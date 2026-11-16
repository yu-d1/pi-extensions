import { estimateTokens } from "@earendil-works/pi-coding-agent";

/** 摘要文本的 token 估算：按 user 消息口径量一次 */
export function estimateTokensFromSummary(summary: string): number {
  return estimateTokens({ role: "user", content: summary, timestamp: 0 } as Parameters<
    typeof estimateTokens
  >[0]);
}
