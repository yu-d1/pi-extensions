/**
 * 领域类型定义。
 *
 * 所有持久化 schema 与历史版本保持一致（QueueData.version = 1、Config.version = 2），
 * 仅做字段扩展，不做破坏性变更。
 */

export type FileAction = "edit" | "write" | "create" | "delete";

export interface FileChange {
  /** 文件绝对路径（已 resolve） */
  path: string;
  action: FileAction;
  /** sha256；文件不存在时为 EMPTY_HASH */
  beforeHash: string;
  afterHash: string;
  viaBash?: boolean;
  /**
   * 该变更原始所属的 checkpoint turnIndex。
   * 新产生的 residual 变更会带上这个字段，旧数据没有时回退使用所在 entry.turnIndex。
   */
  originalTurnIndex?: number;
}

export interface QueueEntry {
  turnIndex: number;
  text: string;
  timestamp: string;
  changes: FileChange[];
  /** true 表示“上次回滚时被跳过的待重试变更” */
  residual?: boolean;
  /** 对应 session 树中的 user 消息 id（检查点即一个 user 节点） */
  sessionEntryId?: string;
  /** 父 user 节点 id（树拓扑，沿此链合并出节点完整文件状态） */
  parentEntryId?: string;
  /** 可选的分支名/自定义标签 */
  branchLabel?: string;
  resultText?: string;
}

export interface QueueData {
  version: 1;
  sessionId: string;
  entries: QueueEntry[];
  currentIndex: number;
}

export interface Config {
  version: 2;
  workspaces: string[];
  followSessionTree: boolean;
  keepQueueCountPerWorkspace: number;
  clearDataOnRemoveWorkspace: boolean;
}

export interface RollbackChange extends FileChange {
  turnIndex: number;
}

export interface RollbackPlan {
  changes: RollbackChange[];
  conflictPaths: string[];
}

export interface RollbackResult {
  restored: number;
  skipped: string[];
  missingSnapshot: string[];
}

export interface RollbackPreview {
  restore: string[];
  create: string[];
  remove: string[];
}

export interface GcStats {
  snapDeleted: number;
  snapScanned: number;
  live: number;
  queueDeleted: number;
  queueKept: number;
  corruptQueueSkipped: number;
}

export interface ParsedFileOperations {
  rmTargets: string[];
  mvPairs: Array<[string, string]>;
  redirectTargets: string[];
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
