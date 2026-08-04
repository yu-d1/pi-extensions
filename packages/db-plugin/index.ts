import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { query, listTables, describeTable, testConnection, isWriteSql, isDropTable, type ConnConfig } from "./src/db.js";

// ── 类型定义 ──────────────────────────────────────

interface DbConfig {
  id: string;
  name: string;
  type: "postgresql" | "mysql" | "oracle";
  description?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database: string;
  extraParams?: Record<string, string>;
  createdAt: string;
}

// ── 全局插件配置 ────────────────────────────────

interface PluginConfig {
  /** AI 是否只能执行 SELECT（禁止写入） */
  ai_readonly: boolean;
  /** SQL 执行前确认策略: never=不确认 / write=写操作前确认 / always=每次都确认 */
  confirm_before_exec: "never" | "write" | "always";
  /** 查询返回的最大行数 */
  max_rows: number;
  /** 单条 SQL 超时秒数 */
  query_timeout: number;
}

const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  ai_readonly: true,
  confirm_before_exec: "write",
  max_rows: 100,
  query_timeout: 30,
};

// ── 路径 ──────────────────────────────────────────

const CONFIG_FILE = join(homedir(), ".pi", "agent", "db-configs.json");
const PLUGIN_CONFIG_FILE = join(homedir(), ".pi", "agent", "db-plugin-config.json");

// ── JDBC URL 解析 ────────────────────────────────

const DEFAULT_PORTS: Record<string, number> = {
  postgresql: 5432,
  mysql: 3306,
  oracle: 1521,
};

function parseJdbcUrl(url: string): { type: DbConfig["type"]; host: string; port: number; database: string } | null {
  const cleanUrl = url.split("?")[0];

  // PostgreSQL / MySQL: jdbc:postgresql://host:port/db
  const pgMysql = cleanUrl.match(/^jdbc:(postgresql|mysql):\/\/([^:]+)(?::(\d+))?\/(.+)$/);
  if (pgMysql) {
    const type = pgMysql[1] as DbConfig["type"];
    const host = pgMysql[2];
    const port = pgMysql[3] ? parseInt(pgMysql[3], 10) : DEFAULT_PORTS[type];
    const database = pgMysql[4];
    if (!host || !database) return null;
    return { type, host, port, database };
  }

  // Oracle service name: jdbc:oracle:thin:@//host:port/service
  const oraSvc = cleanUrl.match(/^jdbc:oracle:thin:@\/\/([^:]+)(?::(\d+))?\/(.+)$/);
  if (oraSvc) {
    const host = oraSvc[1];
    const port = oraSvc[2] ? parseInt(oraSvc[2], 10) : DEFAULT_PORTS.oracle;
    const database = oraSvc[3];
    if (!host || !database) return null;
    return { type: "oracle", host, port, database };
  }

  // Oracle SID: jdbc:oracle:thin:@host:port:sid
  const oraSid = cleanUrl.match(/^jdbc:oracle:thin:@([^:]+)(?::(\d+))?:(.+)$/);
  if (oraSid) {
    const host = oraSid[1];
    const port = oraSid[2] ? parseInt(oraSid[2], 10) : DEFAULT_PORTS.oracle;
    const database = oraSid[3];
    if (!host || !database) return null;
    return { type: "oracle", host, port, database };
  }

  return null;
}

function reconstructJdbcUrl(config: DbConfig): string {
  if (config.type === "oracle") {
    return `jdbc:oracle:thin:@//${config.host}:${config.port}/${config.database}`;
  }
  return `jdbc:${config.type}://${config.host}:${config.port}/${config.database}`;
}

// ── 配置管理 ──────────────────────────────────────

function loadConfigs(): DbConfig[] {
  if (!existsSync(CONFIG_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveConfigs(configs: DbConfig[]) {
  writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
}

// ── 插件全局配置 ──────────────────────────────────

function loadPluginConfig(): PluginConfig {
  if (!existsSync(PLUGIN_CONFIG_FILE)) return { ...DEFAULT_PLUGIN_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(PLUGIN_CONFIG_FILE, "utf-8"));
    return { ...DEFAULT_PLUGIN_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_PLUGIN_CONFIG };
  }
}

function savePluginConfig(cfg: PluginConfig) {
  writeFileSync(PLUGIN_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getConfigSummary(cfg: PluginConfig): string {
  const readonlyLabel = cfg.ai_readonly ? "是" : "否";
  const confirmLabel =
    cfg.confirm_before_exec === "never" ? "不确认" :
    cfg.confirm_before_exec === "write" ? "写操作确认" : "每次都确认";
  return [
    `AI 只读: ${readonlyLabel}`,
    `执行确认: ${confirmLabel}`,
    `最大行数: ${cfg.max_rows}`,
    `查询超时: ${cfg.query_timeout}s`,
  ].join("\n");
}

function getDbNames(configs: DbConfig[]): string {
  return configs
    .map((c) => {
      const typeLabel = { postgresql: "PG", mysql: "MySQL", oracle: "Oracle" }[c.type] || c.type;
      const desc = c.description ? `(${c.description})` : "";
      return `${c.name}[${typeLabel}]${desc}`;
    })
    .join(", ");
}

function buildDisplayList(configs: DbConfig[]): { list: string[]; map: Map<string, DbConfig> } {
  const map = new Map<string, DbConfig>();
  const list: string[] = [];
  for (const c of configs) {
    const typeLabel = { postgresql: "PG", mysql: "MySQL", oracle: "Oracle" }[c.type] || c.type;
    const desc = c.description ? ` - ${c.description}` : "";
    const display = `${c.name} [${typeLabel}]${desc}`;
    list.push(display);
    map.set(display, c);
  }
  return { list, map };
}

// ── 辅助: 查找数据库配置（忽略大小写和首尾空格） ────

function findConfig(configs: DbConfig[], name: string): DbConfig | undefined {
  const target = name.trim().toLowerCase();
  return configs.find((c) => c.name.toLowerCase() === target);
}

// ── 构建「可用数据库」提示（注入系统提示，让 AI 知道有哪些连接） ────

function buildDbListHint(configs: DbConfig[]): string {
  if (configs.length === 0) {
    return [
      "[可用数据库]",
      "暂无数据库连接。请告知用户先通过 /db add 添加数据库连接，再执行查询。",
    ].join("\n");
  }
  const lines = configs.map((c) => {
    const typeLabel = { postgresql: "PostgreSQL", mysql: "MySQL", oracle: "Oracle" }[c.type] || c.type;
    const desc = c.description ? ` - ${c.description}` : "";
    return `- ${c.name} [${typeLabel}]${desc}`;
  });
  return [
    "[可用数据库]",
    ...lines,
    "query_database / list_tables / describe_table 的 database 参数必须使用上述名称（不含中括号内容，名称区分大小写）。",
  ].join("\n");
}

// ── 辅助: 从 DbConfig 提取 ConnConfig ────────────

function toConnConfig(c: DbConfig): ConnConfig {
  return {
    type: c.type,
    host: c.host || "localhost",
    port: c.port || DEFAULT_PORTS[c.type] || 5432,
    username: c.username || "",
    password: c.password || "",
    database: c.database,
  };
}

// ── 导出扩展 ──────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── 添加数据库连接 ──────────────────────────────
  const addDbConfig = async (ctx: any) => {
    const name = (await ctx.ui.input("连接名称", ""))?.trim();
    if (!name) { ctx.ui.notify("连接名称不能为空", "error"); return; }

    const url = (await ctx.ui.input("JDBC URL", "jdbc:postgresql://host:port/database"))?.trim();
    if (!url) { ctx.ui.notify("JDBC URL 不能为空", "error"); return; }

    const parsed = parseJdbcUrl(url);
    if (!parsed) {
      ctx.ui.notify("JDBC URL 格式无法识别。支持格式:\n" +
        "  PostgreSQL: jdbc:postgresql://host:port/db\n" +
        "  MySQL:      jdbc:mysql://host:port/db\n" +
        "  Oracle:     jdbc:oracle:thin:@//host:port/service", "error");
      return;
    }

    const username = (await ctx.ui.input("账号", "root"))?.trim() || "root";
    const password = (await ctx.ui.input("密码", ""))?.trim();
    const description = (await ctx.ui.input("用途说明（可选）", ""))?.trim() || undefined;

    const typeLabel = { postgresql: "PostgreSQL", mysql: "MySQL", oracle: "Oracle" }[parsed.type];

    // 测试连接
    ctx.ui.notify(`正在测试 ${typeLabel} 连接...`, "info");
    const result = await testConnection({
      type: parsed.type, host: parsed.host, port: parsed.port,
      username, password, database: parsed.database,
    });
    if (!result.success) {
      ctx.ui.notify(`连接失败: ${result.error}`, "error");
      return;
    }
    ctx.ui.notify(`连接成功 (${result.version}, ${result.latency})`, "success");

    const configs = loadConfigs();
    if (configs.some((c) => c.name === name)) {
      ctx.ui.notify(`已存在同名配置: ${name}`, "error");
      return;
    }

    const config: DbConfig = {
      id: randomUUID(),
      name,
      type: parsed.type,
      description,
      host: parsed.host,
      port: parsed.port,
      username,
      password,
      database: parsed.database,
      createdAt: new Date().toISOString(),
    };

    configs.push(config);
    saveConfigs(configs);
    ctx.ui.notify(`配置已保存: ${name}`, "success");
  };

  // ── 编辑数据库连接 ──────────────────────────────
  const editDbConfig = async (ctx: any, original: DbConfig) => {
    const currentUrl = reconstructJdbcUrl(original);
    const prefill = [
      `名称: ${original.name}`,
      `URL: ${currentUrl}`,
      `账号: ${original.username}`,
      `密码: ${original.password || ""}`,
      `说明: ${original.description || ""}`,
    ].join("\n");

    const result = await ctx.ui.editor("编辑数据库连接（修改后保存，留空则保持原值）", prefill);
    if (!result) return;

    // 解析编辑结果
    const lines = result.split("\n");

    function getValue(key: string): string | undefined {
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(key + ":")) {
          return trimmed.slice(key.length + 1).trim();
        }
      }
      return undefined;
    }

    const name = getValue("名称") || original.name;
    const url = getValue("URL") || currentUrl;

    const parsed = parseJdbcUrl(url);
    if (!parsed) {
      ctx.ui.notify("JDBC URL 格式无法识别。", "error");
      return;
    }

    const username = getValue("账号") || original.username || "";
    const password = getValue("密码") ?? original.password ?? "";
    const descRaw = getValue("说明");
    const description = descRaw === "" ? undefined : (descRaw || original.description);

    const updated: DbConfig = {
      ...original,
      name,
      type: parsed.type,
      host: parsed.host,
      port: parsed.port,
      username,
      password,
      database: parsed.database,
      description,
    };

    const all = loadConfigs();
    if (updated.name !== original.name && all.some((c) => c.id !== original.id && c.name === updated.name)) {
      ctx.ui.notify(`已存在同名配置: ${updated.name}`, "error");
      return;
    }

    const idx = all.findIndex((c) => c.id === original.id);
    if (idx < 0) {
      ctx.ui.notify("找不到原配置", "error");
      return;
    }
    all[idx] = updated;
    saveConfigs(all);
    ctx.ui.notify(`已更新: ${updated.name}`, "success");
  };

  // ── 选择数据库公共操作 ────────────────────────────

  const selectDbConfig = async (ctx: any, configs: DbConfig[], title: string): Promise<DbConfig | undefined> => {
    if (configs.length === 0) {
      ctx.ui.notify("尚无数据库连接", "info");
      return undefined;
    }
    const { list, map } = buildDisplayList(configs);
    const choice = await ctx.ui.select(title, list);
    return choice ? map.get(choice) : undefined;
  };

  const showDbList = (ctx: any, configs: DbConfig[]) => {
    if (configs.length === 0) {
      ctx.ui.notify("尚无数据库连接", "info");
      return;
    }
    const lines = configs.map((c) => {
      const typeLabel = { postgresql: "PG", mysql: "MySQL", oracle: "Oracle" }[c.type] || c.type;
      const desc = c.description ? ` - ${c.description}` : "";
      return `  ${c.name} [${typeLabel}]${desc}`;
    });
    ctx.ui.notify(`数据库连接 (${configs.length}):\n${lines.join("\n")}`, "info");
  };

  const deleteDbConfig = async (ctx: any, configs: DbConfig[]) => {
    const target = await selectDbConfig(ctx, configs, "选择要删除的连接");
    if (!target) return;
    const ok = await ctx.ui.confirm("确认删除", `确定删除数据库连接 ${target.name}？`);
    if (!ok) return;
    const all = loadConfigs();
    saveConfigs(all.filter((c) => c.id !== target.id));
    ctx.ui.notify(`已删除: ${target.name}`, "success");
  };

  // ── 选择数据库后操作菜单 ────────────────────────
  const showDbActions = async (ctx: any, config: DbConfig) => {
    const actions = [
      "📝 执行查询",
      "📋 列出表",
      "🔍 查看详情",
      "✏️ 编辑",
      "🗑️ 删除",
    ];
    const choice = await ctx.ui.select(`选择操作 - ${config.name}`, actions);
    if (!choice) return;

    if (choice === "📝 执行查询") {
      const sql = (await ctx.ui.input("输入 SQL 语句", ""))?.trim();
      if (!sql) return;
      ctx.ui.notify("正在执行查询...", "info");
      const cfg = loadPluginConfig();
      const result = await query(toConnConfig(config), sql, true, cfg.max_rows, cfg.query_timeout);
      if (result.success) {
        const lines = [`查询完成 (${result.duration})`, `返回 ${result.rowCount} 行`];
        if (result.columns && result.columns.length > 0) {
          lines.push("列: " + result.columns.join(", "));
        }
        if (result.rows && result.rows.length > 0) {
          const preview = result.rows.slice(0, 10).map((r) => JSON.stringify(r)).join("\n");
          lines.push("数据预览:\n" + preview);
          if (result.rows.length > 10) {
            lines.push(`... 还有 ${result.rows.length - 10} 行`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        ctx.ui.notify(`查询失败: ${result.error}`, "error");
      }
    } else if (choice === "📋 列出表") {
      const result = await listTables(toConnConfig(config));
      if (result.success && result.tables) {
        const lines = result.tables.map((t) => {
          const schema = t.schema ? `${t.schema}.` : "";
          const desc = t.description ? ` - ${t.description}` : "";
          return `${schema}${t.name} (${t.type})${desc}`;
        });
        ctx.ui.notify(`共 ${result.count} 张表:\n` + lines.join("\n"), "info");
      } else {
        ctx.ui.notify(`获取表列表失败: ${result.error}`, "error");
      }
    } else if (choice === "🔍 查看详情") {
      const typeLabel = { postgresql: "PostgreSQL", mysql: "MySQL", oracle: "Oracle" }[config.type] || config.type;
      const url = reconstructJdbcUrl(config);
      const parts = [
        `【名称】 ${config.name}`,
        `【类型】 ${typeLabel}`,
        `【JDBC URL】 ${url}`,
        `【账号】 ${config.username}`,
      ];
      if (config.description) parts.push(`【说明】 ${config.description}`);
      parts.push(`【创建时间】 ${config.createdAt}`);
      ctx.ui.notify(parts.join("\n"), "info");
    } else if (choice === "✏️ 编辑") {
      await editDbConfig(ctx, config);
    } else if (choice === "🗑️ 删除") {
      const ok = await ctx.ui.confirm("确认删除", `确定删除数据库连接 ${config.name}？`);
      if (!ok) return;
      const all = loadConfigs();
      saveConfigs(all.filter((c) => c.id !== config.id));
      ctx.ui.notify(`已删除: ${config.name}`, "success");
    }
  };

  // ── 插件全局配置菜单 ────────────────────────────
  const showPluginConfigMenu = async (ctx: any) => {
    const cfg = loadPluginConfig();
    ctx.ui.notify(`当前设置:\n${getConfigSummary(cfg)}`, "info");
    await editPluginConfig(ctx, cfg);
  };

  const editPluginConfig = async (ctx: any, cfg: PluginConfig) => {
    const fields = [
      {
        key: "ai_readonly" as const,
        label: "AI 只读模式",
        current: cfg.ai_readonly ? "是" : "否",
        options: ["是", "否"],
      },
      {
        key: "confirm_before_exec" as const,
        label: "执行确认",
        current:
          cfg.confirm_before_exec === "never" ? "不确认" :
          cfg.confirm_before_exec === "write" ? "写操作确认" : "每次都确认",
        options: ["不确认", "写操作确认", "每次都确认"],
        valueMap: { "不确认": "never" as const, "写操作确认": "write" as const, "每次都确认": "always" as const },
      },
      {
        key: "max_rows" as const,
        label: "最大行数",
        current: String(cfg.max_rows),
      },
      {
        key: "query_timeout" as const,
        label: "查询超时(s)",
        current: String(cfg.query_timeout),
      },
    ];

    // 选择要修改的字段
    const fieldLabels = fields.map((f) => `${f.label}（当前: ${f.current}）`);
    fieldLabels.push("✅ 完成修改");

    const newCfg = { ...cfg };

    while (true) {
      const pick = await ctx.ui.select("选择要修改的设置项", fieldLabels);
      if (!pick || pick === "✅ 完成修改") break;

      const idx = fieldLabels.indexOf(pick);
      if (idx < 0) break;
      const field = fields[idx];

      if (field.options) {
        // 枚举型 -> 选择
        const val = await ctx.ui.select(`选择 ${field.label}`, field.options);
        if (!val) continue;
        if (field.valueMap) {
          (newCfg as any)[field.key] = field.valueMap[val];
        } else {
          (newCfg as any)[field.key] = val === "是";
        }
      } else {
        // 数字型 -> 输入
        const input = await ctx.ui.input(`${field.label}（当前: ${field.current}）`, field.current);
        if (!input) continue;
        const num = parseInt(input, 10);
        if (isNaN(num) || num <= 0) {
          ctx.ui.notify("请输入正整数", "error");
          continue;
        }
        (newCfg as any)[field.key] = num;
      }

      // 更新 fieldLabels 中的当前值
      const updatedFields = fields.map((f) => {
        const val = (newCfg as any)[f.key];
        const display =
          f.key === "ai_readonly" ? (val ? "是" : "否") :
          f.key === "confirm_before_exec" ?
            (val === "never" ? "不确认" : val === "write" ? "写操作确认" : "每次都确认") :
            String(val);
        return `${f.label}（当前: ${display}）`;
      });
      updatedFields.push("✅ 完成修改");
      fieldLabels.length = 0;
      fieldLabels.push(...updatedFields);
    }

    savePluginConfig(newCfg);
    ctx.ui.notify(`设置已保存\n${getConfigSummary(newCfg)}`, "success");
  };

  // ── 系统提示注入：每轮告知 AI 可用数据库列表 ──────
  // 解决 AI 不知道有哪些数据库连接、database 参数只能靠猜的问题。

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + "\n\n" + buildDbListHint(loadConfigs()) };
  });

  // ── 注册 3 个工具（给 LLM 调用） ──────────────────

  // 工具 1: query_database
  pi.registerTool({
    name: "query_database",
    label: "数据库查询",
    description: "执行 SQL 查询，支持 PostgreSQL / MySQL / Oracle。返回结果集。只读模式下仅允许 SELECT 查询。",
    promptSnippet: "执行 SQL 查询。database 参数取系统提示「可用数据库」列表中的名称。使用 list_tables 查看表结构后再编写 SQL。",
    parameters: Type.Object({
      database: Type.String({ description: "数据库连接名称（取系统提示「可用数据库」列表中的名称）" }),
      sql: Type.String({ description: "SQL 语句" }),
    }),
    async execute(_toolCallId: string, params: { database: string; sql: string }, _signal: any, _onUpdate?: any, ctx?: any) {
      const cfg = loadPluginConfig();

      // 硬限制：禁止 AI 删除表
      if (isDropTable(params.sql)) {
        return {
          content: [{ type: "text" as const, text: "禁止通过 AI 执行 DROP TABLE 操作。如需删除表，请手动连接数据库执行。" }],
        };
      }

      // 只读检查
      if (cfg.ai_readonly && isWriteSql(params.sql)) {
        return {
          content: [{ type: "text" as const, text: "当前配置为 AI 只读模式，不允许执行写操作。如需修改，请执行 /db config set 更改配置。" }],
        };
      }

      // 确认策略
      if (cfg.confirm_before_exec === "always" || (cfg.confirm_before_exec === "write" && isWriteSql(params.sql))) {
        if (!ctx?.hasUI) {
          return {
            content: [{ type: "text" as const, text: "当前环境无法弹出确认对话框，已取消 SQL 执行。请在有界面的环境中操作。" }],
          };
        }
        const ok = await ctx.ui.confirm(
          "SQL 执行确认",
          `数据库: ${params.database}\n\nSQL:\n${params.sql}`
        );
        if (!ok) {
          return {
            content: [{ type: "text" as const, text: "用户取消了 SQL 执行。" }],
          };
        }
        // 用户确认，继续执行
      }

      const configs = loadConfigs();
      const config = findConfig(configs, params.database);
      if (!config) {
        const available = configs.map((c) => c.name).join(", ") || "无";
        return {
          content: [{ type: "text" as const, text: `数据库 "${params.database}" 未找到。可用数据库: ${available}。database 参数应使用系统提示「可用数据库」列表中的名称。` }],
        };
      }

      const result = await query(
        toConnConfig(config),
        params.sql,
        cfg.ai_readonly,
        cfg.max_rows,
        cfg.query_timeout,
      );

      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `查询失败: ${result.error}` }],
        };
      }

      let text = `查询完成 (${result.duration})，返回 ${result.rowCount} 行\n`;
      if (result.columns && result.columns.length > 0) {
        text += `列: ${result.columns.join(", ")}\n\n`;
      }
      if (result.rows && result.rows.length > 0) {
        // 格式化为表格文本
        const header = result.columns?.join(" | ") || "";
        const separator = result.columns?.map(() => "---").join(" | ") || "";
        const rows = result.rows.slice(0, 50).map((r) => r.join(" | "));
        text += [header, separator, ...rows].join("\n");
        if (result.rows.length > 50) {
          text += `\n... 还有 ${result.rows.length - 50} 行`;
        }
      } else {
        text += "无数据返回。";
      }

      return { content: [{ type: "text" as const, text }] };
    },
  });

  // 工具 2: list_tables
  pi.registerTool({
    name: "list_tables",
    label: "列出数据库表",
    description: "列出指定数据库中的所有表，包含 schema、表名、类型。",
    promptSnippet: "列出数据库中的表，了解表结构后再查询。database 参数取系统提示「可用数据库」列表中的名称。",
    parameters: Type.Object({
      database: Type.String({ description: "数据库连接名称（取系统提示「可用数据库」列表中的名称）" }),
    }),
    async execute(_toolCallId: string, params: { database: string }, _signal: any) {
      const configs = loadConfigs();
      const config = findConfig(configs, params.database);
      if (!config) {
        return {
          content: [{ type: "text" as const, text: `数据库 "${params.database}" 未找到。可用数据库: ${configs.map((c) => c.name).join(", ") || "无"}` }],
        };
      }

      const result = await listTables(toConnConfig(config));

      if (!result.success || !result.tables) {
        return {
          content: [{ type: "text" as const, text: `获取表列表失败: ${result.error}` }],
        };
      }

      const lines = result.tables.map((t) => {
        const schema = t.schema ? `${t.schema}.` : "";
        const desc = t.description ? ` - ${t.description}` : "";
        return `${schema}${t.name} (${t.type})${desc}`;
      });

      return {
        content: [{ type: "text" as const, text: `数据库 "${params.database}" 共 ${result.count} 张表:\n${lines.join("\n")}` }],
      };
    },
  });

  // 工具 3: describe_table
  pi.registerTool({
    name: "describe_table",
    label: "查看表结构",
    description: "查看指定表的列定义、类型、默认值、主键等。",
    promptSnippet: "查看表结构，了解列名和类型后编写精确的 SQL。database 参数取系统提示「可用数据库」列表中的名称。",
    parameters: Type.Object({
      database: Type.String({ description: "数据库连接名称（取系统提示「可用数据库」列表中的名称）" }),
      table: Type.String({ description: "表名（可带 schema，如 public.users）" }),
    }),
    async execute(_toolCallId: string, params: { database: string; table: string }, _signal: any) {
      const configs = loadConfigs();
      const config = findConfig(configs, params.database);
      if (!config) {
        return {
          content: [{ type: "text" as const, text: `数据库 "${params.database}" 未找到。可用数据库: ${configs.map((c) => c.name).join(", ") || "无"}` }],
        };
      }

      const result = await describeTable(toConnConfig(config), params.table);

      if (!result.success || !result.columns) {
        return {
          content: [{ type: "text" as const, text: `获取表结构失败: ${result.error}` }],
        };
      }

      const lines = [`表: ${params.table}`, `共 ${result.count} 列\n`];
      // 表头
      lines.push("列名 | 类型 | 可空 | 默认值 | 主键 | 说明");
      lines.push("--- | --- | --- | --- | --- | ---");
      for (const col of result.columns) {
        lines.push(
          `${col.name} | ${col.type} | ${col.nullable ? "YES" : "NO"} | ${col.default ?? ""} | ${col.primaryKey ? "✓" : ""} | ${col.comment || ""}`
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  });

  // ── 注册 /db 命令（给用户管理连接） ──────────────
  pi.registerCommand("db", {
    description: "AI 接入数据库",
    handler: async (args: string, ctx: any) => {
      const sub = args.trim().toLowerCase();
      const configs = loadConfigs();

      if (!sub) {
        // 导航菜单：查看 / 编辑 / 新增 / 删除 / 设置
        const navActions = [
          "📋 查看连接",
          "✏️ 编辑连接",
          "➕ 新增连接",
          "🗑️ 删除连接",
          "⚙️ 设置",
        ];
        const navChoice = await ctx.ui.select("数据库管理", navActions);
        if (!navChoice) return;

        if (navChoice === "⚙️ 设置") {
          await showPluginConfigMenu(ctx);
        } else if (navChoice === "📋 查看连接") {
          const config = await selectDbConfig(ctx, configs, "选择连接");
          if (config) await showDbActions(ctx, config);
        } else if (navChoice === "✏️ 编辑连接") {
          const config = await selectDbConfig(ctx, configs, "选择要编辑的连接");
          if (config) await editDbConfig(ctx, config);
        } else if (navChoice === "➕ 新增连接") {
          await addDbConfig(ctx);
        } else if (navChoice === "🗑️ 删除连接") {
          await deleteDbConfig(ctx, configs);
        }
      } else if (sub === "config" || sub === "c") {
        await showPluginConfigMenu(ctx);
      } else if (sub === "add" || sub === "new" || sub === "a") {
        await addDbConfig(ctx);
      } else if (sub === "edit" || sub === "e") {
        const config = await selectDbConfig(ctx, configs, "选择要编辑的连接");
        if (config) await editDbConfig(ctx, config);
      } else if (sub === "rm" || sub === "remove" || sub === "del" || sub === "delete" || sub === "d") {
        await deleteDbConfig(ctx, configs);
      } else if (sub === "ls" || sub === "list") {
        showDbList(ctx, configs);
      } else {
        ctx.ui.notify(
          "用法: /db [add|edit|rm|ls|config]\n" +
          "  add    新增数据库连接\n" +
          "  edit   编辑连接\n" +
          "  rm     删除连接\n" +
          "  ls     列出所有连接\n" +
          "  config 查看/修改插件设置\n" +
          "  默认    打开管理菜单（查看/编辑/新增/删除/设置）",
          "info"
        );
      }
    },
  });
}