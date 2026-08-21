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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Container, Input, Key, matchesKey, Spacer, Text, fuzzyFilter } from "@earendil-works/pi-tui";
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

interface StoredModel {
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

type ServiceTier = "standard" | "priority";
type ThinkingType = "adaptive" | "disabled";

interface MiniMaxConfig {
	serviceTier: ServiceTier;
	reasoningSplit: boolean;
	/** "auto" 表示根据模型 + reasoningEffort 自动决定；否则覆盖自动逻辑 */
	thinkingOverride: ThinkingType | "auto";
	/** 采样温度，范围 [0, 2]，默认 1 */
	temperature: number;
	/** 核采样参数，范围 [0, 1]，MiniMax-M3 默认 0.95，M2.x 系列默认 0.9 */
	topP: number;
	/** 生成内容长度上限；null 表示使用 model.maxTokens */
	maxCompletionTokens: number | null;
}

interface BuiltinEntry {
	kind: "builtin";
	name: "minimax_local";
	label: "MiniMax Local";
	minimax: MiniMaxConfig;
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

const DEFAULT_MINIMAX: MiniMaxConfig = {
	serviceTier: "priority",
	reasoningSplit: true,
	thinkingOverride: "auto",
	temperature: 1,
	topP: 0.95,
	maxCompletionTokens: null,
};

function createDefaultStore(): Store {
	return {
		schemaVersion: 2,
		providers: [
			{
				kind: "builtin",
				name: "minimax_local",
				label: "MiniMax Local",
				minimax: { ...DEFAULT_MINIMAX },
			},
		],
	};
}

let store: Store = createDefaultStore();
let api: ExtensionAPI | null = null;

// =============================================================================
// Store 读写与迁移
// =============================================================================

function asMiniMaxConfig(raw: any): MiniMaxConfig {
	return {
		serviceTier: raw?.serviceTier === "standard" || raw?.serviceTier === "priority" ? raw.serviceTier : DEFAULT_MINIMAX.serviceTier,
		reasoningSplit: typeof raw?.reasoningSplit === "boolean" ? raw.reasoningSplit : DEFAULT_MINIMAX.reasoningSplit,
		thinkingOverride:
			raw?.thinkingOverride === "auto" || raw?.thinkingOverride === "adaptive" || raw?.thinkingOverride === "disabled"
				? raw.thinkingOverride
				: DEFAULT_MINIMAX.thinkingOverride,
		temperature:
			typeof raw?.temperature === "number" && !isNaN(raw.temperature) && raw.temperature >= 0 && raw.temperature <= 2
				? raw.temperature
				: DEFAULT_MINIMAX.temperature,
		topP: typeof raw?.topP === "number" && !isNaN(raw.topP) && raw.topP >= 0 && raw.topP <= 1 ? raw.topP : DEFAULT_MINIMAX.topP,
		maxCompletionTokens:
			raw?.maxCompletionTokens === null
				? null
				: typeof raw?.maxCompletionTokens === "number" && raw.maxCompletionTokens >= 1
					? raw.maxCompletionTokens
					: DEFAULT_MINIMAX.maxCompletionTokens,
	};
}

function normalizeStore(raw: any): Store {
	const providers: ProviderEntry[] = [];
	// 内置 minimax 始终存在
	const builtinRaw = Array.isArray(raw?.providers) ? raw.providers.find((p: any) => p?.kind === "builtin") : undefined;
	providers.push({
		kind: "builtin",
		name: "minimax_local",
		label: "MiniMax Local",
		minimax: asMiniMaxConfig(builtinRaw?.minimax),
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
				models: sortModels(
					Array.isArray(p.models)
						? p.models
								.filter((m: any) => typeof m?.id === "string")
								.map((m: any) => ({
									id: m.id,
									...(m.name ? { name: m.name } : {}),
									...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
									input: normalizeInput(m.input),
									...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
									...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
									...(m.cost ? { cost: m.cost } : {}),
									...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
									...(typeof m.enabled === "boolean" ? { enabled: m.enabled } : {}),
								}))
						: [],
				),
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

function getMiniMax(): MiniMaxConfig {
	const builtin = store.providers.find((p): p is BuiltinEntry => p.kind === "builtin");
	return builtin?.minimax ?? DEFAULT_MINIMAX;
}

function getCommonEntries(): CommonEntry[] {
	return store.providers.filter((p): p is CommonEntry => p.kind === "common");
}

// =============================================================================
// 工具：M2.x 系列识别
// =============================================================================

const isM2Series = (modelId: string) => modelId.startsWith("MiniMax-M2");

/** 计算字符串的终端显示宽度（CJK 汉字=2，其他=1） */
function visualWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		if (/[㐀-鿿　-〿＀-￯]/.test(ch)) {
			w += 2;
		} else {
			w += 1;
		}
	}
	return w;
}

/** 按视觉宽度右侧补齐空格（用于表格对齐） */
function padVisualEnd(s: string, target: number): string {
	const w = visualWidth(s);
	if (w >= target) return s;
	return s + " ".repeat(target - w);
}

/** 模型官方推荐的 top_p 默认值 */
function defaultTopPForModel(modelId: string): number {
	return isM2Series(modelId) ? 0.9 : 0.95;
}

/** 模型 max_completion_tokens 上限 */
function getMaxTokensLimit(modelId: string): number {
	return isM2Series(modelId) ? 204800 : 524288;
}

// =============================================================================
// 消息转换：pi 内部消息 → OpenAI 格式（内置 minimax 用）
// =============================================================================

function convertContent(
	blocks: (TextContent | ImageContent)[],
): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
	const hasImages = blocks.some((b) => b.type === "image");
	if (!hasImages) {
		return blocks
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("");
	}
	const result: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
	for (const block of blocks) {
		if (block.type === "text") {
			result.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			const dataUrl = `data:${block.mimeType};base64,${block.data}`;
			result.push({ type: "image_url", image_url: { url: dataUrl } });
		}
	}
	if (!result.some((b) => b.type === "text")) {
		result.unshift({ type: "text", text: "(see attached image)" });
	}
	return result;
}

/**
 * 后处理：剥离孤立的 assistant(tool_calls)
 * MiniMax 协议要求 assistant(tool_calls) 之后必须紧跟 tool 消息；
 * 中断场景下 assistant 发了 tool_calls 但 tool_result 没回来，必须清空，否则报 2013。
 */
function sanitizeOrphanToolCalls(messages: any[]): any[] {
	const fulfilled = new Set<string>();
	for (const m of messages) {
		if (m.role === "tool" && m.tool_call_id) {
			fulfilled.add(m.tool_call_id);
		}
	}
	const out: any[] = [];
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
			out.push(m);
			continue;
		}
		const valid = m.tool_calls.filter((tc: any) => fulfilled.has(tc.id));
		if (valid.length === m.tool_calls.length) {
			out.push(m);
			continue;
		}
		if (valid.length === 0) {
			const { tool_calls, ...rest } = m;
			if (typeof rest.content === "string" ? rest.content.trim() : rest.content) {
				out.push(rest);
			}
		} else {
			out.push({ ...m, tool_calls: valid });
		}
	}
	return out;
}

function convertMessages(messages: Message[]): any[] {
	const result: any[] = [];
	let pendingToolCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim()) {
					result.push({ role: "user", content: msg.content });
				}
			} else {
				const content = convertContent(msg.content as (TextContent | ImageContent)[]);
				if (Array.isArray(content) ? content.length > 0 : content.trim()) {
					result.push({ role: "user", content });
				}
			}
		} else if (msg.role === "assistant") {
			const blocks: any[] = [];
			let text = "";
			const toolCalls: any[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					text += block.text;
				} else if (block.type === "thinking") {
					if (!text.startsWith(" thinking")) {
						text = ` thinking\n${(block as ThinkingContent).thinking}\n response\n\n${text}`;
					}
				} else if (block.type === "toolCall") {
					toolCalls.push({
						id: block.id,
						type: "function",
						function: {
							name: block.name,
							arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments),
						},
					});
				}
			}
			const assistantMsg: any = { role: "assistant" };
			if (text) assistantMsg.content = text;
			else assistantMsg.content = "";
			if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
			result.push(assistantMsg);
			for (const tc of toolCalls) pendingToolCallIds.add(tc.id);
		} else if (msg.role === "toolResult") {
			if (!msg.toolCallId || !pendingToolCallIds.has(msg.toolCallId)) {
				continue;
			}
			result.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content:
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((b): b is TextContent => b.type === "text")
								.map((b) => b.text)
								.join(""),
			});
			pendingToolCallIds.delete(msg.toolCallId);
		}
	}
	return sanitizeOrphanToolCalls(result);
}

function convertTools(tools: Tool[]): any[] {
	return tools.map((t) => ({
		type: "function",
		function: {
			name: t.name,
			description: t.description,
			parameters: (t.parameters as any) ?? { type: "object", properties: {} },
		},
	}));
}

// =============================================================================
// thinking.type 决定逻辑（内置 minimax 用）
// =============================================================================

function resolveThinkingType(model: Model<Api>, options?: SimpleStreamOptions): ThinkingType | undefined {
	if (!model.reasoning) return undefined;
	const cfg = getMiniMax();
	if (cfg.thinkingOverride !== "auto") {
		if (isM2Series(model.id)) return "adaptive";
		return cfg.thinkingOverride;
	}
	if (isM2Series(model.id)) return "adaptive";
	if (!options?.reasoning || (options.reasoning as string) === "off") {
		return (model.thinkingLevelMap as any)?.off === "disabled" ? "disabled" : "adaptive";
	}
	const mapped = model.thinkingLevelMap?.[options.reasoning];
	if (mapped === "disabled") return "disabled";
	return "adaptive";
}

// =============================================================================
// 响应 → StopReason 映射
// =============================================================================

function mapStopReason(reason: string | null | undefined): StopReason {
	switch (reason) {
		case "stop":
		case "stop_sequence":
			return "stop";
		case "length":
		case "max_tokens":
			return "length";
		case "tool_calls":
		case "tool_use":
			return "toolUse";
		case "content_filter":
			return "error";
		default:
			return "error";
	}
}

// =============================================================================
// 内置 minimax 流式实现
// =============================================================================

function streamMiniMaxChat(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const cfg = getMiniMax();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey ?? "";

			const thinkingType = resolveThinkingType(model, options);
			const body: any = {
				model: model.id,
				messages: convertMessages(context.messages),
				service_tier: cfg.serviceTier,
				reasoning_split: cfg.reasoningSplit,
				stream: true,
				stream_options: { include_usage: true },
				temperature: cfg.temperature,
				top_p: cfg.topP,
				max_completion_tokens: Math.max(
					1,
					Math.min(
						cfg.maxCompletionTokens ?? options?.maxTokens ?? model.maxTokens,
						getMaxTokensLimit(model.id),
					),
				),
			};
			if (thinkingType) {
				body.thinking = { type: thinkingType };
			}
			if (context.systemPrompt) {
				body.messages = [{ role: "system", content: context.systemPrompt }, ...body.messages];
			}
			if (context.tools && context.tools.length > 0) {
				body.tools = convertTools(context.tools);
			}

			const url = `${(model.baseUrl ?? "https://api.minimaxi.com/v1").replace(/\/+$/, "")}/chat/completions`;

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					Accept: "text/event-stream",
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP ${response.status}: ${errorText}`);
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			const blocks = output.content as any[];
			const toolCallBlocksByIndex = new Map<number, any>();

			const ensureTextBlock = (): TextContent => {
				if (blocks.length === 0 || blocks[blocks.length - 1].type !== "text") {
					const block: TextContent = { type: "text", text: "" };
					blocks.push(block);
					stream.push({ type: "text_start", contentIndex: blocks.length - 1, partial: output });
				}
				return blocks[blocks.length - 1] as TextContent;
			};

			const ensureThinkingBlock = (): ThinkingContent => {
				if (blocks.length === 0 || blocks[blocks.length - 1].type !== "thinking") {
					const block: ThinkingContent = { type: "thinking", thinking: "" };
					blocks.push(block);
					stream.push({ type: "thinking_start", contentIndex: blocks.length - 1, partial: output });
				}
				return blocks[blocks.length - 1] as ThinkingContent;
			};

			const ensureToolCallBlock = (index: number, id: string, name: string): any => {
				let block = toolCallBlocksByIndex.get(index);
				if (!block) {
					block = { type: "toolCall", id, name, arguments: {}, partialJson: "" };
					toolCallBlocksByIndex.set(index, block);
					blocks.push(block);
					stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
				}
				return block;
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				const events = buffer.split("\n\n");
				buffer = events.pop() ?? "";

				for (const event of events) {
					const lines = event.split("\n");
					let data = "";
					for (const line of lines) {
						if (line.startsWith("data:")) {
							data += line.slice(5).trim();
						}
					}
					if (!data || data === "[DONE]") continue;

					let chunk: any;
					try {
						chunk = JSON.parse(data);
					} catch {
						continue;
					}

					if (chunk.usage) {
						const u = chunk.usage;
						output.usage.input = u.prompt_tokens ?? 0;
						output.usage.output = u.completion_tokens ?? 0;
						output.usage.cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
						output.usage.cacheWrite = 0;
						output.usage.totalTokens = u.total_tokens ?? 0;
						calculateCost(model, output.usage);
					}

					const choice = chunk.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta ?? {};
					const finishReason = choice.finish_reason;

					if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
						const block = ensureThinkingBlock();
						block.thinking += delta.reasoning_content;
						stream.push({ type: "thinking_delta", contentIndex: blocks.length - 1, delta: delta.reasoning_content, partial: output });
					}

					if (typeof delta.content === "string" && delta.content.length > 0) {
						const block = ensureTextBlock();
						block.text += delta.content;
						stream.push({ type: "text_delta", contentIndex: blocks.length - 1, delta: delta.content, partial: output });
					}

					if (Array.isArray(delta.tool_calls)) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							const id = tc.id ?? "";
							const name = tc.function?.name ?? "";
							const argsDelta = tc.function?.arguments ?? "";

							const block = ensureToolCallBlock(idx, id || getExistingToolCallId(toolCallBlocksByIndex, idx), name);

							if (id) block.id = id;
							if (name) block.name = name;
							if (argsDelta) {
								block.partialJson = (block.partialJson ?? "") + argsDelta;
								try {
									block.arguments = JSON.parse(block.partialJson);
								} catch {
									// 部分 JSON，继续累积
								}
								stream.push({ type: "toolcall_delta", contentIndex: blocks.length - 1, delta: argsDelta, partial: output });
							}
						}
					}

					if (finishReason) {
						output.stopReason = mapStopReason(finishReason);
						for (let i = 0; i < blocks.length; i++) {
							const b = blocks[i];
							if (b.type === "text") {
								stream.push({ type: "text_end", contentIndex: i, content: b.text, partial: output });
							} else if (b.type === "thinking") {
								stream.push({ type: "thinking_end", contentIndex: i, content: b.thinking, partial: output });
							} else if (b.type === "toolCall") {
								try {
									b.arguments = JSON.parse(b.partialJson ?? "{}");
								} catch {
									b.arguments = {};
								}
								delete b.partialJson;
								stream.push({ type: "toolcall_end", contentIndex: i, toolCall: b as ToolCall, partial: output });
							}
						}
					}
				}
			}

			if (output.stopReason === "stop") {
				for (let i = 0; i < blocks.length; i++) {
					const b = blocks[i];
					if (b.type === "text") {
						stream.push({ type: "text_end", contentIndex: i, content: b.text, partial: output });
					} else if (b.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: i, content: b.thinking, partial: output });
					} else if (b.type === "toolCall") {
						try {
							b.arguments = JSON.parse(b.partialJson ?? "{}");
						} catch {
							b.arguments = {};
						}
						delete b.partialJson;
						stream.push({ type: "toolcall_end", contentIndex: i, toolCall: b as ToolCall, partial: output });
					}
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// 辅助：获取已有 toolCall 的 id（用于流式 tool_calls 增量）
function getExistingToolCallId(map: Map<number, any>, index: number): string {
	return map.get(index)?.id ?? "";
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

function extractModels(data: any, api: string): StoredModel[] {
	let arr = data?.data ?? data?.models ?? data?.ids ?? data?.list ?? data?.items;
	if (!Array.isArray(arr)) arr = [];
	const out: StoredModel[] = [];
	for (const m of arr) {
		if (m === undefined || m === null) continue;
		if (typeof m === "string") {
			out.push({ id: m, input: ["text", "image"], enabled: false });
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
		out.push({
			id,
			name: typeof display === "string" ? display : id,
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

function registerAllProviders(pi: ExtensionAPI): void {
	pi.unregisterProvider("minimax_local");
	pi.registerProvider("minimax_local", {
		name: "MiniMax Local",
		baseUrl: "https://api.minimaxi.com/v1",
		apiKey: "$MINIMAX_API_KEY",
		authHeader: true,
		api: "minimax-chat",
		models: [
			{
				id: "MiniMax-M3",
				name: "MiniMax-M3 (priority)",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1000000,
				maxTokens: 131072,
				cost: { input: 2.0, output: 8.0, cacheRead: 0, cacheWrite: 0 },
				thinkingLevelMap: {
					off: "disabled",
					minimal: "adaptive",
					low: "adaptive",
					medium: "adaptive",
					high: "adaptive",
					xhigh: "adaptive",
				},
			},
			{
				id: "MiniMax-M2.7-highspeed",
				name: "MiniMax-M2.7-HighSpeed (priority)",
				reasoning: true,
				input: ["text"],
				contextWindow: 204800,
				maxTokens: 65536,
				cost: { input: 0.5, output: 2.0, cacheRead: 0, cacheWrite: 0 },
				thinkingLevelMap: {
					off: "adaptive",
					minimal: "adaptive",
					low: "adaptive",
					medium: "adaptive",
					high: "adaptive",
					xhigh: "adaptive",
				},
			},
		],
		streamSimple: streamMiniMaxChat,
	});
	for (const entry of getCommonEntries()) {
		registerCommon(pi, entry);
	}
}

// =============================================================================
// 内置 minimax 配置菜单（原 /minimax 迁入 /model-provider minimax）
// =============================================================================

function formatConfig(currentModel?: { id: string } | null): string {
	const cfg = getMiniMax();
	const thinkingText = (() => {
		if (cfg.thinkingOverride === "auto") {
			const m2 = currentModel ? isM2Series(currentModel.id) : false;
			return m2 ? "auto（M2.x 系列始终为开启思考）" : "auto（根据思考级别自动决定）";
		}
		if (cfg.thinkingOverride === "adaptive") return "adaptive（强制开启思考）";
		return "disabled（强制关闭思考）";
	})();

	const tierText = cfg.serviceTier === "priority" ? "priority（高优先级）" : "standard（标准排队）";
	const splitText = cfg.reasoningSplit ? "true（拆分到独立字段）" : "false（混合在 content 中）";

	const modelId = currentModel?.id ?? "MiniMax-M3";
	const modelLimit = getMaxTokensLimit(modelId);
	const recommendedTopP = defaultTopPForModel(modelId);
	const maxTokensDisplay =
		cfg.maxCompletionTokens === null ? `自动（模型上限 ${modelLimit}）` : `${cfg.maxCompletionTokens}（上限 ${modelLimit}）`;

	return [
		"━━━━━━ MiniMax 当前配置 ━━━━━━",
		"",
		padVisualEnd("思考模式（thinking）", 27) + thinkingText,
		padVisualEnd("服务层级（service_tier）", 27) + tierText,
		padVisualEnd("思考拆分（reasoning_split）", 27) + splitText,
		padVisualEnd("温度（temperature）", 27) + `${cfg.temperature}（范围 0-2）`,
		padVisualEnd("核采样（top_p）", 27) + `${cfg.topP}（推荐 ${recommendedTopP}，范围 0-1）`,
		padVisualEnd("最大输出（max_tokens）", 27) + maxTokensDisplay,
		"",
	].join("\n");
}

async function minimaxMenu(ctx: any): Promise<void> {
	await loadStore();
	const currentModel = ctx.model ? { id: ctx.model.id } : null;

	const thinkingDesc = (v: string): string => {
		if (v === "auto") return "auto  （根据模型自动决定）";
		if (v === "adaptive") return "adaptive （强制开启）";
		return "disabled （强制关闭）";
	};
	const tierDesc = (v: string): string => {
		if (v === "priority") return "priority （高优先级，1.5×价格）";
		return "standard （标准排队）";
	};

	const cfg = getMiniMax();
	const mainMenu = [
		padVisualEnd("思考模式（thinking）", 27) + `当前：${cfg.thinkingOverride}`,
		padVisualEnd("服务层级（service_tier）", 27) + `当前：${cfg.serviceTier}`,
		padVisualEnd("思考拆分（reasoning_split）", 27) + `当前：${cfg.reasoningSplit ? "拆分到独立字段" : "混合在 content 中"}`,
		padVisualEnd("温度（temperature）", 27) + `当前：${cfg.temperature}（范围 0-2）`,
		padVisualEnd("核采样（top_p）", 27) + `当前：${cfg.topP}（范围 0-1）`,
		padVisualEnd("最大输出（max_tokens）", 27) + `当前：${cfg.maxCompletionTokens ?? "自动（用模型默认）"}`,
		"恢复默认设置",
		"返回上级",
	];

	const action = await ctx.ui.select("MiniMax 配置", mainMenu);
	if (!action || action === "返回上级") return;

	if (action === "恢复默认设置") {
		const builtin = store.providers.find((p): p is BuiltinEntry => p.kind === "builtin");
		if (builtin) builtin.minimax = { ...DEFAULT_MINIMAX };
		await saveStore();
		ctx.ui.notify("已恢复默认设置。\n\n" + formatConfig(currentModel), "info");
		return;
	}

	if (action.startsWith("思考模式（thinking）")) {
		const values = [`auto      （根据模型自动决定）`, `adaptive  （强制开启）`, `disabled  （强制关闭，M3生效）`, "取消"];
		const choice = await ctx.ui.select("选择思考模式（thinking）", values);
		if (!choice || choice === "取消") return;
		const newValue = choice.split(/\s+/)[0];
		getMiniMax().thinkingOverride = newValue as ThinkingType | "auto";
		await saveStore();
		ctx.ui.notify(`思考模式（thinking） = ${thinkingDesc(newValue)}\n\n` + formatConfig(currentModel), "info");
		return;
	}

	if (action.startsWith("服务层级（service_tier）")) {
		const values = [`priority  （高优先级，1.5×价格）`, `standard  （标准排队）`, "取消"];
		const choice = await ctx.ui.select("选择服务层级（service_tier）", values);
		if (!choice || choice === "取消") return;
		const newValue = choice.split(/\s+/)[0];
		getMiniMax().serviceTier = newValue as ServiceTier;
		await saveStore();
		ctx.ui.notify(`服务层级（service_tier） = ${tierDesc(newValue)}\n\n` + formatConfig(currentModel), "info");
		return;
	}

	if (action.startsWith("思考拆分（reasoning_split）")) {
		const values = [`true   （拆分到 reasoning_content 字段）`, `false  （保留在 content 字段中）`, "取消"];
		const choice = await ctx.ui.select("选择思考拆分方式（reasoning_split）", values);
		if (!choice || choice === "取消") return;
		const newValue = choice.split(/\s+/)[0];
		getMiniMax().reasoningSplit = newValue === "true";
		await saveStore();
		ctx.ui.notify(`思考拆分（reasoning_split） = ${getMiniMax().reasoningSplit ? "拆分到 reasoning_content" : "保留在 content 中"}\n\n` + formatConfig(currentModel), "info");
		return;
	}

	if (action.startsWith("温度（temperature）")) {
		const values = [`0.0  （完全确定）`, `0.5  （较确定）`, `0.7  （MiniMax 官方推荐低值）`, `1.0  （默认，平衡）`, `1.3  （MiniMax 官方推荐高值）`, `1.5  （较随机）`, `2.0  （完全随机）`, "取消"];
		const choice = await ctx.ui.select("选择温度（temperature）", values);
		if (!choice || choice === "取消") return;
		const newValue = parseFloat(choice.split(/\s+/)[0]);
		if (!isNaN(newValue) && newValue >= 0 && newValue <= 2) {
			getMiniMax().temperature = newValue;
			await saveStore();
			ctx.ui.notify(`温度（temperature） = ${getMiniMax().temperature}\n\n` + formatConfig(currentModel), "info");
		}
		return;
	}

	if (action.startsWith("核采样（top_p）")) {
		const m2 = currentModel ? isM2Series(currentModel.id) : false;
		const recommended = m2 ? 0.9 : 0.95;
		const values = [`0.5  （聚焦）`, `0.7  （较聚焦）`, `${recommended}  （当前模型官方推荐）`, `1.0  （全概率采样）`, "取消"];
		const choice = await ctx.ui.select("选择核采样（top_p）", values);
		if (!choice || choice === "取消") return;
		const newValue = parseFloat(choice.split(/\s+/)[0]);
		if (!isNaN(newValue) && newValue >= 0 && newValue <= 1) {
			getMiniMax().topP = newValue;
			await saveStore();
			ctx.ui.notify(`核采样（top_p） = ${getMiniMax().topP}\n\n` + formatConfig(currentModel), "info");
		}
		return;
	}

	if (action.startsWith("最大输出（max_tokens）")) {
		const m2 = currentModel ? isM2Series(currentModel.id) : false;
		const modelDefault = m2 ? 65536 : 131072;
		const modelLimit = getMaxTokensLimit(currentModel?.id ?? "MiniMax-M3");
		const values = [`自动   （使用模型默认 ${modelDefault}）`, `${modelDefault}    （MiniMax 官方推荐）`, `${modelLimit}    （模型上限）`, "取消"];
		const choice = await ctx.ui.select("选择最大输出（max_tokens）", values);
		if (!choice || choice === "取消") return;
		if (choice.startsWith("自动")) {
			getMiniMax().maxCompletionTokens = null;
		} else {
			const n = parseInt(choice.split(/\s+/)[0], 10);
			if (!isNaN(n) && n >= 1) {
				getMiniMax().maxCompletionTokens = Math.min(n, modelLimit);
			}
		}
		await saveStore();
		const display = getMiniMax().maxCompletionTokens === null ? `自动（上限 ${modelLimit}）` : `${getMiniMax().maxCompletionTokens}（上限 ${modelLimit}）`;
		ctx.ui.notify(`最大输出（max_tokens） = ${display}\n\n` + formatConfig(currentModel), "info");
		return;
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
			lines.push(`● ${p.name}（内置 MiniMax）`);
			lines.push(`   地址：https://api.minimaxi.com/v1`);
			lines.push(`   模型：MiniMax-M3, MiniMax-M2.7-highspeed（2 个）`);
			lines.push(`   服务层级：${cfg.serviceTier}  思考拆分：${cfg.reasoningSplit}`);
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
	if (cleanName === "minimax_local" || getCommonEntries().some((p) => p.name === cleanName)) {
		ctx.ui.notify(`供应商 "${cleanName}" 已存在或是内置供应商。`, "error");
		return;
	}

	const apiOptions = COMMON_API_OPTIONS.map((option) =>
		`${option.label}（${option.api}）  示例：${option.example}  ——  ${option.description}`,
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
		`已添加供应商：${entry.name}\n请求格式：${selected.label}\n请求地址前缀：${entry.baseUrl}\n\n请先执行 /login ${entry.name} 完成认证，再到“模型管理→刷新拉取”获取模型。\n也可以直接手动添加模型 id。`,
		"info",
	);
}

async function selectCommon(ctx: any, title: string): Promise<CommonEntry | undefined> {
	const commons = getCommonEntries();
	if (commons.length === 0) {
		ctx.ui.notify("暂无 common 供应商，请先“添加供应商”。", "warning");
		return undefined;
	}
	const options = commons.map((p) => {
		const apiOption = getCommonApiOption(p.api);
		const enabledCount = p.models.filter(isModelEnabled).length;
		return `${p.name}  [${apiOption.label}]  ${p.baseUrl}  （启用 ${enabledCount}/${p.models.length} 个模型）`;
	});
	options.push("取消");
	const choice = await ctx.ui.select(title, options);
	if (!choice || choice === "取消") return undefined;
	const picked = choice.split(/\s+\[/)[0];
	return commons.find((p) => p.name === picked);
}

async function editCommonFlow(ctx: any): Promise<void> {
	const entry = await selectCommon(ctx, "选择要编辑的供应商");
	if (!entry) return;
	const oldName = entry.name;

	const newName = (await ctx.ui.input(`供应商名称（当前：${entry.name}）`, entry.name))?.trim() || entry.name;
	const apiOptions = COMMON_API_OPTIONS.map((option) =>
		`${option.label}（${option.api}）  示例：${option.example}  ——  ${option.description}`,
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
	if (existingSameName || newName === "minimax_local") {
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
	const entry = await selectCommon(ctx, "选择要移除的供应商");
	if (!entry) return;
	const ok = await ctx.ui.confirm("确认移除", `确定移除供应商 ${entry.name}？其模型将一并删除。`);
	if (!ok) return;
	store.providers = store.providers.filter((p) => p !== entry);
	if (api) api.unregisterProvider(entry.name);
	await saveStore();
	ctx.ui.notify(`已移除供应商 ${entry.name}。`, "info");
}

async function refreshCommonModels(ctx: any, entry: CommonEntry): Promise<void> {
	ctx.ui.setStatus("model-provider", `正在刷新 ${entry.name} 模型列表...`);
	try {
		let key: string | undefined;
		try {
			key = await (ctx.modelRegistry as any)?.getApiKeyForProvider(entry.name);
		} catch {
			key = undefined;
		}
		const list = await fetchModelsByApi(entry.api, entry.baseUrl, key);
		const knownIds = new Set(entry.models.map((m) => m.id));
		const added = list.filter((m) => !knownIds.has(m.id)).length;
		entry.models = mergeModels(entry.models, list);
		if (api) unregisterAndReRegister(api, entry.name, entry);
		await saveStore();
		const enabledCount = entry.models.filter(isModelEnabled).length;
		let message = `已刷新 ${entry.name}：启用 ${enabledCount} / 共 ${entry.models.length} 个模型。`;
		if (added > 0) {
			message += `\n新增 ${added} 个模型默认未勾选，请到“启用模型”中挑选启用。`;
		}
		ctx.ui.notify(message, "info");
	} catch (e) {
		ctx.ui.notify(`刷新失败：${e instanceof Error ? e.message : String(e)}\n可直接手动添加模型 id。`, "error");
	} finally {
		ctx.ui.setStatus("model-provider", undefined);
	}
}

async function addModelsFlow(ctx: any, entry: CommonEntry): Promise<void> {
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
			// 手动添加的模型同样默认未勾选，需在“启用模型”中挑选。
			entry.models.push({ id, input, contextWindow: DEFAULT_CONTEXT_WINDOW, enabled: false });
			added++;
		}
	}
	entry.models = sortModels(entry.models);
	if (api) unregisterAndReRegister(api, entry.name, entry);
	await saveStore();
	ctx.ui.notify(`已处理 ${list.length} 个模型，新增 ${added} 个（默认未启用）；请到“启用模型”中勾选后使用。`, "info");
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

async function editModelContextFlow(ctx: any, entry: CommonEntry): Promise<void> {
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
	if (api) unregisterAndReRegister(api, entry.name, entry);
	await saveStore();
	ctx.ui.notify(`已更新 ${id}：上下文 ${formatContextWindow(contextWindow)}（${contextWindow.toLocaleString()}）`, "info");
}

/**
 * 批量设置图片读取能力：勾选 = 支持图片输入（文本 + 图片），未勾选 = 仅文本。
 * TUI 模式使用勾选组件，其它模式降级为 select 循环。
 */
async function editModelInputFlow(ctx: any, entry: CommonEntry): Promise<void> {
	if (entry.models.length === 0) {
		ctx.ui.notify("暂无模型，请先刷新或手动添加。", "info");
		return;
	}
	const supportsImage = (model: StoredModel) => (model.input ?? ["text", "image"]).includes("image");
	let result: Set<string> | null | undefined;
	if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
		const ids = await ctx.ui.custom<string[] | null>(
			(_tui: any, theme: any, keybindings: any, done: (value: string[] | null) => void) =>
				new ModelToggleSelectorComponent(
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
				),
		);
		result = ids === null ? null : new Set(ids);
	} else {
		result = await toggleViaSelectFallback(ctx, entry, {
			title: `图片读取：${entry.name}`,
			countLabel: "支持图片",
			isMarked: supportsImage,
		});
	}
	if (result === null || result === undefined) return; // 取消
	for (const model of entry.models) {
		model.input = result.has(model.id) ? ["text", "image"] : ["text"];
	}
	if (api) unregisterAndReRegister(api, entry.name, entry);
	await saveStore();
	ctx.ui.notify(`已更新 ${entry.name}：${result.size} / 共 ${entry.models.length} 个模型支持图片输入。`, "info");
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
	private readonly options: ModelToggleSelectorOptions;
	private readonly keybindings: any;
	private readonly theme: any;
	private readonly done: (result: string[] | null) => void;

	constructor(
		options: ModelToggleSelectorOptions,
		models: StoredModel[],
		initialEnabled: string[],
		keybindings: any,
		theme: any,
		done: (result: string[] | null) => void,
	) {
		super();
		this.options = options;
		this.keybindings = keybindings;
		this.theme = theme;
		this.done = done;
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

	private getFooterText(): string {
		const parts = [
			`${this.keyLabel("tui.select.confirm")} 切换`,
			`${this.keyLabel("app.models.enableAll")} 全选`,
			`${this.keyLabel("app.models.clearAll")} 清空`,
			`${this.keyLabel("app.models.save")} 保存`,
			"esc 取消",
			`${this.options.countLabel} ${this.enabledIds.length}/${this.allIds.length}`,
		];
		const text = `  ${parts.join(" · ")}`;
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
			this.done([...this.enabledIds]);
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
 * 返回被勾选的模型 id 集合；null 表示取消。由调用方决定集合的含义与应用方式。
 */
async function toggleViaSelectFallback(
	ctx: any,
	entry: CommonEntry,
	opts: { title: string; countLabel: string; isMarked: (model: StoredModel) => boolean },
): Promise<Set<string> | null> {
	const marked = new Set(entry.models.filter((m) => opts.isMarked(m)).map((m) => m.id));
	while (true) {
		entry.models = sortModels(entry.models);
		const options = entry.models.map((model) => {
			const mark = marked.has(model.id) ? "[✓]" : "[ ]";
			return `${mark} ${model.id}  [上下文 ${formatContextWindow(model.contextWindow)}]  [${inputModeText(model.input)}]`;
		});
		options.push("保存并返回", "全部勾选", "全部取消", "取消（不保存）");
		const title = `${opts.title}（${opts.countLabel} ${marked.size}/${entry.models.length}，选择条目即切换勾选）`;
		const choice = await ctx.ui.select(title, options);
		if (!choice || choice === "取消（不保存）") return null;
		if (choice === "保存并返回") return marked;
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
 * 其它模式降级为 select 循环。保存后未勾选的模型不再注册到 pi。
 */
async function toggleModelsFlow(ctx: any, entry: CommonEntry): Promise<void> {
	if (entry.models.length === 0) {
		ctx.ui.notify("暂无模型，请先刷新或手动添加。", "info");
		return;
	}
	entry.models = sortModels(entry.models);
	let result: Set<string> | null | undefined;
	if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
		const ids = await ctx.ui.custom<string[] | null>(
			(_tui: any, theme: any, keybindings: any, done: (value: string[] | null) => void) =>
				new ModelToggleSelectorComponent(
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
				),
		);
		result = ids === null ? null : new Set(ids);
	} else {
		result = await toggleViaSelectFallback(ctx, entry, {
			title: `勾选启用的模型：${entry.name}`,
			countLabel: "已启用",
			isMarked: isModelEnabled,
		});
	}
	if (result === null || result === undefined) return; // 取消
	entry.models = sortModels(entry.models.map((m) => ({ ...m, enabled: result!.has(m.id) })));
	if (api) unregisterAndReRegister(api, entry.name, entry);
	await saveStore();
	ctx.ui.notify(
		`已保存 ${entry.name}：启用 ${result!.size} / 共 ${entry.models.length} 个模型；未勾选的模型不再显示在 /model 中。`,
		"info",
	);
}

async function modelsMenu(ctx: any): Promise<void> {
	const entry = await selectCommon(ctx, "选择供应商以管理模型");
	if (!entry) return;
	while (true) {
		const enabledCount = entry.models.filter(isModelEnabled).length;
		const action = await ctx.ui.select(`模型管理：${entry.name}（启用 ${enabledCount} / 共 ${entry.models.length} 个）`, [
			"启用模型",
			"刷新模型",
			"新增模型",
			"修改上下文窗口",
			"是否支持图片读取",
			"返回",
		]);
		if (!action || action === "返回") return;
		if (action === "启用模型") await toggleModelsFlow(ctx, entry);
		else if (action === "刷新模型") await refreshCommonModels(ctx, entry);
		else if (action === "新增模型") await addModelsFlow(ctx, entry);
		else if (action === "修改上下文窗口") await editModelContextFlow(ctx, entry);
		else if (action === "是否支持图片读取") await editModelInputFlow(ctx, entry);
	}
}

async function providerMenu(ctx: any): Promise<void> {
	while (true) {
		const commons = getCommonEntries();
		const options = commons.length > 0 ? ["管理模型", "添加供应商", "编辑供应商", "删除供应商"] : ["添加供应商"];
		options.push("返回");
		const action = await ctx.ui.select("Common 供应商", options);
		if (!action || action === "返回") return;
		if (action === "添加供应商") await addCommonFlow(ctx);
		else if (action === "编辑供应商") await editCommonFlow(ctx);
		else if (action === "删除供应商") await removeCommonFlow(ctx);
		else if (action === "管理模型") await modelsMenu(ctx);
	}
}

async function modelProviderCommand(_args: string, ctx: any): Promise<void> {
	await loadStore();
	while (true) {
		const action = await ctx.ui.select("模型提供", [
			"Common 供应商",
			"MiniMax 内置配置",
			"查看全部供应商",
			"返回",
		]);
		if (!action || action === "返回") return;
		if (action === "Common 供应商") await providerMenu(ctx);
		else if (action === "MiniMax 内置配置") await minimaxMenu(ctx);
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
		description: "统一管理模型供应商：内置 MiniMax 配置 + 添加/编辑/移除 common 供应商、模型管理",
		handler: modelProviderCommand,
	});
	// 兼容别名（旧命令），指向同一处理逻辑
	pi.registerCommand("minimax", {
		description: "进入 MiniMax 内置配置菜单（等价 /model-provider 内的 MiniMax 配置）",
		handler: async (_args, ctx) => {
			await minimaxMenu(ctx);
		},
	});
}
