/**
 * 分支：主/支线切换、新分支创建、深链导航。
 */
import { describe, it, eq, ok } from "./harness";
import { assistant, entry, makeFixture, readFileIn, turn0, user, type Fixture } from "./fixtures";

/**
 * 主线 u1→a1→u2→a2，分支 u2b 从 a1 拉出 → a2b。
 * u2 建 b.txt，u2b 建 c.txt。
 */
function twoBranches(): Fixture {
  const seed = makeFixture({});
  const e1 = seed.applyChange("a.txt", null, "1");
  const e2 = seed.applyChange("b.txt", null, "2");
  const e2b = seed.applyChange("c.txt", null, "3B");
  const entries = [
    turn0(),
    entry(1, "u1", [e1]),
    entry(2, "u2", [e2], "u1"),
    entry(3, "u2b", [e2b], "u1"),
  ];
  const f = makeFixture({
    ws: seed.ws,
    entries,
    nodes: [
      user("u1", null), assistant("a1", "u1"),
      user("u2", "a1"), assistant("a2", "u2"),
      user("u2b", "a1"), assistant("a2b", "u2b"),
    ],
    leaf: "a2b",
  });
  for (const [k, v] of seed.snapshots) f.snapshots.set(k, v);
  f.queue.currentIndex = 3;
  f.queue.currentMode = "after";
  f.materialize(); // 当前在分支 u2b：b.txt 属另一支线，磁盘上不应存在
  return f;
}

const snap = (f: Fixture) => [readFileIn(f.ws, "a.txt"), readFileIn(f.ws, "b.txt"), readFileIn(f.ws, "c.txt")];

describe("分支 · 主支线往返", () => {
  it("切到分支各节点状态正确", () => {
    const f = twoBranches();
    f.session.navigate("u2b");
    eq(f.session.leafId, "a1", "选 user 回到 parent=分叉点");
    eq(snap(f).join(","), "1,∅,∅");

    f.session.navigate("a2b");
    eq(snap(f).join(","), "1,∅,3B", "分支末");

    f.session.navigate("u2");
    eq(snap(f).join(","), "1,∅,∅", "分叉点：c.txt 属另一支线，应清掉");

    f.session.navigate("a2");
    eq(snap(f).join(","), "1,2,∅", "主线末：b.txt 存在，c.txt 不存在");

    f.session.navigate("u1");
    eq(snap(f).join(","), "∅,∅,∅", "根");
  });

  it("主线与分支反复切换 12 次不串味", () => {
    const f = twoBranches();
    const seq = ["a2", "a2b", "u2", "a2b", "u2b", "a2", "a2b", "u2b", "u2", "a2", "u2b", "a2b"];
    const expect: Record<string, string> = {
      a1: "1,∅,∅", a2: "1,2,∅", a2b: "1,∅,3B", null: "∅,∅,∅",
    };
    for (const t of seq) {
      f.session.navigate(t);
      eq(snap(f).join(","), expect[f.session.leafId ?? "null"], `导航 ${t}（leaf=${f.session.leafId}）`);
    }
  });

  it("两条支线各自修改同一文件，互不覆盖", () => {
    const seed = makeFixture({});
    const e1 = seed.applyChange("shared.txt", null, "base");
    const mainChg = seed.applyChange("shared.txt", "base", "主线");
    const brChg = seed.applyChange("shared.txt", "base", "分支");
    const f = makeFixture({
      ws: seed.ws,
      entries: [turn0(), entry(1, "u1", [e1]), entry(2, "u2", [mainChg], "u1"), entry(3, "u2b", [brChg], "u1")],
      nodes: [
        user("u1", null), assistant("a1", "u1"),
        user("u2", "a1"), assistant("a2", "u2"),
        user("u2b", "a1"), assistant("a2b", "u2b"),
      ],
      leaf: "a2b",
    });
    for (const [k, v] of seed.snapshots) f.snapshots.set(k, v);
    f.queue.currentIndex = 3;
    f.queue.currentMode = "after";
    f.materialize();
    eq(readFileIn(f.ws, "shared.txt"), "分支");

    f.session.navigate("a2");
    eq(readFileIn(f.ws, "shared.txt"), "主线", "切到主线应是主线的内容");

    f.session.navigate("a2b");
    eq(readFileIn(f.ws, "shared.txt"), "分支", "切回分支应恢复分支内容");
  });
});

describe("分支 · 导航后新建分支", () => {
  /** 真实走 flushTurn：模拟「回到历史节点后继续对话」产生新检查点。 */
  function flushNewTurn(f: Fixture, userId: string, rel: string, content: string) {
    // 工具写入文件
    f.applyChange(rel, null, content);
    // 让 sessionManager.getBranch() 的叶子落在新 user 上
    f.session.setLeaf(userId);
    f.svc.handleToolCall({ toolName: "write", input: { path: rel } });
    f.svc.handleToolResult({ toolName: "write", input: { path: rel } });
    f.svc.flushTurn(f.ctx);
  }

  it("回到历史节点后新对话 → 生成挂在该节点下的检查点，旧记录保留", () => {
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

    // 退到第1轮之后（leaf=a1），此处发新问题 u3 → 应从 a1 分叉
    f.session.setLeaf("a1");
    f.session.addNode(user("u3", "a1", "u3"));
    f.session.addNode(assistant("a3", "u3"));

    const before = f.queue.entries.length;
    flushNewTurn(f, "u3", "new.txt", "N");

    ok(f.queue.entries.length > before, "应新增检查点");
    const added = f.queue.entries[f.queue.entries.length - 1];
    eq(added.sessionEntryId, "u3");
    eq(added.parentEntryId, "u1", "新分支应挂在 u1（当前 leaf 所属轮次）之下，而非线性接在 u2 后");
    ok(f.queue.entries.some((e) => e.sessionEntryId === "u2"), "旧主线记录必须保留");
    eq(f.queue.entries.length, before + 1, "只新增一条，不截断旧记录");
  });
});

describe("分支 · 深链", () => {
  it("5 轮深链逐级导航", () => {
    const seed = makeFixture({});
    const files = ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"];
    const changes = files.map((n, i) => seed.applyChange(n, null, String(i + 1)));

    // u1→a1→u2→a2→...→u5→a5
    const nodes: ReturnType<typeof user>[] = [];
    const entries = [turn0()];
    let prevAssistantId: string | null = null;
    for (let i = 1; i <= 5; i++) {
      nodes.push(user(`u${i}`, prevAssistantId, `u${i}`));
      nodes.push(assistant(`a${i}`, `u${i}`));
      entries.push(entry(i, `u${i}`, [changes[i - 1]], i === 1 ? undefined : `u${i - 1}`));
      prevAssistantId = `a${i}`;
    }

    const f = makeFixture({ ws: seed.ws, entries, nodes, leaf: "a5" });
    for (const [k, v] of seed.snapshots) f.snapshots.set(k, v);
    f.queue.currentIndex = 5;
    f.queue.currentMode = "after";

    const expect: Record<string, string> = {
      u1: "∅,∅,∅,∅,∅", a1: "1,∅,∅,∅,∅",
      u2: "1,∅,∅,∅,∅", a2: "1,2,∅,∅,∅",
      u3: "1,2,∅,∅,∅", a3: "1,2,3,∅,∅",
      u4: "1,2,3,∅,∅", a4: "1,2,3,4,∅",
      u5: "1,2,3,4,∅", a5: "1,2,3,4,5",
    };
    for (const t of Object.keys(expect)) {
      f.session.navigate(t);
      const got = files.map((n) => readFileIn(f.ws, n)).join(",");
      eq(got, expect[t], `导航 ${t}（leaf=${f.session.leafId}）`);
    }
  });
});
