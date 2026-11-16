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

/** 整个区间序列化。会二次裁剪总长度，防止输入本身就把预算吃光。 */
export function serializeRange(
  entries: SessionEntry[],
  entryIds: string[],
  maxChars = 60_000,
): string {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  const chunks: string[] = [];
  let total = 0;

  for (const id of entryIds) {
    const entry = byId.get(id);
    if (entry === undefined) continue;
    const text = renderEntry(entry);
    if (text === undefined) continue;

    if (total + text.length > maxChars) {
      chunks.push(`…[后续 ${entryIds.length - chunks.length} 条已省略]…`);
      break;
    }
    chunks.push(text);
    total += text.length;
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
export function buildSummaryHeader(blockId: string, messageCount: number, summary: string): string {
  return [
    `[历史摘要 ${blockId} · 覆盖 ${messageCount} 条消息]`,
    "",
    summary,
    "",
    `需要原文时调用 recall("${blockId}")。`,
  ].join("\n");
}
