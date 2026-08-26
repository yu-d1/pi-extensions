import * as fs from "node:fs";
import * as path from "node:path";
import { EMPTY_HASH, QUEUE_DATA_VERSION } from "../constants";
import type { Logger, QueueData } from "../types";
import { atomicWriteFile, backupFile, ensureDir, isFile } from "../utils/fs";
import { StorageLayout } from "./layout";

export interface QueueFileInfo {
  fullPath: string;
  mtime: number;
}

export class QueueStore {
  constructor(
    private readonly layout: StorageLayout,
    private readonly logger: Logger,
  ) {}

  load(workspace: string, sessionId: string): QueueData {
    const filePath = this.findQueueFile(workspace, sessionId);
    if (!filePath) return this.empty(sessionId);

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<QueueData>;
      if (parsed.version !== QUEUE_DATA_VERSION || !Array.isArray(parsed.entries)) {
        throw new Error(`unsupported queue schema in ${filePath}`);
      }
      return {
        version: QUEUE_DATA_VERSION,
        sessionId,
        entries: parsed.entries,
        currentIndex: typeof parsed.currentIndex === "number" ? parsed.currentIndex : -1,
        currentMode: parsed.currentMode === "before" || parsed.currentMode === "after" ? parsed.currentMode : undefined,
      };
    } catch (err) {
      // 损坏文件先备份，避免 flushTurn 用空队列覆盖掉全部历史。
      try {
        const backupPath = backupFile(filePath, "corrupt");
        this.logger.warn("queue 文件损坏，已备份为", backupPath ?? filePath, err);
      } catch (backupErr) {
        this.logger.error("queue 文件损坏且备份失败，拒绝重建空队列", filePath, backupErr);
        throw backupErr;
      }
      return this.empty(sessionId);
    }
  }

  save(workspace: string, data: QueueData): void {
    const dir = this.layout.workspaceDir(workspace);
    ensureDir(dir);

    const normalized: QueueData = {
      version: QUEUE_DATA_VERSION,
      sessionId: data.sessionId,
      entries: data.entries,
      currentIndex: data.currentIndex,
      ...(data.currentMode ? { currentMode: data.currentMode } : {}),
    };
    const primaryPath = this.layout.queueFilePath(workspace, data.sessionId);
    atomicWriteFile(primaryPath, JSON.stringify(normalized, null, 2));
  }

  clear(workspace: string, sessionId: string): void {
    const data = this.load(workspace, sessionId);
    data.entries = [];
    data.currentIndex = -1;
    data.currentMode = undefined;
    this.save(workspace, data);
  }

  deleteFile(filePath: string): boolean {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      this.logger.warn("删除 queue 文件失败", filePath, err);
      return false;
    }
  }

  listQueueFiles(workspace: string): QueueFileInfo[] {
    return this.listQueueFilesInDir(this.layout.workspaceDir(workspace));
  }

  listQueueFilesInDir(dir: string): QueueFileInfo[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.startsWith("queue-") && name.endsWith(".json"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const result: QueueFileInfo[] = [];
    for (const name of names) {
      const fullPath = path.join(dir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(fullPath).mtimeMs;
      } catch {
        mtime = 0;
      }
      result.push({ fullPath, mtime });
    }
    return result;
  }

  countQueueFiles(workspace: string): number {
    return this.listQueueFiles(workspace).length;
  }

  /** 读取 queue 文件中引用的所有 snapshot hash。损坏文件返回 null。 */
  collectLiveHashes(filePath: string, live: Set<string>): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as QueueData;
      if (parsed.version !== QUEUE_DATA_VERSION || !Array.isArray(parsed.entries)) return false;
      for (const entry of parsed.entries) {
        for (const change of entry.changes ?? []) {
          if (change.beforeHash && change.beforeHash !== EMPTY_HASH) {
            live.add(change.beforeHash);
          }
          if (change.afterHash && change.afterHash !== EMPTY_HASH) {
            live.add(change.afterHash);
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private empty(sessionId: string): QueueData {
    return {
      version: QUEUE_DATA_VERSION,
      sessionId,
      entries: [],
      currentIndex: -1,
    };
  }

  private findQueueFile(workspace: string, sessionId: string): string | null {
    const primary = this.layout.queueFilePath(workspace, sessionId);
    return isFile(primary) ? primary : null;
  }
}
