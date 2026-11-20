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

/** 结果超过这个数就在头部提醒缩范围，避免被截断后看不全 */
const MANY_TABLES = 200;

/**
 * 参数描述里直接把当前可用目标列出来。
 *
 * 不能只写「见系统提示中的列表」：那个列表在系统提示的末尾，
 * 模型经常读不到，于是回头去猜连接名（试过 database="74"）。
 * 参数是每次调用都会读的位置，写在这里最稳。
 */
function databaseParam(): string {
  const labels = listTargets(loadDbConfigs()).map((t) => t.label);
  const base =
    "数据库目标。写「连接名」时按该连接下全部已启用的库处理；写「连接名/库名」时只针对该库。";
  if (labels.length === 0) return `${base}当前没有可用数据库。`;
  return `${base}当前可用: ${labels.join(", ")}。`;
}

/** 统一的失败返回，并把当前可用目标带上，便于模型自我纠正 */
function failure(message: string) {
  // resolveConnection/resolveTarget 的报错里已经带了可用目标，不再重复追加
  if (message.includes("可用")) {
    return {
      content: [{ type: "text" as const, text: message }],
      details: { success: false, error: message },
      isError: true,
    };
  }

  const available = listTargets(loadDbConfigs()).map((t) => t.label);
  const suffix = available.length > 0 ? `\n\n可用目标: ${available.join(", ")}` : "";
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
      "执行 SQL 语句。先看 database 参数描述里列出的当前可用目标，不要自己拼连接名。使用 list_tables 定位表、describe_table 确认列后再查数据。",
    promptGuidelines: [
      "database 参数只能用 database 参数描述里列出的目标；用户说「74」这类缩写时对应连接名里的数字，找不到就说明未找到，不要猜。",
      "不确定表在哪个库时，对该连接调一次 list_tables（只写连接名）并传 table 参数过滤；不要逐库试。",
      "查询数据前用 describe_table 确认列名，不要凭字段名猜。",
    ],
    parameters: Type.Object({
      database: Type.String({ description: databaseParam() }),
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
      "列出表与视图，包含库名、schema、表名、类型和表注释。database 写成「连接名」时一次枚举该连接下全部已启用的库；传 table 可按表名模糊过滤。",
    promptSnippet:
      "列出库中的表与视图。找表在哪个库时写「连接名」一次拿全，再配 table 过滤；只看单个库就写「连接名/库名」。",
    parameters: Type.Object({
      database: Type.String({ description: databaseParam() }),
      table: Type.Optional(
        Type.String({
          description: "可选。按表名模糊匹配，只返回命中的表，用于快速定位表在哪个库",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: { database: string; table?: string }) {
      const cfg = loadPluginConfig();
      const configs = loadDbConfigs();
      const keyword = params.table?.trim().toLowerCase() ?? "";

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
      let matched = 0;

      for (const item of databases) {
        const connConfig = toConnConfig({ config, database: item.database, label: item.label });
        const result = await listTables(connConfig, cfg.query_timeout);
        if (!result.success) {
          errors.push(`${item.label}: ${result.error}`);
          continue;
        }

        // 给了表名就只留命中项：找表在哪时一次调用就能定位到具体库。
        // 完全相等的排最前，否则搜 wm_x 会先看到 wm_x_bak_20261119，容易选错。
        const tables =
          keyword.length > 0
            ? result.tables
                .filter((t) => t.name.toLowerCase().includes(keyword))
                .sort((a, b) => {
                  const exact = (n: string) => (n.toLowerCase() === keyword ? 0 : 1);
                  return exact(a.name) - exact(b.name) || a.name.length - b.name.length;
                })
            : result.tables;
        matched += tables.length;

        if (tables.length === 0) {
          if (keyword.length === 0) sections.push(`【${item.label}】无表或视图`);
          continue;
        }
        const exact = tables.filter((t) => t.name.toLowerCase() === keyword);
        const rest = tables.filter((t) => t.name.toLowerCase() !== keyword);
        const lines = [...exact.map((t) => `${formatTableLine(t, databases.length > 1)}  ← 精确`), ...rest.map((t) => formatTableLine(t, databases.length > 1))];
        sections.push(`【${item.label}】共 ${tables.length} 个表/视图:\n${lines.join("\n")}`);
        for (const t of tables) {
          allTables.push({ database: item.label, schema: t.schema, name: t.name, type: t.type });
        }
      }

      if (errors.length > 0 && sections.length === 0) {
        return {
          content: [{ type: "text" as const, text: `获取表列表失败: ${errors.join("; ")}` }],
          details: { success: false, error: errors.join("; ") },
          isError: true,
        };
      }

      // 指定了表名却没命中，直接说清去哪找过，避免模型反复扫
      if (keyword.length > 0 && sections.length === 0) {
        const scanned = databases.map((d) => d.label).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `在 ${scanned} 中没有查到名字包含 "${params.table}" 的表。换个关键词，或不带 table 重新列出全部。`,
            },
          ],
          details: { success: true, database: scanned, count: 0, tables: [] },
        };
      }

      // 精确匹配单独点出来，避免模型在多个相似表名里选错
      const exactHits = allTables.filter((t) => t.name.toLowerCase() === keyword);
      const similarCount = matched - exactHits.length;
      const header =
        keyword.length > 0
          ? exactHits.length > 0 && similarCount === 0
            ? `"${params.table}" 命中 ${exactHits.length} 个（${[...new Set(exactHits.map((t) => t.database))].join(", ")}）`
            : exactHits.length > 0
              ? `匹配 "${params.table}" 的表 ${matched} 个；其中完全同名 ${exactHits.length} 个（${[...new Set(exactHits.map((t) => t.database))].join(", ")}），其余 ${similarCount} 个为相似名（如备份表），优先用标注「精确」的那个`
              : `匹配 "${params.table}" 的表 ${matched} 个，都只是名字包含，没有完全同名的`
          : databases.length > 1
            ? `已枚举 ${databases.length} 个启用库`
            : `库 ${databases[0].label}`;
      const suffix = errors.length > 0 ? `\n\n部分库枚举失败:\n${errors.join("\n")}` : "";

      // 结果过多时在头部就说清总量，末尾提醒缩范围；
      // 否则模型只看到截断后的片段，不知道还有多少没显示。
      const tooMany = allTables.length > MANY_TABLES;
      const banner = tooMany
        ? `\n共 ${allTables.length} 个结果，下面只展示开头部分。加 table 参数按表名过滤，否则缩小到单个库（连接名/库名）再看。`
        : "";

      const { text } = truncatePlainText(`${header}${banner}\n\n${sections.join("\n\n")}${suffix}`);

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
      database: Type.String({ description: databaseParam() }),
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
        // 表可能就在同一连接的别的库里，直接把其它库列出来，避免又白扫一轮
        const siblings = enabledDatabases(target.config)
          .map((d) => d.name)
          .filter((n) => n !== target.database);
        const hint =
          siblings.length > 0
            ? `\n该连接下其它库: ${siblings.join(", ")}。用 list_tables（只写连接名 ${target.config.name}）并传 table 参数可一次确认表在哪个库。`
            : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `表 "${params.table}" 不在 ${target.label} 中。${hint}`,
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
