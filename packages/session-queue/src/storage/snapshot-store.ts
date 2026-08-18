import * as fs from "node:fs";
import { EMPTY_HASH } from "../constants";
import type { Logger } from "../types";
import { atomicWriteFile, pathExists, readContentIfExists, sha256 } from "../utils/fs";
import { StorageLayout } from "./layout";

export class SnapshotStore {
  constructor(
    private readonly layout: StorageLayout,
    private readonly logger: Logger,
  ) {}

  read(hash: string): string | null {
    if (hash === EMPTY_HASH) return null;
    const filePath = this.layout.snapshotPath(hash);
    const content = readContentIfExists(filePath);
    if (content === null) return null;
    if (sha256(content) !== hash) {
      this.logger.warn("snapshot 内容与 hash 不一致", hash);
      return null;
    }
    return content;
  }

  writeIfMissing(hash: string, content: string | null): void {
    if (hash === EMPTY_HASH || content === null) return;
    const filePath = this.layout.snapshotPath(hash);

    if (pathExists(filePath)) {
      // 内容寻址存储应具备自校验能力；文件损坏时立即修复。
      try {
        const existing = readContentIfExists(filePath);
        if (existing !== null && sha256(existing) === hash) return;
      } catch {
        // 读取失败则按缺失处理并重写。
      }
    }

    atomicWriteFile(filePath, content);
  }

  /** 删除所有不在 liveSet 中的 .content 文件。 */
  deleteOrphans(liveSet: ReadonlySet<string>): { scanned: number; deleted: number } {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.layout.snapshotsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { scanned: 0, deleted: 0 };
      throw err;
    }

    let scanned = 0;
    let deleted = 0;
    for (const name of names) {
      if (!name.endsWith(".content")) continue;
      scanned++;
      const hash = name.slice(0, -".content".length);
      if (liveSet.has(hash)) continue;
      try {
        fs.unlinkSync(this.layout.snapshotPath(hash));
        deleted++;
      } catch (err) {
        this.logger.warn("删除孤儿 snapshot 失败", name, err);
      }
    }
    return { scanned, deleted };
  }
}
