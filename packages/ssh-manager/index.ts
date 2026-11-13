import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONFIRM_LABELS,
  configFilePath,
  enabledConfigs,
  loadConfigs,
  loadPluginConfig,
  sortedByName,
  type PluginConfig,
} from "./src/config.js";
import { handleSshCommand } from "./src/menu.js";
import { registerTools } from "./src/tools.js";

// ── 系统提示：执行策略与可用服务器 ────────────────

function buildPolicyText(cfg: PluginConfig): string {
  const readonly = cfg.ai_readonly
    ? "当前 AI 只读模式：是。ssh_exec 只能执行查看类命令（ls、cat、ps、df 等），且不允许管道、重定向与复合命令。"
    : "当前 AI 只读模式：否。ssh_exec 允许执行写操作，但仍受危险命令黑名单与执行确认策略限制。";
  const confirm = cfg.confirm_before_exec === "never"
    ? "执行确认：不确认，命令直接执行。"
    : cfg.confirm_before_exec === "write"
      ? "执行确认：写操作需要用户确认，此时 ssh_exec 会直接拒绝，请让用户手动执行。"
      : "执行确认：每次都确认，ssh_exec 会直接拒绝，请让用户手动执行。";

  return [
    readonly,
    confirm,
    `命令超时 ${cfg.command_timeout} 秒。`,
    "无论何种设置，删除、格式化、关机重启、分区等破坏性命令始终禁止通过 ssh_exec 执行。",
  ].join("\n");
}

function buildServerList(): string {
  const configs = sortedByName(loadConfigs());
  const open = enabledConfigs(configs);

  if (configs.length === 0) {
    return "暂无 SSH 连接。请告知用户执行 /ssh edit 新增连接，再执行 /ssh enable 启用。";
  }

  // 停用的连接对 AI 完全不可见，连名字也不暴露
  if (open.length === 0) {
    return "当前没有可用的 SSH 连接。请告知用户执行 /ssh enable 启用需要访问的连接。";
  }

  return open
    .map((c) => {
      const desc = c.description ? ` - ${c.description}` : "";
      return `- ${c.name} → ${c.username}@${c.host}:${c.port}${desc}`;
    })
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const cfg = loadPluginConfig();
    event.systemPromptOptions.sections["ssh"] = [
      "[SSH 工具执行策略]",
      buildPolicyText(cfg),
      "",
      "[可用 SSH 服务器]",
      buildServerList(),
      "",
      `server 参数必须使用上述连接名称之一。连接与设置保存在 ${configFilePath()}。`,
    ].join("\n");
  });

  registerTools(pi);

  pi.registerCommand("ssh", {
    description: "AI 远程操作服务器",
    handler: async (args, ctx) => {
      await handleSshCommand(args, ctx);
    },
  });
}
