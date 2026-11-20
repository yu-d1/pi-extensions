import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  TYPE_LABELS,
  configFilePath,
  listTargets,
  loadDbConfigs,
  loadPluginConfig,
  readRawConfigs,
  writeRawConfigs,
  type DbTarget,
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

  // 停用的连接与未启用的库都不出现在这里：对 AI 而言它们不存在。
  // 列出来只会诱导模型去建议用户开启，而开启是用户自己的决定。
  if (targets.length === 0) {
    return "暂无可用数据库。";
  }

  const lines = targets.map((target) => {
    const { config } = target;
    const desc = config.description ? ` - ${config.description}` : "";
    return `- ${target.label} [${TYPE_LABELS[config.type]}] ${config.host}:${config.port}${desc}`;
  });

  // 段首先说明这就是全部，避免模型以为列表在别处而去猜连接名
  const listHeader = `以下是当前全部可用目标（共 ${targets.length} 个），没有其它：`;

  const hints = ["", "database 参数必须使用上述「连接名/库名」之一。"];

  // 多个目标时才有定位问题，只有一个就不用讲规则占地方
  if (targets.length > 1) {
    hints.push("", "定位规则：");
    hints.push("1. 先定连接。用户提到数字或主机时，对应连接名里的数字（如 74 → " +
      connectionHints(targets, "74") + "）。");
    hints.push("2. 再定库。多连接下有同名库时，按用户说的连接、主机或业务含义定；无法区分时问一句，不要逐个试。");
    hints.push("3. 找表在哪个库：list_tables 只写连接名，一次返回该连接全部启用库的表；再补 table 参数可直接过滤。");

    const duplicates = duplicateLibraryNames(targets);
    if (duplicates.length > 0) {
      hints.push(`   同名库（属于多个连接，必须问清）: ${duplicates.join(", ")}`);
    }

    const sample = targets[0].config.name;
    hints.push("", `示例：用户说「查 ${sampleNumeral(sample) ?? "74"} 的 wm_waterquality_hour_records 结构」`);
    hints.push(`  list_tables  database=${sample}  table=wm_waterquality_hour_records`);
    hints.push(`  describe_table  database=<命中的连接名/库名>  table=wm_waterquality_hour_records`);
  }

  return [listHeader, ...lines, ...hints].join("\n");
}

/** 把用户说的数字映射回实际连接名，例如 74 → pg_74 */
function connectionHints(targets: DbTarget[], number: string): string {
  const hits = [...new Set(targets.filter((t) => t.config.name.includes(number)).map((t) => t.config.name))];
  return hits.length > 0 ? hits.join(" / ") : `包含 ${number} 的连接`;
}

/** 从连接名里取出数字，用于示例文案 */
function sampleNumeral(name: string): string | undefined {
  const hit = name.match(/\d+/);
  return hit?.[0];
}

/** 在多个连接下重名的库，选择时必须问用户 */
function duplicateLibraryNames(targets: DbTarget[]): string[] {
  const owners = new Map<string, Set<string>>();
  for (const target of targets) {
    const set = owners.get(target.database) ?? new Set<string>();
    set.add(target.config.name);
    owners.set(target.database, set);
  }
  return [...owners.entries()].filter(([, set]) => set.size > 1).map(([name]) => name);
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
