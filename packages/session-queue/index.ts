/**
 * @liziy/session-queue —— pi 的线性队列会话管理 + 文件变更记忆回滚
 * =============================================================================
 * 把 pi 的会话从「树」改为「队列」：双 Esc 唤起线性列表，回滚直接截断后续记录。
 * 配合 JIT 工具拦截：edit/write/bash 执行前/后拍照存证，记录每个 turn 修改的文件。
 * 回滚时弹窗确认 + 脏检查，自动还原文件内容。
 *
 * 核心特性：
 * - 队列视图：10 轮滚动窗口，.slice(-10) 一刀切
 * - JIT 拦截：pi.on("tool_call"/"tool_result") 按需拍照，0 启动开销
 * - 内容寻址：相同内容只存一次（sha256 命名）
 * - 脏检查：回滚前比对当前文件 hash，防止覆盖用户手动修改
 * - 工作区白名单：默认休眠，/rollback enable 启用
 * - snapshot GC：标记-扫描回收孤儿快照，防止磁盘无限增长
 * - bash 追踪：rm/del/mv/重定向 的文件操作（多文件、glob 展开）
 * - 零依赖
 *
 * 存储路径：
 *   config.json                      工作区列表
 *   queue-{sessionId}.json           队列（内嵌 changes）
 *   snapshots/{hash}.content         内容寻址快照
 *
 * 命令：
 *   /rollback            唤起队列选择器（回滚弹窗）
 *   /rollback enable     启用当前目录的变更记录
 *   /rollback disable    暂停当前目录的变更记录
 *   /rollback list       列出当前已启用的工作区
 *   /rollback gc         手动回收孤儿快照
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// =============================================================================
// 常量
// =============================================================================

const MAX_TURNS = 10;
const WRITE_TOOLS = new Set(["edit", "write"]);
const EMPTY_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const GC_THROTTLE_MS = 5 * 60 * 1000;  // 自动 GC 节流：5 分钟
const MAX_QUEUE_FILES = 20;            // GC 时保留的最近 queue 文件数量

// =============================================================================
// 类型
// =============================================================================

interface FileChange {
  path: string;
  action: "edit" | "write" | "create" | "delete";
  beforeHash: string;
  afterHash: string;
  viaBash?: boolean;  // 由 bash 命令推断（可能不完整）
}

interface QueueEntry {
  turnIndex: number;
  text: string;
  timestamp: string;
  changes: FileChange[];
  residual?: boolean;          // 跳过冲突时保留的未回滚残留
  sessionEntryId?: string;     // 对应 Session Tree 中 user 消息的 entry ID
  resultText?: string;         // assistant 的最后回复文本（当前节点展示用）
}

interface QueueData {
  version: 1;
  sessionId: string;
  entries: QueueEntry[];
  currentIndex: number;
  lastGcAt?: string;
}

interface Config {
  workspaces: string[];
  followSessionTree?: boolean;  // 是否在 Session Tree 导航时自动回滚队列
}

// =============================================================================
// 全局状态（每个 pi 进程内单例）
// =============================================================================

const EXT_DIR = path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi/agent/extensions/session-queue");
const SNAPSHOT_DIR = path.join(EXT_DIR, "snapshots");
const CONFIG_FILE = path.join(EXT_DIR, "config.json");

let activeWorkspace: string | null = null;
let currentSessionId: string | null = null;
let turnIndex = 0;
let followSessionTreeEnabled = true;  // 从 config 加载；默认开启

// JIT 拦截状态：当前 turn 内
const beforeMap = new Map<string, string | null>();  // path → 第一次拍照（turn 开始时的状态）
const afterMap = new Map<string, string | null>();   // path → 最新一次读取（每次 tool_result 更新）
const bashTrackedPaths = new Set<string>();           // bash 分支追踪的路径（供 onToolResult 回填 after）
const turnChanges: FileChange[] = [];

// 锁：防止 turn_end 和回滚并发
let isProcessing = false;

// 上一个已落盘 entry 所属的 user 消息 id；用于在 turn_end 时判断是否为新提问。
// 在 turn_end（而非 turn_start）时检测，因为此时 branch 一定已包含当前 user 消息。
let lastFlushedUserMsgId: string | null = null;

// GC 节流时间戳
let lastGcRun = 0;

// ANSI 转义码（仅给“点”上色，文字保持默认色）
const ANSI = {
  reset: "\x1b[0m",
  cyan:  "\x1b[36m",  // 青（天蓝）
  green: "\x1b[32m",  // 亮绿
};

// 状态文本（3 态：未启用 / 仅记录 / 记录+同步）
function getStatusText(): string | undefined {
  if (!activeWorkspace) return undefined;     // 状态 1：未启用 → 不显示
  if (followSessionTreeEnabled) return `${ANSI.green}●${ANSI.reset} 同步`;   // 状态 3：亮绿点
  return `${ANSI.cyan}●${ANSI.reset} 记录`;                              // 状态 2：青色点
}

// =============================================================================
// 工具：路径与 IO
// =============================================================================

function ensureDirs(): void {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  } catch {
    // 忽略：可能权限问题
  }
}

function queueFilePath(sessionId: string): string {
  return path.join(EXT_DIR, `queue-${sessionId}.json`);
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
    } catch {
      // 忽略写入失败
    }
  }
}

function isInsideWorkspace(targetPath: string, workspace: string): boolean {
  try {
    const target = path.resolve(targetPath);
    const ws = path.resolve(workspace);
    // Windows 盘符不同 → 直接 false
    if (target[0] !== ws[0]) return false;
    return target.startsWith(ws + path.sep) || target === ws;
  } catch {
    return false;
  }
}

// 简单 glob 展开（零依赖）：支持 basename 中的 * 和 ?
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
// 工具：队列与配置 IO
// =============================================================================

function loadQueue(sessionId: string): QueueData {
  const file = queueFilePath(sessionId);
  try {
    const data = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(data) as QueueData;
    if (parsed.version === 1) return parsed;
  } catch {
    // 文件不存在或解析失败
  }
  return {
    version: 1,
    sessionId,
    entries: [],
    currentIndex: -1,
  };
}

function saveQueue(data: QueueData): void {
  const file = queueFilePath(data.sessionId);
  try {
    atomicWriteFile(file, JSON.stringify(data, null, 2));
  } catch {
    // 忽略
  }
}

function loadConfig(): Config {
  try {
    const data = fs.readFileSync(CONFIG_FILE, "utf-8");
    const cfg = JSON.parse(data) as Config;
    if (typeof cfg.followSessionTree === "boolean") {
      followSessionTreeEnabled = cfg.followSessionTree;
    }
    return cfg;
  } catch {
    return { workspaces: [] };
  }
}

function saveConfig(config: Config): void {
  try {
    atomicWriteFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch {
    // 忽略
  }
}

function isWorkspaceEnabled(cwd: string): boolean {
  const config = loadConfig();
  return config.workspaces.some((ws) => isInsideWorkspace(cwd, ws));
}

function addWorkspace(cwd: string): void {
  const config = loadConfig();
  const resolved = path.resolve(cwd);
  if (!config.workspaces.includes(resolved)) {
    config.workspaces.push(resolved);
    saveConfig(config);
  }
}

function removeWorkspace(cwd: string): void {
  const config = loadConfig();
  const resolved = path.resolve(cwd);
  config.workspaces = config.workspaces.filter((ws) => ws !== resolved);
  saveConfig(config);
}

// =============================================================================
// 工具：从 input 提取文件路径
// =============================================================================

function extractFilePath(input: Record<string, unknown>): string | null {
  // edit / write 工具的参数：path 或 filePath
  const raw = (input.path as string) ?? (input.filePath as string) ?? (input.file_path as string);
  if (!raw || typeof raw !== "string") return null;
  return raw;
}

// =============================================================================
// snapshot GC：标记-扫描回收
// =============================================================================

function runGc(): { snapDeleted: number; snapScanned: number; live: number; queueDeleted: number; queueKept: number } {
  const liveSet = new Set<string>();

  let queueFiles: string[] = [];
  try {
    queueFiles = fs.readdirSync(EXT_DIR).filter(
      (f) => f.startsWith("queue-") && f.endsWith(".json"),
    );
  } catch {
    lastGcRun = Date.now();
    return { snapDeleted: 0, snapScanned: 0, live: 0, queueDeleted: 0, queueKept: 0 };
  }

  // Phase 1：收集所有 queue 引用的 hash 集合
  for (const qf of queueFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(EXT_DIR, qf), "utf-8")) as QueueData;
      if (data.version !== 1) continue;
      for (const e of data.entries) {
        for (const c of e.changes) {
          if (c.beforeHash && c.beforeHash !== EMPTY_HASH) liveSet.add(c.beforeHash);
          if (c.afterHash && c.afterHash !== EMPTY_HASH) liveSet.add(c.afterHash);
        }
      }
    } catch {
      // 单个 queue 损坏不影响整体
    }
  }

  // Phase 2：清理孤儿快照
  let snapFiles: string[] = [];
  try {
    snapFiles = fs.readdirSync(SNAPSHOT_DIR);
  } catch { /* ignore */ }

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
      } catch {
        // 忽略删除失败
      }
    }
  }

  // Phase 3：清理旧 queue 文件（按 mtime 保留最近 MAX_QUEUE_FILES 个）
  // 必须在 Phase 1 扫描完成后再删，避免 liveSet 误判
  let queueDeleted = 0;
  let queueKept = queueFiles.length;
  if (queueFiles.length > MAX_QUEUE_FILES) {
    const withMtime = queueFiles.map((name) => {
      try {
        return { name, mtime: fs.statSync(path.join(EXT_DIR, name)).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);  // 最新的在前
    const toDelete = withMtime.slice(MAX_QUEUE_FILES);
    for (const old of toDelete) {
      try {
        fs.unlinkSync(path.join(EXT_DIR, old.name));
        queueDeleted++;
        queueKept--;
      } catch {
        // 忽略删除失败
      }
    }
  }

  lastGcRun = Date.now();
  return { snapDeleted, snapScanned, live: liveSet.size, queueDeleted, queueKept };
}

function maybeGc(force = false): void {
  if (!force && Date.now() - lastGcRun < GC_THROTTLE_MS) return;
  try {
    runGc();
  } catch {
    // GC 失败不影响主流程
  }
}

// =============================================================================
// 核心：bash 命令文件路径解析
// =============================================================================

// 跳过空白与 shell 分隔符，返回下一个 token 起始位置
function skipWs(cmd: string, i: number): number {
  while (i < cmd.length && /\s/.test(cmd[i])) i++;
  return i;
}

// 从位置 i 读取一个 token（支持引号、转义），返回 {token, next}
// 注意：Windows 路径含反斜杠，双引号内只在遇到 " \ $ ` 时才当转义，
// 其他情况反斜杠保留为字面量（避免 E:\work → E:work 吃掉分隔符）。
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
          s += "\\";  // 字面反斜杠
          i++;
        }
      } else {
        s += cmd[i];
        i++;
      }
    }
    i++; // 跳过结束引号
    return { token: s, next: i };
  }
  if (ch === "'") {
    // 单引号：无转义，全部字面量
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

// 提取 rm/del 的所有目标（多命令、多文件、跳过 flag）
function parseRmTargets(cmd: string): string[] {
  const targets: string[] = [];
  const re = /\b(rm|del)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    let i = m.index + m[1].length;
    // 收集该 rm 之后到分隔符前的所有非 flag token
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

// 提取 mv 的 (src, dst) 对
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

// 提取 > / >> 重定向目标
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
  // 目录无法内容快照，跳过（回滚不支持目录还原）
  if (isDirectory(filePath)) return;
  if (!beforeMap.has(filePath)) {
    beforeMap.set(filePath, readContentIfExists(filePath));
  }
  if (viaBash) bashTrackedPaths.add(filePath);
}

function onToolCall(event: { toolName: string; input: Record<string, unknown> }): void {
  if (!activeWorkspace) return;

  // 处理 edit/write 工具
  if (WRITE_TOOLS.has(event.toolName)) {
    const raw = extractFilePath(event.input);
    if (!raw) return;
    const filePath = path.resolve(raw);
    trackPathBefore(filePath, false);
    return;
  }

  // 处理 bash 工具（rm / del / mv / 重定向）
  if (event.toolName === "bash") {
    const cmd = ((event.input as any).command || "").trim();
    if (!cmd) return;

    // rm / del：原路径将被删除
    for (const raw of parseRmTargets(cmd)) {
      for (const expanded of expandGlob(raw)) {
        trackPathBefore(path.resolve(expanded), true);
      }
    }

    // mv：oldPath 删除 + newPath 覆盖
    for (const [oldRaw, newRaw] of parseMvPairs(cmd)) {
      for (const expanded of expandGlob(oldRaw)) {
        trackPathBefore(path.resolve(expanded), true);
      }
      // newPath 可能被覆盖，记录其 before
      for (const expanded of expandGlob(newRaw)) {
        trackPathBefore(path.resolve(expanded), true);
      }
    }

    // > / >> 重定向：target 被覆盖
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

  // bash 分支：对所有 bash 追踪路径回填 after（删除后为 null、移动后为目标内容）
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

// 从 ctx.sessionManager 的 branch 中取最后一条 user 消息的 {id, text}
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
  } catch {
    // ignore
  }
  return { id: null, text: "" };
}

// 从 branch 中取最后一条 assistant 消息的回复文本（用于当前节点展示）
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
  } catch {
    // ignore
  }
  return "";
}

function flushTurn(ctx: any): void {
  if (isProcessing) return;
  isProcessing = true;
  try {
    if (!currentSessionId) return;

    const queue = loadQueue(currentSessionId);

    // ── Session Tree 同步检测 ──
    // 仅在当前工作区启用且开关打开、且是新 user 消息（避免同一提问内反复触发）时才执行。
    const canSync =
      activeWorkspace !== null && followSessionTreeEnabled &&
      currentUserMessage(ctx).id !== lastFlushedUserMsgId;
    if (canSync) {
      const navIdx = detectSessionTreeNav(ctx, queue);
      if (navIdx !== null) {
        autoRollbackForSessionTree(ctx, queue, navIdx);
      }
    }

    // Turn 0 初始化（始终创建占位）
    if (queue.entries.length === 0) {
      queue.entries.push({
        turnIndex: 0,
        text: "（会话起点）",
        timestamp: new Date().toISOString(),
        changes: [],
      });
      queue.currentIndex = 0;
    }

    // 从 beforeMap + afterMap 生成 changes（同 turn 多次编辑聚合为 1 条）
    const aggregated: FileChange[] = [];
    for (const [filePath, before] of beforeMap) {
      const after = afterMap.has(filePath)
        ? afterMap.get(filePath)!
        : readContentIfExists(filePath);
      const beforeHash = sha256(before);
      const afterHash = sha256(after);
      if (beforeHash === afterHash) continue;  // 没变化 → 跳过

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

    // 清空缓存，下一轮重新拍照
    beforeMap.clear();
    afterMap.clear();
    bashTrackedPaths.clear();

    const curUser = currentUserMessage(ctx);
    const currentText = curUser.text.slice(0, 80) || "";
    const curUserMsgId = curUser.id;
    const lastEntry = queue.entries[queue.entries.length - 1];

    // 按用户提问归类：在 turn_end 时检测当前 user 消息 id 是否变化。
    // - id 与上次落盘的相同 → 同一提问的后续 turn_end → 追加步骤到现有 entry；
    // - id 变化 / 首次 / 回滚后（lastFlushedUserMsgId=null）→ 新建 entry。
    //
    // 合并采用「追加步骤」（保留每个 turn 的快照），而非旧的 net 合并，
    // 避免吞掉中间的删除/重建步骤导致按步回滚失败。
    // planRollback/applyRollback 按 turnIndex 升序聚合 earliest-before / latest-after，
    // 天然兼容同 path 多条 step。
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
      // 更新 resultText 为本轮的 assistant 回复
      const at = currentAssistantText(ctx);
      if (at) lastEntry.resultText = at;
      queue.currentIndex = queue.entries.length - 1;
      saveQueue(queue);
      turnIndex++;
      return;
    }

    lastFlushedUserMsgId = curUserMsgId;

    // 新建 entry（用 entries 长度作为编号）
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

    // 滚动窗口：只保留最后 10 条
    if (queue.entries.length > MAX_TURNS) {
      queue.entries = queue.entries.slice(-MAX_TURNS);
      queue.currentIndex = queue.entries.length - 1;
    }

    saveQueue(queue);
    turnIndex++;

    // 每次 turn_end 都触发节流 GC（回收孤儿 snapshot + 清理旧 queue 文件）
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
  conflictPaths: string[];  // 脏检查失败的路径
}

function planRollback(queue: QueueData, targetIndex: number, force = false): RollbackPlan {
  // Option C 语义：每个 entry 是一个检查点 = 该 entry 修改之前的文件状态。
  // 回滚到 targetIndex = 撤销 targetIndex 及之后所有 entry（含 targetIndex 自身）。
  const discarded = queue.entries.slice(targetIndex).filter((e) => !e.residual);
  const changes: RollbackChange[] = [];
  for (const entry of discarded) {
    for (const c of entry.changes) {
      changes.push({ ...c, turnIndex: entry.turnIndex });
    }
  }

  const conflictPaths: string[] = [];

  // 脏检查：当前文件 hash 应等于最新 turn 留下的 afterHash
  // 仅在手动回滚时检查（force=false）；Session Tree 同步(force=true)强制覆盖
  if (!force) {
    // 聚合：同一文件只检查"最新一条"的 afterHash（按 turnIndex 升序，后覆盖前）
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

function applyRollback(plan: RollbackPlan): {
  restored: number;
  skipped: string[];
  missingSnapshot: string[];
} {
  const skipped: string[] = [];
  const missingSnapshot: string[] = [];

  // 关键修复：聚合取「最早 turnIndex」的 beforeHash = 被丢弃 turns 第一次修改前的真实原始状态
  // 升序遍历，第一个命中即为最小 turnIndex 的 before。
  // 这正确处理删除/重建多步序列：
  //   F: A→(delete)→(create C)→(delete)，回滚到 A 那一步时，最早 discarded 的 before=A → 还原 A；
  //   回滚到「删除」那步时，最早 discarded 的 before=EMPTY → 删除文件。
  // 不会误取中间快照。
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
      // 原始状态：文件不存在 → 删除
      try {
        fs.unlinkSync(filePath);
      } catch {
        // 文件可能已被删除
      }
      continue;
    }

    // 非空 hash：必须能读到快照，否则绝不删除（避免误删用户文件）
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

  return {
    restored: finalBeforeByPath.size - skipped.length,
    skipped,
    missingSnapshot,
  };
}

// =============================================================================
// 回滚预览：按文件分类（还原/新增/删除）供确认菜单展示
// =============================================================================

interface RollbackPreview {
  restore: string[];  // 文件将还原到原内容
  create: string[];   // 文件将被新增创建
  remove: string[];   // 文件将被删除
}

function previewRollback(plan: RollbackPlan, workspace: string): RollbackPreview {
  // 复用 applyRollback 的 earliest-before 聚合逻辑
  const sortedAsc = [...plan.changes].sort((a, b) => a.turnIndex - b.turnIndex);
  const finalBeforeByPath = new Map<string, string>();
  for (const c of sortedAsc) {
    if (!finalBeforeByPath.has(c.path)) finalBeforeByPath.set(c.path, c.beforeHash);
  }

  const restore: string[] = [];
  const create: string[] = [];
  const remove: string[] = [];
  for (const [filePath, beforeHash] of finalBeforeByPath) {
    if (plan.conflictPaths.includes(filePath)) continue;  // 跳过的不计入
    const rel = path.relative(workspace, filePath) || filePath;
    const currentlyExists = readContentIfExists(filePath) !== null;
    if (beforeHash === EMPTY_HASH) {
      // 目标状态：不存在
      remove.push(rel);
    } else if (!currentlyExists) {
      // 目标状态：有内容 且 当前不存在 → 新增
      create.push(rel);
    } else {
      restore.push(rel);
    }
  }
  return { restore, create, remove };
}

function formatPreview(preview: RollbackPreview): string {
  const lines: string[] = [];
  if (preview.restore.length > 0) {
    lines.push(`  还原（${preview.restore.length}）：${preview.restore.join(", ")}`);
  }
  if (preview.create.length > 0) {
    lines.push(`  新增（${preview.create.length}）：${preview.create.join(", ")}`);
  }
  if (preview.remove.length > 0) {
    lines.push(`  删除（${preview.remove.length}）：${preview.remove.join(", ")}`);
  }
  if (lines.length === 0) lines.push("  （无文件变更）");
  return lines.join("\n");
}

// Session Tree 同步：检测到用户通过 Session Tree 导航到旧对话点时，
// 自动回滚队列和文件，让 Queue 跟随系统Tree。
// ─────────────────────────────────────────────────────────────

// 检测 Session Tree 是否被导航到旧对话点
// 返回：需要回滚到的 queue.entries 数组下标；未发生导航则返回 null
function detectSessionTreeNav(ctx: any, queue: QueueData): number | null {
  if (queue.entries.length < 2) return null;
  if (queue.currentIndex < 1) return null;

  try {
    const branch = ctx.sessionManager.getBranch();
    if (!Array.isArray(branch)) return null;

    // 收集 branch 中所有 user 消息 ID（按时间顺序）
    const userMsgIds: string[] = [];
    for (const e of branch) {
      if (e.type === "message" && e.message?.role === "user") {
        userMsgIds.push(e.id ?? "");
      }
    }
    if (userMsgIds.length < 2) return null;

    // 当前 user 消息（新输入的问题）
    const currentUserMsgId = userMsgIds[userMsgIds.length - 1];
    // 前一条 user 消息（用户导航到的对话点）
    const prevUserMsgId = userMsgIds[userMsgIds.length - 2];
    if (!prevUserMsgId) return null;

    // 按 sessionEntryId 匹配（新 entry 都有该字段）
    const idx = queue.entries.findIndex(
      (ent) => ent.sessionEntryId === prevUserMsgId,
    );

    if (idx >= 0 && idx < queue.currentIndex) return idx;
    return null;
  } catch {
    // ignore
  }
  return null;
}

// Session Tree 导航后的自动回滚（无需用户确认，静默处理冲突）
function autoRollbackForSessionTree(
  ctx: any,
  queue: QueueData,
  targetIdx: number,
): void {
  if (targetIdx < 0 || targetIdx >= queue.entries.length) return;
  const targetEntry = queue.entries[targetIdx];

  const plan = planRollback(queue, targetIdx, true);
  const result = applyRollback(plan);
  const skippedSet = new Set(result.skipped);

  // Option C：丢弃 target 及之后的 entry
  queue.entries = queue.entries.slice(0, targetIdx);

  // 若有跳过（冲突或快照丢失）→ 保留残留 entry，保持后续可重试
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

  saveQueue(queue);
  // 重置为 null，使后续 flushTurn 走“新建 entry”分支
  lastFlushedUserMsgId = null;
  turnIndex = targetEntry.turnIndex;

  // GC
  maybeGc(true);

  // 通知
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
  // Option C：entry 不表示当前状态，所有 entry 都是普通检查点；
  // 「当前状态」由 showRollbackUI 中的 phantomCurrent 表示。
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
  if (isProcessing) {
    ctx.ui.notify("正在处理上一轮，请稍候", "warning");
    return;
  }

  const queue = loadQueue(currentSessionId);
  if (queue.entries.length === 0) {
    ctx.ui.notify("队列为空", "info");
    return;
  }
  if (queue.entries.length === 1) {
    ctx.ui.notify("只有 Turn 0，没有可回滚的记录", "info");
    return;
  }

  // ── 第一步：选择目标 turn ──
  // Option C 语义：每个 entry 是一个检查点（该 entry 修改之前的文件状态）。
  // 展示顺序与 Session Tree 一致：「当前状态」虚顶在最上，下面是各 entry 检查点（倒序，最近在前）。
  // 过滤掉「会话起点」占位（与首个真实 entry 检查点语义重合）。
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
    let label: string;
    if (item.isCurrent) {
      label = "当前状态";
    } else {
      label = item.entry.text;
    }
    return `${label}${bashTag}${curTag}`;
  });

  // 循环选择：避免用户误选当前节点
  let targetEntry: QueueEntry | null = null;
  while (targetEntry === null) {
    const choice = await ctx.ui.select(
      `回滚到哪个检查点？(${checkpoints.length} 个检查点 + 当前状态)`,
      selectOptions,
    );
    if (!choice) return;  // 用户取消
    const choiceIdx = selectOptions.indexOf(choice);
    if (choiceIdx < 0) return;
    const picked = orderedDisplay[choiceIdx];
    if (picked.isCurrent) {
      ctx.ui.notify("当前节点不可回滚，请选其他 turn", "info");
      continue;  // 重新提示
    }
    targetEntry = picked.entry;
  }

  // 定位 target 在 queue.entries 中的数组索引（滚动窗口后 turnIndex 与数组下标不一致）
  const targetArrIdx = queue.entries.findIndex(
    (e) => e.turnIndex === targetEntry!.turnIndex,
  );
  if (targetArrIdx < 0) return;

  // ── 第二步：计算回滚计划 + 脏检查 ──
  const plan = planRollback(queue, targetArrIdx);
  if (plan.changes.length === 0) {
    // 没有文件变更，丢弃 target 及之后的 entry（Option C：target 检查点之前的 entry 保留）
    queue.entries = queue.entries.slice(0, targetArrIdx);
    queue.currentIndex = queue.entries.length - 1;
    saveQueue(queue);
    maybeGc();
    lastFlushedUserMsgId = null;
    ctx.ui.notify(`已回滚到「${targetEntry.text.slice(0, 30)}」`, "info");
    return;
  }

  // ── 第三步：单次确认弹窗（确定/取消 + 冲突处理一起） ──
  const preview = previewRollback(plan, activeWorkspace || process.cwd());
  let confirmTitle =
    `确认回滚到「${targetEntry.text.slice(0, 30)}」？\n` +
    `将处理 ${plan.changes.length} 个文件变更：\n` +
    formatPreview(preview);
  const hasConflict = plan.conflictPaths.length > 0;
  let confirmButtons: string[];
  if (hasConflict) {
    const conflictList = plan.conflictPaths
      .map((p) => "  ⚠ " + path.relative(activeWorkspace || process.cwd(), p))
      .join("\n");
    confirmTitle += `\n⚠ ${plan.conflictPaths.length} 个文件被外部修改：\n` + conflictList;
    confirmButtons = [
      "✅ 强制覆盖并回滚",
      "⏭  跳过冲突，回滚其他",
      "❌ 取消",
    ];
  } else {
    confirmButtons = ["✅ 确定回滚", "❌ 取消"];
  }

  const confirm = await ctx.ui.select(confirmTitle, confirmButtons);
  if (!confirm || confirm === "❌ 取消") return;
  if (hasConflict && confirm.includes("强制")) {
    plan.conflictPaths = [];  // 强制覆盖：清空冲突 → applyRollback 全部走
  }

  // ── 第五步：执行回滚 ──
  isProcessing = true;
  try {
    const result = applyRollback(plan);
    const skippedSet = new Set(result.skipped);

    // 截断队列（Option C：丢弃 target 及之后的 entry，保留 target 检查点之前的部分）
    queue.entries = queue.entries.slice(0, targetArrIdx);

    // 若有跳过（冲突或快照丢失）→ 保留残留 entry，记录被跳过文件的原始 change
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

    saveQueue(queue);
    turnIndex = targetEntry.turnIndex;
    // 回滚后下一个 turn_end 应新建 entry，而非追加到回滚截断后的最后一条
    lastFlushedUserMsgId = null;

    // 回滚后回收孤儿快照
    maybeGc(true);

    const parts: string[] = [];
    if (preview.restore.length > 0) parts.push(`还原 ${preview.restore.length}`);
    if (preview.create.length > 0) parts.push(`新增 ${preview.create.length}`);
    if (preview.remove.length > 0) parts.push(`删除 ${preview.remove.length}`);
    let msg = `已回滚到「${targetEntry.text.slice(0, 30)}」：${parts.join("、") || "无变更"}`;
    if (result.skipped.length > 0) {
      msg += `，跳过 ${result.skipped.length} 个`;
    }
    if (result.missingSnapshot.length > 0) {
      msg += `（其中 ${result.missingSnapshot.length} 个快照丢失，请手动检查）`;
    }
    ctx.ui.notify(msg, result.missingSnapshot.length > 0 ? "warning" : "success");
  } finally {
    isProcessing = false;
  }
}

// =============================================================================
// 入口
// =============================================================================

export default function (pi: ExtensionAPI) {
  ensureDirs();
  activeWorkspace = null;

  // ── session_start：初始化 Turn 0 ──
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentSessionId = ctx.sessionManager.getSessionFile() || null;
    // 用 sessionId 作为 key
    if (currentSessionId) {
      currentSessionId = currentSessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    }
    turnIndex = 1;
    lastFlushedUserMsgId = null;

    // 检查工作区是否启用
    if (isWorkspaceEnabled(ctx.cwd)) {
      activeWorkspace = path.resolve(ctx.cwd);
      ctx.ui.setStatus("session-queue", getStatusText());
    }
  });

  // ── turn_end：持久化（在此检测新提问，此时 branch 一定含当前 user 消息） ──
  pi.on("turn_end", (_event, ctx) => {
    if (!activeWorkspace || !ctx.hasUI) return;
    flushTurn(ctx);
  });

  // ── session_tree：用户导航 Session Tree 时立即检测 + 自动回滚 ──
  // 注意：此时 branch 可能只有 1 条 user 消息（导航点本身），不走 detectSessionTreeNav。
  // 改为：直接拿 branch 中最后一条 user 消息 id 作为 sessionEntryId 匹配。
  pi.on("session_tree", (event, ctx) => {
    if (event.fromExtension) {
      ctx.ui.notify("[SQ-debug] session_tree: fromExtension=true 跳过", "info");
      return;
    }
    if (!activeWorkspace) {
      ctx.ui.notify(`[SQ-debug] session_tree: activeWorkspace=null, currentSession=${currentSessionId?.slice(-12) ?? "?"}`, "info");
      return;
    }
    if (!ctx.hasUI) return;
    if (!followSessionTreeEnabled) {
      ctx.ui.notify("[SQ-debug] session_tree: toggle off", "info");
      return;
    }
    if (isProcessing) {
      ctx.ui.notify("[SQ-debug] session_tree: isProcessing=true", "info");
      return;
    }
    if (event.newLeafId === event.oldLeafId) {
      ctx.ui.notify(`[SQ-debug] session_tree: 无实际导航 (newLeafId===oldLeafId=${event.newLeafId?.slice(0, 8) ?? "?"})`, "info");
      return;
    }
    try {
      const queue = loadQueue(currentSessionId || "");
      if (queue.entries.length === 0) {
        ctx.ui.notify("[SQ-debug] session_tree: queue.entries=[]", "info");
        return;
      }

      // 关键修复：pi 在用户点击 user 消息时会把 leaf 设置为该消息的 parentId。
      // 例如点击 q3 → leaf = q3.parentId，这样 branch 不再包含 q3，最后一条 user 消息是 q2，
      // 会导致间接匹配到 q2，错误地多回滚一个。
      // 正确的处理顺序：
      //   优先级 1：getChildren(leafId) 找被点击的 user 消息
      //   优先级 2：leafEntry 本身为 user 消息（备用，比如点击的就是正在生效的 user）
      //   优先级 3：branch 倒序查最后一条 user 消息（最后一项备用）
      const leafEntry = ctx.sessionManager.getLeafEntry?.();
      const leafId = (leafEntry as any)?.id ?? event.newLeafId ?? null;
      let navUserMsgId: string | null = null;
      let navSource = "";

      // 优先级 1：getChildren(leafId) 找 user 消息子节点（即被点击的 user 消息）
      if (leafId != null) {
        const children = (ctx.sessionManager as any).getChildren?.(leafId) ?? [];
        for (const c of children) {
          if (c.type === "message" && (c as any).message?.role === "user") {
            navUserMsgId = c.id ?? null;
            navSource = "getChildren";
            break;
          }
        }
      }
      // 优先级 2：leafEntry 本身是 user 消息
      if (!navUserMsgId) {
        if (leafEntry && leafEntry.type === "message" && (leafEntry as any).message?.role === "user") {
          navUserMsgId = (leafEntry as any).id ?? null;
          navSource = "leafEntry-user";
        }
      }
      // 优先级 3：branch 倒序查最后一条 user 消息
      if (!navUserMsgId) {
        const branch = ctx.sessionManager.getBranch();
        if (Array.isArray(branch)) {
          for (let i = branch.length - 1; i >= 0; i--) {
            const e: any = branch[i];
            if (e.type === "message" && e.message?.role === "user") {
              navUserMsgId = e.id ?? null;
              navSource = "branch";
              break;
            }
          }
        }
      }

      ctx.ui.notify(
        `[SQ-debug] nav: ${navSource}=${navUserMsgId?.slice(0, 8) ?? "?"}, leafId=${leafId?.slice(0, 8) ?? "?"}, queue(${queue.entries.length}e/${queue.currentIndex}ci), session=${currentSessionId?.slice(-12) ?? "?"}`,
        "info",
      );
      if (!navUserMsgId) {
        ctx.ui.notify("[SQ-debug] session_tree: 未找到 nav user msg", "info");
        return;
      }
      // 查找队列中对应的 entry
      const idx = queue.entries.findIndex(
        (ent) => ent.sessionEntryId === navUserMsgId,
      );
      // 注意：Option C 语义为「entry 检查点 = 该 entry 修改之前的状态」。
      // 导航到 qN 对应「回滚到 qN 检查点」= 撤销 qN 及之后。
      // 若 nav 目标是当前 entry（idx === currentIndex），则 qN 本身还未被撤销、后续被撤销。
      // 但 currentIndex 永远 = entries.length-1，所以 idx >= currentIndex 的情形是“未真正导航”。
      // 同样：idx > entries.length-1 的越界情形跳过。
      if (idx < 0) {
        ctx.ui.notify(`[SQ-debug] session_tree: nav=${navUserMsgId?.slice(0, 8) ?? "?"} 未匹配 entries=${queue.entries.map(e => (e.sessionEntryId || '?').slice(0, 8)).join(',')}`, "info");
        return;
      }
      // Option C 语义：entry 是检查点。“导航到 q3” 包含 “q3 本身被撤销”（q3 不再在检查点列表中）。
      // 所以即使 idx === currentIndex（队列中最后一个 entry），仍然需要 fire。
      // 唯一需要跳过的是 idx 超出 entries 范围（不可能访问的检查点）。
      if (idx >= queue.entries.length) {
        ctx.ui.notify(`[SQ-debug] session_tree: idx=${idx} >= ${queue.entries.length}（超出队列范围），跳过`, "info");
        return;
      }
      ctx.ui.notify(`[SQ-debug] session_tree 回滚 idx=${idx} entries=${queue.entries.length}`, "info");
      isProcessing = true;
      try {
        autoRollbackForSessionTree(ctx, queue, idx);
      } finally {
        isProcessing = false;
      }
    } catch (e: any) {
      ctx.ui.notify(`[SQ-debug] session_tree 异常: ${e.message}`, "warning");
    }
  });

  // ── tool_call：JIT 拦截拍照 ──
  pi.on("tool_call", (event) => {
    onToolCall(event);
  });

  // ── tool_result：JIT 拦截收集 ──
  pi.on("tool_result", (event) => {
    onToolResult(event);
  });

  // ── 命令：/rollback（单入口菜单） ──
  pi.registerCommand("rollback", {
    description: "会话队列回滚（单入口菜单）",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("rollback 需要交互模式", "error");
        return;
      }

      // 一直循环，直到用户 Esc 取消或选择某个"完成"项
      while (true) {
        // 构建主菜单
        const queue = currentSessionId ? loadQueue(currentSessionId) : null;
        const queueSize = queue?.entries.length ?? 0;
        const config = loadConfig();

        const mainOptions: string[] = [
          `📋  回滚历史  (${Math.max(0, queueSize - 1)} 个变更点)`,
          "📂  管理工作区",
          "🗑️  清空当前队列",
          activeWorkspace ? "⏸   删除并清空" : "✅  启用当前工作区",
          `🔗  跟随 Session Tree  (${followSessionTreeEnabled ? "开" : "关"})`,
          "🧹  回收孤儿快照",
          "❌  退出菜单",
        ];

        const mainChoice = await ctx.ui.select(
          "会话队列回滚",
          mainOptions,
        );
        if (!mainChoice || mainChoice.startsWith("❌")) return;

        if (mainChoice.startsWith("📋")) {
          // 唤起回滚选择器，确认/取消后退出菜单
          await showRollbackUI(pi, ctx);
          return;
        } else if (mainChoice.startsWith("📂")) {
          // 管理工作区
          const result = await manageWorkspaces(ctx, config);
          if (result) {
            // 如果状态变了（启用/暂停），重新加载
            return;  // 状态已变，需要重启 session 才生效
          }
        } else if (mainChoice.startsWith("🗑️")) {
          // 清空当前队列
          if (!currentSessionId) {
            ctx.ui.notify("无活跃 session", "info");
            continue;
          }
          if (queueSize === 0) {
            ctx.ui.notify("队列已经为空", "info");
            continue;
          }
          const clearedQueue = loadQueue(currentSessionId);
          clearedQueue.entries = [];
          clearedQueue.currentIndex = -1;
          saveQueue(clearedQueue);
          lastFlushedUserMsgId = null;
          // 清空缓存状态，防止残留数据污染下一个 turn
          beforeMap.clear();
          afterMap.clear();
          bashTrackedPaths.clear();
          turnIndex = 0;
          // 清空后立即 GC，回收该 session 引用的孤儿快照
          const gc = runGc();
          ctx.ui.notify(
            `✅ 队列已清空，回收 ${gc.snapDeleted} 个孤儿快照${gc.queueDeleted ? `，清理 ${gc.queueDeleted} 个旧 queue 文件` : ""}`,
            "success",
          );
          // 回到主菜单
        } else if (mainChoice.startsWith("⏸")) {
          // 删除并清空
          if (!activeWorkspace) {
            ctx.ui.notify("当前工作区未启用", "info");
            continue;
          }
          removeWorkspace(ctx.cwd);
          activeWorkspace = null;
          ctx.ui.setStatus("session-queue", undefined);  // 状态 1：未启用
          beforeMap.clear();
          afterMap.clear();
          bashTrackedPaths.clear();
          turnIndex = 0;
          if (currentSessionId) {
            try { fs.unlinkSync(queueFilePath(currentSessionId)); } catch {}
          }
          // 删除 queue.json 后 GC 回收该 session 独占的孤儿快照
          const gc = runGc();
          ctx.ui.notify(
            `⏸ 已删除并清空当前 session 的记录，回收 ${gc.snapDeleted} 个孤儿快照${gc.queueDeleted ? `，清理 ${gc.queueDeleted} 个旧 queue 文件` : ""}`,
            "success",
          );
          return;  // 状态已变，退出菜单
        } else if (mainChoice.startsWith("✅")) {
          // 启用当前工作区
          if (activeWorkspace) {
            ctx.ui.notify("当前工作区已启用", "info");
            continue;
          }
          const resolved = path.resolve(ctx.cwd);
          addWorkspace(resolved);
          activeWorkspace = resolved;
          ctx.ui.setStatus("session-queue", getStatusText());
          ctx.ui.notify(`✅ 已启用变更记录：${resolved}`, "success");
          return;  // 状态已变，退出菜单
        } else if (mainChoice.startsWith("🔗")) {
          // 切换 Session Tree 跟随回滚开关
          followSessionTreeEnabled = !followSessionTreeEnabled;
          try {
            const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
            const cfg = JSON.parse(raw);
            cfg.followSessionTree = followSessionTreeEnabled;
            atomicWriteFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
          } catch {
            atomicWriteFile(
              CONFIG_FILE,
              JSON.stringify({ workspaces: [], followSessionTree: followSessionTreeEnabled }, null, 2),
            );
          }
          ctx.ui.notify(
            followSessionTreeEnabled ? "🔗 已开启：Session Tree 导航将自动回滚队列" : "⏸ 已关闭：Session Tree 导航不会自动回滚队列",
            "info",
          );
          // 同步更新状态栏文案
          ctx.ui.setStatus("session-queue", getStatusText());
          // 回到主菜单
        } else if (mainChoice.startsWith("🧹")) {
          // 手动 GC
          const gc = runGc();
          ctx.ui.notify(
            `🧹 扫描 ${gc.snapScanned} 个快照，删除 ${gc.snapDeleted} 个孤儿，存活 ${gc.live} 个${gc.queueDeleted ? `；清理 ${gc.queueDeleted} 个旧 queue 文件，保留 ${gc.queueKept ?? 0} 个` : ""}`,
            "success",
          );
        }
      }
    },
  });
}

// =============================================================================
// 管理工作区：二级菜单
// =============================================================================

async function manageWorkspaces(ctx: any, _config: Config): Promise<boolean> {
  // 一级：列出已启用的工作区
  const config = loadConfig();
  if (config.workspaces.length === 0) {
    ctx.ui.notify("没有已启用的工作区", "info");
    return false;
  }

  // 用绝对路径 + 标记当前激活
  const wsOptions = config.workspaces.map((ws) => {
    const isCurrent = activeWorkspace && path.resolve(ws) === activeWorkspace;
    const tag = isCurrent ? "  ← 当前" : "";
    return `${ws}${tag}`;
  });
  wsOptions.push("← 返回");

  const wsChoice = await ctx.ui.select(
    `已启用的工作区 (${config.workspaces.length})`,
    wsOptions,
  );

  if (!wsChoice || wsChoice === "← 返回") return false;

  // 从选项中提取路径（精确匹配）
  const selectedWs = config.workspaces.find((ws) => wsChoice.startsWith(ws));
  if (!selectedWs) return false;

  // 二级：对该工作区的操作
  const isCurrent = activeWorkspace && path.resolve(selectedWs) === activeWorkspace;
  const opOptions: string[] = [];
  if (isCurrent) {
    opOptions.push("⏸  暂停此工作区");
  } else {
    opOptions.push("✅ 启用此工作区");
  }
  opOptions.push("🗑️  从列表中删除");
  opOptions.push("← 返回");

  const opChoice = await ctx.ui.select(
    `工作区: ${selectedWs}`,
    opOptions,
  );

  if (!opChoice || opChoice === "← 返回") return false;

  if (opChoice.startsWith("⏸")) {
    // 暂停
    if (activeWorkspace && path.resolve(selectedWs) === activeWorkspace) {
      removeWorkspace(ctx.cwd);
      activeWorkspace = null;
      ctx.ui.setStatus("session-queue", undefined);  // 状态 1：未启用
      if (currentSessionId) {
        try { fs.unlinkSync(queueFilePath(currentSessionId)); } catch {}
      }
      const gc = runGc();
      ctx.ui.notify(
        `⏸ 已暂停：${selectedWs}，回收 ${gc.snapDeleted} 个孤儿快照${gc.queueDeleted ? `，清理 ${gc.queueDeleted} 个旧 queue 文件` : ""}`,
        "success",
      );
      return true;
    }
  } else if (opChoice.startsWith("✅")) {
    // 启用
    if (!activeWorkspace) {
      addWorkspace(ctx.cwd);
      activeWorkspace = path.resolve(ctx.cwd);
      ctx.ui.setStatus("session-queue", getStatusText());
      ctx.ui.notify(`✅ 已启用：${selectedWs}`, "success");
      return true;
    } else {
      ctx.ui.notify("已有其他工作区启用中，请先暂停", "warning");
    }
  } else if (opChoice.startsWith("🗑️")) {
    // 删除（从 config 移除）
    const cfg = loadConfig();
    cfg.workspaces = cfg.workspaces.filter((w) => w !== selectedWs);
    saveConfig(cfg);
    if (activeWorkspace && path.resolve(selectedWs) === activeWorkspace) {
      activeWorkspace = null;
      ctx.ui.setStatus("session-queue", undefined);
    }
    ctx.ui.notify(`🗑️ 已从列表中删除：${selectedWs}`, "success");
    return false;  // 状态未变（只是配置变了），可继续菜单
  }

  return false;
}
