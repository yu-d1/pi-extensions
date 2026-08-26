export function truncateText(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join("");
}
