// 计划模式扩展 (Plan mode)
// Tab 键切换 Plan/Act 模式，叠加在 plugin-manager 等其他扩展的白名单之上
//
// 独立原则：本扩展不读取任何其他扩展的状态，只通过 pi.getActiveTools() 和
// pi.setActiveTools() 与运行时交互。即使 plugin-manager 未安装，也能正常工作。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

  // ── 持久化 ──────────────────────────────────────────

  // 快照必须自包含：undefined 字段会被 JSON 省略，所以未配置的一侧也要显式写 null。
  const persistState = () => {
    pi.appendEntry("plan-guard-state", {
      mode: state.mode,
      planModelId: state.planModelId ?? null,
      actModelId: state.actModelId ?? null,
    });
  };

  const restoreState = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getEntries();
    const saved = [...entries]
      .reverse()
      .find((e: any) => e.type === "custom" && e.customType === "plan-guard-state") as any;
    const data = saved?.data;
    if (!data) return;
    state.mode = data.mode === "plan" ? "plan" : "act";
    // 只覆盖快照里存在的字段：旧版写的 mode-only 快照没有模型字段，
    // 无条件赋值会把它们置成 undefined，丢掉已配置的模式偏好。
    if ("planModelId" in data) state.planModelId = data.planModelId ?? undefined;
    if ("actModelId" in data) state.actModelId = data.actModelId ?? undefined;
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

  /**
   * 程序化切模型的深度计数。
   *
   * pi 的 extensionRunner.emit 逐个 `await handler(...)`，且 _emitModelSelect
   * 被 setModel await，所以 `await pi.setModel()` 返回时 model_select handler
   * 必已执行完 —— 同步计数即可可靠区分「本扩展切的」与「用户在 /model 里选的」。
   * 事件本身无从判断：两者触发的 source 都是 "set"。
   */
  let switchingModelDepth = 0;

  /**
   * 让 targetMode 的偏好对齐当前模型。返回 true 表示状态已变，
   * 由调用方统一落库（一次模式切换最多追加一条快照）。
   */
  const switchModelForMode = async (ctx: ExtensionContext, targetMode: "plan" | "act") => {
    const targetModelId = targetMode === "plan" ? state.planModelId : state.actModelId;
    if (!targetModelId) {
      // 首次进入该模式且无偏好：把当前模型播种为该模式偏好。
      // 缺这一步则另一模式永远为空，切换时静默沿用当前模型，
      // 表现上就是「两个模式没有各自配置」。当前模型不变，下次切换才生效。
      if (!ctx.model) return false;
      const currentModelId = `${ctx.model.provider}/${ctx.model.id}`;
      if (targetMode === "plan") state.planModelId = currentModelId;
      else state.actModelId = currentModelId;
      return true;
    }
    const slashIdx = targetModelId.indexOf("/");
    if (slashIdx === -1) return false;
    // 当前已是目标模型时跳过，避免无意义的 setModel 调用
    if (ctx.model && `${ctx.model.provider}/${ctx.model.id}` === targetModelId) return false;
    const model = ctx.modelRegistry.find(
      targetModelId.slice(0, slashIdx),
      targetModelId.slice(slashIdx + 1),
    );
    if (!model) {
      ctx.ui.notify(`找不到模型 ${targetModelId}，请重新选择`, "error");
      return false;
    }
    switchingModelDepth++;
    try {
      const ok = await pi.setModel(model);
      if (!ok) {
        ctx.ui.notify(`模型 ${targetModelId} 无可用 API key`, "error");
      }
    } finally {
      switchingModelDepth--;
    }
    return false;
  };

  // ── 切换核心 ────────────────────────────────────────

  const toggleMode = async (ctx: ExtensionContext) => {
    state.mode = state.mode === "plan" ? "act" : "plan";
    updateUI(ctx);
    // 统一在此落库：switchModelForMode 不再自行持久化（播种的偏好一并写入），
    // model_select 又被深度计数挡掉，故一次切换恰好一条快照。
    // try/finally 保证 setModel 抛错时模式变更也不会丢。
    try {
      await switchModelForMode(ctx, state.mode);
    } finally {
      persistState();
    }
  };

  // ── Tab 快捷键 ─────────────────────────────────────

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

  // ── 模型偏好追踪（只记用户显式选择的模型）───────────

  pi.on("model_select", async (event) => {
    if (!event.model || event.source === "restore") return;
    if (switchingModelDepth > 0) return;
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
    const seeded = await switchModelForMode(ctx, state.mode);
    // 仅在播种出新偏好时落库，避免每次 resume 都追加一条冗余快照
    if (seeded) persistState();
  });
}
