import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  describeMaxRows,
  enabledDatabases,
  listTargets,
  loadDbConfigs,
  loadPluginConfig,
  parseSpec,
  resolveConnection,
  resolveTarget,
  type DbConfig,
} from "./config.js";
import { describeTable, listTables, query, type ColumnInfo, type TableInfo } from "./connection.js";
import { renderRows, renderSummary, toConnConfig, truncatePlainText } from "./format.js";
import { checkSqlPolicy, splitStatements } from "./policy.js";

const DATABASE_PARAM =
  "数据库目标。写「连接名」时按该连接下全部已启用的库处理；写「连接名/库名」时只针对该库。取值见系统提示「可用数据库」列表。";

/** 统一的失败返回，并附上当前可用目标，便于模型自我纠正 */
function failure(message: string) {
  const available = listTargets(loadDbConfigs()).map((t) => t.label);
  const suffix =
    available.length > 0
      ? `\n\n可用目标: ${available.join(", ")}`
      : "\n\n暂无可用数据库，请提示用户先执行 /db 新增连接并启用数据库。";
  return {
    content: [{ type: "text" as const, text: `${message}${suffix}` }],
    details: { success: false, error: message },
    isError: true,
  };
}

export function registerTools(pi: ExtensionAPI) {
  // ── query_database ────────────────────────────
  pi.registerTool({
    name: "query_database",
    label: "数据库查询",
    description:
      "执行 SQL 语句，支持 PostgreSQL / MySQL / Oracle。多条语句用分号分隔，返回最后一条语句的结果集。是否允许写操作以系统提示中的当前数据库工具执行策略为准。DROP TABLE 等删除结构操作始终禁止。",
    promptSnippet:
      "执行 SQL 语句。先根据系统提示中的当前数据库工具执行策略判断是否允许写操作；database 参数取系统提示「可用数据库」列表中的「连接名/库名」。使用 list_tables 查看表清单、describe_table 查看列结构后再编写 SQL。",
    promptGuidelines: [
      "调用 query_database 时，database 参数必须使用系统提示「可用数据库」列表中列出的「连接名/库名」；列表为空时提示用户执行 /db 新增连接并启用数据库。",
      "调用 query_database 查询表数据前，先用 list_tables 与 describe_table 确认表名和列名，不要猜测字段。",
      "query_database 的输出会被截断，查询大表时用 LIMIT 或 WHERE 缩小范围，不要依赖默认行数上限。",
    ],
    parameters: Type.Object({
      database: Type.String({ description: DATABASE_PARAM }),
      sql: Type.String({ description: "SQL 语句" }),
    }),
    async execute(_toolCallId: string, params: { database: string; sql: string }, signal?: AbortSignal) {
      const cfg = loadPluginConfig();
      const policy = checkSqlPolicy(params.sql, cfg.ai_readonly);
      if (!policy.allowed) {
        return failure(policy.reason ?? "语句被拒绝执行");
      }

      const resolved = resolveTarget(loadDbConfigs(), params.database);
      if (!resolved.ok) return failure(resolved.error);

      if (signal?.aborted) {
        return failure("已取消执行。");
      }

      const { target } = resolved;
      const statements = splitStatements(params.sql).map((s) => s.sql);
      const result = await query(toConnConfig(target), statements, cfg.max_rows, cfg.query_timeout);

      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `查询失败 (${target.label}): ${result.error}` }],
          details: { success: false, database: target.label, error: result.error ?? "" },
          isError: true,
        };
      }

      const { text: table } = renderRows({
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `${renderSummary(target.label, result.durationMs, result.rowCount, cfg)}\n\n${table}`,
          },
        ],
        details: {
          success: true,
          database: target.label,
          columns: result.columns,
          rowCount: result.rowCount,
          durationMs: result.durationMs,
          maxRows: describeMaxRows(cfg.max_rows),
        },
      };
    },
  });

  // ── list_tables ───────────────────────────────
  pi.registerTool({
    name: "list_tables",
    label: "列出数据库表",
    description:
      "列出表与视图，包含库名、schema、表名、类型和表注释。database 写成「连接名」时一次枚举该连接下全部已启用的库。",
    promptSnippet:
      "列出库中的表与视图。database 写「连接名」可一次查看该连接下全部已启用库的表；写「连接名/库名」只看单个库。",
    parameters: Type.Object({
      database: Type.String({ description: DATABASE_PARAM }),
    }),
    async execute(_toolCallId: string, params: { database: string }) {
      const cfg = loadPluginConfig();
      const configs = loadDbConfigs();

      // 未指定库时枚举连接下所有已启用的库
      const { dbName } = parseSpec(params.database);
      const databases: Array<{ label: string; database?: string }> = [];
      let config: DbConfig;

      if (!dbName) {
        const resolved = resolveConnection(configs, params.database);
        if (!resolved.ok) return failure(resolved.error);
        config = resolved.config;
        for (const entry of enabledDatabases(config)) {
          databases.push({ label: `${config.name}/${entry.name}`, database: entry.name });
        }
      } else {
        const resolved = resolveTarget(configs, params.database);
        if (!resolved.ok) return failure(resolved.error);
        config = resolved.target.config;
        databases.push({ label: resolved.target.label, database: resolved.target.database });
      }

      const sections: string[] = [];
      const allTables: Array<{ database: string; schema: string; name: string; type: string }> = [];
      const errors: string[] = [];

      for (const item of databases) {
        const connConfig = toConnConfig({ config, database: item.database, label: item.label });
        const result = await listTables(connConfig, cfg.query_timeout);
        if (!result.success) {
          errors.push(`${item.label}: ${result.error}`);
          continue;
        }
        if (result.tables.length === 0) {
          sections.push(`【${item.label}】无表或视图`);
          continue;
        }
        const lines = result.tables.map((t) => formatTableLine(t, databases.length > 1));
        sections.push(`【${item.label}】共 ${result.tables.length} 个表/视图:\n${lines.join("\n")}`);
        for (const t of result.tables) {
          allTables.push({ database: item.label, schema: t.schema, name: t.name, type: t.type });
        }
      }

      if (sections.length === 0) {
        return {
          content: [{ type: "text" as const, text: `获取表列表失败: ${errors.join("; ")}` }],
          details: { success: false, error: errors.join("; ") },
          isError: true,
        };
      }

      const header =
        databases.length > 1
          ? `已枚举 ${databases.length} 个启用库`
          : `库 ${databases[0].label}`;
      const suffix = errors.length > 0 ? `\n\n部分库枚举失败:\n${errors.join("\n")}` : "";
      const { text } = truncatePlainText(`${header}\n\n${sections.join("\n\n")}${suffix}`);

      return {
        content: [{ type: "text" as const, text }],
        details: {
          success: true,
          database: databases.map((d) => d.label).join(", "),
          count: allTables.length,
          tables: allTables,
        },
      };
    },
  });

  // ── describe_table ────────────────────────────
  pi.registerTool({
    name: "describe_table",
    label: "查看表结构",
    description: "查看指定表的列定义、类型、可空、默认值、主键与列注释。",
    promptSnippet:
      "查看表结构，了解列名与类型后编写精确的 SQL。database 用「连接名/库名」；该连接只启用一个库时可只写连接名。",
    parameters: Type.Object({
      database: Type.String({ description: DATABASE_PARAM }),
      table: Type.String({ description: "表名，可带 schema，如 public.users" }),
    }),
    async execute(_toolCallId: string, params: { database: string; table: string }) {
      const cfg = loadPluginConfig();
      const resolved = resolveTarget(loadDbConfigs(), params.database);
      if (!resolved.ok) return failure(resolved.error);

      const { target } = resolved;
      const result = await describeTable(toConnConfig(target), params.table, cfg.query_timeout);
      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `获取表结构失败 (${target.label}.${params.table}): ${result.error}` }],
          details: { success: false, database: target.label, table: params.table, error: result.error ?? "" },
          isError: true,
        };
      }

      if (result.columns.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `未找到表 "${params.table}"，或当前账号无权查看。可先用 list_tables 确认表名。`,
            },
          ],
          details: { success: false, database: target.label, table: params.table, error: "表不存在或无权访问" },
          isError: true,
        };
      }

      const lines = [
        `表: ${target.label}.${params.table}`,
        `共 ${result.columns.length} 列`,
        "",
        "| 列名 | 类型 | 可空 | 默认值 | 主键 | 说明 |",
        "| --- | --- | --- | --- | --- | --- |",
        ...result.columns.map(formatColumnLine),
      ];
      const { text } = truncatePlainText(lines.join("\n"));

      return {
        content: [{ type: "text" as const, text }],
        details: {
          success: true,
          database: target.label,
          table: params.table,
          columns: result.columns,
        },
      };
    },
  });
}

function formatTableLine(table: TableInfo, keepSchema = true): string {
  const fullName = keepSchema && table.schema ? `${table.schema}.${table.name}` : table.name;
  const desc = table.description ? ` - ${table.description}` : "";
  return `${fullName} (${table.type})${desc}`;
}

function formatColumnLine(column: ColumnInfo): string {
  const nullable = column.nullable ? "YES" : "NO";
  const fallback = column.default ?? "";
  const primaryKey = column.primaryKey ? "是" : "";
  return `| ${column.name} | ${column.type} | ${nullable} | ${fallback} | ${primaryKey} | ${column.comment} |`;
}
