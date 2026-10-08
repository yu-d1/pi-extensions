/**
 * model-provider — 模型提供扩展（统一管理 pi 模型供应商）
 * =============================================================================
 * 在原 minimax-local 基础上扩展：
 *   1. 内置 MiniMax Local：完整适配 MiniMax 官方参数（service_tier / thinking /
 *      reasoning_split / temperature / top_p / max_completion_tokens），逻辑整体保留。
 *   2. 通用（common）供应商：通过 /model-provider 命令添加，仅使用 pi 官方的
 *      OpenAI Completions 格式、OpenAI Responses 格式、Claude 格式；地址只保存 API 前缀，模型列表
 *      通过 {baseUrl}/models 获取，也可手动添加模型 id。
 *      认证统一走 /login <名称> 存入 auth.json。
 *   3. 配置统一持久化到 ~/.pi/agent/extensions/model-provider/config.json（schemaVersion:2），
 *      首次加载时自动迁移旧的 minimax-local/config.json。
 *   4. MiniMax 专属协议实现、流式逻辑与参数配置菜单拆分在 minimax.ts；
 *      内置 MiniMax 作为固定供应商出现在“管理模型”列表中，参数经“配置管理”进入。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, Spacer, Text, fuzzyFilter } from "@earendil-works/pi-tui";
import {
	DEFAULT_MINIMAX,
	MINIMAX_BASE_URL,
	MINIMAX_PROVIDER_ID,
	MINIMAX_PROVIDER_LABEL,
	asMiniMaxConfig,
	cloneMiniMaxDefaultModels,
	minimaxMenu,
	setMiniMaxHost,
	streamMiniMaxChat,
	type MiniMaxConfig,
} from "./minimax";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
	/** 勾选启用：true/undefined = 启用并显示在 /model；false = 不显示（配置保留）。 */
	enabled?: boolean;
}

interface BuiltinEntry {
	kind: "builtin";
	name: "minimax_local";
	label: "MiniMax Local";
	minimax: MiniMaxConfig;
	/** 内置模型列表（可在“管理模型”中勾选启用/修改）。 */
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
const LEGACY_MINIMAX_FILE = join(homedir(), ".pi", "agent", "extensions", "minimax-local", "config.json");

function createDefaultStore(): Store {
	return {
		schemaVersion: 2,
		providers: [
			{
				kind: "builtin",
				name: "minimax_local",
				label: "MiniMax Local",
				minimax: { ...DEFAULT_MINIMAX },
				models: cloneMiniMaxDefaultModels(),
			},
		],
	};
}

let store: Store = createDefaultStore();
let api: ExtensionAPI | null = null;

// minimax.ts 通过宿主回调读写 store，保持 index → minimax 的单向依赖。
setMiniMaxHost({
	getBuiltin: () => getBuiltinEntry(),
	save: () => saveStore(),
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
			...(typeof m.enabled === "boolean" ? { enabled: m.enabled } : {}),
		}));
}

function normalizeStore(raw: any): Store {
	const providers: ProviderEntry[] = [];
	// 内置 minimax 始终存在
	const builtinRaw = Array.isArray(raw?.providers) ? raw.providers.find((p: any) => p?.kind === "builtin") : undefined;
	const builtinModels = normalizeStoredModels(builtinRaw?.models);
	providers.push({
		kind: "builtin",
		name: "minimax_local",
		label: "MiniMax Local",
		minimax: asMiniMaxConfig(builtinRaw?.minimax),
		// 旧配置没有 models 字段时回落到内置默认模型（M3 / M2.7-HighSpeed）。
		models: builtinModels.length > 0 ? sortModels(builtinModels) : cloneMiniMaxDefaultModels(),
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

/** 将旧 minimax-local/config.json 迁移进新 store（一次性） */
async function migrateLegacyMinimax(): Promise<void> {
	try {
		const raw = await readFile(LEGACY_MINIMAX_FILE, "utf8");
		const parsed = JSON.parse(raw);
		const builtin = store.providers.find((p): p is BuiltinEntry => p.kind === "builtin");
		if (builtin) builtin.minimax = asMiniMaxConfig(parsed);
		await unlink(LEGACY_MINIMAX_FILE).catch(() => {});
	} catch {
		// 无旧文件或读取失败，忽略
	}
}

async function loadStore(): Promise<void> {
	try {
		const raw = await readFile(STORE_FILE, "utf8");
		store = normalizeStore(JSON.parse(raw));
	} catch {
		store = createDefaultStore();
		await migrateLegacyMinimax();
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

function getBuiltinEntry(): BuiltinEntry | undefined {
	return store.providers.find((p): p is BuiltinEntry => p.kind === "builtin");
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

/** 保存新增或编辑的供应商前，确认 API 前缀和 /models 接口可访问。 */
async function checkProviderConnectivity(apiType: string, baseUrl: string, apiKey?: string): Promise<ConnectivityResult> {
	const base = baseUrl.trim().replace(/\/+$/, "");
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
			return {
				ok: false,
				reason: "http",
				message: `请求 /models 失败（HTTP ${res.status}）。请检查 API 前缀和请求格式。`,
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
		const message = error instanceof Error ? error.message : String(error);
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
function inferModelThinking(raw: any): { reasoning: boolean; thinkingLevelMap?: Record<string, string> } {
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
	return { reasoning: true, thinkingLevelMap: { ...FULL_THINKING_LEVEL_MAP } };
}

function extractModels(data: any, api: string): StoredModel[] {
	let arr = data?.data ?? data?.models ?? data?.ids ?? data?.list ?? data?.items;
	if (!Array.isArray(arr)) arr = [];
	const out: StoredModel[] = [];
	for (const m of arr) {
		if (m === undefined || m === null) continue;
		if (typeof m === "string") {
			const thinking = inferModelThinking({ id: m });
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
		const thinking = inferModelThinking({ ...m, id });
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

function extractCredentialKey(c: any): string | undefined {
	if (!c) return undefined;
	if (typeof c === "string") return c;
	if (typeof c === "object") {
		for (const k of ["apiKey", "access", "key", "token", "value", "api_key"]) {
			if (typeof c?.[k] === "string" && c[k]) return c[k];
		}
	}
	return undefined;
}

/**
 * common 供应商只保存 API 前缀，例如 https://api.openai.com/v1。
 * 三种格式的模型目录都按前缀拼接 /models；对话请求仍完全由 pi 官方 api 实现。
 */
async function fetchModelsByApi(api: string, baseUrl: string, apiKey?: string): Promise<StoredModel[]> {
	const base = baseUrl.trim().replace(/\/+$/, "");
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
// 通用注册：内置 minimax + common 供应商
// =============================================================================

function normalizeModel(m: StoredModel): any {
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
		},
	};
	if (m.thinkingLevelMap) base.thinkingLevelMap = m.thinkingLevelMap;
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
	// 已存在的模型保留用户的勾选与配置。
	const merged = fetched.map((f) => {
		const old = existing.find((e) => e.id === f.id);
		return old ? { ...f, ...old } : { ...f, enabled: false };
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
		baseUrl: entry.baseUrl,
		api: entry.api,
		// 只注册勾选启用的模型；未勾选的保留在配置中但不显示在 /model。
		models: entry.models.filter(isModelEnabled).map(normalizeModel),
		// 仅允许登录后的有网络刷新访问 /models；注册、注销、删除模型等本地变更
		// 会触发 pi 的无网络同步，此时必须直接保留当前列表。
		// 未勾选启用的模型不暴露给 pi，因此不会出现在 /model 选择器中。
		refreshModels: async (context: any) => {
			if (context?.allowNetwork !== true || context?.signal?.aborted) {
				return entry.models.filter(isModelEnabled).map(normalizeModel);
			}
			const key = extractCredentialKey(context?.credential);
			const fetched = await fetchModelsByApi(entry.api, entry.baseUrl, key);
			const merged = mergeModels(entry.models, fetched);
			entry.models = merged;
			await saveStore();
			return merged.filter(isModelEnabled).map(normalizeModel);
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

/** 模型等本地变更后重新注册：builtin 走 MiniMax 注册，common 走通用注册。 */
function reRegisterEntry(entry: ProviderEntry): void {
	if (!api) return;
	if (entry.kind === "builtin") registerBuiltin(api);
	else unregisterAndReRegister(api, entry.name, entry);
}

/** 注册内置 MiniMax 供应商：模型列表来自 store（可在“管理模型”中勾选启用）。 */
function registerBuiltin(pi: ExtensionAPI): void {
	const builtin = getBuiltinEntry();
	const models = (builtin?.models?.length ? builtin.models : cloneMiniMaxDefaultModels())
		.filter(isModelEnabled)
		.map(normalizeModel);
	pi.unregisterProvider(MINIMAX_PROVIDER_ID);
	pi.registerProvider(MINIMAX_PROVIDER_ID, {
		name: MINIMAX_PROVIDER_LABEL,
		baseUrl: MINIMAX_BASE_URL,
		apiKey: "$MINIMAX_API_KEY",
		authHeader: true,
		api: "minimax-chat",
		models,
		streamSimple: streamMiniMaxChat,
	});
}

function registerAllProviders(pi: ExtensionAPI): void {
	registerBuiltin(pi);
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
			const cfg = p.minimax;
			const enabledCount = p.models.filter(isModelEnabled).length;
			lines.push(`● ${p.name}（内置 MiniMax，固定供应商）`);
			lines.push(`   地址：${MINIMAX_BASE_URL}`);
			lines.push(`   模型：启用 ${enabledCount} / 共 ${p.models.length} 个（未勾选的不显示在 /model 中）`);
			lines.push(`   服务层级：${cfg.serviceTier}  思考拆分：${cfg.reasoningSplit}`);
			lines.push(`   参数配置：/model-provider → 管理模型 → ${p.name} → 配置管理`);
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
	if (cleanName === MINIMAX_PROVIDER_ID || getCommonEntries().some((p) => p.name === cleanName)) {
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
 * 选择供应商。includeBuiltin = true 时，内置 MiniMax 固定显示在最后（仅“管理模型”入口使用）。
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
			return `${p.name}  [内置 MiniMax]  ${MINIMAX_BASE_URL}  （启用 ${enabledCount}/${p.models.length} 个模型）`;
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
	if (existingSameName || newName === MINIMAX_PROVIDER_ID) {
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
			key = await (ctx.modelRegistry as any)?.getApiKeyForProvider(entry.name);
		} catch {
			key = undefined;
		}
		// 内置 MiniMax 的模型目录固定走官方 /v1（OpenAI 兼容 /models）。
		const apiType = entry.kind === "builtin" ? "openai-completions" : entry.api;
		const baseUrl = entry.kind === "builtin" ? MINIMAX_BASE_URL : entry.baseUrl;
		const list = await fetchModelsByApi(apiType, baseUrl, key);
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
		ctx.ui.notify(`刷新失败：${e instanceof Error ? e.message : String(e)}\n可在“新增模型”中手动添加。`, "error");
	} finally {
		ctx.ui.setStatus("model-provider", undefined);
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
	for (const id of list) {
		const old = entry.models.find((model) => model.id === id);
		if (old) {
			old.input = input;
		} else {
			// 服务端未声明能力时自动补全全部思考等级（含 xhigh/max），使 /settings 可配置全部档位。
			const thinking = inferModelThinking({ id });
			entry.models.push({
				id,
				...(thinking.reasoning ? { reasoning: true, thinkingLevelMap: thinking.thinkingLevelMap } : {}),
				input,
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				// 新增即勾选启用，省去再去「启用模型」里手动找一遍
				enabled: true,
			});
			added++;
		}
	}
	entry.models = sortModels(entry.models);
	reRegisterEntry(entry);
	await saveStore();
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
				this.saveNote = `保存失败：${e instanceof Error ? e.message : String(e)}`;
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
		// 内置 MiniMax 作为固定供应商始终出现在列表首位，可统一管理模型与参数。
		const entry = await selectProvider(ctx, "管理模型：选择供应商", true);
		if (!entry) return;
		await modelOpsMenu(ctx, entry);
	}
}

async function modelOpsMenu(ctx: any, entry: ProviderEntry): Promise<void> {
	while (true) {
		const enabledCount = entry.models.filter(isModelEnabled).length;
		const items = [
			// 内置 MiniMax 独有：参数配置菜单（思考模式/服务层级/温度等）。
			...(entry.kind === "builtin" ? ["配置管理"] : []),
			"启用模型",
			"刷新模型",
			"新增模型",
			"删除模型",
			"修改上下文窗口",
			"是否支持图片读取",
			"返回供应商列表",
		];
		const action = await ctx.ui.select(`模型管理：${entry.name}（启用 ${enabledCount} / 共 ${entry.models.length} 个）`, items);
		if (!action || action === "返回供应商列表") return;
		if (action === "配置管理") await minimaxMenu(ctx);
		else if (action === "启用模型") await toggleModelsFlow(ctx, entry);
		else if (action === "刷新模型") await refreshCommonModels(ctx, entry);
		else if (action === "新增模型") await addModelsFlow(ctx, entry);
		else if (action === "删除模型") await removeModelFlow(ctx, entry);
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
		description: "统一管理模型供应商：内置 MiniMax 与通用供应商、模型管理，MiniMax 参数经“配置管理”进入",
		handler: modelProviderCommand,
	});
}
