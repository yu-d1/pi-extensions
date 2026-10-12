// ~/.pi/agent/extensions/plan-guard.ts
// 计划模式扩展 (Plan mode)
// Tab 键切换 Plan/Act 模式，叠加在 plugin-manager 等其他扩展的白名单之上
//
// 独立原则：本扩展不读取任何其他扩展的状态，只通过 pi.getActiveTools() 和
// pi.setActiveTools() 与运行时交互。即使 plugin-manager 未安装，也能正常工作。
//
// v2.0.0 整合：
//   - 内嵌 rpiv-todo（todo 工具 + overlay 面板，/todos 菜单注册于本文件）与
//     rpiv-ask-user-question（ask_user_question 终端对话框）两个子扩展，
//     源码位于 ask-user-question/ 与 todo/ 子目录（MIT, juicesharp）。
//   - 开关：~/.pi/agent/extensions/plan-guard/config.json 的 features 字段
//     （todo / askUserQuestion，默认全开），/plan config 子菜单可切换。
//     注册决策在扩展加载期完成，切换开关后需 /reload 生效。
//   - 关闭的子扩展不注册 → pi 内置的同名工具（todo / ask_user_question）
//     自然生效。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import registerAskUserQuestionExtension from "./ask-user-question/index.js";
import registerTodoExtension from "./todo/index.js";
import { renderTodosText } from "./todo/todo.js";
import { getTodos } from "./todo/state/store.js";

// ── 配置读写（最小本地实现）──────────────────────────

/** 读取 JSON 配置；缺失/损坏/非 plain object 一律返回 {}。 */
function loadJsonConfig<T>(path: string): T {
	if (!existsSync(path)) return {} as T;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch {
		return {} as T;
	}
}

/** 持久化 JSON 配置；磁盘错误返回 false（调用方据此决定是否提示保存成功）。 */
function saveJsonConfig(path: string, data: unknown): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}

// ── 配置（features 开关）────────────────────────────

const PLAN_GUARD_CONFIG_DIR = join(homedir(), ".pi/agent/extensions/plan-guard");
const PLAN_GUARD_CONFIG_FILE = join(PLAN_GUARD_CONFIG_DIR, "config.json");

interface PlanGuardFeatures {
  /** todo 工具 + overlay 面板（rpiv-todo 整合；/todos 菜单注册在本文件） */
  todo: boolean;
  /** ask_user_question 终端对话框（rpiv-ask-user-question 整合） */
  askUserQuestion: boolean;
}

interface PlanGuardConfig {
  features: PlanGuardFeatures;
}

const DEFAULT_PLAN_GUARD_CONFIG: PlanGuardConfig = {
  features: { todo: true, askUserQuestion: true },
};

/** 读取 features 配置（缺失/损坏 → 默认全开）。同步读取，供扩展加载期注册决策。 */
function loadPlanGuardConfig(): PlanGuardConfig {
  const raw = loadJsonConfig<Partial<PlanGuardConfig>>(PLAN_GUARD_CONFIG_FILE);
  const f = raw.features;
  return {
    features: {
      todo: typeof f?.todo === "boolean" ? f.todo : DEFAULT_PLAN_GUARD_CONFIG.features.todo,
      askUserQuestion:
        typeof f?.askUserQuestion === "boolean"
          ? f.askUserQuestion
          : DEFAULT_PLAN_GUARD_CONFIG.features.askUserQuestion,
    },
  };
}

// ── 计划模式下应禁用的工具（破坏性写入操作）──────────
// bash 不在此列 —— 计划模式下允许 bash 执行只读命令，通过提示词约束；
// 仅拦截高破坏性的删除命令（rm/rmdir），采用命令位置匹配避免误判参数里的 "rm" 字样。
const PLAN_BLOCKED_TOOLS = new Set([
  "edit",
  "write",
]);

// 命令起始位置（行首、分号、&&、||、管道、括号、常见前缀）后紧跟 rm/rmdir 才算命中。
// 例如 `grep "rm" file`、`echo rm` 中的 rm 不匹配；`rm -rf /`、`sudo rm a.txt` 命中。
const PLAN_BLOCKED_BASH = /(^|[;&|(]|\b(?:sudo|nohup|env)\s+)\s*(rm\b|rmdir\b)/;

const PLAN_MODE_PROMPT_ADDON = `
[计划模式已激活 - 只读设计阶段]

你处于「计划模式」(Plan mode)。当前任务是进行分析、设计和规划，而非直接执行修改。

行为约束：
- 禁止使用 bash 执行会修改本地文件系统的操作，尤其是：
  - 删除/移动/覆盖文件：rm、mv、cp（覆盖目标）
  - 写入文件：重定向 > / >>
  - 直接编辑：sed -i
  - 修改 git 历史：git add、git commit、git push
- 允许所有只读操作：ls、cat、find、grep、git log、git diff、git status 等
- 允许 MCP 及其他扩展工具

请输出设计方案、分析结论或修改建议，不要执行任何修改操作。
`.trim();

/** 自动执行的最大轮次，防模型反复横跳停不下来。 */
const MAX_EXEC_ROUNDS = 20;

/**
 * `/todos → 执行` 的自动续跑状态。只存内存，不落 store —— 重启后 restoreState
 * 读出会意外开跑。
 */
let execRun: { rounds: number } | null = null;

const ACT_MODE_PROMPT_ADDON = `
[执行模式已激活]

你处于「执行模式」(Act mode)。可以自由使用所有工具进行文件修改和命令执行。
请直接执行代码修改、文件操作和系统命令，无需先征求确认。
`.trim();

interface PlanGuardState {
  mode: "plan" | "act";
  planModelId?: string;
  actModelId?: string;
}

export default function planGuardExtension(pi: ExtensionAPI) {
  const state: PlanGuardState = { mode: "act" };

  // ── 整合子扩展（按 features 开关条件注册）───────────
  // 注册决策在扩展加载期完成：开关关闭时不注册 → pi 内置同名工具生效；
  // 开关切换后需 /reload 重新加载生效（与 rpiv 自身 config 的 register-once
  // 语义一致）。
  const features = loadPlanGuardConfig().features;
  if (features.askUserQuestion) {
    registerAskUserQuestionExtension(pi);
  }
  if (features.todo) {
    registerTodoExtension(pi);
  }

  // ── 核心过滤逻辑（独立于其他扩展）──────────────────
  // 注意：不通过 setActiveTools 移工具（那会导致 LLM 看不见工具定义，
  // 引发 "Tool edit not found" 错误）。改用 tool_call 事件在运行时拦截。
  // 工具定义始终在 API 请求中，LLM 知道它们存在，只是调用时被阻止。

  // ── 持久化 ──────────────────────────────────────────

  const persistState = () => {
    pi.appendEntry("plan-guard-state", state);
  };

  const restoreState = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getEntries();
    const saved = [...entries]
      .reverse()
      .find((e: any) => e.type === "custom" && e.customType === "plan-guard-state") as any;
    if (saved?.data) {
      state.mode = saved.data.mode === "plan" ? "plan" : "act";
      state.planModelId = saved.data.planModelId;
      state.actModelId = saved.data.actModelId;
    }
  };

  // ── UI ──────────────────────────────────────────────

  const updateUI = (ctx: ExtensionContext) => {
    if (state.mode === "plan") {
      ctx.ui.setStatus("plan-guard", ctx.ui.theme.fg("warning", "[计划模式]"));
    } else {
      ctx.ui.setStatus("plan-guard", undefined);
    }
    if (execRun) {
      const c = todoCounts(ctx);
      ctx.ui.setStatus(
        "plan-guard-exec",
        ctx.ui.theme.fg("accent", `🐐 ${c.done}/${c.total} · 轮次 ${execRun.rounds + 1}/${MAX_EXEC_ROUNDS}`),
      );
    } else {
      ctx.ui.setStatus("plan-guard-exec", undefined);
    }
  };

  // ── 模型自动切换 ────────────────────────────────────

  const switchModelForMode = async (ctx: ExtensionContext, targetMode: "plan" | "act") => {
    const targetModelId = targetMode === "plan" ? state.planModelId : state.actModelId;
    if (!targetModelId) return;
    const slashIdx = targetModelId.indexOf("/");
    if (slashIdx === -1) return;
    // 当前已是目标模型时跳过，避免无意义的 setModel 调用
    if (ctx.model && `${ctx.model.provider}/${ctx.model.id}` === targetModelId) return;
    const model = ctx.modelRegistry.find(
      targetModelId.slice(0, slashIdx),
      targetModelId.slice(slashIdx + 1),
    );
    if (!model) {
      ctx.ui.notify(`找不到模型 ${targetModelId}，请重新选择`, "error");
      return;
    }
    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(`模型 ${targetModelId} 无可用 API key`, "error");
    }
  };

  // ── 切换核心 ────────────────────────────────────────

  const toggleMode = async (ctx: ExtensionContext) => {
    state.mode = state.mode === "plan" ? "act" : "plan";
    updateUI(ctx);
    persistState();
    if (execRun) {
      const c = todoCounts(ctx);
      finishExec(ctx, `已切换模式，自动执行中止（完成 ${c.done}/${c.total}）`);
    }
    await switchModelForMode(ctx, state.mode);
  };


  // ── /todos 菜单（执行 / 检查 / 查看）────────────────

  /** 当前未完成 todo 数。deleted 是墓碑，不计入。 */
  const todoCounts = (ctx: ExtensionContext) => {
    const tasks = getTodos(ctx.sessionManager.getSessionId()).filter((t) => t.status !== "deleted");
    const done = tasks.filter((t) => t.status === "completed").length;
    return { total: tasks.length, done, pending: tasks.length - done };
  };

  const finishExec = (ctx: ExtensionContext, reason: string) => {
    execRun = null;
    updateUI(ctx);
    ctx.ui.notify(reason, "info");
  };

  /** 未完成 todo 清单，用于每轮提示词注入。 */
  const pendingTodoLines = (ctx: ExtensionContext) =>
    getTodos(ctx.sessionManager.getSessionId())
      .filter((t) => t.status === "pending" || t.status === "in_progress")
      .map((t) => `${t.id}. ${t.subject}`);

  const GOAT_EXEC_PROMPT = (lines: string[]) =>
    [
      "按以下待办逐项推进，全部完成或明确受阻时停止：",
      ...lines.map((l) => `  ${l}`),
      "",
      "推进要求：",
      "1. 每项做完立刻把状态标为 completed，不要把已完成的事项留在 pending",
      "2. 项与项之间相互独立就直接依次执行，不要停下来请示",
      "3. 遇阻时说明卡在哪、已完成到哪一步，再停止",
    ].join("\n");

  /** /todos → 执行：切执行模式，按待办清单自动推进至全部完成。 */
  const startExec = async (ctx: ExtensionContext) => {
    if (!features.todo) {
      ctx.ui.notify("Todo 面板已关闭，用 /plan config 开启", "info");
      return;
    }
    const { pending } = todoCounts(ctx);
    if (pending === 0) {
      ctx.ui.notify("没有待完成的 todo", "info");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/todos 执行需要在交互式（TUI）模式下使用", "error");
      return;
    }
    if (state.mode !== "act") await toggleMode(ctx);
    execRun = { rounds: 0 };
    updateUI(ctx);
    const lines = pendingTodoLines(ctx);
    if (lines.length === 0) {
      finishExec(ctx, "待办清单已空，无需执行");
      return;
    }
    await pi.sendUserMessage(GOAT_EXEC_PROMPT(lines), { deliverAs: "steer" });
  };

  /** /todos → 检查：让当前模型核对 todo 状态与实际进展。 */
  const startCheck = async (ctx: ExtensionContext) => {
    if (!features.todo) {
      ctx.ui.notify("Todo 面板已关闭，用 /plan config 开启", "info");
      return;
    }
    const { total, done } = todoCounts(ctx);
    if (total === 0) {
      ctx.ui.notify("还没有 todo，先让模型制定计划", "info");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/todos 检查需要在交互式（TUI）模式下使用", "error");
      return;
    }
    const text = renderTodosText(ctx);
    if (text === null) {
      ctx.ui.notify("当前分支没有可见 todo", "info");
      return;
    }
    ctx.ui.notify(`检查 ${total} 项 todo（已完成 ${done} 项）`, "info");
    const tasks = getTodos(ctx.sessionManager.getSessionId()).filter((t) => t.status !== "deleted");
    await pi.sendUserMessage(
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
  };

  /** /todos → 查看：原一次性分档渲染。 */
  const showTodos = (ctx: ExtensionContext) => {
    if (!features.todo) {
      ctx.ui.notify("Todo 面板已关闭，用 /plan config 开启", "info");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/todos 查看需要在交互式（TUI）模式下使用", "error");
      return;
    }
    const text = renderTodosText(ctx);
    if (text === null) ctx.ui.notify("当前分支还没有 todo", "info");
    else ctx.ui.notify(text, "info");
  };

  /** /todos 菜单主体。execRun 非空时首项变为中止。 */
  const showTodosMenu = async (ctx: ExtensionContext) => {
    if (!features.todo) {
      ctx.ui.notify("Todo 面板已关闭，用 /plan config 开启", "info");
      return;
    }
    const { total, done, pending } = todoCounts(ctx);
    if (total === 0) {
      ctx.ui.notify("还没有 todo，先让模型制定计划", "info");
      return;
    }
    const abortLabel = "⏹ 中止自动执行";
    const execLabel = execRun
      ? `${abortLabel}（第 ${execRun.rounds + 1}/${MAX_EXEC_ROUNDS} 轮 · ${done}/${total}）`
      : `▶️ 执行全部待办（剩 ${pending} 项）`;
    const choice = await ctx.ui.select("Todo 任务", [
      execLabel,
      "🔍 检查并标注状态",
      "📋 查看任务列表",
    ]);
    if (!choice) return;
    if (choice.startsWith(abortLabel)) {
      finishExec(ctx, `已中止自动执行（第 ${execRun?.rounds ?? 0} 轮 · ${done}/${total}）`);
      return;
    }
    if (choice.startsWith("▶️")) {
      await startExec(ctx);
      return;
    }
    if (choice.startsWith("🔍")) {
      await startCheck(ctx);
      return;
    }
    showTodos(ctx);
  };

  // ── /plan config 配置菜单 ──────────────────────────

  const showConfigMenu = async (ctx: ExtensionContext) => {
    // 循环菜单：切换后留在当前界面，可连续调整多个开关
    while (true) {
      const cfg = loadPlanGuardConfig();
      const todoLabel = `📋 Todo 任务面板  (${cfg.features.todo ? "✅ 开启" : "⬜ 关闭"})`;
      const aqLabel = `💬 提问对话框    (${cfg.features.askUserQuestion ? "✅ 开启" : "⬜ 关闭"})`;
      const choice = await ctx.ui.select("Plan Guard 配置（重新加载后生效）", [
        todoLabel,
        aqLabel,
        "🔙 返回",
      ]);
      if (!choice || choice === "🔙 返回") return;

      const next: PlanGuardConfig = {
        features: { ...cfg.features },
      };
      if (choice === todoLabel) next.features.todo = !cfg.features.todo;
      else if (choice === aqLabel) next.features.askUserQuestion = !cfg.features.askUserQuestion;
      else return;

      const ok = saveJsonConfig(PLAN_GUARD_CONFIG_FILE, next);
      if (ok) {
        ctx.ui.notify(
          `已保存（Todo ${next.features.todo ? "开" : "关"} · 提问 ${next.features.askUserQuestion ? "开" : "关"}）→ /reload 后生效`,
          "info",
        );
      } else {
        ctx.ui.notify("配置保存失败（磁盘错误？）", "error");
      }
    }
  };

  // ── /todos 命令 ───────────────────────────────────
  // 无参数 → 菜单（执行 / 检查 / 查看）；带参数直达对应动作。
  pi.registerCommand("todos", {
    description: "Todo 任务：执行全部待办、检查状态标注、查看列表",
    handler: async (args, ctx) => {
      const sub = args?.trim();
      if (sub === "exec" || sub === "run") {
        await startExec(ctx);
        return;
      }
      if (sub === "check") {
        await startCheck(ctx);
        return;
      }
      if (sub === "list" || sub === "ls" || sub === "show") {
        showTodos(ctx);
        return;
      }
      await showTodosMenu(ctx);
    },
  });

  // ── Tab 快捷键 ──────────────────────────────────────

  pi.registerShortcut("tab", {
    description: "切换 Plan/Act 模式",
    handler: async (ctx) => toggleMode(ctx),
  });

  // ── /plan 命令 ──────────────────────────────────────
  // /plan          —— 切换计划/执行模式（TUI 手动输入或 Web 端按钮调用）
  // /plan config   —— 配置整合子扩展的开关（Todo 面板 / 提问对话框）
  pi.registerCommand("plan", {
    description: "切换计划模式（计划 ⇄ 执行）；/plan config 配置整合子扩展",
    handler: async (args, ctx) => {
      if (args === "config") {
        await showConfigMenu(ctx);
        return;
      }
      await toggleMode(ctx);
      const label = state.mode === "plan" ? "计划" : "执行";
      ctx.ui.notify(`已切换到${label}模式`, "info");
    },
  });

  // ── 系统提示注入 + 工具调用拦截 ──────────────────

  // exec 期间每轮注入实时待办清单。续跑跨多轮，模型会遗忘「做完要标状态」，
  // 而那是唯一的终止依据。此分支优先于 plan/act 判断。
  pi.on("before_agent_start", async (event, ctx) => {
    if (execRun) {
      const lines = pendingTodoLines(ctx);
      if (lines.length === 0) {
        return { systemPrompt: event.systemPrompt + "\n\n" + ACT_MODE_PROMPT_ADDON };
      }
      return {
        systemPrompt:
          event.systemPrompt + "\n\n" + ACT_MODE_PROMPT_ADDON + "\n\n" + GOAT_EXEC_PROMPT(lines),
      };
    }
    if (state.mode === "plan") {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + PLAN_MODE_PROMPT_ADDON,
        message: {
          customType: "plan-guard-hint",
          content: "当前处理计划模式，只需要给出思路",
          display: false,
        },
      };
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + ACT_MODE_PROMPT_ADDON };
  });

  // 续跑驱动：agent 每轮落定前检查待办是否清空。用官方 before_settle 钩子返回
  // { continue: true } 让 pi 再发一次请求，不在对话历史里插入任何条目。
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
    updateUI(ctx);
    return { continue: true };
  });

  // 工具调用拦截：计划模式下阻止破坏性工具执行，但不移除工具定义
  pi.on("tool_call", async (event) => {
    if (state.mode !== "plan") return;
    if (PLAN_BLOCKED_TOOLS.has(event.toolName)) {
      return { block: true, reason: "计划模式禁止写操作，切换到执行模式后再试" };
    }
    const command = (event.input as { command?: string } | undefined)?.command;
    if (event.toolName === "bash" && command && PLAN_BLOCKED_BASH.test(command)) {
      return { block: true, reason: "计划模式禁止删除命令（rm/rmdir），切换到执行模式后再试" };
    }
  });

  // ── 模型偏好追踪（自动记录各模式下的模型选择）───────
  // 注意：source 为 "restore"（pi 会话恢复时自动恢复上次模型）不记录，
  // 否则会把恢复的模型误写进当前模式的偏好，污染 planModelId/actModelId。

  pi.on("model_select", async (event) => {
    if (!event.model || event.source === "restore") return;
    const modelId = `${event.model.provider}/${event.model.id}`;
    if (state.mode === "plan") {
      if (state.planModelId === modelId) return;
      state.planModelId = modelId;
    } else {
      if (state.actModelId === modelId) return;
      state.actModelId = modelId;
    }
    persistState();
  });

  // ── 会话恢复 ────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    restoreState(ctx);
    updateUI(ctx);
    // 恢复该模式对应的偏好模型（幂等：与当前模型相同则跳过）
    await switchModelForMode(ctx, state.mode);
  });
}
