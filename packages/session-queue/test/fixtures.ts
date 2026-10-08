/**
 * 测试夹具：真实文件 + 内存 store + 模拟 pi sessionManager。
 *
 * 关键点：模拟的 navigateTree 严格复刻 pi 的契约
 * （agent-session.js:3300 附近 navigateTree 的 newLeafId 推导），
 * 否则「跟随 /tree」的测试就没有意义。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { SessionQueueService } from "../src/core/session-queue";
import { targetStateFor } from "../src/core/tree";
import type { FileChange, Logger, QueueData, QueueEntry } from "../src/types";

export const EMPTY_HASH = "0".repeat(64);

export const sha = (c: string | null): string =>
  c === null ? EMPTY_HASH : createHash("sha256").update(c).digest("hex");

// ── 临时工作区 ────────────────────────────────────────────────
export const tmpRoots: string[] = [];

export function makeWorkspace(prefix = "sq"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

export function cleanupWorkspaces(): void {
  for (const dir of tmpRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function writeFileIn(ws: string, rel: string, content: string | null): string {
  const p = path.join(ws, rel);
  if (content === null) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return EMPTY_HASH;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  return sha(content);
}

export function readFileIn(ws: string, rel: string): string {
  const p = path.join(ws, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "∅";
}

// ── 模拟 pi session 树 ────────────────────────────────────────
export type NodeType = "user" | "assistant" | "label" | "custom_message";

export interface TreeNode {
  id: string;
  type: NodeType;
  parentId: string | null;
  text?: string;
}

export function user(id: string, parentId: string | null, text = ""): TreeNode {
  return { id, type: "user", parentId, text };
}
export function assistant(id: string, parentId: string | null): TreeNode {
  return { id, type: "assistant", parentId };
}
export function label(id: string, parentId: string | null): TreeNode {
  return { id, type: "label", parentId };
}
export function customMessage(id: string, parentId: string | null): TreeNode {
  return { id, type: "custom_message", parentId };
}

export function toSessionEntry(n: TreeNode): any {
  if (n.type === "user") return { id: n.id, type: "message", parentId: n.parentId, message: { role: "user", content: n.text ?? n.id } };
  if (n.type === "assistant") return { id: n.id, type: "message", parentId: n.parentId, message: { role: "assistant", content: n.id } };
  if (n.type === "custom_message") return { id: n.id, type: "custom_message", parentId: n.parentId, content: n.id };
  return { id: n.id, type: "label", parentId: n.parentId, label: n.id };
}

/**
 * pi navigateTree 的 newLeafId 推导（agent-session.js）：
 *   选中 user / custom_message → newLeafId = target.parentId
 *   其他（assistant / label）    → newLeafId = target.id
 */
export function piLeafFor(nodes: Map<string, TreeNode>, selected: string): string | null {
  const t = nodes.get(selected);
  if (!t) return null;
  return t.type === "user" || t.type === "custom_message" ? t.parentId : t.id;
}

export interface MockSession {
  manager: any;
  nodes: Map<string, TreeNode>;
  leafId: string | null;
  /** 追加节点（用于模拟“导航后新开一轮对话”产生的树变化）。 */
  addNode(node: TreeNode): void;
  /** 模拟宿主导航：按 pi 契约算 newLeafId 并派发 session_tree。 */
  navigate(selected: string, opts?: { fromExtension?: boolean }): { cancelled: boolean; newLeafId: string | null };
  onNavigate: (ev: any) => void;
  /** 手动派发事件（用于构造非导航场景）。 */
  emit(ev: any): void;
  /** 把某个节点设为当前会话叶（不发事件）。 */
  setLeaf(id: string | null): void;
}

export function mockSession(nodes: TreeNode[], initialLeaf: string | null, onNavigate: (ev: any) => void): MockSession {
  const list = [...nodes];
  const map = new Map(list.map((n) => [n.id, n]));
  const state = { leafId: initialLeaf as string | null };
  const session: MockSession = {
    nodes: map,
    get leafId() {
      return state.leafId;
    },
    manager: null as any,
    addNode(node) {
      list.push(node);
      map.set(node.id, node);
    },
    navigate(selected, opts) {
      const target = map.get(selected);
      if (!target) return { cancelled: false, newLeafId: state.leafId };
      if (selected === state.leafId) return { cancelled: false, newLeafId: state.leafId };
      const newLeafId = piLeafFor(map, selected);
      const oldLeafId = state.leafId;
      state.leafId = newLeafId;
      const ev = { type: "session_tree", newLeafId, oldLeafId, ...(opts?.fromExtension ? { fromExtension: true } : {}) };
      onNavigate(ev);
      return { cancelled: false, newLeafId };
    },
    onNavigate,
    emit(ev) {
      onNavigate(ev);
    },
    setLeaf(id) {
      state.leafId = id;
    },
  };

  session.manager = {
    getEntries: () => list.map(toSessionEntry),
    getEntry: (id: string) => (map.has(id) ? toSessionEntry(map.get(id)!) : undefined),
    getSessionFile: () => "session-1.json",
    getLeafId: () => state.leafId,
    getLeafEntry: () => (state.leafId && map.has(state.leafId) ? toSessionEntry(map.get(state.leafId)!) : undefined),
    getChildren: (parentId: string) => list.filter((n) => n.parentId === parentId).map(toSessionEntry),
    getBranch: () => {
      const chain: TreeNode[] = [];
      let cur = state.leafId ? map.get(state.leafId) : undefined;
      while (cur) {
        chain.unshift(cur);
        cur = cur.parentId ? map.get(cur.parentId) : undefined;
      }
      return chain.map(toSessionEntry);
    },
    getTree: () => [],
  };
  return session;
}

// ── 内存 store ───────────────────────────────────────────────
export interface Fixture {
  ws: string;
  queue: QueueData;
  snapshots: Map<string, string | null>;
  svc: SessionQueueService;
  session: MockSession;
  ctx: any;
  notices: { message: string; level: string }[];
  /** 把 entry 的文件写入磁盘，并登记快照。 */
  applyChange(rel: string, before: string | null, after: string | null): FileChange;
  saveSnapshot(hash: string, content: string | null): void;
  /** 把磁盘重置为「当前 currentIndex/currentMode」应有的状态，保证夹具自洽。 */
  materialize(): void;
  config: { followSessionTree: boolean; keep: number };
  savedCount: number;
}

export function makeFixture(opts: {
  ws?: string;
  entries?: QueueEntry[];
  nodes?: TreeNode[];
  leaf?: string | null;
  followSessionTree?: boolean;
  sessionFile?: string;
  currentMode?: "before" | "after";
}): Fixture {
  const ws = opts.ws ?? makeWorkspace();
  const snapshots = new Map<string, string | null>();
  const config = { followSessionTree: opts.followSessionTree ?? true, keep: 10 };
  const notices: { message: string; level: string }[] = [];

  const queue: QueueData = {
    version: 1,
    sessionId: "session-1_json",
    entries: opts.entries ? JSON.parse(JSON.stringify(opts.entries)) : [],
    currentIndex: (opts.entries?.length ?? 0) - 1,
    ...(opts.currentMode ? { currentMode: opts.currentMode } : {}),
  };

  let savedCount = 0;
  const queueStore: any = {
    load: () => JSON.parse(JSON.stringify(queue)),
    save: (_w: string, d: QueueData) => {
      savedCount++;
      Object.assign(queue, JSON.parse(JSON.stringify(d)));
    },
    clear: () => {
      queue.entries = [];
      queue.currentIndex = -1;
    },
    collectLiveHashes: (_f: string, live: Set<string>) => {
      for (const e of queue.entries) for (const c of e.changes ?? []) live.add(c.beforeHash), live.add(c.afterHash);
    },
    listQueues: () => [],
    countQueueFiles: () => 1,
  };
  const snapshotStore: any = {
    read: (h: string) => (snapshots.has(h) ? snapshots.get(h)! : null),
    writeIfMissing: (h: string, c: string | null) => {
      if (!snapshots.has(h)) snapshots.set(h, c);
    },
    deleteOrphans: () => ({ deleted: 0, scanned: 0 }),
  };
  const configStore: any = {
    filePath: path.join(ws, "config.json"),
    load: () => ({
      version: 2,
      workspaces: [ws],
      followSessionTree: config.followSessionTree,
      keepQueueCountPerWorkspace: config.keep,
      clearDataOnRemoveWorkspace: false,
    }),
    update: (fn: (c: any) => void) => fn(configStore.load()),
  };
  const gcService: any = { maybeGc: () => { }, run: () => ({ snapDeleted: 0, queueDeleted: 0 }) };
  const logger: Logger = { debug() { }, info() { }, warn() { }, error() { } };

  const svc = new SessionQueueService(configStore, queueStore, snapshotStore, gcService, logger);
  const session = mockSession(opts.nodes ?? [], opts.leaf ?? null, (ev) => svc.handleSessionTreeNavigation(ev, ctx));

  const ctx: any = {
    hasUI: true,
    cwd: ws,
    sessionManager: session.manager,
    ui: {
      setStatus: () => { },
      notify: (message: string, level = "info") => notices.push({ message, level }),
    },
    navigateTree: async (id: string) => session.navigate(id, { fromExtension: true }),
  };

  svc.startSession(ctx);

  return {
    ws,
    queue,
    snapshots,
    svc,
    session,
    ctx,
    notices,
    config,
    get savedCount() {
      return savedCount;
    },
    applyChange(rel, before, after) {
      const p = path.join(ws, rel);
      const beforeHash = before === null ? EMPTY_HASH : sha(before);
      // 写 before 状态
      writeFileIn(ws, rel, before);
      if (before !== null) snapshots.set(beforeHash, before);
      const afterHash = writeFileIn(ws, rel, after);
      if (after !== null) snapshots.set(afterHash, after);
      snapshots.set(beforeHash, before);
      return {
        path: p,
        action: before === null ? "create" : after === null ? "delete" : "write",
        beforeHash,
        afterHash,
      };
    },
    saveSnapshot(hash, content) {
      snapshots.set(hash, content);
    },
    materialize() {
      // 让磁盘与「当前 currentIndex/currentMode」对齐：不属于当前节点链的文件一律视为不存在。
      const state = targetStateFor(queue, queue.currentIndex, queue.currentMode ?? "after");
      const keep = new Set([...state.keys()]);
      for (const change of queue.entries.flatMap((e) => e.changes ?? [])) {
        if (!keep.has(comparable(change.path))) {
          writeFileIn(ws, path.relative(ws, change.path), null);
        }
      }
      for (const v of state.values()) {
        writeFileIn(ws, path.relative(ws, v.path), snapshots.get(v.afterHash) ?? null);
      }
    },
  };

  function comparable(p: string): string {
    return process.platform === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p);
  }
}

/** 构造一条 entry（不落盘，由调用方决定初始磁盘状态）。 */
export function entry(turnIndex: number, sessionEntryId: string | undefined, changes: FileChange[], parentEntryId?: string): QueueEntry {
  return {
    turnIndex,
    text: sessionEntryId ?? `turn${turnIndex}`,
    timestamp: `t${turnIndex}`,
    changes,
    sessionEntryId,
    ...(parentEntryId !== undefined ? { parentEntryId } : {}),
  };
}

export function turn0(): QueueEntry {
  return { turnIndex: 0, text: "（会话起点）", timestamp: "t0", changes: [] };
}
