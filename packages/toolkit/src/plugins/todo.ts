/**
 * 子插件：Todo 面板（todo 工具 + 悬浮面板 + 自动续跑）
 *
 * 原插件地址：https://github.com/juicesharp/rpiv-pi
 * 同步基线：7525a5d (@juicesharp/rpiv-todo) · 协议：MIT
 * 本地改写：移除 rpiv-config / rpiv-i18n 依赖与独立 /todos 命令，
 *           操作菜单收口至 /toolkit 配置菜单及 /toolkit todo 子命令。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PluginStore, ToolkitPlugin } from "../types.js";
import registerTodoExtension from "./todo/index.js";
import { getTodos } from "./todo/state/store.js";
import { renderTodosText } from "./todo/todo.js";

const EXEC_STATUS_KEY = "toolkit:todo-exec";
/** 自动执行的最大轮次，防模型反复横跳停不下来。 */
const MAX_EXEC_ROUNDS = 20;

let api: ExtensionAPI | undefined;
/** `/toolkit → 配置 → Todo → 执行` 的自动续跑状态（仅存内存，重启后不自动开跑）。 */
let execRun: { rounds: number } | null = null;

const buildExecPrompt = (lines: string[]): string =>
  [
    "按以下待办逐项推进，全部完成或明确受阻时停止：",
    ...lines.map((l) => `  ${l}`),
    "",
    "推进要求：",
    "1. 每项做完立刻把状态标为 completed，不要把已完成的事项留在 pending",
    "2. 项与项之间相互独立就直接依次执行，不要停下来请示",
    "3. 遇阻时说明卡在哪、已完成到哪一步，再停止",
  ].join("\n");

function todoCounts(ctx: ExtensionContext) {
  const tasks = getTodos(ctx.sessionManager.getSessionId()).filter((t) => t.status !== "deleted");
  const done = tasks.filter((t) => t.status === "completed").length;
  return { total: tasks.length, done, pending: tasks.length - done };
}

function updateExecStatus(ctx: ExtensionContext): void {
  if (!ctx?.ui?.setStatus) return;
  if (!execRun) {
    ctx.ui.setStatus(EXEC_STATUS_KEY, undefined);
    return;
  }
  const c = todoCounts(ctx);
  const text = `🐐 ${c.done}/${c.total} · 轮次 ${execRun.rounds + 1}/${MAX_EXEC_ROUNDS}`;
  try {
    const fg = ctx.ui.theme?.fg?.bind(ctx.ui.theme);
    ctx.ui.setStatus(EXEC_STATUS_KEY, fg ? fg("accent", text) : text);
  } catch {
    ctx.ui.setStatus(EXEC_STATUS_KEY, text);
  }
}

function finishExec(ctx: ExtensionContext, reason: string): void {
  execRun = null;
  updateExecStatus(ctx);
  ctx.ui.notify(reason, "info");
}

function pendingTodoLines(ctx: ExtensionContext): string[] {
  return getTodos(ctx.sessionManager.getSessionId())
    .filter((t) => t.status === "pending" || t.status === "in_progress")
    .map((t) => `${t.id}. ${t.subject}`);
}

function ensureReady(ctx: ExtensionContext, store: PluginStore<Record<string, never>>): ExtensionAPI | null {
  if (!api || !store.isEnabled()) {
    ctx.ui.notify("Todo 面板当前未启用或未加载，请在 /toolkit → 启用 中开启并执行 /reload", "info");
    return null;
  }
  return api;
}

async function startExec(ctx: ExtensionContext, store: PluginStore<Record<string, never>>): Promise<void> {
  const runtimeApi = ensureReady(ctx, store);
  if (!runtimeApi) return;

  const { pending } = todoCounts(ctx);
  if (pending === 0) {
    ctx.ui.notify("没有待完成的 todo", "info");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("执行 todo 需要在交互式（TUI）模式下使用", "error");
    return;
  }
  execRun = { rounds: 0 };
  updateExecStatus(ctx);
  const lines = pendingTodoLines(ctx);
  if (lines.length === 0) {
    finishExec(ctx, "待办清单已空，无需执行");
    return;
  }
  await runtimeApi.sendUserMessage(buildExecPrompt(lines), { deliverAs: "steer" });
}

async function startCheck(ctx: ExtensionContext, store: PluginStore<Record<string, never>>): Promise<void> {
  const runtimeApi = ensureReady(ctx, store);
  if (!runtimeApi) return;

  const { total, done } = todoCounts(ctx);
  if (total === 0) {
    ctx.ui.notify("还没有 todo，先让模型制定计划", "info");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("检查 todo 需要在交互式（TUI）模式下使用", "error");
    return;
  }
  const text = renderTodosText(ctx);
  if (text === null) {
    ctx.ui.notify("当前分支没有可见 todo", "info");
    return;
  }
  ctx.ui.notify(`检查 ${total} 项 todo（已完成 ${done} 项）`, "info");
  const tasks = getTodos(ctx.sessionManager.getSessionId()).filter((t) => t.status !== "deleted");
  await runtimeApi.sendUserMessage(
    [
      "逐项核对下列 todo 的状态与仓库实际进展是否一致：",
      ...tasks.map((t) => `  #${t.id} ${t.subject}（当前标记为 ${t.status}）`),
      "",
      "核对规则：",
      "1. 实际已完成但状态仍为 pending 的，改为 completed",
      "2. 实际未完成却标为 completed 的，改回 in_progress 或 pending",
      "3. 无法确认的先保留原状态，并在末尾说明为什么不确定",
      "4. 只改状态，不要新增、删除任务，不要动手改代码或文件",
    ].join("\n"),
    { deliverAs: "steer" },
  );
}

function showTodos(ctx: ExtensionContext, store: PluginStore<Record<string, never>>): void {
  if (!ensureReady(ctx, store)) return;
  if (!ctx.hasUI) {
    ctx.ui.notify("查看 todo 需要在交互式（TUI）模式下使用", "error");
    return;
  }
  const text = renderTodosText(ctx);
  if (text === null) ctx.ui.notify("当前分支还没有 todo", "info");
  else ctx.ui.notify(text, "info");
}

async function openTodoMenu(
  ctx: ExtensionContext,
  store: PluginStore<Record<string, never>>,
): Promise<"close" | void> {
  if (!ensureReady(ctx, store)) return "close";

  const { total, done, pending } = todoCounts(ctx);
  if (total === 0) {
    ctx.ui.notify("还没有 todo，先让模型制定计划", "info");
    return "close";
  }

  const abortLabel = "⏹ 中止自动执行";
  const execLabel = execRun
    ? `${abortLabel}（第 ${execRun.rounds + 1}/${MAX_EXEC_ROUNDS} 轮 · ${done}/${total}）`
    : `▶️ 执行全部待办（剩 ${pending} 项）`;
  const choice = await ctx.ui.select("Todo 任务", [
    execLabel,
    "🔍 检查并标注状态",
    "📋 查看任务列表",
    "返回",
  ]);
  if (!choice || choice === "返回") return;

  if (choice.startsWith(abortLabel)) {
    finishExec(ctx, `已中止自动执行（第 ${execRun?.rounds ?? 0} 轮 · ${done}/${total}）`);
    return "close";
  }
  if (choice.startsWith("▶️")) {
    await startExec(ctx, store);
    return "close";
  }
  if (choice.startsWith("🔍")) {
    await startCheck(ctx, store);
    return "close";
  }
  showTodos(ctx, store);
  return "close";
}

export const todoPlugin: ToolkitPlugin<Record<string, never>> = {
  id: "todo",
  name: "Todo 面板",
  icon: "📋",
  description: "任务追踪悬浮面板与待办自动续跑",
  defaultEnabled: true,
  defaultSettings: {},
  requiresReload: true,
  upstream: {
    repo: "https://github.com/juicesharp/rpiv-pi",
    ref: "7525a5d (@juicesharp/rpiv-todo)",
    license: "MIT",
    notes: "移除 rpiv-config / rpiv-i18n 依赖与独立 /todos 命令，整合待办菜单（执行、检查、查看）至 /toolkit",
  },

  setup(pi: ExtensionAPI): void {
    api = pi;
    registerTodoExtension(pi);

    pi.on("before_agent_start", async (event, ctx) => {
      const sections = event?.systemPromptOptions?.sections;
      if (!execRun) {
        if (sections && typeof sections === "object") delete sections["toolkit-todo-exec"];
        return;
      }
      const lines = pendingTodoLines(ctx);
      if (lines.length === 0) {
        if (sections && typeof sections === "object") delete sections["toolkit-todo-exec"];
        return;
      }
      const prompt = buildExecPrompt(lines);
      if (sections && typeof sections === "object") {
        sections["toolkit-todo-exec"] = prompt;
        return;
      }
      const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
      return { systemPrompt: `${base}${prompt}` };
    });

    pi.on("agent_before_settle", async (event, ctx) => {
      if (!execRun) return;
      if (event.outcome !== "completed") {
        finishExec(ctx, "自动执行已中止（本轮未正常结束）");
        return;
      }
      const c = todoCounts(ctx);
      if (c.pending === 0) {
        finishExec(ctx, `全部 todo 已完成（${c.done}/${c.total}）`);
        return;
      }
      if (execRun.rounds >= MAX_EXEC_ROUNDS) {
        finishExec(ctx, `已达 ${MAX_EXEC_ROUNDS} 轮上限，剩余 ${c.pending} 项未完成`);
        return;
      }
      execRun.rounds += 1;
      updateExecStatus(ctx);
      return { continue: true };
    });
  },

  getConfigSummary(ctx: ExtensionContext, store: PluginStore<Record<string, never>>): string {
    if (!store.isEnabled()) return "已停用";
    if (!api) return "未加载（需 /reload）";
    if (execRun) return `自动执行中（第 ${execRun.rounds + 1}/${MAX_EXEC_ROUNDS} 轮）`;
    const { total, done, pending } = todoCounts(ctx);
    return total === 0 ? "暂无待办" : `待办 ${done}/${total} 已完成（剩 ${pending} 项）`;
  },

  openMenu: openTodoMenu,

  async handleCommand(
    args: string,
    ctx: ExtensionContext,
    store: PluginStore<Record<string, never>>,
  ): Promise<void> {
    const sub = args.trim().toLowerCase();
    if (!sub) {
      await openTodoMenu(ctx, store);
      return;
    }
    if (sub === "exec" || sub === "run") {
      await startExec(ctx, store);
      return;
    }
    if (sub === "check") {
      await startCheck(ctx, store);
      return;
    }
    if (sub === "list" || sub === "ls" || sub === "show") {
      showTodos(ctx, store);
      return;
    }
    if (sub === "on" || sub === "off") {
      const next = sub === "on";
      if (!store.setEnabled(next)) {
        ctx.ui.notify("保存 Todo 面板状态失败", "error");
        return;
      }
      ctx.ui.notify(`Todo 面板已${next ? "启用" : "停用"}（/reload 后生效）`, "info");
      return;
    }
    ctx.ui.notify("无效参数，可用: exec | check | list | on | off", "warning");
  },

  getCompletions(prefix: string): string[] {
    const p = prefix.trim().toLowerCase();
    return ["exec", "check", "list", "on", "off"].filter((v) => v.startsWith(p));
  },
};
