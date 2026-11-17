import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { batchModeLabel, DEFAULT_CONFIG, configSummary, loadConfig, MAX_CONCURRENCY, saveConfig, tokenLabel, CONCURRENCY_OPTIONS, type FoldConfig } from "./config.js";
import { startSummarize } from "./run.js";
import type { FoldState } from "./state.js";
import { buildStatusText } from "./tools.js";

const MENU_STATUS = "状态";
const MENU_SETTINGS = "设置";
const MENU_DONE = "完成";

const FOLD_AT_CHOICES = ["50K", "100K", "150K", "200K", "自定义输入"];
const KEEP_CHOICES = ["10K", "20K", "40K", "自定义输入"];
const SAFETY_CHOICES = ["关闭", "80%", "90%", "95%", "自定义输入"];
const BATCH_MODE_CHOICES = ["逐步", "并发"];
const CONCURRENCY_CHOICES = [...CONCURRENCY_OPTIONS.map(String), "自定义输入"];

const USAGE = [
  "用法: /fold [子命令]",
  "",
  "  /fold        菜单",
  "  /fold s      查看折叠状态",
  "  /fold f      立即折叠（跳过阈值判断）",
  "  /fold c      查看与修改设置",
  "  /fold reset  恢复默认设置",
].join("\n");

async function editSettings(ctx: ExtensionContext): Promise<void> {
  const next: FoldConfig = { ...loadConfig() };

  while (true) {
    const options = [
      `启用折叠（当前: ${next.enabled ? "是" : "否"}）`,
      `触发阈值（当前: ${tokenLabel(next.foldAtTokens)}）`,
      `保留最近（当前: ${tokenLabel(next.keepRecentTokens)}）`,
      `保底触发（当前: ${next.safetyRatio > 0 ? `${Math.round(next.safetyRatio * 100)}%` : "关闭"}）`,
      `执行方式（当前: ${batchModeLabel(next.batchMode)}）`,
    ];
    // 并发个数只在并发时出现
    if (next.batchMode === "parallel") {
      options.push(`并发个数（当前: ${next.batchConcurrency}）`);
    }
    options.push(MENU_DONE);

    const choice = await ctx.ui.select("设置", options);
    if (!choice || choice === MENU_DONE) break;

    if (choice.startsWith("启用折叠")) {
      const pick = await ctx.ui.select("启用折叠", ["是", "否"]);
      if (pick === undefined) continue;
      next.enabled = pick === "是";
    } else if (choice.startsWith("执行方式")) {
      const pick = await ctx.ui.select("多批摘要怎么执行", BATCH_MODE_CHOICES);
      if (pick === undefined) continue;
      next.batchMode = pick === "并发" ? "parallel" : "serial";
    } else if (choice.startsWith("并发个数")) {
      const pick = await ctx.ui.select("同时发起几个摘要请求", CONCURRENCY_CHOICES);
      if (pick === undefined) continue;
      if (pick === "自定义输入") {
        const input = await ctx.ui.input(`并发个数（1-${MAX_CONCURRENCY}）`, String(next.batchConcurrency));
        if (input === undefined) continue;
        const num = Number(input.trim());
        if (!Number.isFinite(num) || num < 1 || num > MAX_CONCURRENCY) {
          ctx.ui.notify(`请输入 1 到 ${MAX_CONCURRENCY} 之间的数字`, "error");
          continue;
        }
        next.batchConcurrency = Math.round(num);
      } else {
        next.batchConcurrency = Number(pick);
      }
    } else if (choice.startsWith("触发阈值")) {
      const pick = await ctx.ui.select("上下文达到多少 token 时折叠", FOLD_AT_CHOICES);
      if (pick === undefined) continue;
      if (pick === "自定义输入") {
        const input = await ctx.ui.input("token 数（20000-2000000）", String(next.foldAtTokens));
        if (input === undefined) continue;
        const num = Number(input.trim());
        if (!Number.isFinite(num) || num < 20_000 || num > 2_000_000) {
          ctx.ui.notify("请输入 20000 到 2000000 之间的数字", "error");
          continue;
        }
        next.foldAtTokens = Math.round(num);
      } else {
        next.foldAtTokens = Number(pick.replace("K", "")) * 1_000;
      }
    } else if (choice.startsWith("保底触发")) {
      const pick = await ctx.ui.select("上下文到多少时无条件折叠", SAFETY_CHOICES);
      if (pick === undefined) continue;
      if (pick === "关闭") {
        next.safetyRatio = 0;
      } else if (pick === "自定义输入") {
        const input = await ctx.ui.input("百分比（50-98，输入 0 关闭）", String(Math.round(next.safetyRatio * 100)));
        if (input === undefined) continue;
        const num = Number(input.replace("%", "").trim());
        if (!Number.isFinite(num) || num < 0 || (num > 0 && num < 50) || num > 98) {
          ctx.ui.notify("请输入 0（关闭）或 50 到 98 之间的数字", "error");
          continue;
        }
        next.safetyRatio = num === 0 ? 0 : num / 100;
      } else {
        next.safetyRatio = Number(pick.replace("%", "")) / 100;
      }
    } else if (choice.startsWith("保留最近")) {
      const pick = await ctx.ui.select("保留最近多少原文", KEEP_CHOICES);
      if (pick === undefined) continue;
      if (pick === "自定义输入") {
        const input = await ctx.ui.input("token 数（2000-200000）", String(next.keepRecentTokens));
        if (input === undefined) continue;
        const num = Number(input.trim());
        if (!Number.isFinite(num) || num < 2_000 || num > 200_000) {
          ctx.ui.notify("请输入 2000 到 200000 之间的数字", "error");
          continue;
        }
        next.keepRecentTokens = Math.round(num);
      } else {
        next.keepRecentTokens = Number(pick.replace("K", "")) * 1_000;
      }
    }
  }

  saveConfig(next);
  ctx.ui.notify(`设置已保存\n${configSummary(next).join("\n")}`, "success");
}

/** 手动触发一次折叠，绕过阈值判断 */
async function foldNow(ctx: ExtensionContext, state: FoldState, level?: string): Promise<void> {
  if (state.summarizing) {
    ctx.ui.notify("摘要正在生成中，请稍候", "warning");
    return;
  }
  if (state.pending !== undefined) {
    ctx.ui.notify(`${state.pending.length} 块已生成，本轮结束时会自动生效`, "info");
    return;
  }

  const started = startSummarize(ctx, state, loadConfig(), undefined, undefined, level);
  if (!started) {
    ctx.ui.notify("没有可折叠的区间（需要至少两轮已完成的对话，且区间够大）", "warning");
    return;
  }
  ctx.ui.notify("开始折叠，摘要生成后会在本轮结束时生效", "info");
}

export async function showMenu(ctx: ExtensionContext, state: FoldState): Promise<void> {
  const choice = await ctx.ui.select("上下文折叠", [MENU_STATUS, MENU_SETTINGS]);
  if (choice === undefined) return;

  if (choice === MENU_STATUS) {
    ctx.ui.notify(buildStatusText(state, ctx), "info");
  } else if (choice === MENU_SETTINGS) {
    await editSettings(ctx);
  }
}

export function registerMenu(pi: ExtensionAPI, state: FoldState): void {
  pi.registerCommand("fold", {
    description: "上下文折叠：查看状态、立即折叠、修改设置",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const sub = raw.split(/\s+/)[0]?.toLowerCase() ?? "";

      if (sub === "") {
        await showMenu(ctx, state);
        return;
      }

      switch (sub) {
        case "status":
        case "s":
          ctx.ui.notify(buildStatusText(state, ctx), "info");
          return;
        case "now":
        case "run":
        case "f":
          await foldNow(ctx, state, typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined);
          return;
        case "config":
        case "settings":
        case "c": {
          ctx.ui.notify(configSummary(loadConfig()).join("\n"), "info");
          await editSettings(ctx);
          return;
        }
        case "reset": {
          const ok = await ctx.ui.confirm("恢复默认", "确定把折叠设置恢复为默认值？");
          if (!ok) return;
          saveConfig({ ...DEFAULT_CONFIG });
          ctx.ui.notify(`已恢复默认设置\n${configSummary(DEFAULT_CONFIG).join("\n")}`, "success");
          return;
        }
        default:
          ctx.ui.notify(USAGE, "info");
      }
    },
  });
}
