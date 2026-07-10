// ~/.pi/agent/extensions/plan-guard.ts
// 计划模式扩展 (Plan mode)
// Tab 键切换 Plan/Act 模式，叠加在 plugin-manager 等其他扩展的白名单之上
//
// 独立原则：本扩展不读取任何其他扩展的状态，只通过 pi.getActiveTools() 和
// pi.setActiveTools() 与运行时交互。即使 plugin-manager 未安装，也能正常工作。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 计划模式下应禁用的工具（破坏性写入操作）。
// bash 不在此列 —— 计划模式下允许 bash 执行只读命令，通过提示词约束。
const PLAN_BLOCKED_TOOLS = new Set([
  "edit",
  "write",
]);

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
    const model = ctx.modelRegistry.find(
      targetModelId.slice(0, slashIdx),
      targetModelId.slice(slashIdx + 1),
    );
    if (model) await pi.setModel(model);
  };

  // ── 切换核心 ────────────────────────────────────────

  const toggleMode = async (ctx: ExtensionContext) => {
    state.mode = state.mode === "plan" ? "act" : "plan";
    updateUI(ctx);
    persistState();
    await switchModelForMode(ctx, state.mode);
  };

  // ── Tab 快捷键 ──────────────────────────────────────

  pi.registerShortcut("tab", {
    description: "切换 Plan/Act 模式",
    handler: async (ctx) => toggleMode(ctx),
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
  pi.on("tool_call", async (event, ctx) => {
    if (state.mode === "plan" && PLAN_BLOCKED_TOOLS.has(event.toolName)) {
      return { block: true, reason: "计划模式禁止写操作，切换到执行模式后再试" };
    }
  });

  // ── 模型偏好追踪（自动记录各模式下的模型选择）───────

  pi.on("model_select", async (event) => {
    if (!event.model) return;
    const modelId = `${event.model.provider}/${event.model.id}`;
    if (state.mode === "plan") state.planModelId = modelId;
    else state.actModelId = modelId;
    persistState();
  });

  // ── 会话恢复 ────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    restoreState(ctx);
    updateUI(ctx);
  });
}
