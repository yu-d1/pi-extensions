import * as fs from "node:fs";
import * as path from "node:path";
import { EMPTY_HASH, TURN_0_TEXT } from "../constants";
import type { FileChange, Logger, QueueData, QueueEntry, RollbackPlan, RollbackResult } from "../types";
import { ensureDir } from "../utils/fs";
import { sanitizeSessionId, workspaceId } from "../storage/layout";
import { ConfigStore } from "../storage/config-store";
import { GcService } from "../storage/gc";
import { QueueStore } from "../storage/queue-store";
import { SnapshotStore } from "../storage/snapshot-store";
import { currentAssistantText, currentUserMessage, parentUserMessageId } from "../utils/messages";
import { isInsideWorkspace, normalizeWorkspace, samePath } from "../utils/path";
import { ChangeTracker } from "./change-tracker";
import { applyRollback, buildRollbackPlan, truncateQueueAfterRollback } from "./rollback";
import { applyNodeState, buildUserParentMap, previewNodeSwitch, type NodeMode } from "./tree";

export interface RollbackExecution {
  queue: QueueData;
  targetEntry: QueueEntry;
  plan: RollbackPlan;
  result: RollbackResult;
}

export interface NodeSwitchExecution {
  queue: QueueData;
  targetEntry: QueueEntry;
  preview: ReturnType<typeof previewNodeSwitch>;
  result: ReturnType<typeof applyNodeState>;
  mode: NodeMode;
}

export class SessionQueueService {
  private activeWorkspace: string | null = null;
  private sessionId: string | null = null;
  private sessionCwd = process.cwd();
  private followSessionTree: boolean;

  private readonly changeTracker = new ChangeTracker();
  private lastFlushedUserMsgId: string | null = null;
  /** user 消息 id → 父 user 消息 id（session 树拓扑，用于持久化 parentEntryId） */
  private userParentMap = new Map<string, string | null>();
  /** 最近一次切换/导航应用的语义（before = 操作前，after = 操作后） */
  private lastAppliedMode: NodeMode | null = null;

  private processing = false;
  // 并发边界：本地单项目使用，保持简单锁；turn_end 与回滚冲突时直接跳过。

  constructor(
    private readonly configStore: ConfigStore,
    private readonly queueStore: QueueStore,
    private readonly snapshotStore: SnapshotStore,
    private readonly gcService: GcService,
    private readonly logger: Logger,
  ) {
    this.followSessionTree = this.configStore.load().followSessionTree;
  }

  get active(): string | null {
    return this.activeWorkspace;
  }

  get session(): string | null {
    return this.sessionId;
  }

  get busy(): boolean {
    return this.processing;
  }

  /** 最近一次切换/导航应用的语义（before=操作前 / after=操作后 / null=未切换过）。 */
  get appliedMode(): NodeMode | null {
    return this.lastAppliedMode;
  }

  // ---------------------------------------------------------------------
  // Session 生命周期
  // ---------------------------------------------------------------------

  startSession(ctx: any): void {
    // 新 session 必须完整重置，防止上一个工作区状态泄漏到当前 session。
    this.activeWorkspace = null;
    this.sessionId = null;
    this.lastFlushedUserMsgId = null;
    this.lastAppliedMode = null;
    this.changeTracker.reset();

    this.sessionCwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();

    // 捕获会话树的 user 拓扑，供 ensureParentIds 持久化树形队列。
    try {
      this.userParentMap = buildUserParentMap(ctx.sessionManager?.getEntries?.() ?? []);
    } catch {
      this.userParentMap = new Map();
    }

    const rawSession = (() => {
      try {
        return ctx.sessionManager.getSessionFile() as string | null | undefined;
      } catch {
        return null;
      }
    })();
    this.sessionId = rawSession ? sanitizeSessionId(rawSession) : null;

    // 每次 session 启动重新读取配置，修复“重启后 followSessionTree 不生效”。
    this.followSessionTree = this.configStore.load().followSessionTree;

    const enabled = this.findEnabledWorkspace(this.sessionCwd);
    if (enabled) {
      this.activeWorkspace = enabled;
      this.changeTracker.start(enabled, this.sessionCwd);
    }
  }

  endSession(): void {
    this.activeWorkspace = null;
    this.sessionId = null;
    this.lastFlushedUserMsgId = null;
    this.lastAppliedMode = null;
    this.changeTracker.reset();
  }

  // ---------------------------------------------------------------------
  // 工具拦截
  // ---------------------------------------------------------------------

  handleToolCall(event: { toolName: string; input: Record<string, unknown> }): void {
    if (!this.activeWorkspace) return;
    if (event.toolName === "bash") {
      this.changeTracker.onBashToolCall(event.input);
      return;
    }
    this.changeTracker.onWriteToolCall(event.toolName, event.input);
  }

  handleToolResult(event: { toolName: string; input: Record<string, unknown> }): void {
    if (!this.activeWorkspace) return;
    if (event.toolName === "bash") {
      this.changeTracker.onBashToolResult();
      return;
    }
    this.changeTracker.onWriteToolResult(event.toolName, event.input);
  }

  // ---------------------------------------------------------------------
  // Turn 持久化
  // ---------------------------------------------------------------------

  flushTurn(ctx: any): boolean {
    if (!this.activeWorkspace || !this.sessionId) return false;
    // 本地单项目使用：并发冲突直接跳过，不做延迟队列。
    if (this.processing) return false;

    this.processing = true;
    try {
      return this.flushTurnUnlocked(ctx);
    } catch (err) {
      this.logger.error("turn_end 持久化失败", err);
      throw err;
    } finally {
      this.processing = false;
    }
  }

  private flushTurnUnlocked(ctx: any): boolean {
    const workspace = this.activeWorkspace!;
    const sessionId = this.sessionId!;

    const queue = this.queueStore.load(workspace, sessionId);

    // Turn 0 初始化。
    if (queue.entries.length === 0) {
      queue.entries.push({
        turnIndex: 0,
        text: TURN_0_TEXT,
        timestamp: new Date().toISOString(),
        changes: [],
      });
      queue.currentIndex = 0;
    }

    const collected = this.changeTracker.collect();
    const aggregated: FileChange[] = [];
    for (const change of collected) {
      this.writeSnapshotSafely(change.beforeHash, change.beforeContent);
      this.writeSnapshotSafely(change.afterHash, change.afterContent);
      aggregated.push({
        path: change.path,
        action: change.action,
        beforeHash: change.beforeHash,
        afterHash: change.afterHash,
        viaBash: change.viaBash || undefined,
      });
    }

    const user = currentUserMessage(ctx);
    const userText = Array.from(user.text).slice(0, 80).join("");
    const sameQuestion = user.id !== null && user.id === this.lastFlushedUserMsgId;
    const lastEntry = queue.entries[queue.entries.length - 1];

    if (sameQuestion && lastEntry && lastEntry.turnIndex !== 0 && !lastEntry.residual) {
      this.mergeChanges(lastEntry, aggregated);
      const assistant = currentAssistantText(ctx);
      if (assistant) lastEntry.resultText = assistant;
      queue.currentIndex = queue.entries.length - 1;
      this.ensureParentIds(queue);
      this.queueStore.save(workspace, queue);
      return true;
    }

    this.lastFlushedUserMsgId = user.id;

    const entryIndex = queue.entries.length;
    queue.entries.push({
      turnIndex: entryIndex,
      text: userText || `变更 #${entryIndex}`,
      timestamp: new Date().toISOString(),
      changes: aggregated,
      sessionEntryId: user.id ?? undefined,
      parentEntryId: parentUserMessageId(ctx, user.id) ?? undefined,
      resultText: currentAssistantText(ctx) || undefined,
    });
    queue.currentIndex = queue.entries.length - 1;
    this.ensureParentIds(queue);
    this.queueStore.save(workspace, queue);

    this.gcService.maybeGc(false);
    return true;
  }

  private writeSnapshotSafely(hash: string, content: string | null): void {
    try {
      this.snapshotStore.writeIfMissing(hash, content);
    } catch (err) {
      // 快照写失败不能阻止 queue 落盘；回滚时若缺失会明确告警。
      this.logger.warn("写入 snapshot 失败", hash, err);
    }
  }

  private mergeChanges(entry: QueueEntry, incoming: FileChange[]): void {
    for (const change of incoming) {
      const existing = entry.changes.find((c) => samePath(c.path, change.path));
      if (!existing) {
        entry.changes.push(change);
        continue;
      }
      // 同一 user turn 内多次修改同一文件：保留最早 before，更新为最新 after。
      // action 基于合并后的净状态判定（用保留的 beforeHash，而非传入变更的），
      // 避免出现 action=write 但 beforeHash=EMPTY 的矛盾记录。
      existing.afterHash = change.afterHash;
      existing.action = existing.beforeHash === EMPTY_HASH
        ? "create"
        : existing.afterHash === EMPTY_HASH
          ? "delete"
          : "write";
      existing.viaBash = existing.viaBash || change.viaBash;
    }
  }

  // ---------------------------------------------------------------------
  // Session Tree 同步
  // ---------------------------------------------------------------------

  handleSessionTreeNavigation(event: any, ctx: any): void {
    if (event.fromExtension) return;
    if (!this.activeWorkspace || !this.sessionId) return;
    if (!this.followSessionTree) return;
    if (event.newLeafId === event.oldLeafId) return;
    if (this.processing) return;

    try {
      const queue = this.queueStore.load(this.activeWorkspace, this.sessionId);
      if (queue.entries.length === 0) return;

      // 优先直接用 session_tree 的 newLeafId 匹配检查点（树形直连）；
      // 匹配不到再回退到旧的"沿 branch 找最后一条 user 消息"逻辑。
      let idx = -1;
      if (event.newLeafId) {
        idx = queue.entries.findIndex(
          (entry) => entry.sessionEntryId === event.newLeafId && !entry.residual,
        );
      }
      if (idx < 0) {
        const navUserMsgId = this.findNavigationUserMessageId(event, ctx);
        if (!navUserMsgId) return;
        idx = queue.entries.findIndex((entry) => entry.sessionEntryId === navUserMsgId && !entry.residual);
      }
      if (idx < 0 || idx >= queue.entries.length) return;

      // 语义：leaf 是 user 节点 → 停在操作前（before）；leaf 在 user 之后（assistant/edit/工具）→ 操作后（after）。
      const leafIsUser = event.newLeafId ? this.userParentMap.has(event.newLeafId) : false;
      const mode: NodeMode = leafIsUser ? "before" : "after";

      this.processing = true;
      try {
        const execution = this.executeNodeSwitchUnlocked(queue, idx, false, mode);
        this.lastAppliedMode = mode;
        const result = execution.result;
        const parts: string[] = [];
        if (result.restored > 0) parts.push(`还原 ${result.restored}`);
        if (result.deleted > 0) parts.push(`删除 ${result.deleted}`);
        const modeTag = mode === "before" ? "操作前" : "操作后";
        let message = `↩️ Session Tree 导航 → 已切换至「${Array.from(execution.targetEntry.text).slice(0, 30).join("")}」${modeTag}`;
        if (parts.length > 0) message += `：${parts.join("、")}`;
        if (result.skipped.length > 0) message += `，跳过 ${result.skipped.length} 个冲突`;
        if (result.missingSnapshot.length > 0) message += `（${result.missingSnapshot.length} 个快照丢失）`;
        ctx.ui.notify(message, result.skipped.length > 0 || result.missingSnapshot.length > 0 ? "warning" : "info");
      } finally {
        this.processing = false;
      }
    } catch (err) {
      this.logger.warn("Session Tree 导航切换失败", err);
    }
  }

  /**
   * 切换分支/回滚到任意检查点节点（树形语义）：把磁盘状态重放为目标节点的
   * 文件状态，但不截断队列——各分支的记录全部保留，后续可自由切回。
   * mode: before = 操作前状态；after = 操作后状态。
   */
  private executeNodeSwitchUnlocked(
    queue: QueueData,
    targetIdx: number,
    force: boolean,
    mode: NodeMode = "before",
  ): NodeSwitchExecution {
    const workspace = this.activeWorkspace!;
    const targetEntry = queue.entries[targetIdx];
    const preview = previewNodeSwitch(queue, targetIdx, mode);
    const result = applyNodeState(queue, targetIdx, this.snapshotStore, this.logger, force, mode);
    queue.currentIndex = targetIdx;
    this.ensureParentIds(queue);
    this.queueStore.save(workspace, queue);
    this.lastFlushedUserMsgId = null;
    this.lastAppliedMode = mode;
    this.gcService.maybeGc(true);
    return { queue, targetEntry, preview, result, mode };
  }

  /** 供 UI 预览+执行使用：预览切换效果（不落地）。 */
  previewNodeTarget(
    targetIdx: number,
    mode: NodeMode = "before",
  ): { queue: QueueData; preview: ReturnType<typeof previewNodeSwitch> } | null {
    if (!this.activeWorkspace || !this.sessionId) return null;
    const queue = this.loadCurrentQueue();
    if (!queue || targetIdx < 0 || targetIdx >= queue.entries.length) return null;
    return { queue, preview: previewNodeSwitch(queue, targetIdx, mode) };
  }

  /** 执行切换到任意检查点节点（不截断队列）。mode: before=操作前, after=操作后。 */
  switchToNode(targetIdx: number, force = false, mode: NodeMode = "before"): NodeSwitchExecution {
    if (this.processing) throw new Error("operation already in progress");
    if (!this.activeWorkspace || !this.sessionId) throw new Error("无活跃工作区或 session");
    this.processing = true;
    try {
      const queue = this.loadCurrentQueue();
      if (!queue || targetIdx < 0 || targetIdx >= queue.entries.length) {
        throw new Error("目标节点不存在");
      }
      return this.executeNodeSwitchUnlocked(queue, targetIdx, force, mode);
    } finally {
      this.processing = false;
    }
  }

  // ---------------------------------------------------------------------
  // 手动回滚（规划与执行分离，供 UI 先预览确认）
  // ---------------------------------------------------------------------

  loadCurrentQueue(): QueueData | null {
    if (!this.activeWorkspace || !this.sessionId) return null;
    const queue = this.queueStore.load(this.activeWorkspace, this.sessionId);
    // 每次读取都修正树形拓扑（幂等），发现变化立即落盘，保证 UI/切换拿到的都是完整树。
    if (this.ensureParentIds(queue)) {
      this.queueStore.save(this.activeWorkspace, queue);
    }
    return queue;
  }

  planRollback(queue: QueueData, targetIndex: number, force = false): RollbackPlan {
    return buildRollbackPlan(queue, targetIndex, force);
  }

  executeManualRollback(queue: QueueData, targetIndex: number, plan: RollbackPlan): RollbackExecution {
    if (this.processing) throw new Error("rollback already in progress");
    this.processing = true;
    try {
      const workspace = this.activeWorkspace!;
      const targetEntry = queue.entries[targetIndex];
      const result = applyRollback(plan, this.snapshotStore, this.logger);
      const nextQueue = truncateQueueAfterRollback(queue, targetIndex, plan, result);
      this.ensureParentIds(nextQueue);
      this.queueStore.save(workspace, nextQueue);
      this.lastFlushedUserMsgId = null;
      this.gcService.maybeGc(true);
      return { queue: nextQueue, targetEntry, plan, result };
    } finally {
      this.processing = false;
    }
  }

  // ---------------------------------------------------------------------
  // 队列与工作区操作
  // ---------------------------------------------------------------------

  clearCurrentQueue(): void {
    if (!this.activeWorkspace || !this.sessionId) return;
    this.queueStore.clear(this.activeWorkspace, this.sessionId);
    this.lastFlushedUserMsgId = null;
    this.changeTracker.reset();
  }

  findEnabledWorkspace(cwd: string): string | null {
    const config = this.configStore.load();
    const matches = config.workspaces
      .filter((ws) => isInsideWorkspace(cwd, ws))
      .sort((a, b) => b.length - a.length);
    return matches[0] ?? null;
  }

  enableWorkspace(workspace: string, toolCwd?: string): string {
    const resolved = normalizeWorkspace(workspace);
    this.configStore.update((config) => {
      if (!config.workspaces.some((ws) => samePath(ws, resolved))) {
        config.workspaces.push(resolved);
      }
    });
    // 预创建该工作区的数据目录。
    ensureDir(path.join(path.dirname(this.configStore.filePath), "workspaces", workspaceId(resolved)));
    this.activeWorkspace = resolved;
    this.sessionCwd = toolCwd && toolCwd.trim() ? toolCwd : resolved;
    this.changeTracker.start(resolved, this.sessionCwd);
    return resolved;
  }

  pauseWorkspace(): void {
    this.activeWorkspace = null;
    this.changeTracker.reset();
  }

  removeWorkspace(workspace: string): { removed: boolean; clearedData: boolean; wasActive: boolean } {
    const target = this.configStore.load().workspaces.find((ws) => samePath(ws, workspace)) ?? null;
    if (!target) return { removed: false, clearedData: false, wasActive: false };

    const wasActive = this.activeWorkspace !== null && samePath(this.activeWorkspace, target);
    const clearData = this.configStore.load().clearDataOnRemoveWorkspace;

    this.configStore.update((config) => {
      config.workspaces = config.workspaces.filter((ws) => !samePath(ws, target));
    });

    if (wasActive) {
      this.activeWorkspace = null;
      this.changeTracker.reset();
    }

    if (clearData) {
      // 使用 fs.rmSync 直接删除整个工作区数据目录。
      try {
        fs.rmSync(this.workspaceDataDir(target), { recursive: true, force: true });
      } catch (err) {
        this.logger.warn("删除工作区数据目录失败", target, err);
      }
      this.gcService.maybeGc(true);
      return { removed: true, clearedData: true, wasActive };
    }

    return { removed: true, clearedData: false, wasActive };
  }

  getStatusText(detail?: string): string | undefined {
    if (!this.activeWorkspace) return undefined;
    const base = this.followSessionTree ? `\x1b[32m●\x1b[0m 同步` : `\x1b[36m●\x1b[0m 记录`;
    return detail ? `${base} ${detail}` : base;
  }

  setFollowSessionTree(enabled: boolean): void {
    this.followSessionTree = enabled;
    this.configStore.update((config) => {
      config.followSessionTree = enabled;
    });
  }

  setKeepQueueCount(count: number): void {
    this.configStore.update((config) => {
      config.keepQueueCountPerWorkspace = count;
    });
  }

  setClearDataOnRemoveWorkspace(enabled: boolean): void {
    this.configStore.update((config) => {
      config.clearDataOnRemoveWorkspace = enabled;
    });
  }

  getConfig() {
    return this.configStore.load();
  }

  runGc() {
    return this.gcService.run();
  }

  getQueueCount(workspace: string): number {
    return this.queueStore.countQueueFiles(workspace);
  }

  // ---------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------

  private findNavigationUserMessageId(event: any, ctx: any): string | null {
    try {
      const leafEntry = ctx.sessionManager.getLeafEntry?.();
      const leafId = (leafEntry as any)?.id ?? event.newLeafId ?? null;

      if (leafId != null) {
        const children = (ctx.sessionManager as any).getChildren?.(leafId) ?? [];
        for (const child of children) {
          if (child?.type === "message" && child.message?.role === "user") {
            return child.id ?? null;
          }
        }
      }

      if (leafEntry?.type === "message" && leafEntry.message?.role === "user") {
        return leafEntry.id ?? null;
      }

      const branch = ctx.sessionManager.getBranch();
      if (Array.isArray(branch)) {
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry?.type === "message" && entry.message?.role === "user") {
            return entry.id ?? null;
          }
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * 持久化前修正所有 entry 的 parentEntryId：
   * 优先用 session 树拓扑（userParentMap），匹配不到时回退线性链（旧数据迁移）。
   * 只在能确定父节点时才更新，绝不因映射缺失而清空已有 parentEntryId。
   * 返回是否有变化（供调用方决定是否需要落盘）。
   */
  private ensureParentIds(queue: QueueData): boolean {
    let changed = false;
    let lastId: string | null = null;
    for (const entry of queue.entries) {
      if (entry.residual) continue;
      let expected: string | undefined;
      const parent = entry.sessionEntryId ? this.userParentMap.get(entry.sessionEntryId) ?? null : null;
      if (parent != null) {
        expected = parent ?? undefined;
      } else if (!entry.parentEntryId) {
        expected = lastId ?? undefined;
      }
      if (expected != null && expected !== entry.parentEntryId) {
        entry.parentEntryId = expected;
        changed = true;
      }
      if (entry.sessionEntryId) lastId = entry.sessionEntryId;
    }
    return changed;
  }

  private workspaceDataDir(workspace: string): string {
    return path.join(path.dirname(this.configStore.filePath), "workspaces", workspaceId(workspace));
  }

}
