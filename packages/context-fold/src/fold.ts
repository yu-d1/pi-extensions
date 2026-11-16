import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { MIN_HEADROOM_TOKENS, type FoldConfig } from "./config.js";
import type { FoldRecord } from "./state.js";

/** 保留量下限：再少也不该把这些内容折掉 */
const MIN_KEEP_TOKENS = 2_000;

/** 一轮对话：从一条 user 消息开始，到下一条 user 之前 */
export interface Turn {
  /** 该 turn 在 entries 里的起始下标 */
  start: number;
  /** 结束下标（不含） */
  end: number;
  /** 本轮所有消息的估算 token 数 */
  tokens: number;
  /** 本轮的条目 id */
  entryIds: string[];
}

/** 折叠候选区间 */
export interface FoldRange {
  /** 待折叠的条目 id，按时间顺序 */
  entryIds: string[];
  /** 承载摘要的条目（区间第一条） */
  headEntryId: string;
  /** 区间内原始 token 估算 */
  tokensBefore: number;
}

export type SkipReason =
  | "no-turns"
  | "no-completed-turns"
  | "nothing-beyond-protection"
  | "range-too-small"
  | "all-folded"
  | "insufficient-headroom";

export interface PickResult {
  range?: FoldRange;
  reason?: SkipReason;
}

function messageEntryId(entry: SessionEntry): string | undefined {
  return entry.type === "message" ? entry.id : undefined;
}

/** 只统计真正进上下文的消息条目 */
/**
 * 哪些条目参与折叠。
 *
 * 只取 user / assistant / toolResult 三种消息。system 消息虽然也是
 * type "message"，但 appendContextEdit 不接受它，折了会直接抛错。
 * custom_message 可以折但不在 turn 内（不占区间），保持原样不动。
 */
function isFoldable(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const role = entry.message.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

function entryTokens(entry: SessionEntry): number {
  if (!isFoldable(entry) || entry.type !== "message") return 0;
  return estimateTokens(entry.message as Parameters<typeof estimateTokens>[0]);
}

/**
 * 找出扫描起点：最后一条原生 compaction 之后。
 *
 * 被原生压缩盖住的条目已经不在上下文里了，再对它们做 context_edit 没有意义，
 * 而且 entryIds 会因为跨越压缩边界而失去连续性。
 */
function scanStart(branch: SessionEntry[]): number {
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") return i + 1;
  }
  return 0;
}

/**
 * 按 user 消息切分 turn。
 *
 * 折叠边界只能落在 user 条目之前，这样 assistant(toolCall) 和 toolResult
 * 天然成组，不会出现孤儿结果导致协议报错。
 */
export function splitTurns(branch: SessionEntry[]): Turn[] {
  const start = scanStart(branch);
  const turns: Turn[] = [];
  let current: Turn | undefined;

  for (let i = start; i < branch.length; i++) {
    const entry = branch[i];
    if (!isFoldable(entry) || entry.type !== "message") continue;

    const role = entry.message.role;
    if (role !== "user") {
      if (current === undefined) continue; // 会话以 assistant 开头，忽略
      current.end = i + 1;
      current.tokens += entryTokens(entry);
      current.entryIds.push(entry.id);
      continue;
    }

    if (current !== undefined) turns.push(current);
    current = {
      start: i,
      end: i + 1,
      tokens: entryTokens(entry),
      entryIds: [entry.id],
    };
  }

  if (current !== undefined) turns.push(current);

  // 最后一个 turn 可能没跑完（当前正在进行的任务），不参与折叠，
  // 但保留在列表里供调用方判断。
  return turns;
}

export interface PickOptions {
  config: FoldConfig;
  /** 本次实际生效的触发阈值（可能被窗口限制过） */
  foldAtTokens: number;
  /** 当前投影的真实 token 数（不含已折叠部分），用于判断折完是否还有意义 */
  currentTokens: number;
  /** 已被折叠过的条目 id */
  folded: Set<string>;
  /** 模型明确表示最近几轮已收尾，允许把它们也纳入折叠（保留量降到下限） */
  includeRecent?: boolean;
}

/**
 * 选出要折叠的区间。
 *
 * 策略：从尾部往前扣掉保留量，剩下的全折。这样折叠点尽量靠后，
 * 前缀缓存命中最多。
 */
export function pickRange(branch: SessionEntry[], options: PickOptions): PickResult {
  const turns = splitTurns(branch);
  if (turns.length === 0) return { reason: "no-turns" };

  // 最后一个 turn 是当前任务，永远保留
  const usable = turns.slice(0, -1);
  if (usable.length === 0) return { reason: "no-completed-turns" };

  // 第一个 turn 承载任务意图，永久保护
  const candidates = usable.slice(1);
  if (candidates.length === 0) return { reason: "nothing-beyond-protection" };

  // 保留量不能占满整个阈值，否则折完也省不下空间。
  // includeRecent 时降到下限：模型说最近几轮已收尾，不必再圈进保护区。
  const keepBudget = options.includeRecent
    ? MIN_KEEP_TOKENS
    : Math.max(
        MIN_KEEP_TOKENS,
        Math.min(options.config.keepRecentTokens, Math.max(MIN_KEEP_TOKENS, options.foldAtTokens - MIN_HEADROOM_TOKENS)),
      );

  // 从尾部往前保留 keepBudget
  let kept = 0;
  let cut = candidates.length;
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (kept >= keepBudget) break;
    kept += candidates[i].tokens;
    cut = i;
  }

  if (cut === 0) return { reason: "nothing-beyond-protection" };

  // 从候选里剔除已折叠的条目；一个 turn 只要还有未折叠条目就保留剩下的部分
  const range = candidates.slice(0, cut);
  const entryIds: string[] = [];
  let tokensBefore = 0;
  let skippedAll = true;

  // 防御：再对照一次 branch，确保交给 context_edit 的条目都能被编辑
  const index = new Map(branch.map((entry) => [entry.id, entry]));

  for (const turn of range) {
    for (const id of turn.entryIds) {
      if (options.folded.has(id)) continue;
      const entry = index.get(id);
      if (entry === undefined || !isFoldable(entry)) continue;
      skippedAll = false;
      entryIds.push(id);
    }
    if (turn.entryIds.some((id) => !options.folded.has(id))) {
      tokensBefore += turn.tokens;
    }
  }

  if (skippedAll || entryIds.length === 0) return { reason: "all-folded" };

  // 区间太薄，白付一次摘要费用
  if (tokensBefore < options.config.minFoldTokens) return { reason: "range-too-small" };

  // 折完还是超过阈值，说明保留量占满了预算，这次折叠没意义。
  // 基准用当前投影的真实 token，而不是所有历史轮次之和——
  // 已折叠的轮次在投影里只剩摘要，再算一遍会让判断失效。
  if (options.currentTokens - tokensBefore >= options.foldAtTokens) {
    return { reason: "insufficient-headroom" };
  }

  return {
    range: {
      entryIds,
      headEntryId: entryIds[0],
      tokensBefore,
    },
  };
}

/** 边界草稿：context_edit 列表 + 一条元数据记录 */
export interface FoldDraft {
  type: "context_edit";
  targetId: string;
  replacement: { content: Array<{ type: "text"; text: string }> } | null;
}

export interface RecordDraft {
  type: "custom";
  customType: "fold-record";
  data: FoldRecord;
}

export interface Drafts {
  entries: Array<FoldDraft | RecordDraft>;
  record: FoldRecord;
}

/**
 * 生成要追加的条目。
 *
 * 头条目内容换成摘要（传数组格式，避免角色相关的类型分歧），
 * 其余条目设为 null 从投影中移除，最后写一条元数据记录。
 */
export function buildDrafts(
  range: FoldRange,
  blockId: string,
  summary: string,
  header: string,
  tokensAfter: number,
): Drafts {
  const record: FoldRecord = {
    blockId,
    entryIds: range.entryIds,
    headEntryId: range.headEntryId,
    summary,
    tokensBefore: range.tokensBefore,
    tokensAfter,
    createdAt: Date.now(),
  };

  const entries: Array<FoldDraft | RecordDraft> = [];

  // 头条目：换成摘要，保留 original 角色与位置
  entries.push({
    type: "context_edit",
    targetId: range.headEntryId,
    replacement: { content: [{ type: "text", text: header }] },
  });

  // 其余条目：从上下文消失
  for (const id of range.entryIds.slice(1)) {
    entries.push({ type: "context_edit", targetId: id, replacement: null });
  }

  // 元数据：不进上下文，只用于重建
  entries.push({ type: "custom", customType: "fold-record", data: record });

  return { entries, record };
}
