import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ── 类型定义 ──────────────────────────────────────

export type DbType = "postgresql" | "mysql" | "oracle";

export interface DbConfig {
  id: string;
  name: string;
  type: DbType;
  description?: string;
  /** 连接级开关，停用后该连接下所有库都不对 AI 开放 */
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  /** 默认库：可为空。为空表示连接不绑定库，需先启用库或由扫描结果确定 */
  database?: string;
  /** 该连接下的库清单及启用状态，只有启用的库对 AI 可见 */
  databases: DatabaseEntry[];
  extraParams?: Record<string, string>;
  createdAt: string;
}

export interface DatabaseEntry {
  /** 库名（Oracle 为服务名） */
  name: string;
  enabled: boolean;
}

export interface PluginConfig {
  /** AI 是否只能执行查询语句 */
  ai_readonly: boolean;
  /** 查询返回的最大行数，0 表示不限制 */
  max_rows: number;
  /** 单条 SQL 超时秒数 */
  query_timeout: number;
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  ai_readonly: true,
  max_rows: 500,
  query_timeout: 15,
};

/** 最大行数预设选项，0 表示不限制 */
export const MAX_ROWS_OPTIONS = [1, 50, 500, 0] as const;

export const DEFAULT_PORTS: Record<DbType, number> = {
  postgresql: 5432,
  mysql: 3306,
  oracle: 1521,
};

export const TYPE_LABELS: Record<DbType, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  oracle: "Oracle",
};

// ── 路径 ──────────────────────────────────────────

function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  return override && override.trim() ? override : join(homedir(), ".pi", "agent");
}

const CONFIG_FILE = join(agentDir(), "db-configs.json");
const PLUGIN_CONFIG_FILE = join(agentDir(), "db-plugin-config.json");

// ── 文件读写 ──────────────────────────────────────

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

// ── 连接配置 ──────────────────────────────────────

function normalizeDatabases(raw: any, legacyDatabase: string | undefined): DatabaseEntry[] {
  const list: DatabaseEntry[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        const name = item.trim();
        if (name && !list.some((d) => d.name === name)) list.push({ name, enabled: true });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const name = String((item as any).name ?? "").trim();
      if (!name || list.some((d) => d.name === name)) continue;
      list.push({ name, enabled: (item as any).enabled !== false });
    }
  }
  // 旧格式只有 database 字段：视为唯一已启用的库
  if (list.length === 0 && legacyDatabase) list.push({ name: legacyDatabase, enabled: true });
  return list;
}

function normalizeDbConfig(raw: any): DbConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const type = raw.type;
  if (type !== "postgresql" && type !== "mysql" && type !== "oracle") return undefined;
  const name = String(raw.name ?? "").trim();
  if (!name) return undefined;

  const boundDatabase = String(raw.database ?? "").trim() || undefined;
  const databases = normalizeDatabases(raw.databases, boundDatabase);

  // Oracle 必须知道服务名才能连接，未绑定时用第一个库补齐
  const database = boundDatabase ?? (type === "oracle" ? databases[0]?.name : undefined);
  if (type === "oracle" && !database) return undefined;

  const port = Number(raw.port);
  return {
    id: String(raw.id ?? randomUUID()),
    name,
    type,
    description: raw.description ? String(raw.description) : undefined,
    enabled: raw.enabled !== false,
    host: String(raw.host ?? "localhost"),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORTS[type],
    username: String(raw.username ?? ""),
    password: String(raw.password ?? ""),
    database,
    databases,
    extraParams: raw.extraParams && typeof raw.extraParams === "object" ? raw.extraParams : undefined,
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
  };
}

export function loadDbConfigs(): DbConfig[] {
  const raw = readJson(CONFIG_FILE);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeDbConfig).filter((c): c is DbConfig => !!c);
}

/** 配置文件路径，供迁移与备份使用 */
export function configFilePath(): string {
  return CONFIG_FILE;
}

/** 读取原始 JSON 数组（不做规范化） */
export function readRawConfigs(): unknown[] {
  const raw = readJson(CONFIG_FILE);
  return Array.isArray(raw) ? raw : [];
}

/** 直接写入原始数组（用于迁移） */
export function writeRawConfigs(raw: unknown[]) {
  writeJson(CONFIG_FILE, raw);
}

export function saveDbConfigs(configs: DbConfig[]) {
  writeJson(CONFIG_FILE, configs);
}

/** 按名称查找连接（忽略首尾空格与大小写） */
export function findDbConfig(configs: DbConfig[], name: string): DbConfig | undefined {
  const target = name.trim().toLowerCase();
  return configs.find((c) => c.name.toLowerCase() === target);
}

// ── 库的启用状态 ──────────────────────────────────

/** 已启用的库；库清单为空且绑定了默认库时，视为该库已启用 */
export function enabledDatabases(config: DbConfig): DatabaseEntry[] {
  if (!config.enabled) return [];
  const enabled = config.databases.filter((d) => d.enabled);
  if (enabled.length > 0) return enabled;
  if (config.database) return [{ name: config.database, enabled: true }];
  return [];
}

/** 库清单（与启用状态无关），用于界面展示与候选 */
export function allDatabases(config: DbConfig): string[] {
  const names = config.databases.map((d) => d.name);
  if (config.database && !names.includes(config.database)) return [config.database, ...names];
  return names;
}

/** 连接下是否至少有一个可用库 */
export function hasEnabledDatabase(config: DbConfig): boolean {
  return enabledDatabases(config).length > 0;
}

/** 设置某个库的启用状态；不改默认库（默认库可单独指定） */
export function setDatabaseEnabled(config: DbConfig, name: string, enabled: boolean): DbConfig {
  const databases = config.databases.some((d) => d.name === name)
    ? config.databases.map((d) => (d.name === name ? { ...d, enabled } : d))
    : [...config.databases, { name, enabled }];
  return { ...config, databases };
}

// ── 连接 + 库 目标的定位 ──────────────────────────

export interface DbTarget {
  config: DbConfig;
  /** 实际要连接的库名 */
  database: string;
  /** 展示与回显用的标识，形如 conn/db */
  label: string;
}

export type TargetResult =
  | { ok: true; target: DbTarget }
  | { ok: false; error: string };

export type ConnectionResult =
  | { ok: true; config: DbConfig }
  | { ok: false; error: string };

/** 拆分「连接名」与可选的「库名」 */
export function parseSpec(spec: string): { connName: string; dbName?: string } {
  const input = spec.trim();
  const slash = input.indexOf("/");
  if (slash < 0) return { connName: input };
  const dbName = input.slice(slash + 1).trim();
  return { connName: input.slice(0, slash).trim(), dbName: dbName || undefined };
}

/** 定位连接（不关心具体库），用于按连接枚举全部启用库 */
export function resolveConnection(configs: DbConfig[], spec: string): ConnectionResult {
  const { connName } = parseSpec(spec);
  if (!connName) {
    return { ok: false, error: "database 参数不能为空。" };
  }

  // 只在启用且至少有一个启用库的连接里找。停用的连接当成不存在，
  // 否则报错里的「已停用」「没有已启用的库」会把内部状态透露给模型。
  const config = findDbConfig(configs, connName);
  if (!config || !config.enabled || enabledDatabases(config).length === 0) {
    const available = listTargets(configs).map((t) => t.label).join(", ") || "无";
    return { ok: false, error: `连接 "${connName}" 未找到。可用数据库: ${available}。` };
  }

  return { ok: true, config };
}

/**
 * 解析 database 参数为「连接 + 库」。
 * 写成「连接名」时，仅在只启用了一个库的情况下自动选定该库。
 */
export function resolveTarget(configs: DbConfig[], spec: string): TargetResult {
  const { dbName } = parseSpec(spec);
  const resolved = resolveConnection(configs, spec);
  if (!resolved.ok) return resolved;

  const config = resolved.config;
  const enabled = enabledDatabases(config);

  if (!dbName) {
    if (enabled.length === 1) {
      return {
        ok: true,
        target: { config, database: enabled[0].name, label: `${config.name}/${enabled[0].name}` },
      };
    }
    return {
      ok: false,
      error: `连接 "${config.name}" 下有多个可用库，database 参数必须写成「连接名/库名」。可用库: ${enabled.map((d) => d.name).join(", ")}。`,
    };
  }

  const hit = enabled.find((d) => d.name.toLowerCase() === dbName.toLowerCase());
  if (!hit) {
    return {
      ok: false,
      error: `库 "${dbName}" 不存在。可用库: ${enabled.map((d) => d.name).join(", ")}。`,
    };
  }
  return { ok: true, target: { config, database: hit.name, label: `${config.name}/${hit.name}` } };
}

/** 枚举所有可访问目标，用于系统提示与校验 */
export function listTargets(configs: DbConfig[]): DbTarget[] {
  const targets: DbTarget[] = [];
  for (const config of configs) {
    for (const entry of enabledDatabases(config)) {
      targets.push({ config, database: entry.name, label: `${config.name}/${entry.name}` });
    }
  }
  return targets;
}

// ── 插件配置 ──────────────────────────────────────

function normalizeMaxRows(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return DEFAULT_PLUGIN_CONFIG.max_rows;
  return Math.floor(num);
}

function normalizeTimeout(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_PLUGIN_CONFIG.query_timeout;
  return Math.floor(num);
}

export function loadPluginConfig(): PluginConfig {
  const raw = readJson(PLUGIN_CONFIG_FILE);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PLUGIN_CONFIG };
  const input = raw as Record<string, unknown>;
  return {
    ai_readonly: typeof input.ai_readonly === "boolean" ? input.ai_readonly : DEFAULT_PLUGIN_CONFIG.ai_readonly,
    max_rows: normalizeMaxRows(input.max_rows),
    query_timeout: normalizeTimeout(input.query_timeout),
  };
}

export function savePluginConfig(cfg: PluginConfig) {
  writeJson(PLUGIN_CONFIG_FILE, cfg);
}

export function describeMaxRows(value: number): string {
  return value === 0 ? "不限制" : String(value);
}

export function formatPluginConfig(cfg: PluginConfig): string {
  return [
    `只读模式: ${cfg.ai_readonly ? "是" : "否"}`,
    `最大行数: ${describeMaxRows(cfg.max_rows)}`,
    `查询超时: ${cfg.query_timeout}s`,
  ].join("\n");
}
