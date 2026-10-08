/**
 * 变更追踪：edit/write 工具与 bash 的 rm/mv/重定向。
 */
import { describe, it, eq, ok } from "./harness";
import { ChangeTracker } from "../src/core/change-tracker";
import { parseFileOperations } from "../src/shell/parser-lite";
import { makeWorkspace, writeFileIn, cleanupWorkspaces } from "./fixtures";
import * as path from "node:path";

function trackerWith(ws: string) {
  const t = new ChangeTracker();
  t.start(ws, ws);
  return t;
}

describe("变更追踪 · write/edit 工具", () => {
  it("write 新建文件 → action=create", () => {
    const ws = makeWorkspace("trk");
    const t = trackerWith(ws);
    t.onWriteToolCall("write", { path: "n.txt" });
    writeFileIn(ws, "n.txt", "hi");
    t.onWriteToolResult("write", { path: "n.txt" });
    const c = t.collect();
    eq(c.length, 1);
    eq(c[0].action, "create");
    eq(c[0].afterContent, "hi");
    cleanupWorkspaces();
  });

  it("edit 修改已有文件 → action=write", () => {
    const ws = makeWorkspace("trk");
    writeFileIn(ws, "e.txt", "old");
    const t = trackerWith(ws);
    t.onWriteToolCall("edit", { path: "e.txt" });
    writeFileIn(ws, "e.txt", "new");
    t.onWriteToolResult("edit", { path: "e.txt" });
    const c = t.collect();
    eq(c[0].action, "write");
    eq(c[0].beforeContent, "old");
    eq(c[0].afterContent, "new");
    cleanupWorkspaces();
  });

  it("相对路径按 tool cwd 解析", () => {
    const ws = makeWorkspace("trk");
    const sub = path.join(ws, "sub");
    const t = trackerWith(ws);
    t.onWriteToolCall("write", { path: "rel.txt", cwd: sub });
    writeFileIn(sub, "rel.txt", "x");
    t.onWriteToolResult("write", { path: "rel.txt", cwd: sub });
    const c = t.collect();
    eq(c.length, 1);
    eq(path.normalize(c[0].path), path.normalize(path.join(sub, "rel.txt")));
    cleanupWorkspaces();
  });

  it("内容未变化 → 不记录", () => {
    const ws = makeWorkspace("trk");
    writeFileIn(ws, "same.txt", "v");
    const t = trackerWith(ws);
    t.onWriteToolCall("write", { path: "same.txt" });
    t.onWriteToolResult("write", { path: "same.txt" });
    eq(t.collect().length, 0, "无实际变化不应产生检查点");
    cleanupWorkspaces();
  });

  it("工作区外路径被忽略", () => {
    const ws = makeWorkspace("trk");
    const t = trackerWith(ws);
    t.onWriteToolCall("write", { path: path.join(ws, "..", "escape.txt") });
    t.onWriteToolResult("write", { path: path.join(ws, "..", "escape.txt") });
    eq(t.collect().length, 0, "不得跟踪工作区外文件");
    cleanupWorkspaces();
  });

  it("非 write 工具被忽略", () => {
    const ws = makeWorkspace("trk");
    const t = trackerWith(ws);
    t.onWriteToolCall("read", { path: "r.txt" });
    t.onWriteToolResult("read", { path: "r.txt" });
    eq(t.collect().length, 0);
    cleanupWorkspaces();
  });
});

describe("变更追踪 · bash", () => {
  it("rm 被跟踪（before 存在、after 消失 → delete）", () => {
    const ws = makeWorkspace("trk");
    writeFileIn(ws, "del.txt", "bye");
    const t = trackerWith(ws);
    t.onBashToolCall({ command: "rm del.txt" });
    writeFileIn(ws, "del.txt", null);
    t.onBashToolResult();
    const c = t.collect();
    eq(c.length, 1);
    eq(c[0].action, "delete");
    ok(c[0].viaBash, "应标记 viaBash");
    cleanupWorkspaces();
  });

  it("重定向创建文件被跟踪", () => {
    const ws = makeWorkspace("trk");
    const t = trackerWith(ws);
    t.onBashToolCall({ command: "echo hi > out.txt" });
    writeFileIn(ws, "out.txt", "hi\n");
    t.onBashToolResult();
    const c = t.collect();
    eq(c.length, 1);
    eq(c[0].action, "create");
    cleanupWorkspaces();
  });

  it("mv 源与目标都被跟踪", () => {
    const ws = makeWorkspace("trk");
    writeFileIn(ws, "src.txt", "data");
    const t = trackerWith(ws);
    t.onBashToolCall({ command: "mv src.txt dst.txt" });
    writeFileIn(ws, "src.txt", null);
    writeFileIn(ws, "dst.txt", "data");
    t.onBashToolResult();
    const c = t.collect();
    eq(c.length, 2, "src(删除) + dst(创建) 都应记录");
    cleanupWorkspaces();
  });

  it("带引号的含空格路径", () => {
    const ws = makeWorkspace("trk");
    writeFileIn(ws, "my file.txt", "x");
    const t = trackerWith(ws);
    t.onBashToolCall({ command: 'rm "my file.txt"' });
    writeFileIn(ws, "my file.txt", null);
    t.onBashToolResult();
    eq(t.collect().length, 1);
    cleanupWorkspaces();
  });

  it("glob 展开命中多个文件", () => {
    const ws = makeWorkspace("trk");
    writeFileIn(ws, "g1.txt", "1");
    writeFileIn(ws, "g2.txt", "2");
    writeFileIn(ws, "g3.log", "3");
    const t = trackerWith(ws);
    t.onBashToolCall({ command: "rm *.txt" });
    writeFileIn(ws, "g1.txt", null);
    writeFileIn(ws, "g2.txt", null);
    t.onBashToolResult();
    eq(t.collect().length, 2, "只命中 .txt");
    cleanupWorkspaces();
  });

  it("复合命令中的 rm 也能识别", () => {
    const ws = makeWorkspace("trk");
    writeFileIn(ws, "sub/drop.txt", "d");
    const t = trackerWith(ws);
    t.onBashToolCall({ command: "ls sub && rm sub/drop.txt; echo done" });
    writeFileIn(ws, "sub/drop.txt", null);
    t.onBashToolResult();
    const c = t.collect();
    ok(c.some((x) => x.path.endsWith("drop.txt")), "应识别 && 与 ; 之后的 rm");
    cleanupWorkspaces();
  });

  it("已知限制：cd 到子目录后的相对路径仍按工作区解析（现状锁定）", () => {
    // parser-lite 不维护 cd 上下文，相对路径一律以工作区为基准；
    // 因此 `cd sub && rm drop.txt` 会被当成 rm <ws>/drop.txt 而漏跟。
    const ws = makeWorkspace("trk");
    writeFileIn(ws, "sub/drop.txt", "d");
    const t = trackerWith(ws);
    t.onBashToolCall({ command: "cd sub && rm drop.txt" });
    writeFileIn(ws, "sub/drop.txt", null);
    t.onBashToolResult();
    eq(t.collect().length, 0, "当前实现会漏跟，锁定现状以便后续改进时能被发现");
    cleanupWorkspaces();
  });

  it("bash 命令里的绝对路径（正斜杠）正常跟踪", () => {
    const ws = makeWorkspace("trk");
    const abs = path.join(ws, "abs.txt");
    writeFileIn(ws, "abs.txt", "x");
    const t = trackerWith(ws);
    t.onBashToolCall({ command: `rm ${abs.split(path.sep).join("/")}` });
    writeFileIn(ws, "abs.txt", null);
    t.onBashToolResult();
    eq(t.collect().length, 1);
    cleanupWorkspaces();
  });
});

describe("bash 解析", () => {
  it("识别 rm / del", () => {
    eq(parseFileOperations("rm a.txt b.txt").rmTargets.join(","), "a.txt,b.txt");
    eq(parseFileOperations("rm -rf build/").rmTargets.join(","), "build/");
    eq(parseFileOperations('del "C:\\tmp\\x.txt"').rmTargets.join(","), "C:\\tmp\\x.txt");
  });

  it("已知限制：未加引号的反斜杠路径会被当作转义（现状锁定）", () => {
    // tokenize 对 `\\` 统一按 shell 转义处理，未加引号时 `\\t` → `t`。
    // Git Bash 下用户习惯写正斜杠，故此处锁定现状而非断言期望值。
    eq(parseFileOperations("del C:\\tmp\\x.txt").rmTargets.join(","), "C:tmpx.txt");
  });

  it("识别 mv 多个源", () => {
    const pairs = parseFileOperations("mv a.txt b.txt dest/").mvPairs;
    eq(pairs.length, 2);
    eq(pairs[0][0], "a.txt");
    eq(pairs[1][1], "dest/");
  });

  it("识别 > 与 >>，不把 >& 当重定向", () => {
    eq(parseFileOperations("echo x > a.txt").redirectTargets.join(","), "a.txt");
    eq(parseFileOperations("echo x >> a.txt").redirectTargets.join(","), "a.txt");
    eq(parseFileOperations("cmd 2>&1").redirectTargets.length, 0, "2>&1 不是文件重定向");
    eq(parseFileOperations("cmd > /dev/null").redirectTargets.join(","), "/dev/null");
  });

  it("引号内的 > 不当作重定向", () => {
    eq(parseFileOperations('echo "a > b"').redirectTargets.length, 0);
    eq(parseFileOperations("echo 'a > b'").redirectTargets.length, 0);
  });

  it("已知限制：heredoc 正文里的 > 仍会被识别（parser-lite 不解析 heredoc）", () => {
    // 文件头已声明「不做 here-doc」；这里锁定现状，避免以后静默变化。
    ok(parseFileOperations("cat <<'EOF'\n> not a redirect\nEOF").redirectTargets.length > 0);
  });

  it("空命令安全返回", () => {
    const r = parseFileOperations("   ");
    eq(r.rmTargets.length + r.mvPairs.length + r.redirectTargets.length, 0);
  });
});
