/**
 * @liziy/session-queue —— pi 的线性队列会话管理 + 文件变更记忆回滚（v2）
 * =============================================================================
 * 把 pi 的会话从「树」改为「队列」：双 Esc 唤起线性列表，回滚直接截断后续记录。
 * 配合 JIT 工具拦截：edit/write/bash 执行前/后拍照存证，记录每个 turn 修改的文件。
 * 回滚时弹窗确认 + 脏检查，自动还原文件内容。
 *
 * 核心特性：
 * - 队列视图：每个 turn 一个检查点（Option C 语义）
 * - 工作区隔离：每个 workspace 独立目录、独立队列配额
 * - JIT 拦截：pi.on("tool_call"/"tool_result") 按需拍照，0 启动开销
 * - 内容寻址：相同内容只存一次（sha256 命名）
 * - 脏检查：回滚前比对当前文件 hash，防止覆盖用户手动修改
 * - 工作区白名单：默认休眠，启用后按目录记录
 * - snapshot GC：标记-扫描回收孤儿快照
 * - bash 追踪：rm/del/mv/重定向 的文件操作（多文件、glob 展开）
 * - 零依赖
 *
 * 存储路径（v2 架构）：
 *   config.json                          全局配置 + 工作区列表
 *   workspaces/{wsId}/queue-{sid}.json   按工作区分目录的队列
 *   workspaces/{wsId}/snapshots/         （预留：未来可改 per-ws）
 *   snapshots/{hash}.content             全局共享内容寻址快照
 *
 * 命令：
 *   /rollback            唤起主菜单（回滚 / 工作区 / 配置 / GC / 设置）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// =============================================================================
// 常量
// =============================================================================

const DEFAULT_KEEP_QUEUE = 10;
const WRITE_TOOLS = new Set(["edit", "write"]);
const EMPTY_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const GC_THROTTLE_MS = 5 * 60 * 1000;

// =============================================================================
// 类型
// =============================================================================

interface FileChange {
  path: string;
  action: "edit" | "write" | "create" | "delete";
  beforeHash: string;
  afterHash: string;
  viaBash?: boolean;
}

interface QueueEntry {
  turnIndex: number;
  text: string;
  timestamp: string;
  changes: FileChange[];
  residual?: boolean;
  sessionEntryId?: string;
  resultText?: string;
}

interface QueueData {
  version: 1;
  sessionId: string;
  entries: QueueEntry[];
  currentIndex: number;
  lastGcAt?: string;
}

interface Config {
  version: 2;
  workspaces: string[];
  followSessionTree: boolean;
  keepQueueCountPerWorkspace: number;
  clearDataOnRemoveWorkspace: boolean;
}

// =============================================================================
// 全局状态（每个 pi 进程内单例）
// =============================================================================

const EXT_DIR = path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi/agent/extensions/session-queue");
const WORKSPACES_DIR = path.join(EXT_DIR, "workspaces");
const SNAPSHOT_DIR = path.join(EXT_DIR, "snapshots");
const CONFIG_FILE = path.join(EXT_DIR, "config.json");

let activeWorkspace: string | null = null;
let currentSessionId: string | null = null;
let turnIndex = 0;
let followSessionTreeEnabled = true;

// JIT 拦截状态：当前 turn 内
const beforeMap = new Map<string, string | null>();
const afterMap = new Map<string, string | null>();
const bashTrackedPaths = new Set<string>();
const turnChanges: FileChange[] = [];

// 锁：防止 turn_end 和回滚并发
let isProcessing = false;

// 上一个已落盘 entry 所属的 user 消息 id
let lastFlushedUserMsgId: string | null = null;

// GC 节流时间戳
let lastGcRun = 0;

// ANSI 转义码
const ANSI = {
  reset: "\x1b[0m",
  cyan:  "\x1b[36m",
  green: "\x1b[32m",
};

function getStatusText(): string | undefined {
  if (!activeWorkspace) return undefined;
  if (followSessionTreeEnabled) return `${ANSI.green}●${ANSI.reset} 同步`;
  return `${ANSI.cyan}●${ANSI.reset} 记录`;
}

// 旧实现兼容：语义化菜单图标统一使用一个空格分隔文字。
function padPrefix(icon: string): string {
  return `${icon} `;
}

// =============================================================================
// 工具：路径与 IO
// =============================================================================

function ensureDirs(): void {
  try {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  } catch {}
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  } catch {}
}

// base64 编码路径作为 wsId（可读、稳定、无冲突）
function workspaceId(ws: string): string {
  return Buffer.from(path.resolve(ws))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function workspaceDir(ws: string): string {
  return path.join(WORKSPACES_DIR, workspaceId(ws));
}

function queueFilePath(ws: string, sessionId: string): string {
  return path.join(workspaceDir(ws), `queue-${sessionId}.json`);
}

// 原子写入
function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function readContentIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function sha256(content: string | null): string {
  if (content === null) return EMPTY_HASH;
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function snapshotPath(hash: string): string {
  return path.join(SNAPSHOT_DIR, `${hash}.content`);
}

function readSnapshot(hash: string): string | null {
  if (hash === EMPTY_HASH) return null;
  return readContentIfExists(snapshotPath(hash));
}

function writeSnapshotIfMissing(hash: string, content: string | null): void {
  if (hash === EMPTY_HASH || content === null) return;
  const p = snapshotPath(hash);
  if (!fs.existsSync(p)) {
    try {
      atomicWriteFile(p, content);
    } catch {}
  }
}

function isInsideWorkspace(targetPath: string, workspace: string): boolean {
  try {
    const target = path.resolve(targetPath);
    const ws = path.resolve(workspace);
    if (target[0] !== ws[0]) return false;
    return target.startsWith(ws + path.sep) || target === ws;
  } catch {
    return false;
  }
}

function expandGlob(pattern: string): string[] {
  if (!pattern.includes("*") && !pattern.includes("?")) return [pattern];
  try {
    const dir = path.dirname(pattern);
    const base = path.basename(pattern);
    const reSrc = "^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
    const re = new RegExp(reSrc);
    const entries = fs.readdirSync(dir);
    return entries.filter((e) => re.test(e)).map((e) => path.join(dir, e));
  } catch {
    return [pattern];
  }
}

// =============================================================================
// 工具：队列与配置 IO（v2：queue 按 ws 分目录，config 走 v2 schema）
// =============================================================================

function loadQueue(ws: string, sessionId: string): QueueData {
  const file = queueFilePath(ws, sessionId);
  try {
    const data = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(data) as QueueData;
    if (parsed.version === 1) return parsed;
  } catch {}
  return {
    version: 1,
    sessionId,
    entries: [],
    currentIndex: -1,
  };
}

function saveQueue(ws: string, data: QueueData): void {
  const file = queueFilePath(ws, data.sessionId);
  try {
    atomicWriteFile(file, JSON.stringify(data, null, 2));
  } catch {}
}

function defaultConfig(): Config {
  return {
    version: 2,
    workspaces: [],
    followSessionTree: true,
    keepQueueCountPerWorkspace: DEFAULT_KEEP_QUEUE,
    clearDataOnRemoveWorkspace: true,
  };
}

function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const cfg = JSON.parse(raw) as Partial<Config>;
    // 字段缺失时用默认值补全
    return {
      version: 2,
      workspaces: Array.isArray(cfg.workspaces) ? cfg.workspaces : [],
      followSessionTree: typeof cfg.followSessionTree === "boolean" ? cfg.followSessionTree : true,
      keepQueueCountPerWorkspace: typeof cfg.keepQueueCountPerWorkspace === "number" && cfg.keepQueueCountPerWorkspace > 0
        ? cfg.keepQueueCountPerWorkspace
        : DEFAULT_KEEP_QUEUE,
      clearDataOnRemoveWorkspace: typeof cfg.clearDataOnRemoveWorkspace === "boolean"
        ? cfg.clearDataOnRemoveWorkspace
        : true,
    };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(config: Config): void {
  try {
    atomicWriteFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch {}
}

function isWorkspaceEnabled(cwd: string): boolean {
  const config = loadConfig();
  return config.workspaces.some((ws) => isInsideWorkspace(cwd, ws));
}

function getKeepCount(): number {
  return loadConfig().keepQueueCountPerWorkspace;
}

function addWorkspace(cwd: string): void {
  const config = loadConfig();
  const resolved = path.resolve(cwd);
  if (!config.workspaces.includes(resolved)) {
    config.workspaces.push(resolved);
    saveConfig(config);
  }
  // 预创建 ws 目录
  try {
    fs.mkdirSync(workspaceDir(resolved), { recursive: true });
  } catch {}
}

// 删除工作区：返回 { removed, clearedData }，由全局配置决定是否清除数据
function removeWorkspace(ws: string): { removed: boolean; clearedData: boolean } {
  const config = loadConfig();
  const resolved = path.resolve(ws);
  if (!config.workspaces.includes(resolved)) {
    return { removed: false, clearedData: false };
  }
  config.workspaces = config.workspaces.filter((w) => w !== resolved);
  saveConfig(config);

  // 根据全局配置决定是否清除数据
  if (config.clearDataOnRemoveWorkspace) {
    const dir = workspaceDir(resolved);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    return { removed: true, clearedData: true };
  }
  return { removed: true, clearedData: false };
}

// =============================================================================
// 工具：从 input 提取文件路径
// =============================================================================

function extractFilePath(input: Record<string, unknown>): string | null {
  const raw = (input.path as string) ?? (input.filePath as string) ?? (input.file_path as string);
  if (!raw || typeof raw !== "string") return null;
  return raw;
}

// =============================================================================
// snapshot GC：标记-扫描回收（v2：按 ws 分桶限额）
// =============================================================================

interface QueueFileInfo {
  wsDir: string;   // wsId 目录名
  name: string;
  fullPath: string;
  mtime: number;
}

function runGc(): { snapDeleted: number; snapScanned: number; live: number; queueDeleted: number; queueKept: number } {
  const liveSet = new Set<string>();
  const keepN = getKeepCount();

  // Phase 1：扫描所有 ws 目录下的 queue 文件，收集 liveSet
  const queueFiles: QueueFileInfo[] = [];
  let workspaceDirs: string[] = [];
  try {
    const entries = fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true });
    workspaceDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    lastGcRun = Date.now();
    return { snapDeleted: 0, snapScanned: 0, live: 0, queueDeleted: 0, queueKept: 0 };
  }

  for (const wsDir of workspaceDirs) {
    const wsPath = path.join(WORKSPACES_DIR, wsDir);
    let qfs: string[] = [];
    try {
      qfs = fs.readdirSync(wsPath).filter((f) => f.startsWith("queue-") && f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const qf of qfs) {
      const fullPath = path.join(wsPath, qf);
      let mtime = 0;
      try { mtime = fs.statSync(fullPath).mtimeMs; } catch { mtime = 0; }
      queueFiles.push({ wsDir, name: qf, fullPath, mtime });
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as QueueData;
        if (data.version !== 1) continue;
        for (const e of data.entries) {
          for (const c of e.changes) {
            if (c.beforeHash && c.beforeHash !== EMPTY_HASH) liveSet.add(c.beforeHash);
            if (c.afterHash && c.afterHash !== EMPTY_HASH) liveSet.add(c.afterHash);
          }
        }
      } catch {}
    }
  }

  // Phase 2：清理孤儿 snapshot（仍全局共享）
  let snapFiles: string[] = [];
  try {
    snapFiles = fs.readdirSync(SNAPSHOT_DIR);
  } catch {}

  let snapDeleted = 0;
  let snapScanned = 0;
  for (const sf of snapFiles) {
    if (!sf.endsWith(".content")) continue;
    snapScanned++;
    const hash = sf.slice(0, -".content".length);
    if (!liveSet.has(hash)) {
      try {
        fs.unlinkSync(path.join(SNAPSHOT_DIR, sf));
        snapDeleted++;
      } catch {}
    }
  }

  // Phase 3：按 ws 分桶，每桶限 keepN（v2 核心）
  const byWs = new Map<string, QueueFileInfo[]>();
  for (const qf of queueFiles) {
    if (!byWs.has(qf.wsDir)) byWs.set(qf.wsDir, []);
    byWs.get(qf.wsDir)!.push(qf);
  }

  let queueDeleted = 0;
  let queueKept = 0;
  for (const [, list] of byWs) {
    list.sort((a, b) => b.mtime - a.mtime);
    const keep = list.slice(0, keepN);
    const drop = list.slice(keepN);
    queueKept += keep.length;
    for (const old of drop) {
      try {
        fs.unlinkSync(old.fullPath);
        queueDeleted++;
      } catch {}
    }
  }

  lastGcRun = Date.now();
  return { snapDeleted, snapScanned, live: liveSet.size, queueDeleted, queueKept };
}

function maybeGc(force = false): void {
  if (!force && Date.now() - lastGcRun < GC_THROTTLE_MS) return;
  try {
    runGc();
  } catch {}
}

// =============================================================================
// 核心：bash 命令文件路径解析
// =============================================================================

function skipWs(cmd: string, i: number): number {
  while (i < cmd.length && /\s/.test(cmd[i])) i++;
  return i;
}

function readToken(cmd: string, i: number): { token: string; next: number } | null {
  i = skipWs(cmd, i);
  if (i >= cmd.length) return null;
  const ch = cmd[i];
  if (ch === ";" || ch === "&" || ch === "|") return null;
  if (ch === '"') {
    i++;
    let s = "";
    while (i < cmd.length && cmd[i] !== '"') {
      if (cmd[i] === "\\" && i + 1 < cmd.length) {
        const nxt = cmd[i + 1];
        if (nxt === '"' || nxt === "\\" || nxt === "$" || nxt === "`") {
          s += nxt;
          i += 2;
        } else {
          s += "\\";
          i++;
        }
      } else {
        s += cmd[i];
        i++;
      }
    }
    i++;
    return { token: s, next: i };
  }
  if (ch === "'") {
    i++;
    let s = "";
    while (i < cmd.length && cmd[i] !== "'") {
      s += cmd[i];
      i++;
    }
    i++;
    return { token: s, next: i };
  }
  let s = "";
  while (i < cmd.length && !/\s/.test(cmd[i]) && cmd[i] !== ";" && cmd[i] !== "&" && cmd[i] !== "|") {
    s += cmd[i];
    i++;
  }
  return { token: s, next: i };
}

function isFlag(tok: string): boolean {
  return tok.startsWith("-") && tok.length > 1 && !tok.startsWith("--") || tok.startsWith("--");
}

function parseRmTargets(cmd: string): string[] {
  const targets: string[] = [];
  const re = /\b(rm|del)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    let i = m.index + m[1].length;
    while (true) {
      const r = readToken(cmd, i);
      if (!r) break;
      i = r.next;
      if (isFlag(r.token)) continue;
      if (r.token) targets.push(r.token);
    }
  }
  return targets;
}

function parseMvPairs(cmd: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re = /\bmv\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    let i = m.index + m[1].length;
    const args: string[] = [];
    while (args.length < 2) {
      const r = readToken(cmd, i);
      if (!r) break;
      i = r.next;
      if (isFlag(r.token)) continue;
      args.push(r.token);
    }
    if (args.length === 2) pairs.push([args[0], args[1]]);
  }
  return pairs;
}

function parseRedirectTargets(cmd: string): string[] {
  const targets: string[] = [];
  const re = />>?\s*("[^"]*"|'[^']*'|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    let t = m[1];
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1);
    }
    if (t) targets.push(t);
  }
  return targets;
}

// =============================================================================
// 核心：JIT 工具拦截
// =============================================================================

function trackPathBefore(filePath: string, viaBash: boolean): void {
  if (!isInsideWorkspace(filePath, activeWorkspace!)) return;
  if (isDirectory(filePath)) return;
  if (!beforeMap.has(filePath)) {
    beforeMap.set(filePath, readContentIfExists(filePath));
  }
  if (viaBash) bashTrackedPaths.add(filePath);
}

function onToolCall(event: { toolName: string; input: Record<string, unknown> }): void {
  if (!activeWorkspace) return;

  if (WRITE_TOOLS.has(event.toolName)) {
    const raw = extractFilePath(event.input);
    if (!raw) return;
    trackPathBefore(path.resolve(raw), false);
    return;
  }

  if (event.toolName === "bash") {
    const cmd = ((event.input as any).command || "").trim();
    if (!cmd) return;

    for (const raw of parseRmTargets(cmd)) {
      for (const expanded of expandGlob(raw)) {
        trackPathBefore(path.resolve(expanded), true);
      }
    }
    for (const [oldRaw, newRaw] of parseMvPairs(cmd)) {
      for (const expanded of expandGlob(oldRaw)) {
        trackPathBefore(path.resolve(expanded), true);
      }
      for (const expanded of expandGlob(newRaw)) {
        trackPathBefore(path.resolve(expanded), true);
      }
    }
    for (const raw of parseRedirectTargets(cmd)) {
      for (const expanded of expandGlob(raw)) {
        trackPathBefore(path.resolve(expanded), true);
      }
    }
  }
}

function onToolResult(event: { toolName: string; input: Record<string, unknown> }): void {
  if (!activeWorkspace) return;

  if (WRITE_TOOLS.has(event.toolName)) {
    const raw = extractFilePath(event.input);
    if (!raw) return;
    const filePath = path.resolve(raw);
    if (!isInsideWorkspace(filePath, activeWorkspace)) return;
    if (!beforeMap.has(filePath)) return;
    afterMap.set(filePath, readContentIfExists(filePath));
    return;
  }

  if (event.toolName === "bash") {
    for (const filePath of bashTrackedPaths) {
      if (!beforeMap.has(filePath)) continue;
      afterMap.set(filePath, readContentIfExists(filePath));
    }
  }
}

// =============================================================================
// 核心：turn_end 持久化
// =============================================================================

function currentUserMessage(ctx: any): { id: string | null; text: string } {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e.type === "message" && e.message.role === "user") {
        const m = e.message as any;
        let text = "";
        if (typeof m.content === "string") text = m.content;
        else if (Array.isArray(m.content))
          text = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
        return { id: e.id ?? null, text };
      }
    }
  } catch {}
  return { id: null, text: "" };
}

function currentAssistantText(ctx: any): string {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e.type === "message" && e.message?.role === "assistant") {
        const m = e.message as any;
        let text = "";
        if (typeof m.content === "string") text = m.content;
        else if (Array.isArray(m.content))
          text = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
        return text.slice(0, 80) || "";
      }
    }
  } catch {}
  return "";
}

function flushTurn(ctx: any): void {
  if (isProcessing) return;
  isProcessing = true;
  try {
    if (!currentSessionId || !activeWorkspace) return;

    const queue = loadQueue(activeWorkspace, currentSessionId);

    // Session Tree 同步检测
    const canSync =
      activeWorkspace !== null && followSessionTreeEnabled &&
      currentUserMessage(ctx).id !== lastFlushedUserMsgId;
    if (canSync) {
      const navIdx = detectSessionTreeNav(ctx, queue);
      if (navIdx !== null) {
        autoRollbackForSessionTree(ctx, queue, navIdx);
      }
    }

    // Turn 0 初始化
    if (queue.entries.length === 0) {
      queue.entries.push({
        turnIndex: 0,
        text: "（会话起点）",
        timestamp: new Date().toISOString(),
        changes: [],
      });
      queue.currentIndex = 0;
    }

    // 从 beforeMap + afterMap 生成 changes
    const aggregated: FileChange[] = [];
    for (const [filePath, before] of beforeMap) {
      const after = afterMap.has(filePath) ? afterMap.get(filePath)! : readContentIfExists(filePath);
      const beforeHash = sha256(before);
      const afterHash = sha256(after);
      if (beforeHash === afterHash) continue;

      writeSnapshotIfMissing(beforeHash, before);
      writeSnapshotIfMissing(afterHash, after);

      let action: FileChange["action"];
      if (before === null) action = "create";
      else if (after === null) action = "delete";
      else action = "write";

      aggregated.push({
        path: filePath,
        action,
        beforeHash,
        afterHash,
        viaBash: bashTrackedPaths.has(filePath) || undefined,
      });
    }

    beforeMap.clear();
    afterMap.clear();
    bashTrackedPaths.clear();

    const curUser = currentUserMessage(ctx);
    const currentText = curUser.text.slice(0, 80) || "";
    const curUserMsgId = curUser.id;
    const lastEntry = queue.entries[queue.entries.length - 1];

    const sameQuestion =
      curUserMsgId !== null &&
      curUserMsgId === lastFlushedUserMsgId;
    if (
      sameQuestion &&
      lastEntry &&
      lastEntry.turnIndex !== 0 &&
      !lastEntry.residual
    ) {
      for (const nc of aggregated) lastEntry.changes.push(nc);
      const at = currentAssistantText(ctx);
      if (at) lastEntry.resultText = at;
      queue.currentIndex = queue.entries.length - 1;
      saveQueue(activeWorkspace, queue);
      turnIndex++;
      return;
    }

    lastFlushedUserMsgId = curUserMsgId;

    const entryIdx = queue.entries.length;
    const newEntry: QueueEntry = {
      turnIndex: entryIdx,
      text: currentText || `变更 #${entryIdx}`,
      timestamp: new Date().toISOString(),
      changes: aggregated,
      sessionEntryId: curUserMsgId ?? undefined,
      resultText: currentAssistantText(ctx) || undefined,
    };
    queue.entries.push(newEntry);
    queue.currentIndex = queue.entries.length - 1;

    // 注：queue 文件不再这里做窗口截断，由 GC 统一管理
    saveQueue(activeWorkspace, queue);
    turnIndex++;

    maybeGc();
  } finally {
    isProcessing = false;
  }
}

// =============================================================================
// 核心：回滚算法
// =============================================================================

interface RollbackChange {
  path: string;
  beforeHash: string;
  afterHash: string;
  action: FileChange["action"];
  turnIndex: number;
  viaBash?: boolean;
}

interface RollbackPlan {
  changes: RollbackChange[];
  conflictPaths: string[];
}

function planRollback(queue: QueueData, targetIndex: number, force = false): RollbackPlan {
  const discarded = queue.entries.slice(targetIndex).filter((e) => !e.residual);
  const changes: RollbackChange[] = [];
  for (const entry of discarded) {
    for (const c of entry.changes) {
      changes.push({ ...c, turnIndex: entry.turnIndex });
    }
  }

  const conflictPaths: string[] = [];
  if (!force) {
    const latestAfterByPath = new Map<string, string>();
    const sortedAsc = [...changes].sort((a, b) => a.turnIndex - b.turnIndex);
    for (const c of sortedAsc) {
      latestAfterByPath.set(c.path, c.afterHash);
    }
    for (const [filePath, expectedAfterHash] of latestAfterByPath) {
      const current = readContentIfExists(filePath);
      const currentHash = sha256(current);
      if (currentHash !== expectedAfterHash) {
        conflictPaths.push(filePath);
      }
    }
  }
  return { changes, conflictPaths };
}

function applyRollback(plan: RollbackPlan): { restored: number; skipped: string[]; missingSnapshot: string[] } {
  const skipped: string[] = [];
  const missingSnapshot: string[] = [];

  const sortedAsc = [...plan.changes].sort((a, b) => a.turnIndex - b.turnIndex);
  const finalBeforeByPath = new Map<string, string>();
  for (const c of sortedAsc) {
    if (!finalBeforeByPath.has(c.path)) {
      finalBeforeByPath.set(c.path, c.beforeHash);
    }
  }

  for (const [filePath, beforeHash] of finalBeforeByPath) {
    if (plan.conflictPaths.includes(filePath)) {
      skipped.push(filePath);
      continue;
    }
    if (beforeHash === EMPTY_HASH) {
      try { fs.unlinkSync(filePath); } catch {}
      continue;
    }
    const content = readSnapshot(beforeHash);
    if (content === null) {
      missingSnapshot.push(filePath);
      skipped.push(filePath);
      continue;
    }
    try {
      atomicWriteFile(filePath, content);
    } catch {
      skipped.push(filePath);
    }
  }

  return { restored: finalBeforeByPath.size - skipped.length, skipped, missingSnapshot };
}

interface RollbackPreview {
  restore: string[];
  create: string[];
  remove: string[];
}

function previewRollback(plan: RollbackPlan, workspace: string): RollbackPreview {
  const sortedAsc = [...plan.changes].sort((a, b) => a.turnIndex - b.turnIndex);
  const finalBeforeByPath = new Map<string, string>();
  for (const c of sortedAsc) {
    if (!finalBeforeByPath.has(c.path)) finalBeforeByPath.set(c.path, c.beforeHash);
  }

  const restore: string[] = [];
  const create: string[] = [];
  const remove: string[] = [];
  for (const [filePath, beforeHash] of finalBeforeByPath) {
    if (plan.conflictPaths.includes(filePath)) continue;
    const rel = path.relative(workspace, filePath) || filePath;
    const currentlyExists = readContentIfExists(filePath) !== null;
    if (beforeHash === EMPTY_HASH) {
      remove.push(rel);
    } else if (!currentlyExists) {
      create.push(rel);
    } else {
      restore.push(rel);
    }
  }
  return { restore, create, remove };
}

function formatPreview(preview: RollbackPreview): string {
  const lines: string[] = [];
  if (preview.restore.length > 0) lines.push(`  还原（${preview.restore.length}）：${preview.restore.join(", ")}`);
  if (preview.create.length > 0) lines.push(`  新增（${preview.create.length}）：${preview.create.join(", ")}`);
  if (preview.remove.length > 0) lines.push(`  删除（${preview.remove.length}）：${preview.remove.join(", ")}`);
  if (lines.length === 0) lines.push("  （无文件变更）");
  return lines.join("\n");
}

// =============================================================================
// Session Tree 同步
// =============================================================================

function detectSessionTreeNav(ctx: any, queue: QueueData): number | null {
  if (queue.entries.length < 2) return null;
  if (queue.currentIndex < 1) return null;
  try {
    const branch = ctx.sessionManager.getBranch();
    if (!Array.isArray(branch)) return null;
    const userMsgIds: string[] = [];
    for (const e of branch) {
      if (e.type === "message" && e.message?.role === "user") {
        userMsgIds.push(e.id ?? "");
      }
    }
    if (userMsgIds.length < 2) return null;
    const prevUserMsgId = userMsgIds[userMsgIds.length - 2];
    if (!prevUserMsgId) return null;
    const idx = queue.entries.findIndex((ent) => ent.sessionEntryId === prevUserMsgId);
    if (idx >= 0 && idx < queue.currentIndex) return idx;
    return null;
  } catch {}
  return null;
}

function autoRollbackForSessionTree(ctx: any, queue: QueueData, targetIdx: number): void {
  if (!activeWorkspace) return;
  if (targetIdx < 0 || targetIdx >= queue.entries.length) return;
  const targetEntry = queue.entries[targetIdx];

  const plan = planRollback(queue, targetIdx, true);
  const result = applyRollback(plan);
  const skippedSet = new Set(result.skipped);

  queue.entries = queue.entries.slice(0, targetIdx);

  if (result.skipped.length > 0) {
    const residualChanges: FileChange[] = plan.changes
      .filter((c) => skippedSet.has(c.path))
      .map((c) => ({
        path: c.path,
        action: c.action,
        beforeHash: c.beforeHash,
        afterHash: c.afterHash,
        viaBash: c.viaBash,
      }));
    if (residualChanges.length > 0) {
      const resIdx = queue.entries.length;
      queue.entries.push({
        turnIndex: resIdx,
        text: "（未回滚残留）",
        timestamp: new Date().toISOString(),
        changes: residualChanges,
        residual: true,
      });
      queue.currentIndex = resIdx;
    } else {
      queue.currentIndex = queue.entries.length - 1;
    }
  } else {
    queue.currentIndex = queue.entries.length - 1;
  }

  saveQueue(activeWorkspace, queue);
  lastFlushedUserMsgId = null;
  turnIndex = targetEntry.turnIndex;

  maybeGc(true);

  const parts: string[] = [];
  if (result.restored > 0) parts.push(`还原 ${result.restored}`);
  let msg = `↩️ Session Tree 导航 → 自动回滚到「${targetEntry.text.slice(0, 30)}」`;
  if (parts.length > 0) msg += `：${parts.join("、")}`;
  if (result.skipped.length > 0) msg += `，跳过 ${result.skipped.length} 个冲突`;
  ctx.ui.notify(msg, result.skipped.length > 0 ? "warning" : "info");
}

// =============================================================================
// TUI 组件：回滚选择器
// =============================================================================

interface QueueItem {
  entry: QueueEntry;
  isCurrent: boolean;
}

function buildQueueItems(queue: QueueData): QueueItem[] {
  return queue.entries.map((e) => ({ entry: e, isCurrent: false }));
}

async function showRollbackUI(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("rollback 需要交互模式", "error");
    return;
  }
  if (!currentSessionId) {
    ctx.ui.notify("无活跃 session", "error");
    return;
  }
  if (!activeWorkspace) {
    ctx.ui.notify("当前工作区未启用，无法回滚", "error");
    return;
  }
  if (isProcessing) {
    ctx.ui.notify("正在处理上一轮，请稍候", "warning");
    return;
  }

  const queue = loadQueue(activeWorkspace, currentSessionId);
  if (queue.entries.length === 0) {
    ctx.ui.notify("队列为空", "info");
    return;
  }
  if (queue.entries.length === 1) {
    ctx.ui.notify("只有 Turn 0，没有可回滚的记录", "info");
    return;
  }

  const allItems = buildQueueItems(queue);
  const phantomCurrent: QueueItem = {
    entry: {
      turnIndex: queue.entries.length,
      text: "当前状态",
      timestamp: new Date().toISOString(),
      changes: [],
    },
    isCurrent: true,
  };
  const checkpoints = allItems.filter(
    (it) => !it.entry.residual && !(it.entry.turnIndex === 0 && it.entry.text === "（会话起点）"),
  );
  if (checkpoints.length === 0) {
    ctx.ui.notify("没有可回滚的检查点", "info");
    return;
  }
  const orderedDisplay: QueueItem[] = [phantomCurrent, ...[...checkpoints].reverse()];

  const selectOptions = orderedDisplay.map((item) => {
    const bashTag = item.entry.changes.some((c) => c.viaBash) ? "  ⚠bash" : "";
    const curTag = item.isCurrent ? "  ← 当前节点" : "";
    const label = item.isCurrent ? "当前状态" : item.entry.text;
    return `${label}${bashTag}${curTag}`;
  });

  let targetEntry: QueueEntry | null = null;
  while (targetEntry === null) {
    const choice = await ctx.ui.select(
      `回滚到哪个检查点？(${checkpoints.length} 个检查点 + 当前状态)`,
      selectOptions,
    );
    if (!choice) return;
    const choiceIdx = selectOptions.indexOf(choice);
    if (choiceIdx < 0) return;
    const picked = orderedDisplay[choiceIdx];
    if (picked.isCurrent) {
      ctx.ui.notify("当前节点不可回滚，请选其他 turn", "info");
      continue;
    }
    targetEntry = picked.entry;
  }

  const targetArrIdx = queue.entries.findIndex((e) => e.turnIndex === targetEntry!.turnIndex);
  if (targetArrIdx < 0) return;

  const plan = planRollback(queue, targetArrIdx);
  if (plan.changes.length === 0) {
    queue.entries = queue.entries.slice(0, targetArrIdx);
    queue.currentIndex = queue.entries.length - 1;
    saveQueue(activeWorkspace, queue);
    maybeGc();
    lastFlushedUserMsgId = null;
    ctx.ui.notify(`已回滚到「${targetEntry.text.slice(0, 30)}」`, "info");
    return;
  }

  const preview = previewRollback(plan, activeWorkspace);
  let confirmTitle =
    `确认回滚到「${targetEntry.text.slice(0, 30)}」？\n` +
    `将处理 ${plan.changes.length} 个文件变更：\n` +
    formatPreview(preview);
  const hasConflict = plan.conflictPaths.length > 0;
  let confirmButtons: string[];
  if (hasConflict) {
    const conflictList = plan.conflictPaths
      .map((p) => "  ⚠ " + path.relative(activeWorkspace, p))
      .join("\n");
    confirmTitle += `\n⚠ ${plan.conflictPaths.length} 个文件被外部修改：\n` + conflictList;
    confirmButtons = [padPrefix("🛡️") + "强制覆盖并回滚", padPrefix("⏭️") + "跳过冲突，回滚其他", padPrefix("🚫") + "取消"];
  } else {
    confirmButtons = [padPrefix("🛡️") + "确定回滚", padPrefix("🚫") + "取消"];
  }

  const confirm = await ctx.ui.select(confirmTitle, confirmButtons);
  if (!confirm || confirm.startsWith("🚫")) return;
  if (hasConflict && confirm.includes("强制")) {
    plan.conflictPaths = [];
  }

  isProcessing = true;
  try {
    const result = applyRollback(plan);
    const skippedSet = new Set(result.skipped);

    queue.entries = queue.entries.slice(0, targetArrIdx);

    if (result.skipped.length > 0) {
      const residualChanges: FileChange[] = plan.changes
        .filter((c) => skippedSet.has(c.path))
        .map((c) => ({
          path: c.path,
          action: c.action,
          beforeHash: c.beforeHash,
          afterHash: c.afterHash,
          viaBash: c.viaBash,
        }));
      if (residualChanges.length > 0) {
        const resIdx = queue.entries.length;
        queue.entries.push({
          turnIndex: resIdx,
          text: "（未回滚残留）",
          timestamp: new Date().toISOString(),
          changes: residualChanges,
          residual: true,
        });
        queue.currentIndex = resIdx;
      } else {
        queue.currentIndex = queue.entries.length - 1;
      }
    } else {
      queue.currentIndex = queue.entries.length - 1;
    }

    saveQueue(activeWorkspace, queue);
    turnIndex = targetEntry.turnIndex;
    lastFlushedUserMsgId = null;

    maybeGc(true);

    const parts: string[] = [];
    if (preview.restore.length > 0) parts.push(`还原 ${preview.restore.length}`);
    if (preview.create.length > 0) parts.push(`新增 ${preview.create.length}`);
    if (preview.remove.length > 0) parts.push(`删除 ${preview.remove.length}`);
    let msg = `已回滚到「${targetEntry.text.slice(0, 30)}」：${parts.join("、") || "无变更"}`;
    if (result.skipped.length > 0) msg += `，跳过 ${result.skipped.length} 个`;
    if (result.missingSnapshot.length > 0) msg += `（其中 ${result.missingSnapshot.length} 个快照丢失，请手动检查）`;
    ctx.ui.notify(msg, result.missingSnapshot.length > 0 ? "warning" : "success");
  } finally {
    isProcessing = false;
  }
}

// =============================================================================
// TUI 组件：全局配置
// =============================================================================

async function showGlobalConfigUI(ctx: any): Promise<void> {
  while (true) {
    const cfg = loadConfig();
    const opts = [
      padPrefix("🔢") + `每工作区保留队列数: ${cfg.keepQueueCountPerWorkspace}`,
      "🗑️  删除工作区时清除数据: " + (cfg.clearDataOnRemoveWorkspace ? "是" : "否"),
      padPrefix("🌳") + `跟随 Session Tree: ${cfg.followSessionTree ? "开" : "关"}`,
      padPrefix("🔙") + "返回",
    ];
    const c = await ctx.ui.select("全局配置", opts);
    if (!c || c.startsWith("🔙")) return;

    if (c.startsWith("🔢")) {
      const presets = ["5", "10", "20", "50"];
      const p = await ctx.ui.select("选择每工作区保留的队列数（当前：" + cfg.keepQueueCountPerWorkspace + "）", presets);
      if (p) {
        cfg.keepQueueCountPerWorkspace = parseInt(p, 10);
        saveConfig(cfg);
        ctx.ui.notify(`✅ 已设置每工作区保留 ${p} 个队列`, "success");
      }
    } else if (c.startsWith("🗑️")) {
      cfg.clearDataOnRemoveWorkspace = !cfg.clearDataOnRemoveWorkspace;
      saveConfig(cfg);
      ctx.ui.notify(
        cfg.clearDataOnRemoveWorkspace
          ? "✅ 删除工作区时将清除数据"
          : "✅ 删除工作区时保留数据（仅从列表移除）",
        "info",
      );
    } else if (c.startsWith("🌳")) {
      cfg.followSessionTree = !cfg.followSessionTree;
      saveConfig(cfg);
      followSessionTreeEnabled = cfg.followSessionTree;
      ctx.ui.notify(
        cfg.followSessionTree ? "🔗 已开启：Session Tree 导航将自动回滚队列" : "⏸ 已关闭：Session Tree 导航不会自动回滚队列",
        "info",
      );
      // 同步状态栏
      ctx.ui.setStatus("session-queue", getStatusText());
    }
  }
}

// =============================================================================
// TUI 组件：工作区管理
// =============================================================================

async function manageWorkspaces(ctx: any): Promise<boolean> {
  const config = loadConfig();
  if (config.workspaces.length === 0) {
    ctx.ui.notify("没有已启用的工作区", "info");
    return false;
  }

  const wsOptions = config.workspaces.map((ws) => {
    const isCurrent = activeWorkspace && path.resolve(ws) === activeWorkspace;
    const tag = isCurrent ? "  ← 当前" : "";
    // 统计该 ws 下的 queue 数
    let count = 0;
    try {
      const dir = workspaceDir(ws);
      count = fs.readdirSync(dir).filter((f) => f.startsWith("queue-") && f.endsWith(".json")).length;
    } catch {}
    return `${ws}  (${count} queue)${tag}`;
  });
  wsOptions.push(padPrefix("🔙") + "返回");

  const wsChoice = await ctx.ui.select(`已启用的工作区 (${config.workspaces.length})`, wsOptions);
  if (!wsChoice || wsChoice.startsWith("🔙")) return false;

  const selectedWs = config.workspaces.find((ws) => wsChoice.startsWith(ws));
  if (!selectedWs) return false;

  const isCurrent = activeWorkspace && path.resolve(selectedWs) === activeWorkspace;
  const opOptions: string[] = [];
  if (isCurrent) {
    opOptions.push(padPrefix("⏸️") + "停用工作区");
  } else {
    opOptions.push(padPrefix("✅") + "启用此工作区");
  }
  opOptions.push(padPrefix("🗑️") + "删除工作区");
  opOptions.push(padPrefix("🔙") + "返回");

  const opChoice = await ctx.ui.select(`工作区: ${selectedWs}`, opOptions);
  if (!opChoice || opChoice.startsWith("🔙")) return false;

  if (opChoice.startsWith("⏸️")) {
    // 停用：仅清 activeWorkspace，保留在 config 列表里，后续可重新启用
    if (activeWorkspace && path.resolve(selectedWs) === activeWorkspace) {
      activeWorkspace = null;
      ctx.ui.setStatus("session-queue", undefined);
      beforeMap.clear();
      afterMap.clear();
      bashTrackedPaths.clear();
      turnIndex = 0;
      ctx.ui.notify(`⏸ 已停用：${selectedWs}（仍在列表中，可重新启用）`, "info");
      return true;
    }
  } else if (opChoice.startsWith("✅")) {
    if (!activeWorkspace) {
      addWorkspace(ctx.cwd);
      activeWorkspace = path.resolve(ctx.cwd);
      ctx.ui.setStatus("session-queue", getStatusText());
      ctx.ui.notify(`✅ 已启用：${selectedWs}`, "success");
      return true;
    } else {
      ctx.ui.notify("已有其他工作区启用中，请先停用", "warning");
    }
  } else if (opChoice.startsWith("🗑️")) {
    // 删除：从 config 彻底移除，根据全局配置决定是否清数据
    const wasActive = activeWorkspace && path.resolve(selectedWs) === activeWorkspace;
    const willClear = config.clearDataOnRemoveWorkspace;
    const ok = await ctx.ui.confirm(
      "确认删除工作区",
      willClear
        ? `确定删除 ${selectedWs}？将同时清除该工作区的队列与快照数据，不可恢复。`
        : `确定从列表移除 ${selectedWs}？（数据保留）`,
    );
    if (!ok) return false;
    const result = removeWorkspace(selectedWs);
    if (wasActive) {
      activeWorkspace = null;
      ctx.ui.setStatus("session-queue", undefined);
      beforeMap.clear();
      afterMap.clear();
      bashTrackedPaths.clear();
      turnIndex = 0;
    }
    if (result.clearedData) {
      maybeGc(true);
      ctx.ui.notify(`🗑️ 已删除并清除数据：${selectedWs}`, "success");
    } else {
      ctx.ui.notify(`🗑️ 已从列表移除（数据保留）：${selectedWs}`, "success");
    }
    return false;
  }

  return false;
}

// =============================================================================
// 入口
// =============================================================================

export { default } from "./src/index";

/** 旧实现已迁移到 src/，此函数仅保留作参考，不会注册任何事件。 */
function __legacyDisabled(pi: ExtensionAPI) {
  ensureDirs();
  activeWorkspace = null;

  // ── session_start ──
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentSessionId = ctx.sessionManager.getSessionFile() || null;
    if (currentSessionId) {
      currentSessionId = currentSessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    }
    turnIndex = 1;
    lastFlushedUserMsgId = null;

    if (isWorkspaceEnabled(ctx.cwd)) {
      activeWorkspace = path.resolve(ctx.cwd);
      ctx.ui.setStatus("session-queue", getStatusText());
    }
  });

  // ── turn_end ──
  pi.on("turn_end", (_event, ctx) => {
    if (!activeWorkspace || !ctx.hasUI) return;
    flushTurn(ctx);
  });

  // ── session_tree ──
  pi.on("session_tree", (event, ctx) => {
    if (event.fromExtension) return;
    if (!activeWorkspace || !ctx.hasUI) return;
    if (!followSessionTreeEnabled) return;
    if (isProcessing) return;
    if (event.newLeafId === event.oldLeafId) return;
    try {
      if (!currentSessionId) return;
      const queue = loadQueue(activeWorkspace, currentSessionId);
      if (queue.entries.length === 0) return;

      const leafEntry = ctx.sessionManager.getLeafEntry?.();
      const leafId = (leafEntry as any)?.id ?? event.newLeafId ?? null;
      let navUserMsgId: string | null = null;

      if (leafId != null) {
        const children = (ctx.sessionManager as any).getChildren?.(leafId) ?? [];
        for (const c of children) {
          if (c.type === "message" && (c as any).message?.role === "user") {
            navUserMsgId = c.id ?? null;
            break;
          }
        }
      }
      if (!navUserMsgId) {
        if (leafEntry && leafEntry.type === "message" && (leafEntry as any).message?.role === "user") {
          navUserMsgId = (leafEntry as any).id ?? null;
        }
      }
      if (!navUserMsgId) {
        const branch = ctx.sessionManager.getBranch();
        if (Array.isArray(branch)) {
          for (let i = branch.length - 1; i >= 0; i--) {
            const e: any = branch[i];
            if (e.type === "message" && e.message?.role === "user") {
              navUserMsgId = e.id ?? null;
              break;
            }
          }
        }
      }

      if (!navUserMsgId) return;
      const idx = queue.entries.findIndex((ent) => ent.sessionEntryId === navUserMsgId);
      if (idx < 0) return;
      if (idx >= queue.entries.length) return;

      isProcessing = true;
      try {
        autoRollbackForSessionTree(ctx, queue, idx);
      } finally {
        isProcessing = false;
      }
    } catch {}
  });

  // ── tool_call ──
  pi.on("tool_call", (event) => {
    onToolCall(event);
  });

  // ── tool_result ──
  pi.on("tool_result", (event) => {
    onToolResult(event);
  });

  // ── 命令：/rollback ──
  pi.registerCommand("rollback", {
    description: "会话队列回滚（单入口菜单）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("rollback 需要交互模式", "error");
        return;
      }

      while (true) {
        const queue = currentSessionId && activeWorkspace
          ? loadQueue(activeWorkspace, currentSessionId)
          : null;
        const queueSize = queue?.entries.length ?? 0;
        const config = loadConfig();

        const mainOptions: string[] = [
          padPrefix("📋") + `回滚历史  (${Math.max(0, queueSize - 1)} 个变更点)`,
          ...(activeWorkspace ? [] : [padPrefix("✅") + "启用当前工作区"]),
          padPrefix("📂") + "管理工作区",
          padPrefix("⚙️") + "全局配置",
          padPrefix("🗑️") + "清空当前队列",
          padPrefix("♻️") + "回收孤儿快照",
          padPrefix("🚪") + "退出菜单",
        ];

        const mainChoice = await ctx.ui.select("会话队列回滚", mainOptions);
        if (!mainChoice || mainChoice.startsWith("🚪")) return;

        if (mainChoice.startsWith("📋")) {
          await showRollbackUI(pi, ctx);
          return;
        } else if (mainChoice.startsWith("📂")) {
          const changed = await manageWorkspaces(ctx);
          if (changed) return;
        } else if (mainChoice.startsWith("⚙️")) {
          await showGlobalConfigUI(ctx);
        } else if (mainChoice.startsWith("🗑️")) {
          if (!currentSessionId || !activeWorkspace) {
            ctx.ui.notify("无活跃 session 或工作区未启用", "info");
            continue;
          }
          if (queueSize === 0) {
            ctx.ui.notify("队列已经为空", "info");
            continue;
          }
          const clearedQueue = loadQueue(activeWorkspace, currentSessionId);
          clearedQueue.entries = [];
          clearedQueue.currentIndex = -1;
          saveQueue(activeWorkspace, clearedQueue);
          lastFlushedUserMsgId = null;
          beforeMap.clear();
          afterMap.clear();
          bashTrackedPaths.clear();
          turnIndex = 0;
          const gc = runGc();
          ctx.ui.notify(
            `✅ 队列已清空，回收 ${gc.snapDeleted} 个孤儿快照${gc.queueDeleted ? `，清理 ${gc.queueDeleted} 个旧 queue 文件` : ""}`,
            "success",
          );
        } else if (mainChoice.startsWith("✅")) {
          if (activeWorkspace) {
            ctx.ui.notify("当前工作区已启用", "info");
            continue;
          }
          const resolved = path.resolve(ctx.cwd);
          addWorkspace(resolved);
          activeWorkspace = resolved;
          ctx.ui.setStatus("session-queue", getStatusText());
          ctx.ui.notify(`✅ 已启用变更记录：${resolved}`, "success");
          return;
        } else if (mainChoice.startsWith("♻️")) {
          const gc = runGc();
          ctx.ui.notify(
            `🧹 扫描 ${gc.snapScanned} 个快照，删除 ${gc.snapDeleted} 个孤儿，存活 ${gc.live} 个${gc.queueDeleted ? `；清理 ${gc.queueDeleted} 个旧 queue 文件，保留 ${gc.queueKept} 个` : ""}`,
            "success",
          );
        }
      }
    },
  });
}
