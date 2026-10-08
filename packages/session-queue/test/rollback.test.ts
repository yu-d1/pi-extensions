/**
 * /rollback 与 /tree 交错：不得重复应用、状态不得串味。
 */
import { describe, it, eq, ok } from "./harness";
import { assistant, entry, makeFixture, readFileIn, turn0, user, type Fixture } from "./fixtures";

/** 主线 u1→a1→u2→a2→u3→a3，每轮新建一个文件。 */
function linear3(): Fixture {
  const seed = makeFixture({});
  const e1 = seed.applyChange("a.txt", null, "1");
  const e2 = seed.applyChange("b.txt", null, "2");
  const e3 = seed.applyChange("c.txt", null, "3");
  const f = makeFixture({
    ws: seed.ws,
    entries: [turn0(), entry(1, "u1", [e1]), entry(2, "u2", [e2], "u1"), entry(3, "u3", [e3], "u2")],
    nodes: [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2"), user("u3", "a2"), assistant("a3", "u3")],
    leaf: "a3",
  });
  for (const [k, v] of seed.snapshots) f.snapshots.set(k, v);
  f.queue.currentIndex = 3;
  f.queue.currentMode = "after";
  return f;
}

const snap = (f: Fixture) => [readFileIn(f.ws, "a.txt"), readFileIn(f.ws, "b.txt"), readFileIn(f.ws, "c.txt")];

describe("/rollback · 基础", () => {
  it("回滚到 u1 发送前 → 全部清空且移动 leaf", async () => {
    const f = linear3();
    const r = await f.svc.rollbackToConversation(1, f.ctx, false);
    eq(snap(f).join(","), "∅,∅,∅");
    eq(r.result.restored + r.result.deleted, 3, "一次到位，不应重复应用");
    eq(f.session.leafId, null, "pi 应把 leaf 移到 u1 的 parent");
    eq(f.queue.currentIndex, 1);
    eq(f.queue.currentMode, "before");
  });

  it("回滚后 session_tree 事件不重复应用", async () => {
    const f = linear3();
    const savedBefore = f.savedCount;
    await f.svc.rollbackToConversation(1, f.ctx, false);
    // rollbackToConversation 内部会触发 navigateTree → session_tree(fromExtension)
    // 额外再补发一次非扩展来源的事件，模拟竞态
    f.session.emit({ type: "session_tree", newLeafId: null, oldLeafId: "a3" });
    eq(snap(f).join(","), "∅,∅,∅", "磁盘状态保持");
    eq(f.queue.currentIndex, 1, "队列位置不应被后续事件改写");
    ok(f.savedCount >= savedBefore);
  });

  it("连续回滚两次 → 状态递进", async () => {
    const f = linear3();
    await f.svc.rollbackToConversation(3, f.ctx, false);
    eq(snap(f).join(","), "1,2,∅", "u3 发送前 = 第2轮完成");
    await f.svc.rollbackToConversation(2, f.ctx, false);
    eq(snap(f).join(","), "1,∅,∅", "u2 发送前 = 第1轮完成");
    await f.svc.rollbackToConversation(1, f.ctx, false);
    eq(snap(f).join(","), "∅,∅,∅");
  });
});

describe("/rollback ↔ /tree 交错", () => {
  it("rollback → /tree 导航", async () => {
    const f = linear3();
    await f.svc.rollbackToConversation(1, f.ctx, false);
    eq(snap(f).join(","), "∅,∅,∅");
    f.session.navigate("a3");
    eq(snap(f).join(","), "1,2,3", "回滚后 /tree 仍能恢复到最新");
  });

  it("/tree 导航 → rollback", () => {
    const f = linear3();
    f.session.navigate("a1");
    eq(snap(f).join(","), "1,∅,∅");
    return f.svc.rollbackToConversation(3, f.ctx, false).then(() => {
      eq(snap(f).join(","), "1,2,∅", "rollback 到 u3 发送前");
    });
  });

  it("/tree → /tree → /rollback → /tree 反复", async () => {
    const f = linear3();
    f.session.navigate("u1");
    eq(snap(f).join(","), "∅,∅,∅");
    f.session.navigate("a2");
    eq(snap(f).join(","), "1,2,∅");
    await f.svc.rollbackToConversation(1, f.ctx, false);
    eq(snap(f).join(","), "∅,∅,∅");
    f.session.navigate("a3");
    eq(snap(f).join(","), "1,2,3");
    f.session.navigate("a1");
    eq(snap(f).join(","), "1,∅,∅");
  });

  it("rollback 后队列 currentMode 与磁盘一致（冲突检测基准正确）", async () => {
    const f = linear3();
    await f.svc.rollbackToConversation(2, f.ctx, false);
    eq(f.queue.currentMode, "before");
    eq(f.queue.currentIndex, 2);
    // 紧接着导航到最新：不应因 currentMode 基准错判而跳过冲突
    f.session.navigate("a3");
    eq(snap(f).join(","), "1,2,3");
  });
});

describe("/rollback · 手动线性回滚", () => {
  it("executeManualRollback 截断队列并保留恢复结果", () => {
    const f = linear3();
    const queue = f.svc.loadCurrentQueue()!;
    const plan = f.svc.planRollback(queue, 1, false);
    eq(plan.conflictPaths.length, 0, "无外部改动时不应有冲突");
    const r = f.svc.executeManualRollback(queue, 1, plan);
    eq(r.queue.entries.length, 1, "队列应被截断到目标之前");
    eq(readFileIn(f.ws, "c.txt"), "∅", "被丢弃轮次的文件应回退");
    eq(f.queue.entries.length, 1);
  });

  it("有冲突时跳过并生成 residual 待重试", () => {
    const f = linear3();
    f.applyChange("b.txt", null, "外部改动"); // 制造冲突
    const queue = f.svc.loadCurrentQueue()!;
    const plan = f.svc.planRollback(queue, 1, false);
    ok(plan.conflictPaths.length > 0, "应检出冲突");
    const r = f.svc.executeManualRollback(queue, 1, plan);
    eq(readFileIn(f.ws, "b.txt"), "外部改动", "冲突文件不覆盖");
    ok(r.queue.entries.some((e) => e.residual), "应生成 residual 待重试条目");
  });

  it("force 模式无视冲突", () => {
    const f = linear3();
    f.applyChange("b.txt", null, "外部改动");
    const queue = f.svc.loadCurrentQueue()!;
    const plan = f.svc.planRollback(queue, 1, true);
    eq(plan.conflictPaths.length, 0, "force 不报冲突");
    f.svc.executeManualRollback(queue, 1, plan);
    eq(readFileIn(f.ws, "b.txt"), "∅", "force 应回退冲突文件");
  });
});
