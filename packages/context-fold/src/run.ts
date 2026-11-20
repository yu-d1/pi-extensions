import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { atSafetyLimit, canFoldWindow, effectiveFoldAt, MAX_CONCURRENCY, type FoldConfig } from "./config.js";
import { fallbackBatches, normalizeBatches, pickRange, toFoldRange, type BatchPlan, type Candidates } from "./fold.js";
import type { FoldRecord, FoldState } from "./state.js";
import { foldedEntryIds, reserveBlockIds, sortedRecords } from "./state.js";
import { mergeSummaries, splitCandidates, summarizeRange } from "./summarize.js";

/**
 * 产出本次折叠要写进上下文的记录。
 *
 * 形态：1 个合并块 + N 个新块。
 *   合并块承载全部历史，用一个块就够了，块数不会随折叠次数增长；
 *   新块对应本次切分出的子任务，各存细节，recall 时能精确取回。
 */
function collect(fresh: FoldRecord[], merged: FoldRecord | undefined): FoldRecord[] {
  const blocks = fresh.filter((r) => r.summary.trim().length > 0);
  if (merged !== undefined && merged.summary.trim().length > 0) blocks.unshift(merged);
  return blocks;
}

/**
 * 把现有各块的摘要压成一段。
 *
 * 用新编号而不是复用旧块的：旧块的 fold-record 一旦写进会话就删不掉，
 * 复用编号会让同一个 id 在文件里出现多次，重建时分不清哪份是最新的。
 * 排在最前靠 merged 标记，不靠编号。
 *
 * entryIds 累积所有块的全部条目，recall 仍能取回最早的历史原文。
 */
function buildMerged(
  blockId: string,
  base: FoldRecord,
  records: FoldRecord[],
  summary: string,
): FoldRecord {
  const entryIds: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const id of record.entryIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      entryIds.push(id);
    }
  }
  // 头条目必须排第一，它承载摘要正文
  const rest = entryIds.filter((id) => id !== base.headEntryId);
  return {
    blockId,
    entryIds: [base.headEntryId, ...rest],
    headEntryId: base.headEntryId,
    summary,
    topic: base.topic,
    // 旧块之间可能已有包含关系，累加会虚高；取去重后的总量
    tokensBefore: records.reduce((sum, r) => sum + r.tokensBefore, 0),
    tokensAfter: Math.round(summary.length / 4),
    createdAt: Date.now(),
    merged: true,
  };
}

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
    folded: foldedEntryIds(state, branch),
    currentTokens: usage?.tokens ?? undefined,
    tokenScale: state.tokenScale,
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
        plans = await splitCandidates(ctx, { candidates, signal, reasoning, config });
      } catch {
        plans = undefined;
      }
      if (signal?.aborted) return;

      const batches = planBatches(candidates, plans);
      if (batches.length === 0) return;

      // 编号一次预留，并发完成顺序不会影响块顺序。
      // 合并块也占一个新号：旧块的 fold-record 删不掉，复用编号会让
      // 同一个 id 在会话文件里出现多次，重建时分不清哪份最新。
      const oldBlocks = sortedRecords(state);
      const base = oldBlocks[0];
      const needsMerge = base !== undefined;
      const blockIds = reserveBlockIds(state, batches.length + (needsMerge ? 1 : 0));
      const mergeBlockId = needsMerge ? blockIds[blockIds.length - 1] : undefined;
      const batchBlockIds = needsMerge ? blockIds.slice(0, -1) : blockIds;

      // 任务表：N 个摘要 +（有旧块时）1 个合并
      state.batchTotal = batches.length + (needsMerge ? 1 : 0);

      let mergedRecord: FoldRecord | undefined;

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
              config,
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

      // 合并任务：把现有各块压成一段。与各批摘要一起排队，不额外拖尾。
      // 失败就保留旧块原样，下次折叠再试，不影响本次新块写入。
      const runMerge = async (): Promise<void> => {
        if (!needsMerge || mergeBlockId === undefined || signal?.aborted) return;
        try {
          const merged = await mergeSummaries(ctx, {
            summaries: oldBlocks.map((r) => r.summary),
            signal,
            reasoning,
            config,
          });
          if (merged !== undefined) mergedRecord = buildMerged(mergeBlockId, base!, oldBlocks, merged);
        } catch {
          // 保留旧块，不记为失败
        }
        state.batchDone += 1;
        onSettled?.();
      };

      if (config.batchMode === "parallel") {
        const limit = Math.max(1, Math.min(MAX_CONCURRENCY, config.batchConcurrency));
        const tasks: Array<() => Promise<void>> = batches.map((b, i) => () => runOne(b, batchBlockIds[i]));
        if (needsMerge) tasks.push(() => runMerge());

        let cursor = 0;
        const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
          while (cursor < tasks.length) {
            const i = cursor++;
            if (signal?.aborted) return;
            await tasks[i]();
          }
        });
        await Promise.all(workers);
      } else {
        for (let i = 0; i < batches.length; i++) {
          if (signal?.aborted) break;
          await runOne(batches[i], batchBlockIds[i]);
          // 串行时某一个失败就停，没必要继续烧钱
          if (failed > 0) break;
        }
        if (failed === 0) await runMerge();
      }

      if (signal?.aborted) return;

      const blocks = collect(records ?? [], mergedRecord);
      if (blocks.length > 0) state.pending = blocks;
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
