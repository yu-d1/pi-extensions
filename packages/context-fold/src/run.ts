import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { atSafetyLimit, canFoldWindow, effectiveFoldAt, MAX_CONCURRENCY, type FoldConfig } from "./config.js";
import { fallbackBatches, normalizeBatches, pickRange, toFoldRange, type BatchPlan, type Candidates } from "./fold.js";
import type { FoldState } from "./state.js";
import { foldedEntryIds, reserveBlockIds } from "./state.js";
import { splitCandidates, summarizeRange } from "./summarize.js";

/** 连续失败这么多轮后暂停自动折叠 */
export const MAX_FAILURES = 3;

/** 单批失败后重试的次数 */
const BATCH_RETRIES = 1;

/** 兜底切分的默认批数：模型不给可用方案时，按轮次均分成这么多批 */
const FALLBACK_BATCH_COUNT = 3;

/** 切分失败时退化为固定批数 */
function planBatches(candidates: Candidates, plans: BatchPlan[] | undefined): BatchPlan[] {
  if (plans === undefined || plans.length === 0) {
    return fallbackBatches(candidates, FALLBACK_BATCH_COUNT);
  }
  return normalizeBatches(candidates, plans);
}

/** 等一段时间，给限流类错误留出恢复空间 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * 选候选区间、切分、逐批生成摘要。
 *
 * 切分只调一次模型，之后按配置串行或并发跑各批。
 * 全程异步，不阻塞任何对话流程。
 */
export function startSummarize(
  ctx: ExtensionContext,
  state: FoldState,
  config: FoldConfig,
  signal?: AbortSignal,
  /** 后台任务结束时回调，用于刷新 footer 状态 */
  onSettled?: () => void,
  /** 当前会话的思考等级，摘要与切分都跟随它 */
  reasoning?: string,
): boolean {
  if (state.summarizing) return false;

  const branch = ctx.sessionManager.getBranch() as Parameters<typeof pickRange>[0];
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? 0;
  const picked = pickRange(branch, {
    config,
    foldAtTokens: effectiveFoldAt(config, window),
    folded: foldedEntryIds(state),
  });
  if (picked.candidates === undefined) return false;

  const candidates = picked.candidates;
  state.summarizing = true;
  state.batchDone = 0;
  state.batchTotal = 0;

  void (async () => {
    const records: FoldState["pending"] = [];
    let failed = 0;

    try {
      // 切分：失败就用兜底方案，不影响折叠本身
      let plans: BatchPlan[] | undefined;
      try {
        plans = await splitCandidates(ctx, { candidates, signal, reasoning });
      } catch {
        plans = undefined;
      }
      if (signal?.aborted) return;

      const batches = planBatches(candidates, plans);
      if (batches.length === 0) return;

      // 编号一次预留，并发完成顺序不会影响块顺序
      const blockIds = reserveBlockIds(state, batches.length);
      state.batchTotal = batches.length;

      const runOne = async (batch: BatchPlan, blockId: string): Promise<void> => {
        const range = toFoldRange(candidates, batch);
        if (range === undefined) return;

        let lastError: unknown;
        for (let attempt = 0; attempt <= BATCH_RETRIES; attempt++) {
          if (signal?.aborted) return;
          try {
            const result = await summarizeRange(ctx, {
              blockId,
              branch,
              range,
              signal,
              topic: batch.topic,
              reasoning,
            });
            records?.push({
              blockId,
              entryIds: range.entryIds,
              headEntryId: range.headEntryId,
              summary: result.summary,
              topic: batch.topic.length > 0 ? batch.topic : undefined,
              tokensBefore: range.tokensBefore,
              tokensAfter: result.tokensAfter,
              createdAt: Date.now(),
            });
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < BATCH_RETRIES) await delay(1_000, signal);
          }
        }

        state.batchDone += 1;
        if (lastError !== undefined) failed += 1;
        onSettled?.();
      };

      if (config.batchMode === "parallel") {
        const limit = Math.max(1, Math.min(MAX_CONCURRENCY, config.batchConcurrency));
        let cursor = 0;
        const workers = Array.from({ length: Math.min(limit, batches.length) }, async () => {
          while (cursor < batches.length) {
            const i = cursor++;
            if (signal?.aborted) return;
            await runOne(batches[i], blockIds[i]);
          }
        });
        await Promise.all(workers);
      } else {
        for (let i = 0; i < batches.length; i++) {
          if (signal?.aborted) break;
          await runOne(batches[i], blockIds[i]);
          // 串行时某一个失败就停，没必要继续烧钱
          if (failed > 0) break;
        }
      }

      if (signal?.aborted) return;

      if (records !== undefined && records.length > 0) {
        state.pending = records;
      }
      state.failures = failed > 0 ? state.failures + 1 : 0;
    } catch {
      state.failures += 1;
    } finally {
      state.summarizing = false;
      state.batchTotal = 0;
      state.batchDone = 0;
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

  // 保底线：到占比就折，不看增长
  if (atSafetyLimit(usage.tokens, usage.contextWindow, config)) return true;

  if (usage.tokens < effectiveFoldAt(config, usage.contextWindow)) return false;

  const baseline = state.lastFoldTokens ?? 0;
  if (usage.tokens - baseline < config.minGrowth) return false;

  return true;
}
