import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  authLabel,
  enabledConfigs,
  findByName,
  loadConfigs,
  loadPluginConfig,
  sortedByName,
  type SshConfig,
} from "./config.js";
import { executeCommand } from "./client.js";
import {
  explainReadonlyReject,
  findForbiddenCommand,
  isReadOnlyCommand,
} from "./policy.js";

/** 命中确认策略时的统一提示：不给 AI 留执行余地 */
const CONFIRM_REQUIRED =
  "该命令需要用户确认后才能执行。请提示用户自行通过 SSH 登录服务器操作，不要尝试绕过。";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** 只有启用的连接才可能被解析到，停用与不存在对 AI 表现一致 */
function resolveServer(name: string): { config?: SshConfig; error?: string } {
  const config = findByName(name);
  if (!config || !config.enabled) {
    const available = sortedByName(enabledConfigs(loadConfigs()))
      .map((c) => c.name)
      .join(", ");
    return { error: `服务器 "${name}" 未找到。可用服务器: ${available || "无"}` };
  }
  if (!config.password && !config.keyPath) {
    return { error: `服务器 "${name}" 未配置认证信息，请先执行 /ssh edit 补充。` };
  }
  return { config };
}

export function registerTools(pi: ExtensionAPI) {
  // ── 执行远程命令 ────────────────────────────────
  pi.registerTool({
    name: "ssh_exec",
    label: "远程命令执行",
    description:
      "通过 SSH 在已启用的服务器上执行命令，返回标准输出、错误输出与退出码。受只读模式与执行确认策略限制。",
    promptSnippet:
      "执行远程命令。先用 ssh_list_servers 查看已启用的服务器，再执行命令；只读模式下仅允许查看类命令。",
    parameters: Type.Object({
      server: Type.String({ description: "SSH 连接名称，需与 ssh_list_servers 返回的名称一致", minLength: 1 }),
      command: Type.String({ description: "要执行的命令", minLength: 1 }),
    }),
    async execute(
      _toolCallId: string,
      params: { server: string; command: string },
      signal?: AbortSignal,
    ) {
      const cfg = loadPluginConfig();
      const command = params.command.trim();

      // 1. 硬禁止：与只读模式无关，任何配置下都拦截
      const forbidden = findForbiddenCommand(command);
      if (forbidden) {
        return text(
          `禁止执行该命令（命中「${forbidden}」）。这类操作可能造成不可恢复的破坏，` +
            "无论只读模式如何设置都会被拒绝。如确需执行，请用户手动登录服务器操作。",
        );
      }

      // 2. 只读模式：仅放行明确无副作用的查看命令
      const readonly = isReadOnlyCommand(command);
      if (cfg.ai_readonly && !readonly) {
        return text(`当前为 AI 只读模式，已拒绝执行。${explainReadonlyReject(command)}`);
      }

      // 3. 确认策略：命中即拒绝，提示用户手动执行
      if (
        cfg.confirm_before_exec === "always" ||
        (cfg.confirm_before_exec === "write" && !readonly)
      ) {
        return text(CONFIRM_REQUIRED);
      }

      // 4. 解析服务器
      const resolved = resolveServer(params.server);
      if (!resolved.config) return text(resolved.error ?? "服务器不可用");
      const config = resolved.config;

      // 5. 执行；signal 中断时同样关闭连接
      try {
        if (signal?.aborted) return text("已取消执行。");

        const result = await executeCommand(config, command, cfg.command_timeout);

        const parts = [
          `服务器: ${config.name} (${config.username}@${config.host}:${config.port})`,
          `命令: ${command}`,
          `退出码: ${result.code ?? "未知"}`,
        ];
        if (result.stdout) parts.push("", "标准输出:", result.stdout);
        if (result.stderr) parts.push("", "错误输出:", result.stderr);
        if (!result.stdout && !result.stderr) parts.push("", "(无输出)");

        return text(parts.join("\n"));
      } catch (err: any) {
        return text(`执行失败: ${err?.message ?? String(err)}`);
      }
    },
  });

  // ── 列出服务器 ──────────────────────────────────
  pi.registerTool({
    name: "ssh_list_servers",
    label: "列出 SSH 服务器",
    description: "列出已启用的 SSH 服务器连接，包含名称、地址、认证方式与说明。",
    promptSnippet: "列出可用于执行的 SSH 服务器名称，再配合 ssh_exec 使用。",
    parameters: Type.Object({}),
    async execute() {
      const configs = sortedByName(loadConfigs());
      const open = enabledConfigs(configs);

      if (configs.length === 0) {
        return text("尚未配置任何 SSH 连接。请提示用户执行 /ssh edit 新增连接。");
      }
      if (open.length === 0) {
        return text("所有 SSH 连接均已停用。请提示用户执行 /ssh enable 启用需要访问的连接。");
      }

      const lines = open.map((c) => {
        const desc = c.description ? ` - ${c.description}` : "";
        return `  ${c.name} → ${c.username}@${c.host}:${c.port} (${authLabel(c)})${desc}`;
      });

      return text([`可用的 SSH 连接 (${open.length}):`, ...lines].join("\n"));
    },
  });
}
