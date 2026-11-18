import { estimateTokens } from "@earendil-works/pi-coding-agent";

/** 摘要文本的 token 估算：按 user 消息口径量一次 */
export function estimateTokensFromSummary(summary: string): number {
  return estimateTokens({ role: "user", content: summary, timestamp: 0 } as Parameters<
    typeof estimateTokens
  >[0]);
}

/** 校准系数的合理区间，越界的样本丢掉，避免被异常 usage 带偏 */
const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

/**
 * 用真实 usage 校准「本地估算 → 真实 token」的比例。
 *
 * 本插件内部（以及 pi 折叠后的回退估算）都按 chars/4 折算，而
 * 中文一个字往往就是一个 token，纯英文代码则是 3~4 字符一个 token。
 * 会话里中英混排时这个折算会系统性偏低，导致：
 *   - 保留量看起来是 40K，实际留了 55K；
 *   - 阈值看起来是 250K，实际要到 300K 才触发。
 *
 * 做法：找最后一条带有效 usage 的 assistant，用它的真实总量除以
 * 同一段消息的本地估算，得到真实比值。pi 在有 usage 时返回的就是
 * 真实值，所以这个比值就是缺的那个校正量。
 */
export function computeTokenScale(messages: readonly unknown[]): number | undefined {
  let index = -1;
  let real = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as
      | { role?: string; stopReason?: string; usage?: Record<string, number> }
      | undefined;
    if (message?.role !== "assistant" || message.usage === undefined) continue;
    // 中断或出错的轮次 usage 不可信
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;

    const usage = message.usage;
    const total =
      (usage.totalTokens ?? 0) > 0
        ? (usage.totalTokens as number)
        : (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (total <= 0) continue;

    index = i;
    real = total;
    break;
  }

  if (index < 0) return undefined;

  let estimated = 0;
  for (let i = 0; i <= index; i++) {
    estimated += estimateTokens(messages[i] as Parameters<typeof estimateTokens>[0]);
  }
  if (estimated <= 0) return undefined;

  const ratio = real / estimated;
  if (!Number.isFinite(ratio) || ratio < MIN_SCALE || ratio > MAX_SCALE) return undefined;
  return ratio;
}
