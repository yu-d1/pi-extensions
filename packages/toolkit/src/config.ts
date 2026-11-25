import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginStore, ToolkitPlugin } from "./types.js";

/** 单个插件在配置文件中的持久化条目 */
export interface StoredPluginEntry {
  enabled?: boolean;
  settings?: Record<string, unknown>;
}

/** 合集统一配置文件结构 */
export interface ToolkitConfigFile {
  version: number;
  plugins: Record<string, StoredPluginEntry>;
}

export const TOOLKIT_CONFIG_FILE = join(homedir(), ".pi/agent/extensions/toolkit/config.json");

const CURRENT_CONFIG_VERSION = 1;
let cachedConfig: ToolkitConfigFile | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyConfig(): ToolkitConfigFile {
  return { version: CURRENT_CONFIG_VERSION, plugins: {} };
}

/** 读取合集配置；缺失、损坏或结构非法时安全回退默认值 */
export function loadToolkitConfig(forceReload = false): ToolkitConfigFile {
  if (cachedConfig && !forceReload) return cachedConfig;
  if (!existsSync(TOOLKIT_CONFIG_FILE)) {
    cachedConfig = emptyConfig();
    return cachedConfig;
  }
  try {
    const raw = readFileSync(TOOLKIT_CONFIG_FILE, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      cachedConfig = emptyConfig();
      return cachedConfig;
    }
    const plugins: Record<string, StoredPluginEntry> = {};
    if (isPlainObject(parsed.plugins)) {
      for (const [id, entry] of Object.entries(parsed.plugins)) {
        if (!isPlainObject(entry)) continue;
        const normalized: StoredPluginEntry = {};
        if (typeof entry.enabled === "boolean") normalized.enabled = entry.enabled;
        if (isPlainObject(entry.settings)) normalized.settings = { ...entry.settings };
        plugins[id] = normalized;
      }
    }
    cachedConfig = {
      version: typeof parsed.version === "number" ? parsed.version : CURRENT_CONFIG_VERSION,
      plugins,
    };
    return cachedConfig;
  } catch {
    cachedConfig = emptyConfig();
    return cachedConfig;
  }
}

/** 持久化合集配置并同步刷新内存缓存 */
export function saveToolkitConfig(cfg: ToolkitConfigFile): boolean {
  try {
    mkdirSync(dirname(TOOLKIT_CONFIG_FILE), { recursive: true });
    writeFileSync(TOOLKIT_CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
    cachedConfig = cfg;
    return true;
  } catch {
    return false;
  }
}

/** 为指定子插件创建隔离的配置读写代理 */
export function createPluginStore<TSettings extends Record<string, unknown>>(
  plugin: ToolkitPlugin<TSettings>,
): PluginStore<TSettings> {
  const ensureEntry = (cfg: ToolkitConfigFile): StoredPluginEntry => {
    if (!cfg.plugins[plugin.id]) cfg.plugins[plugin.id] = {};
    return cfg.plugins[plugin.id];
  };

  return {
    isEnabled(): boolean {
      const entry = loadToolkitConfig().plugins[plugin.id];
      return typeof entry?.enabled === "boolean" ? entry.enabled : plugin.defaultEnabled;
    },

    setEnabled(enabled: boolean): boolean {
      const cfg = loadToolkitConfig(true);
      ensureEntry(cfg).enabled = enabled;
      return saveToolkitConfig(cfg);
    },

    getSettings(): TSettings {
      const entry = loadToolkitConfig().plugins[plugin.id];
      return {
        ...plugin.defaultSettings,
        ...(entry?.settings as Partial<TSettings> | undefined),
      };
    },

    updateSettings(patch: Partial<TSettings>): boolean {
      const cfg = loadToolkitConfig(true);
      const entry = ensureEntry(cfg);
      entry.settings = {
        ...plugin.defaultSettings,
        ...entry.settings,
        ...patch,
      };
      return saveToolkitConfig(cfg);
    },
  };
}
