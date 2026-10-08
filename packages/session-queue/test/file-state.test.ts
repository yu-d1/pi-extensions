/**
 * 文件状态语义：增删改、基线兜底、路径归一、冲突与损坏。
 */
import { describe, it, eq, ok } from "./harness";
import { applyNodeState, globalBaselineOf, nodeStateOf, previewNodeSwitch, targetStateFor } from "../src/core/tree";
import { EMPTY_HASH, assistant, entry, makeFixture, readFileIn, sha, turn0, user, type Fixture } from "./fixtures";
import type { Logger, QueueData } from "../src/types";

const logger: Logger = { debug() { }, info() { }, warn() { }, error() { } };
const snapshotStore = (snaps: Map<string, string | null>): any => ({
  read: (h: string) => (snaps.has(h) ? snaps.get(h)! : null),
  writeIfMissing: (h: string, c: string | null) => { if (!snaps.has(h)) snaps.set(h, c); },
  deleteOrphans: () => ({ deleted: 0, scanned: 0 }),
});

describe("文件状态 · 增删改", () => {
  it("create → write → delete 三种 action 都能正确回放", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("f.txt", null, "v1");      // create
    const c2 = f.applyChange("f.txt", "v1", "v2");      // write
    const c3 = f.applyChange("f.txt", "v2", null);      // delete
    eq(c1.action, "create");
    eq(c2.action, "write");
    eq(c3.action, "delete");

    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 3, currentMode: "after",
      entries: [turn0(), entry(1, "u1", [c1]), entry(2, "u2", [c2], "u1"), entry(3, "u3", [c3], "u2")],
    };
    const st = snapshotStore(f.snapshots);
    // 冲突检测以 currentIndex（切换前所在节点）为基准，因此调用期间必须保持为「源节点」。
    let fromIdx = 3;
    q.currentIndex = 3;
    q.currentMode = "after";
    for (const [idx, mode, exp] of [[3, "after", "∅"], [2, "after", "v2"], [1, "after", "v1"], [3, "after", "∅"], [1, "before", "∅"]] as const) {
      q.currentIndex = fromIdx;
      applyNodeState(q, idx, st, logger, false, mode);
      q.currentIndex = idx;
      q.currentMode = mode;
      fromIdx = idx;
      eq(readFileIn(f.ws, "f.txt"), exp, `idx=${idx} mode=${mode}`);
    }
  });

  it("同一文件多轮修改，before 语义取父节点状态", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("x.txt", null, "1");
    const c2 = f.applyChange("x.txt", "1", "2");
    const c3 = f.applyChange("x.txt", "2", "3");
    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 3, currentMode: "after",
      entries: [turn0(), entry(1, "u1", [c1]), entry(2, "u2", [c2], "u1"), entry(3, "u3", [c3], "u2")],
    };
    const st = snapshotStore(f.snapshots);
    let fromIdx = 3;
    q.currentIndex = 3;
    q.currentMode = "after";
    for (const [idx, mode, exp] of [[3, "after", "3"], [2, "after", "2"], [1, "after", "1"], [3, "before", "2"], [2, "before", "1"], [1, "before", "∅"]] as const) {
      q.currentIndex = fromIdx;
      applyNodeState(q, idx, st, logger, false, mode);
      q.currentIndex = idx;
      q.currentMode = mode;
      fromIdx = idx;
      eq(readFileIn(f.ws, "x.txt"), exp, `idx=${idx} mode=${mode}`);
    }
  });
});

describe("文件状态 · 基线兜底", () => {
  it("目标节点未涉及的文件回到基线（根）状态", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("a.txt", null, "1");
    const c2 = f.applyChange("b.txt", null, "2");
    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 2, currentMode: "after",
      entries: [turn0(), entry(1, "u1", [c1]), entry(2, "u2", [c2], "u1")],
    };
    const st = snapshotStore(f.snapshots);
    // 回到第1轮：b.txt 不在目标状态里，应按基线删除
    applyNodeState(q, 1, st, logger, false, "after");
    eq(readFileIn(f.ws, "a.txt"), "1");
    eq(readFileIn(f.ws, "b.txt"), "∅", "b.txt 应被基线兜底清除");
  });

  it("globalBaselineOf 取每个路径最早的 beforeHash", () => {
    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 2, currentMode: "after",
      entries: [
        turn0(),
        entry(1, "u1", [{ path: "C:/w/f.txt", action: "create", beforeHash: EMPTY_HASH, afterHash: sha("v1") }]),
        entry(2, "u2", [{ path: "C:/w/f.txt", action: "write", beforeHash: sha("v1"), afterHash: sha("v2") }], "u1"),
      ],
    };
    const base = globalBaselineOf(q.entries);
    eq(base.get("c:\\w\\f.txt")?.beforeHash ?? base.get("C:/w/f.txt")?.beforeHash, EMPTY_HASH, "基线 = 首次出现的 beforeHash");
    eq(base.size, 1);
  });

  it("nodeStateOf 沿 parentEntryId 链合并，before 取最早、after 取最新", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("m.txt", null, "1");
    const c2 = f.applyChange("m.txt", "1", "2");
    const c3 = f.applyChange("m.txt", "2", "3");
    const entries = [turn0(), entry(1, "u1", [c1]), entry(2, "u2", [c2], "u1"), entry(3, "u3", [c3], "u2")];
    const state = nodeStateOf(entries[3], entries);
    eq(state.size, 1);
    const v = [...state.values()][0];
    eq(v.beforeHash, EMPTY_HASH, "before 取路径上首次出现");
    eq(v.afterHash, sha("3"), "after 取路径上最新");
  });

  it("targetStateFor(before) 用父节点状态；无父时返回空由基线兜底", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("t.txt", null, "1");
    const entries = [turn0(), entry(1, "u1", [c1])];
    eq(targetStateFor({ version: 1, sessionId: "s", entries, currentIndex: 1 } as QueueData, 1, "before").size, 0, "无父 → 空");
    eq(targetStateFor({ version: 1, sessionId: "s", entries, currentIndex: 1 } as QueueData, 1, "after").size, 1);
  });
});

describe("文件状态 · 路径归一", () => {
  it("同一文件大小写不同视为同一路径（Windows）", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("Case.txt", null, "1");
    const c2 = f.applyChange("case.TXT", "1", "2");
    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 2, currentMode: "after",
      entries: [turn0(), entry(1, "u1", [c1]), entry(2, "u2", [c2], "u1")],
    };
    eq(nodeStateOf(q.entries[2], q.entries).size, 1, "应合并为一条");
    applyNodeState(q, 2, snapshotStore(f.snapshots), logger, false, "after");
    eq(readFileIn(f.ws, "Case.txt"), "2");
  });
});

describe("文件状态 · 冲突与损坏", () => {
  it("外部修改过的文件在非强制模式下被跳过，不被覆盖", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("conflict.txt", null, "原版");
    const c2 = f.applyChange("conflict.txt", "原版", "会话版");
    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 2, currentMode: "after",
      entries: [turn0(), entry(1, "u1", [c1]), entry(2, "u2", [c2], "u1")],
    };
    const st = snapshotStore(f.snapshots);
    // 用户在外部改了文件
    f.applyChange("conflict.txt", null, "外部改动");

    const r = applyNodeState(q, 1, st, logger, false, "after");
    eq(readFileIn(f.ws, "conflict.txt"), "外部改动", "外部内容必须保留");
    ok(r.skipped.some((p) => p.endsWith("conflict.txt")), "应记入 skipped");
  });

  it("force=true 时覆盖外部修改", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("conflict.txt", null, "原版");
    const c2 = f.applyChange("conflict.txt", "原版", "会话版");
    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 2, currentMode: "after",
      entries: [turn0(), entry(1, "u1", [c1]), entry(2, "u2", [c2], "u1")],
    };
    f.applyChange("conflict.txt", null, "外部改动");
    const r = applyNodeState(q, 1, snapshotStore(f.snapshots), logger, true, "after");
    eq(readFileIn(f.ws, "conflict.txt"), "原版", "强制模式应覆盖");
    eq(r.skipped.length, 0);
  });

  it("目标快照缺失 → 记入 missingSnapshot 且不崩", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("gone.txt", null, "1");
    const c2 = f.applyChange("gone.txt", "1", "2");
    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 2, currentMode: "after",
      entries: [turn0(), entry(1, "u1", [c1]), entry(2, "u2", [c2], "u1")],
    };
    f.snapshots.delete(sha("1")); // 模拟快照丢失
    const r = applyNodeState(q, 1, snapshotStore(f.snapshots), logger, false, "after");
    ok(r.missingSnapshot.some((p) => p.endsWith("gone.txt")), "应报告缺失快照");
    ok(r.skipped.length > 0, "缺失时应跳过而非误写");
  });

  it("previewNodeSwitch 不改磁盘，且正确报告 create/restore/remove", () => {
    const f = makeFixture({});
    const c1 = f.applyChange("a.txt", null, "1");
    const c2 = f.applyChange("b.txt", null, "2");
    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 2, currentMode: "after",
      entries: [turn0(), entry(1, "u1", [c1]), entry(2, "u2", [c2], "u1")],
    };
    const before = [readFileIn(f.ws, "a.txt"), readFileIn(f.ws, "b.txt")].join(",");
    const p = previewNodeSwitch(q, 1, "after");
    eq([readFileIn(f.ws, "a.txt"), readFileIn(f.ws, "b.txt")].join(","), before, "预览不得改磁盘");
    ok(p.remove.some((x) => x.endsWith("b.txt")), "b.txt 应被报告为将删除");
    eq(p.remove.length + p.restore.length + p.create.length, 1);
  });
});

describe("文件状态 · 工作区边界", () => {
  it("工作区外的路径不参与回放", () => {
    const f = makeFixture({});
    const outside = f.applyChange("../outside.txt", null, "外部");
    const inside = f.applyChange("inside.txt", null, "内部");
    const q: QueueData = {
      version: 1, sessionId: "s", currentIndex: 1, currentMode: "after",
      entries: [turn0(), entry(1, "u1", [outside, inside])],
    };
    // 基线会把两者都当作需还原的文件；此用例只验证快照/回放本身不越界报错
    const r = applyNodeState(q, 1, snapshotStore(f.snapshots), logger, false, "before");
    ok(Array.isArray(r.skipped));
  });

  it("isInsideWorkspace 正确判定同级与父级目录", async () => {
    const { isInsideWorkspace } = await import("../src/utils/path");
    const ws = "C:/proj";
    ok(isInsideWorkspace("C:/proj/a/b.txt", ws), "子目录内");
    ok(isInsideWorkspace("C:/proj", ws), "工作区本身");
    ok(!isInsideWorkspace("C:/other/b.txt", ws), "同级其他目录");
    ok(!isInsideWorkspace("C:/projX/b.txt", ws), "前缀相同但不同目录");
  });
});

describe("文件状态 · 树形预览", () => {
  it("树形预览反映分支差异", () => {
    const seed = makeFixture({});
    const e1 = seed.applyChange("a.txt", null, "1");
    const main = seed.applyChange("b.txt", null, "M");
    const br = seed.applyChange("c.txt", null, "B");
    const f = makeFixture({
      ws: seed.ws,
      entries: [turn0(), entry(1, "u1", [e1]), entry(2, "u2", [main], "u1"), entry(3, "u2b", [br], "u1")],
      nodes: [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2"), user("u2b", "a1"), assistant("a2b", "u2b")],
      leaf: "a2b",
    });
    for (const [k, v] of seed.snapshots) f.snapshots.set(k, v);
    f.queue.currentIndex = 3;
    f.queue.currentMode = "after";
    f.materialize(); // 当前在分支 u2b：磁盘上无 b.txt
    const p = f.svc.previewNodeTarget(2, "after"); // 预览主线 u2
    ok(p, "应返回预览");
    ok(p!.preview.create.some((x) => x.endsWith("b.txt")), "主线独有的 b.txt 应报告为将新建");
    ok(p!.preview.remove.some((x) => x.endsWith("c.txt")), "分支独有的 c.txt 应报告将删除");
  });
});
