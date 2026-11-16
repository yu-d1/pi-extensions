import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { atSafetyLimit, canFoldWindow, effectiveFoldAt, type FoldConfig } from "./config.js";
import { pickRange } from "./fold.js";
import type { FoldState } from "./state.js";
import { foldedEntryIds, nextBlockId } from "./state.js";
import { summarizeRange, SummarizeError } from "./summarize.js";

/** 连续失败这么多轮后暂停自动折叠 */
export const MAX_FAILURES = 3;

/** 折叠请求的语义参数，来自模型（request_fold）或默认值（自动触发） */
export interface FoldIntent {
  /** 摘要侧重点，告诉摘要器哪些结论必须留住 */
  focus?: string;
  /** 最近几轮已收尾，允许纳入折叠 */
  includeRecent?: boolean;
}

/** 选区间并后台生成摘要，不阻塞任何流程 */
export function startSummarize(
  ctx: ExtensionContext,
  state: FoldState,
  config: FoldConfig,
  signal?: AbortSignal,
  /** 后台任务结束时回调，用于刷新 footer 状态 */
  onSettled?: () => void,
  intent?: FoldIntent,
): boolean {
  if (state.summarizing) return false;

  const branch = ctx.sessionManager.getBranch() as Parameters<typeof pickRange>[0];
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? 0;
  const picked = pickRange(branch, {
    config,
    foldAtTokens: effectiveFoldAt(config, window),
    currentTokens: usage?.tokens ?? 0,
    folded: foldedEntryIds(state),
    includeRecent: intent?.includeRecent === true,
  });
  if (picked.range === undefined) return false;

  const range = picked.range;
  const blockId = nextBlockId(state);
  state.summarizing = true;


  void (async () => {
    try {
      const result = await summarizeRange(ctx, { blockId, branch, range, signal, focus: intent?.focus });
      state.pending = {
        blockId,
        entryIds: range.entryIds,
        headEntryId: range.headEntryId,
        summary: result.summary,
        tokensBefore: range.tokensBefore,
        tokensAfter: result.tokensAfter,
        createdAt: Date.now(),
      };
      state.failures = 0;
    } catch (error) {
      if (error instanceof SummarizeError || error instanceof Error) {
        state.failures += 1;
      }
    } finally {
      state.summarizing = false;
      onSettled?.();
    }
  })();

  return true;
}

/** 阈值 + 增长双门槛判断 */
export function shouldFold(ctx: ExtensionContext, state: FoldState, config: FoldConfig): boolean {
  if (!config.enabled) return false;
  if (state.summarizing || state.pending !== undefined) return false;
  if (state.failures >= MAX_FAILURES) return false;

  const usage = ctx.getContextUsage();
  if (usage?.tokens == null || usage.contextWindow <= 0) return false;

  // 窗口小到装不下阈值时，用窗口能容纳的上限
  if (!canFoldWindow(config, usage.contextWindow)) return false;

  // 保底线：两种模式都生效，到占比就折，不看增长
  if (atSafetyLimit(usage.tokens, usage.contextWindow, config)) return true;

  // 模型判断模式下不按阈值自动触发，等模型调 request_fold
  if (config.triggerMode === "model") return false;

  if (usage.tokens < effectiveFoldAt(config, usage.contextWindow)) return false;

  const baseline = state.lastFoldTokens ?? 0;
  if (usage.tokens - baseline < config.minGrowth) return false;

  return true;
}
