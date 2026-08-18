import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EMPTY_HASH } from "../constants";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function pathExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读取文本文件。
 * - 文件不存在或目标是目录时返回 null；
 * - 其他 IO 错误（权限、磁盘等）向上抛，不再像旧实现那样静默吞掉。
 */
export function readContentIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (isMissingError(err)) return null;
    throw err;
  }
}

export function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
}

/**
 * 原子写入：唯一临时文件 + fsync + rename。
 * 不再使用固定的 `.tmp` 文件，避免并发写入互相覆盖。
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const tmpPath = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );

  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeSync(fd, content, null, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw new Error(`atomic write failed for ${filePath}: ${(err as Error).message}`);
  }
}

/** 把损坏文件移到带时间戳的备份路径，避免后续写入覆盖证据。 */
export function backupFile(filePath: string, reason: string): string | null {
  if (!pathExists(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.${reason}-${stamp}.bak`;
  try {
    fs.renameSync(filePath, backupPath);
    return backupPath;
  } catch (err) {
    // 备份失败时保留原文件，绝不直接覆盖。
    throw new Error(`failed to back up corrupt file ${filePath}: ${(err as Error).message}`);
  }
}

export function sha256(content: string | null): string {
  if (content === null) return EMPTY_HASH;
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}
