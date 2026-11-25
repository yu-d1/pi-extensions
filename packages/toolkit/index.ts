import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPluginStore } from "./src/config.js";
import { completeToolkitArgs, handleToolkitCommand, type RegisteredEntry } from "./src/menu.js";
import { PLUGINS } from "./src/plugins/index.js";

export default function toolkitExtension(pi: ExtensionAPI): void {
  const entries: RegisteredEntry[] = PLUGINS.map((plugin) => ({
    plugin,
    store: createPluginStore(plugin),
  }));

  for (const { plugin, store } of entries) {
    // 需 /reload 生效的插件（如注册新工具）在关闭时直接跳过挂载
    if (plugin.requiresReload && !store.isEnabled()) continue;
    plugin.setup(pi, store);
  }

  pi.registerCommand("toolkit", {
    description: "管理自用精选插件（启停切换与档位设置）",
    getArgumentCompletions: (prefix) => completeToolkitArgs(prefix, entries),
    handler: async (args, ctx) => handleToolkitCommand(args, ctx, entries),
  });
}
