/**
 * minimax-local — MiniMax 自定义 Provider 扩展（完整适配 MiniMax 官方参数）
 * =============================================================================
 * 让 pi 直接调用 MiniMax API（https://api.minimaxi.com/v1/chat/completions），
 * 无需经过中间层代理，完整支持 MiniMax 官方采样参数：可配置高倍率 priority、
 * 思考、思考拆分、max_completion_tokens、temperature、top_p。
 *
 * v1.1.0 新增：完整适配 MiniMax 官方三项采样参数（可由 /minimax 命令调整）：
 *              - max_completion_tokens（生成内容长度上限，MiniMax-M3 推荐 131072、上限 524288；
 *                其他模型推荐 65536、上限 204800）
 *              - temperature（温度系数，范围 [0, 2]，默认 1）
 *              - top_p（核采样参数，范围 [0, 1]，MiniMax-M3 默认 0.95，M2.x 系列默认 0.9）
 * v1.0.4 修复：中断后孤立的 assistant(tool_calls) 会被剥离（避免 2013 协议错误）
 *                  场景：用户中断了工具调用，assistant 带了 tool_calls 但没有 toolResult 返回，
 *                  原版会带着 tool_calls 发出去 → MiniMax 报 2013。新版后处理剥离孤立 tool_calls。
 * v1.0.3 说明：调整 description / keywords / README，突出"可配置高倍率 + 适配官方参数"卖点。代码逻辑不变。
 * v1.0.2 修复：采用消耗式 pending 跟踪，正确处理跨 user 边界的 tool_result
 * v1.0.1 修复：中断后坬立的 tool 消息会被丢弃（避免 2013 协议错误）
 *
 * 特性：
 * - 完整适配 MiniMax 官方采样参数（pi 原生不支持）：
 *     service_tier（高倍率）、thinking（思考）、reasoning_split（思考拆分）、
 *     max_completion_tokens、temperature、top_p
 * - 可配置高倍率：service_tier 支持 priority（1.5× 价格，跳过排队）和 standard 运行时切换（/minimax 命令）
 * - 注册 MiniMax-M3（文本+图片）和 MiniMax-M2.7-highspeed（纯文本）两个模型
 * - 支持 stream（流式响应）
 * - 支持 tool_calls（工具调用/函数调用）
 * - 支持 thinking（reasoning_content 拆到独立字段）
 * - 支持多模态（图片理解）
 * - 自动计算 token 费用
 *
 * 可通过 /minimax 命令修改六项运行时配置：
 *   思考模式        auto | adaptive | disabled
 *   服务层级        standard | priority
 *   思考拆分        true | false
 *   温度（temperature）     0.0-2.0（默认 1）
 *   核采样（top_p）         0.0-1.0（默认按模型 M3:0.95 / M2:0.9）
 *   最大输出（max_tokens）  自动 | 数字（生成上限，null = 用模型默认）
 *
 * 配置持久化到 ~/.pi/agent/extensions/minimax-local/config.json。
 *
 * 安装：
 *   pi install npm:@liziy/minimax-local
 *
 * 使用：
 *   1. 在 ~/.pi/agent/auth.json 中添加 minimax_local 凭证：
 *      { "minimax_local": "你的 MiniMax API Key" }
 *   2. pi 启动后 /model 选择 minimax_local/MiniMax-M3 即可使用
 *   3. 输入 /minimax 查看或修改运行时参数
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// =============================================================================
// 运行时配置（可由 /minimax 命令修改，持久化到磁盘）
// =============================================================================

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
	/** 生成内容长度上限；null 表示使用 model.maxTokens。MiniMax-M3 推荐 131072、上限 524288；其他模型推荐 65536、上限 204800 */
	maxCompletionTokens: number | null;
}

const DEFAULT_CONFIG: MiniMaxConfig = {
	serviceTier: "priority",
	reasoningSplit: true,
	thinkingOverride: "auto",
	temperature: 1,
	topP: 0.95,
	maxCompletionTokens: null,
};

const CONFIG_FILE = join(homedir(), ".pi", "agent", "extensions", "minimax-local", "config.json");

let config: MiniMaxConfig = { ...DEFAULT_CONFIG };

/** 从磁盘加载配置；文件不存在或解析失败时使用默认值 */
async function loadConfig(): Promise<void> {
	try {
		const raw = await readFile(CONFIG_FILE, "utf8");
		const parsed = JSON.parse(raw);
		config = {
			serviceTier:
				parsed.serviceTier === "standard" || parsed.serviceTier === "priority"
					? parsed.serviceTier
					: DEFAULT_CONFIG.serviceTier,
			reasoningSplit: typeof parsed.reasoningSplit === "boolean" ? parsed.reasoningSplit : DEFAULT_CONFIG.reasoningSplit,
			thinkingOverride:
				parsed.thinkingOverride === "auto" ||
				parsed.thinkingOverride === "adaptive" ||
				parsed.thinkingOverride === "disabled"
					? parsed.thinkingOverride
					: DEFAULT_CONFIG.thinkingOverride,
			// 新增：temperature 范围 [0, 2]
			temperature:
				typeof parsed.temperature === "number" && !isNaN(parsed.temperature) && parsed.temperature >= 0 && parsed.temperature <= 2
					? parsed.temperature
					: DEFAULT_CONFIG.temperature,
			// 新增：top_p 范围 [0, 1]
			topP: typeof parsed.topP === "number" && !isNaN(parsed.topP) && parsed.topP >= 0 && parsed.topP <= 1 ? parsed.topP : DEFAULT_CONFIG.topP,
			// 新增：maxCompletionTokens >= 1 或 null
			maxCompletionTokens:
				parsed.maxCompletionTokens === null
					? null
					: typeof parsed.maxCompletionTokens === "number" && parsed.maxCompletionTokens >= 1
						? parsed.maxCompletionTokens
						: DEFAULT_CONFIG.maxCompletionTokens,
		};
	} catch {
		// 文件不存在或解析失败，保留默认值
		config = { ...DEFAULT_CONFIG };
	}
}

/** 将当前配置写入磁盘 */
async function saveConfig(): Promise<void> {
	try {
		await mkdir(dirname(CONFIG_FILE), { recursive: true });
		await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
	} catch {
		// 静默忽略保存错误，不影响命令反馈
	}
}

// =============================================================================
// 工具：M2.x 系列识别
// =============================================================================

const isM2Series = (modelId: string) => modelId.startsWith("MiniMax-M2");

/** 计算字符串的终端显示宽度（CJK 汉字=2，其他=1） */
function visualWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		// CJK 表意文字、全角标点、半角假名等统一按 2 宽
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
// 消息转换：pi 内部消息 → OpenAI 格式
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
			// pi 的 ImageContent 字段是 { data: base64, mimeType }
			// 转为 data URL
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
 * 中断场景下 assistant 发了 tool_calls 但 tool_result 没回来，
 * 这种"孤立 tool_call"必须清空，否则 MiniMax 报 2013。
 */
function sanitizeOrphanToolCalls(messages: any[]): any[] {
  // 1. 收集所有已履行的 tool_call_id（出现在 tool 消息中的）
  const fulfilled = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      fulfilled.add(m.tool_call_id);
    }
  }
  // 2. 清理 assistant 消息的孤立 tool_calls
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
      // 全部孤立：剥离 tool_calls；如果连 text 都没有就整条丢
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
	// 消耗式跟踪：assistant(tool_calls) 中的 id 加入集合
	// 遇到对应的 toolResult 才从集合中移除（表示已响应）
	// user 消息不再重置集合——允许 toolResult 跨越 user 边界（中断场景）
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
			// 回放 assistant 消息：保留 text 和 tool_calls
			const blocks: any[] = [];
			let text = "";
			const toolCalls: any[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					text += block.text;
				} else if (block.type === "thinking") {
					// thinking 内容不需要回放（M3 用 reasoning_split 已在服务端隔离）
					// 但若不开启则需保留为内联 <think> 块
					if (!text.startsWith("<think>")) {
						text = `<think>\n${(block as ThinkingContent).thinking}\n</think>\n\n${text}`;
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
			// 将本轮所有 tool_call_id 加入 pending
			for (const tc of toolCalls) pendingToolCallIds.add(tc.id);
		} else if (msg.role === "toolResult") {
			// 协议守卫：tool 消息必须有对应 pending 的 tool_call_id
			if (!msg.toolCallId || !pendingToolCallIds.has(msg.toolCallId)) {
				// 孤立 tool（无对应调用 / id 不匹配 / 重复） → 丢弃
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
			// 消耗：从 pending 中移除（防止重复的 tool 消息）
			pendingToolCallIds.delete(msg.toolCallId);
		}
	}
	// v1.0.4 修复：剥离孤立的 tool_calls（中断场景下 assistant 调了工具但 tool_result 没回来）
	// 不清空会导致 MiniMax 报 2013 "tool call result does not follow tool call"
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
// thinking.type 决定逻辑
// =============================================================================

function resolveThinkingType(model: Model<Api>, options?: SimpleStreamOptions): ThinkingType | undefined {
	if (!model.reasoning) return undefined;

	// 1. 用户在 /minimax 命令中手动覆盖
	if (config.thinkingOverride !== "auto") {
		// M2.x 系列 thinking 始终开启，无法关闭
		if (isM2Series(model.id)) return "adaptive";
		return config.thinkingOverride;
	}

	// 2. 自动模式：M2.x 系列始终 adaptive
	if (isM2Series(model.id)) return "adaptive";

	// 3. 自动模式 M3：根据 pi 的 reasoningEffort 决定
	if (!options?.reasoning || options.reasoning === "off") {
		return model.thinkingLevelMap?.off === "disabled" ? "disabled" : "adaptive";
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
// 流式实现
// =============================================================================

function streamMiniMaxChat(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
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

			// 构造请求体
			const thinkingType = resolveThinkingType(model, options);
			const body: any = {
				model: model.id,
				messages: convertMessages(context.messages),
				service_tier: config.serviceTier,
				reasoning_split: config.reasoningSplit,
				stream: true,
				stream_options: { include_usage: true },
				// 采样参数：始终以 config 为准（用户通过 /minimax 调整）
				temperature: config.temperature,
				top_p: config.topP,
				// max_completion_tokens：优先级 config > options > model.maxTokens，并限制在模型上限内
				max_completion_tokens: Math.max(
					1,
					Math.min(
						config.maxCompletionTokens ?? options?.maxTokens ?? model.maxTokens,
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

			// 解析 SSE 流
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			// 块索引追踪
			const blocks = output.content as any[];
			const toolCallBlocksByIndex = new Map<number, any>();

			const ensureTextBlock = (): TextContent => {
				if (blocks.length === 0 || blocks[blocks.length - 1].type !== "text") {
					const block: TextContent = { type: "text", text: "" };
					blocks.push(block);
					stream.push({
						type: "text_start",
						contentIndex: blocks.length - 1,
						partial: output,
					});
				}
				return blocks[blocks.length - 1] as TextContent;
			};

			const ensureThinkingBlock = (): ThinkingContent => {
				if (blocks.length === 0 || blocks[blocks.length - 1].type !== "thinking") {
					const block: ThinkingContent = { type: "thinking", thinking: "" };
					blocks.push(block);
					stream.push({
						type: "thinking_start",
						contentIndex: blocks.length - 1,
						partial: output,
					});
				}
				return blocks[blocks.length - 1] as ThinkingContent;
			};

			const ensureToolCallBlock = (index: number, id: string, name: string): any => {
				let block = toolCallBlocksByIndex.get(index);
				if (!block) {
					block = {
						type: "toolCall",
						id,
						name,
						arguments: {},
						partialJson: "",
					};
					toolCallBlocksByIndex.set(index, block);
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: blocks.length - 1,
						partial: output,
					});
				}
				return block;
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// 按 \n\n 切分事件
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

					// usage 统计（仅在最后一个 chunk 返回）
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

					// 1. thinking（reasoning_content）
					if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
						const block = ensureThinkingBlock();
						block.thinking += delta.reasoning_content;
						stream.push({
							type: "thinking_delta",
							contentIndex: blocks.length - 1,
							delta: delta.reasoning_content,
							partial: output,
						});
					}

					// 2. 文本
					if (typeof delta.content === "string" && delta.content.length > 0) {
						const block = ensureTextBlock();
						block.text += delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: blocks.length - 1,
							delta: delta.content,
							partial: output,
						});
					}

					// 3. 工具调用
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
								stream.push({
									type: "toolcall_delta",
									contentIndex: blocks.length - 1,
									delta: argsDelta,
									partial: output,
								});
							}
						}
					}

					// 4. 结束事件
					if (finishReason) {
						output.stopReason = mapStopReason(finishReason);

						// 关闭未完成的块
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
								stream.push({
									type: "toolcall_end",
									contentIndex: i,
									toolCall: b as ToolCall,
									partial: output,
								});
							}
						}
					}
				}
			}

			// 流正常结束
			if (output.stopReason === "stop") {
				// 关闭未关闭的块
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
						stream.push({
							type: "toolcall_end",
							contentIndex: i,
							toolCall: b as ToolCall,
							partial: output,
						});
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
// 扩展注册
// =============================================================================

// =============================================================================
// /minimax 命令：通过菜单查看或修改运行时配置
// =============================================================================

function formatConfig(currentModel?: { id: string } | null): string {
	const thinkingText = (() => {
		if (config.thinkingOverride === "auto") {
			const m2 = currentModel ? isM2Series(currentModel.id) : false;
			return m2 ? "auto（M2.x 系列始终为开启思考）" : "auto（根据思考级别自动决定）";
		}
		if (config.thinkingOverride === "adaptive") return "adaptive（强制开启思考）";
		return "disabled（强制关闭思考）";
	})();

	const tierText = config.serviceTier === "priority" ? "priority（高优先级）" : "standard（标准排队）";
	const splitText = config.reasoningSplit ? "true（拆分到独立字段）" : "false（混合在 content 中）";

	// 新增 3 项展示
	const modelId = currentModel?.id ?? "MiniMax-M3";
	const modelLimit = getMaxTokensLimit(modelId);
	const recommendedTopP = defaultTopPForModel(modelId);
	const maxTokensDisplay =
		config.maxCompletionTokens === null ? `自动（模型上限 ${modelLimit}）` : `${config.maxCompletionTokens}（上限 ${modelLimit}）`;

	return [
		"━━━━━━ MiniMax 当前配置 ━━━━━━",
		"",
		padVisualEnd("思考模式（thinking）", 27) + thinkingText,
		padVisualEnd("服务层级（service_tier）", 27) + tierText,
		padVisualEnd("思考拆分（reasoning_split）", 27) + splitText,
		padVisualEnd("温度（temperature）", 27) + `${config.temperature}（范围 0-2）`,
		padVisualEnd("核采样（top_p）", 27) + `${config.topP}（推荐 ${recommendedTopP}，范围 0-1）`,
		padVisualEnd("最大输出（max_tokens）", 27) + maxTokensDisplay,
		"",
		"输入 /minimax 进入菜单修改。",
	].join("\n");
}

function registerMinimaxCommand(pi: ExtensionAPI) {
	pi.registerCommand("minimax", {
		description: "通过菜单查看或修改 MiniMax 运行时配置",
		handler: async (_args, ctx) => {
			// 每次执行时从磁盘重新加载，反映手动修改
			await loadConfig();
			const currentModel = ctx.model ? { id: ctx.model.id } : null;

			// 思考模式的中文描述
			const thinkingDesc = (v: string): string => {
				if (v === "auto") return "auto  （根据模型自动决定）";
				if (v === "adaptive") return "adaptive （强制开启）";
				return "disabled （强制关闭）";
			};

			// 服务层级的中文描述
			const tierDesc = (v: string): string => {
				if (v === "priority") return "priority （高优先级，1.5×价格）";
				return "standard （标准排队）";
			};

			const mainMenu = [
				padVisualEnd("思考模式（thinking）", 27) + `当前：${config.thinkingOverride}`,
				padVisualEnd("服务层级（service_tier）", 27) + `当前：${config.serviceTier}`,
				padVisualEnd("思考拆分（reasoning_split）", 27) + `当前：${config.reasoningSplit ? "拆分到独立字段" : "混合在 content 中"}`,
				padVisualEnd("温度（temperature）", 27) + `当前：${config.temperature}（范围 0-2）`,
				padVisualEnd("核采样（top_p）", 27) + `当前：${config.topP}（范围 0-1）`,
				padVisualEnd("最大输出（max_tokens）", 27) + `当前：${config.maxCompletionTokens ?? "自动（用模型默认）"}`,
				"恢复默认设置",
				"取消",
			];

			const action = await ctx.ui.select("MiniMax 配置", mainMenu);
			if (!action || action === "取消") return;

			if (action === "恢复默认设置") {
				config = { ...DEFAULT_CONFIG };
				await saveConfig();
				ctx.ui.notify("已恢复默认设置。\n\n" + formatConfig(currentModel), "info");
				return;
			}

			if (action.startsWith("思考模式（thinking）")) {
				const values = [
					`auto      （根据模型自动决定）`,
					`adaptive  （强制开启）`,
					`disabled  （强制关闭，M3生效）`,
					"取消",
				];
				const choice = await ctx.ui.select("选择思考模式（thinking）", values);
				if (!choice || choice === "取消") return;
				const newValue = choice.split(/\s+/)[0];
				config.thinkingOverride = newValue as ThinkingType | "auto";
				await saveConfig();
				ctx.ui.notify(`思考模式（thinking） = ${thinkingDesc(newValue)}\n\n` + formatConfig(currentModel), "info");
				return;
			}

			if (action.startsWith("服务层级（service_tier）")) {
				const values = [
					`priority  （高优先级，1.5×价格）`,
					`standard  （标准排队）`,
					"取消",
				];
				const choice = await ctx.ui.select("选择服务层级（service_tier）", values);
				if (!choice || choice === "取消") return;
				const newValue = choice.split(/\s+/)[0];
				config.serviceTier = newValue as ServiceTier;
				await saveConfig();
				ctx.ui.notify(`服务层级（service_tier） = ${tierDesc(newValue)}\n\n` + formatConfig(currentModel), "info");
				return;
			}

			if (action.startsWith("思考拆分（reasoning_split）")) {
				const values = [
					`true   （拆分到 reasoning_content 字段）`,
					`false  （保留在 content 字段中）`,
					"取消",
				];
				const choice = await ctx.ui.select("选择思考拆分方式（reasoning_split）", values);
				if (!choice || choice === "取消") return;
				const newValue = choice.split(/\s+/)[0];
				config.reasoningSplit = newValue === "true";
				await saveConfig();
				ctx.ui.notify(`思考拆分（reasoning_split） = ${config.reasoningSplit ? "拆分到 reasoning_content" : "保留在 content 中"}\n\n` + formatConfig(currentModel), "info");
				return;
			}

			// 新增：温度子菜单
			if (action.startsWith("温度（temperature）")) {
				const values = [
					`0.0  （完全确定）`,
					`0.5  （较确定）`,
					`0.7  （MiniMax 官方推荐低值）`,
					`1.0  （默认，平衡）`,
					`1.3  （MiniMax 官方推荐高值）`,
					`1.5  （较随机）`,
					`2.0  （完全随机）`,
					"取消",
				];
				const choice = await ctx.ui.select("选择温度（temperature）", values);
				if (!choice || choice === "取消") return;
				const newValue = parseFloat(choice.split(/\s+/)[0]);
				if (!isNaN(newValue) && newValue >= 0 && newValue <= 2) {
					config.temperature = newValue;
					await saveConfig();
					ctx.ui.notify(`温度（temperature） = ${config.temperature}\n\n` + formatConfig(currentModel), "info");
				}
				return;
			}

			// 新增：核采样子菜单
			if (action.startsWith("核采样（top_p）")) {
				const m2 = currentModel ? isM2Series(currentModel.id) : false;
				const recommended = m2 ? 0.9 : 0.95;
				const values = [
					`0.5  （聚焦）`,
					`0.7  （较聚焦）`,
					`${recommended}  （当前模型官方推荐）`,
					`1.0  （全概率采样）`,
					"取消",
				];
				const choice = await ctx.ui.select("选择核采样（top_p）", values);
				if (!choice || choice === "取消") return;
				const newValue = parseFloat(choice.split(/\s+/)[0]);
				if (!isNaN(newValue) && newValue >= 0 && newValue <= 1) {
					config.topP = newValue;
					await saveConfig();
					ctx.ui.notify(`核采样（top_p） = ${config.topP}\n\n` + formatConfig(currentModel), "info");
				}
				return;
			}

			// 新增：最大输出子菜单
			if (action.startsWith("最大输出（max_tokens）")) {
				const m2 = currentModel ? isM2Series(currentModel.id) : false;
				const modelDefault = m2 ? 65536 : 131072;
				const modelLimit = getMaxTokensLimit(currentModel?.id ?? "MiniMax-M3");
				const values = [
					`自动   （使用模型默认 ${modelDefault}）`,
					`${modelDefault}    （MiniMax 官方推荐）`,
					`${modelLimit}    （模型上限）`,
					"取消",
				];
				const choice = await ctx.ui.select("选择最大输出（max_tokens）", values);
				if (!choice || choice === "取消") return;
				if (choice.startsWith("自动")) {
					config.maxCompletionTokens = null;
				} else {
					const n = parseInt(choice.split(/\s+/)[0], 10);
					if (!isNaN(n) && n >= 1) {
						config.maxCompletionTokens = Math.min(n, modelLimit);
					}
				}
				await saveConfig();
				const display = config.maxCompletionTokens === null ? `自动（上限 ${modelLimit}）` : `${config.maxCompletionTokens}（上限 ${modelLimit}）`;
				ctx.ui.notify(`最大输出（max_tokens） = ${display}\n\n` + formatConfig(currentModel), "info");
				return;
			}
		},
	});
}

// =============================================================================
// 扩展注册
// =============================================================================

export default async function (pi: ExtensionAPI) {
	// 启动时从磁盘加载持久化的配置
	await loadConfig();
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

	registerMinimaxCommand(pi);
}
