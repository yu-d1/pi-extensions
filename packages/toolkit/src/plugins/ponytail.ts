/**
 * 子插件：Ponytail（极简开发模式）
 *
 * 原插件地址：https://github.com/DietrichGebert/ponytail
 * 同步基线：v5.3.3 (ebd8654) · 协议：MIT
 * 本地改写：精简中文版，移除 skills 与衍生斜杠命令、跨宿主兼容层及强制写测试条款，
 *           启停由 /toolkit 启用菜单统一管理，配置菜单提供 lite / full / ultra 三档选择。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PluginStore, ToolkitPlugin } from "../types.js";

export type PonytailActiveMode = "lite" | "full" | "ultra";

export interface PonytailSettings extends Record<string, unknown> {
  mode: PonytailActiveMode;
}

const STATUS_KEY = "toolkit:ponytail";

const LEVEL_META: Array<{ value: PonytailActiveMode; icon: string; summary: string }> = [
  { value: "lite", icon: "🌿", summary: "按要求完成实现，结尾附一行更精简的替代方案" },
  { value: "full", icon: "⚡", summary: "直接执行极简阶梯，砍掉未被要求的附加复杂度" },
  { value: "ultra", icon: "🔥", summary: "动手前先审视需求，主动质疑并精简不合理部分" },
];

const LEVEL_DIRECTIVES: Record<PonytailActiveMode, string> = {
  lite: "当前等级为 lite：按用户要求完成目标实现，同时在回复末尾用一行指出更精简的替代方案供用户选择。",
  full: "当前等级为 full：直接严格执行下方极简准则，砍掉未被要求的附加复杂度。",
  ultra: "当前等级为 ultra：严格执行下方准则，且在动手前先审视需求本身——对实际需求支撑不足的部分主动提出质疑与精简建议。",
};

function validMode(value: unknown): PonytailActiveMode {
  return value === "lite" || value === "full" || value === "ultra" ? value : "full";
}

function parseActiveMode(raw: string): PonytailActiveMode | null {
  const normalized = raw.trim().toLowerCase();
  return normalized === "lite" || normalized === "full" || normalized === "ultra" ? normalized : null;
}

/** 构造精简中文版 Ponytail 系统提示词 */
export function buildPonytailPrompt(mode: PonytailActiveMode): string {
  return [
    `[Ponytail 极简开发模式 · ${mode}]`,
    LEVEL_DIRECTIVES[mode],
    "",
    "你是崇尚极简的资深开发者：最好的代码是无需编写的代码，用最少的新增代码完整解决问题。每次回复末尾用 1～2 行简要说明跳过或未检查的事项，以及用户需知晓的潜在风险。",
    "",
    "动手前先看全貌：",
    "- 先阅读任务与涉及的代码，查清改动必须触达的所有位置（调用方、配置、导出接口等），检查是否会破坏现有调用方或导致数据损坏与泄露。",
    "- 修缺陷前先全局检索被修改函数的所有调用处，在共享逻辑中一次性修复根因。",
    "",
    "最小完整改动阶梯（取第一个可行项即止）：",
    "1. 是否必须存在？跳过无人要求的附加特性、可选项与灵活度（用一行点明即可）；模糊需求只做能跑通核心目标的最小版本。",
    "2. 代码库已有现成实现（工具函数、组件、服务、模式）？按周边代码惯例直接复用。",
    "3. 标准库或平台原生能力能解决？直接采用（项目已有封装组件时优先用项目组件）。",
    "4. 已安装的依赖能解决？直接复用，绝不为几行代码引入新依赖。",
    "5. 能写成一眼看懂的单行代码？写一行（需要费力解码的单行不算简短）。",
    "6. 以上皆否：编写能正常工作的最少代码。",
    "",
    "编码约束：",
    "- 对方案求简，对改动范围绝不敷衍：凡是本次改动波及的调用方与配置必须同步改完。",
    "- 禁止未被要求的抽象、包装层、类型转换、配置项、样板代码或预留逻辑；保持项目原有的分层、接口与编码约定；能删减就不新增。",
    "- 移动或合并代码时完整保留原有的错误处理与校验；仅在代码本身无法表达原因时写单行注释。",
    "- 代码量相当时优先选择边界情况正确的写法；带有已知上限的权宜方案标注单行注释：`shortcut: <上限>, <何时升级>`。",
    "- 绝不精简：信任边界的输入校验、防止数据丢失的错误处理、安全性、无障碍支持以及用户明确要求的功能。",
  ].join("\n");
}

let lastCtx: ExtensionContext | undefined;

function syncStatus(store: PluginStore<PonytailSettings>, ctx?: ExtensionContext): void {
  if (ctx) lastCtx = ctx;
  const target = ctx ?? lastCtx;
  if (!target?.ui?.setStatus) return;

  if (!store.isEnabled()) {
    target.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const mode = validMode(store.getSettings().mode);
  const text = `🐴 ${mode}`;
  // 防御部分非标准界面代理在主题初始化完成前访问 theme.fg 抛出异常
  try {
    const fg = target.ui.theme?.fg?.bind(target.ui.theme);
    target.ui.setStatus(STATUS_KEY, fg ? fg("muted", text) : text);
  } catch {
    target.ui.setStatus(STATUS_KEY, text);
  }
}

function setModeSetting(
  mode: PonytailActiveMode,
  ctx: ExtensionContext,
  store: PluginStore<PonytailSettings>,
): void {
  if (!store.updateSettings({ mode })) {
    ctx.ui.notify("保存 Ponytail 等级失败", "error");
    return;
  }
  syncStatus(store, ctx);
  if (store.isEnabled()) {
    ctx.ui.notify(`Ponytail 等级已设为 ${mode}`, "info");
  } else {
    ctx.ui.notify(`Ponytail 等级已设为 ${mode}（当前未启用，可在 /toolkit → 启用 中开启）`, "info");
  }
}

async function openPonytailMenu(
  ctx: ExtensionContext,
  store: PluginStore<PonytailSettings>,
): Promise<void> {
  const current = validMode(store.getSettings().mode);
  const optionMap = new Map<string, PonytailActiveMode>();
  const labels = LEVEL_META.map((item) => {
    const suffix = item.value === current ? " [当前]" : "";
    const label = `${item.icon} ${item.value.padEnd(5)} — ${item.summary}${suffix}`;
    optionMap.set(label, item.value);
    return label;
  });

  const titleSuffix = store.isEnabled() ? current : `${current} · 未启用`;
  const picked = await ctx.ui.select(`Ponytail · 选择等级（当前: ${titleSuffix}）`, [...labels, "返回"]);
  if (!picked || picked === "返回") return;

  const choice = optionMap.get(picked);
  if (choice) setModeSetting(choice, ctx, store);
}

export const ponytailPlugin: ToolkitPlugin<PonytailSettings> = {
  id: "ponytail",
  name: "Ponytail",
  icon: "🐴",
  description: "极简开发模式",
  defaultEnabled: true,
  defaultSettings: { mode: "full" },
  requiresReload: false,
  upstream: {
    repo: "https://github.com/DietrichGebert/ponytail",
    ref: "v5.3.3 (ebd8654)",
    license: "MIT",
    notes: "精简中文版：仅保留等级选择与 sections 提示词注入，移除 skills、衍生斜杠命令、跨宿主兼容层及强制写测试条款",
  },

  setup(pi: ExtensionAPI, store: PluginStore<PonytailSettings>): void {
    pi.on("session_start", async (_event, ctx) => {
      syncStatus(store, ctx);
    });

    pi.on("before_agent_start", async (event) => {
      const sections = event?.systemPromptOptions?.sections;
      if (!store.isEnabled()) {
        if (sections && typeof sections === "object") delete sections["ponytail"];
        return;
      }

      const mode = validMode(store.getSettings().mode);
      const prompt = buildPonytailPrompt(mode);
      if (sections && typeof sections === "object") {
        sections["ponytail"] = prompt;
        return;
      }

      const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
      return { systemPrompt: `${base}${prompt}` };
    });
  },

  getStatusBadge(store: PluginStore<PonytailSettings>): string {
    return validMode(store.getSettings().mode);
  },

  getConfigSummary(_ctx: ExtensionContext, store: PluginStore<PonytailSettings>): string {
    return `等级: ${validMode(store.getSettings().mode)}`;
  },

  onToggle(ctx: ExtensionContext, _enabled: boolean, store: PluginStore<PonytailSettings>): void {
    syncStatus(store, ctx);
  },

  openMenu: openPonytailMenu,

  async handleCommand(
    args: string,
    ctx: ExtensionContext,
    store: PluginStore<PonytailSettings>,
  ): Promise<void> {
    const trimmed = args.trim().toLowerCase();
    if (!trimmed) {
      if (ctx.hasUI) {
        await openPonytailMenu(ctx, store);
      } else {
        const active = store.isEnabled() ? validMode(store.getSettings().mode) : "off";
        ctx.ui.notify(`Ponytail 当前状态: ${active}`, "info");
      }
      return;
    }

    if (trimmed === "off") {
      if (!store.setEnabled(false)) {
        ctx.ui.notify("保存 Ponytail 停用状态失败", "error");
        return;
      }
      syncStatus(store, ctx);
      ctx.ui.notify("Ponytail 已停用", "info");
      return;
    }

    if (trimmed === "on") {
      if (!store.setEnabled(true)) {
        ctx.ui.notify("保存 Ponytail 启用状态失败", "error");
        return;
      }
      syncStatus(store, ctx);
      ctx.ui.notify(`Ponytail 已启用（${validMode(store.getSettings().mode)}）`, "info");
      return;
    }

    const parsed = parseActiveMode(trimmed);
    if (!parsed) {
      ctx.ui.notify("无效参数，可用: lite | full | ultra | on | off", "warning");
      return;
    }

    if (!store.setEnabled(true) || !store.updateSettings({ mode: parsed })) {
      ctx.ui.notify("保存 Ponytail 等级失败", "error");
      return;
    }
    syncStatus(store, ctx);
    ctx.ui.notify(`Ponytail 已设为 ${parsed}`, "info");
  },

  getCompletions(prefix: string): string[] {
    const p = prefix.trim().toLowerCase();
    return ["lite", "full", "ultra", "on", "off"].filter((value) => value.startsWith(p));
  },
};
