import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  TYPE_LABELS,
  allDatabases,
  configFilePath,
  enabledDatabases,
  listTargets,
  loadDbConfigs,
  loadPluginConfig,
  readRawConfigs,
  writeRawConfigs,
  type PluginConfig,
} from "./src/config.js";
import { runStartupMigration } from "./src/migrate.js";
import { handleDbCommand } from "./src/menu.js";
import { registerTools } from "./src/tools.js";

// ── 系统提示：可用数据库与执行策略 ────────────────

function buildPolicyText(cfg: PluginConfig): string {
  const policy = cfg.ai_readonly
    ? "当前 AI 只读模式：是。query_database 只能执行查询语句，INSERT、UPDATE、DELETE、DDL 等写操作会被拒绝。"
    : "当前 AI 只读模式：否。query_database 允许执行查询和写操作，不要因为工具名称或通用描述而把它限制为 SELECT。";
  const maxRows = cfg.max_rows > 0 ? `最多返回 ${cfg.max_rows} 行` : "不限制返回行数";
  return [
    policy,
    `当前限制：${maxRows}，单条 SQL 超时 ${cfg.query_timeout} 秒。`,
    "DROP TABLE、DROP DATABASE 等删除结构的语句始终禁止通过 query_database 执行，与只读模式设置无关。",
  ].join("\n");
}

function buildDatabaseList(): string {
  const configs = loadDbConfigs();
  const targets = listTargets(configs);

  if (targets.length === 0) {
    if (configs.length === 0) {
      return "暂无数据库连接。请告知用户先执行 /db 编辑 新增连接，再用 /db 启用 开放要访问的库。";
    }
    const names = configs.map((c) => c.name).join(", ");
    return `连接 ${names} 均未启用。请告知用户执行 /db 启用，先启用连接本身，再启用需要访问的库。`;
  }

  const lines = targets.map((target) => {
    const { config } = target;
    const desc = config.description ? ` - ${config.description}` : "";
    return `- ${target.label} [${TYPE_LABELS[config.type]}] ${config.host}:${config.port}${desc}`;
  });

  const trailing = ["", "database 参数必须使用上述「连接名/库名」之一。"];

  // 未启用的库与停用的连接不开放给 AI，只告知模型去提示用户
  const hidden = configs
    .filter((c) => c.enabled)
    .map((c) => {
      const enabled = new Set(enabledDatabases(c).map((d) => d.name));
      return { name: c.name, disabled: allDatabases(c).filter((n) => !enabled.has(n)) };
    })
    .filter((c) => c.disabled.length > 0);

  if (hidden.length > 0) {
    const detail = hidden.map((c) => `${c.name}（未启用: ${c.disabled.join(", ")}）`).join("；");
    trailing.push(`存在但未开放访问的库: ${detail}。如确需访问，提示用户执行 /db 启用。`);
  }

  const disabledConnections = configs.filter((c) => !c.enabled).map((c) => c.name);
  if (disabledConnections.length > 0) {
    trailing.push(`已停用的连接: ${disabledConnections.join(", ")}。其下的库不可访问。`);
  }

  return [...lines, ...trailing].join("\n");
}

// ── 导出扩展 ──────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // 启动时迁移 v2 旧数据（一条连接一个库 → 一条连接多库），写盘前自动备份
  const migration = runStartupMigration(configFilePath(), readRawConfigs, writeRawConfigs);

  pi.on("session_start", async (_event, ctx) => {
    if (migration.migrated) {
      ctx.ui.notify(
        `数据库配置已迁移：${migration.before} 条连接合并为 ${migration.after} 条（同实例多库已启用）。\n` +
          (migration.backupFile ? `原文件备份: ${migration.backupFile}` : ""),
        "info",
      );
    } else if (migration.error) {
      ctx.ui.notify(`数据库配置迁移失败: ${migration.error}`, "warning");
    }
  });

  pi.on("before_agent_start", async (event) => {
    const cfg = loadPluginConfig();
    // 用结构化 section 注入，内容变化时只下发差异，避免每轮全量替换系统提示
    event.systemPromptOptions.sections["database"] = [
      "[数据库工具执行策略]",
      buildPolicyText(cfg),
      "",
      "[可用数据库]",
      buildDatabaseList(),
    ].join("\n");
  });

  registerTools(pi);

  pi.registerCommand("db", {
    description: "AI 接入数据库",
    handler: async (args, ctx) => {
      await handleDbCommand(args, ctx);
    },
  });
}
