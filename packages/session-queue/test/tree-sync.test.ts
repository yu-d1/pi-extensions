/**
 * 跟随 /tree：文件状态必须与 pi 的 newLeafId 语义严格一致。
 *
 * pi 契约（agent-session.js navigateTree）：
 *   选 user / custom_message → newLeafId = target.parentId（文本退回编辑器）
 *   选 assistant / label     → newLeafId = target.id
 *
 * 文件状态只由 newLeafId 决定：
 *   leaf = user 消息 U      → U 所属轮次的「执行前」
 *   leaf 位于 U 之下        → U 所属轮次的「执行后」
 *   leaf = null             → 根（turn 0 空状态）
 */
import { describe, it, eq, ok } from "./harness";
import { assistant, customMessage, entry, label, makeFixture, readFileIn, turn0, user, type Fixture } from "./fixtures";

/** 3 轮主线：u1→a1→u2→a2→u3→a3，每轮新建一个文件。 */
function linear3(): Fixture {
  const f = makeFixture({ nodes: [], leaf: null });
  const e1 = f.applyChange("a.txt", null, "1");
  const e2 = f.applyChange("b.txt", null, "2");
  const e3 = f.applyChange("c.txt", null, "3");
  f.queue.entries = [
    turn0(),
    entry(1, "u1", [e1]),
    entry(2, "u2", [e2], "u1"),
    entry(3, "u3", [e3], "u2"),
  ];
  f.queue.currentIndex = 3;
  f.queue.currentMode = "after";

  const rebuilt = makeFixture({
    ws: f.ws,
    entries: f.queue.entries,
    nodes: [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2"), user("u3", "a2"), assistant("a3", "u3")],
    leaf: "a3",
  });
  // 复用同一份快照表
  for (const [k, v] of f.snapshots) rebuilt.snapshots.set(k, v);
  rebuilt.queue.currentIndex = 3;
  rebuilt.queue.currentMode = "after";
  return rebuilt;
}

const snap = (f: Fixture) => [readFileIn(f.ws, "a.txt"), readFileIn(f.ws, "b.txt"), readFileIn(f.ws, "c.txt")];

describe("跟随 /tree · 主线全节点", () => {
  it("选 user u1 → leaf=根 → 全部清空", () => {
    const f = linear3();
    f.session.navigate("u1");
    eq(snap(f).join(","), "∅,∅,∅");
  });

  it("选 user u2 → leaf=a1 → 第1轮完成后", () => {
    const f = linear3();
    f.session.navigate("u2");
    eq(snap(f).join(","), "1,∅,∅");
  });

  it("选 user u3 → leaf=a2 → 第2轮完成后", () => {
    const f = linear3();
    const r = f.session.navigate("u3");
    eq(r.newLeafId, "a2", "pi 契约：选 user 回到 parent");
    eq(snap(f).join(","), "1,2,∅");
  });

  it("选 assistant a1 → leaf=a1 → 第1轮完成后", () => {
    const f = linear3();
    f.session.navigate("a1");
    eq(snap(f).join(","), "1,∅,∅");
  });

  it("选 assistant a2（中间节点）→ 第2轮完成后", () => {
    const f = linear3();
    f.session.navigate("a2");
    eq(snap(f).join(","), "1,2,∅");
  });

  it("选 assistant a3（跳回现在）→ 完全恢复", () => {
    const f = linear3();
    f.session.navigate("u1");
    eq(snap(f).join(","), "∅,∅,∅", "先退到根");
    f.session.navigate("a3");
    eq(snap(f).join(","), "1,2,3", "跳回最新应完全恢复");
    eq(f.queue.currentIndex, 3);
    eq(f.queue.currentMode, "after");
  });

  it("选 label 节点 → leaf=自身 → 沿父链定位轮次", () => {
    const f = linear3();
    // label 挂在 a2 之后：u1→a1→u2→a2→lbl
    const g = makeFixture({
      ws: f.ws,
      entries: f.queue.entries,
      nodes: [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2"), label("lbl", "a2"), user("u3", "a2"), assistant("a3", "u3")],
      leaf: "a3",
    });
    for (const [k, v] of f.snapshots) g.snapshots.set(k, v);
    g.queue.currentIndex = 3;
    g.queue.currentMode = "after";
    g.session.navigate("lbl");
    eq(g.session.leafId, "lbl", "pi 契约：选 label 时 leaf=自身");
    eq(snap(g).join(","), "1,2,∅", "label 位于第2轮之后 → 第2轮完成态");
  });

  it("选 custom_message → leaf=parent（不是自身）", () => {
    const f = linear3();
    const g = makeFixture({
      ws: f.ws,
      entries: f.queue.entries,
      nodes: [
        user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2"),
        customMessage("cus", "a2"), user("u3", "cus"), assistant("a3", "u3"),
      ],
      leaf: "a3",
    });
    for (const [k, v] of f.snapshots) g.snapshots.set(k, v);
    g.queue.currentIndex = 3;
    g.queue.currentMode = "after";
    const r = g.session.navigate("cus");
    eq(r.newLeafId, "a2", "pi 契约：custom_message 也回到 parent");
    eq(snap(g).join(","), "1,2,∅");
  });
});

describe("跟随 /tree · 前进与往复", () => {
  it("从根逐级前进到最新，每一步都正确", () => {
    const f = linear3();
    f.session.navigate("u1");
    eq(snap(f).join(","), "∅,∅,∅", "根");
    f.session.navigate("a1");
    eq(snap(f).join(","), "1,∅,∅");
    f.session.navigate("u2");
    eq(snap(f).join(","), "1,∅,∅");
    f.session.navigate("a2");
    eq(snap(f).join(","), "1,2,∅");
    f.session.navigate("u3");
    eq(snap(f).join(","), "1,2,∅");
    f.session.navigate("a3");
    eq(snap(f).join(","), "1,2,3");
  });

  it("随机往复 20 次不漂移（状态只由 leaf 决定）", () => {
    const f = linear3();
    const targets = ["u1", "a1", "u2", "a2", "u3", "a3"];
    const expected: Record<string, string> = {
      u1: "∅,∅,∅", a1: "1,∅,∅", u2: "1,∅,∅", a2: "1,2,∅", u3: "1,2,∅", a3: "1,2,3",
      null: "∅,∅,∅",
    };
    for (let i = 0; i < 20; i++) {
      const t = targets[(i * 7 + 3) % targets.length];
      f.session.navigate(t);
      const key = f.session.leafId ?? "null";
      eq(snap(f).join(","), expected[key], `导航到 ${t}（leaf=${key}）`);
    }
  });

  it("重复派发同一 leaf 幂等（不重复写盘刷屏）", () => {
    const f = linear3();
    f.session.navigate("a1");
    const savedAfterFirst = f.savedCount;
    const noticesAfterFirst = f.notices.length;
    for (let i = 0; i < 3; i++) f.session.emit({ type: "session_tree", newLeafId: "a1", oldLeafId: "a1" });
    eq(snap(f).join(","), "1,∅,∅", "磁盘状态不变");
    eq(f.savedCount, savedAfterFirst, "不应重复写盘");
    eq(f.notices.length, noticesAfterFirst, "不应重复通知");
  });

  it("newLeafId 与 oldLeafId 相同 → 无操作", () => {
    const f = linear3();
    const before = snap(f).join(",");
    f.session.emit({ type: "session_tree", newLeafId: "a3", oldLeafId: "a3" });
    eq(snap(f).join(","), before);
  });
});

describe("跟随 /tree · 异常与边界输入", () => {
  it("fromExtension=true → 忽略（扩展自身导航已先行恢复文件）", () => {
    const f = linear3();
    const before = snap(f).join(",");
    f.session.emit({ type: "session_tree", newLeafId: "a1", oldLeafId: "a3", fromExtension: true });
    eq(snap(f).join(","), before, "不应应用");
    eq(f.queue.currentIndex, 3, "队列位置不应变化");
  });

  it("newLeafId = null → 根状态", () => {
    const f = linear3();
    f.session.emit({ type: "session_tree", newLeafId: null, oldLeafId: "a3" });
    eq(snap(f).join(","), "∅,∅,∅");
    eq(f.queue.currentIndex, 0);
    eq(f.queue.currentMode, "before");
  });

  it("未知 leafId → 不动、不崩", () => {
    const f = linear3();
    const before = snap(f).join(",");
    f.session.emit({ type: "session_tree", newLeafId: "不存在", oldLeafId: "a3" });
    eq(snap(f).join(","), before);
    eq(f.queue.currentIndex, 3);
  });

  it("sessionManager 缺 getEntry → 不动、不崩", () => {
    const f = linear3();
    const before = snap(f).join(",");
    f.svc.handleSessionTreeNavigation({ type: "session_tree", newLeafId: "a1", oldLeafId: "a3" }, { sessionManager: {} });
    eq(snap(f).join(","), before);
  });

  it("事件缺少 sessionManager → 不动、不崩", () => {
    const f = linear3();
    const before = snap(f).join(",");
    f.svc.handleSessionTreeNavigation({ type: "session_tree", newLeafId: "a1", oldLeafId: "a3" }, {});
    eq(snap(f).join(","), before);
  });

  it("空队列 → 不动、不崩", () => {
    const f = makeFixture({ ws: undefined, nodes: [user("u1", null), assistant("a1", "u1")], leaf: "a1" });
    f.queue.entries = [];
    f.session.navigate("a1");
    ok(true, "未抛异常即通过");
  });

  it("leaf 祖先链上无任何检查点 → 不动", () => {
    const f = linear3();
    // 这棵树与队列的 sessionEntryId 完全无关：pre1→prea→pre2→preb 均无对应 entry。
    const g = makeFixture({
      ws: f.ws,
      entries: f.queue.entries,
      nodes: [user("pre1", null), assistant("prea", "pre1"), user("pre2", "prea"), assistant("preb", "pre2")],
      leaf: "preb",
    });
    for (const [k, v] of f.snapshots) g.snapshots.set(k, v);
    g.queue.currentIndex = 3;
    g.queue.currentMode = "after";
    g.materialize();
    const before = [readFileIn(g.ws, "a.txt"), readFileIn(g.ws, "b.txt"), readFileIn(g.ws, "c.txt")].join(",");
    g.session.navigate("pre2");
    eq(g.session.leafId, "prea");
    eq(
      [readFileIn(g.ws, "a.txt"), readFileIn(g.ws, "b.txt"), readFileIn(g.ws, "c.txt")].join(","),
      before,
      "祖先链上没有检查点，不应误触发回滚",
    );
  });

  it("祖先中部分轮次无检查点 → 跳到最近的带检查点祖先", () => {
    // u1(有检查点) → u2(无检查点) → u3(有检查点)：leaf 落在 u3 之下
    const f = makeFixture({
      nodes: [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2"), user("u3", "a2"), assistant("a3", "u3")],
      leaf: "a3",
      entries: [
        turn0(),
        { ...entry(1, "u1", []), changes: [] },
      ],
    });
    // 手工写入一条有文件变更的 entry
    const chg = f.applyChange("only.txt", null, "X");
    f.queue.entries = [turn0(), entry(1, "u1", [chg])];
    f.queue.currentIndex = 1;
    f.queue.currentMode = "after";
    f.session.navigate("u2");
    // leaf = a1（u1 之后），最近带检查点的 user 是 u1 → after
    eq(f.session.leafId, "a1");
    eq(readFileIn(f.ws, "only.txt"), "X");
    f.session.navigate("u3");
    eq(f.session.leafId, "a2");
    eq(readFileIn(f.ws, "only.txt"), "X");
  });
});

describe("跟随开关", () => {
  it("关闭时不跟随，重新开启后恢复", () => {
    const f = linear3();
    f.config.followSessionTree = false;
    f.svc.startSession(f.ctx); // startSession 会重读配置
    f.session.navigate("u1");
    eq(snap(f).join(","), "1,2,3", "关闭时不应改文件");
    eq(f.queue.currentIndex, 3);

    f.config.followSessionTree = true;
    f.svc.startSession(f.ctx);
    f.session.navigate("u1");
    eq(snap(f).join(","), "∅,∅,∅", "重新开启后应跟随");
  });

  it("关闭期间多次导航，重新开启后不残留旧目标（回归：pendingTreeTargetId 泄漏）", () => {
    const f = linear3();
    f.config.followSessionTree = false;
    f.svc.startSession(f.ctx);
    f.session.navigate("u1");
    f.session.navigate("u2");
    f.session.navigate("a2");
    eq(snap(f).join(","), "1,2,3", "关闭期间磁盘不动");

    f.config.followSessionTree = true;
    f.svc.startSession(f.ctx);
    // 重新开启后的第一次导航必须按「新 leaf」判断，不能用上一次遗留的 target
    f.session.navigate("a1");
    eq(snap(f).join(","), "1,∅,∅", "应跟随本次 leaf=a1");
    eq(f.queue.currentIndex, 1);
    eq(f.queue.currentMode, "after");
  });
});

describe("跟随 /tree · 通知", () => {
  it("发生实际变更时给出通知", () => {
    const f = linear3();
    f.notices.length = 0;
    f.session.navigate("a1");
    ok(f.notices.length > 0, "应产生通知");
    ok(/Session Tree 导航/.test(f.notices[0].message), `通知内容异常：${f.notices[0]?.message}`);
  });

  it("目标状态已满足时不通知", () => {
    const f = linear3();
    f.session.navigate("a3");
    f.notices.length = 0;
    f.session.emit({ type: "session_tree", newLeafId: "a3", oldLeafId: "a1" });
    eq(f.notices.length, 0, "磁盘已是目标态，不应刷屏");
  });
});
