import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadConfig, tokenLabel } from "./src/config.js";
import { buildDrafts, type FoldRange } from "./src/fold.js";
import { registerMenu } from "./src/menu.js";
import { buildSummaryHeader } from "./src/prompt.js";
import { MAX_FAILURES, shouldFold, startSummarize } from "./src/run.js";
import { createState, foldedEntryIds, onBranch, rebuildFromBranch, resetState, sortedRecords, type FoldState } from "./src/state.js";
import { computeTokenScale } from "./src/tokens.js";
import { registerTools } from "./src/tools.js";

const STATUS_KEY = "context-fold";

/** footer 状态：只在干活时占位，其余一律留空 */
function updateStatus(ctx: ExtensionContext, state: FoldState): void {
  const ui = ctx.ui;
  if (ui?.setStatus === undefined) return;

  if (state.summarizing) {
    // 多批时带进度，单批不显示分子分母
    ui.setStatus(STATUS_KEY, state.batchTotal > 1 ? `折叠中... ${state.batchDone}/${state.batchTotal}` : "折叠中...");
    return;
  }
  if (state.pending !== undefined) {
    ui.setStatus(STATUS_KEY, "待生效");
    return;
  }
  ui.setStatus(STATUS_KEY, undefined);
}

function branchOf(ctx: ExtensionContext): SessionEntry[] {
  return ctx.sessionManager.getBranch() as SessionEntry[];
}

/** 把 pending 转成待追加条目；逐批校验，对不上的那批丢弃 */
/**
 * 把待生效的折叠写进上下文。
 *
 * pending 里只有一条记录：它已经包含了旧摘要与新内容的合并结果，
 * 所以这里只需要把旧块原有的摘要头条目清空，再把本块头条目换成
 * 新摘要，其余条目一律从投影中移除。上下文里始终只有一份摘要。
 */
/**
 * 把待生效的块写进上下文。
 *
 * 待生效里可能同时有合并块与本次新块。合并块复用了最早旧块的编号与头位置，
 * 所以那些旧块要先从上下文和状态里清掉，否则两份摘要会同时挂在上面。
 */
function drainPending(state: FoldState, branch: SessionEntry[]): Array<Record<string, unknown>> | undefined {
  const pending = state.pending;
  if (pending === undefined) return undefined;
  state.pending = undefined;

  const all: Array<Record<string, unknown>> = [];

  // 待生效里如果有一个编号已在状态中的块，说明本次做了合并，
  // 它顶替了其他旧块的位置，那些旧块要清掉。
  // 合并失败时 pending 里只有新块，旧块原封不动。
  const mergeBlockId = pending.find((r) => state.records.has(r.blockId))?.blockId;

  if (mergeBlockId !== undefined) {
    for (const old of sortedRecords(state)) {
      if (old.blockId === mergeBlockId) continue;
      if (!onBranch(branch, old.headEntryId)) continue;
      all.push({ type: "context_edit", targetId: old.headEntryId, replacement: null });
      state.records.delete(old.blockId);
    }
  }

  // 已在上下文里躺着的条目，不需要再发一次 context_edit
  const already = foldedEntryIds(state, branch);

  for (const record of pending) {
    // 头部不在当前分支上，说明被 /tree 切走了
    if (!onBranch(branch, record.headEntryId)) continue;

    // 合并块会覆盖旧块已折叠的条目，这是正常的；新块区间不该有重叠。
    const isMerge = record.blockId === mergeBlockId;
    if (!isMerge && record.entryIds.some((id) => already.has(id))) continue;

    const header = buildSummaryHeader(record.blockId, record.entryIds.length, record.summary, record.topic);
    const range: FoldRange = {
      entryIds: record.entryIds,
      headEntryId: record.headEntryId,
      tokensBefore: record.tokensBefore,
    };
    const drafts = buildDrafts(range, record.blockId, record.summary, header, record.tokensAfter, record.topic);

    // 只有头条目真正需要写摘要，其余条目早在旧块里就已置空
    const edits = (drafts.entries as Array<Record<string, unknown>>).filter((e) => {
      if (e.type !== "context_edit") return true;
      if (e.targetId === record.headEntryId) return true;
      return !already.has(e.targetId as string);
    });

    state.records.set(record.blockId, drafts.record);
    all.push(...edits);
  }

  return all.length > 0 ? all : undefined;
}

export default function contextFold(pi: ExtensionAPI): void {
  const state = createState();
  let abort: AbortController | undefined;

  /** 启动与切分支都要重建：状态只认当前分支上的折叠记录 */
  const resync = (ctx: ExtensionContext): void => {
    abort?.abort();
    abort = undefined;
    rebuildFromBranch(state, branchOf(ctx));
    // 基线交给 agent_settled 重算
    state.lastFoldTokens = null;
    state.baselinePending = false;
    state.summarizing = false;
    state.pending = undefined;
    state.batchTotal = 0;
    state.batchDone = 0;
    state.failures = 0;
    updateStatus(ctx, state);
  };

  pi.on("session_start", async (_event, ctx) => resync(ctx));

  // 切分支不会重建 ctx 里的 sessionManager，但会改变可见条目。
  // 不重建的话，回滚后 state.records 里还留着另一条分支的块，
  // lastFoldTokens 也停在旧值上，导致增长门槛永远迈不过去。
  pi.on("session_tree", async (_event, ctx) => resync(ctx));

  /** 到阈值就启动折叠；返回是否已启动 */
  const triggerFold = (ctx: ExtensionContext): boolean => {
    const config = loadConfig();
    if (!shouldFold(ctx, state, config)) return false;

    abort?.abort();
    abort = new AbortController();
    // 摘要跟随当前会话的思考等级：自己另指定一套只会与对话脱节，
    // 而且固定传 "off" 在部分供应商上等于不下发任何参数，反而按默认强度思考
    const level = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
    // 摘要完成时刷新 footer；后台上下文里的 ctx 可能已失效，所以只改状态，
    // 真正的 UI 刷新由下一个边界事件负责
    const started = startSummarize(
      ctx,
      state,
      config,
      abort.signal,
      () => {
        try {
          updateStatus(ctx, state);
        } catch {
          // 会话已关闭，忽略
        }
      },
      level,
    );
    if (started) updateStatus(ctx, state);
    return started;
  };

  /** 补齐基线：折叠后要读折叠后的真实值，其余情况从 0 起算 */
  const syncBaseline = (ctx: ExtensionContext): void => {
    if (state.baselinePending) {
      state.lastFoldTokens = ctx.getContextUsage()?.tokens ?? 0;
      state.baselinePending = false;
    } else if (state.lastFoldTokens === null) {
      state.lastFoldTokens = 0;
    }
  };

  /**
   * 用真实 usage 校准本地估算的比例。
   *
   * chars/4 对中文偏低，折叠后 pi 回退到该估算，状态栏就会显示得比实际小。
   * 每轮拿最近一条真实 usage 算一次，平滑一下避免单次抖动。
   */
  const syncTokenScale = (ctx: ExtensionContext): void => {
    try {
      const messages = ctx.sessionManager.buildSessionProjection().messages;
      const next = computeTokenScale(messages);
      if (next === undefined) return;
      // 首次直接采用，之后小幅跟随，避免个别异常样本把系数拉飞
      state.tokenScale = state.tokenScale === 0 ? next : state.tokenScale * 0.7 + next * 0.3;
    } catch {
      // 投影不可用时跳过，保持上一个值
    }
  };

  pi.on("agent_settled", async (_event, ctx) => {
    syncBaseline(ctx);
    syncTokenScale(ctx);
    triggerFold(ctx);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    // 摘要还在生成就不等：本轮照常收尾，下轮边界再应用。
    if (state.pending === undefined) {
      updateStatus(ctx, state);
      return;
    }

    const drafts = drainPending(state, branchOf(ctx));
    if (drafts === undefined) {
      updateStatus(ctx, state);
      return;
    }

    // 应用后基线待重读：现在拿到的 usage 还是折叠前的，读了会偏高
    state.lastFoldTokens = null;
    state.baselinePending = true;
    updateStatus(ctx, state);

    return {
      entries: [...(event.entries as Array<Record<string, unknown>>), ...drafts],
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    abort?.abort();
    abort = undefined;
    resetState(state);
    updateStatus(ctx, state);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // 用户发出提问时先看一眼水位：超了就地开始折，不必等到本轮结束。
    // 读的是上一轮响应带回的 usage，正好是这次提问时的上下文大小。
    syncBaseline(ctx);
    triggerFold(ctx);

    const lines: string[] = [];

    // 只剩两块内容：怎么取回原文、以及失败暂停提示。
    // 折叠时机由阈值决定，不需要在这里引导模型。
    if (state.records.size > 0) {
      const blocks = sortedRecords(state)
        .map(
          (r) =>
            `${r.blockId} 覆盖 ${r.entryIds.length} 条（${tokenLabel(r.tokensBefore)} → ${tokenLabel(r.tokensAfter)}）${
              r.topic !== undefined && r.topic.length > 0 ? ` · ${r.topic}` : ""
            }`,
        )
        .join("；");
      lines.push(
        "[上下文折叠]",
        `较早的对话已折叠为摘要，共 ${state.records.size} 块：${blocks}。`,
        "摘要块以 [历史摘要 bN] 开头，标注了覆盖范围与主题。",
        "当摘要不足以支撑当前任务（需要原始报错、完整代码、具体数值）时，调用 recall(blockId) 取回原文。",
        "不要因为摘要存在而跳过必要的核查。",
      );
    }

    if (state.failures >= MAX_FAILURES) {
      if (lines.length > 0) lines.push("");
      else lines.push("[上下文折叠]");
      lines.push(`自动折叠已暂停（连续失败 ${state.failures} 次），可提示用户执行 /fold f 手动重试。`);
    }

    if (lines.length === 0) return;
    event.systemPromptOptions.sections["context-fold"] = lines.join("\n");
  });

  registerTools(pi, state);
  registerMenu(pi, state);
}
