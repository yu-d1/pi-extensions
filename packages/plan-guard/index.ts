// ~/.pi/agent/extensions/plan-guard.ts
// 计划模式扩展 (Plan mode)
// Tab 键切换 Plan/Act 模式，叠加在 plugin-manager 等其他扩展的白名单之上
//
// 独立原则：本扩展不读取任何其他扩展的状态，只通过 pi.getActiveTools() 和
// pi.setActiveTools() 与运行时交互。即使 plugin-manager 未安装，也能正常工作。
//
// v2.0.0 整合：
//   - 内嵌 rpiv-todo（todo 工具 + /todos 命令 + overlay 面板）与
//     rpiv-ask-user-question（ask_user_question 终端对话框）两个子扩展，
//     源码位于 ask-user-question/ 与 todo/ 子目录（MIT, juicesharp），
//     配置工具内联于 rpiv-config.ts（MIT, juicesharp）。
//   - 开关：~/.pi/agent/extensions/plan-guard/config.json 的 features 字段
//     （todo / askUserQuestion，默认全开），/plan config 子菜单可切换。
//     注册决策在扩展加载期完成，切换开关后需 /reload 生效。
//   - 关闭的子扩展不注册 → pi 内置的同名工具（todo / ask_user_question）
//     自然生效。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadJsonConfig, saveJsonConfig } from "./rpiv-config.js";
import registerAskUserQuestionExtension from "./ask-user-question/index.js";
import registerTodoExtension from "./todo/index.js";

// ── 配置（features 开关）────────────────────────────

const PLAN_GUARD_CONFIG_DIR = join(homedir(), ".pi/agent/extensions/plan-guard");
const PLAN_GUARD_CONFIG_FILE = join(PLAN_GUARD_CONFIG_DIR, "config.json");

interface PlanGuardFeatures {
  /** todo 工具 + /todos 命令 + overlay 面板（rpiv-todo 整合） */
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
    await switchModelForMode(ctx, state.mode);
  };

  // ── /plan config 配置菜单 ──────────────────────────

  const showConfigMenu = async (ctx: ExtensionContext) => {
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

    const ok = saveJsonConfig(PLAN_GUARD_CONFIG_FILE, next);
    if (ok) {
      ctx.ui.notify(
        `已保存（Todo ${next.features.todo ? "开" : "关"} · 提问 ${next.features.askUserQuestion ? "开" : "关"}）→ /reload 后生效`,
        "info",
      );
    } else {
      ctx.ui.notify("配置保存失败（磁盘错误？）", "error");
    }
  };

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

  pi.on("before_agent_start", async (event) => {
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
