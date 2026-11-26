/**
 * 思考等级探测：直连供应商接口，实测每个模型真正支持哪些档位。
 *
 * 为什么要直连而不是走 pi 的 modelRegistry：
 *   1. pi 内部把 `reasoning: "off"` 转成 undefined，off 档永远发不出去；
 *   2. pi 是否下发思考参数取决于 model.compat.thinkingFormat —— 而那正是
 *      我们要测出来的东西，形成循环依赖；
 *   3. 没设 thinkingFormat 时所有档位的请求完全相同，全部 200，
 *      于是全部被判为支持（历史配置里的错误档位就是这么来的）。
 *
 * 因此这里自己拼请求，按 pi-ai 支持的 thinkingFormat 逐个试，
 * 命中后再逐档验证，一次探测同时得出「哪些档可用」和「该用哪种参数格式」。
 */

/** pi 的全部思考档位（用于排序参照） */
export const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 需要逐档验证的档位，不含 off（关闭是另一套判定） */
const PROBE_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * 寻找格式时用的档位。
 *
 * 选 medium 而非 low：low 在部分实现上等价于关闭，会被误判成「这个格式不支持思考」。
 */
const FORMAT_PROBE_LEVEL = "medium";

/**
 * 探测提问。
 *
 * 用写代码而不是简单问答：推理模型面对「哪个数大」这类题会直接作答，
 * 不产生思考内容，容易被误判成「不支持该档」。
 */
const PROBE_QUESTION = "用 Java 写一个冒泡排序，只要代码。";

/** 探测请求的输出预算：够写下代码即可，不追求完整 */
const PROBE_MAX_TOKENS = 512;

/** 单次请求超时 */
const PROBE_TIMEOUT_MS = 45_000;

/**
 * 借用 minimal 档位承载「真正关闭思考」。
 *
 * 实测 deepseek 系列不认 `thinking: {type:"disabled"}`，只有
 * `reasoning_effort: "off"` 能关掉，而 pi 内部会把 off 档转成 undefined 不下发。
 * 因此把关闭值挂到 minimal 上：用户选 minimal 即等于关闭思考。
 */
const BORROWED_CLOSE_LEVEL = "minimal";

/** 关闭思考的各种写法。不同厂商认的不一样，逐个试到能关掉为止。 */
const CLOSE_SHAPES: Array<{ value?: string; params: Record<string, unknown> }> = [
	// 实测 deepseek 只认这个；mimo 会对它报 400
	{ value: "off", params: { reasoning_effort: "off" } },
	// mimo / openrouter 系认这个
	{ value: "none", params: { reasoning_effort: "none" } },
	// 不发 effort，改用开关字段
	{ params: { thinking: { type: "disabled" } } },
	{ params: { enable_thinking: false } },
{ params: { chat_template_kwargs: { enable_thinking: false } } },
];

/** 一次请求的判定结果 */
export type Verdict = "ok" | "no-think" | "error";

/** 单档探测记录 */
export interface LevelProbe {
	level: string;
	format: string;
	verdict: Verdict;
	note: string;
}

/** 一个模型的探测结果 */
export interface ModelProbeResult {
	/** 真正生效的档位（不含 off） */
	levels: string[];
	/** 命中的参数格式，写进 compat.thinkingFormat */
	thinkingFormat?: string;
	/** 关闭思考是否真的生效 */
	offClosable: boolean;
	/** 关闭思考用的 effort 值（如 "off"、"none"），可借位到 minimal 档 */
	closeValue?: string;
	/** 逐档过程，用于排查与展示 */
	trace: LevelProbe[];
}

/** 探测目标：直连所需的全部信息 */
export interface ProbeTarget {
	/** 对话端点前缀，例如 https://api.xiaomimimo.com/v1 */
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/**
	 * 参数格式候选。按优先级排列，命中即停。
	 * 每个格式自带「各档位要发什么」，与 pi-ai 的 thinkingFormat 分支保持一致。
	 */
	formats: ThinkFormat[];
}

/** 一种思考参数格式 */
export interface ThinkFormat {
	/** 对应 pi-ai 的 compat.thinkingFormat */
	name: string;
	/** 构造该档位下的请求增量；返回 null 表示此格式下该档没有额外参数 */
	build: (level: string) => Record<string, unknown> | null;
}

/**
 * 常见格式候选。
 *
 * 与 pi-ai openai-completions 的分支一一对应；只列能纯靠请求体区分的那几种，
 * 协议级差异（anthropic messages、commandcode 私有通道）不走这里。
 */
export const THINK_FORMATS: ThinkFormat[] = [
	{
		// 实测 deepseek：关闭只认 reasoning_effort:"off"，不认 thinking:disabled
		name: "deepseek",
		build: (level) => (level === "off" ? { reasoning_effort: "off" } : { thinking: { type: "enabled" }, reasoning_effort: level }),
	},
	{
		name: "zai",
		build: (level) => (level === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: level }),
	},
	{
		name: "openrouter",
		build: (level) => ({ reasoning: { effort: level === "off" ? "none" : level } }),
	},
	{
		name: "ant-ling",
		build: (level) => (level === "off" ? { reasoning: { effort: "none" } } : { reasoning: { effort: level } }),
	},
	{
		name: "qwen",
		build: (level) => (level === "off" ? { enable_thinking: false } : { enable_thinking: true, reasoning_effort: level }),
	},
	{
		name: "qwen-chat-template",
		build: (level) => ({ chat_template_kwargs: { enable_thinking: level !== "off" } }),
	},
];

/**
 * 判断响应里是否真的出现了思考内容。
 *
 * 只看「思考内容」不看状态码：参数被忽略时各家都会正常回话（200），
 * 仅凭状态码会把不支持的档误判为支持。
 */
function hasReasoningContent(json: any): boolean {
	const message = json?.choices?.[0]?.message;
	if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim().length > 0) return true;
	if (typeof message?.reasoning === "string" && message.reasoning.trim().length > 0) return true;
	if (Array.isArray(message?.reasoning_content) && message.reasoning_content.length > 0) return true;
	if (Array.isArray(message?.content) && message.content.some((b: any) => b?.type === "thinking" || b?.type === "reasoning")) {
		return true;
	}
	const reasoningTokens = json?.usage?.completion_tokens_details?.reasoning_tokens;
	return typeof reasoningTokens === "number" && reasoningTokens > 0;
}

function shortError(value: unknown): string {
	const text = typeof value === "string" ? value : value instanceof Error ? value.message : JSON.stringify(value ?? "");
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}

/** 统一的 JSON POST 请求封装（超时控制、外部取消、错误提炼）。 */
async function postProbeJson(
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ ok: true; json: any } | { ok: false; note: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("探测超时")), PROBE_TIMEOUT_MS);
	const onAbort = () => controller.abort(signal?.reason);
	if (signal !== undefined) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const resp = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await resp.text();
		// 参数不被接受时，网关普遍用 400/422 明确拒绝
		if (resp.status === 400 || resp.status === 422) return { ok: false, note: shortError(text) };
		if (!resp.ok) return { ok: false, note: `HTTP ${resp.status} ${shortError(text)}` };

		try {
			return { ok: true, json: JSON.parse(text) };
		} catch {
			return { ok: false, note: "响应不是 JSON" };
		}
	} catch (error) {
		return { ok: false, note: shortError(error) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** 发一次请求并判定 */
async function requestOnce(
	target: ProbeTarget,
	_level: string,
	params: Record<string, unknown> | null,
	signal?: AbortSignal,
): Promise<{ verdict: Verdict; note: string }> {
	const res = await postProbeJson(
		`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`,
		{ "Content-Type": "application/json", Authorization: `Bearer ${target.apiKey}` },
		{
			model: target.modelId,
			stream: false,
			max_tokens: PROBE_MAX_TOKENS,
			messages: [{ role: "user", content: PROBE_QUESTION }],
			...params,
		},
		signal,
	);
	if (!res.ok) return { verdict: "error", note: res.note };
	if (hasReasoningContent(res.json)) return { verdict: "ok", note: "出现思考内容" };
	return { verdict: "no-think", note: "200 但无思考内容" };
}

/**
 * 探测一个模型支持哪些思考档位。
 *
 * 流程：先找出哪种参数格式能触发思考（只试 medium），命中后在该格式下逐档验证，
 * 最后单独验证关闭是否生效。
 */
export async function probeThinkingLevels(
	target: ProbeTarget,
	signal?: AbortSignal,
	onProgress?: (note: string) => void,
): Promise<ModelProbeResult> {
	const trace: LevelProbe[] = [];
	const empty: ModelProbeResult = { levels: [], offClosable: false, trace };

	// ── 1. 找格式 ──────────────────────────────────────────────
	let hit: ThinkFormat | undefined;
	for (const format of target.formats) {
		if (signal?.aborted) return empty;
		const params = format.build(FORMAT_PROBE_LEVEL);
		const r = await requestOnce(target, FORMAT_PROBE_LEVEL, params, signal);
		trace.push({ level: FORMAT_PROBE_LEVEL, format: format.name, verdict: r.verdict, note: r.note });
		onProgress?.(`格式 ${format.name} ${r.verdict === "ok" ? "✓" : "✗"}`);
		if (r.verdict === "ok") {
			hit = format;
			break;
		}
	}

	// 一种格式都不通：可能是模型不支持思考，也可能是密钥/网络问题，
	// 无法区分时保持原配置不动，避免误杀
	if (hit === undefined) return empty;

	// ── 2. 逐档验证 ────────────────────────────────────────────
	const levels: string[] = [FORMAT_PROBE_LEVEL];
	for (const level of PROBE_LEVELS) {
		if (level === FORMAT_PROBE_LEVEL) continue;
		if (signal?.aborted) break;
		const params = hit.build(level);
		const r = await requestOnce(target, level, params, signal);
		trace.push({ level, format: hit.name, verdict: r.verdict, note: r.note });
		onProgress?.(`${level} ${r.verdict === "ok" ? "✓" : "✗"}`);
		if (r.verdict === "ok") levels.push(level);
	}

	// ── 3. 验证关闭 ────────────────────────────────────────────
	// 不能只试当前格式的关闭写法：deepseek 认 reasoning_effort:"off"，
	// mimo 认 "none"，只试一种会把能关的模型误判成关不掉。
	let offClosable = false;
	let closeValue: string | undefined;
	for (const shape of CLOSE_SHAPES) {
		if (signal?.aborted) break;
		const r = await requestOnce(target, "off", shape.params, signal);
		// 关闭看的是「有没有思考」：没思考才算真的关掉了
		if (r.verdict === "no-think") {
			offClosable = true;
			closeValue = shape.value;
			trace.push({ level: "off", format: hit.name, verdict: r.verdict, note: "思考已关闭 ✓" });
			break;
		}
		trace.push({ level: "off", format: hit.name, verdict: r.verdict, note: r.note });
	}
	onProgress?.(`off ${offClosable ? "✓ 可关闭" : "✗ 关不掉"}`);

	return {
		levels: levels.sort(byLevelOrder),
		thinkingFormat: hit.name,
		offClosable,
		...(closeValue !== undefined ? { closeValue } : {}),
		trace,
	};
}

/** 按 pi 的档位顺序排列，避免探测顺序决定展示顺序 */
function byLevelOrder(a: string, b: string): number {
	const order = ALL_THINKING_LEVELS as readonly string[];
	return order.indexOf(a) - order.indexOf(b);
}

/**
 * 把探测结果转成 thinkingLevelMap。
 *
 * 不支持的档位不应该出现在配置里，所以：
 *   - xhigh / max：pi 不写键就当不支持，直接省略，配置保持干净；
 *   - minimal / low / medium / high：pi 不写键会当成支持，
 *     只能用 null 表达不支持（这是 pi 的约定，没得选）。
 *
 * @param levels 探测到的可用档位
 * @param borrowedClose 关闭思考用的 effort 值。有值时挂到 minimal，
 *        给用户一个「真正关掉」的可选项。
 */
export function buildThinkingLevelMap(
	levels: string[],
	borrowedClose?: string,
): Record<string, string | null> {
	const map: Record<string, string | null> = { off: borrowedClose ?? "none" };

	// 不支持时必须写 null 才能隐藏
	for (const level of ["minimal", "low", "medium", "high"] as const) {
		if (level === BORROWED_CLOSE_LEVEL && borrowedClose !== undefined) {
			map[level] = borrowedClose;
			continue;
		}
		map[level] = levels.includes(level) ? level : null;
	}

	// 不支持时省略键即可
	for (const level of ["xhigh", "max"] as const) {
		if (levels.includes(level)) map[level] = level;
	}

	return map;
}

// =============================================================================
// Anthropic Messages 协议探测（adaptive + budget）
// =============================================================================

export interface AnthropicProbeTarget {
	/** 接口前缀，如 https://api.commandcode.ai/provider/v1 或 https://api.anthropic.com/v1 */
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** 为 true 时同时携带 Authorization: Bearer（兼容 Command Code Provider API 等网关） */
	sendBearer?: boolean;
}

export interface AnthropicProbeResult {
	/** 探测命中的思考协议：adaptive 或 budget；未探测到则 undefined */
	mode?: "adaptive" | "budget";
	/** 真正生效的档位（不含 off） */
	levels: string[];
	/** thinking: { type: "disabled" } 是否可关闭思考 */
	offClosable: boolean;
	trace: LevelProbe[];
}

const ADAPTIVE_EXTRA_LEVELS = ["low", "high", "xhigh", "max"] as const;

function hasAnthropicThinking(json: any): boolean {
	return (
		Array.isArray(json?.content) &&
		json.content.some((b: any) => b?.type === "thinking" || b?.type === "redacted_thinking")
	);
}

async function requestAnthropicOnce(
	target: AnthropicProbeTarget,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ verdict: Verdict; note: string }> {
	const base = target.baseUrl.replace(/\/+$/, "");
	const url = base.endsWith("/messages") ? base : `${base}/messages`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (target.apiKey.includes("sk-ant-oat")) {
		headers.Authorization = `Bearer ${target.apiKey}`;
	} else {
		headers["x-api-key"] = target.apiKey;
		if (target.sendBearer === true) headers.Authorization = `Bearer ${target.apiKey}`;
	}

	const res = await postProbeJson(
		url,
		headers,
		{
			model: target.modelId,
			messages: [{ role: "user", content: PROBE_QUESTION }],
			...payload,
		},
		signal,
	);
	if (!res.ok) return { verdict: "error", note: res.note };
	if (hasAnthropicThinking(res.json)) return { verdict: "ok", note: "出现思考内容" };
	return { verdict: "no-think", note: "200 但无思考内容" };
}

/** 探测 Anthropic Messages 协议模型支持 adaptive 还是 budget 思考模式及可用档位。 */
export async function probeAnthropicThinkingLevels(
	target: AnthropicProbeTarget,
	signal?: AbortSignal,
	onProgress?: (note: string) => void,
): Promise<AnthropicProbeResult> {
	const trace: LevelProbe[] = [];
	const empty: AnthropicProbeResult = { levels: [], offClosable: false, trace };

	let mode: "adaptive" | "budget" | undefined;
	const levels: string[] = [];

	// 1. 先试 adaptive + medium
	if (signal?.aborted) return empty;
	const adaptiveProbe = await requestAnthropicOnce(
		target,
		{ max_tokens: 1024, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: FORMAT_PROBE_LEVEL } },
		signal,
	);
	trace.push({ level: FORMAT_PROBE_LEVEL, format: "anthropic-adaptive", verdict: adaptiveProbe.verdict, note: adaptiveProbe.note });
	onProgress?.(`adaptive ${adaptiveProbe.verdict === "ok" ? "✓" : "✗"}`);

	if (adaptiveProbe.verdict === "ok") {
		mode = "adaptive";
		levels.push(FORMAT_PROBE_LEVEL);
		for (const level of ADAPTIVE_EXTRA_LEVELS) {
			if (signal?.aborted) break;
			const r = await requestAnthropicOnce(
				target,
				{ max_tokens: 1024, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: level } },
				signal,
			);
			trace.push({ level, format: "anthropic-adaptive", verdict: r.verdict, note: r.note });
			onProgress?.(`${level} ${r.verdict === "ok" ? "✓" : "✗"}`);
			if (r.verdict === "ok") levels.push(level);
		}
	} else {
		// 2. adaptive 不通，再试旧代 budget 模式
		if (signal?.aborted) return empty;
		const budgetProbe = await requestAnthropicOnce(
			target,
			{ max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 1024 } },
			signal,
		);
		trace.push({ level: "enabled", format: "anthropic-budget", verdict: budgetProbe.verdict, note: budgetProbe.note });
		onProgress?.(`budget ${budgetProbe.verdict === "ok" ? "✓" : "✗"}`);
		if (budgetProbe.verdict !== "ok") return empty;
		mode = "budget";
		levels.push("minimal", "low", "medium", "high");
	}

	// 3. 验证 disabled 是否可关闭思考
	let offClosable = false;
	if (!signal?.aborted) {
		const offProbe = await requestAnthropicOnce(
			target,
			{ max_tokens: PROBE_MAX_TOKENS, thinking: { type: "disabled" } },
			signal,
		);
		offClosable = offProbe.verdict === "no-think";
		trace.push({
			level: "off",
			format: `anthropic-${mode}`,
			verdict: offProbe.verdict,
			note: offClosable ? "思考已关闭 ✓" : offProbe.note,
		});
		onProgress?.(`off ${offClosable ? "✓ 可关闭" : "✗ 关不掉"}`);
	}

	return {
		mode,
		levels: levels.sort(byLevelOrder),
		offClosable,
		trace,
	};
}

/** 把 Anthropic 探测结果转为安全的 thinkingLevelMap。 */
export function buildAnthropicThinkingLevelMap(
	result: AnthropicProbeResult,
): Record<string, string | null> | undefined {
	if (result.mode === "adaptive") {
		const map: Record<string, string | null> = {
			...(result.offClosable ? {} : { off: null }),
			minimal: null,
		};
		for (const level of ["low", "medium", "high"] as const) {
			map[level] = result.levels.includes(level) ? level : null;
		}
		for (const level of ["xhigh", "max"] as const) {
			if (result.levels.includes(level)) map[level] = level;
		}
		return map;
	}
	if (result.mode === "budget") {
		return result.offClosable ? undefined : { off: null };
	}
	return undefined;
}
