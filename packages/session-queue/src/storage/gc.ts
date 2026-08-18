import * as fs from "node:fs";
import * as path from "node:path";
import { GC_THROTTLE_MS } from "../constants";
import type { GcStats, Logger } from "../types";
import { ensureDir } from "../utils/fs";
import { ConfigStore } from "./config-store";
import { StorageLayout } from "./layout";
import { QueueStore, type QueueFileInfo } from "./queue-store";
import { SnapshotStore } from "./snapshot-store";

export class GcService {
  private lastRun = 0;

  constructor(
    private readonly layout: StorageLayout,
    private readonly queueStore: QueueStore,
    private readonly snapshotStore: SnapshotStore,
    private readonly configStore: ConfigStore,
    private readonly logger: Logger,
  ) {}

  maybeGc(force = false): GcStats | null {
    if (!force && Date.now() - this.lastRun < GC_THROTTLE_MS) return null;
    const stats = this.run();
    this.lastRun = Date.now();
    return stats;
  }

  /**
   * 标记-扫描 GC。
   *
   * 与旧实现的关键区别：
   * 1. 先决定每个工作区保留哪些 queue；
   * 2. 只从“保留的 queue”收集 live hash；
   * 3. 再删孤儿 snapshot；
   * 4. 损坏 queue 不参与淘汰，且会让本轮 snapshot 回收保持保守。
   */
  run(): GcStats {
    this.layout.ensureDirs();
    const keepN = this.configStore.load().keepQueueCountPerWorkspace;
    const live = new Set<string>();
    let corruptQueueSkipped = 0;
    let liveSetIncomplete = false;
    let queueKept = 0;
    let queueDeleted = 0;

    const groups = this.groupQueueFilesByWorkspaceDir();


    for (const files of groups.values()) {
      const sorted = files.sort((a, b) => b.mtime - a.mtime);
      const keep = sorted.slice(0, keepN);
      const drop = sorted.slice(keepN);
      queueKept += keep.length;

      for (const file of keep) {
        const ok = this.queueStore.collectLiveHashes(file.fullPath, live);
        if (!ok) {
          corruptQueueSkipped++;
          liveSetIncomplete = true;
          this.logger.warn("GC 跳过损坏的 queue 文件", file.fullPath);
        }
      }

      for (const file of drop) {
        // 损坏文件不删除，避免把唯一历史销毁。
        const valid = this.queueStore.collectLiveHashes(file.fullPath, new Set());
        if (!valid) {
          corruptQueueSkipped++;
          liveSetIncomplete = true;
          this.logger.warn("GC 跳过损坏的待淘汰 queue 文件", file.fullPath);
          continue;
        }
        if (this.queueStore.deleteFile(file.fullPath)) queueDeleted++;
      }
    }

    let snapScanned = 0;
    let snapDeleted = 0;
    if (!liveSetIncomplete) {
      const result = this.snapshotStore.deleteOrphans(live);
      snapScanned = result.scanned;
      snapDeleted = result.deleted;
    } else {
      snapScanned = this.countSnapshotFiles();
      this.logger.warn("存在损坏 queue，本轮跳过 snapshot 孤儿回收");
    }

    return {
      snapDeleted,
      snapScanned,
      live: live.size,
      queueDeleted,
      queueKept,
      corruptQueueSkipped,
    };
  }

  private groupQueueFilesByWorkspaceDir(): Map<string, QueueFileInfo[]> {
    const groups = new Map<string, QueueFileInfo[]>();

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.layout.workspacesDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        ensureDir(this.layout.workspacesDir);
        return groups;
      }
      throw err;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.layout.workspacesDir, entry.name);
      const files = this.queueStore.listQueueFilesInDir(dir);
      if (files.length > 0) groups.set(dir, files);
    }
    return groups;
  }

  private countSnapshotFiles(): number {
    try {
      return fs.readdirSync(this.layout.snapshotsDir).filter((name) => name.endsWith(".content")).length;
    } catch {
      return 0;
    }
  }
}
