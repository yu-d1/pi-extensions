/**
 * 持久化与旧数据兼容。
 */
import { describe, it, eq, ok } from "./harness";
import { assistant, entry, makeFixture, readFileIn, turn0, user } from "./fixtures";
import { currentDiskExpectation } from "../src/core/tree";
import { workspaceId, sanitizeSessionId, queueFileStem } from "../src/storage/layout";
import type { QueueData } from "../src/types";

describe("持久化 · 重启恢复", () => {
  it("重新 startSession 后仍能正确跟随 /tree", () => {
    const seed = makeFixture({});
    const e1 = seed.applyChange("a.txt", null, "1");
    const e2 = seed.applyChange("b.txt", null, "2");
    const f = makeFixture({
      ws: seed.ws,
      entries: [turn0(), entry(1, "u1", [e1]), entry(2, "u2", [e2], "u1")],
      nodes: [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2")],
      leaf: "a2",
    });
    for (const [k, v] of seed.snapshots) f.snapshots.set(k, v);
    f.queue.currentIndex = 2;
    f.queue.currentMode = "after";

    // 退到第1轮后，重启（重读配置与拓扑），再跳回最新
    f.session.navigate("a1");
    eq(readFileIn(f.ws, "b.txt"), "∅");
    f.svc.endSession();
    f.svc.startSession(f.ctx);
    f.session.navigate("a2");
    eq(readFileIn(f.ws, "a.txt"), "1");
    eq(readFileIn(f.ws, "b.txt"), "2");
  });

  it("session 切换后不残留上一会话的工作区状态", () => {
    const f = makeFixture({ nodes: [user("u1", null), assistant("a1", "u1")], leaf: "a1" });
    f.svc.endSession();
    ok(!f.svc.active, "endSession 后应无活跃工作区");
    f.session.navigate("a1"); // 不应崩、不应写盘
    f.svc.startSession(f.ctx);
    ok(f.svc.active, "重新 start 后恢复");
  });
});

describe("兼容 · 旧队列数据", () => {
  it("缺 currentMode 的旧队列按 after 处理", () => {
    const seed = makeFixture({});
    const e1 = seed.applyChange("a.txt", null, "1");
    const q: QueueData = { version: 1, sessionId: "s", currentIndex: 1, entries: [turn0(), entry(1, "u1", [e1])] } as any;
    const expect = currentDiskExpectation(q);
    const v = [...expect.values()][0];
    eq(v.afterHash, e1.afterHash, "无 currentMode 时应取该节点 after 状态");
  });

  it("缺 parentEntryId 的线性旧队列 → ensureParentIds 补全为链", () => {
    const f = makeFixture({
      nodes: [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2"), user("u3", "a2"), assistant("a3", "u3")],
      leaf: "a3",
      entries: [turn0(), entry(1, "u1", []), entry(2, "u2", [], "u1"), entry(3, "u3", [])], // u3 缺 parent
    });
    const queue = f.svc.loadCurrentQueue()!;
    eq(queue.entries[3].parentEntryId, "u2", "应按线性顺序补全父节点");
  });

  it("无 sessionEntryId 的旧条目不参与节点匹配，也不报错", () => {
    const f = makeFixture({
      nodes: [user("u1", null), assistant("a1", "u1")],
      leaf: "a1",
      entries: [turn0(), { turnIndex: 1, text: "旧条目", timestamp: "t1", changes: [] }],
    });
    const before = f.svc.loadCurrentQueue()!.entries.length;
    f.session.navigate("a1");
    eq(f.svc.loadCurrentQueue()!.entries.length, before, "不应新增或丢失条目");
  });

  it("residual 条目不参与树状态合并", () => {
    const seed = makeFixture({});
    const e1 = seed.applyChange("a.txt", null, "1");
    const residual = {
      turnIndex: 2, text: "（未回滚残留）", timestamp: "t2", residual: true,
      changes: [{ path: path2(seed.ws, "a.txt"), action: "write" as const, beforeHash: e1.afterHash, afterHash: e1.afterHash }],
    };
    const f = makeFixture({
      ws: seed.ws,
      entries: [turn0(), entry(1, "u1", [e1]), residual as any],
      nodes: [user("u1", null), assistant("a1", "u1")],
      leaf: "a1",
    });
    for (const [k, v] of seed.snapshots) f.snapshots.set(k, v);
    f.queue.currentIndex = 1;
    f.queue.currentMode = "after";
    f.session.navigate("a1");
    eq(readFileIn(f.ws, "a.txt"), "1", "residual 不得改变节点状态");
  });
});

describe("存储布局", () => {
  it("workspaceId 稳定且无路径分隔符", () => {
    const a = workspaceId("C:/proj");
    const b = workspaceId("C:\\proj");
    eq(a, b, "等价路径应得同一 id");
    ok(!/[+/=]/.test(a), "base64url 不含 + / =");
  });

  it("sanitizeSessionId 清洗非法字符", () => {
    eq(sanitizeSessionId("a/b:c.json"), "a_b_c_json");
    eq(queueFileStem(""), "session", "空 id 回退默认值");
  });
});

function path2(ws: string, rel: string): string {
  return `${ws}\\${rel}`.replace(/\//g, "\\");
}
