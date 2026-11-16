import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadConfig, tokenLabel } from "./src/config.js";
import { buildDrafts, type FoldRange } from "./src/fold.js";
import { registerMenu } from "./src/menu.js";
import { buildSummaryHeader } from "./src/prompt.js";
import { MAX_FAILURES, shouldFold, startSummarize } from "./src/run.js";
import { createState, foldedEntryIds, onBranch, rebuildFromBranch, resetState, type FoldState } from "./src/state.js";
import { registerTools } from "./src/tools.js";

const STATUS_KEY = "context-fold";

/** footer 状态：只在干活时占位，其余一律留空 */
function updateStatus(ctx: ExtensionContext, state: FoldState): void {
  const ui = ctx.ui;
  if (ui?.setStatus === undefined) return;

  if (state.summarizing) {
    ui.setStatus(STATUS_KEY, "折叠中...");
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

function buildHeader(record: { blockId: string; entryIds: string[]; summary: string }): string {
  return buildSummaryHeader(record.blockId, record.entryIds.length, record.summary);
}

/** 把 pending 转成待追加条目；分支对不上就丢弃 */
function drainPending(
  state: FoldState,
  branch: SessionEntry[],
): Array<Record<string, unknown>> | undefined {
  const record = state.pending;
  if (record === undefined) return undefined;
  state.pending = undefined;

  // 头部不在当前分支上，说明被 /tree 切走了
  if (!onBranch(branch, record.headEntryId)) return undefined;

  // 区间内已有条目被折叠过，状态错乱，丢弃
  const folded = foldedEntryIds(state);
  if (record.entryIds.some((id) => folded.has(id))) return undefined;

  const range: FoldRange = {
    entryIds: record.entryIds,
    headEntryId: record.headEntryId,
    tokensBefore: record.tokensBefore,
  };
  const drafts = buildDrafts(range, record.blockId, record.summary, buildHeader(record), record.tokensAfter);

  state.records.set(record.blockId, drafts.record);
  return drafts.entries as unknown as Array<Record<string, unknown>>;
}

export default function contextFold(pi: ExtensionAPI): void {
  const state = createState();
  let abort: AbortController | undefined;

  pi.on("session_start", async (_event, ctx) => {
    rebuildFromBranch(state, branchOf(ctx));
    // 交给 agent_settled 补读，那里 usage 才准确
    state.lastFoldTokens = null;
    state.summarizing = false;
    state.pending = undefined;
    state.failures = 0;
    updateStatus(ctx, state);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // 基线补齐，分两种情况：
    //   从未折叠过 → 基线为 0，增长量就是全部上下文，第一轮就该能触发
    //   折叠过（应用后置空）→ 读折叠后的真实值，用作下次的增长起点
    if (state.lastFoldTokens === null) {
      const usage = ctx.getContextUsage();
      state.lastFoldTokens = state.records.size > 0 ? (usage?.tokens ?? 0) : 0;
    }

    const config = loadConfig();
    if (!shouldFold(ctx, state, config)) return;

    abort?.abort();
    abort = new AbortController();
    // 摘要完成时刷新 footer；后台上下文里的 ctx 可能已失效，所以只改状态，
    // 真正的 UI 刷新由下一个边界事件负责
    startSummarize(ctx, state, config, abort.signal, () => {
      try {
        updateStatus(ctx, state);
      } catch {
        // 会话已关闭，忽略
      }
    });
    updateStatus(ctx, state);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    // 摘要还在生成就不等：本轮照常收尾，下轮边界再应用。
    // 多留一条未折叠的最近内容是正常的，不值得为它阻塞收尾。
    if (state.pending === undefined) {
      updateStatus(ctx, state);
      return;
    }

    const drafts = drainPending(state, branchOf(ctx));
    if (drafts === undefined) return;

    // 应用后基线归零，下次 agent_settled 重新读
    state.lastFoldTokens = null;
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
    const config = loadConfig();
    const lines: string[] = [];

    // 模型判断模式：每轮注入判断准则，让模型自己决定何时折。
    // 只写静态准则：带实时 token 数的话每轮都会生成不同文本，
    // 产生一条新的 system patch 并打断尾部缓存。水位让模型用 fold_status 现查。
    //
    // 连续失败时不再引导折叠：反正调不动，还会让模型每轮白试一次。
    if (state.failures >= MAX_FAILURES) {
      lines.push(
        "[上下文折叠]",
        `折叠已暂停（连续失败 ${state.failures} 次），不要调用 request_fold。`,
        "需要时提示用户执行 /fold f 手动重试。",
      );
    } else if (config.enabled && config.triggerMode === "model") {
      lines.push(
        "[上下文折叠]",
        "较早的对话可以折叠成摘要，原文不会删除，之后随时能用 recall 取回，所以折叠是低风险操作。",
        "",
        "出现这些情况时调用 request_fold：",
        "- 一个子任务刚收尾（改完一个文件、修完一个 bug、跑完一轮验证）",
        "- 用户说「不用了」「先这样」「继续别的」—— 这通常意味着上一阶段已经结束",
        "- 你正准备写一段很长的阶段总结 —— 先折叠，再总结，不要用文字总结代替折叠",
        "- 大量工具输出已经提炼出结论，原文不再需要",
        "",
        "这些先不要折：",
        "- 正在调试、还没解决的问题",
        "- 刚读取但还没用上的代码或数据",
        "- 最近几轮对话",
        "",
        "两个可选参数：",
        "- focus：写明这段历史里哪些结论、路径、决定必须在摘要中留住。摘要只看得到部分原文，",
        "  不写 focus 容易丢关键细节。",
        "- includeRecent：刚结束的那几轮已经收尾、不需要再回看时设为 true，否则尾部会被保护起来不折。",
        "",
        "需要知道当前用量时调用 fold_status，不要凭感觉估。",
        "调用后插件会在后台生成摘要，本轮结束时生效，不需要等待。",
      );
    }

    // 已有折叠块时说明如何取回原文
    if (state.records.size > 0) {
      if (lines.length > 0) lines.push("");
      const blocks = [...state.records.values()]
        .map(
          (r) =>
            `${r.blockId} 覆盖 ${r.entryIds.length} 条（${tokenLabel(r.tokensBefore)} → ${tokenLabel(r.tokensAfter)}）`,
        )
        .join("；");
      lines.push(
        `较早的对话已折叠为摘要，共 ${state.records.size} 块：${blocks}。`,
        "摘要块以 [历史摘要 bN] 开头，标注了覆盖范围。",
        "当摘要不足以支撑当前任务（需要原始报错、完整代码、具体数值）时，调用 recall(blockId) 取回原文。",
        "不要因为摘要存在而跳过必要的核查。",
      );
    }

    if (lines.length === 0) return;
    event.systemPromptOptions.sections["context-fold"] = lines.join("\n");
  });

  registerTools(pi, state, (ctx, intent) => {
    const config = loadConfig();
    if (config.triggerMode !== "model") return { started: false, reason: "当前为按阈值自动折叠。" };
    if (state.summarizing) return { started: false, reason: "已有摘要正在生成，请稍后。" };
    if (state.pending !== undefined) return { started: false, reason: "上一块已生成摘要，本轮结束会生效。" };
    if (state.failures >= MAX_FAILURES) {
      return { started: false, reason: "摘要连续失败，折叠已暂停。请继续当前任务，不要重复尝试。" };
    }

    const started = startSummarize(
      ctx,
      state,
      config,
      undefined,
      () => {
        try {
          updateStatus(ctx, state);
        } catch {
          // 会话已关闭
        }
      },
      intent,
    );
    if (!started) {
      return { started: false, reason: "没有可折叠的区间：需要至少两轮已完成的对话，且区间够大。" };
    }
    updateStatus(ctx, state);
    return { started: true };
  });
  registerMenu(pi, state);
}
