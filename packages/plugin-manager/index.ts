// @liziy/plugin-manager
// =========================================================================
// 插件管理器 —— 管理 MCP 服务器、扩展工具、技能 的启用状态
//
// 设计要点：
// - 按 source（包/服务器/技能目录）维度开关，自动发现而非手动映射
// - opt-out 模型：默认全部启用，用户只关掉不需要的
// - 持久化配置在 ~/.pi/agent/extensions/plugin-manager/config.json
// - 三层过滤：
//     1) setActiveTools     —— 过滤 API 请求的 tools 参数（扩展 + MCP 工具）
//     2) before_agent_start —— 过滤系统提示中的技能 SKILL.md 段落
//     3) session_start      —— 3-way diff 自动感知新增/删除/变化
// - 工具过滤只在 session_start 和 /plugins 时执行；技能过滤在 before_agent_start 每轮执行
//
// 安装：pi install npm:@liziy/plugin-manager
// 使用：/plugins

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { Container, Input, Key, matchesKey, Spacer, Text, fuzzyFilter } from "@earendil-works/pi-tui";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { homedir } from "node:os";

// ── 路径 ────────────────────────────────────────────────
const CONFIG_DIR = join(homedir(), ".pi/agent/extensions/plugin-manager");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const MCP_CONFIG_FILE = join(homedir(), ".pi/agent/mcp.json");
const MCP_CACHE_FILE = join(homedir(), ".pi/agent/mcp-cache.json");
const SKILLS_DIR = join(homedir(), ".pi/agent/skills");

// ── 类型 ────────────────────────────────────────────────
interface OptOutEntry {
  disabled_at: string;
  reason?: string;
}

interface Config {
  version: number;
  created_at: string;
  updated_at: string;
  opt_out: {
    extensions: Record<string, OptOutEntry>;
    mcp_servers: Record<string, OptOutEntry>;
    skills: Record<string, OptOutEntry>;
  };
  known_sources: {
    extensions: Record<string, { tools: string[]; last_seen: string }>;
    mcp_servers: Record<string, { tools: string[]; last_seen: string }>;
    skills: Record<string, { last_seen: string }>;
  };
}

interface ManifestSource {
  tools: string[];
  /** 估算的工具定义总 token 数（JSON 序列化长度 / 4） */
  totalTokens: number;
}

interface Manifest {
  extensions: Record<string, ManifestSource>;
  mcp_servers: Record<string, ManifestSource>;
  skills: Record<string, Record<string, never>>;
}

interface DiffResult {
  added: { type: "extension" | "mcp" | "skill"; name: string; tools: string[] }[];
  removed: { type: "extension" | "mcp" | "skill"; name: string }[];
  changed: { type: "extension" | "mcp"; name: string; added: string[]; removed: string[] }[];
}

const DEFAULT_CONFIG: Config = {
  version: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  opt_out: { extensions: {}, mcp_servers: {}, skills: {} },
  known_sources: { extensions: {}, mcp_servers: {}, skills: {} },
};

// ── 工具函数 ────────────────────────────────────────────
function nowIso(): string {
  return new Date().toISOString();
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * 把 sourceInfo.source（全路径）归一化为稳定短名。
 * 例：
 *   "C:/Users/11/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/index.ts"
 *   → "@juicesharp/rpiv-todo"
 *   "C:/.../pi-chrome/extensions/chrome-profile-bridge/index.ts"
 *   → "pi-chrome/extensions/chrome-profile-bridge"
 */
function normalizeSourceName(sourcePath: string): string {
  const norm = normalizePath(sourcePath);
  const nmIdx = norm.lastIndexOf("/node_modules/");
  if (nmIdx !== -1) {
    const rel = norm.slice(nmIdx + "/node_modules/".length);
    // 取前两段：scope/pkg 或 pkg
    const parts = rel.split("/");
    if (parts[0].startsWith("@")) return `${parts[0]}/${parts[1]}`;
    return parts[0];
  }
  const piIdx = norm.indexOf("/.pi/agent/");
  if (piIdx !== -1) {
    return norm.slice(piIdx + "/.pi/agent/".length);
  }
  // fallback：取文件名（去扩展名）
  return norm.split("/").pop()?.replace(/\.\w+$/, "") || norm;
}

// ── 配置 I/O ────────────────────────────────────────────
async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_FILE)) {
    const fresh = { ...DEFAULT_CONFIG, created_at: nowIso(), updated_at: nowIso() };
    return fresh;
  }
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      version: parsed.version ?? 1,
      created_at: parsed.created_at ?? nowIso(),
      updated_at: parsed.updated_at ?? nowIso(),
      opt_out: {
        extensions: parsed.opt_out?.extensions ?? {},
        mcp_servers: parsed.opt_out?.mcp_servers ?? {},
        skills: parsed.opt_out?.skills ?? {},
      },
      known_sources: {
        extensions: parsed.known_sources?.extensions ?? {},
        mcp_servers: parsed.known_sources?.mcp_servers ?? {},
        skills: parsed.known_sources?.skills ?? {},
      },
    };
  } catch {
    // 损坏的 config：备份后回退到默认
    try {
      await rename(CONFIG_FILE, `${CONFIG_FILE}.corrupt.${Date.now()}`);
    } catch { /* ignore */ }
    return { ...DEFAULT_CONFIG, created_at: nowIso(), updated_at: nowIso() };
  }
}

/**
 * 原子写入：先写 .tmp，再 rename 覆盖。
 * 防止并发或崩溃时配置损坏。
 */
async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  config.updated_at = nowIso();
  const tmp = `${CONFIG_FILE}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(config, null, 2), "utf-8");
  await rename(tmp, CONFIG_FILE);
}

// ── Manifest 构建 ───────────────────────────────────────
/** MCP 工具名前缀模式 — 复刻 pi-mcp-adapter/types.ts 定义 */
type ToolPrefix = "server" | "none" | "short";

interface McpCacheFile {
  version: number;
  servers: Record<string, {
    configHash: string;
    tools: Array<{ name: string }>;
    /** MCP 资源会被适配器注册为 read 类型的工具，工具名规则：get_{resourceNameToToolName(name)} */
    resources?: Array<{ uri: string; name: string; description?: string }>;
  }>;
}

interface McpConfigFile {
  mcpServers: Record<string, unknown>;
  settings?: { toolPrefix?: ToolPrefix };
  imports?: string[];
}

async function readMcpCache(): Promise<McpCacheFile> {
  if (!existsSync(MCP_CACHE_FILE)) return { version: 1, servers: {} };
  try {
    return JSON.parse(await readFile(MCP_CACHE_FILE, "utf-8"));
  } catch {
    return { version: 1, servers: {} };
  }
}

async function readMcpConfig(): Promise<McpConfigFile> {
  if (!existsSync(MCP_CONFIG_FILE)) return { mcpServers: {} };
  try {
    return JSON.parse(await readFile(MCP_CONFIG_FILE, "utf-8"));
  } catch {
    return { mcpServers: {} };
  }
}

async function readSkillsDir(): Promise<string[]> {
  if (!existsSync(SKILLS_DIR)) return [];
  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** 内置工具的 source 标识（createSyntheticSourceInfo 用 "builtin"） */
const BUILTIN_SOURCE = "builtin";
/** MCP 适配器的归一化 source 名 —— 其工具由 MCP 服务器分类管理，不归入扩展 */
const MCP_ADAPTER_SOURCE = "npm:pi-mcp-adapter";

function estimateToolTokens(tool: ToolInfo): number {
  // 粗略估算：description + parameters 序列化长度 / 4
  try {
    const len = JSON.stringify({
      description: tool.description,
      parameters: tool.parameters,
    }).length;
    return Math.min(Math.max(Math.round(len / 4), 1), 100_000); // 单工具上限 100K
  } catch {
    // JSON 序列化出错（如循环引用），降级为纯文本估算
    return Math.max(Math.round((tool.description ?? "").length / 4), 1);
  }
}

function buildTokenMap(allTools: ToolInfo[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const tool of allTools) {
    map.set(tool.name, Math.max(estimateToolTokens(tool), 1));
  }
  return map;
}

function buildManifestFromTools(allTools: ToolInfo[], tokenMap: Map<string, number>): Record<string, ManifestSource> {
  const grouped: Record<string, ManifestSource> = {};
  for (const tool of allTools) {
    const key = normalizeSourceName(tool.sourceInfo.source);
    // 排除内置工具（bash/read/edit/...）和 MCP 适配器（其工具按服务器维度管理）
    if (key === BUILTIN_SOURCE || key === MCP_ADAPTER_SOURCE) continue;
    if (!grouped[key]) grouped[key] = { tools: [], totalTokens: 0 };
    if (!grouped[key].tools.includes(tool.name)) {
      grouped[key].tools.push(tool.name);
      grouped[key].totalTokens += tokenMap.get(tool.name) ?? 0;
    }
  }
  // 排序便于 diff 稳定
  for (const k of Object.keys(grouped)) {
    grouped[k].tools.sort();
  }
  return grouped;
}

async function buildCurrentManifest(pi: ExtensionAPI): Promise<Manifest> {
  // 0. 构建工具名→token 估算的查找表
  const allTools = pi.getAllTools();
  const tokenMap = buildTokenMap(allTools);

  // 1. 扩展工具（通过 getAllTools + sourceInfo）
  const extensions = buildManifestFromTools(allTools, tokenMap);

  // 2. MCP 服务器（从 mcp.json + mcp-cache 推断）
  const mcpConfig = await readMcpConfig();
  const mcpCache = await readMcpCache();
  const prefixMode: ToolPrefix = mcpConfig.settings?.toolPrefix ?? "server";
  const mcpServers: Record<string, ManifestSource> = {};
  for (const serverName of Object.keys(mcpConfig.mcpServers)) {
    const cacheServer = mcpCache.servers?.[serverName];
    const toolNames: string[] = [];
    let totalTokens = 0;
    // tools 数组（缓存中的名字无前缀，需用 formatMcpToolName 转换）
    for (const t of cacheServer?.tools ?? []) {
      const fullName = formatMcpToolName(t.name, serverName, prefixMode);
      toolNames.push(fullName);
      totalTokens += tokenMap.get(fullName) ?? 0;
    }
    // resources 会被注册为 read 工具，这里也计入
    for (const r of cacheServer?.resources ?? []) {
      const baseName = `get_${resourceNameToToolName(r.name ?? "")}`;
      const fullName = formatMcpToolName(baseName, serverName, prefixMode);
      toolNames.push(fullName);
      totalTokens += tokenMap.get(fullName) ?? 0;
    }
    toolNames.sort();
    mcpServers[serverName] = { tools: toolNames, totalTokens };
  }

  // 3. 技能（扫描 skills 目录）
  const skillNames = await readSkillsDir();
  const skills: Record<string, Record<string, never>> = {};
  for (const s of skillNames) skills[s] = {};

  return { extensions, mcp_servers: mcpServers, skills };
}

// ── Diff 引擎 ──────────────────────────────────────────
function diffManifests(known: Config["known_sources"], current: Manifest): DiffResult {
  const result: DiffResult = { added: [], removed: [], changed: [] };

  // extensions
  for (const k of Object.keys(current.extensions)) {
    if (!known.extensions[k]) {
      result.added.push({ type: "extension", name: k, tools: current.extensions[k].tools });
    } else {
      const old = new Set(known.extensions[k].tools);
      const newSet = new Set(current.extensions[k].tools);
      const added = current.extensions[k].tools.filter((t) => !old.has(t));
      const removed = (known.extensions[k].tools ?? []).filter((t) => !newSet.has(t));
      if (added.length > 0 || removed.length > 0) {
        result.changed.push({ type: "extension", name: k, added, removed });
      }
    }
  }
  for (const k of Object.keys(known.extensions)) {
    if (!current.extensions[k]) {
      result.removed.push({ type: "extension", name: k });
    }
  }

  // mcp_servers
  for (const k of Object.keys(current.mcp_servers)) {
    if (!known.mcp_servers[k]) {
      result.added.push({ type: "mcp", name: k, tools: current.mcp_servers[k].tools });
    } else {
      const old = new Set(known.mcp_servers[k].tools);
      const newSet = new Set(current.mcp_servers[k].tools);
      const added = current.mcp_servers[k].tools.filter((t) => !old.has(t));
      const removed = (known.mcp_servers[k].tools ?? []).filter((t) => !newSet.has(t));
      if (added.length > 0 || removed.length > 0) {
        result.changed.push({ type: "mcp", name: k, added, removed });
      }
    }
  }
  for (const k of Object.keys(known.mcp_servers)) {
    if (!current.mcp_servers[k]) {
      result.removed.push({ type: "mcp", name: k });
    }
  }

  // skills
  for (const k of Object.keys(current.skills)) {
    if (!known.skills[k]) {
      result.added.push({ type: "skill", name: k, tools: [] });
    }
  }
  for (const k of Object.keys(known.skills)) {
    if (!current.skills[k]) {
      result.removed.push({ type: "skill", name: k });
    }
  }

  return result;
}

// ── 过滤应用 ────────────────────────────────────────────
/**
 * 计算应启用的工具名集合。
 * 规则：所有工具默认启用；被 opt_out 的 source 下的工具被过滤。
 */
function computeEnabledToolNames(
  allTools: ToolInfo[],
  optOut: Config["opt_out"],
): string[] {
  // 把 mcp_servers 的禁用意图转换为注册后的 tool 名集合
  // mcp 适配器会给工具名加前缀（默认 server_），需要复刻这个逻辑
  let mcpCache: McpCacheFile = { version: 1, servers: {} };
  let mcpConfig: McpConfigFile = { mcpServers: {} };
  try {
    if (existsSync(MCP_CACHE_FILE)) {
      mcpCache = JSON.parse(readFileSync(MCP_CACHE_FILE, "utf-8"));
    }
    if (existsSync(MCP_CONFIG_FILE)) {
      mcpConfig = JSON.parse(readFileSync(MCP_CONFIG_FILE, "utf-8"));
    }
  } catch { /* ignore */ }

  const prefixMode: ToolPrefix = mcpConfig.settings?.toolPrefix ?? "server";
  const disabledMcpToolNames = new Set<string>();
  for (const serverName of Object.keys(optOut.mcp_servers)) {
    const serverCache = mcpCache.servers?.[serverName];

    // 1. tools 数组
    for (const t of serverCache?.tools ?? []) {
      disabledMcpToolNames.add(formatMcpToolName(t.name, serverName, prefixMode));
    }

    // 2. resources 数组 —— MCP 适配器会把每个 resource 注册成一个 read 工具
    //    工具名规则：formatToolName("get_" + resourceNameToToolName(name), serverName, prefix)
    //    例：resource "act_ge_bytearray database schema" → get_act_ge_bytearray_database_schema → postgres_gt_cloud_get_act_ge_bytearray_database_schema
    for (const r of serverCache?.resources ?? []) {
      const baseName = `get_${resourceNameToToolName(r.name ?? "")}`;
      disabledMcpToolNames.add(formatMcpToolName(baseName, serverName, prefixMode));
    }
  }

  const disabledExtSources = new Set(Object.keys(optOut.extensions));

  return allTools
    .filter((tool) => {
      // 1. 禁用 MCP server 的工具
      if (disabledMcpToolNames.has(tool.name)) return false;
      // 2. 禁用扩展 source 的工具
      const sourceKey = normalizeSourceName(tool.sourceInfo.source);
      if (disabledExtSources.has(sourceKey)) return false;
      return true;
    })
    .map((t) => t.name);
}

function applyToolFilter(pi: ExtensionAPI, config: Config): { enabled: number; disabled: number } {
  const allTools = pi.getAllTools();
  const enabledNames = computeEnabledToolNames(allTools, config.opt_out);
  pi.setActiveTools(enabledNames);
  return {
    enabled: enabledNames.length,
    disabled: allTools.length - enabledNames.length,
  };
}

/**
 * 将 diff 结果同步到 config：清理 opt_out 残留、更新 known_sources 快照。
 */
function applyDiffToConfig(
  config: Config,
  manifest: Manifest,
  diff: DiffResult,
  notify: boolean,
  ctx?: ExtensionContext,
): void {
  // 清理被卸载的 source
  for (const r of diff.removed) {
    if (r.type === "extension") {
      delete config.opt_out.extensions[r.name];
      delete config.known_sources.extensions[r.name];
      if (notify && ctx) ctx.ui.notify(`已移除: 扩展 ${r.name}（其配置已自动清理）`, "info");
    } else if (r.type === "mcp") {
      delete config.opt_out.mcp_servers[r.name];
      delete config.known_sources.mcp_servers[r.name];
      if (notify && ctx) ctx.ui.notify(`已移除: MCP ${r.name}（其配置已自动清理）`, "info");
    } else if (r.type === "skill") {
      delete config.opt_out.skills[r.name];
      delete config.known_sources.skills[r.name];
      if (notify && ctx) ctx.ui.notify(`已移除: 技能 ${r.name}（其配置已自动清理）`, "info");
    }
  }

  // 刷新 known_sources 中所有 source 的快照
  for (const k of Object.keys(manifest.extensions)) {
    config.known_sources.extensions[k] = {
      tools: manifest.extensions[k].tools,
      last_seen: nowIso(),
    };
  }
  for (const k of Object.keys(manifest.mcp_servers)) {
    config.known_sources.mcp_servers[k] = {
      tools: manifest.mcp_servers[k].tools,
      last_seen: nowIso(),
    };
  }
  for (const k of Object.keys(manifest.skills)) {
    if (!config.known_sources.skills[k]) {
      config.known_sources.skills[k] = { last_seen: nowIso() };
    } else {
      config.known_sources.skills[k].last_seen = nowIso();
    }
  }

  // 通知新发现
  if (notify && ctx) {
    for (const a of diff.added) {
      const tip = a.type === "extension"
        ? `扩展 ${a.name}（${a.tools.length} 工具）`
        : a.type === "mcp"
          ? `MCP ${a.name}（${a.tools.length} 工具）`
          : `技能 ${a.name}`;
      ctx.ui.notify(`发现新来源: ${tip}，默认启用（/plugins 管理）`, "info");
    }
  }
}

async function refreshManifestAndFilter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  silent: boolean,
): Promise<void> {
  if (!cachedConfig) return;
  const manifest = await buildCurrentManifest(pi);
  const diff = diffManifests(cachedConfig.known_sources, manifest);
  applyDiffToConfig(cachedConfig, manifest, diff, /* notify */ !silent, silent ? undefined : ctx);
  await saveConfig(cachedConfig);

  lastStats = applyToolFilter(pi, cachedConfig);
  if (!silent && lastStats.disabled > 0) {
    ctx.ui.notify(
      `🔌 插件管理器：已关闭 ${lastStats.disabled} 个工具（节省上下文）`,
      "info",
    );
  }
  ctx.ui.setStatus("plugin-manager", getFooterStatus());
}

/**
 * 从系统提示中删除禁用技能的 SKILL.md 段落。
 * formatSkillsForPrompt 输出形如：
 *   <available_skills>
 *     <skill>
 *       <name>excel-edit</name>
 *       <description>...</description>
 *       <location>...</location>
 *     </skill>
 *   </available_skills>
 */
function removeDisabledSkills(systemPrompt: string, disabledSkillNames: string[]): string {
  if (disabledSkillNames.length === 0) return systemPrompt;
  let result = systemPrompt;
  for (const name of disabledSkillNames) {
    // 匹配 <skill>...</skill> 块，包含指定 <name> 的
    const blockRe = new RegExp(
      `<skill>[\\s\\S]*?<name>\\s*${escapeRegex(name)}\\s*</name>[\\s\\S]*?</skill>`,
      "g",
    );
    result = result.replace(blockRe, "");
  }
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 复刻 pi-mcp-adapter 的工具名前缀逻辑。
 * 默认 prefix = "server"，输出形如 `postgres_gt_cloud_query`。
 * 参考: pi-mcp-adapter/types.ts formatToolName
 */
function getMcpServerPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") return "";
  if (mode === "short") {
    let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    if (!short) short = "mcp";
    return short;
  }
  return serverName.replace(/-/g, "_");
}

function formatMcpToolName(toolName: string, serverName: string, mode: ToolPrefix): string {
  const p = getMcpServerPrefix(serverName, mode);
  return p ? `${p}_${toolName}` : toolName;
}

/**
 * 复刻 pi-mcp-adapter/resource-tools.ts 的 resourceNameToToolName。
 * MCP 资源名（如 `"table_name" database schema`）会先转成 tool basename，再加 `get_` 前缀。
 */
function resourceNameToToolName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .toLowerCase();
  if (!result || /^\d/.test(result)) {
    result = "resource" + (result ? "_" + result : "");
  }
  return result;
}

// ── /plugins 命令 ───────────────────────────────────────

/** 分类标识 */
type ItemCat = "mcp" | "ext" | "skill";

/** 切换某个来源的启用/禁用状态，返回操作结果 */
function toggleItem(config: Config, cat: ItemCat, name: string): { enabled: boolean; label: string } {
  const now = nowIso();
  const bucket =
    cat === "mcp" ? config.opt_out.mcp_servers
    : cat === "ext" ? config.opt_out.extensions
    : config.opt_out.skills;
  const prefix = cat === "mcp" ? "MCP" : cat === "ext" ? "扩展" : "技能";
  if (bucket[name]) {
    delete bucket[name];
    return { enabled: true, label: `${prefix}: ${name}` };
  }
  bucket[name] = { disabled_at: now };
  return { enabled: false, label: `${prefix}: ${name}` };
}

/** 格式化 token 数：≥1000 显示 X.XK，否则显示裸数字 */
function fmtTokens(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}K` : `~${n}`;
}

// ── 勾选组件（样式与交互对齐内置 /scoped-models 选择器）─────────────

interface ToggleEntry {
  /** 唯一 id */
  id: string;
  /** 主文本 */
  primary: string;
  /** muted 徽标，如 "[MCP] (3 工具, ~1.2K)" */
  badge?: string;
  /** 底部选中详情行 */
  detail?: string;
}

interface ToggleSelectorOptions {
  /** 标题 */
  title: string;
  /** 副标题说明（muted 提示行） */
  subtitle: string;
  /** footer 计数标签，如 "已启用" */
  countLabel: string;
}

/**
 * 勾选组件：↑↓ 选择、enter 切换勾选、ctrl+a 全选、ctrl+x 清空、
 * ctrl+s 保存、esc 取消；支持模糊搜索过滤；勾选的条目排在最上面。
 * 仅限 TUI 模式通过 ctx.ui.custom() 挂载；done(ids) 保存，done(null) 取消。
 */
class ToggleSelectorComponent extends Container {
  private entriesById = new Map<string, ToggleEntry>();
  private allIds: string[] = [];
  private markedIds: string[];
  private filteredItems: { entry: ToggleEntry; marked: boolean }[] = [];
  private selectedIndex = 0;
  private searchInput: Input;
  private listContainer: Container;
  private footerText: Text;
  private readonly maxVisible = 10;
  private isDirty = false;
  private saving = false;
  private saveNote = "";
  private readonly options: ToggleSelectorOptions;
  private readonly tui: any;
  private readonly keybindings: any;
  private readonly theme: any;
  private readonly done: (result: string[] | null) => void;
  private readonly onSave?: (ids: string[]) => void | Promise<void>;

  constructor(
    tui: any,
    options: ToggleSelectorOptions,
    entries: ToggleEntry[],
    initialMarked: string[],
    keybindings: any,
    theme: any,
    done: (result: string[] | null) => void,
    onSave?: (ids: string[]) => void | Promise<void>,
  ) {
    super();
    this.options = options;
    this.tui = tui;
    this.keybindings = keybindings;
    this.theme = theme;
    this.done = done;
    this.onSave = onSave;
    this.markedIds = [...initialMarked];
    for (const entry of entries) {
      this.entriesById.set(entry.id, entry);
      this.allIds.push(entry.id);
    }
    const border = this.theme.fg("border", "─".repeat(56));
    this.addChild(new Text(border, 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold(options.title)), 0, 0));
    this.addChild(
      new Text(this.theme.fg("muted", `${options.subtitle} · ${this.keyLabel("app.models.save")} 保存`), 0, 0),
    );
    this.addChild(new Spacer(1));
    this.searchInput = new Input();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.footerText = new Text("", 0, 0);
    this.addChild(this.footerText);
    this.addChild(new Text(border, 0, 0));
    this.refresh();
  }

  private keyLabel(id: string): string {
    try {
      const keys = this.keybindings?.getKeys?.(id);
      return Array.isArray(keys) && keys.length > 0 ? keys.join("/") : "";
    } catch {
      return "";
    }
  }

  private buildItems() {
    // 勾选的排最上（按勾选顺序），未勾选的保持原顺序排在后面
    const markedSet = new Set(this.markedIds);
    const sorted = [
      ...this.markedIds.filter((id) => this.entriesById.has(id)),
      ...this.allIds.filter((id) => !markedSet.has(id)),
    ];
    return sorted.map((id) => ({ entry: this.entriesById.get(id) as ToggleEntry, marked: markedSet.has(id) }));
  }

  /** ctrl+s：触发保存但不关闭组件，留在当前界面继续调整；esc 才退出。 */
  private triggerSave(): void {
    if (this.saving) return;
    if (!this.onSave) {
      this.done([...this.markedIds]);
      return;
    }
    this.saving = true;
    this.saveNote = "";
    this.footerText.setText(this.theme.fg("dim", "  保存中..."));
    const ids = [...this.markedIds];
    Promise.resolve()
      .then(() => this.onSave!(ids))
      .then(() => {
        this.saving = false;
        this.isDirty = false;
        this.saveNote = "已保存";
        this.refresh();
        this.tui?.requestRender?.();
      })
      .catch((e) => {
        this.saving = false;
        this.saveNote = `保存失败：${e instanceof Error ? e.message : String(e)}`;
        this.refresh();
        this.tui?.requestRender?.();
      });
  }

  private getFooterText(): string {
    const parts = [
      `${this.keyLabel("tui.select.confirm")} 切换`,
      `${this.keyLabel("app.models.enableAll")} 全选`,
      `${this.keyLabel("app.models.clearAll")} 清空`,
      `${this.keyLabel("app.models.save")} 保存`,
      "esc 取消",
      `${this.options.countLabel} ${this.markedIds.length}/${this.allIds.length}`,
    ];
    const text = `  ${parts.join(" · ")}${this.saveNote ? ` · ${this.saveNote}` : ""}`;
    return this.isDirty ? this.theme.fg("dim", text) + this.theme.fg("warning", " （未保存）") : this.theme.fg("dim", text);
  }

  private refresh(): void {
    const query = this.searchInput.getValue();
    const items = this.buildItems();
    this.filteredItems = query
      ? fuzzyFilter(items, query, (item) => item.entry.primary)
      : items;
    if (this.selectedIndex >= this.filteredItems.length) {
      this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
    }
    this.updateList();
    this.footerText.setText(this.getFooterText());
  }

  private updateList(): void {
    this.listContainer.clear();
    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  没有匹配的条目"), 0, 0));
      return;
    }
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      const primary = isSelected ? this.theme.fg("accent", item.entry.primary) : item.entry.primary;
      const badge = item.entry.badge ? this.theme.fg("muted", ` ${item.entry.badge}`) : "";
      const status = item.marked ? this.theme.fg("success", " ✓") : this.theme.fg("dim", " ✗");
      this.listContainer.addChild(new Text(`${prefix}${primary}${badge}${status}`, 0, 0));
    }
    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
      );
    }
    const selected = this.filteredItems[this.selectedIndex];
    if (selected?.entry.detail) {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(new Text(this.theme.fg("muted", `  ${selected.entry.detail}`), 0, 0));
    }
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.up")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
      this.updateList();
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      const item = this.filteredItems[this.selectedIndex];
      if (item) {
        const index = this.markedIds.indexOf(item.entry.id);
        if (index >= 0) this.markedIds.splice(index, 1);
        else this.markedIds.push(item.entry.id);
        this.isDirty = true;
        this.refresh();
      }
      return;
    }
    if (kb.matches(data, "app.models.enableAll")) {
      const targets = this.searchInput.getValue() ? this.filteredItems.map((i) => i.entry.id) : this.allIds;
      for (const id of targets) {
        if (!this.markedIds.includes(id)) this.markedIds.push(id);
      }
      this.isDirty = true;
      this.refresh();
      return;
    }
    if (kb.matches(data, "app.models.clearAll")) {
      if (this.searchInput.getValue()) {
        const targets = new Set(this.filteredItems.map((i) => i.entry.id));
        this.markedIds = this.markedIds.filter((id) => !targets.has(id));
      } else {
        this.markedIds = [];
      }
      this.isDirty = true;
      this.refresh();
      return;
    }
    if (kb.matches(data, "app.models.save")) {
      this.triggerSave();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.searchInput.getValue()) {
        this.searchInput.setValue("");
        this.refresh();
      } else {
        this.done(null);
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }
    this.searchInput.handleInput(data);
    this.refresh();
  }
}

/** 计算各分类的来源名列表（排序后） */
function getSortedNames(manifest: Manifest): {
  mcp: string[]; ext: string[]; skill: string[]; total: number;
} {
  const mcp = Object.keys(manifest.mcp_servers).sort();
  const ext = Object.keys(manifest.extensions).sort();
  const skill = Object.keys(manifest.skills).sort();
  return { mcp, ext, skill, total: mcp.length + ext.length + skill.length };
}

async function showPluginsMenu(ctx: ExtensionContext, pi: ExtensionAPI) {
  const config = await loadConfig();
  const manifest = await buildCurrentManifest(pi);
  const { total } = getSortedNames(manifest);

  if (total === 0) {
    ctx.ui.notify("没有发现可管理的插件", "info");
    return;
  }

  // TUI 模式：勾选组件批量编辑，ctrl+s 统一保存生效
  if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
    await runPluginToggleComponent(ctx, pi, config, manifest);
    return;
  }
  // 非 TUI：保留原有循环 select 交互
  if (total <= 20) {
    await showFlatMenu(ctx, pi, config, manifest);
  } else {
    await showCategoryMenu(ctx, pi, config, manifest);
  }
}

/** 收集所有可管理条目（MCP + 扩展 + 技能）及其分类元数据 */
function collectPluginEntries(
  config: Config,
  manifest: Manifest,
): { entries: ToggleEntry[]; meta: Map<string, { cat: ItemCat; name: string }> } {
  const { mcp, ext, skill } = getSortedNames(manifest);
  const entries: ToggleEntry[] = [];
  const meta = new Map<string, { cat: ItemCat; name: string }>();
  const add = (cat: ItemCat, name: string) => {
    const off = cat === "mcp" ? !!config.opt_out.mcp_servers[name]
      : cat === "ext" ? !!config.opt_out.extensions[name]
      : !!config.opt_out.skills[name];
    const info = cat === "skill" ? null
      : cat === "mcp" ? manifest.mcp_servers[name]
      : manifest.extensions[name];
    const badgeName = cat === "mcp" ? "MCP" : cat === "ext" ? "扩展" : "技能";
    const tail = info ? ` (${info.tools.length} 工具, ${fmtTokens(info.totalTokens)})` : "";
    const id = `${cat}:${name}`;
    entries.push({
      id,
      primary: name,
      badge: `[${badgeName}]${tail}`,
      detail: off ? "当前已禁用" : "当前已启用",
    });
    meta.set(id, { cat, name });
  };
  for (const n of mcp) add("mcp", n);
  for (const n of ext) add("ext", n);
  for (const n of skill) add("skill", n);
  return { entries, meta };
}

/** 把勾选结果应用到 opt_out 配置，返回变更数与非技能变更数 */
function applyPluginToggleDiff(
  config: Config,
  meta: Map<string, { cat: ItemCat; name: string }>,
  enabledIds: Set<string>,
): { changed: number; nonSkillChanged: number } {
  let changed = 0;
  let nonSkillChanged = 0;
  for (const [id, { cat, name }] of meta) {
    const bucket = cat === "mcp" ? config.opt_out.mcp_servers
      : cat === "ext" ? config.opt_out.extensions
      : config.opt_out.skills;
    const shouldEnable = enabledIds.has(id);
    if (shouldEnable && bucket[name]) {
      delete bucket[name];
      changed++;
      if (cat !== "skill") nonSkillChanged++;
    } else if (!shouldEnable && !bucket[name]) {
      bucket[name] = { disabled_at: new Date().toISOString() };
      changed++;
      if (cat !== "skill") nonSkillChanged++;
    }
  }
  return { changed, nonSkillChanged };
}

/** TUI 勾选组件入口：批量编辑启用状态，ctrl+s 实时保存并应用工具过滤，留在界面继续调整 */
async function runPluginToggleComponent(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
  manifest: Manifest,
) {
  const { entries, meta } = collectPluginEntries(config, manifest);
  const initialMarked = entries.filter((e) => !isEntryDisabled(config, meta, e.id)).map((e) => e.id);
  await ctx.ui.custom<string[] | null>(
    (tui: any, theme: any, keybindings: any, done: (value: string[] | null) => void) =>
      new ToggleSelectorComponent(
        tui,
        {
          title: "插件管理",
          subtitle: "勾选 = 启用该来源的工具；未勾选的不注入上下文",
          countLabel: "已启用",
        },
        entries,
        initialMarked,
        keybindings,
        theme,
        done,
        async (ids) => {
          const { changed, nonSkillChanged } = applyPluginToggleDiff(config, meta, new Set(ids));
          if (changed > 0) {
            cachedConfig = config;
            await saveConfig(config);
            if (nonSkillChanged > 0) applyToolFilter(pi, config);
            ctx.ui.setStatus("plugin-manager", getFooterStatus());
          }
        },
      ),
  );
  ctx.ui.setStatus("plugin-manager", getFooterStatus());
}

/** 条目当前是否处于禁用状态 */
function isEntryDisabled(config: Config, meta: Map<string, { cat: ItemCat; name: string }>, id: string): boolean {
  const item = meta.get(id);
  if (!item) return false;
  const bucket = item.cat === "mcp" ? config.opt_out.mcp_servers
    : item.cat === "ext" ? config.opt_out.extensions
    : config.opt_out.skills;
  return !!bucket[item.name];
}

/** 扁平菜单：所有来源在一个列表里，按分类标题分组 */
async function showFlatMenu(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
  manifest: Manifest,
) {
  const { mcp, ext, skill } = getSortedNames(manifest);
  while (true) {
    const options: string[] = [];
    const items: { cat: ItemCat; name: string }[] = [];

    if (mcp.length > 0) {
      options.push(`── 🔌 MCP 服务器 (${mcp.length}) ──`);
      items.push({ cat: "mcp", name: "" });
      for (const n of mcp) {
        const off = !!config.opt_out.mcp_servers[n];
        const info = manifest.mcp_servers[n];
        const tc = info.tools.length;
        options.push(`  ${off ? "☐" : "☑"} ${n} (${tc}, ${fmtTokens(info.totalTokens)})`);
        items.push({ cat: "mcp", name: n });
      }
    }
    if (ext.length > 0) {
      options.push(`── 🧩 扩展工具 (${ext.length}) ──`);
      items.push({ cat: "ext", name: "" });
      for (const n of ext) {
        const off = !!config.opt_out.extensions[n];
        const info = manifest.extensions[n];
        const tc = info.tools.length;
        options.push(`  ${off ? "☐" : "☑"} ${n} (${tc}, ${fmtTokens(info.totalTokens)})`);
        items.push({ cat: "ext", name: n });
      }
    }
    if (skill.length > 0) {
      options.push(`── 📋 技能 (${skill.length}) ──`);
      items.push({ cat: "skill", name: "" });
      for (const n of skill) {
        const off = !!config.opt_out.skills[n];
        options.push(`  ${off ? "☐" : "☑"} ${n}`);
        items.push({ cat: "skill", name: n });
      }
    }
    options.push("🔙 返回");

    const choice = await ctx.ui.select("插件管理（点击切换启用/禁用）", options);
    if (!choice || choice === "🔙 返回") return;
    const idx = options.indexOf(choice);
    if (idx < 0 || idx >= items.length) continue;
    const item = items[idx];
    if (!item.name) continue; // 分类标题行，不操作

    const r = toggleItem(config, item.cat, item.name);
    cachedConfig = config;
    await saveConfig(config);
    if (item.cat !== "skill") applyToolFilter(pi, config);
    ctx.ui.notify(r.enabled ? `已启用 ${r.label}` : `已禁用 ${r.label}`, "info");
    ctx.ui.setStatus("plugin-manager", getFooterStatus());
  }
}

/** 二级菜单：先选分类，再进子列表（用于来源数 > 20 的场景） */
async function showCategoryMenu(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
  manifest: Manifest,
) {
  const { mcp, ext, skill } = getSortedNames(manifest);
  while (true) {
    const section = await ctx.ui.select("插件管理 — 选择类别", [
      `🔌 MCP 服务器 (${mcp.length})`,
      `🧩 扩展工具 (${ext.length})`,
      `📋 技能 (${skill.length})`,
      "🔙 返回",
    ]);
    if (!section || section === "🔙 返回") return;
    if (section.startsWith("🔌")) await manageSubList(ctx, pi, config, manifest, "mcp", mcp);
    else if (section.startsWith("🧩")) await manageSubList(ctx, pi, config, manifest, "ext", ext);
    else if (section.startsWith("📋")) await manageSubList(ctx, pi, config, manifest, "skill", skill);
  }
}

/** 二级菜单的子列表切换 */
async function manageSubList(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
  manifest: Manifest,
  cat: ItemCat,
  names: string[],
) {
  if (names.length === 0) {
    ctx.ui.notify("该分类下没有来源", "info");
    return;
  }
  while (true) {
    const options = names.map((n) => {
      const off =
        cat === "mcp" ? !!config.opt_out.mcp_servers[n]
        : cat === "ext" ? !!config.opt_out.extensions[n]
        : !!config.opt_out.skills[n];
      const info = cat === "skill" ? null
        : cat === "mcp" ? manifest.mcp_servers[n]
        : manifest.extensions[n];
      const tc = info ? info.tools.length : 0;
      const tk = info ? info.totalTokens : 0;
      const tail = cat === "skill" ? "" : ` (${tc}, ${fmtTokens(tk)})`;
      return `${off ? "☐" : "☑"} ${n}${tail}`;
    });
    options.push("🔙 返回");

    const title = cat === "mcp" ? "MCP 服务器" : cat === "ext" ? "扩展工具" : "技能";
    const choice = await ctx.ui.select(`${title}（点击切换）`, options);
    if (!choice || choice === "🔙 返回") return;
    const idx = options.indexOf(choice);
    if (idx < 0 || idx >= names.length) continue;

    const name = names[idx];
    const r = toggleItem(config, cat, name);
    cachedConfig = config;
    await saveConfig(config);
    if (cat !== "skill") applyToolFilter(pi, config);
    ctx.ui.notify(r.enabled ? `已启用 ${r.label}` : `已禁用 ${r.label}`, "info");
    ctx.ui.setStatus("plugin-manager", getFooterStatus());
  }
}

// ── 全局状态 ───────────────────────────────────────────
let cachedConfig: Config | null = null;
let lastStats: { enabled: number; disabled: number } = { enabled: 0, disabled: 0 };

function getFooterStatus(): string {
  if (!cachedConfig) return "";
  const total =
    Object.keys(cachedConfig.known_sources.extensions).length +
    Object.keys(cachedConfig.known_sources.mcp_servers).length +
    Object.keys(cachedConfig.known_sources.skills).length;
  if (total === 0) return "";
  let disabled = 0;
  disabled += Object.keys(cachedConfig.opt_out.extensions).length;
  disabled += Object.keys(cachedConfig.opt_out.mcp_servers).length;
  disabled += Object.keys(cachedConfig.opt_out.skills).length;
  const enabled = total - disabled;
  return `🧩 ${enabled}/${total}`;
}

// ── 扩展入口 ────────────────────────────────────────────
export default function pluginManagerExtension(pi: ExtensionAPI) {
  // ── /plugins 命令 ──────────────────────────────────
  pi.registerCommand("plugins", {
    description: "管理 MCP / 扩展 / 技能的启用状态（关闭不需要的能力以节省上下文）",
    handler: async (_args, ctx) => {
      await showPluginsMenu(ctx as ExtensionContext, pi);
    },
  });

  // ── session_start: 加载配置 + 首次扫描 + 注册 footer ─────
  pi.on("session_start", async (_event, ctx) => {
    const isFirstRun = !existsSync(CONFIG_FILE);
    cachedConfig = await loadConfig();

    // 扫描 + 过滤（MCP direct 工具在扩展加载时已注册，此时 getAllTools 已包含它们）
    await refreshManifestAndFilter(pi, ctx, isFirstRun);

    // 用 setStatus 在 footer 显示启用/总数
    ctx.ui.setStatus("plugin-manager", getFooterStatus());
  });

  // ── before_agent_start: 只过滤系统提示中的技能段落 ──
  // 工具过滤仅在 session_start 和 /plugins 时做（MCP direct 工具在扩展加载时就
  // 已注册，session_start 时 getAllTools 已包含它们，无需每轮重扫）
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!cachedConfig) return;
    const disabledSkills = Object.keys(cachedConfig.opt_out.skills);
    if (disabledSkills.length === 0) return;
    const filtered = removeDisabledSkills(event.systemPrompt, disabledSkills);
    if (filtered !== event.systemPrompt) {
      return { systemPrompt: filtered };
    }
  });
}
