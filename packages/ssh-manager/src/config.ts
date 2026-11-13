import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── 类型定义 ──────────────────────────────────────

export interface SshConfig {
  id: string;
  name: string;
  description?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
  /** 是否对 AI 开放。缺省（旧数据无此字段）视为启用 */
  enabled: boolean;
  createdAt: string;
}

export type ConfirmPolicy = "never" | "write" | "always";

export interface PluginConfig {
  /** AI 是否只能执行读命令 */
  ai_readonly: boolean;
  /** 执行前确认策略：never=不确认 / write=写操作前确认 / always=每次都确认 */
  confirm_before_exec: ConfirmPolicy;
  /** 单条命令超时秒数 */
  command_timeout: number;
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  ai_readonly: true,
  confirm_before_exec: "write",
  command_timeout: 30,
};

export const CONFIRM_LABELS: Record<ConfirmPolicy, string> = {
  never: "不确认",
  write: "写操作确认",
  always: "每次都确认",
};

// ── 路径 ──────────────────────────────────────────

function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  return override && override.trim() ? override : join(homedir(), ".pi", "agent");
}

export function configFilePath(): string {
  return join(agentDir(), "ssh-configs.json");
}

export function pluginConfigFilePath(): string {
  return join(agentDir(), "ssh-plugin-config.json");
}

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

/** 旧数据没有 enabled / createdAt 字段，补齐默认值保证后续逻辑统一 */
function normalizeConfig(raw: any): SshConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const name = String(raw.name ?? "").trim();
  const host = String(raw.host ?? "").trim();
  if (!name || !host) return undefined;

  const port = Number(raw.port);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
    name,
    host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
    username: String(raw.username ?? "").trim() || "root",
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : undefined,
    password: typeof raw.password === "string" && raw.password ? raw.password : undefined,
    keyPath: typeof raw.keyPath === "string" && raw.keyPath ? raw.keyPath : undefined,
    // 缺省视为启用：升级后旧连接保持可用
    enabled: raw.enabled !== false,
    createdAt:
      typeof raw.createdAt === "string" && raw.createdAt
        ? raw.createdAt
        : new Date().toISOString(),
  };
}

export function loadConfigs(): SshConfig[] {
  const raw = readJson(configFilePath());
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeConfig).filter((c): c is SshConfig => c !== undefined);
}

export function saveConfigs(configs: SshConfig[]) {
  writeJson(configFilePath(), configs);
}

export function sortedByName(configs: SshConfig[]): SshConfig[] {
  return [...configs].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function findConfig(id: string): SshConfig | undefined {
  return loadConfigs().find((c) => c.id === id);
}

export function findByName(name: string): SshConfig | undefined {
  return loadConfigs().find((c) => c.name === name);
}

/** 写回单条配置；原配置不存在时返回 false */
export function persistConfig(updated: SshConfig): boolean {
  const all = loadConfigs();
  const idx = all.findIndex((c) => c.id === updated.id);
  if (idx < 0) return false;
  all[idx] = updated;
  saveConfigs(all);
  return true;
}

/** 只有启用的连接才对 AI 开放 */
export function enabledConfigs(configs: SshConfig[]): SshConfig[] {
  return configs.filter((c) => c.enabled);
}

export function setEnabled(id: string, enabled: boolean): SshConfig | undefined {
  const config = findConfig(id);
  if (!config) return undefined;
  const updated = { ...config, enabled };
  persistConfig(updated);
  return updated;
}

// ── 插件配置 ──────────────────────────────────────

export function loadPluginConfig(): PluginConfig {
  const raw = readJson(pluginConfigFilePath());
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PLUGIN_CONFIG };
  const cfg = { ...DEFAULT_PLUGIN_CONFIG, ...(raw as any) };

  const policy = cfg.confirm_before_exec;
  if (policy !== "never" && policy !== "write" && policy !== "always") {
    cfg.confirm_before_exec = DEFAULT_PLUGIN_CONFIG.confirm_before_exec;
  }
  const timeout = Number(cfg.command_timeout);
  cfg.command_timeout =
    Number.isFinite(timeout) && timeout > 0
      ? Math.round(timeout)
      : DEFAULT_PLUGIN_CONFIG.command_timeout;
  cfg.ai_readonly = cfg.ai_readonly !== false;
  return cfg;
}

export function savePluginConfig(cfg: PluginConfig) {
  writeJson(pluginConfigFilePath(), cfg);
}

// ── 展示 ──────────────────────────────────────────

export function authLabel(config: SshConfig): string {
  return config.keyPath ? "密钥" : config.password ? "密码" : "未配置认证";
}

/** 列表里的一行：名称 - user@host:port - 说明 */
export function displayLine(config: SshConfig): string {
  const desc = config.description ? ` - ${config.description}` : "";
  return `${config.name} - ${config.username}@${config.host}:${config.port}${desc}`;
}

export function configSummary(cfg: PluginConfig): string {
  return [
    `AI 只读: ${cfg.ai_readonly ? "是" : "否"}`,
    `执行确认: ${CONFIRM_LABELS[cfg.confirm_before_exec]}`,
    `命令超时: ${cfg.command_timeout}s`,
  ].join("\n");
}
