import { copyFileSync, existsSync } from "node:fs";
import type { DatabaseEntry } from "./config.js";
import { DEFAULT_PORTS } from "./config.js";

// ── 旧数据迁移 ────────────────────────────────────
// v2 的模型是「一条连接 = 一个库」，v3 改为「一条连接 = 一个服务器实例，可含多库」。
//
// 判定依据不依赖是否存在 databases 字段（旧版本可能已被补写过），而是看
// database 字段是否有值：v3 的 Postgres / MySQL 连接不绑定库，database 为空。
//
// 迁移策略：
//   - Postgres / MySQL：把 type + host + port + username 相同的多条旧连接合并为一条，
//     各条旧连接的库名并入 databases 且全部启用，连接本身的 database 置空。
//   - Oracle：一个服务名就是一条连接，不做合并，只补齐 databases 字段。
// 迁移幂等：database 已被置空的连接不会再被当作旧数据。

/** 进程内一次性迁移标记 */
let attempted = false;

export interface MigrationResult {
  migrated: boolean;
  before: number;
  after: number;
  /** 备份文件路径，未迁移时为空 */
  backupFile?: string;
  error?: string;
}

interface RawConfig {
  [key: string]: unknown;
}

function nonEmptyDatabase(item: RawConfig): string {
  const value = item.database;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 是否为待迁移的旧数据：绑定了具体库，且库清单里最多只有它自己。
 * 已经迁移过的连接 database 为空，不会再次命中。
 */
function needsMigration(item: RawConfig): boolean {
  const database = nonEmptyDatabase(item);
  if (!database) return false;
  const databases = item.databases;
  if (!Array.isArray(databases) || databases.length === 0) return true;
  if (databases.length > 1) return false;
  const only = databases[0] as { name?: unknown } | undefined;
  return String(only?.name ?? "").toLowerCase() === database.toLowerCase();
}

function instanceKey(item: RawConfig): string {
  const type = String(item.type ?? "");
  const host = String(item.host ?? "");
  const port = Number(item.port ?? DEFAULT_PORTS[type as keyof typeof DEFAULT_PORTS] ?? 0);
  const username = String(item.username ?? "");
  return `${type}|${host}|${port}|${username}`;
}

/** 由类型 + host 与端口推导连接名，如 postgresql 192.168.250.79:5432 → pg79-5432 */
function deriveName(host: string, port: number, type: string): string {
  const prefix = type === "mysql" ? "mysql" : type === "oracle" ? "ora" : "pg";
  const lastOctet = host.split(".").filter(Boolean).pop() ?? host;
  const base = `${prefix}${lastOctet}`.replace(/[^\w-]+/g, "-");
  return port ? `${base}-${port}` : base;
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) return base;
  let index = 2;
  while (used.has(`${base}-${index}`.toLowerCase())) index++;
  return `${base}-${index}`;
}

/** 收集一条旧连接贡献的库名 */
function collectDatabases(group: RawConfig[]): DatabaseEntry[] {
  const result: DatabaseEntry[] = [];
  for (const item of group) {
    const single = nonEmptyDatabase(item);
    if (single && !result.some((d) => d.name.toLowerCase() === single.toLowerCase())) {
      result.push({ name: single, enabled: true });
    }
    const list = item.databases;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const name = String((entry as { name?: unknown })?.name ?? "").trim();
      if (!name || result.some((d) => d.name.toLowerCase() === name.toLowerCase())) continue;
      const enabled = (entry as { enabled?: unknown })?.enabled !== false;
      result.push({ name, enabled });
    }
  }
  // 至少保留默认库本身
  if (result.length === 0) {
    for (const item of group) {
      const single = nonEmptyDatabase(item);
      if (single) result.push({ name: single, enabled: true });
    }
  }
  return result;
}

/**
 * 把旧格式数据合并为新格式。返回迁移后的数组与统计信息，不改动磁盘。
 */
export function migrateRawConfigs(raw: unknown[]): {
  configs: RawConfig[];
  migrated: boolean;
  before: number;
  after: number;
} {
  const before = raw.length;
  const items = raw.filter((item): item is RawConfig => !!item && typeof item === "object");

  if (!items.some(needsMigration)) {
    return { configs: items, migrated: false, before, after: items.length };
  }

  const groups = new Map<string, RawConfig[]>();
  const passthrough: RawConfig[] = [];
  const oracleEntries: RawConfig[] = [];

  for (const item of items) {
    if (!needsMigration(item)) {
      passthrough.push(item);
      continue;
    }
    if (String(item.type) === "oracle") {
      oracleEntries.push(item);
      continue;
    }
    const key = instanceKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const used = new Set<string>();
  for (const item of passthrough) used.add(String(item.name ?? "").toLowerCase());
  for (const item of oracleEntries) used.add(String(item.name ?? "").toLowerCase());

  const merged: RawConfig[] = [];

  for (const [, group] of groups) {
    const first = group[0];
    const type = String(first.type ?? "postgresql");
    const host = String(first.host ?? "localhost");
    const port = Number(first.port ?? DEFAULT_PORTS[type as keyof typeof DEFAULT_PORTS] ?? 0);

    // 单条旧连接保留用户起的名字；多条合并时按实例推导名称
    const mergedName = group.length > 1
      ? uniqueName(deriveName(host, port, type), used)
      : uniqueName(String(first.name ?? deriveName(host, port, type)), used);
    used.add(mergedName.toLowerCase());

    const description = group
      .map((item) => String(item.description ?? "").trim())
      .find(Boolean);

    merged.push({
      ...first,
      name: mergedName,
      description: description || undefined,
      // 连接不再绑定单一库，可访问范围由 databases 的启用状态决定
      database: "",
      databases: collectDatabases(group),
    });
  }

  // Oracle：一个服务名即一条连接，仅补齐库清单
  for (const item of oracleEntries) {
    const service = nonEmptyDatabase(item);
    merged.push({
      ...item,
      databases: collectDatabases([item]),
      database: service,
    });
  }

  const configs = [...passthrough, ...merged].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-CN"),
  );

  return { configs, migrated: true, before, after: configs.length };
}

/** 备份原配置文件，失败时返回 undefined */
export function backupConfigFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const target = `${file}.bak-${stamp}`;
  try {
    copyFileSync(file, target);
    return target;
  } catch {
    return undefined;
  }
}

/** 在文件层执行迁移：备份 + 写回。幂等，已是新格式时直接返回 */
export function runStartupMigration(
  file: string,
  readRaw: () => unknown[],
  writeRaw: (raw: unknown[]) => void,
): MigrationResult {
  if (attempted) return { migrated: false, before: 0, after: 0 };
  attempted = true;

  try {
    const raw = readRaw();
    if (raw.length === 0) return { migrated: false, before: 0, after: 0 };

    const result = migrateRawConfigs(raw);
    if (!result.migrated) {
      return { migrated: false, before: result.before, after: result.after };
    }

    const backupFile = backupConfigFile(file);
    writeRaw(JSON.parse(JSON.stringify(result.configs)));

    return { migrated: true, before: result.before, after: result.after, backupFile };
  } catch (err) {
    return {
      migrated: false,
      before: 0,
      after: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
