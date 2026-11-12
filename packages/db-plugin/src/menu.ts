import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_PLUGIN_CONFIG,
  DEFAULT_PORTS,
  MAX_ROWS_OPTIONS,
  TYPE_LABELS,
  allDatabases,
  describeMaxRows,
  enabledDatabases,
  formatPluginConfig,
  loadDbConfigs,
  loadPluginConfig,
  saveDbConfigs,
  savePluginConfig,
  setDatabaseEnabled,
  type DbConfig,
  type DbType,
  type PluginConfig,
} from "./config.js";
import { listDatabases, testConnection } from "./connection.js";
import { pickEnabledItems } from "./toggle-selector.js";

// ── 菜单文案 ──────────────────────────────────────

const MENU_ENABLE = "启用";
const MENU_EDIT = "编辑";
const MENU_VIEW = "查看";
const MENU_REMOVE = "删除";
const MENU_SETTINGS = "设置";

const MENU_ADD_LINK = "新增连接";
const MENU_EDIT_LINK = "编辑连接信息";
const MENU_MANUAL = "手动输入库名";
const MENU_RESCAN = "重新扫描库清单";
const MENU_DONE = "完成";

const CONFIG_DONE = "完成修改";
const CUSTOM_ROWS = "自定义输入";

const ON = "已启用";
const OFF = "已停用";

/** 启用组件中代表「连接本身」的条目 id，库名不会与之冲突 */
const CONNECTION_ITEM_ID = "\u0000connection";

// ── 依据类型与地址推导连接名 ──────────────────────

/** postgresql 192.168.250.74:5432 → pg74-5432 */
function deriveConnectionName(type: DbType, host: string, port: number): string {
  const prefix = type === "mysql" ? "mysql" : type === "oracle" ? "ora" : "pg";
  const lastOctet = host.split(".").filter(Boolean).pop() ?? host;
  const base = `${prefix}${lastOctet}`.replace(/[^\w-]+/g, "-");
  return port ? `${base}-${port}` : base;
}

// ── 列表展示 ──────────────────────────────────────

function connectionState(config: DbConfig): string {
  if (!config.enabled) return OFF;
  const enabled = enabledDatabases(config);
  return enabled.length > 0 ? `已启用 ${enabled.length} 个库` : OFF;
}

function displayName(config: DbConfig): string {
  const desc = config.description ? ` - ${config.description}` : "";
  const host = `${config.host}:${config.port}`;
  return `${config.name} [${TYPE_LABELS[config.type]}] ${host} ${connectionState(config)}${desc}`;
}

function buildSelection(configs: DbConfig[]): { list: string[]; map: Map<string, DbConfig> } {
  const map = new Map<string, DbConfig>();
  const list = configs.map((c) => {
    const label = displayName(c);
    map.set(label, c);
    return label;
  });
  return { list, map };
}

async function pickConfig(
  ctx: ExtensionContext,
  title: string,
  extraOptions: string[] = [],
): Promise<{ config?: DbConfig; extra?: string } | undefined> {
  const configs = loadDbConfigs();
  if (configs.length === 0 && extraOptions.length === 0) {
    ctx.ui.notify("尚未配置连接，请先新增连接。", "info");
    return undefined;
  }
  const { list, map } = buildSelection(configs);
  const options = [...list, ...extraOptions];
  const choice = await ctx.ui.select(title, options);
  if (!choice) return undefined;
  const config = map.get(choice);
  return config ? { config } : { extra: choice };
}

function persist(updated: DbConfig): boolean {
  const configs = loadDbConfigs();
  const index = configs.findIndex((c) => c.id === updated.id);
  if (index < 0) return false;
  configs[index] = updated;
  saveDbConfigs(configs);
  return true;
}

function findById(id: string): DbConfig | undefined {
  return loadDbConfigs().find((c) => c.id === id);
}

// ── 启用：连接级 + 库级 ───────────────────────────

/**
 * 候选库清单 = 已保存的库 ∪ 服务器扫描结果。
 * 扫描失败不阻塞操作，用户仍可手动输入库名。
 */
async function collectDatabaseNames(ctx: ExtensionContext, config: DbConfig): Promise<string[]> {
  const names = new Set(allDatabases(config));

  ctx.ui.notify(`正在扫描 ${config.name} 的库清单...`, "info");
  const scanned = await listDatabases(
    {
      type: config.type,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
    },
    10,
  );

  if (scanned.success) {
    for (const name of scanned.databases) names.add(name);
  } else {
    ctx.ui.notify(`扫描库清单失败: ${scanned.error}\n可手动输入要启用的库名。`, "warning");
  }

  return [...names];
}

/** 连接级开关：整条连接停用后，其下所有库都不再对 AI 开放 */
function toggleConnection(ctx: ExtensionContext, config: DbConfig): DbConfig {
  const next = { ...config, enabled: !config.enabled };
  persist(next);
  ctx.ui.notify(`连接 ${next.name} 已${next.enabled ? "启用" : "停用"}`, "success");
  return next;
}

/** 把当前选中的条目 id 列表写回配置 */
function applySelection(config: DbConfig, selectedIds: string[], allNames: string[]): DbConfig {
  const connectionOn = selectedIds.includes(CONNECTION_ITEM_ID);
  const selectedNames = new Set(selectedIds.filter((id) => id !== CONNECTION_ITEM_ID));

  // 扫描到的新库写入清单，保持原有启用状态
  const databases = allNames.map((name) => ({ name, enabled: selectedNames.has(name) }));
  for (const name of selectedNames) {
    if (!databases.some((d) => d.name === name)) databases.push({ name, enabled: true });
  }

  return { ...config, enabled: connectionOn, databases };
}

async function enableMenu(ctx: ExtensionContext, original: DbConfig) {
  const names = await collectDatabaseNames(ctx, original);
  let current = findById(original.id) ?? original;

  // TUI 下用搜索 + 多选组件；非 TUI 退回逐项菜单
  if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
    /** 把勾选结果写盘：^s 与退出时共用 */
    const save = (selected: string[], added: string[]): string | undefined => {
      const latest = findById(original.id);
      if (!latest) return "配置已不存在，可能被删除";

      const mergedNames = [...new Set([...names, ...added])];
      const next = applySelection(latest, selected, mergedNames);
      if (enabledDatabases(next).length === 0) return "至少需要启用一个库";

      persist(next);
      current = next;
      return undefined;
    };

    const result = await pickEnabledItems(ctx, {
      title: `启用 - ${current.name}`,
      subtitle: "勾选的库对 AI 开放",
      hint: "搜索框输入新库名后回车可新增；空格切换，^a 全选，^s 保存",
      countLabel: "已启用",
      items: [
        {
          id: CONNECTION_ITEM_ID,
          label: "连接本身",
          badge: `${TYPE_LABELS[current.type]} ${current.host}:${current.port}`,
          detail: "停用后该连接下所有库都不对 AI 开放",
          pinned: true,
        },
        ...names.map((name) => ({
          id: name,
          label: name,
          badge: enabledDatabases(current).some((d) => d.name === name) ? "当前启用" : undefined,
        })),
      ],
      initialMarked: [
        ...(current.enabled ? [CONNECTION_ITEM_ID] : []),
        ...enabledDatabases(current).map((d) => d.name),
      ],
      minSelected: 1,
      // ^s：保存后留在界面继续调整
      onSave: async ({ selected, added }) => {
        const error = save(selected, added);
        if (error) throw new Error(error);
      },
    });

    // esc：未修改则完成，有未保存修改则已确认放弃（返回 null）
    if (result) {
      const error = save(result.selected, result.added);
      if (error) {
        ctx.ui.notify(`${error}，已保留原有配置。`, "warning");
      } else {
        for (const name of result.added) {
          ctx.ui.notify(`已新增库: ${name}`, "success");
        }
      }
    }

    const finalConfig = findById(original.id);
    if (finalConfig) {
      const summary = finalConfig.enabled
        ? enabledDatabases(finalConfig).map((d) => d.name).join(", ") || "无"
        : "连接已停用";
      ctx.ui.notify(`连接 ${finalConfig.name} 当前状态: ${summary}`, "info");
    }
    return;
  }

  // 非 TUI 环境的兼容菜单
  while (true) {
    current = findById(original.id) ?? original;
    const enabledSet = new Set(enabledDatabases(current).map((d) => d.name));

    const options = [
      `${current.enabled ? ON : OFF} 连接本身`,
      ...names.map((name) => `${enabledSet.has(name) ? ON : OFF} ${name}`),
      MENU_MANUAL,
      MENU_RESCAN,
      MENU_DONE,
    ];

    const choice = await ctx.ui.select(`启用 - ${current.name}`, options);
    if (!choice || choice === MENU_DONE) break;

    if (choice.startsWith("连接本身")) {
      current = toggleConnection(ctx, current);
      continue;
    }

    if (choice === MENU_MANUAL) {
      const input = (await ctx.ui.input("输入库名（Oracle 为服务名）", ""))?.trim();
      if (!input) continue;
      if (!names.includes(input)) names = [...names, input];
      persist(setDatabaseEnabled(findById(current.id) ?? current, input, true));
      ctx.ui.notify(`已启用库: ${input}`, "success");
      continue;
    }

    if (choice === MENU_RESCAN) {
      const rescanned = await collectDatabaseNames(ctx, current);
      names = [...new Set([...names, ...rescanned])];
      continue;
    }

    const name = choice.replace(/^(已启用|已停用)\s+/, "");
    const latest = findById(current.id) ?? current;
    const nextEnabled = !enabledSet.has(name);

    const candidate = setDatabaseEnabled(latest, name, nextEnabled);
    if (!candidate.databases.some((d) => d.enabled)) {
      ctx.ui.notify("至少需要启用一个库。", "warning");
      continue;
    }

    persist(candidate);
    ctx.ui.notify(`${nextEnabled ? "已启用" : "已停用"}库: ${name}`, "success");
  }

  const finalConfig = findById(original.id);
  if (!finalConfig) return;
  const summary = finalConfig.enabled
    ? enabledDatabases(finalConfig).map((d) => d.name).join(", ") || "无"
    : "连接已停用";
  ctx.ui.notify(`连接 ${finalConfig.name} 当前状态: ${summary}`, "info");
}

async function pickAndEnable(ctx: ExtensionContext, preset?: DbConfig) {
  const target = preset ?? (await pickConfig(ctx, "选择要启用的连接"))?.config;
  if (!target) return;
  await enableMenu(ctx, target);
}

// ── 编辑：编辑已有连接或新增 ───────────────────────

async function pickAndEdit(ctx: ExtensionContext) {
  const picked = await pickConfig(ctx, "选择要编辑的连接", [MENU_ADD_LINK]);
  if (!picked) return;
  if (picked.extra === MENU_ADD_LINK) {
    await addConfig(ctx);
    return;
  }
  if (picked.config) await editConfig(ctx, picked.config);
}

async function addConfig(ctx: ExtensionContext) {
  // 直接选类型 + 地址 + 库名，不让用户手拼 JDBC URL
  const typeChoice = await ctx.ui.select("数据库类型", ["PostgreSQL", "MySQL", "Oracle"]);
  if (!typeChoice) return;
  const type: DbType =
    typeChoice === "MySQL" ? "mysql" : typeChoice === "Oracle" ? "oracle" : "postgresql";

  const host = (await ctx.ui.input("主机地址", "192.168.1.10"))?.trim();
  if (!host) {
    ctx.ui.notify("主机地址不能为空。", "error");
    return;
  }

  const portInput = (await ctx.ui.input("端口", String(DEFAULT_PORTS[type])))?.trim();
  const port = Number(portInput || DEFAULT_PORTS[type]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.ui.notify("端口无效。", "error");
    return;
  }

  // Oracle 必须填服务名；PostgreSQL / MySQL 可留空，之后扫描并选库
  const dbPrompt =
    type === "oracle"
      ? "服务名（必填）"
      : "数据库名（可选，留空则扫描全部库）";
  const database = (await ctx.ui.input(dbPrompt, ""))?.trim() || undefined;
  if (type === "oracle" && !database) {
    ctx.ui.notify("Oracle 必须填写服务名。", "error");
    return;
  }

  const username = (await ctx.ui.input("账号", ""))?.trim();
  if (!username) {
    ctx.ui.notify("账号不能为空。", "error");
    return;
  }
  const password = (await ctx.ui.input("密码", "")) ?? "";
  const description = (await ctx.ui.input("用途说明（可选）", ""))?.trim() || undefined;

  const defaultName = deriveConnectionName(type, host, port);
  const name = (await ctx.ui.input("连接名称（可改）", defaultName))?.trim() || defaultName;
  if (loadDbConfigs().some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    ctx.ui.notify(`已存在同名连接: ${name}`, "error");
    return;
  }

  const connConfig = { type, host, port, username, password, database };

  ctx.ui.notify(`正在测试 ${TYPE_LABELS[type]} 连接...`, "info");
  const test = await testConnection(connConfig);
  if (!test.success) {
    const proceed = await ctx.ui.confirm("连接测试失败", `${test.error}\n\n仍然保存这个连接吗？`);
    if (!proceed) return;
  } else {
    ctx.ui.notify(`连接成功 (${test.version}, ${test.latencyMs}ms)`, "success");
  }

  const config: DbConfig = {
    id: randomUUID(),
    name,
    type,
    description,
    enabled: true,
    host,
    port,
    username,
    password,
    database,
    databases: database ? [{ name: database, enabled: true }] : [],
    createdAt: new Date().toISOString(),
  };

  const configs = loadDbConfigs();
  configs.push(config);
  saveDbConfigs(configs);
  ctx.ui.notify(`已保存连接: ${name}`, "success");

  const goEnable = await ctx.ui.confirm("启用", "现在扫描并选择这个连接下要启用的库吗？");
  if (goEnable) await enableMenu(ctx, config);
}

async function editConfig(ctx: ExtensionContext, original: DbConfig) {
  const summary = [
    `当前连接: ${original.name}`,
    `类型: ${TYPE_LABELS[original.type]}`,
    `地址: ${original.host}:${original.port}`,
    `账号: ${original.username || "未设置"}`,
    `默认库: ${original.database || "未绑定（可查询全部已启用库）"}`,
    `状态: ${connectionState(original)}`,
    `库清单: ${allDatabases(original).join(", ") || "无"}`,
    `说明: ${original.description || "无"}`,
  ].join("\n");
  ctx.ui.notify(`${summary}\n\n每一项回车保持原值，直接输入新值则覆盖；输入 - 置空。`, "info");

  /**
   * 读取一项输入：
   *  - undefined（用户按 Esc 取消）→ 放弃整个编辑
   *  - 空字符串 → 保持原值
   *  - "-" → 置空
   *  - 其他 → 使用新值
   */
  const readField = async (title: string, current: string): Promise<{ value: string } | undefined> => {
    const input = await ctx.ui.input(`${title}（当前: ${current || "无"}，回车保持，输入 - 置空）`, current);
    if (input === undefined) return undefined;
    const trimmed = input.trim();
    if (trimmed === "") return { value: current };
    if (trimmed === "-") return { value: "" };
    return { value: trimmed };
  };

  // 类型
  const typeChoice = await ctx.ui.select(`数据库类型（当前: ${TYPE_LABELS[original.type]}）`, [
    "PostgreSQL",
    "MySQL",
    "Oracle",
  ]);
  const type: DbType = !typeChoice
    ? original.type
    : typeChoice === "MySQL"
      ? "mysql"
      : typeChoice === "Oracle"
        ? "oracle"
        : "postgresql";

  const hostField = await readField("主机地址", original.host);
  if (!hostField) return;
  if (!hostField.value) {
    ctx.ui.notify("主机地址不能为空。", "error");
    return;
  }

  const portField = await readField("端口", String(original.port));
  if (!portField) return;
  const port = Number(portField.value || original.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.ui.notify("端口无效。", "error");
    return;
  }

  const dbField = await readField("数据库名（Oracle 为服务名）", original.database || "");
  if (!dbField) return;
  const database = dbField.value || undefined;
  if (type === "oracle" && !database) {
    ctx.ui.notify("Oracle 必须填写服务名。", "error");
    return;
  }

  const userField = await readField("账号", original.username);
  if (!userField) return;
  if (!userField.value) {
    ctx.ui.notify("账号不能为空。", "error");
    return;
  }

  const nameField = await readField("连接名称", original.name);
  if (!nameField) return;
  if (!nameField.value) {
    ctx.ui.notify("连接名称不能为空。", "error");
    return;
  }

  const passwordField = await readField("密码", original.password ? "已设置" : "");
  if (!passwordField) return;
  // 「已设置」是展示占位，回车时保持原密码；输入 - 清空；其他为新密码
  const password =
    passwordField.value === (original.password ? "已设置" : "")
      ? original.password
      : passwordField.value;

  const descField = await readField("用途说明", original.description || "");
  if (!descField) return;
  const description = descField.value || undefined;

  const name = nameField.value;

  const updated: DbConfig = {
    ...original,
    name,
    type,
    host: hostField.value,
    port,
    database,
    username: userField.value,
    password,
    description,
  };

  const configs = loadDbConfigs();
  if (configs.some((c) => c.id !== original.id && c.name.toLowerCase() === name.toLowerCase())) {
    ctx.ui.notify(`已存在同名连接: ${name}`, "error");
    return;
  }

  const needRetest =
    updated.type !== original.type ||
    updated.host !== original.host ||
    updated.port !== original.port ||
    updated.database !== original.database ||
    updated.username !== original.username ||
    updated.password !== original.password;

  if (needRetest) {
    ctx.ui.notify("正在测试新连接...", "info");
    const test = await testConnection({
      type: updated.type,
      host: updated.host,
      port: updated.port,
      username: updated.username,
      password: updated.password,
      database: updated.database,
    });
    if (!test.success) {
      const proceed = await ctx.ui.confirm("连接测试失败", `${test.error}\n\n仍然保存修改吗？`);
      if (!proceed) return;
    } else {
      ctx.ui.notify(`连接成功 (${test.version}, ${test.latencyMs}ms)`, "success");
    }
  }

  if (!persist(updated)) {
    ctx.ui.notify("找不到原连接，可能已被删除。", "error");
    return;
  }
  ctx.ui.notify(`已更新连接: ${updated.name}`, "success");

  const goEnable = await ctx.ui.confirm("启用", "现在调整这个连接下启用的库吗？");
  if (goEnable) await enableMenu(ctx, updated);
}

// ── 删除连接 ──────────────────────────────────────

async function removeConfig(ctx: ExtensionContext) {
  const target = (await pickConfig(ctx, "选择要删除的连接"))?.config;
  if (!target) return;

  const ok = await ctx.ui.confirm(
    "确认删除",
    `确定删除连接 ${target.name}（${target.host}:${target.port}）？此操作不可恢复。`,
  );
  if (!ok) return;

  saveDbConfigs(loadDbConfigs().filter((c) => c.id !== target.id));
  ctx.ui.notify(`已删除连接: ${target.name}`, "success");
}

// ── 设置 ──────────────────────────────────────────

const READONLY_LABELS = { yes: "是", no: "否" } as const;

async function editSettings(ctx: ExtensionContext) {
  let cfg: PluginConfig = loadPluginConfig();

  while (true) {
    const options = [
      `只读模式（当前: ${cfg.ai_readonly ? READONLY_LABELS.yes : READONLY_LABELS.no}）`,
      `最大行数（当前: ${describeMaxRows(cfg.max_rows)}）`,
      `查询超时(s)（当前: ${cfg.query_timeout}）`,
      CONFIG_DONE,
    ];

    const choice = await ctx.ui.select("设置", options);
    if (!choice || choice === CONFIG_DONE) break;

    if (choice.startsWith("只读模式")) {
      const value = await ctx.ui.select("只读模式下 AI 只能执行查询语句，是否开启？", [
        READONLY_LABELS.yes,
        READONLY_LABELS.no,
      ]);
      if (!value) continue;
      cfg = { ...cfg, ai_readonly: value === READONLY_LABELS.yes };
    } else if (choice.startsWith("最大行数")) {
      const value = await ctx.ui.select("选择查询返回的最大行数", [
        ...MAX_ROWS_OPTIONS.map((n) => (n === 0 ? "不限制" : String(n))),
        CUSTOM_ROWS,
      ]);
      if (!value) continue;
      if (value === CUSTOM_ROWS) {
        const input = (await ctx.ui.input("输入最大行数（0 表示不限制）", String(cfg.max_rows)))?.trim();
        if (!input) continue;
        const num = Number(input);
        if (!Number.isInteger(num) || num < 0) {
          ctx.ui.notify("请输入 0 或正整数。", "error");
          continue;
        }
        cfg = { ...cfg, max_rows: num };
      } else {
        cfg = { ...cfg, max_rows: value === "不限制" ? 0 : Number(value) };
      }
    } else if (choice.startsWith("查询超时")) {
      const input = (await ctx.ui.input("单条 SQL 超时秒数", String(cfg.query_timeout)))?.trim();
      if (!input) continue;
      const num = Number(input);
      if (!Number.isInteger(num) || num <= 0) {
        ctx.ui.notify("请输入正整数秒数。", "error");
        continue;
      }
      cfg = { ...cfg, query_timeout: num };
    }

    savePluginConfig(cfg);
  }

  savePluginConfig(cfg);
  ctx.ui.notify(`设置已保存\n${formatPluginConfig(cfg)}`, "success");
}

async function showSettings(ctx: ExtensionContext) {
  const cfg = loadPluginConfig();
  ctx.ui.notify(`当前设置\n${formatPluginConfig(cfg)}`, "info");
  await editSettings(ctx);
}

async function resetSettings(ctx: ExtensionContext) {
  const ok = await ctx.ui.confirm(
    "恢复默认设置",
    `将恢复为:\n${formatPluginConfig(DEFAULT_PLUGIN_CONFIG)}`,
  );
  if (!ok) return;
  savePluginConfig({ ...DEFAULT_PLUGIN_CONFIG });
  ctx.ui.notify(`已恢复默认设置\n${formatPluginConfig(DEFAULT_PLUGIN_CONFIG)}`, "success");
}

// ── 查看所有连接 ──────────────────────────────────

/** 列出全部连接及其账号密码，便于核对与复制 */
function viewConfigs(ctx: ExtensionContext) {
  const configs = loadDbConfigs();
  if (configs.length === 0) {
    ctx.ui.notify("尚未配置连接。", "info");
    return;
  }

  const sorted = [...configs].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const blocks = sorted.map((c, index) => {
    const enabled = c.enabled ? enabledDatabases(c).map((d) => d.name) : [];
    const lines = [
      `${index + 1}. ${c.name}${c.enabled ? "" : "（已停用）"}`,
      `   类型: ${TYPE_LABELS[c.type]}`,
      `   地址: ${c.host}:${c.port}`,
      `   账号: ${c.username || "未设置"}`,
      `   密码: ${c.password || "未设置"}`,
      `   默认库: ${c.database || "未绑定"}`,
      `   已启用库: ${enabled.length > 0 ? enabled.join(", ") : "无"}`,
    ];
    if (c.description) lines.push(`   说明: ${c.description}`);
    return lines.join("\n");
  });

  const text = [
    `共 ${sorted.length} 个连接`,
    "─".repeat(40),
    blocks.join("\n\n"),
  ].join("\n");

  ctx.ui.notify(text, "info");
}

// ── /db 命令入口 ──────────────────────────────────

export async function handleDbCommand(args: string, ctx: ExtensionContext) {
  const sub = args.trim().toLowerCase();

  if (!sub) {
    const choice = await ctx.ui.select("数据库管理", [
      MENU_ENABLE,
      MENU_EDIT,
      MENU_VIEW,
      MENU_REMOVE,
      MENU_SETTINGS,
    ]);
    if (!choice) return;

    if (choice === MENU_ENABLE) return pickAndEnable(ctx);
    if (choice === MENU_EDIT) return pickAndEdit(ctx);
    if (choice === MENU_VIEW) return viewConfigs(ctx);
    if (choice === MENU_REMOVE) return removeConfig(ctx);
    if (choice === MENU_SETTINGS) return showSettings(ctx);
    return;
  }

  if (sub === "view" || sub === "v" || sub === "show" || sub === "ls" || sub === "list") {
    return viewConfigs(ctx);
  }

  if (sub === "enable" || sub === "use") return pickAndEnable(ctx);

  if (sub === "edit" || sub === "e") return pickAndEdit(ctx);

  if (sub === "add" || sub === "new" || sub === "a") return addConfig(ctx);

  if (sub === "rm" || sub === "remove" || sub === "del" || sub === "delete" || sub === "d") {
    return removeConfig(ctx);
  }

  if (sub === "config" || sub === "c" || sub === "set" || sub === "settings") {
    return showSettings(ctx);
  }

  if (sub === "reset") return resetSettings(ctx);

  ctx.ui.notify(
    [
      "用法: /db [enable|edit|view|rm|config|reset]",
      "  enable 启用连接或连接下的库",
      "  edit   编辑已有连接或新增连接",
      "  view   查看所有连接及账号密码",
      "  rm     删除连接",
      "  config 查看与修改设置",
      "  reset  恢复默认设置",
      "  默认   打开管理菜单",
    ].join("\n"),
    "info",
  );
}
