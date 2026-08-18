import * as fs from "node:fs";
import * as path from "node:path";
import { EMPTY_HASH, RESIDUAL_TEXT, TURN_0_TEXT } from "../constants";
import type {
  FileChange,
  Logger,
  QueueData,
  QueueEntry,
  RollbackChange,
  RollbackPlan,
  RollbackPreview,
  RollbackResult,
} from "../types";
import { atomicWriteFile, readContentIfExists, sha256 } from "../utils/fs";
import type { SnapshotStore } from "../storage/snapshot-store";

/**
 * 回滚规划。
 *
 * 语义：
 * - 回滚到 targetIndex = 丢弃 [targetIndex, ...) 的所有普通 entry；
 * - 文件状态取被丢弃变更中“最早”的 beforeHash；
 * - residual entry 是上次跳过的待重试变更，必须参与后续回滚规划。
 */
export function buildRollbackPlan(queue: QueueData, targetIndex: number, force = false): RollbackPlan {
  const discarded = queue.entries.slice(targetIndex).filter((entry) => !entry.residual);
  const residualEntries = queue.entries.filter((entry) => entry.residual);

  const changes: RollbackChange[] = [];

  for (const entry of discarded) {
    for (const change of entry.changes ?? []) {
      changes.push({ ...change, turnIndex: change.originalTurnIndex ?? entry.turnIndex });
    }
  }

  for (const entry of residualEntries) {
    for (const change of entry.changes ?? []) {
      changes.push({ ...change, turnIndex: change.originalTurnIndex ?? entry.turnIndex });
    }
  }

  const sorted = changes.sort((a, b) => a.turnIndex - b.turnIndex);

  const conflictPaths: string[] = [];
  if (!force) {
    const latestAfterByPath = new Map<string, string>();
    for (const change of sorted) {
      latestAfterByPath.set(change.path, change.afterHash);
    }
    for (const [filePath, expectedAfterHash] of latestAfterByPath) {
      const currentHash = sha256(readContentIfExists(filePath));
      if (currentHash !== expectedAfterHash) conflictPaths.push(filePath);
    }
  }

  return { changes: sorted, conflictPaths };
}

export function previewRollback(plan: RollbackPlan, workspace: string): RollbackPreview {
  const finalBeforeByPath = earliestBeforeByPath(plan.changes);

  const restore: string[] = [];
  const create: string[] = [];
  const remove: string[] = [];

  for (const [filePath, beforeHash] of finalBeforeByPath) {
    if (plan.conflictPaths.includes(filePath)) continue;
    const relative = pathRelativeOrSelf(workspace, filePath);
    const currentlyExists = readContentIfExists(filePath) !== null;

    if (beforeHash === EMPTY_HASH) {
      if (currentlyExists) remove.push(relative);
    } else if (!currentlyExists) {
      create.push(relative);
    } else {
      restore.push(relative);
    }
  }

  return { restore, create, remove };
}

export function formatPreview(preview: RollbackPreview): string {
  const lines: string[] = [];
  if (preview.restore.length > 0) lines.push(`  还原（${preview.restore.length}）：${preview.restore.join(", ")}`);
  if (preview.create.length > 0) lines.push(`  新增（${preview.create.length}）：${preview.create.join(", ")}`);
  if (preview.remove.length > 0) lines.push(`  删除（${preview.remove.length}）：${preview.remove.join(", ")}`);
  if (lines.length === 0) lines.push("  （无文件变更）");
  return lines.join("\n");
}

export function applyRollback(
  plan: RollbackPlan,
  snapshotStore: SnapshotStore,
  logger: Logger,
): RollbackResult {
  const finalBeforeByPath = earliestBeforeByPath(plan.changes);
  const skippedSet = new Set<string>();
  const missingSnapshot: string[] = [];
  let restored = 0;

  for (const [filePath, beforeHash] of finalBeforeByPath) {
    if (plan.conflictPaths.includes(filePath)) {
      skippedSet.add(filePath);
      continue;
    }

    // 目标状态为“不存在”。
    if (beforeHash === EMPTY_HASH) {
      let currentlyExists: boolean;
        try {
          currentlyExists = readContentIfExists(filePath) !== null;
        } catch (err) {
          logger.warn("回滚前读取文件状态失败", filePath, err);
          skippedSet.add(filePath);
          continue;
        }
        if (!currentlyExists) {
        restored++;
        continue;
      }
      try {
        unlinkFile(filePath);
        restored++;
      } catch (err) {
        logger.warn("回滚删除文件失败", filePath, err);
        skippedSet.add(filePath);
      }
      continue;
    }

    let snapshot: string | null;
      try {
        snapshot = snapshotStore.read(beforeHash);
      } catch (err) {
        logger.warn("读取 snapshot 失败", beforeHash, err);
        skippedSet.add(filePath);
        continue;
      }
    if (snapshot === null) {
      missingSnapshot.push(filePath);
      skippedSet.add(filePath);
      continue;
    }

    // 已经是目标内容时避免无谓写入。
    try {
      if (readContentIfExists(filePath) === snapshot) {
        restored++;
        continue;
      }
    } catch {
      // 读取失败则继续尝试写入，最终由写入结果决定。
    }

    try {
      atomicWriteFile(filePath, snapshot);
      restored++;
    } catch (err) {
      logger.warn("回滚写入文件失败", filePath, err);
      skippedSet.add(filePath);
    }
  }

  return { restored, skipped: [...skippedSet], missingSnapshot };
}

/**
 * 执行队列截断，并生成新的 residual entry（如有跳过项）。
 * 新 residual 中的每条 change 都带上 originalTurnIndex，后续规划能正确排序。
 */
export function truncateQueueAfterRollback(
  queue: QueueData,
  targetIndex: number,
  plan: RollbackPlan,
  result: RollbackResult,
): QueueData {
  const entries = queue.entries.slice(0, targetIndex);
  const skippedSet = new Set(result.skipped);

    if (skippedSet.size > 0 && entries.length === 0) {
      entries.push({
        turnIndex: 0,
        text: TURN_0_TEXT,
        timestamp: new Date().toISOString(),
        changes: [],
      });
    }

  if (skippedSet.size > 0) {
    const residualChanges = compactResidualChanges(plan, skippedSet);
    if (residualChanges.length > 0) {
      entries.push(createResidualEntry(entries.length, residualChanges));
    }
  }

  return {
    version: queue.version,
    sessionId: queue.sessionId,
    entries,
    currentIndex: entries.length - 1,
  };
}

function compactResidualChanges(plan: RollbackPlan, skippedSet: ReadonlySet<string>): FileChange[] {
  const byPath = new Map<string, RollbackChange[]>();
  for (const change of plan.changes) {
    if (!skippedSet.has(change.path)) continue;
    const group = byPath.get(change.path);
    if (group) group.push(change);
    else byPath.set(change.path, [change]);
  }

  const result: FileChange[] = [];
  for (const group of byPath.values()) {
    const sorted = group.sort((a, b) => a.turnIndex - b.turnIndex);
    const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if (!first || !last) continue;
    result.push({
      path: first.path,
      action: first.action,
      beforeHash: first.beforeHash,
      afterHash: last.afterHash,
      viaBash: sorted.some((change) => change.viaBash) || undefined,
      originalTurnIndex: first.turnIndex,
    });
  }
  return result;
}

function createResidualEntry(turnIndex: number, changes: FileChange[]): QueueEntry {
  return {
    turnIndex,
    text: RESIDUAL_TEXT,
    timestamp: new Date().toISOString(),
    changes,
    residual: true,
  };
}

function earliestBeforeByPath(changes: RollbackChange[]): Map<string, string> {
  const sorted = [...changes].sort((a, b) => a.turnIndex - b.turnIndex);
  const result = new Map<string, string>();
  for (const change of sorted) {
    if (!result.has(change.path)) result.set(change.path, change.beforeHash);
  }
  return result;
}

function unlinkFile(filePath: string): void {
  fs.unlinkSync(filePath);
}

function pathRelativeOrSelf(workspace: string, filePath: string): string {
  return path.relative(workspace, filePath) || filePath;
}
