/**
 * model-provider — 模型提供扩展（统一管理 pi 模型供应商）
 * =============================================================================
 *   1. 内置 Command Code 供应商：自带上游专属协议与套餐分流，见 commandcode-go.ts。
 *   2. 通用（common）供应商：通过 /model-provider 命令添加，仅使用 pi 官方的
 *      OpenAI Completions 格式、OpenAI Responses 格式、Claude 格式；地址只保存 API 前缀，模型列表
 *      通过 {baseUrl}/models 获取，也可手动添加模型 id。
 *      认证统一走 /login <名称> 存入 auth.json。
 *   3. 配置统一持久化到 ~/.pi/agent/extensions/model-provider/config.json（schemaVersion:2）。
 *   4. 思考等级可实测后写入（thinking-probe.ts），只把真正可用的档位暴露到 /settings。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, Spacer, Text, fuzzyFilter } from "@earendil-works/pi-tui";
import {
	CCGO_LABEL,
	CCGO_PROVIDER_ID,
	DEFAULT_CCGO,
	fetchCommandCodeGoModels,
	asCommandCodeGoConfig,
	buildCommandCodeGoConfig,
	setCommandCodeGoConfig,
	setCommandCodeGoHost,
	type CcGoModelConfig,
	type CommandCodeGoConfig,
} from "./commandcode-go";
import {
	applyAnthropicCompat,
	extractCredentialKey,
	formatErrorMessage,
	formatUpstreamError,
	resolveAnthropicThinkingProfile,
	resolveEndpoint,
	type CcgoPlanMode,
} from "./commandcode-api";
import {
	buildAnthropicThinkingLevelMap,
	buildThinkingLevelMap,
	probeAnthropicThinkingLevels,
	probeThinkingLevels,
	THINK_FORMATS,
	type AnthropicProbeResult,
	type ModelProbeResult,
} from "./thinking-probe";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// =============================================================================
// common 支持的官方 api 类型（只保留三种通用格式）
// =============================================================================

const COMMON_API_OPTIONS = [
	{
		api: "openai-completions",
		label: "OpenAI 通用格式",
		example: "https://api.openai.com/v1",
		description: "Chat Completions，兼容性最好，本地服务多用",
	},
	{
		api: "openai-responses",
		label: "OpenAI Responses 格式",
		example: "https://api.deepseek.com",
		description: "OpenAI Responses API，请求路径为 /responses，适用于支持该格式的模型服务",
	},
	{
		api: "anthropic-messages",
		label: "Claude 格式",
		example: "https://api.anthropic.com/v1",
		description: "Anthropic Messages API 及兼容代理",
	},
] as const;

const KNOWN_APIS: string[] = COMMON_API_OPTIONS.map((option) => option.api);

function getCommonApiOption(api: string) {
	return COMMON_API_OPTIONS.find((option) => option.api === api) ?? COMMON_API_OPTIONS[0];
}

function inputModeText(input?: ("text" | "image")[]): string {
	return input?.includes("image") ? "文本 + 图片" : "仅文本";
}

function normalizeInput(input: unknown): ("text" | "image")[] {
	if (!Array.isArray(input)) return ["text", "image"];
	const values = input.filter((value): value is "text" | "image" => value === "text" || value === "image");
	return values.includes("text") ? (values.includes("image") ? ["text", "image"] : ["text"]) : ["text", "image"];
}

// =============================================================================
// 持久化数据模型
// =============================================================================

interface StoredCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface StoredModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: StoredCost;
	thinkingLevelMap?: Record<string, string | null>;
	/** 思考参数格式（pi-ai 的 compat.thinkingFormat），由“刷新启用模型思考”实测得出。 */
	thinkingFormat?: string;
	/** 新一代 Claude 的自适应思考标记（pi-ai 的 compat.forceAdaptiveThinking）。 */
	forceAdaptiveThinking?: boolean;
	/** 是否已完成过思考探测（实测校准过格式与档位）。 */
	thinkingProbed?: boolean;
	/** Command Code 模型目录声明的应答端点，用于 API 通道选路。 */
	supportedEndpoints?: string[];
	/** 勾选启用：true/undefined = 启用并显示在 /model；false = 不显示（配置保留）。 */
	enabled?: boolean;
}

interface BuiltinEntry {
	kind: "builtin";
	name: "commandcodego";
	label: string;
	commandcodeGo: CommandCodeGoConfig;
	models: StoredModel[];
}

interface CommonEntry {
	kind: "common";
	/** 供应商 id，同时作为显示名称 */
	name: string;
	/** 官方 api 类型 */
	api: string;
	/** API 请求地址前缀，不包含 /models 等具体接口 */
	baseUrl: string;
	/** 已保存模型列表；只有手动刷新时才会重新获取 /models */
	models: StoredModel[];
}

type ProviderEntry = BuiltinEntry | CommonEntry;

interface Store {
	schemaVersion: 2;
	providers: ProviderEntry[];
}

// =============================================================================
// 配置路径与默认值
// =============================================================================

const STORE_FILE = join(homedir(), ".pi", "agent", "extensions", "model-provider", "config.json");

function createDefaultStore(): Store {
	return {
		schemaVersion: 2,
		providers: [
			{
				kind: "builtin",
				name: "commandcodego",
				label: CCGO_LABEL,
				commandcodeGo: { ...DEFAULT_CCGO },
				models: [],
			},
		],
	};
}

let store: Store = createDefaultStore();
let api: ExtensionAPI | null = null;

// commandcode-go.ts 登录时判定完套餐类型，通过该回调写回持久化配置。
// 套餐类型只有两个写入口：登录自动判定、用户在「套餐类型」菜单手动选择。
setCommandCodeGoHost({
	savePlanMode: async (mode: CcgoPlanMode) => {
		const entry = getBuiltinEntry("commandcodego");
		if (!entry || entry.name !== "commandcodego") return;
		entry.commandcodeGo.planMode = mode;
		// 必须同步注入值，否则 streamSimple 读到的还是旧 planMode
		setCommandCodeGoConfig(entry.commandcodeGo);
		reRegisterEntry(entry);
		await saveStore();
	},
});

// =============================================================================
// Store 读写与迁移
// =============================================================================

/** 解析持久化的模型数组（builtin 与 common 共用）。 */
function normalizeStoredModels(raw: unknown): StoredModel[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((m: any) => typeof m?.id === "string")
		.map((m: any) => ({
			id: m.id,
			...(m.name ? { name: m.name } : {}),
			reasoning: inferModelReasoning(m),
			input: normalizeInput(m.input),
			...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
			...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
			...(m.cost ? { cost: m.cost } : {}),
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			...(typeof m.thinkingFormat === "string" && m.thinkingFormat ? { thinkingFormat: m.thinkingFormat } : {}),
			...(typeof m.forceAdaptiveThinking === "boolean" ? { forceAdaptiveThinking: m.forceAdaptiveThinking } : {}),
			...(typeof m.thinkingProbed === "boolean" ? { thinkingProbed: m.thinkingProbed } : {}),
			...(Array.isArray(m.supportedEndpoints) ? { supportedEndpoints: m.supportedEndpoints.map(String) } : {}),
			...(typeof m.enabled === "boolean" ? { enabled: m.enabled } : {}),
		}));
}

function normalizeStore(raw: any): Store {
	const providers: ProviderEntry[] = [];
	// 内置 commandcodego 始终存在
	const rawProviders: any[] = Array.isArray(raw?.providers) ? raw.providers : [];
	const findBuiltin = (id: string) => rawProviders.find((p: any) => p?.kind === "builtin" && p?.name === id);
	const ccgoRaw = findBuiltin("commandcodego");
	const ccgoModels = sortModels(normalizeStoredModels(ccgoRaw?.models));
	providers.push({
		kind: "builtin",
		name: "commandcodego",
		label: CCGO_LABEL,
		commandcodeGo: asCommandCodeGoConfig(ccgoRaw?.commandcodeGo),
		models: ccgoModels,
	});
	// 其它 common 条目
	if (Array.isArray(raw?.providers)) {
		for (const p of raw.providers) {
			if (p?.kind !== "common") continue;
			if (typeof p.name !== "string" || !p.name.trim()) continue;
			const entry: CommonEntry = {
				kind: "common",
				name: p.name.trim(),
				api: typeof p.api === "string" && KNOWN_APIS.includes(p.api) ? p.api : "openai-completions",
				baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
				models: sortModels(normalizeStoredModels(p.models)),
			};
			providers.push(entry);
		}
	}
	return { schemaVersion: 2, providers };
}

async function loadStore(): Promise<void> {
	try {
		const raw = await readFile(STORE_FILE, "utf8");
		store = normalizeStore(JSON.parse(raw));
	} catch {
		store = createDefaultStore();
		await saveStore();
	}
}

async function saveStore(): Promise<void> {
	try {
		await mkdir(dirname(STORE_FILE), { recursive: true });
		const persisted: Store = {
			schemaVersion: 2,
			providers: store.providers.map((provider) =>
				provider.kind === "common"
					? {
							kind: "common",
							name: provider.name,
							api: provider.api,
							baseUrl: provider.baseUrl,
							models: provider.models,
						} as CommonEntry
					: provider,
			),
		};
		await writeFile(STORE_FILE, JSON.stringify(persisted, null, 2), "utf8");
	} catch {
		// 静默忽略保存错误
	}
}

function getBuiltinEntry(id?: BuiltinEntry["name"]): BuiltinEntry | undefined {
	const all = store.providers.filter((p): p is BuiltinEntry => p.kind === "builtin");
	return id ? all.find((p) => p.name === id) : all[0];
}

function getCommonEntries(): CommonEntry[] {
	return store.providers.filter((p): p is CommonEntry => p.kind === "common");
}

// =============================================================================
// 通用取模（common 供应商）：按官方 api 类型拉取模型列表
// =============================================================================

async function tryFetchJson(path: string, baseUrl: string, headers: Record<string, string>): Promise<any | null> {
	try {
		const res = await fetch(`${baseUrl}${path}`, {
			headers: { Accept: "application/json", ...headers },
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

type ConnectivityResult =
	| { ok: true; status: number; modelCount: number; authRequired?: boolean }
	| { ok: false; reason: "invalid-url" | "network" | "http" | "auth" | "response"; message: string };

function buildModelsHeaders(apiType: string, apiKey?: string): Record<string, string> {
	const headers: Record<string, string> = {};
	if (apiType === "anthropic-messages") {
		headers["anthropic-version"] = "2023-06-01";
		if (apiKey) headers["x-api-key"] = apiKey;
	} else if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

/** Anthropic SDK 会自动追加 /v1/messages，注册给 SDK 的 baseUrl 需去掉末尾 /v1。 */
function toAnthropicSdkBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** 直连 Anthropic /models 或 /messages 时确保带有版本路径前缀（默认补 /v1）。 */
function toAnthropicApiV1Url(baseUrl: string): string {
	const clean = baseUrl.trim().replace(/\/+$/, "");
	return /\/v\d+$/i.test(clean) ? clean : `${clean}/v1`;
}

/** 保存新增或编辑的供应商前，确认 API 前缀和 /models 接口可访问。 */
async function checkProviderConnectivity(apiType: string, baseUrl: string, apiKey?: string): Promise<ConnectivityResult> {
	const base = apiType === "anthropic-messages" ? toAnthropicApiV1Url(baseUrl) : baseUrl.trim().replace(/\/+$/, "");
	let endpoint: URL;
	try {
		endpoint = new URL(`${base}/models`);
		if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
			return { ok: false, reason: "invalid-url", message: "地址必须使用 http:// 或 https://。" };
		}
	} catch {
		return { ok: false, reason: "invalid-url", message: `地址格式无效：${baseUrl}` };
	}

	try {
		const res = await fetch(endpoint, {
			method: "GET",
			headers: { Accept: "application/json", ...buildModelsHeaders(apiType, apiKey) },
			signal: AbortSignal.timeout(15000),
		});
		if (res.status === 401 || res.status === 403) {
			// 新增供应商尚未保存时无法执行 /login，因此认证失败不能阻止保存；
			// 401/403 已经证明地址可访问，保存后再登录并刷新模型即可。
			return { ok: true, status: res.status, modelCount: 0, authRequired: true };
		}
		if (!res.ok) {
			const detail = formatUpstreamError(res.status, await res.text().catch(() => ""));
			return {
				ok: false,
				reason: "http",
				message: `请求 /models 失败（${detail}）。请检查 API 前缀和请求格式。`,
			};
		}
		if (res.status === 204) return { ok: true, status: res.status, modelCount: 0 };

		const text = await res.text();
		let data: any;
		try {
			data = JSON.parse(text);
		} catch {
			return { ok: false, reason: "response", message: "接口已返回成功状态，但响应不是有效 JSON。" };
		}
		const list = [data?.data, data?.models, data?.ids, data?.list, data?.items].find(Array.isArray);
		if (!list) {
			return { ok: false, reason: "response", message: "接口已返回成功状态，但没有识别到模型列表。" };
		}
		return { ok: true, status: res.status, modelCount: list.length };
	} catch (error) {
		const message = formatErrorMessage(error) || "网络连接失败";
		return { ok: false, reason: "network", message: `无法访问 /models：${message}` };
	}
}

async function getProviderApiKey(ctx: any, providerNames: string[]): Promise<string | undefined> {
	for (const providerName of providerNames) {
		if (!providerName) continue;
		try {
			const key = extractCredentialKey(await (ctx.modelRegistry as any)?.getApiKeyForProvider(providerName));
			if (key) return key;
		} catch {
			// 认证不存在时继续尝试其它名称。
		}
	}
	return undefined;
}

/** 失败后重新回到地址输入，让用户修改后继续检查；按 Esc 才取消流程。 */
async function promptVerifiedBaseUrl(
	ctx: any,
	apiType: string,
	prompt: string,
	initialValue: string,
	providerNames: string[],
): Promise<string | undefined> {
	let value = initialValue;
	while (true) {
		const input = await ctx.ui.input(prompt, value);
		if (!input?.trim()) return undefined;
		value = input.trim().replace(/\/+$/, "");
		if (/\/(models|messages|responses|chat\/completions)$/i.test(value)) {
			ctx.ui.notify("这里只填写 API 前缀，不要填写具体接口路径。请修改后重试。", "error");
			continue;
		}

		ctx.ui.setStatus("model-provider", `正在检查 ${value}/models 连通性...`);
		let check: ConnectivityResult;
		try {
			const key = await getProviderApiKey(ctx, providerNames);
			check = await checkProviderConnectivity(apiType, value, key);
		} finally {
			ctx.ui.setStatus("model-provider", undefined);
		}
		if (check.ok) return value;
		ctx.ui.notify(`供应商地址检查失败：${check.message}\n请修改地址后重试，按 Esc 可取消。`, "error");
	}
}

type ModelInput = ("text" | "image")[];

/** 服务端没有返回上下文窗口时，通用模型使用 1M 默认值。 */
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * 从 /models 返回的供应商扩展字段推断输入能力。
 * 标准 OpenAI/Claude /models 通常只有 id，没有能力字段；未知时默认开放图片输入，
 * 这样通用模型可以直接接收图片。若接口明确声明仅 text，则保留为文本模型。
 */
function inferModelInput(raw: any): ModelInput {
	const candidates = [
		raw?.input,
		raw?.modalities,
		raw?.input_modalities,
		raw?.supported_modalities,
		raw?.capabilities?.input,
		raw?.capabilities?.input_modalities,
		raw?.architecture?.input_modalities,
	].filter(Array.isArray) as unknown[][];
	const declared = candidates.flat().map((value) => String(value).toLowerCase());
	const hasImage = declared.some((value) => value.includes("image") || value.includes("vision") || value.includes("picture"));
	const hasText = declared.some((value) => value.includes("text"));
	if (hasImage || raw?.supports_vision === true || raw?.vision === true || raw?.capabilities?.vision === true) {
		return ["text", "image"];
	}
	if (raw?.supports_vision === false || raw?.vision === false || (declared.length > 0 && hasText)) {
		return ["text"];
	}
	// 绝大多数模型目录不会返回能力字段，默认允许图片；用户可以在模型管理中切换。
	return ["text", "image"];
}

/**
 * 通用供应商统一使用 pi 的请求格式和 /settings 思考等级。
 * 只有服务端明确声明不支持思考时才关闭，避免依赖易过时的模型名称规则。
 */
function inferModelReasoning(raw: any): boolean {
	const values = [
		raw?.reasoning,
		raw?.supports_reasoning,
		raw?.supportsReasoning,
		raw?.thinking,
		raw?.capabilities?.reasoning,
		raw?.capabilities?.thinking,
	];
	const declared = values.find((value) => typeof value === "boolean");
	return declared === false ? false : true;
}

/** pi 官方全档思考等级（off 映射 none，其余恒等），对齐 pi 内置 OpenAI 模型的惯例。 */
const FULL_THINKING_LEVEL_MAP: Record<string, string> = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/**
 * 推断模型思考能力 + 思考等级映射。
 * 服务端能获取到能力声明就使用声明（明确不支持思考 → 只有 off，不补全）；
 * 获取不到时补全全部等级（含 xhigh/max），使 /settings 中可配置全部档位。
 */
function inferModelThinking(raw: any, apiType?: string): { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> } {
	const values = [
		raw?.reasoning,
		raw?.supports_reasoning,
		raw?.supportsReasoning,
		raw?.thinking,
		raw?.capabilities?.reasoning,
		raw?.capabilities?.thinking,
	];
	const declared = values.find((value) => typeof value === "boolean");
	if (declared === false) return { reasoning: false };
	if (apiType === "anthropic-messages" && typeof raw?.id === "string") {
		const profile = resolveAnthropicThinkingProfile(raw.id);
		return {
			reasoning: true,
			...(profile.thinkingLevelMap ? { thinkingLevelMap: profile.thinkingLevelMap } : {}),
		};
	}
	return { reasoning: true, thinkingLevelMap: { ...FULL_THINKING_LEVEL_MAP } };
}

function extractModels(data: any, api: string): StoredModel[] {
	let arr = data?.data ?? data?.models ?? data?.ids ?? data?.list ?? data?.items;
	if (!Array.isArray(arr)) arr = [];
	const out: StoredModel[] = [];
	for (const m of arr) {
		if (m === undefined || m === null) continue;
		if (typeof m === "string") {
			const thinking = inferModelThinking({ id: m }, api);
			out.push({
				id: m,
				reasoning: thinking.reasoning,
				...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
				input: ["text", "image"],
				enabled: false,
			});
			continue;
		}
		const rawId = m?.id ?? m?.name ?? m?.model ?? m?.key ?? (typeof m === "object" ? Object.keys(m)[0] : undefined);
		if (typeof rawId !== "string" || !rawId.trim()) continue;
		let id = rawId.trim();
		if (api.startsWith("google-")) id = id.replace(/^models\//, "");
		const display = m?.display_name ?? m?.displayName ?? id;
		const contextWindow = [m?.contextWindow, m?.context_window, m?.context_length, m?.max_context_length, m?.limit?.context]
			.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
		const maxTokens = [m?.maxTokens, m?.max_tokens, m?.max_output_tokens, m?.limit?.output]
			.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
		const thinking = inferModelThinking({ ...m, id }, api);
		out.push({
			id,
			name: typeof display === "string" ? display : id,
			reasoning: thinking.reasoning,
			...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
			input: inferModelInput(m),
			enabled: false,
			...(contextWindow ? { contextWindow } : {}),
			...(maxTokens ? { maxTokens } : {}),
		});
	}
	return out;
}

/**
 * common 供应商只保存 API 前缀，例如 https://api.openai.com/v1。
 * 三种格式的模型目录都按前缀拼接 /models；对话请求仍完全由 pi 官方 api 实现。
 */
async function fetchModelsByApi(api: string, baseUrl: string, apiKey?: string): Promise<StoredModel[]> {
	const base = api === "anthropic-messages" ? toAnthropicApiV1Url(baseUrl) : baseUrl.trim().replace(/\/+$/, "");
	const headers: Record<string, string> = {};
	if (api === "anthropic-messages") {
		headers["anthropic-version"] = "2023-06-01";
		if (apiKey) headers["x-api-key"] = apiKey;
	} else if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const data = await tryFetchJson("/models", base, headers);
	if (!data) {
		throw new Error(`无法获取模型列表：${base}/models 不可用或认证失败`);
	}
	const list = extractModels(data, api);
	if (list.length === 0) {
		throw new Error(`${base}/models 返回为空或格式无法识别`);
	}
	return list;
}

// =============================================================================
// 通用注册：builtin + common 供应商
// =============================================================================

/**
 * 推断模型的初始思考参数格式。
 *
 * 只作为探测前的默认值：真正准确的格式由“刷新启用模型思考”实测写入。
 * pi-ai 只有命中某个 thinkingFormat 分支才会下发思考参数，不设这个字段
 * 时无论传什么 reasoning 都会被静默丢弃。
 *
 * pi 自带的 detectCompat 只按 provider 名或 baseUrl 判断，聚合供应商
 * （如 commandcodego）下的模型识别不出来，所以这里按模型 id 兜一个。
 */
function inferThinkingFormat(modelId: string): string | undefined {
	if (/^deepseek[\/-]/i.test(modelId)) return "deepseek";
	return undefined;
}

function normalizeModel(m: StoredModel, apiType?: string): any {
	// 实测写入的优先，没测过才按 id 前缀兜个默认值
	const thinkingFormat = m.thinkingFormat ?? inferThinkingFormat(m.id);
	const base: any = {
		id: m.id,
		name: m.name ?? m.id,
		reasoning: m.reasoning ?? false,
		input: m.input ?? ["text", "image"],
		contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: m.maxTokens ?? 16384,
		cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsReasoningEffort: true,
			// 第三方网关（cctq、各类中转/代理）普遍只接受 system/user/assistant/tool，
			// pi-ai 默认会在 reasoning 模型上把系统提示词发成 developer 角色，导致 400
			// “unknown variant `developer`”。这里统一退回 system 角色。
			supportsDeveloperRole: false,
			...(thinkingFormat ? { thinkingFormat } : {}),
		},
	};
	if (m.thinkingLevelMap) base.thinkingLevelMap = m.thinkingLevelMap;
	if (apiType === "anthropic-messages") {
		Object.assign(base, applyAnthropicCompat(base, m.forceAdaptiveThinking));
	}
	// API 通道按此字段选 /messages 还是 /chat/completions；联络式模型自带，其它忽略
	if (m.supportedEndpoints) base.supportedEndpoints = m.supportedEndpoints;
	return base;
}

/** 模型是否启用（未设置 enabled 视为启用，兼容旧配置）。 */
function isModelEnabled(m: StoredModel): boolean {
	return m.enabled !== false;
}

/** 启用的模型排在前面（稳定排序，各组内保持原有相对顺序）。 */
function sortModels(models: StoredModel[]): StoredModel[] {
	const enabled: StoredModel[] = [];
	const disabled: StoredModel[] = [];
	for (const m of models) {
		(isModelEnabled(m) ? enabled : disabled).push(m);
	}
	return [...enabled, ...disabled];
}

function mergeModels(existing: StoredModel[], fetched: StoredModel[]): StoredModel[] {
	// 新拉取的模型一律默认未勾选（不显示在 /model），需在“启用模型”中手动挑选；
	// 已存在的模型保留用户的勾选与配置，同时刷新服务端元信息（如 supportedEndpoints）。
	const merged = fetched.map((f) => {
		const old = existing.find((e) => e.id === f.id);
		if (!old) return { ...f, enabled: false };
		return {
			...f,
			...old,
			...(f.supportedEndpoints?.length ? { supportedEndpoints: f.supportedEndpoints } : {}),
			...(f.name && (!old.name || old.name === old.id) ? { name: f.name } : {}),
		};
	});
	for (const e of existing) {
		if (!fetched.some((f) => f.id === e.id)) {
			merged.push(e);
		}
	}
	return sortModels(merged);
}

function registerCommon(pi: ExtensionAPI, entry: CommonEntry): void {
	const cfg: any = {
		name: entry.name,
		baseUrl: entry.api === "anthropic-messages" ? toAnthropicSdkBaseUrl(entry.baseUrl) : entry.baseUrl,
		api: entry.api,
		// 只注册勾选启用的模型；未勾选的保留在配置中但不显示在 /model。
		models: entry.models.filter(isModelEnabled).map((m) => normalizeModel(m, entry.api)),
		// 仅允许登录后的有网络刷新访问 /models；注册、注销、删除模型等本地变更
		// 会触发 pi 的无网络同步，此时必须直接保留当前列表。
		// 未勾选启用的模型不暴露给 pi，因此不会出现在 /model 选择器中。
		refreshModels: async (context: any) => {
			if (context?.allowNetwork !== true || context?.signal?.aborted) {
				return entry.models.filter(isModelEnabled).map((m) => normalizeModel(m, entry.api));
			}
			const key = extractCredentialKey(context?.credential);
			const fetched = await fetchModelsByApi(entry.api, entry.baseUrl, key);
			const merged = mergeModels(entry.models, fetched);
			entry.models = merged;
			await saveStore();
			return merged.filter(isModelEnabled).map((m) => normalizeModel(m, entry.api));
		},
	};
	pi.registerProvider(entry.name, cfg);
}

function unregisterAndReRegister(pi: ExtensionAPI, oldName: string | null, entry: CommonEntry): void {
	if (oldName && oldName !== entry.name) {
		pi.unregisterProvider(oldName);
	}
	pi.unregisterProvider(entry.name);
	registerCommon(pi, entry);
}

/** 模型等本地变更后重新注册：builtin 走各自专属注册，common 走通用注册。 */
function reRegisterEntry(entry: ProviderEntry): void {
	if (!api) return;
	if (entry.kind === "builtin") registerCommandCodeGo(api);
	else unregisterAndReRegister(api, entry.name, entry);
}

/**
 * 注册内置 Command Code 供应商。
 *
 * 模型目录固定走 /provider/v1/models（所有套餐都可读），而对话通道由
 * 持久化的套餐类型（planMode）决定：GO 套餐只能用 /alpha/generate，
 * GOAT / Pro / Max / Provider 套餐走官方 Provider API。因此必须自带
 * streamSimple 做分流。带 oauth 后该 provider 会出现在 /login 的
 * 「Sign in with an account」中。
 */
function registerCommandCodeGo(pi: ExtensionAPI): void {
	const entry = getBuiltinEntry("commandcodego");
	if (!entry || entry.name !== "commandcodego") return;
	const cfg = entry.commandcodeGo;
	setCommandCodeGoConfig(cfg);
	const buildEnabledModels = (): CcGoModelConfig[] =>
		entry.models
			.filter(isModelEnabled)
			.map((m) =>
				normalizeModel(
					m,
					cfg.planMode === "api" && resolveEndpoint(m as any) === "anthropic-messages" ? "anthropic-messages" : undefined,
				) as unknown as CcGoModelConfig,
			);
	pi.unregisterProvider(CCGO_PROVIDER_ID);
	pi.registerProvider(CCGO_PROVIDER_ID, buildCommandCodeGoConfig({
		config: cfg,
		models: buildEnabledModels(),
		persist: async (fetched) => {
			// 远端目录写回本地配置，供「启用模型」勾选；
			// supportedEndpoints 必须一并落盘：API 通道靠它判断该模型走 /messages 还是 /chat/completions。
			const remote = fetched as {
				id: string;
				name: string;
				contextWindow: number;
				input: ("text" | "image")[];
				supportedEndpoints: string[];
			}[];
			const merged = mergeModels(entry.models, remote.map((r) => ({
				id: r.id,
				name: r.name,
				input: r.input,
				contextWindow: r.contextWindow,
				...(r.supportedEndpoints?.length ? { supportedEndpoints: r.supportedEndpoints } : {}),
			})));
			entry.models = sortModels(merged);
			await saveStore();
			return buildEnabledModels();
		},
	}) as any);
}

function registerAllProviders(pi: ExtensionAPI): void {
	registerCommandCodeGo(pi);
	for (const entry of getCommonEntries()) {
		registerCommon(pi, entry);
	}
}

// =============================================================================
// /model-provider 命令：供应商增删改查与模型管理
// =============================================================================

function listProvidersText(): string {
	const lines: string[] = ["━━━━━━ 当前供应商 ━━━━━━"];
	for (const p of store.providers) {
		if (p.kind === "builtin") {
			const enabledCount = p.models.filter(isModelEnabled).length;
			if (p.name === "commandcodego") {
				const mode = p.commandcodeGo.planMode;
				lines.push(`● ${p.name}（内置 ${CCGO_LABEL}，固定供应商）`);
				lines.push(`   地址：${p.commandcodeGo.baseUrl}`);
				lines.push(
					mode === "api"
						? `   套餐类型：GOAT / Pro / Max / Provider（Provider API）`
						: `   套餐类型：GO（仅 /alpha/generate）`,
				);
				lines.push(
					mode === "api"
						? `   对话通道：/provider/v1/chat/completions（Claude 走 /provider/v1/messages）`
						: `   对话通道：/alpha/generate（GO 套餐无 Provider API 权限）`,
				);
				lines.push(`   模型：启用 ${enabledCount} / 共 ${p.models.length} 个（登录后可在“刷新模型”拉取目录）`);
				lines.push(`   登录：/login → Sign in with an account → ${CCGO_LABEL}`);
				lines.push(`   套餐类型可在「管理模型 → ${p.name} → 套餐类型」手动修改`);
			}
		} else {
			const apiOption = getCommonApiOption(p.api);
			const enabledCount = p.models.filter(isModelEnabled).length;
			lines.push(`● ${p.name}`);
			lines.push(`   请求格式：${apiOption.label}（${p.api}）`);
			lines.push(`   请求地址前缀：${p.baseUrl}`);
			lines.push(`   模型：启用 ${enabledCount} / 共 ${p.models.length} 个（未勾选的不显示在 /model 中）`);
			lines.push(`   认证：/login ${p.name}  自动取模：开启`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

async function addCommonFlow(ctx: any): Promise<void> {
	// common 供应商只需要三个字段：名称、官方请求格式、API 前缀地址。
	const name = await ctx.ui.input("供应商名称（英文/数字/下划线，作为唯一 id）", "如 my-ollama、openai-proxy");
	if (!name || !name.trim()) return;
	const cleanName = name.trim();
	if (!/^[A-Za-z0-9_\-]+$/.test(cleanName)) {
		ctx.ui.notify("供应商名称只能包含字母、数字、下划线、连字符。", "error");
		return;
	}
	if (cleanName === CCGO_PROVIDER_ID || getCommonEntries().some((p) => p.name === cleanName)) {
		ctx.ui.notify(`供应商 "${cleanName}" 已存在或是内置供应商。`, "error");
		return;
	}

	const apiOptions = COMMON_API_OPTIONS.map((option) =>
		`${option.label}（${option.api}）· ${option.description}`,
	);
	apiOptions.push("取消");
	const apiChoice = await ctx.ui.select("选择请求格式", apiOptions);
	if (!apiChoice || apiChoice === "取消") return;
	const selected = COMMON_API_OPTIONS.find((option) => apiChoice.startsWith(`${option.label}（`));
	if (!selected) return;

	const baseUrl = await promptVerifiedBaseUrl(
		ctx,
		selected.api,
		`请求地址前缀（示例：${selected.example}）`,
		selected.example,
		[cleanName],
	);
	if (!baseUrl) return;

	const entry: CommonEntry = {
		kind: "common",
		name: cleanName,
		api: selected.api,
		baseUrl,
		models: [],
	};

	store.providers.push(entry);
	if (api) {
		api.unregisterProvider(entry.name);
		registerCommon(api, entry);
	}
	await saveStore();
	ctx.ui.notify(
		`已添加供应商 ${entry.name}。${selected.label} · ${entry.baseUrl}\n下一步：/login ${entry.name} 认证后刷新模型，或直接新增模型。`,
		"info",
	);
}

/**
 * 选择供应商。includeBuiltin = true 时，内置供应商同时列出（仅“管理模型”入口使用）。
 */
async function selectProvider(ctx: any, title: string, includeBuiltin = false): Promise<ProviderEntry | undefined> {
	const entries: ProviderEntry[] = [
		...getCommonEntries(),
		...(includeBuiltin ? store.providers.filter((p): p is BuiltinEntry => p.kind === "builtin") : []),
	];
	if (entries.length === 0) {
		ctx.ui.notify("暂无供应商，请先“添加供应商”。", "warning");
		return undefined;
	}
	const options = entries.map((p) => {
		const enabledCount = p.models.filter(isModelEnabled).length;
		if (p.kind === "builtin") {
			return `${p.name}  [内置 ${CCGO_LABEL}]  ${p.commandcodeGo.baseUrl}  （启用 ${enabledCount}/${p.models.length} 个模型）`;
		}
		const apiOption = getCommonApiOption(p.api);
		return `${p.name}  [${apiOption.label}]  ${p.baseUrl}  （启用 ${enabledCount}/${p.models.length} 个模型）`;
	});
	options.push("取消");
	const choice = await ctx.ui.select(title, options);
	if (!choice || choice === "取消") return undefined;
	const picked = choice.split(/\s+\[/)[0];
	return entries.find((p) => p.name === picked);
}

async function editCommonFlow(ctx: any): Promise<void> {
	const entry = await selectProvider(ctx, "选择要编辑的供应商");
	if (!entry || entry.kind !== "common") return;
	const oldName = entry.name;

	const newName = (await ctx.ui.input(`供应商名称（当前：${entry.name}）`, entry.name))?.trim() || entry.name;
	const apiOptions = COMMON_API_OPTIONS.map((option) =>
		`${option.label}（${option.api}）· ${option.description}`,
	);
	apiOptions.push("取消");
	const currentOption = COMMON_API_OPTIONS.find((option) => option.api === entry.api) ?? COMMON_API_OPTIONS[0];
	const apiChoice = await ctx.ui.select(`选择请求格式（当前：${currentOption.label}）`, [
		...apiOptions.map((option) => option.startsWith(`${currentOption.label}（`) ? `${option}  ← 当前` : option),
	]);
	if (!apiChoice || apiChoice === "取消") return;
	const selected = COMMON_API_OPTIONS.find((option) => apiChoice.startsWith(`${option.label}（`));
	if (!selected) return;

	const newBase = await promptVerifiedBaseUrl(
		ctx,
		selected.api,
		`请求地址前缀（当前：${entry.baseUrl}）`,
		entry.baseUrl,
		[newName, oldName],
	);
	if (!newBase) return;
	if (!/^[A-Za-z0-9_\-]+$/.test(newName)) {
		ctx.ui.notify("供应商名称只能包含字母、数字、下划线、连字符。", "error");
		return;
	}
	const existingSameName = getCommonEntries().some((p) => p.name === newName && p !== entry);
	if (existingSameName) {
		ctx.ui.notify(`供应商 "${newName}" 已存在或是内置供应商。`, "error");
		return;
	}

	entry.name = newName;
	entry.api = selected.api;
	entry.baseUrl = newBase;

	if (api) unregisterAndReRegister(api, oldName, entry);
	await saveStore();
	ctx.ui.notify(`已更新供应商 ${entry.name}。若修改了名称，请对 ${oldName} 重新执行 /login（旧凭据按旧 id 保存）。`, "info");
}

async function removeCommonFlow(ctx: any): Promise<void> {
	const entry = await selectProvider(ctx, "选择要移除的供应商");
	if (!entry || entry.kind !== "common") return;
	const ok = await ctx.ui.confirm("确认移除", `确定移除供应商 ${entry.name}？其模型将一并删除。`);
	if (!ok) return;
	store.providers = store.providers.filter((p) => p !== entry);
	if (api) api.unregisterProvider(entry.name);
	await saveStore();
	ctx.ui.notify(`已移除供应商 ${entry.name}。`, "info");
}

async function refreshCommonModels(ctx: any, entry: ProviderEntry): Promise<void> {
	ctx.ui.setStatus("model-provider", `正在刷新 ${entry.name} 模型列表...`);
	try {
		let key: string | undefined;
		try {
			key = extractCredentialKey(await (ctx.modelRegistry as any)?.getApiKeyForProvider(entry.name));
		} catch {
			key = undefined;
		}
		let list: StoredModel[];
		if (entry.kind === "builtin" && entry.name === "commandcodego") {
			// Command Code 的模型目录在 {baseUrl}/provider/v1/models，与其它供应商既不同站也不同路径，
			// 必须走它自己的拉取函数；套用通用的 /v1/models 会认证失败。
			const remote = await fetchCommandCodeGoModels(key, entry.commandcodeGo.baseUrl);
			if (remote.length === 0) {
				throw new Error(`${entry.commandcodeGo.baseUrl}/provider/v1/models 返回为空，请先 /login 登录 ${CCGO_LABEL} 账号`);
			}
			// 不写 reasoning/thinkingLevelMap：注册时 buildCommandCodeGoConfig 会补 CCGO 专属档位映射。
			// supportedEndpoints 必须写入：API 通道靠它判断模型走 /messages 还是 /chat/completions。
			list = remote.map((m) => ({
				id: m.id,
				name: m.name || m.id,
				input: normalizeInput(m.input),
				...(m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
				...(Array.isArray(m.supportedEndpoints) && m.supportedEndpoints.length > 0
					? { supportedEndpoints: m.supportedEndpoints }
					: {}),
				enabled: false,
			}));
		} else {
			list = await fetchModelsByApi(entry.api, entry.baseUrl, key);
		}
		const knownIds = new Set(entry.models.map((m) => m.id));
		const added = list.filter((m) => !knownIds.has(m.id)).length;
		entry.models = mergeModels(entry.models, list);
		reRegisterEntry(entry);
		await saveStore();
		const enabledCount = entry.models.filter(isModelEnabled).length;
		let message = `已刷新 ${entry.name}：启用 ${enabledCount} / 共 ${entry.models.length} 个模型。`;
		if (added > 0) {
			message += `\n新增 ${added} 个模型默认未勾选，请到“启用模型”中挑选启用。`;
		}
		ctx.ui.notify(message, "info");
	} catch (e) {
		ctx.ui.notify(`刷新失败：${formatErrorMessage(e) || "未知错误"}\n可在“新增模型”中手动添加。`, "error");
	} finally {
		ctx.ui.setStatus("model-provider", undefined);
	}
}

type ProbeOutcome =
	| { kind: "anthropic"; result: AnthropicProbeResult }
	| { kind: "openai"; result: ModelProbeResult }
	| { kind: "none" };

const inFlightProbeKeys = new Set<string>();
const sessionAttemptedProbeKeys = new Set<string>();
const silentProbeControllers = new Map<string, Set<AbortController>>();

function probeKey(entryName: string, modelId: string): string {
	return `${entryName}\0${modelId}`;
}

function needsThinkingProbe(entryName: string, model: StoredModel): boolean {
	if (!isModelEnabled(model)) return false;
	if (model.thinkingProbed === true || model.thinkingFormat || typeof model.forceAdaptiveThinking === "boolean") {
		return false;
	}
	const key = probeKey(entryName, model.id);
	return !inFlightProbeKeys.has(key) && !sessionAttemptedProbeKeys.has(key);
}

async function probeSingleModel(
	connection: { baseUrl: string; protocol: ProbeProtocol },
	apiKey: string,
	model: StoredModel,
	signal: AbortSignal,
	onNote?: (note: string) => void,
): Promise<ProbeOutcome> {
	const isAnthropic =
		connection.protocol === "anthropic-messages" ||
		(connection.protocol === "commandcode-api" && resolveEndpoint(model as any) === "anthropic-messages");
	if (isAnthropic) {
		const result = await probeAnthropicThinkingLevels(
			{
				baseUrl: connection.baseUrl,
				apiKey,
				modelId: model.id,
				sendBearer: connection.protocol === "commandcode-api",
			},
			signal,
			onNote,
		);
		return result.mode !== undefined ? { kind: "anthropic", result } : { kind: "none" };
	}
	const result = await probeThinkingLevels(
		{ baseUrl: connection.baseUrl, apiKey, modelId: model.id, formats: THINK_FORMATS },
		signal,
		onNote,
	);
	return result.thinkingFormat !== undefined ? { kind: "openai", result } : { kind: "none" };
}

function applyProbeOutcome(entry: ProviderEntry, modelId: string, outcome: ProbeOutcome): string | undefined {
	if (outcome.kind === "none") return undefined;
	// 每次从最新列表定位对象，避免异步期间用户操作列表导致写入旧引用
	const target = entry.models.find((m) => m.id === modelId);
	if (!target || !isModelEnabled(target)) return undefined;

	target.reasoning = true;
	target.thinkingProbed = true;
	if (outcome.kind === "anthropic") {
		const { result } = outcome;
		target.forceAdaptiveThinking = result.mode === "adaptive";
		delete target.thinkingFormat;
		const levelMap = buildAnthropicThinkingLevelMap(result);
		if (levelMap) target.thinkingLevelMap = levelMap;
		else delete target.thinkingLevelMap;
		const summary = result.levels.length > 0 ? result.levels.join("/") : "无";
		return `${target.id}：Anthropic ${result.mode}，档位 ${summary}${result.offClosable ? "，可关闭" : "，关不掉"}`;
	}
	const { result } = outcome;
	target.thinkingFormat = result.thinkingFormat;
	delete target.forceAdaptiveThinking;
	// 关闭生效时把实测出的关闭值挂到 minimal，给用户一个真正能关掉的选项
	target.thinkingLevelMap = buildThinkingLevelMap(result.levels, result.offClosable ? result.closeValue : undefined);
	const summary = result.levels.length > 0 ? result.levels.join("/") : "无";
	return `${target.id}：${result.thinkingFormat} 格式，档位 ${summary}${result.offClosable ? `，可关闭（${result.closeValue ?? "开关字段"}）` : "，关不掉"}`;
}

/**
 * 对已启用但从未探测过思考参数的模型，在后台静默执行思考探测与校准。
 *
 * 不阻塞当前操作且静默处理无密钥/不支持直连/探测失败的情况，防止未校准模型在后续对话中报错。
 */
function scheduleSilentThinkingProbe(ctx: any, entry: ProviderEntry, candidateIds?: string[]): void {
	const connection = resolveProbeConnection(entry);
	if (connection === undefined) return;
	const idSet = candidateIds ? new Set(candidateIds) : undefined;
	const initialTargets = entry.models.filter(
		(m) => (!idSet || idSet.has(m.id)) && needsThinkingProbe(entry.name, m),
	);
	if (initialTargets.length === 0) return;

	const keys = initialTargets.map((m) => probeKey(entry.name, m.id));
	for (const k of keys) {
		inFlightProbeKeys.add(k);
		sessionAttemptedProbeKeys.add(k);
	}

	const abort = new AbortController();
	let controllers = silentProbeControllers.get(entry.name);
	if (!controllers) {
		controllers = new Set();
		silentProbeControllers.set(entry.name, controllers);
	}
	controllers.add(abort);

	void (async () => {
		let updated = 0;
		try {
			const apiKey = await getProviderApiKey(ctx, [entry.name]);
			if (!apiKey || abort.signal.aborted) return;

			for (let i = 0; i < initialTargets.length; i++) {
				if (abort.signal.aborted) break;
				const modelId = initialTargets[i].id;
				const model = entry.models.find((m) => m.id === modelId);
				if (!model || !isModelEnabled(model)) continue;

				ctx.ui.setStatus("model-provider", `后台校准思考 ${i + 1}/${initialTargets.length}：${model.id}`);
				const outcome = await probeSingleModel(connection, apiKey, model, abort.signal);
				if (abort.signal.aborted && outcome.kind === "none") break;
				if (applyProbeOutcome(entry, modelId, outcome)) {
					updated += 1;
					reRegisterEntry(entry);
					await saveStore();
				}
			}
		} catch {
			// 后台静默校准失败时不打扰用户
		} finally {
			for (const k of keys) inFlightProbeKeys.delete(k);
			controllers?.delete(abort);
			if (controllers && controllers.size === 0) silentProbeControllers.delete(entry.name);
			ctx.ui.setStatus("model-provider", undefined);
			if (updated > 0) {
				ctx.ui.notify(
					`后台已静默校准 ${entry.name} ${updated} 个模型的思考等级（切换模型或新会话生效）。`,
					"info",
				);
			}
		}
	})();
}

/**
 * 实测已启用模型真正支持哪些思考档位，写回 thinkingLevelMap 与 thinkingFormat。
 *
 * 为什么必须直连而不是走 pi 的 modelRegistry：
 *   pi 内部把 reasoning:"off" 转成 undefined，off 档永远发不出去；
 *   而且是否下发思考参数取决于 thinkingFormat —— 那正是要测的东西，
 *   没设时所有档位请求完全相同，会全部 200、全部误判为支持。
 */
async function refreshThinkingLevels(ctx: any, entry: ProviderEntry): Promise<void> {
	const targets = entry.models.filter(isModelEnabled);
	if (targets.length === 0) {
		ctx.ui.notify("当前没有启用的模型。", "warning");
		return;
	}

	// 直连需要真实地址与密钥
	const connection = resolveProbeConnection(entry);
	if (connection === undefined) {
		ctx.ui.notify("当前供应商无法直连探测（私有协议或未配置地址），已跳过。", "warning");
		return;
	}
	const apiKey = await getProviderApiKey(ctx, [entry.name]);
	if (!apiKey) {
		ctx.ui.notify(`未找到 ${entry.name} 的密钥，请先登录或配置 API Key。`, "error");
		return;
	}

	// 手动触发时先中止该供应商正在进行的后台静默任务，并允许重新探测
	for (const c of silentProbeControllers.get(entry.name) ?? []) c.abort();
	for (const m of targets) sessionAttemptedProbeKeys.delete(probeKey(entry.name, m.id));

	const abort = new AbortController();
	let index = 0;
	let updated = 0;
	const unchanged: string[] = [];
	const notes: string[] = [];

	const runProbe = async (onStatus: (text: string) => void): Promise<void> => {
		try {
			for (const model of targets) {
				if (abort.signal.aborted) break;
				index += 1;
				const prefix = `正在探测 ${index}/${targets.length}：${model.id}`;
				onStatus(prefix);

				const key = probeKey(entry.name, model.id);
				inFlightProbeKeys.add(key);
				try {
					const outcome = await probeSingleModel(
						connection,
						apiKey,
						model,
						abort.signal,
						(note) => onStatus(`${prefix} · ${note}`),
					);
					if (abort.signal.aborted && outcome.kind === "none") break;
					const note = applyProbeOutcome(entry, model.id, outcome);
					if (note) {
						updated += 1;
						notes.push(note);
					} else {
						unchanged.push(model.id);
					}
				} finally {
					inFlightProbeKeys.delete(key);
				}
			}

			if (updated > 0) {
				reRegisterEntry(entry);
				await saveStore();
			}
		} catch (e) {
			notes.push(formatErrorMessage(e) || "探测过程发生未知错误");
		}
	};

	if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
		await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: null) => void) => {
			const comp = new ProbeProgressComponent(tui, theme, `思考探测：${entry.name}`, () => abort.abort());
			Promise.resolve()
				.then(() => runProbe((text) => comp.setStatus(text)))
				.finally(() => done(null));
			return comp;
		});
	} else {
		try {
			await runProbe((text) => ctx.ui.setStatus("model-provider", text));
		} finally {
			ctx.ui.setStatus("model-provider", undefined);
		}
	}

	const header = abort.signal.aborted
		? `已取消后续探测，已保存 ${updated} / ${targets.length} 个模型的结果。`
		: `已更新 ${updated} / ${targets.length} 个模型的思考等级。`;
	const lines = [header];
	if (notes.length > 0) lines.push("", ...notes);
	if (unchanged.length > 0) lines.push("", `没探到思考档位（配置保持原样）：${unchanged.join("、")}`);
	if (updated > 0) lines.push("", "已重新注册生效（当前会话切换模型或新会话即可使用）。");
	ctx.ui.notify(lines.join("\n"), updated > 0 ? "info" : "warning");
}

type ProbeProtocol = "openai-completions" | "anthropic-messages" | "commandcode-api";

/**
 * 解析直连探测用的端点前缀与协议。
 *
 * 支持标准 chat/completions、Anthropic Messages 以及 Command Code Provider API；
 * 私有协议（commandcode 的 GO 通道）与 Responses API 返回 undefined，保持原配置不动。
 */
function resolveProbeConnection(entry: ProviderEntry): { baseUrl: string; protocol: ProbeProtocol } | undefined {
	if (entry.kind === "builtin") {
		// GO 套餐走 /alpha/generate 私有 NDJSON，不支持分协议直连探测，跳过
		if (entry.commandcodeGo.planMode !== "api") return undefined;
		const base = (entry.commandcodeGo.baseUrl || CCGO_BASE_URL).replace(/\/+$/, "");
		return { baseUrl: `${base}/provider/v1`, protocol: "commandcode-api" };
	}
	if (entry.api !== "openai-completions" && entry.api !== "anthropic-messages") return undefined;
	const base = (entry.baseUrl || "").trim().replace(/\/+$/, "");
	if (!base) return undefined;
	return {
		baseUrl: entry.api === "anthropic-messages" ? toAnthropicApiV1Url(base) : base,
		protocol: entry.api,
	};
}

class ProbeProgressComponent extends Container {
	private readonly statusText: Text;
	private readonly tui: any;
	private readonly onCancel: () => void;

	constructor(tui: any, theme: any, title: string, onCancel: () => void) {
		super();
		this.tui = tui;
		this.onCancel = onCancel;
		const border = theme.fg("border", "─".repeat(56));
		this.addChild(new Text(border, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
		this.statusText = new Text(theme.fg("muted", "  准备中..."), 0, 0);
		this.addChild(this.statusText);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  esc / ctrl+c 取消后续探测"), 0, 0));
		this.addChild(new Text(border, 0, 0));
	}

	setStatus(text: string): void {
		this.statusText.setText(`  ${text}`);
		this.tui?.requestRender?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onCancel();
			this.setStatus("正在取消...");
		}
	}
}

async function addModelsFlow(ctx: any, entry: ProviderEntry): Promise<void> {
	const ids = (await ctx.ui.input("新增模型（多个用逗号分隔）", "例如：gpt-4o, claude-sonnet-4-20250514"))?.trim();
	if (!ids) return;
	const list = ids.split(/[,，\s]+/).map((s: string) => s.trim()).filter(Boolean);
	const inputChoice = await ctx.ui.select("这些模型是否支持图片输入？", [
		"文本 + 图片（通用默认）",
		"仅文本",
		"取消",
	]);
	if (!inputChoice || inputChoice === "取消") return;
	const input = inputChoice.startsWith("文本") ? ["text", "image"] as ("text" | "image")[] : ["text"] as ("text" | "image")[];
	let added = 0;
	const addedIds: string[] = [];
	for (const id of list) {
		const old = entry.models.find((model) => model.id === id);
		if (old) {
			old.input = input;
		} else {
			// 内置 commandcodego 的档位映射按套餐与端点在注册时决定；通用供应商按其 api 推断
			const thinking: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> } =
				entry.kind === "builtin"
					? { reasoning: true }
					: inferModelThinking({ id }, entry.api);
			entry.models.push({
				id,
				...(thinking.reasoning ? { reasoning: true } : {}),
				...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
				input,
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				// 新增即勾选启用，省去再去「启用模型」里手动找一遍
				enabled: true,
			});
			added++;
			addedIds.push(id);
		}
	}
	entry.models = sortModels(entry.models);
	reRegisterEntry(entry);
	await saveStore();
	if (addedIds.length > 0) scheduleSilentThinkingProbe(ctx, entry, addedIds);
	const summary = added > 0 ? `新增 ${added} 个，已自动勾选启用` : "均已存在，仅更新了输入能力";
	ctx.ui.notify(`已处理 ${list.length} 个模型：${summary}。`, "info");
}

/**
 * 循环删除模型：选中 → 确认 → 删除，可连续删除；返回退出。
 * 删除的是保存在配置中的模型（含手动新增与刷新拉取的），刷新模型可重新拉取。
 */
async function removeModelFlow(ctx: any, entry: ProviderEntry): Promise<void> {
	if (entry.models.length === 0) {
		ctx.ui.notify("暂无模型。", "info");
		return;
	}
	while (true) {
		const options = entry.models.map(
			(model) => `${model.id}  [上下文 ${formatContextWindow(model.contextWindow)}]${isModelEnabled(model) ? "" : "  [已禁用]"}`,
		);
		options.push("返回");
		const choice = await ctx.ui.select(`删除模型：${entry.name}（共 ${entry.models.length} 个，选中即删除）`, options);
		if (!choice || choice === "返回") return;
		const id = choice.split(/\s+\[/)[0];
		const model = entry.models.find((m) => m.id === id);
		if (!model) continue;
		const ok = await ctx.ui.confirm("确认删除", `删除模型 ${id}？\n配置将移除（“刷新模型”可重新拉取，手动新增的需重新添加）。`);
		if (!ok) continue;
		entry.models = entry.models.filter((m) => m !== model);
		reRegisterEntry(entry);
		await saveStore();
		ctx.ui.notify(`已删除 ${id}：启用 ${entry.models.filter(isModelEnabled).length} / 共 ${entry.models.length} 个。`, "info");
		if (entry.models.length === 0) return;
	}
}

function parseContextWindowInput(value: string): number | undefined {
	const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|m|g)?$/);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const multiplier = match[2] === "g" ? 1_000_000_000 : match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	const result = Math.round(amount * multiplier);
	return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}

function formatContextWindow(value: number | undefined): string {
	if (!value) return `默认 ${DEFAULT_CONTEXT_WINDOW.toLocaleString()}（1M）`;
	if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
	if (value % 1_000 === 0) return `${value / 1_000}K`;
	return value.toLocaleString();
}

/**
 * 套餐类型：决定走 Provider API 还是 /alpha/generate。
 *
 * 登录成功后会自动判定一次并写入；用户可以在这里手动改。
 * 手动改过的值不会被后续任何操作（包括刷新模型、重新注册）覆盖。
 */
async function editPlanModeFlow(ctx: any, entry: ProviderEntry): Promise<void> {
	if (entry.kind !== "builtin" || entry.name !== "commandcodego") return;
	const cur = entry.commandcodeGo.planMode;
	const apiLabel = "GOAT / Pro / Max / Provider：可用 Provider API";
	const goLabel = "GO：仅 /alpha/generate";
	const choice = await ctx.ui.select(
		`套餐类型：${CCGO_LABEL}（决定请求通道）`,
		[
			`${apiLabel}${cur === "api" ? "  ← 当前" : ""}`,
			`${goLabel}${cur === "go" ? "  ← 当前" : ""}`,
		],
	);
	if (!choice) return;
	const mode: CcgoPlanMode = choice.startsWith("GOAT") ? "api" : "go";
	if (mode === cur) {
		ctx.ui.notify(`套餐类型未变更（${mode === "api" ? "Provider API" : "GO 通道"}）。`, "info");
		return;
	}
	entry.commandcodeGo.planMode = mode;
	// 先同步注入配置再重注册，否则重注册时拿到的还是旧值
	setCommandCodeGoConfig(entry.commandcodeGo);
	reRegisterEntry(entry);
	await saveStore();
	if (mode === "api") scheduleSilentThinkingProbe(ctx, entry);
	ctx.ui.notify(
		mode === "api"
			? "已切换为 Provider API 通道：请求走 /provider/v1/chat/completions（Claude 走 /provider/v1/messages）。"
			: "已切换为 GO 通道：请求走 /alpha/generate。",
		"info",
	);
}

async function editModelContextFlow(ctx: any, entry: ProviderEntry): Promise<void> {
	if (entry.models.length === 0) {
		ctx.ui.notify("暂无模型，请先刷新或手动添加。", "info");
		return;
	}
	const options = entry.models.map(
		(model) => `${model.id}  [上下文 ${formatContextWindow(model.contextWindow)}]${isModelEnabled(model) ? "" : "  [已禁用]"}`,
	);
	options.push("取消");
	const choice = await ctx.ui.select("选择要修改上下文窗口的模型", options);
	if (!choice || choice === "取消") return;
	const id = choice.split(/\s+\[/)[0];
	const model = entry.models.find((item) => item.id === id);
	if (!model) return;
	const value = await ctx.ui.input(
		`模型 ${id} 的上下文窗口（当前：${formatContextWindow(model.contextWindow)}）`,
		"例如：256k、512k、1m，也可以填写纯数字",
	);
	if (!value?.trim()) return;
	const contextWindow = parseContextWindowInput(value);
	if (!contextWindow) {
		ctx.ui.notify("上下文窗口必须是正整数，支持 256k、512k、1m 或纯数字。", "error");
		return;
	}
	model.contextWindow = contextWindow;
	reRegisterEntry(entry);
	await saveStore();
	ctx.ui.notify(`已更新 ${id}：上下文 ${formatContextWindow(contextWindow)}（${contextWindow.toLocaleString()}）`, "info");
}

/**
 * 批量设置图片读取能力：勾选 = 支持图片输入（文本 + 图片），未勾选 = 仅文本。
 * ctrl+s 保存后留在界面，esc 退出。
 */
async function editModelInputFlow(ctx: any, entry: ProviderEntry): Promise<void> {
	if (entry.models.length === 0) {
		ctx.ui.notify("暂无模型，请先刷新或手动添加。", "info");
		return;
	}
	const supportsImage = (model: StoredModel) => (model.input ?? ["text", "image"]).includes("image");
	const apply = async (ids: Set<string>) => {
		for (const model of entry.models) {
			model.input = ids.has(model.id) ? ["text", "image"] : ["text"];
		}
		reRegisterEntry(entry);
		await saveStore();
	};
	if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
		await ctx.ui.custom(
			(tui: any, theme: any, keybindings: any, done: (value: string[] | null) => void) =>
				new ModelToggleSelectorComponent(
					tui,
					{
						title: `图片读取：${entry.name}`,
						subtitle: "勾选表示支持图片输入（文本 + 图片），未勾选为仅文本",
						countLabel: "支持图片",
					},
					entry.models,
					entry.models.filter(supportsImage).map((m) => m.id),
					keybindings,
					theme,
					done,
					(ids) => apply(new Set(ids)),
				),
		);
	} else {
		await toggleViaSelectFallback(ctx, entry, {
			title: `图片读取：${entry.name}`,
			countLabel: "支持图片",
			isMarked: supportsImage,
			apply,
		});
	}
}

// =============================================================================
// 模型勾选组件（样式与交互对齐内置 /scoped-models 选择器）
// =============================================================================

interface ToggleItem {
	id: string;
	model: StoredModel;
	enabled: boolean;
}

/**
 * 模型勾选组件：↑↓ 选择、enter 切换勾选、ctrl+a 全选、ctrl+x 清空、
 * ctrl+s 保存、esc 取消；支持模糊搜索过滤；启用的模型始终排在列表最上面。
 * 仅限 TUI 模式通过 ctx.ui.custom() 挂载；done(enabledIds) 保存，done(null) 取消。
 */
/** 勾选组件的文案配置。 */
interface ModelToggleSelectorOptions {
	/** 标题，如 "启用模型：my-provider" */
	title: string;
	/** 副标题说明（muted 提示行） */
	subtitle: string;
	/** footer 计数标签，如 "已启用" / "支持图片" */
	countLabel: string;
}

class ModelToggleSelectorComponent extends Container {
	private modelsById = new Map<string, StoredModel>();
	private allIds: string[] = [];
	private enabledIds: string[];
	private filteredItems: ToggleItem[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private listContainer: Container;
	private footerText: Text;
	private readonly maxVisible = 8;
	private isDirty = false;
	private saving = false;
	private saveNote = "";
	private readonly options: ModelToggleSelectorOptions;
	private readonly tui: any;
	private readonly keybindings: any;
	private readonly theme: any;
	private readonly done: (result: string[] | null) => void;
	private readonly onSave?: (ids: string[]) => void | Promise<void>;

	constructor(
		tui: any,
		options: ModelToggleSelectorOptions,
		models: StoredModel[],
		initialEnabled: string[],
		keybindings: any,
		theme: any,
		done: (result: string[] | null) => void,
		onSave?: (ids: string[]) => void | Promise<void>,
	) {
		super();
		this.options = options;
		this.tui = tui;
		this.keybindings = keybindings;
		this.theme = theme;
		this.done = done;
		this.onSave = onSave;
		this.enabledIds = [...initialEnabled];
		for (const model of models) {
			this.modelsById.set(model.id, model);
			this.allIds.push(model.id);
		}
		const border = this.theme.fg("border", "─".repeat(56));
		this.addChild(new Text(border, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(options.title)), 0, 0));
		this.addChild(
			new Text(this.theme.fg("muted", `${options.subtitle} · ${this.keyLabel("app.models.save")} 保存`), 0, 0),
		);
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.footerText = new Text("", 0, 0);
		this.addChild(this.footerText);
		this.addChild(new Text(border, 0, 0));
		this.refresh();
	}

	private keyLabel(id: string): string {
		try {
			const keys = this.keybindings?.getKeys?.(id);
			return Array.isArray(keys) && keys.length > 0 ? keys.join("/") : "";
		} catch {
			return "";
		}
	}

	private buildItems(): ToggleItem[] {
		// 启用的排最上（按勾选顺序），未启用的保持原顺序排在后面
		const enabledSet = new Set(this.enabledIds);
		const sorted = [
			...this.enabledIds.filter((id) => this.modelsById.has(id)),
			...this.allIds.filter((id) => !enabledSet.has(id)),
		];
		return sorted.map((id) => ({ id, model: this.modelsById.get(id) as StoredModel, enabled: enabledSet.has(id) }));
	}

	/** ctrl+s：触发保存但不关闭组件，留在当前界面继续调整；esc 才退出。 */
	private triggerSave(): void {
		if (this.saving) return;
		if (!this.onSave) {
			this.done([...this.enabledIds]);
			return;
		}
		this.saving = true;
		this.saveNote = "";
		this.footerText.setText(this.theme.fg("dim", "  保存中..."));
		const ids = [...this.enabledIds];
		Promise.resolve()
			.then(() => this.onSave!(ids))
			.then(() => {
				this.saving = false;
				this.isDirty = false;
				this.saveNote = "已保存";
				this.refresh();
				this.tui?.requestRender?.();
			})
			.catch((e) => {
				this.saving = false;
				this.saveNote = `保存失败：${formatErrorMessage(e)}`;
				this.refresh();
				this.tui?.requestRender?.();
			});
	}

	private getFooterText(): string {
		const parts = [
			`${this.keyLabel("tui.select.confirm")} 切换`,
			`${this.keyLabel("app.models.enableAll")} 全选`,
			`${this.keyLabel("app.models.clearAll")} 清空`,
			`${this.keyLabel("app.models.save")} 保存`,
			"esc 取消",
			`${this.options.countLabel} ${this.enabledIds.length}/${this.allIds.length}`,
		];
		const text = `  ${parts.join(" · ")}${this.saveNote ? ` · ${this.saveNote}` : ""}`;
		return this.isDirty ? this.theme.fg("dim", text) + this.theme.fg("warning", " （未保存）") : this.theme.fg("dim", text);
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildItems();
		this.filteredItems = query ? fuzzyFilter(items, query, (item) => item.id) : items;
		if (this.selectedIndex >= this.filteredItems.length) {
			this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
		}
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  没有匹配的模型"), 0, 0));
			return;
		}
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const idText = isSelected ? this.theme.fg("accent", item.id) : item.id;
			const badge = this.theme.fg("muted", ` [${formatContextWindow(item.model.contextWindow)}]`);
			const status = item.enabled ? this.theme.fg("success", " ✓") : this.theme.fg("dim", " ✗");
			this.listContainer.addChild(new Text(`${prefix}${idText}${badge}${status}`, 0, 0));
		}
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}
		const selected = this.filteredItems[this.selectedIndex];
		this.listContainer.addChild(new Spacer(1));
		const detail = `${selected.model.name ?? selected.id} · ${inputModeText(selected.model.input)}${selected.model.reasoning ? " · 支持思考" : ""}`;
		this.listContainer.addChild(new Text(this.theme.fg("muted", `  ${detail}`), 0, 0));
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				const index = this.enabledIds.indexOf(item.id);
				if (index >= 0) this.enabledIds.splice(index, 1);
				else this.enabledIds.push(item.id);
				this.isDirty = true;
				this.refresh();
			}
			return;
		}
		if (kb.matches(data, "app.models.enableAll")) {
			// 有搜索词时只全选过滤结果，否则全选全部
			const targets = this.searchInput.getValue() ? this.filteredItems.map((i) => i.id) : this.allIds;
			for (const id of targets) {
				if (!this.enabledIds.includes(id)) this.enabledIds.push(id);
			}
			this.isDirty = true;
			this.refresh();
			return;
		}
		if (kb.matches(data, "app.models.clearAll")) {
			// 有搜索词时只清空过滤结果，否则清空全部
			if (this.searchInput.getValue()) {
				const targets = new Set(this.filteredItems.map((i) => i.id));
				this.enabledIds = this.enabledIds.filter((id) => !targets.has(id));
			} else {
				this.enabledIds = [];
			}
			this.isDirty = true;
			this.refresh();
			return;
		}
		if (kb.matches(data, "app.models.save")) {
			this.triggerSave();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.done(null);
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		// 其余按键交给搜索框
		this.searchInput.handleInput(data);
		this.refresh();
	}
}

/**
 * 非 TUI 模式（rpc/print 等）的降级勾选方式：循环单选模拟多选框。
 * “保存”后留在当前界面继续调整，“返回”才退出；由 apply 回调执行持久化。
 */
async function toggleViaSelectFallback(
	ctx: any,
	entry: ProviderEntry,
	opts: { title: string; countLabel: string; isMarked: (model: StoredModel) => boolean; apply: (ids: Set<string>) => void | Promise<void> },
): Promise<void> {
	const marked = new Set(entry.models.filter((m) => opts.isMarked(m)).map((m) => m.id));
	while (true) {
		entry.models = sortModels(entry.models);
		const options = entry.models.map((model) => {
			const mark = marked.has(model.id) ? "[✓]" : "[ ]";
			return `${mark} ${model.id}  [上下文 ${formatContextWindow(model.contextWindow)}]  [${inputModeText(model.input)}]`;
		});
		options.push("保存", "全部勾选", "全部取消", "返回");
		const title = `${opts.title}（${opts.countLabel} ${marked.size}/${entry.models.length}，选择条目即切换勾选）`;
		const choice = await ctx.ui.select(title, options);
		if (!choice || choice === "返回") return;
		if (choice === "保存") {
			await opts.apply(new Set(marked));
			ctx.ui.notify(`已保存：${opts.countLabel} ${marked.size}/${entry.models.length}。`, "info");
			continue;
		}
		if (choice === "全部勾选") {
			for (const model of entry.models) marked.add(model.id);
			continue;
		}
		if (choice === "全部取消") {
			marked.clear();
			continue;
		}
		const id = choice.replace(/^\[[✓ ]\]\s*/, "").split(/\s+\[/)[0];
		if (marked.has(id)) marked.delete(id);
		else marked.add(id);
	}
}

/**
 * 多选勾选入口：TUI 模式使用与内置 /scoped-models 一致的交互组件，
 * 其它模式降级为 select 循环。ctrl+s 保存后留在界面，esc 退出。
 */
async function toggleModelsFlow(ctx: any, entry: ProviderEntry): Promise<void> {
	if (entry.models.length === 0) {
		ctx.ui.notify("暂无模型，请先刷新或手动添加。", "info");
		return;
	}
	entry.models = sortModels(entry.models);
	const apply = async (ids: Set<string>) => {
		entry.models = sortModels(entry.models.map((m) => ({ ...m, enabled: ids.has(m.id) })));
		reRegisterEntry(entry);
		await saveStore();
		scheduleSilentThinkingProbe(ctx, entry, [...ids]);
	};
	if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
		await ctx.ui.custom(
			(tui: any, theme: any, keybindings: any, done: (value: string[] | null) => void) =>
				new ModelToggleSelectorComponent(
					tui,
					{
						title: `启用模型：${entry.name}`,
						subtitle: "勾选的模型显示在 /model 中",
						countLabel: "已启用",
					},
					entry.models,
					entry.models.filter(isModelEnabled).map((m) => m.id),
					keybindings,
					theme,
					done,
					(ids) => apply(new Set(ids)),
				),
		);
	} else {
		await toggleViaSelectFallback(ctx, entry, {
			title: `勾选启用的模型：${entry.name}`,
			countLabel: "已启用",
			isMarked: isModelEnabled,
			apply,
		});
	}
}

/** 模型管理：选供应商后进入操作循环；“返回供应商列表”回到选择，便于连续管理多个供应商 */
async function modelsMenu(ctx: any): Promise<void> {
	while (true) {
		// 内置供应商与通用供应商一并列出，可连续管理多个。
		const entry = await selectProvider(ctx, "管理模型：选择供应商", true);
		if (!entry) return;
		await modelOpsMenu(ctx, entry);
	}
}

async function modelOpsMenu(ctx: any, entry: ProviderEntry): Promise<void> {
	while (true) {
		const enabledCount = entry.models.filter(isModelEnabled).length;
		const items = [
			"启用模型",
			"刷新启用模型思考",
			"刷新模型",
			"新增模型",
			"删除模型",
			// 套餐类型决定请求通道：GO 走 /alpha/generate，其它套餐走 Provider API
			...(entry.kind === "builtin" && entry.name === "commandcodego" ? ["套餐类型"] : []),
			"修改上下文窗口",
			"是否支持图片读取",
			"返回供应商列表",
		];
		const action = await ctx.ui.select(`模型管理：${entry.name}（启用 ${enabledCount} / 共 ${entry.models.length} 个）`, items);
		if (!action || action === "返回供应商列表") return;
		if (action === "启用模型") await toggleModelsFlow(ctx, entry);
		else if (action === "刷新启用模型思考") await refreshThinkingLevels(ctx, entry);
		else if (action === "刷新模型") await refreshCommonModels(ctx, entry);
		else if (action === "新增模型") await addModelsFlow(ctx, entry);
		else if (action === "删除模型") await removeModelFlow(ctx, entry);
		else if (action === "套餐类型") await editPlanModeFlow(ctx, entry);
		else if (action === "修改上下文窗口") await editModelContextFlow(ctx, entry);
		else if (action === "是否支持图片读取") await editModelInputFlow(ctx, entry);
	}
}

async function modelProviderCommand(_args: string, ctx: any): Promise<void> {
	await loadStore();
	while (true) {
		const action = await ctx.ui.select("模型提供", [
			"管理模型",
			"添加供应商",
			"编辑供应商",
			"删除供应商",
			"查看全部供应商",
			"返回",
		]);
		if (!action || action === "返回") return;
		if (action === "管理模型") await modelsMenu(ctx);
		else if (action === "添加供应商") await addCommonFlow(ctx);
		else if (action === "编辑供应商") await editCommonFlow(ctx);
		else if (action === "删除供应商") await removeCommonFlow(ctx);
		else if (action === "查看全部供应商") ctx.ui.notify(listProvidersText(), "info");
	}
}

// =============================================================================
// 扩展注册
// =============================================================================

export default async function (pi: ExtensionAPI) {
	api = pi;
	await loadStore();
	registerAllProviders(pi);

	pi.registerCommand("model-provider", {
		description: "统一管理模型供应商：内置供应商与通用供应商、模型管理",
		handler: modelProviderCommand,
	});
}
