/**
 * 思考等级探测：实测每个模型真正支持哪些档位，生成 thinkingLevelMap。
 *
 * 为什么需要：pi 用 thinkingLevelMap 决定 /settings 里显示哪些档位
 * （null 表示该档不支持，会被过滤掉）。不探测就只能一律给全档，
 * 用户选到不支持的档会直接 400。
 *
 * 请求走 modelRegistry.complete，由各供应商自己的 streamSimple 处理：
 * 通用供应商用 pi 内置的 api 实现，commandcodego 用扩展注册的
 * 私有通道（/alpha/generate 的 NDJSON 等）。这里不拼任何 HTTP 请求，
 * 否则等于把每家协议重写一遍，而且必然和真实对话路径不一致。
 */

/** pi 的全部思考档位（用于排序参照） */
export const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * 需要逐档实测的档位。
 *
 * 不含 off（那是「关掉思考」，另一套判定）与 minimal（太细，实测用处不大，
 * 统一隐藏）。隐不掉就删掉，所以生成 map 时会把它写成 null。
 */
const PROBE_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** pi 里有、但我们不提供的档位，生成 map 时置 null 隐藏 */
const HIDDEN_LEVELS = ["minimal"] as const;

/**
 * 探测提问。
 *
 * 用写代码而不是简单问答：推理模型面对「哪个数大」这类题会直接作答，
 * 不产生思考内容，容易被误判成「不支持该档」。冒泡排序要理清边界条件，
 * 多数推理模型会真正展开思考。
 */
const PROBE_QUESTION = "用 Java 写一个冒泡排序，只要代码。";

/**
 * 探测顺序。
 *
 * 先试 low：它是最省的一档，模型若不支持会立刻报错，
 * 比先试 medium 少一次长思考。
 */
const FIRST_LEVEL = "low";

/** 单个档位的判定结果 */
export interface LevelResult {
	level: string;
	ok: boolean;
	note: string;
}

/** 一个模型的探测结果 */
export interface ModelProbeResult {
	/** 真正生效的档位（不含 off） */
	levels: string[];
	/** 逐档过程，用于排查与展示 */
	trace: LevelResult[];
}

/** 不能算成功的结束原因 */
const FAILED_STOP_REASONS = new Set(["error", "aborted"]);

/**
 * 判定一档是否支持：请求被接受就算支持。
 *
 * 不看响应里有没有思考内容：部分网关不透传 reasoning 字段，
 * 按内容判定会把能用的一律归为「不支持」。
 *
 * 但必须看 stopReason：pi 的 complete 失败时不抛错，而是返回带
 * stopReason: "error" 的消息，只看“有没有返回”会把失败当成功。
 */
function shortError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

/**
 * 探测一个模型支持哪些思考档位。
 *
 * @param registry pi 的 modelRegistry，负责按供应商路由与认证
 * @param model 已注册的模型对象（含 api / provider / baseUrl）
 */
export async function probeThinkingLevels(
	registry: any,
	model: any,
	signal?: AbortSignal,
	onProgress?: (note: string) => void,
): Promise<ModelProbeResult> {
	const trace: LevelResult[] = [];

	// 先确认能正常调用，避免把「密钥失效」误当成「不支持思考」
	const first = await probeOne(registry, model, FIRST_LEVEL, signal);
	trace.push(first);
	onProgress?.(`${FIRST_LEVEL} ${first.ok ? "✓" : "✗"}`);
	if (!first.ok) {
		// 第一档就失败时无法区分「不支持」与「认证/网络问题」，
		// 返回空让调用方保持原配置，不误杀
		return { levels: [], trace };
	}

	const levels = [FIRST_LEVEL];
	for (const level of PROBE_LEVELS) {
		if (level === FIRST_LEVEL) continue;
		if (signal?.aborted) break;
		const one = await probeOne(registry, model, level, signal);
		trace.push(one);
		onProgress?.(`${level} ${one.ok ? "✓" : "✗"}`);
		if (one.ok) levels.push(level);
	}

	return { levels: levels.sort(byLevelOrder), trace };
}

/** 用指定档位请求一次，看是否真的产生思考内容 */
async function probeOne(
	registry: any,
	model: any,
	level: string,
	signal?: AbortSignal,
): Promise<LevelResult> {
	try {
		const message = await registry.complete(
			model,
			{ messages: [{ role: "user", content: PROBE_QUESTION, timestamp: Date.now() }] },
			{ reasoning: level, maxTokens: 256, signal },
		);
		// 能正常返回就说明该档被接受；是否真的产生思考内容不追究
		if (message === undefined || message === null) return { level, ok: false, note: "空响应" };
		if (FAILED_STOP_REASONS.has(message.stopReason)) {
			return { level, ok: false, note: shortError(message.errorMessage ?? message.stopReason) };
		}
		return { level, ok: true, note: "已接受" };
	} catch (error) {
		return { level, ok: false, note: shortError(error) };
	}
}

/** 按 pi 的档位顺序排列，避免探测顺序决定展示顺序 */
function byLevelOrder(a: string, b: string): number {
	const order = ALL_THINKING_LEVELS as readonly string[];
	return order.indexOf(a) - order.indexOf(b);
}

/**
 * 把探测到的档位转成 thinkingLevelMap。
 *
 * pi 的规则：null = 该档不支持（会被 /settings 过滤）；
 * 但要特别小心：xhigh / max 之外，map 里缺键（undefined）会被当成**支持**。
 * 所以不需要的档必须显式写 null，否则它仍会出现在 /settings 里。
 */
export function buildThinkingLevelMap(levels: string[]): Record<string, string | null> {
	const map: Record<string, string | null> = { off: "none" };
	for (const level of PROBE_LEVELS) {
		map[level] = levels.includes(level) ? level : null;
	}
	for (const level of HIDDEN_LEVELS) {
		map[level] = null;
	}
	return map;
}
