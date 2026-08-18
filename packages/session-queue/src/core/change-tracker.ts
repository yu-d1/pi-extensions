import * as path from "node:path";
import { WRITE_TOOLS } from "../constants";
import type { FileChange } from "../types";
import { isDirectory, readContentIfExists, sha256 } from "../utils/fs";
import { comparablePath, isInsideWorkspace, resolveWorkspacePath } from "../utils/path";
import { expandGlob, parseFileOperations } from "../shell/parser-lite";

export interface CollectedChange {
  path: string;
  action: FileChange["action"];
  beforeContent: string | null;
  afterContent: string | null;
  beforeHash: string;
  afterHash: string;
  viaBash: boolean;
}

interface TrackedFile {
  path: string;
  before: string | null;
  after: string | null;
  afterCaptured: boolean;
  viaBash: boolean;
}

function extractFilePath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const raw = input.path ?? input.filePath ?? input.file_path;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function extractToolCwd(input: Record<string, unknown> | undefined): string | null {
  const cwd = input?.cwd;
  return typeof cwd === "string" && cwd.trim() ? path.resolve(cwd) : null;
}

export class ChangeTracker {
  private activeWorkspace: string | null = null;
  private toolCwd: string | null = null;
  private readonly tracked = new Map<string, TrackedFile>();

  start(workspace: string | null, toolCwd: string): void {
    this.activeWorkspace = workspace;
    this.toolCwd = toolCwd;
    this.tracked.clear();
  }

  reset(): void {
    this.activeWorkspace = null;
    this.toolCwd = null;
    this.tracked.clear();
  }

  /** tool_call：edit/write 执行前拍照。 */
  onWriteToolCall(toolName: string, input: Record<string, unknown>): void {
    if (!this.activeWorkspace || !WRITE_TOOLS.has(toolName)) return;
    const raw = extractFilePath(input);
    if (!raw) return;
    const filePath = resolveWorkspacePath(raw, this.activeWorkspace, extractToolCwd(input) ?? this.toolCwd ?? undefined);
    this.trackBefore(filePath, false);
  }

  /** tool_call：bash 执行前解析 rm/mv/重定向目标并拍照。 */
  onBashToolCall(input: Record<string, unknown>): void {
    if (!this.activeWorkspace) return;
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) return;

    const ops = parseFileOperations(command);
    const baseDir = extractToolCwd(input) ?? this.toolCwd ?? this.activeWorkspace;

    for (const raw of ops.rmTargets) {
      for (const expanded of expandGlob(raw, baseDir)) this.trackBefore(expanded, true);
    }
    for (const [source, dest] of ops.mvPairs) {
      for (const expanded of expandGlob(source, baseDir)) this.trackBefore(expanded, true);
      for (const expanded of expandGlob(dest, baseDir)) this.trackBefore(expanded, true);
    }
    for (const raw of ops.redirectTargets) {
      for (const expanded of expandGlob(raw, baseDir)) this.trackBefore(expanded, true);
    }
  }

  /** tool_result：write/edit 执行后拍照。 */
  onWriteToolResult(toolName: string, input: Record<string, unknown>): void {
    if (!this.activeWorkspace || !WRITE_TOOLS.has(toolName)) return;
    const raw = extractFilePath(input);
    if (!raw) return;
    const filePath = resolveWorkspacePath(raw, this.activeWorkspace, extractToolCwd(input) ?? this.toolCwd ?? undefined);
    const key = comparablePath(filePath);
    const tracked = this.tracked.get(key);
    if (!tracked) return;
    tracked.after = readContentIfExists(filePath);
  }

  /** tool_result：bash 执行后统一拍照。 */
  onBashToolResult(): void {
    if (!this.activeWorkspace) return;
    for (const tracked of this.tracked.values()) {
      if (!tracked.viaBash) continue;
      tracked.after = readContentIfExists(tracked.path);
    }
  }

  /** 生成当前 turn 的 FileChange 列表并清空 JIT 状态。 */
  collect(): CollectedChange[] {
    const result: CollectedChange[] = [];
    for (const tracked of this.tracked.values()) {
      const beforeHash = sha256(tracked.before);
      const afterHash = sha256(tracked.after);
      if (beforeHash === afterHash) continue;

      let action: FileChange["action"];
      if (tracked.before === null) action = "create";
      else if (tracked.after === null) action = "delete";
      else action = "write";

      result.push({
        path: tracked.path,
        action,
        beforeContent: tracked.before,
        afterContent: tracked.after,
        beforeHash,
        afterHash,
        viaBash: tracked.viaBash,
      });
    }
    this.tracked.clear();
    return result;
  }

  private trackBefore(filePath: string, viaBash: boolean): void {
    if (!this.activeWorkspace) return;
    if (!isInsideWorkspace(filePath, this.activeWorkspace)) return;
    if (isDirectory(filePath)) return;

    const key = comparablePath(filePath);
    const existing = this.tracked.get(key);
    if (existing) {
      existing.viaBash = existing.viaBash || viaBash;
      return;
    }
    this.tracked.set(key, {
      path: filePath,
      before: readContentIfExists(filePath),
      after: null,
      afterCaptured: false,
      viaBash,
    });
  }
}
