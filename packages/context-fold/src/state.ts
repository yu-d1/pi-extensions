import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** 折叠记录。写在会话里，重启和切分支都能重建。 */
export interface FoldRecord {
  /** b1, b2, b3 ... 在同一会话内唯一 */
  blockId: string;
  /** 被折叠的原始条目 id，按时间顺序 */
  entryIds: string[];
  /** 承载摘要的那一条（也是 entryIds[0]） */
  headEntryId: string;
  /** 摘要正文 */
  summary: string;
  /** 折叠前的上下文字数（估算） */
  tokensBefore: number;
  /** 折叠后这一块占用的 token（摘要长度） */
  tokensAfter: number;
  createdAt: number;
}

/** 运行期状态。全部可以丢弃重建，不进配置。 */
export interface FoldState {
  /** 已生效的折叠块 */
  records: Map<string, FoldRecord>;
  /** 下一个可用序号，独立自增，不依赖 records.size */
  nextSeq: number;
  /** 最近一次折叠后的上下文 token 数，用作增长门槛基线 */
  lastFoldTokens: number | null;
  /** 正在后台生成摘要 */
  summarizing: boolean;
  /** 摘要已生成，等待在下一个边界应用 */
  pending: FoldRecord | undefined;
  /** 连续失败次数，用来避免反复重试同一个坏区间 */
  failures: number;
}

export function createState(): FoldState {
  return {
    records: new Map(),
    nextSeq: 1,
    lastFoldTokens: null,
    summarizing: false,
    pending: undefined,
    failures: 0,
  };
}

export function resetState(state: FoldState): void {
  state.records.clear();
  state.nextSeq = 1;
  state.lastFoldTokens = null;
  state.summarizing = false;
  state.pending = undefined;
  state.failures = 0;
}

export function nextBlockId(state: FoldState): string {
  const id = `b${state.nextSeq}`;
  state.nextSeq += 1;
  return id;
}

function isFoldRecordEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && (entry as { customType?: string }).customType === "fold-record";
}

function readRecord(entry: SessionEntry): FoldRecord | undefined {
  const data = (entry as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return undefined;

  const d = data as Record<string, unknown>;
  if (typeof d.blockId !== "string" || !Array.isArray(d.entryIds)) return undefined;

  const entryIds = d.entryIds.filter((id): id is string => typeof id === "string");
  if (entryIds.length === 0) return undefined;

  return {
    blockId: d.blockId,
    entryIds,
    headEntryId: typeof d.headEntryId === "string" ? d.headEntryId : entryIds[0],
    summary: typeof d.summary === "string" ? d.summary : "",
    tokensBefore: typeof d.tokensBefore === "number" ? d.tokensBefore : 0,
    tokensAfter: typeof d.tokensAfter === "number" ? d.tokensAfter : 0,
    createdAt: typeof d.createdAt === "number" ? d.createdAt : 0,
  };
}

function seqOf(blockId: string): number {
  const n = Number.parseInt(blockId.replace(/^b/, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从当前分支重建折叠状态。
 *
 * 记录只增不改，所以这里是纯填充；nextSeq 取所有历史记录的最大序号 + 1，
 * 避免删掉旧块之后撞号。
 */
export function rebuildFromBranch(state: FoldState, branch: SessionEntry[]): void {
  state.records.clear();
  let maxSeq = 0;

  for (const entry of branch) {
    if (!isFoldRecordEntry(entry)) continue;
    const record = readRecord(entry);
    if (record === undefined) continue;

    maxSeq = Math.max(maxSeq, seqOf(record.blockId));
    state.records.set(record.blockId, record);
  }

  state.nextSeq = maxSeq + 1;
}

/** 判断某个条目是否还在当前分支上 */
export function onBranch(branch: SessionEntry[], entryId: string): boolean {
  return branch.some((entry) => entry.id === entryId);
}

/** 已被折叠过的条目 id 集合，选新区间时用来跳过 */
export function foldedEntryIds(state: FoldState): Set<string> {
  const ids = new Set<string>();
  for (const record of state.records.values()) {
    for (const id of record.entryIds) ids.add(id);
  }
  return ids;
}
