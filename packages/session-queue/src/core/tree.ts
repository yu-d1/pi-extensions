import * as fs from "node:fs";
import { EMPTY_HASH } from "../constants";
import type { FileChange, Logger, QueueData, QueueEntry } from "../types";
import { atomicWriteFile, readContentIfExists, sha256 } from "../utils/fs";
import { comparablePath } from "../utils/path";
import type { SnapshotStore } from "../storage/snapshot-store";

/**
 * 树形节点模型：把会话树中的 user 节点映射为回滚检查点。
 *
 * 核心概念：
 * - 检查点 = 一个 user 节点（QueueEntry.sessionEntryId 对应其消息 id）；
 * - 节点状态映射 = 从根到该节点路径上所有变更合并后的 (path → beforeHash/afterHash)；
 * - 全局基线 = 所有检查点中每个 path 最早出现的 beforeHash（近似"分支分叉前的根状态"）；
 * - 切换/回滚到节点 X = 把磁盘状态重放为 X 的节点状态（不截断队列，各分支记录保留）。
 *
 * 迁移说明：旧队列是单层链（entries 线性数组 + sessionEntryId）。attachQueueToTree
 * 用 sessionEntryId 在 user 树上挂载；匹配不到的（无 id 或找不到节点）按数组顺序
 * 形成线性父链，这与旧数据完全兼容。
 */

export interface NodeStateEntry {
  path: string;
  beforeHash: string; // 路径上首次出现的 before
  afterHash: string;  // 路径上最新的 after
}

export interface SessionTreeNode {
  id: string; // user 消息 id
  parentId: string | null; // 父 user 消息 id
  text: string;
  /** 对应 entries 数组下标；-1 表示"有 user 节点但无检查点"（例如树导航到分支起点） */
  queueIndex: number;
  children: SessionTreeNode[];
  entry?: QueueEntry;
  branchLabel?: string;
}

export interface NodeSwitchPreview {
  create: string[];
  restore: string[];
  remove: string[];
  conflicts: string[];
  /** 目标节点之外、因基线兜底而会被还原为根状态的文件 */
  baselineRestored: string[];
}

export interface ApplyNodeStateResult {
  restored: number;
  deleted: number;
  skipped: string[];
  missingSnapshot: string[];
}

function messageText(message: any): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block && block.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join(" ");
  }
  return "";
}

/** 从 sessionManager.getEntries() 构建 user 节点树（根 = 无 user 祖先的 user 节点）。 */
export function buildUserTree(sessionEntries: any[]): SessionTreeNode[] {
  const userEntries = (sessionEntries ?? []).filter(
    (entry: any) => entry && entry.type === "message" && entry?.message?.role === "user",
  );
  const parentById = new Map<string, string | null>();
  for (const entry of sessionEntries ?? []) {
    parentById.set(entry?.id, entry?.parentId ?? null);
  }
  const userIds = new Set(userEntries.map((e: any) => e.id));

  const byId = new Map<string, SessionTreeNode>();
  for (const e of userEntries) {
    byId.set(e.id, {
      id: e.id,
      parentId: null,
      text: messageText(e.message),
      queueIndex: -1,
      children: [],
    });
  }

  for (const e of userEntries) {
    const node = byId.get(e.id)!;
    node.parentId = nearestUserAncestor(e.id, parentById, userIds);
    if (node.parentId) {
      byId.get(node.parentId)!.children.push(node);
    }
  }
  return [...byId.values()].filter((n) => !n.parentId);
}

function nearestUserAncestor(
  startId: string,
  parentById: Map<string, string | null>,
  userIds: Set<string>,
): string | null {
  let pid = parentById.get(startId) ?? null;
  while (pid) {
    if (userIds.has(pid)) return pid;
    pid = parentById.get(pid) ?? null;
  }
  return null;
}

/** 直接构建 user 消息 id → 父 user 消息 id 的映射（供 service 持久化 parentEntryId 使用）。 */
export function buildUserParentMap(sessionEntries: any[]): Map<string, string | null> {
  const parentById = new Map<string, string | null>();
  for (const entry of sessionEntries ?? []) {
    parentById.set(entry?.id, entry?.parentId ?? null);
  }
  const userIds = new Set(
    (sessionEntries ?? [])
      .filter((entry: any) => entry?.type === "message" && entry?.message?.role === "user")
      .map((entry: any) => entry.id),
  );
  const result = new Map<string, string | null>();
  for (const id of userIds) {
    parentById.get(id); // 确保存在
    result.set(id, nearestUserAncestor(id, parentById, userIds));
  }
  return result;
}

/** 把队列 entry 挂载到 user 树节点；无 sessionEntryId 的旧数据按数组顺序形成线性父链。 */
export function attachQueueToTree(roots: SessionTreeNode[], entries: QueueEntry[]): void {
  const byId = new Map<string, SessionTreeNode>();
  const walk = (nodes: SessionTreeNode[]) => {
    for (const n of nodes) {
      byId.set(n.id, n);
      walk(n.children);
    }
  };
  walk(roots);

  let lastNodeId: string | null = null;
  for (const entry of entries) {
    if (entry.residual) continue;
    const node = entry.sessionEntryId ? byId.get(entry.sessionEntryId) ?? null : null;
    if (node) {
      node.queueIndex = entries.indexOf(entry);
      node.entry = entry;
      if (!entry.parentEntryId && node.parentId) entry.parentEntryId = node.parentId;
      lastNodeId = node.id;
    } else {
      // 旧数据兜底：挂到前一个检查点后面，形成单层链。
      entry.parentEntryId = entry.parentEntryId ?? lastNodeId ?? undefined;
      lastNodeId = entry.sessionEntryId ?? lastNodeId;
    }
  }
}

/**
 * 计算一个节点的完整文件状态映射（从根到该节点路径上的变更合并）。
 * beforeHash = 路径上首次出现；afterHash = 路径上最新。
 */
export function nodeStateOf(
  entry: QueueEntry | undefined,
  entries: QueueEntry[],
): Map<string, NodeStateEntry> {
  const result = new Map<string, NodeStateEntry>();
  if (!entry) return result;

  // 沿 parentEntryId 链收集祖先顺序（根在前）。
  const chain: QueueEntry[] = [];
  const bySession = new Map<string, QueueEntry>();
  for (const e of entries) {
    if (!e.residual && e.sessionEntryId) bySession.set(e.sessionEntryId, e);
  }
  let cur: QueueEntry | undefined = entry;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentEntryId ? bySession.get(cur.parentEntryId) : undefined;
  }

  for (const e of chain) {
    for (const change of e.changes ?? []) {
      const key = comparablePath(change.path);
      const existing = result.get(key);
      if (!existing) {
        result.set(key, { path: change.path, beforeHash: change.beforeHash, afterHash: change.afterHash });
      } else {
        existing.afterHash = change.afterHash;
      }
    }
  }
  return result;
}

/** 全局基线：所有检查点中每个 path 最早出现的 beforeHash（近似根的初始状态）。 */
export function globalBaselineOf(entries: QueueEntry[]): Map<string, NodeStateEntry> {
  const result = new Map<string, NodeStateEntry>();
  for (const entry of entries) {
    if (entry.residual) continue;
    for (const change of entry.changes ?? []) {
      const key = comparablePath(change.path);
      if (!result.has(key)) {
        result.set(key, { path: change.path, beforeHash: change.beforeHash, afterHash: change.beforeHash });
      }
    }
  }
  return result;
}

/** 计算当前磁盘状态映射，用于冲突检测。旧队列按 after 兼容。 */
export function currentDiskExpectation(queue: QueueData): Map<string, NodeStateEntry> {
  const current = queue.entries[queue.currentIndex];
  const currentState = queue.currentMode === "before" && current
    ? targetStateFor(queue, queue.currentIndex, "before")
    : nodeStateOf(current, queue.entries);
  const baseline = globalBaselineOf(queue.entries);
  const result = new Map(currentState);
  for (const [key, entry] of baseline) {
    if (!result.has(key)) result.set(key, entry);
  }
  return result;
}

/** 节点目标语义：after = 该操作完成后的状态；before = 该操作开始前的状态（= 父节点状态）。 */
export type NodeMode = "after" | "before";

/**
 * 计算目标节点在指定语义下的“节点状态（after 集合）”。
 * - after：该节点自身累积状态（nodeStateOf）
 * - before：父节点的累积状态（操作前）；无父（根 turn）返回空 map，由基线兜底回到最初状态
 */
export function targetStateFor(queue: QueueData, targetIdx: number, mode: NodeMode): Map<string, NodeStateEntry> {
  const entry = queue.entries[targetIdx];
  if (!entry) return new Map();
  if (mode !== "before") return nodeStateOf(entry, queue.entries);
  const parent = entry.parentEntryId
    ? queue.entries.find((e) => !e.residual && e.sessionEntryId === entry.parentEntryId)
    : undefined;
  if (parent) return nodeStateOf(parent, queue.entries);
  return new Map();
}

/**
 * 预览切换到目标节点的效果（不动磁盘）。
 * 目标状态 = 目标节点状态（按 mode）+ 基线兜底（未涉及文件还原为根状态）。
 */
export function previewNodeSwitch(
  queue: QueueData,
  targetIdx: number,
  mode: NodeMode = "after",
): NodeSwitchPreview {
  const targetState = targetStateFor(queue, targetIdx, mode);
  const baseline = globalBaselineOf(queue.entries);
  const currentExpected = currentDiskExpectation(queue);

  // 期望最终状态 E。
  const E = new Map<string, NodeStateEntry>(baseline);
  for (const [key, entry] of targetState) E.set(key, entry);

  const conflicts: string[] = [];
  const create: string[] = [];
  const restore: string[] = [];
  const remove: string[] = [];
  const baselineRestored: string[] = [];

  for (const [key, entry] of E) {
    const targetIsMissing = entry.afterHash === EMPTY_HASH;
    const diskExists = readContentIfExists(entry.path) !== null;
    const diskHash = sha256(readContentIfExists(entry.path));

    // 冲突检测：磁盘与"当前节点应然状态"不一致（用户手动改过或外部变化）
    const currentExpect = currentExpected.get(key);
    if (currentExpect && diskHash !== currentExpect.afterHash) {
      conflicts.push(entry.path);
    }

    if (targetIsMissing) {
      if (diskExists) remove.push(entry.path);
    } else if (!diskExists) {
      create.push(entry.path);
    } else if (diskHash !== entry.afterHash) {
      if (!targetState.has(key)) baselineRestored.push(entry.path);
      restore.push(entry.path);
    }
  }

  return { create, restore, remove, conflicts, baselineRestored };
}

/**
 * 执行切换到目标节点：把磁盘状态重放为目标节点状态（含基线兜底）。
 * 不截断队列，各分支记录保留。
 */
export function applyNodeState(
  queue: QueueData,
  targetIdx: number,
  snapshotStore: SnapshotStore,
  logger: Logger,
  force = false,
  mode: NodeMode = "after",
): ApplyNodeStateResult {
  const targetState = targetStateFor(queue, targetIdx, mode);
  const baseline = globalBaselineOf(queue.entries);
  const currentExpected = currentDiskExpectation(queue);

  const E = new Map<string, NodeStateEntry>(baseline);
  for (const [key, entry] of targetState) E.set(key, entry);

  let restored = 0;
  let deleted = 0;
  const skipped: string[] = [];
  const missingSnapshot: string[] = [];

  for (const [key, entry] of E) {
    const currentExpect = currentExpected.get(key);
    const diskHash = sha256(readContentIfExists(entry.path));

    // 冲突检测（非强制时）
    if (!force && currentExpect && diskHash !== currentExpect.afterHash) {
      skipped.push(entry.path);
      continue;
    }

    const targetIsMissing = entry.afterHash === EMPTY_HASH;
    if (targetIsMissing) {
      if (readContentIfExists(entry.path) !== null) {
        try {
          fs.unlinkSync(entry.path);
          deleted++;
        } catch (err) {
          logger.warn("切换分支删除文件失败", entry.path, err);
          skipped.push(entry.path);
        }
      }
      continue;
    }

    let snapshot: string | null;
    try {
      snapshot = snapshotStore.read(entry.afterHash);
    } catch (err) {
      logger.warn("读取 snapshot 失败", entry.afterHash, err);
      skipped.push(entry.path);
      continue;
    }
    if (snapshot === null) {
      missingSnapshot.push(entry.path);
      skipped.push(entry.path);
      continue;
    }

    if (readContentIfExists(entry.path) === snapshot) {
      restored++;
      continue;
    }
    try {
      atomicWriteFile(entry.path, snapshot);
      restored++;
    } catch (err) {
      logger.warn("切换分支写入文件失败", entry.path, err);
      skipped.push(entry.path);
    }
  }

  return { restored, deleted, skipped, missingSnapshot };
}

/** 节点状态字符串摘要，供 UI 徽标展示（相对父节点的变更计数）。 */
export function nodeSummary(entry: QueueEntry | undefined): string {
  if (!entry || !entry.changes || entry.changes.length === 0) return "";
  const add = entry.changes.filter((c) => c.action === "create" || c.action === "write").length;
  const del = entry.changes.filter((c) => c.action === "delete").length;
  return add > 0 && del > 0 ? `+${add} −${del}` : add > 0 ? `+${add}` : del > 0 ? `−${del}` : "";
}