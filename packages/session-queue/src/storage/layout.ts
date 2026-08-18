import * as os from "node:os";
import * as path from "node:path";
import { ensureDir } from "../utils/fs";
import { normalizeWorkspace } from "../utils/path";
import { EXTENSION_NAME } from "../constants";

export function defaultExtensionDir(): string {
  const override = process.env.SESSION_QUEUE_DATA_DIR;
  if (override && override.trim()) return path.resolve(override);
  const home = os.homedir();
  if (!home) return path.join(path.parse(process.cwd()).root || ".", ".pi", "agent", "extensions", EXTENSION_NAME);
  return path.join(home, ".pi", "agent", "extensions", EXTENSION_NAME);
}

/** base64url，可读、稳定、无路径分隔符冲突。 */
export function workspaceId(workspace: string): string {
  return Buffer.from(normalizeWorkspace(workspace), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** 与历史版本兼容：session id 先做字符白名单清洗。 */
export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function queueFileStem(sessionId: string): string {
  return sanitizeSessionId(sessionId) || "session";
}

export class StorageLayout {
  readonly rootDir: string;
  readonly workspacesDir: string;
  readonly snapshotsDir: string;
  readonly configFile: string;

  constructor(rootDir = defaultExtensionDir()) {
    this.rootDir = path.resolve(rootDir);
    this.workspacesDir = path.join(this.rootDir, "workspaces");
    this.snapshotsDir = path.join(this.rootDir, "snapshots");
    this.configFile = path.join(this.rootDir, "config.json");
  }

  ensureDirs(): void {
    ensureDir(this.workspacesDir);
    ensureDir(this.snapshotsDir);
  }

  workspaceDir(workspace: string): string {
    return path.join(this.workspacesDir, workspaceId(workspace));
  }

  queueFilePath(workspace: string, sessionId: string): string {
    return path.join(this.workspaceDir(workspace), `queue-${queueFileStem(sessionId)}.json`);
  }

  snapshotPath(hash: string): string {
    return path.join(this.snapshotsDir, `${hash}.content`);
  }
}
