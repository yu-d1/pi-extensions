/**
 * TUI 选项前缀对齐。
 * 仅用于显示，业务逻辑绝不能依赖对齐后的字符串匹配。
 */
export function padPrefix(s: string): string {
  let width = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0xfe0f) continue;
    if (code >= 0x1f000) width += 2;
    else if (code >= 0x2600 && code <= 0x27ff) width += 2;
    else if (code === 0x23f8 || code === 0x23ed) width += 1;
    else width += 1;
  }
  const pad = Math.max(1, 4 - width);
  return s + " ".repeat(pad);
}

export function truncateText(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join("");
}
