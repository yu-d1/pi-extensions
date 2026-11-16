import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** 工具结果头尾保留：报错堆栈、断言失败、退出码几乎都在尾部 */
const HEAD_CHARS = 300;
const TAIL_CHARS = 800;
const CLIP_THRESHOLD = 1_200;

export function clipToolOutput(text: string): string {
  if (text.length <= CLIP_THRESHOLD) return text;
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS;
  return `${head}\n…[省略 ${omitted} 字符]…\n${tail}`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") parts.push("[图片]");
    else if (b.type === "thinking") parts.push("[思考过程]");
    else if (b.type === "toolCall") {
      const name = typeof b.name === "string" ? b.name : "?";
      parts.push(`[调用工具 ${name}] ${safeJson(b.arguments)}`);
    }
  }
  return parts.join("\n");
}

function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return "";
  }
}

/** 把一条会话条目渲染成给摘要模型看的纯文本 */
export function renderEntry(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  const text = contentToText((message as { content?: unknown }).content);

  switch (message.role) {
    case "user":
      return `[用户]\n${text}`;
    case "assistant": {
      const body = text.trim();
      return body.length > 0 ? `[助手]\n${body}` : undefined;
    }
    case "toolResult": {
      const name = (message as { toolName?: string }).toolName ?? "tool";
      const failed = (message as { isError?: boolean }).isError === true;
      const clipped = clipToolOutput(text);
      return `[工具 ${name}${failed ? " · 失败" : ""}]\n${clipped}`;
    }
    case "bashExecution": {
      const m = message as { command?: string; output?: string };
      return `[命令]\n${m.command ?? ""}\n${clipToolOutput(m.output ?? "")}`;
    }
    default:
      return text.trim().length > 0 ? text : undefined;
  }
}

/**
 * 整个区间序列化。
 *
 * 不设字符上限：一批折多大由模型的切分决定，插件再做二次裁剪
 * 会让摘要看不到后半段，静默丢信息。单条消息的长度仍在 renderEntry 里裁。
 */
export function serializeRange(entries: SessionEntry[], entryIds: string[]): string {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  const chunks: string[] = [];
  for (const id of entryIds) {
    const entry = byId.get(id);
    if (entry === undefined) continue;
    const text = renderEntry(entry);
    if (text === undefined) continue;
    chunks.push(text);
  }

  return chunks.join("\n\n");
}

/** 防止区间内容伪造闭合标签造成提示词注入 */
export function neutralize(text: string): string {
  return text.replaceAll("</conversation>", "</ conversation>").replaceAll("<conversation>", "< conversation>");
}

export interface PromptInput {
  serialized: string;
  messageCount: number;
  tokensInRange: number;
  /** 模型指定的摘要侧重点：哪些结论必须留住 */
  focus?: string;
}

export function buildFoldPrompt(input: PromptInput): string {
  return [
    "你要为一段即将从上下文中折叠掉的对话历史生成摘要。",
    "摘要会替代原文继续参与后续对话，所以它必须承载后续任务真正需要的信息。",
    "",
    "## 必须逐字保留",
    "- 文件路径与行号（例如 src/config.ts:120）",
    "- 函数签名、关键代码行",
    "- 报错的完整原文",
    "- 已经做出的决定及其理由",
    "- 用户明确提出的约束、偏好、禁止事项",
    "- 尚未解决的问题",
    "",
    ...(input.focus !== undefined && input.focus.trim().length > 0
      ? [
          "",
          "## 本次重点",
          "折叠发起方明确要求优先保住以下内容，与上面的通用规则冲突时以这里为准：",
          neutralize(input.focus.trim()),
        ]
      : []),
    "",
    "## 可以丢弃",
    "- 已经得出结论的冗长日志",
    "- 重复读取的相同内容",
    "- 走弯路的过程（但保留从中得到的教训）",
    "- 工具的完整输出（只保留结论性片段）",
    "",
    "## 预算紧张时的优先级",
    "目标 > 决定与理由 > 产出物与路径 > 结论 > 教训",
    "",
    "## 输出要求",
    "- 纯文本，不要 markdown 标题层级",
    "- 不要写「总结如下」之类的开场白",
    "- 按时间顺序组织",
    "- 控制在 800 字以内",
    "",
    `本段包含 ${input.messageCount} 条消息，约 ${input.tokensInRange} tokens。`,
    "",
    "<conversation>",
    neutralize(input.serialized),
    "</conversation>",
  ].join("\n");
}

/** 摘要块在上下文里的显示头，模型据此知道这是折叠产物、覆盖多少、怎么取回原文 */
export function buildSummaryHeader(
  blockId: string,
  messageCount: number,
  summary: string,
  topic?: string,
): string {
  const title =
    topic !== undefined && topic.trim().length > 0
      ? `[历史摘要 ${blockId} · 覆盖 ${messageCount} 条消息 · ${topic.trim()}]`
      : `[历史摘要 ${blockId} · 覆盖 ${messageCount} 条消息]`;
  return [title, "", summary, "", `需要原文时调用 recall("${blockId}")。`].join("\n");
}

export interface SplitPromptInput {
  /** 每轮的序号与原话，按时间顺序 */
  turns: Array<{ index: number; userText: string }>;
  /** 候选区间总 token，用于让模型有个体量参照 */
  totalTokens: number;
}

/**
 * 让模型决定这段历史切成几批。
 *
 * 只给 user 原话：切分依据是用户提了哪些需求，助手过程对判断子任务边界帮助不大，
 * 而全量内容会让这次调用和一次完整摘要一样贵。
 */
export function buildSplitPrompt(input: SplitPromptInput): string {
  const rows = input.turns.map((turn) => {
    const text = turn.userText.replace(/\s+/g, " ").trim();
    const clipped = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return `[${turn.index}] ${clipped}`;
  });

  return [
    "下面是一段即将被折叠的对话历史，每轮一行，只保留了用户的原话。",
    "",
    "你的任务：按子任务边界把它切成若干批，每批单独生成摘要。",
    "分批是为了让每批的摘要都能覆盖到全部原文，所以不要分出过大的批；",
    "也不要切得比一个子任务还碎，同一件事的过程应该留在同一批里。",
    "",
    "输出要求：",
    "- 只输出 JSON，不要任何解释文字",
    "- 格式：{\"batches\":[{\"from\":1,\"to\":8,\"topic\":\"简短主题\"}]}",
    "- from / to 是轮次序号，闭区间，必须覆盖全部轮次，不要重叠或留空",
    "- topic 用一句话概括这批在做什么，会显示在摘要头部",
    "",
    `共 ${input.turns.length} 轮，约 ${input.totalTokens} tokens。`,
    "",
    "<turns>",
    rows.join("\n"),
    "</turns>",
  ].join("\n");
}

/** 切分结果解析失败时的原因，仅用于日志与兜底判断 */
export class SplitParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitParseError";
  }
}

/** 剥掉模型可能加的 markdown 围栏 */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

/** 从模型输出里取出切分方案；不合法就抛错，由调用方兜底 */
export function parseSplitResponse(text: string): Array<{ from: number; to: number; topic: string }> {
  const body = stripFence(text);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SplitParseError("输出里没有 JSON 对象");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new SplitParseError(`JSON 解析失败: ${msg}`);
  }

  const batches = (parsed as { batches?: unknown }).batches;
  if (!Array.isArray(batches) || batches.length === 0) {
    throw new SplitParseError("缺少 batches 数组");
  }

  const result: Array<{ from: number; to: number; topic: string }> = [];
  for (const item of batches) {
    if (item === null || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const from = typeof b.from === "number" ? b.from : Number(b.from);
    const to = typeof b.to === "number" ? b.to : Number(b.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    result.push({
      from: Math.floor(from),
      to: Math.floor(to),
      topic: typeof b.topic === "string" ? b.topic : "",
    });
  }

  if (result.length === 0) throw new SplitParseError("batches 里没有合法条目");
  return result;
}
