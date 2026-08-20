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
				models: Array.isArray(p.models) ? p.models.filter((m: any) => typeof m?.id === "string").map((m: any) => ({ id: m.id, ...(m.name ? { name: m.name } : {}), ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}), input: normalizeInput(m.input), ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}), ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}), ...(m.cost ? { cost: m.cost } : {}), ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}) })) : [],
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

type ModelInput = ("text" | "image")[];

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
			out.push({ id: m, input: ["text", "image"] });
			continue;
		}
		const rawId = m?.id ?? m?.name ?? m?.model ?? m?.key ?? (typeof m === "object" ? Object.keys(m)[0] : undefined);
		if (typeof rawId !== "string" || !rawId.trim()) continue;
		let id = rawId.trim();
		if (api.startsWith("google-")) id = id.replace(/^models\//, "");
		const display = m?.display_name ?? m?.displayName ?? id;
		out.push({ id, name: typeof display === "string" ? display : id, input: inferModelInput(m) });
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
		contextWindow: m.contextWindow ?? 128000,
		maxTokens: m.maxTokens ?? 16384,
		cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	if (m.thinkingLevelMap) base.thinkingLevelMap = m.thinkingLevelMap;
	return base;
}

function mergeModels(existing: StoredModel[], fetched: StoredModel[]): StoredModel[] {
	const merged = fetched.map((f) => ({
		...f,
		...existing.find((e) => e.id === f.id),
	}));
	for (const e of existing) {
		if (!fetched.some((f) => f.id === e.id)) {
			merged.push(e);
		}
	}
	return merged;
}

function registerCommon(pi: ExtensionAPI, entry: CommonEntry): void {
	const cfg: any = {
		name: entry.name,
		baseUrl: entry.baseUrl,
		api: entry.api,
		models: entry.models.map(normalizeModel),
	};
	// 不注册 pi 的自动刷新回调；只有“模型管理→刷新模型”才访问 /models。
	// 删除模型后，后台状态刷新不会再次把它拉回来。
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
			lines.push(`● ${p.name}`);
			lines.push(`   请求格式：${apiOption.label}（${p.api}）`);
			lines.push(`   请求地址前缀：${p.baseUrl}`);
			lines.push(`   模型：${p.models.length ? p.models.map((m) => m.id).join(", ") : "（空，请用模型管理添加）"}`);
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

	const baseUrl = (await ctx.ui.input(`请求地址前缀（示例：${selected.example}）`, selected.example))?.trim().replace(/\/+$/, "");
	if (!baseUrl) {
		ctx.ui.notify("请求地址前缀不能为空。示例只填写到 /v1，不要填写 /models、/messages 或 /chat/completions。", "error");
		return;
	}
	if (/\/(models|messages|responses|chat\/completions)$/i.test(baseUrl)) {
		ctx.ui.notify("这里只填写 API 前缀，例如 https://api.openai.com/v1，不要填写具体接口路径。", "error");
		return;
	}

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
		return `${p.name}  [${apiOption.label}]  ${p.baseUrl}  （${p.models.length} 个模型）`;
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

	const newBase = (await ctx.ui.input(`请求地址前缀（当前：${entry.baseUrl}）`, entry.baseUrl))?.trim().replace(/\/+$/, "") || entry.baseUrl;
	if (/\/(models|messages|responses|chat\/completions)$/i.test(newBase)) {
		ctx.ui.notify("这里只填写 API 前缀，不要填写具体接口路径。", "error");
		return;
	}
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
		entry.models = mergeModels(entry.models, list);
		if (api) unregisterAndReRegister(api, entry.name, entry);
		await saveStore();
		ctx.ui.notify(`已刷新 ${entry.name}，共 ${entry.models.length} 个模型。`, "info");
	} catch (e) {
		ctx.ui.notify(`刷新失败：${e instanceof Error ? e.message : String(e)}\n可直接手动添加模型 id。`, "error");
	} finally {
		ctx.ui.setStatus("model-provider", undefined);
	}
}

async function addModelsFlow(ctx: any, entry: CommonEntry): Promise<void> {
	const ids = (await ctx.ui.input("添加模型 id（多个用逗号分隔）", "例如：gpt-4o, claude-sonnet-4-20250514"))?.trim();
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
			entry.models.push({ id, input });
			added++;
		}
	}
	if (api) unregisterAndReRegister(api, entry.name, entry);
	await saveStore();
	ctx.ui.notify(`已处理 ${list.length} 个模型，新增 ${added} 个；输入能力：${inputModeText(input)}。`, "info");
}

async function editModelInputFlow(ctx: any, entry: CommonEntry): Promise<void> {
	if (entry.models.length === 0) {
		ctx.ui.notify("暂无模型，请先刷新或手动添加。", "info");
		return;
	}
	const options = entry.models.map((model) => `${model.id}  [${inputModeText(model.input)}]`);
	options.push("取消");
	const choice = await ctx.ui.select("选择要修改输入能力的模型", options);
	if (!choice || choice === "取消") return;
	const id = choice.split(/\s+\[/)[0];
	const model = entry.models.find((item) => item.id === id);
	if (!model) return;
	const inputChoice = await ctx.ui.select(`模型 ${id} 的输入能力`, ["文本 + 图片", "仅文本", "取消"]);
	if (!inputChoice || inputChoice === "取消") return;
	model.input = inputChoice === "文本 + 图片" ? ["text", "image"] : ["text"];
	if (api) unregisterAndReRegister(api, entry.name, entry);
	await saveStore();
	ctx.ui.notify(`已更新 ${id}：${inputModeText(model.input)}。`, "info");
}

async function deleteModelsFlow(ctx: any, entry: CommonEntry): Promise<void> {
	while (entry.models.length > 0) {
		const options = entry.models.map((model) => `${model.id}  [${inputModeText(model.input)}]`);
		options.push("返回模型管理");
		const choice = await ctx.ui.select(`删除模型：${entry.name}（剩余 ${entry.models.length} 个）`, options);
		if (!choice || choice === "返回模型管理") return;
		const id = choice.split(/\s+\[/)[0];
		if (!(await ctx.ui.confirm("确认删除", `删除模型 ${id}？`))) continue;
		entry.models = entry.models.filter((model) => model.id !== id);
		if (api) unregisterAndReRegister(api, entry.name, entry);
		await saveStore();
		ctx.ui.notify(`已删除模型 ${id}。如需恢复，请手动执行“刷新模型”。`, "info");
	}
	ctx.ui.notify(`${entry.name} 已没有可删除的模型。`, "info");
}

async function modelsMenu(ctx: any): Promise<void> {
	const entry = await selectCommon(ctx, "选择供应商以管理模型");
	if (!entry) return;
	while (true) {
		const action = await ctx.ui.select(`模型管理：${entry.name}（${entry.models.length} 个）`, [
			"刷新模型",
			"添加模型 id",
			"修改图片输入能力",
			"查看模型列表",
			"删除模型",
			"返回",
		]);
		if (!action || action === "返回") return;
		if (action === "刷新模型") await refreshCommonModels(ctx, entry);
		else if (action === "添加模型 id") await addModelsFlow(ctx, entry);
		else if (action === "修改图片输入能力") await editModelInputFlow(ctx, entry);
		else if (action === "查看模型列表") {
			const lines = entry.models.map((model) => `  ${model.id}  [${inputModeText(model.input)}]${model.reasoning ? "  [思考]" : ""}`);
			ctx.ui.notify(lines.length ? `【${entry.name}】\n${lines.join("\n")}` : `${entry.name} 暂无模型。`, "info");
		} else if (action === "删除模型") {
			if (entry.models.length === 0) {
				ctx.ui.notify("暂无模型可删除。", "info");
				continue;
			}
			await deleteModelsFlow(ctx, entry);
		}
	}
}

async function providerMenu(ctx: any): Promise<void> {
	while (true) {
		const commons = getCommonEntries();
		const options = ["添加供应商"];
		if (commons.length > 0) options.push("编辑供应商", "删除供应商", "管理模型");
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
