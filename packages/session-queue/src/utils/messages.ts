function messageText(message: any): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block && block.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join(" ");
  }
  return "";
}

/** 找到 branch 中最后一个 user 消息。 */
export function currentUserMessage(ctx: any): { id: string | null; text: string } {
  try {
    const branch = ctx.sessionManager.getBranch();
    if (!Array.isArray(branch)) return { id: null, text: "" };
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message?.role === "user") {
        return { id: entry.id ?? null, text: messageText(entry.message) };
      }
    }
  } catch {
    // sessionManager 可能尚未就绪；返回空值由调用方兜底。
  }
  return { id: null, text: "" };
}

/** 找到 branch 中某个 user 消息的父 user 消息 id（用于树形队列拓扑）。 */
export function parentUserMessageId(ctx: any, userMsgId: string | null): string | null {
  if (!userMsgId) return null;
  try {
    const branch = ctx.sessionManager.getBranch();
    if (!Array.isArray(branch)) return null;
    let index = -1;
    for (let i = 0; i < branch.length; i++) {
      if (branch[i]?.id === userMsgId) {
        index = i;
        break;
      }
    }
    if (index < 0) return null;
    for (let i = index - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message?.role === "user") {
        return entry.id ?? null;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/** 找到 branch 中最后一个 assistant 文本，用于 resultText 展示。 */
export function currentAssistantText(ctx: any, maxLength = 80): string {
  try {
    const branch = ctx.sessionManager.getBranch();
    if (!Array.isArray(branch)) return "";
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message?.role === "assistant") {
        return Array.from(messageText(entry.message)).slice(0, maxLength).join("");
      }
    }
  } catch {
    // ignore
  }
  return "";
}
