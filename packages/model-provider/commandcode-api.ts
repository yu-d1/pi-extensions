// 必须从根入口导入：扩展加载器只把 "@earendil-works/pi-ai" 别名到 compat 入口，
// 而 "/api/*"、"/utils/*" 这类子路径不在别名表里，会直接报 MODULE_NOT_FOUND。
// compat 已重新导出这两个官方实现的惰性工厂及 normalizeContext。
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreams,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi, getModels, normalizeContext, openAICompletionsApi } from "@earendil-works/pi-ai";

/**
 * Command Code Provider API 通道。
 *
 * 与 GO 通道（/alpha/generate，见 commandcode-go.ts）完全隔离：
 *   GO 套餐       → 只能用 /alpha/generate 的私有 NDJSON 协议
 *   GOAT/Pro/Max  → 可用官方 Provider API，标准 OpenAI / Anthropic 协议
 *   Provider      → 按量付费，同样走 Provider API
 *
 * 两条通道的请求体、响应格式、鉴权头都不同，因此不做任何共享：
 * 切换套餐类型即整体换一套传输实现。
 */

// ── 常量 ──────────────────────────────────────────────────────────────

/** Provider API 的根路径。OpenAI 系拼 /chat/completions，Anthropic 系拼 /v1/messages。 */
const PROVIDER_API_SUFFIX = "/provider/v1";
/** Anthropic SDK 会自己追加 /v1，因此基地址只能到 /provider。 */
const PROVIDER_API_SUFFIX_ANTHROPIC = "/provider";
const PLAN_PROBE_MODEL = "__cc_plan_probe__";
const PLAN_PROBE_TIMEOUT_MS = 20_000;

// ── 套餐判定 ──────────────────────────────────────────────────────────

export type CcgoPlanMode = "api" | "go";

const ERROR_CODE_HINTS: Record<string, string> = {
	upstream_refused: "上游模型供应商拒绝了本次请求（未扣费），可尝试切换模型、调整思考等级或刷新思考探测",
	upgrade_required: "当前账号套餐不支持 Provider API，请使用 GO 通道或升级套餐",
};

function clipErrorText(text: string, maxLen: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

export function findErrorHint(text: string): string | undefined {
	for (const [code, hint] of Object.entries(ERROR_CODE_HINTS)) {
		if (text.includes(code)) return hint;
	}
	return undefined;
}

/** 从字符串、Error 或嵌套错误对象中提取可读错误信息，避免出现 [object Object]。 */
export function formatErrorMessage(err: unknown, maxLen = 300, depth = 0): string {
	if (err == null || depth > 4) return "";
	if (err instanceof Error) {
		const msg = err.message?.trim();
		if (msg && msg !== "[object Object]") return formatErrorMessage(msg, maxLen, depth + 1);
		if ((err as any).cause !== undefined) {
			const causeMsg = formatErrorMessage((err as any).cause, maxLen, depth + 1);
			if (causeMsg) return causeMsg;
		}
		return err.name || "未知错误";
	}
	if (typeof err === "string") {
		const trimmed = err.trim();
		if (!trimmed) return "";
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
			try {
				return formatErrorMessage(JSON.parse(trimmed), maxLen, depth + 1);
			} catch {
				// 非合法 JSON，按普通文本处理
			}
		}
		return clipErrorText(trimmed, maxLen);
	}
	if (typeof err === "object") {
		const o = err as Record<string, unknown>;
		const code =
			typeof o.code === "string"
				? o.code
				: typeof (o.error as any)?.code === "string"
					? String((o.error as any).code)
					: undefined;
		const nested = o.error ?? o.message ?? o.detail ?? o.msg ?? o.reason;
		const text = nested !== undefined && nested !== err ? formatErrorMessage(nested, maxLen, depth + 1) : "";
		if (text) {
			const withCode = code && !text.includes(code) ? `${text} [${code}]` : text;
			return clipErrorText(withCode, maxLen);
		}
		try {
			return clipErrorText(JSON.stringify(o), maxLen);
		} catch {
			return "未知对象错误";
		}
	}
	return clipErrorText(String(err), maxLen);
}

/** 将上游 HTTP 非 2xx 响应整理为带说明的简明报错。 */
export function formatUpstreamError(status: number, rawBody: string, maxLen = 300): string {
	const detail = formatErrorMessage(rawBody, maxLen);
	const hint = findErrorHint(rawBody) ?? findErrorHint(detail);
	if (hint) {
		return detail ? `HTTP ${status}：${detail}（${hint}）` : `HTTP ${status}：${hint}`;
	}
	return detail ? `HTTP ${status}：${detail}` : `HTTP ${status}`;
}

/** 从字符串或 pi 的凭据对象中提取 API Key。 */
export function extractCredentialKey(credential: unknown): string | undefined {
	if (typeof credential === "string") return credential.trim() || undefined;
	if (!credential || typeof credential !== "object") return undefined;
	const c = credential as Record<string, unknown>;
	for (const k of ["apiKey", "access", "key", "token", "value", "api_key"]) {
		const v = c[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

/**
 * 判定当前密钥能否使用 Provider API。
 *
 * 用「不存在的模型」打 /provider/v1/chat/completions 作为零成本探针：
 *   403 upgrade_required  → GO 套餐（唯一没有 API 权限的套餐）
 *   400 unsupported_model → 有 API 权限（只是模型名是假的），不扣费
 *   401                   → 密钥无效，直接抛错
 *   其它                  → 无法判定，返回 undefined 且不覆盖用户设置
 *
 * 只在登录成功后调用一次；用户手动改套餐类型后不再重新判定。
 */
export async function detectPlanMode(apiKey: string, baseUrl: string): Promise<CcgoPlanMode | undefined> {
	const base = (baseUrl || "").replace(/\/+$/, "");
	if (!apiKey || !base) return undefined;
	let res: Response;
	try {
		res = await fetch(`${base}${PROVIDER_API_SUFFIX}/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: PLAN_PROBE_MODEL,
				messages: [{ role: "user", content: "x" }],
				max_tokens: 1,
			}),
			signal: AbortSignal.timeout(PLAN_PROBE_TIMEOUT_MS),
		});
	} catch {
		// 网络异常不判定，保留既有设置
		return undefined;
	}

	if (res.status === 401) throw new Error("Command Code 密钥无效");
	if (res.status === 403) {
		const body = await res.text().catch(() => "");
		// 只有升级提示才代表 GO 套餐；地区受限 / 内容策略拒绝不改变套餐类型
		return body.includes("upgrade_required") ? "go" : undefined;
	}
	if (res.status === 400) {
		const body = await res.text().catch(() => "");
		return body.includes("unsupported_model") ? "api" : undefined;
	}
	return undefined;
}

// ── 端点选路 ──────────────────────────────────────────────────────────

type CcgoEndpoint = "anthropic-messages" | "openai-completions";

/**
 * 按模型目录里的 supported_endpoints 选路；缺失或为空时按模型 id 兜底。
 *
 * Claude 系列只在 /messages 应答，其余模型在 /chat/completions 应答
 * （/responses 未接入：chat/completions 已能覆盖全部非 Claude 模型）。
 */
export function resolveEndpoint(model: Model<Api>): CcgoEndpoint {
	const endpoints = (model as any)?.supportedEndpoints;
	if (Array.isArray(endpoints) && endpoints.length > 0) {
		return endpoints.includes("/messages") ? "anthropic-messages" : "openai-completions";
	}
	return /(?:^|\/)claude-/i.test(model.id) ? "anthropic-messages" : "openai-completions";
}

// ── Claude 自适应思考兼容配置 ─────────────────────────────────────────

export interface AnthropicThinkingProfile {
	forceAdaptiveThinking: boolean;
	supportsTemperature?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}

const ANTHROPIC_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

let builtinAnthropicById: Map<string, Model<Api>> | null = null;

function getBuiltinAnthropicMap(): Map<string, Model<Api>> {
	if (builtinAnthropicById) return builtinAnthropicById;
	const map = new Map<string, Model<Api>>();
	try {
		for (const model of getModels("anthropic") ?? []) {
			if (model?.id) map.set(model.id, model as Model<Api>);
		}
	} catch {
		// 宿主环境异常时退回版本号规则
	}
	builtinAnthropicById = map;
	return map;
}

/**
 * 解析 Claude 模型的思考模式与合法档位映射。
 *
 * 优先查 pi-ai 内置 Anthropic 目录；未收录时按版本号规则兜底
 * （Claude 4.6+ / 5+ 使用 adaptive + output_config.effort，4.7+ / 5+ 禁用 temperature）。
 * 故意不继承 supportsMidConvoEffort / allowedFallbackModels 等官方 beta 特性，
 * 避免第三方网关或中转站因不支持特定 beta 头而报错。
 */
export function resolveAnthropicThinkingProfile(modelId: string): AnthropicThinkingProfile {
	const bareId = modelId.replace(/^[^/]+\//, "");
	const catalog = getBuiltinAnthropicMap();
	const builtin =
		catalog.get(bareId) ??
		(/-20\d{6}$/.test(bareId) ? catalog.get(bareId.replace(/-20\d{6}$/, "")) : undefined);
	if (builtin) {
		const compat = (builtin as any).compat;
		return {
			forceAdaptiveThinking: compat?.forceAdaptiveThinking === true,
			supportsTemperature: compat?.supportsTemperature === false ? false : undefined,
			thinkingLevelMap: builtin.thinkingLevelMap ? { ...builtin.thinkingLevelMap } : undefined,
		};
	}

	const match = bareId.match(/^claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?/i);
	if (!match) return { forceAdaptiveThinking: false };
	const major = Number(match[1]);
	const minor = match[2] ? Number(match[2]) : 0;
	const forceAdaptiveThinking = major >= 5 || (major === 4 && minor >= 6);
	const supportsTemperature = major >= 5 || (major === 4 && minor >= 7) ? false : undefined;
	return {
		forceAdaptiveThinking,
		supportsTemperature,
		...(forceAdaptiveThinking
			? {
					thinkingLevelMap: {
						minimal: null,
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
						max: "max",
					},
				}
			: {}),
	};
}

/** 清洗 adaptive 模式的档位映射，过滤掉 OpenAI/GO 通道的非法值（如 "off"、"none"、"minimal"）。 */
function sanitizeAnthropicAdaptiveMap(map: Record<string, string | null>): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	for (const [key, val] of Object.entries(map)) {
		if (key === "off") {
			if (val === null) out.off = null;
			continue;
		}
		if (key === "xhigh" || key === "max") {
			if (typeof val === "string" && ANTHROPIC_EFFORTS.has(val)) out[key] = val;
			continue;
		}
		out[key] = typeof val === "string" && ANTHROPIC_EFFORTS.has(val) ? val : null;
	}
	if (out.minimal === undefined) out.minimal = null;
	return out;
}

/** 为 Anthropic Messages 模型补全自适应思考兼容标记与安全的 thinkingLevelMap。 */
export function applyAnthropicCompat<
	T extends { id: string; compat?: Record<string, unknown>; thinkingLevelMap?: Record<string, string | null> },
>(
	model: T,
	explicitForceAdaptive?: boolean,
): { compat: Record<string, unknown>; thinkingLevelMap?: Record<string, string | null> } {
	const profile = resolveAnthropicThinkingProfile(model.id);
	const modelExplicit = typeof model.compat?.forceAdaptiveThinking === "boolean"
		? model.compat.forceAdaptiveThinking
		: undefined;
	const forceAdaptive = explicitForceAdaptive ?? modelExplicit ?? profile.forceAdaptiveThinking;
	const compat: Record<string, unknown> = {
		...(model.compat ?? {}),
		...(forceAdaptive ? { forceAdaptiveThinking: true } : {}),
		...(profile.supportsTemperature === false && model.compat?.supportsTemperature === undefined
			? { supportsTemperature: false }
			: {}),
	};
	const thinkingLevelMap = forceAdaptive
		? model.thinkingLevelMap
			? sanitizeAnthropicAdaptiveMap(model.thinkingLevelMap)
			: profile.thinkingLevelMap
		: model.thinkingLevelMap;
	return { compat, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) };
}

// ── Provider API 传输 ─────────────────────────────────────────────────

/** 各端点对应的官方实现。惰性工厂只加载一次，由宿主 import 缓存去重。 */
const STREAMS_BY_ENDPOINT: Record<CcgoEndpoint, () => ProviderStreams> = {
	"anthropic-messages": anthropicMessagesApi,
	"openai-completions": openAICompletionsApi,
};

/**
 * 走 Provider API 发起流式请求。
 *
 * 不自行解析协议：直接把模型的 api / baseUrl 换成对应官方实现后调用其
 * streamSimple，reasoning_content、图片、tool_calls 增量合并、usage 统计
 * 全部由 pi-ai 负责。
 *
 * baseUrl 差异（实测）：
 *   OpenAI    SDK 追加 /chat/completions → 基地址需到 {base}/provider/v1
 *   Anthropic SDK 追加 /v1/messages      → 基地址只能到 {base}/provider
 */
export function streamViaProviderApi(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	baseUrl: string,
): AssistantMessageEventStream {
	const base = (baseUrl || "").replace(/\/+$/, "");
	const endpoint = resolveEndpoint(model);
	const anthropicPatch = endpoint === "anthropic-messages" ? applyAnthropicCompat(model as any) : undefined;
	const subModel = {
		...model,
		api: endpoint,
		baseUrl: endpoint === "anthropic-messages" ? `${base}${PROVIDER_API_SUFFIX_ANTHROPIC}` : `${base}${PROVIDER_API_SUFFIX}`,
		...(anthropicPatch ?? {}),
	} as Model<Api>;

	// API 通道不依赖 CLI 版本头：只带 Authorization，不继承 GO 通道的 x-command-code-* 头
	const apiKey = options?.apiKey ?? "";
	// 官方实现只接受 TranscriptContext（带品牌符号），必须先归一化；
	// 它会将 systemPrompt / context.tools 折进 transcript 的 system 消息。
	return STREAMS_BY_ENDPOINT[endpoint]().streamSimple(subModel, normalizeContext(context), { ...options, apiKey });
}
