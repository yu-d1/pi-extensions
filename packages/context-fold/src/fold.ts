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

/** 待切分的候选轮次，交给模型决定切成几批 */
export interface CandidateTurn {
  /** 轮次序号，从 1 开始，给模型看的编号 */
  index: number;
  /** 该轮的条目 id */
  entryIds: string[];
  /** 该轮首条 user 消息的正文，切分时只给模型看这个 */
  userText: string;
  /** 该轮估算 token */
  tokens: number;
}

export interface Candidates {
  /** 按时间顺序排列的候选轮次 */
  turns: CandidateTurn[];
  /** 候选区间总 token */
  totalTokens: number;
}

export type SkipReason =
  | "no-turns"
  | "no-completed-turns"
  | "nothing-beyond-protection"
  | "range-too-small"
  | "all-folded";

export interface PickResult {
  candidates?: Candidates;
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
  /** 已被折叠过的条目 id */
  folded: Set<string>;
  /** 当前投影的真实 token，用于判断折完是否还有意义 */
  currentTokens?: number;
  /** 真实 token / 本地估算的比值，用于把保留量换算成真实口径 */
  tokenScale?: number;
}

/**
 * 选出待折叠的候选轮次。
 *
 * 只负责划出「哪一段可以折」，具体切成几批交给模型决定。
 * 从尾部往前扣掉保留量，剩下的全部作为候选，顺序保持时间先后。
 */
export function pickRange(branch: SessionEntry[], options: PickOptions): PickResult {
  const turns = splitTurns(branch);
  if (turns.length === 0) return { reason: "no-turns" };

  // 最后一个 turn 是当前任务。它通常已经跑完（agent_before_settle 阶段），
  // 可以一起参与折叠；但末尾还悬着 toolCall 时说明结果没回来，
  // 折掉会让 toolResult 变成孤儿，pi 直接报错，这种轮次必须整轮保留。
  const current = turns[turns.length - 1];
  const candidates = isTurnComplete(branch, current) ? turns : turns.slice(0, -1);
  if (candidates.length === 0) return { reason: "no-completed-turns" };

  // 保留量不能占满整个阈值，否则折完也省不下空间
  const keepBudget = Math.max(
    MIN_KEEP_TOKENS,
    Math.min(options.config.keepRecentTokens, Math.max(MIN_KEEP_TOKENS, options.foldAtTokens - MIN_HEADROOM_TOKENS)),
  );
  // 保留量按真实 token 理解，而 turn.tokens 是 chars/4 估算，
  // 中文多的会话里两者差 30% 以上，不换算会实际多留一大截
  const scale = options.tokenScale !== undefined && options.tokenScale > 0 ? options.tokenScale : 1;

  // 从尾部往前累加「未被折叠」的量。
  // 已折叠的条目在上下文里只剩摘要，不能再按原始大小占预算，
  // 否则保留量会被虚高的数字填满，实际保留了远多于配置的量。
  let kept = 0;
  let cut = candidates.length;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const live = liveTokensOf(candidates[i], options.folded);
    if (live === 0) {
      // 整轮已折叠过，既不占预算也不阻断向前推进
      cut = i;
      continue;
    }
    // 放不下就整轮保留，不再多带一轮（边界只能落在轮首）
    if ((kept + live) * scale > keepBudget) {
      // 一轮自己就超预算时（轮内不能切分），至少要保住它，
      // 否则会把当前任务一起折掉；此外的轮全部可折。
      if (kept === 0) {
        cut = i;
        break;
      }
      cut = i + 1;
      break;
    }
    kept += live;
    cut = i;
  }

  // cut 到底说明全部都得保留，没有可折的部分
  if (cut >= candidates.length) return { reason: "nothing-beyond-protection" };

  // 防御：再对照一次 branch，确保交给 context_edit 的条目都能被编辑
  const index = new Map(branch.map((entry) => [entry.id, entry]));
  const picked: CandidateTurn[] = [];
  let totalTokens = 0;

  for (const turn of candidates.slice(0, cut)) {
    const entryIds: string[] = [];
    for (const id of turn.entryIds) {
      if (options.folded.has(id)) continue;
      const entry = index.get(id);
      if (entry === undefined || !isFoldable(entry)) continue;
      entryIds.push(id);
    }
    if (entryIds.length === 0) continue;

    const foldedAll = entryIds.length < turn.entryIds.length;
    picked.push({
      index: picked.length + 1,
      entryIds,
      userText: firstUserText(branch, turn),
      // 部分条目已被折叠过时，按比例折算这轮的实际 token
      tokens: foldedAll ? Math.round((turn.tokens * entryIds.length) / turn.entryIds.length) : turn.tokens,
    });
    totalTokens += picked[picked.length - 1].tokens;
  }

  if (picked.length === 0) return { reason: "all-folded" };

  // 区间太薄，白付一次摘要费用
  if (totalTokens < options.config.minFoldTokens) return { reason: "range-too-small" };

  // 折完还是接近阈值，说明保留量把预算占满了，这次折叠没意义。
  // 基准用当前投影的真实 token：currentTokens 与 foldAtTokens 同口径。
  if (options.currentTokens !== undefined) {
    const savedAfter = options.currentTokens - totalTokens * scale;
    if (savedAfter >= options.foldAtTokens) return { reason: "insufficient-headroom" };
  }

  return { candidates: { turns: picked, totalTokens } };
}

/** 一轮里未被折叠过的 token（已折叠部分在上下文里只剩摘要，不再占预算） */
function liveTokensOf(turn: Turn, folded: Set<string>): number {
  if (turn.tokens === 0) return 0;
  let live = 0;
  for (const id of turn.entryIds) if (!folded.has(id)) live += 1;
  if (live === 0) return 0;
  if (live === turn.entryIds.length) return turn.tokens;
  return Math.round((turn.tokens * live) / turn.entryIds.length);
}

/**
 * 一轮是否已经收尾。
 *
 * 收尾 = 没有悬着的 toolCall。末尾是 toolResult 或 user 则安全；
 * 若最后一个条目是 assistant 且带 toolCall，说明结果还没回来，
 * 折掉会让 toolResult 变成孤儿（pi 会直接报错）。
 */
function isTurnComplete(branch: SessionEntry[], turn: Turn): boolean {
  for (let i = turn.end - 1; i >= turn.start; i--) {
    const entry = branch[i];
    if (entry?.type !== "message") continue;
    const role = entry.message.role;
    if (role === "toolResult" || role === "user") return true;
    const content = entry.message.content;
    if (!Array.isArray(content)) return true;
    return !content.some((block) => {
      const b = block as Record<string, unknown> | null;
      return b !== null && typeof b === "object" && b.type === "toolCall";
    });
  }
  return false;
}

/** 取一轮里的 user 原话，切分时给模型看的就是这段 */
function firstUserText(branch: SessionEntry[], turn: Turn): string {
  for (let i = turn.start; i < turn.end; i++) {
    const entry = branch[i];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    return messageText(entry.message).trim();
  }
  return "";
}

/** 消息正文的纯文本，忽略思考块与图片 */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
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
  topic?: string,
): Drafts {
  const record: FoldRecord = {
    blockId,
    entryIds: range.entryIds,
    headEntryId: range.headEntryId,
    summary,
    topic,
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

/** 一批折叠的轮次范围（模型给出的序号区间） */
export interface BatchPlan {
  /** 起始轮次序号（含） */
  from: number;
  /** 结束轮次序号（含） */
  to: number;
  /** 这段的主题，用作摘要侧重点与摘要头 */
  topic: string;
}

/** 把序号区间映射回具体的折叠区间 */
export function toFoldRange(candidates: Candidates, plan: BatchPlan): FoldRange | undefined {
  const entryIds: string[] = [];
  let tokensBefore = 0;

  for (const turn of candidates.turns) {
    if (turn.index < plan.from || turn.index > plan.to) continue;
    entryIds.push(...turn.entryIds);
    tokensBefore += turn.tokens;
  }

  if (entryIds.length === 0) return undefined;
  return { entryIds, headEntryId: entryIds[0], tokensBefore };
}

/**
 * 兜底切分：模型返回不可用时用这个。
 *
 * 目标是每批差不多大，且都落在轮次边界上，所以平均分即可。
 */
export function fallbackBatches(candidates: Candidates, count: number): BatchPlan[] {
  const turns = candidates.turns;
  if (turns.length === 0) return [];

  const size = Math.max(1, Math.ceil(turns.length / Math.max(1, count)));
  const plans: BatchPlan[] = [];
  for (let i = 0; i < turns.length; i += size) {
    const slice = turns.slice(i, i + size);
    plans.push({
      from: slice[0].index,
      to: slice[slice.length - 1].index,
      topic: "",
    });
  }
  return plans;
}

/**
 * 校验模型给的切分方案。
 *
 * 要求：序号递增、不重叠、不越界。合法部分保留，空洞用后续轮次补齐，
 * 保证覆盖完整且每轮只被折一次。
 */
export function normalizeBatches(candidates: Candidates, plans: BatchPlan[]): BatchPlan[] {
  const turns = candidates.turns;
  if (turns.length === 0) return [];
  const minIndex = turns[0].index;
  const maxIndex = turns[turns.length - 1].index;

  const valid = plans
    .map((p) => ({
      from: Math.max(minIndex, Math.min(maxIndex, Math.floor(p.from))),
      to: Math.max(minIndex, Math.min(maxIndex, Math.floor(p.to))),
      topic: typeof p.topic === "string" ? p.topic.trim() : "",
    }))
    .filter((p) => p.from <= p.to)
    .sort((a, b) => a.from - b.from);

  // 去掉重叠：后一批的起点推到前一批结尾之后
  const cleaned: BatchPlan[] = [];
  let cursor = minIndex;
  for (const p of valid) {
    const from = Math.max(p.from, cursor);
    if (from > p.to) continue;
    cleaned.push({ from, to: p.to, topic: p.topic });
    cursor = p.to + 1;
    if (cursor > maxIndex) break;
  }

  // 尾部有空洞就补一批；完全为空时整体均分
  if (cleaned.length === 0) return fallbackBatches(candidates, 1);
  const last = cleaned[cleaned.length - 1];
  if (last.to < maxIndex) {
    cleaned.push({ from: last.to + 1, to: maxIndex, topic: "" });
  }

  return cleaned;
}
