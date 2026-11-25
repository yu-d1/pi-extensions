import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "./config.js";
import { pickEnabledItems } from "./toggle-selector.js";
import type { PluginStore, ToolkitPlugin } from "./types.js";

const MENU_ENABLE = "启用";
const MENU_CONFIG = "配置";
const MENU_DONE = "完成";

export interface RegisteredEntry {
  plugin: ToolkitPlugin<any>;
  store: PluginStore<any>;
}

function formatUpstreamInfo(entries: RegisteredEntry[]): string {
  return entries
    .map(({ plugin, store }) => {
      const enabled = store.isEnabled();
      const badge = enabled ? plugin.getStatusBadge?.(store) : undefined;
      const stateText = enabled ? `已启用${badge ? ` (${badge})` : ""}` : "已停用";
      const lines = [
        `${plugin.icon ? `${plugin.icon} ` : ""}${plugin.name} (${plugin.id}) [${stateText}]`,
        `  原仓库: ${plugin.upstream.repo}`,
        `  同步基线: ${plugin.upstream.ref}${plugin.upstream.license ? ` · ${plugin.upstream.license}` : ""}`,
      ];
      if (plugin.upstream.notes) lines.push(`  改写备注: ${plugin.upstream.notes}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function togglePluginState(
  entry: RegisteredEntry,
  nextEnabled: boolean,
  ctx: ExtensionContext,
): void {
  const { plugin, store } = entry;
  if (!store.setEnabled(nextEnabled)) {
    ctx.ui.notify(`保存 ${plugin.name} 状态失败`, "error");
    return;
  }
  plugin.onToggle?.(ctx, nextEnabled, store);
  const reloadTip = plugin.requiresReload ? "（/reload 后生效）" : "";
  ctx.ui.notify(`${plugin.name} 已${nextEnabled ? "启用" : "停用"}${reloadTip}`, "info");
}

function buildToggleBadge(entry: RegisteredEntry): string | undefined {
  const { plugin, store } = entry;
  const parts: string[] = [];
  const badge = plugin.getStatusBadge?.(store);
  if (badge) parts.push(`[${badge}]`);
  if (plugin.requiresReload) parts.push("(/reload 生效)");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** 非 TUI 环境的逐项启停兜底 */
async function enableMenuFallback(ctx: ExtensionContext, entries: RegisteredEntry[]): Promise<void> {
  while (true) {
    loadToolkitConfig(true);
    const lineMap = new Map<string, RegisteredEntry>();
    const options = entries.map((entry) => {
      const { plugin, store } = entry;
      const status = store.isEnabled() ? "已启用" : "已停用";
      const line = `[${status}] ${plugin.icon ? `${plugin.icon} ` : ""}${plugin.name} — ${plugin.description}`;
      lineMap.set(line, entry);
      return line;
    });

    const choice = await ctx.ui.select("启用 - Toolkit 插件", [...options, MENU_DONE]);
    if (!choice || choice === MENU_DONE) return;

    const target = lineMap.get(choice);
    if (!target) continue;
    togglePluginState(target, !target.store.isEnabled(), ctx);
  }
}

/** 「启用」菜单：复用 ToggleSelectorComponent 批量勾选启用或停用插件 */
async function enableMenu(ctx: ExtensionContext, entries: RegisteredEntry[]): Promise<void> {
  loadToolkitConfig(true);

  if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
    await enableMenuFallback(ctx, entries);
    return;
  }

  let reloadNeeded = false;
  const save = (selected: string[]) => {
    loadToolkitConfig(true);
    const marked = new Set(selected);
    for (const { plugin, store } of entries) {
      const next = marked.has(plugin.id);
      if (store.isEnabled() === next) continue;
      if (!store.setEnabled(next)) {
        ctx.ui.notify(`保存 ${plugin.name} 状态失败`, "error");
        continue;
      }
      plugin.onToggle?.(ctx, next, store);
      if (plugin.requiresReload) reloadNeeded = true;
    }
  };

  const result = await pickEnabledItems(ctx, {
    title: "启用 - Toolkit 插件",
    subtitle: "勾选要启用的自用插件",
    hint: "空格/回车切换，^a 全选，^x 清空，^s 保存，esc 完成",
    countLabel: "已启用",
    items: entries.map((entry) => ({
      id: entry.plugin.id,
      label: `${entry.plugin.icon ? `${entry.plugin.icon} ` : ""}${entry.plugin.name}`,
      badge: buildToggleBadge(entry),
      detail: `${entry.plugin.description} · 原仓库: ${entry.plugin.upstream.repo}`,
    })),
    initialMarked: entries.filter((entry) => entry.store.isEnabled()).map((entry) => entry.plugin.id),
    onSave: async (selected) => {
      save(selected);
    },
  });

  if (result) save(result);

  loadToolkitConfig(true);
  const enabledNames = entries
    .filter((entry) => entry.store.isEnabled())
    .map((entry) => entry.plugin.name);
  const reloadTip = reloadNeeded ? "（部分变更需 /reload 生效）" : "";
  ctx.ui.notify(
    enabledNames.length > 0
      ? `当前已启用 (${enabledNames.length}/${entries.length}): ${enabledNames.join(", ")}${reloadTip}`
      : `当前未启用任何插件${reloadTip}`,
    "info",
  );
}

/** 「配置」菜单：仅展示有独立设置或操作面板的子插件 */
async function configMenu(ctx: ExtensionContext, entries: RegisteredEntry[]): Promise<void> {
  const configurable = entries.filter((entry) => typeof entry.plugin.openMenu === "function");
  if (configurable.length === 0) {
    ctx.ui.notify("当前没有提供配置面板的插件", "info");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("/toolkit config 需要在交互式（TUI）模式下使用", "warning");
    return;
  }

  while (true) {
    loadToolkitConfig(true);
    const lineMap = new Map<string, RegisteredEntry>();
    const lines = configurable.map((entry) => {
      const { plugin, store } = entry;
      const iconPrefix = plugin.icon ? `${plugin.icon} ` : "";
      const summary = plugin.getConfigSummary?.(ctx, store) ?? plugin.description;
      const disabledSuffix = store.isEnabled() || summary === "已停用" ? "" : " [已停用]";
      const line = `${iconPrefix}${plugin.name} — ${summary}${disabledSuffix}`;
      lineMap.set(line, entry);
      return line;
    });

    const choice = await ctx.ui.select("配置 - Toolkit 插件", [...lines, MENU_DONE]);
    if (!choice || choice === MENU_DONE) return;

    const target = lineMap.get(choice);
    if (!target?.plugin.openMenu) continue;

    const action = await target.plugin.openMenu(ctx, target.store);
    if (action === "close") return;
  }
}

/** 打开 /toolkit 顶层「启用 / 配置」入口菜单 */
export async function openToolkitMenu(
  ctx: ExtensionContext,
  entries: RegisteredEntry[],
): Promise<void> {
  if (!ctx.hasUI) {
    loadToolkitConfig(true);
    ctx.ui.notify(formatUpstreamInfo(entries), "info");
    return;
  }

  const choice = await ctx.ui.select("Toolkit 插件管理", [MENU_ENABLE, MENU_CONFIG]);
  if (!choice) return;

  if (choice === MENU_ENABLE) await enableMenu(ctx, entries);
  else if (choice === MENU_CONFIG) await configMenu(ctx, entries);
}

/** 处理 /toolkit 命令及子参数路由 */
export async function handleToolkitCommand(
  rawArgs: string | undefined,
  ctx: ExtensionContext,
  entries: RegisteredEntry[],
): Promise<void> {
  const trimmed = String(rawArgs ?? "").trim();
  if (!trimmed) {
    await openToolkitMenu(ctx, entries);
    return;
  }

  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const primary = (match?.[1] ?? "").toLowerCase();
  const rest = (match?.[2] ?? "").trim();

  if (primary === "enable" || primary === "en") {
    await enableMenu(ctx, entries);
    return;
  }

  if (primary === "config" || primary === "settings" || primary === "c") {
    await configMenu(ctx, entries);
    return;
  }

  if (primary === "info" || primary === "list" || primary === "status" || primary === "view" || primary === "v") {
    loadToolkitConfig(true);
    ctx.ui.notify(formatUpstreamInfo(entries), "info");
    return;
  }

  const entry = entries.find((item) => item.plugin.id.toLowerCase() === primary);
  if (!entry) {
    const ids = entries.map((item) => item.plugin.id).join(", ");
    ctx.ui.notify(`未知子命令或插件: ${primary}（可用: enable, config, info, ${ids}，或直接运行 /toolkit）`, "warning");
    return;
  }

  loadToolkitConfig(true);
  if (entry.plugin.handleCommand) {
    await entry.plugin.handleCommand(rest, ctx, entry.store);
    return;
  }

  const sub = rest.toLowerCase();
  if (!sub) {
    if (entry.plugin.openMenu && ctx.hasUI) {
      await entry.plugin.openMenu(ctx, entry.store);
      return;
    }
    togglePluginState(entry, !entry.store.isEnabled(), ctx);
    return;
  }

  if (sub === "on" || sub === "enable") {
    togglePluginState(entry, true, ctx);
    return;
  }
  if (sub === "off" || sub === "disable") {
    togglePluginState(entry, false, ctx);
    return;
  }
  if (sub === "toggle") {
    togglePluginState(entry, !entry.store.isEnabled(), ctx);
    return;
  }

  ctx.ui.notify(`无效参数: ${rest}（可用: on | off | toggle）`, "warning");
}

/** /toolkit 命令自动补全 */
export function completeToolkitArgs(
  prefix: string,
  entries: RegisteredEntry[],
): Array<{ value: string; label: string }> | null {
  const raw = String(prefix ?? "").trimStart();
  const spaceIdx = raw.search(/\s/);

  if (spaceIdx === -1) {
    const candidates = ["enable", "config", "info", ...entries.map((entry) => entry.plugin.id)].filter((item) =>
      item.startsWith(raw.toLowerCase()),
    );
    return candidates.length > 0 ? candidates.map((value) => ({ value, label: value })) : null;
  }

  const primary = raw.slice(0, spaceIdx).toLowerCase();
  const rest = raw.slice(spaceIdx + 1).trimStart();
  const entry = entries.find((item) => item.plugin.id.toLowerCase() === primary);
  if (!entry) return null;

  const subItems = entry.plugin.getCompletions
    ? entry.plugin.getCompletions(rest)
    : ["on", "off", "toggle"].filter((v) => v.startsWith(rest.toLowerCase()));

  if (subItems.length === 0) return null;
  return subItems.map((sub) => {
    const value = `${entry.plugin.id} ${sub}`;
    return { value, label: value };
  });
}
