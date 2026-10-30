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
import { anthropicMessagesApi, normalizeContext, openAICompletionsApi } from "@earendil-works/pi-ai";

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
 * 按模型目录里的 supported_endpoints 选路。
 *
 * Claude 系列只在 /messages 应答，其余模型在 /chat/completions 应答
 * （/responses 未接入：chat/completions 已能覆盖全部非 Claude 模型）。
 * 老配置没有该字段时按 openai-completions 兜底。
 */
export function resolveEndpoint(model: Model<Api>): CcgoEndpoint {
	const endpoints = (model as any)?.supportedEndpoints;
	if (Array.isArray(endpoints) && endpoints.includes("/messages")) return "anthropic-messages";
	return "openai-completions";
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
	const subModel = {
		...model,
		api: endpoint,
		baseUrl: endpoint === "anthropic-messages" ? `${base}${PROVIDER_API_SUFFIX_ANTHROPIC}` : `${base}${PROVIDER_API_SUFFIX}`,
		// thinkingLevelMap 已由 pi 侧按 CCGO 档位映射好，无需改写
	} as Model<Api>;

	// API 通道不依赖 CLI 版本头：只带 Authorization，不继承 GO 通道的 x-command-code-* 头
	const apiKey = options?.apiKey ?? "";
	// 官方实现只接受 TranscriptContext（带品牌符号），必须先归一化；
	// 它会将 systemPrompt / context.tools 折进 transcript 的 system 消息。
	return STREAMS_BY_ENDPOINT[endpoint]().streamSimple(subModel, normalizeContext(context), { ...options, apiKey });
}
