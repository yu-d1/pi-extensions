// @liziy/token-stats —— pi 的 Token 用量与配额监控扩展
// =============================================================================
// Footer 实时显示：5h/周 套餐剩余 + 滚动 2s 输出速率 + 缓存命中率 + 上下文占用
// 每轮对话自动落 JSONL，/stats 命令按日/小时/周/月查询
//
// 为什么要装：
// - 避免跑到一半被限流中断（5h 剩余 + 倒计时直接挂在 footer）
// - 调 prompt 有依据（缓存命中率量化"是不是省到钱了"）
// - 实时反馈输出速度（rolling window 对比不同模型/service_tier）
//
// 套餐用量内置：MiniMax / GLM / Kimi / DeepSeek
// 配置持久化：~/.pi/agent/extensions/token-stats/
// 日志输出：   ~/.pi/agent/extensions/token-stats-logs/
//
// 安装：pi install npm:@liziy/token-stats

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { createDeepseekBackend, type SearchBackend } from "./search";

// ── 路径 ──────────────────────────────────────────────────

const LOGS_DIR = join(homedir(), ".pi/agent/extensions/token-stats-logs");
const RAW_DIR = join(LOGS_DIR, "raw");
const HOURLY_DIR = join(LOGS_DIR, "hourly");
const DAILY_FILE = join(LOGS_DIR, "daily", "daily.jsonl");

// ── 常量 ──────────────────────────────────────────────────

/** Rolling window 时长（毫秒），用于实时速率计算 */
const LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS = 2000;

/** 速率合理范围上限 */
const MAX_REASONABLE_TOKEN_SPEED = 1000;

// ── 类型 ──────────────────────────────────────────────────

interface TurnStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokensPerSec: number;
  cacheHitRate: number;
  model: string;
  firstTokenLatency: number; // 首 token 延迟（毫秒）
  wordCount: number;         // 输出词数（中日韩按字 + 其他按词）
  cost: number;              // 本轮花费（美元）
  liveTokenSpeed: number | null; // 流式 rolling window 速率
}

interface RawRecord extends TurnStats {
  ts: string;
  session: string;
}

interface HourlyRecord {
  date: string;
  hour: number;
  count: number;
  sumInput: number;
  sumOutput: number;
  sumCacheRead: number;
  sumCacheWrite: number;
  sumTokensPerSec: number;
  avgCacheHitRate: number;
}

interface DailyRecord {
  date: string;
  count: number;
  sumInput: number;
  sumOutput: number;
  sumCacheRead: number;
  sumCacheWrite: number;
  sumTokensPerSec: number;
  avgCacheHitRate: number;
}
// ── 套餐用量类型 ──────────────────────────────────────────

interface TokenPlan {
  id: string;
  name: string;
  matchProviders: string[];
  apiKeyEnv: string;
  baseUrl: string;
  quotaPath: string;
  authHeader: (key: string) => Record<string, string>;
  fetchQuota: (plan: TokenPlan, key: string) => Promise<any>;
  format: (data: any) => { modelPrefix: string; display: string; color: 'ok' | 'warn' | 'err' };
}

interface TokenConfig {
  providerPlans: Record<string, string | null>;
  ttl: number;
  /** 联网搜索配置（v1.4.0+；旧配置文件无此字段时用默认值：开启 + deepseek 映射） */
  search?: SearchConfig;
}

interface SearchConfig {
  /** 总开关，默认 true */
  enabled: boolean;
  /** 套餐 id → 搜索后端 id 映射（如 { "deepseek": "deepseek-server" }） */
  backends: Record<string, string>;
}

interface QuotaCache {
  [planId: string]: {
    fetchedAt: number;
    ttl: number;
    data: any;
  };
}

export type ContextStyle = "pct-window" | "used-window" | "pct" | "used" | "bar";
export type SpeedStyle = "t/s" | "tok/s" | "T/s" | "liveAt";

export type DisplayKey =
  | "input"       // 输入（累计输入数 ↑）
  | "output"      // 输出（累计输出数 ↓）
  | "totalTokens" // 总token（累计输入+输出）
  | "cacheHit"    // 缓存命中率
  | "speed"       // 速度（tok/s）
  | "context"     // 容量（🧠 ctx%）
  | "quota5h"     // 5h 额度
  | "quotaWeek"   // 周额度
  | "quotaClock"; // 刷新时间（⏱）

export interface DisplayConfig {
  items: Record<DisplayKey, boolean>;
  contextStyle: ContextStyle;
  speedStyle: SpeedStyle;
}


// ── 状态 ──────────────────────────────────────────────────

interface LiveTokenSample {
  timestampMs: number;
  tokens: number;
}

const stats = {
  // 累计会话
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  totalCost: 0,
  turnCount: 0,
  // 本轮计时
  turnStartTime: 0,
  firstTokenTime: 0,
  streaming: false,
  // 缓存命中率累加（用于平均值）
  totalCacheHitRateSum: 0,
  // 本轮最终（message_end 时写入）
  lastInput: 0,
  lastOutput: 0,
  lastCacheRead: 0,
  lastCacheWrite: 0,
  lastCost: 0,
  lastCacheHitRate: 0,
  lastTokensPerSec: 0,           // 平均速率（output / elapsed）
  lastLiveTokenSpeed: null as number | null, // rolling window 速率
  lastFirstTokenLatency: 0,      // 首 token 延迟（毫秒）
  lastWordCount: 0,              // 输出词数
  // ── 流式 rolling window 状态 ─────────────────────────
  liveOutputChars: 0,
  liveEstimatedTokens: 0,
  liveUsageOutputTokens: 0,
  liveTokenSamples: [] as LiveTokenSample[],
  // ── 去重（防止 message_end + turn_end 重复累加）───
  accountedUsageKeys: new Set<string>(),
};
// ── 套餐用量状态 ─────────────────────────────────────────

interface QuotaDisplayState {
  planId: string;
  display: string;
  modelPrefix: string;
  color: "ok" | "warn" | "err" | "muted";
  /** 该 state 对应的 provider；与当前 ctx.model.provider 不一致时视为残留 */
  provider: string;
  /** 数据获取时间戳；用于调试与新陈度判断 */
  fetchedAt: number;
  /** 错误时携带具体原因（key 缺失 / API 错误 / 网络错误 / 无数据） */
  error?: QuotaError;
}

type QuotaError =
  | { kind: "no_plan" }
  | { kind: "key_missing"; envVar: string; provider: string }
  | { kind: "api_error"; message: string }
  | { kind: "network_error"; message: string }
  | { kind: "no_data" };

let quotaState: QuotaDisplayState | null = null;
let quotaTimerId: ReturnType<typeof setInterval> | null = null;
/** session 存活标志：session_shutdown 置 false，session_start 置 true，用于守卫异步回调 */
let sessionActive = false;
let tokenConfig: TokenConfig | null = null;
let lastQuotaProvider: string | null = null;


// ── 工具函数 ──────────────────────────────────────────────

/**
 * Token 格式化（对齐 @firstpick/pi-utils formatTokens）
 */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatTokenSpeed(tokensPerSecond: number): string {
  if (tokensPerSecond < 100) {
    if (tokensPerSecond >= 10) return tokensPerSecond.toFixed(1);
    return tokensPerSecond.toFixed(2);
  }
  if (tokensPerSecond < 1000) return Math.round(tokensPerSecond).toString();
  if (tokensPerSecond < 10000) return `${(tokensPerSecond / 1000).toFixed(1)}k`;
  if (tokensPerSecond < 1000000) return `${Math.round(tokensPerSecond / 1000)}k`;
  if (tokensPerSecond < 10000000) return `${(tokensPerSecond / 1000000).toFixed(1)}M`;
  return `${Math.round(tokensPerSecond / 1000000)}M`;
}

function isReasonableTokenSpeed(tokensPerSecond: number): boolean {
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 && tokensPerSecond <= MAX_REASONABLE_TOKEN_SPEED;
}

function estimateTokens(textLen: number): number {
  return Math.round(textLen / 4);
}

/**
 * 提取消息中的纯文本（含 thinking）
 */
function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const b = block as any;
    if (b?.type === "text" && typeof b.text === "string") {
      text += b.text;
    } else if (b?.type === "thinking" && typeof b.thinking === "string") {
      text += b.thinking;
    }
  }
  return text;
}

/**
 * 词数统计（CJK 按字 + 其他按词）
 * 参考 ChatBox 的 countWord 实现
 */
function countWords(text: string): number {
  if (!text) return 0;
  const pattern =
    /[a-zA-Z0-9_\u0392-\u03c9\u00c0-\u00ff\u0600-\u06ff\u0400-\u04ff]+|[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\uac00-\ud7af]+/g;
  const m = text.match(pattern);
  if (!m) return 0;
  let count = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i].charCodeAt(0) >= 0x4e00) {
      count += m[i].length;
    } else {
      count += 1;
    }
  }
  return count;
}

function getDateStr(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function getHour(ts = Date.now()): number {
  return new Date(ts).getHours();
}

function getISO(ts = Date.now()): string {
  return new Date(ts).toISOString();
}

function formatUserPath(cwd: string): string {
  const home = homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

// ── UI 刷新 ──────────────────────────────────────────────

/** 等宽进度条：██░░░░░░ 25% */
function progressBar(pct: number, width = 8): string {
  const filled = Math.round(Math.min(pct, 100) / 100 * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function getRollingLiveTokenSpeed(nowMs: number = Date.now()): number | null {
  const cutoffMs = nowMs - LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS;
  stats.liveTokenSamples = stats.liveTokenSamples.filter(
    (s) => s.timestampMs >= cutoffMs,
  );
  if (stats.liveTokenSamples.length === 0) return null;

  const firstSampleMs = stats.liveTokenSamples[0]!.timestampMs;
  const windowStartMs = Math.max(stats.turnStartTime || firstSampleMs, cutoffMs);
  const elapsedSeconds = (nowMs - windowStartMs) / 1000;
  if (elapsedSeconds <= 0) return null;

  const tokens = stats.liveTokenSamples.reduce((sum, s) => sum + s.tokens, 0);
  const speed = tokens / elapsedSeconds;
  return isReasonableTokenSpeed(speed) ? speed : null;
}

function resetLiveState() {
  stats.liveOutputChars = 0;
  stats.liveEstimatedTokens = 0;
  stats.liveUsageOutputTokens = 0;
  stats.liveTokenSamples = [];
}

function buildMetricParts(theme: ReturnType<ExtensionContext["ui"]["theme"]>, ctx: ExtensionContext): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const warn = (s: string) => theme.fg("warning", s);
  const ok = (s: string) => theme.fg("success", s);
  const muted = (s: string) => theme.fg("muted", s);

  const parts: string[] = [];
  const cfg = displayConfig.items;

  // ── 输入 / 输出 / 总token / 缓存命中 ──────────────
  {
    const segParts: string[] = [];
    if (cfg.input) segParts.push(`↑${formatTokens(stats.totalInput)}`);
    if (cfg.output) segParts.push(`↓${formatTokens(stats.totalOutput)}`);
    if (cfg.totalTokens) {
      const total = stats.totalInput + stats.totalOutput;
      segParts.push(`Σ${formatTokens(total)}`);
    }
    if (cfg.cacheHit) {
      const totalPrompt = stats.totalInput + stats.totalCacheRead + stats.totalCacheWrite;
      const cumCH = totalPrompt > 0 ? (stats.totalCacheRead / totalPrompt) * 100 : 0;
      const chColor = cumCH >= 80 ? ok
        : cumCH >= 50 ? (s: string) => s
        : warn;
      segParts.push(`${dim("CH")}${chColor(`${cumCH.toFixed(0)}%`)}`);
    }
    if (segParts.length > 0) parts.push(segParts.join(" "));
  }

  // ── 速度 ⚡ ─────────────────────────────────────────
  if (cfg.speed) {
    const liveSpeed = getRollingLiveTokenSpeed();
    const displaySpeed = liveSpeed !== null ? liveSpeed : stats.lastTokensPerSec;
    const speedNum = ok(formatTokenSpeed(displaySpeed));
    const speedStyle = displayConfig.speedStyle ?? "t/s";
    switch (speedStyle) {
      case "tok/s":
        parts.push(`⚡${speedNum} tok/s`);
        break;
      case "T/s":
        parts.push(`⚡${speedNum} T/s`);
        break;
      case "liveAt":
        if (stats.streaming && liveSpeed !== null) {
          parts.push(`⚡${formatTokens(stats.liveEstimatedTokens)}@${speedNum}`);
        } else {
          parts.push(`⚡${speedNum} t/s`);
        }
        break;
      default:
        parts.push(`⚡${speedNum} t/s`);
        break;
    }
  }

  // ── 容量 🧠 ────────────────────────────────────────
  if (cfg.context) {
    try {
      const cu = ctx.getContextUsage();
      const ctxWindow = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const ctxPercent = typeof cu?.percent === "number" ? cu.percent : null;
      const ctxUsed = ctxPercent !== null && ctxWindow > 0 ? Math.round(ctxWindow * ctxPercent / 100) : 0;
      const ctxStyle = displayConfig.contextStyle ?? "pct-window";
      let ctxStr: string;
      if (ctxWindow > 0 && ctxPercent !== null) {
        switch (ctxStyle) {
          case "used-window":
            ctxStr = `${formatTokens(ctxUsed)}/${formatTokens(ctxWindow)}`;
            break;
          case "pct":
            ctxStr = `${ctxPercent.toFixed(1)}%`;
            break;
          case "used":
            ctxStr = formatTokens(ctxUsed);
            break;
          case "bar":
            ctxStr = `${progressBar(ctxPercent)} ${ctxPercent.toFixed(1)}%`;
            break;
          default:
            ctxStr = `${ctxPercent.toFixed(1)}%/${formatTokens(ctxWindow)}`;
            break;
        }
      } else {
        ctxStr = ctxWindow > 0 ? `?/${formatTokens(ctxWindow)}` : `0%/0`;
      }
      const ctxColor = ctxPercent !== null && ctxWindow > 0
        ? ctxPercent < 50 ? ok
          : ctxPercent < 65 ? (s: string) => theme.fg("accent", s)
            : ctxPercent < 75 ? muted
              : ctxPercent < 85 ? warn
                : (s: string) => theme.fg("error", s)
        : dim;
      parts.push(`${muted("🧠")} ${ctxColor(ctxStr)}`);
    } catch { /* ignore */ }
  }

  // ── 套餐用量（最右侧）：检测 provider 变化，自动隐藏/刷新 ─
  // P1 修复：provider 切换会同时清旧 state，错误状态会显示为 "未启用" / "KEY 未设置" 等
  const curProvider = ctx.model?.provider ?? null;
  if (curProvider !== lastQuotaProvider) {
    // 跨 provider 切换：force refresh（绕过缓存，避免 P7）
    if (lastQuotaProvider !== null || curProvider !== null) {
      setTimeout(() => {
        if (!sessionActive) return;
        refreshQuota(ctx, true)
          .then(() => requestFooterRender?.())
          .catch(() => { /* ctx 已失效（session 被替换），忽略 */ });
      }, 0);
    }
    lastQuotaProvider = curProvider;
  }
  if (quotaState && quotaState.display) {
    const qColor = quotaState.color === "ok" ? ok
      : quotaState.color === "warn" ? warn
        : quotaState.color === "err" ? (s: string) => theme.fg("error", s)
          : muted;
    const prefix = quotaState.modelPrefix ? quotaState.modelPrefix + " " : "";

    // P2 修复：error 状态（如 no_plan / key_missing）也显示具体原因，不再静默消失
    if (quotaState.error) {
      // 错误状态：直接显示提示文本，不解析 5h/W/⏱ 字段
      parts.push(qColor(prefix + quotaState.display));
    } else {
      // 正常状态：按子项过滤配额显示
      const fullDisplay = quotaState.display;
      const filteredParts: string[] = [];
      if (cfg.quota5h) {
      const m = fullDisplay.match(/\b5h:\s+\d+%/);
      if (m) filteredParts.push(m[0]);
      }
      if (cfg.quotaWeek) {
      const m = fullDisplay.match(/\bW:\s+\d+%/);
      if (m) filteredParts.push(m[0]);
      }
      if (cfg.quotaClock) {
      const m = fullDisplay.match(/⏱\s*\d+[hm]/);
      if (m) filteredParts.push(m[0]);
      }
      if (filteredParts.length > 0) {
        parts.push(qColor(prefix + filteredParts.join(" ")));
      } else if (cfg.quota5h || cfg.quotaWeek || cfg.quotaClock) {
        // 余额型套餐（DeepSeek ¥xx.x 等）不含 5h/W/⏱ 字段，
        // 子项过滤匹配不到任何内容时回退显示完整 display，避免配额段静默消失
        parts.push(qColor(prefix + fullDisplay));
      }
    }
  }

  return parts;
}

let requestFooterRender: (() => void) | null = null;

// ── 日志持久化 ───────────────────────────────────────────

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function appendRaw(record: RawRecord) {
  await ensureDir(RAW_DIR);
  const file = join(RAW_DIR, `${record.ts.slice(0, 10)}.jsonl`);
  await appendFile(file, JSON.stringify(record) + "\n", "utf-8");
}

async function updateHourly(record: RawRecord) {
  await ensureDir(HOURLY_DIR);
  const date = record.ts.slice(0, 10);
  const hour = new Date(record.ts).getHours();
  const file = join(HOURLY_DIR, `${date}.jsonl`);

  let lines: string[] = [];
  try {
    lines = (await readFile(file, "utf-8")).trim().split("\n").filter(Boolean);
  } catch {
    // 文件不存在
  }

  const records: HourlyRecord[] = lines.map((l) => JSON.parse(l));
  const idx = records.findIndex(
    (r) => r.date === date && r.hour === hour,
  );

  if (idx >= 0) {
    const r = records[idx];
    const newCount = r.count + 1;
    records[idx] = {
      date,
      hour,
      count: newCount,
      sumInput: r.sumInput + record.input,
      sumOutput: r.sumOutput + record.output,
      sumCacheRead: r.sumCacheRead + record.cacheRead,
      sumCacheWrite: r.sumCacheWrite + record.cacheWrite,
      sumTokensPerSec: r.sumTokensPerSec + record.tokensPerSec,
      avgCacheHitRate:
        ((r.avgCacheHitRate * r.count + record.cacheHitRate) / newCount),
    };
  } else {
    records.push({
      date,
      hour,
      count: 1,
      sumInput: record.input,
      sumOutput: record.output,
      sumCacheRead: record.cacheRead,
      sumCacheWrite: record.cacheWrite,
      sumTokensPerSec: record.tokensPerSec,
      avgCacheHitRate: record.cacheHitRate,
    });
  }

  await writeFile(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
}

async function updateDaily(record: RawRecord) {
  await ensureDir(join(LOGS_DIR, "daily"));
  const date = record.ts.slice(0, 10);

  let lines: string[] = [];
  try {
    lines = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n")
      .filter(Boolean);
  } catch {
    // 文件不存在
  }

  const records: DailyRecord[] = lines.map((l) => JSON.parse(l));
  const idx = records.findIndex((r) => r.date === date);

  if (idx >= 0) {
    const r = records[idx];
    const newCount = r.count + 1;
    records[idx] = {
      date,
      count: newCount,
      sumInput: r.sumInput + record.input,
      sumOutput: r.sumOutput + record.output,
      sumCacheRead: r.sumCacheRead + record.cacheRead,
      sumCacheWrite: r.sumCacheWrite + record.cacheWrite,
      sumTokensPerSec: r.sumTokensPerSec + record.tokensPerSec,
      avgCacheHitRate:
        ((r.avgCacheHitRate * r.count + record.cacheHitRate) / newCount),
    };
  } else {
    records.push({
      date,
      count: 1,
      sumInput: record.input,
      sumOutput: record.output,
      sumCacheRead: record.cacheRead,
      sumCacheWrite: record.cacheWrite,
      sumTokensPerSec: record.tokensPerSec,
      avgCacheHitRate: record.cacheHitRate,
    });
  }

  await writeFile(
    DAILY_FILE,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
}

async function persistTurn(record: TurnStats, sessionId: string) {
  const raw: RawRecord = {
    ...record,
    ts: getISO(),
    session: sessionId,
  };
  await appendRaw(raw);
  await updateHourly(raw);
  await updateDaily(raw);
}

// ── 会话恢复：从历史消息重建累计统计 ─────────────────────

function normalizeTimestampMs(timestamp: number): number {
  // 处理混合时间戳单位
  if (timestamp < 1e11) return timestamp * 1000;  // seconds → ms
  if (timestamp > 1e14) return Math.floor(timestamp / 1000); // microsec → ms
  return timestamp;
}

function getEntryTimestampMs(entry: {
  type: string;
  timestamp: string;
  message?: { timestamp?: number };
}): number | null {
  if (entry.type === "message" && typeof entry.message?.timestamp === "number") {
    return normalizeTimestampMs(entry.message.timestamp);
  }
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function rebuildFromHistory(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  stats.totalInput = 0;
  stats.totalOutput = 0;
  stats.totalCacheRead = 0;
  stats.totalCacheWrite = 0;
  stats.totalCost = 0;
  stats.totalCacheHitRateSum = 0;
  stats.turnCount = 0;
  stats.accountedUsageKeys = new Set();
  stats.lastTokensPerSec = 0;

  // 遍历 entries 重建累计统计，同时推算历史速率
  let latestAssistantSpeed: number | null = null;

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = (entry as any).message;
    if (msg.role !== "assistant" || !msg.usage) continue;

    stats.totalInput += msg.usage.input ?? 0;
    stats.totalOutput += msg.usage.output ?? 0;
    stats.totalCacheRead += msg.usage.cacheRead ?? 0;
    stats.totalCacheWrite += msg.usage.cacheWrite ?? 0;
    stats.totalCost += msg.usage.cost?.total ?? 0;

    const promptTokens = (msg.usage.input ?? 0) + (msg.usage.cacheRead ?? 0) + (msg.usage.cacheWrite ?? 0);
    const chRate = promptTokens > 0
      ? ((msg.usage.cacheRead ?? 0) / promptTokens) * 100
      : 0;
    stats.totalCacheHitRateSum += chRate;
    stats.turnCount++;

    // 推算历史速率：从上一个 user 消息到本条 assistant 的耗时
    if ((msg.usage.output ?? 0) <= 0) continue;
    const endMs = getEntryTimestampMs(entry);
    if (endMs === null) continue;

    for (let j = branch.indexOf(entry) - 1; j >= 0; j--) {
      const prev = branch[j];
      if (prev.type !== "message") continue;
      const prevMsg = (prev as any).message;
      if (prevMsg.role === "assistant") continue; // 跳过 assistant 之间的 delta

      const startMs = getEntryTimestampMs(prev);
      if (startMs === null || endMs <= startMs) continue;

      const elapsedSeconds = (endMs - startMs) / 1000;
      if (elapsedSeconds <= 0) continue;

      const speed = (msg.usage.output ?? 0) / elapsedSeconds;
      if (!isReasonableTokenSpeed(speed)) continue;

      if (prevMsg.role === "user") {
        latestAssistantSpeed = speed;
        break;
      }
      // 非 user 消息的 fallback
      if (latestAssistantSpeed === null) latestAssistantSpeed = speed;
    }
  }

  if (latestAssistantSpeed !== null) {
    stats.lastTokensPerSec = latestAssistantSpeed;
  }
}
// ── 套餐用量工具 ─────────────────────────────────────────

const TOKEN_CONFIG_DIR = join(homedir(), ".pi/agent/extensions/token-stats");
const TOKEN_CONFIG_FILE = join(TOKEN_CONFIG_DIR, "config.json");
const QUOTA_CACHE_FILE = join(LOGS_DIR, "quota-cache.json");

const DEFAULT_TOKEN_CONFIG: TokenConfig = {
  providerPlans: {},
  ttl: 60,
  search: { enabled: true, backends: { deepseek: "deepseek-server" } },
};

const DISPLAY_CONFIG_FILE = join(TOKEN_CONFIG_DIR, "display-config.json");
const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  items: {
    input: true,
    output: true,
    totalTokens: false,
    cacheHit: true,
    speed: true,
    context: true,
    quota5h: true,
    quotaWeek: true,
    quotaClock: true,
  },
  contextStyle: "pct-window",
  speedStyle: "t/s",
};

let displayConfig: DisplayConfig = { ...DEFAULT_DISPLAY_CONFIG, items: { ...DEFAULT_DISPLAY_CONFIG.items } };

// ── 内置套餐定义 ─────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms <= 0) return "";
  if (ms >= 24 * 60 * 60 * 1000) {
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    if (days >= 7) return `${Math.floor(days / 7)}w ${days % 7}d`;
    return `${days}d ${hours}h`;
  }
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const mins = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatTokenPlanDisplay(intervalRemaining: number, weeklyRemaining: number, nearestResetMs?: number | null): string {
  let display = `5h: ${Math.round(intervalRemaining)}% W: ${Math.round(weeklyRemaining)}%`;
  if (nearestResetMs && nearestResetMs > 0) {
    const diff = nearestResetMs - Date.now();
    if (diff > 0 && diff < 30 * 24 * 60 * 60 * 1000) {
      display += ` ⏱ ${formatDuration(diff)}`;
    }
  }
  return display;
}

const BUILTIN_PLANS: TokenPlan[] = [
  {
    id: "minimax",
    name: "MiniMax",
    matchProviders: ["minimax_local", "minimax-cn", "minimax"],
    apiKeyEnv: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimaxi.com",
    quotaPath: "/v1/api/openplatform/coding_plan/remains",
    authHeader: (key) => ({ Authorization: "Bearer " + key }),
    fetchQuota: async (plan: TokenPlan, key: string) => {
      const url = "https://api.minimaxi.com" + plan.quotaPath;
      const r = await fetch(url, {
        method: "GET",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      const data = await r.json();
      if (data.base_resp?.status_code === 0) return data;
      throw new Error(data.base_resp?.status_msg || "MiniMax 返回错误");
    },
    format: (data: any) => {
      const models = data.model_remains || [];
      // MiniMax 官方接口 2026-07 起 model_name 改为 general / video 等语义化命名，
      // 不再是 MiniMax-M2 / MiniMax-M3。
      // 优先取 "general"（通用文本/编码套餐），否则取第一项
      const m =
        models.find((x: any) => x.model_name === "general") ||
        models.find((x: any) => x.model_name?.includes("M2")) ||
        models[0];
      if (!m) return { modelPrefix: "", display: "无数据", color: "err" as const };
      const intervalRemaining = m.current_interval_remaining_percent ?? 0;
      const weeklyRemaining = m.current_weekly_remaining_percent ?? 0;
      const now = Date.now();
      const resets = [m.end_time, m.weekly_end_time].filter((t: any) => typeof t === "number" && t > now);
      const nearestReset = resets.length > 0 ? Math.min(...resets) : null;
      return {
        modelPrefix: "",
        display: formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, nearestReset),
        color: intervalRemaining < 20 || weeklyRemaining < 20 ? "err" as const : intervalRemaining < 50 || weeklyRemaining < 50 ? "warn" as const : "ok" as const,
      };
    },
  },
  {
    id: "glm",
    name: "GLM (智谱)",
    matchProviders: ["zhipu-cn", "zhipu", "glm", "bigmodel"],
    apiKeyEnv: "GLM_API_KEY",
    baseUrl: "https://open.bigmodel.cn",
    quotaPath: "/api/monitor/usage/quota/limit",
    authHeader: (key) => ({ Authorization: key }),
    fetchQuota: async (plan: TokenPlan, key: string) => {
      const r = await fetch(plan.baseUrl + plan.quotaPath, {
        method: "GET",
        headers: { ...plan.authHeader(key), "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error("GLM 配额查询 HTTP " + r.status);
      return await r.json();
    },
    format: (data: any) => {
      const limits = data?.data?.limits || [];
      const tokenLimits = limits.filter((x: any) => (x.type || "").toLowerCase() === "tokens_limit");
      if (tokenLimits.length === 0) return { modelPrefix: "", display: "无数据", color: "err" as const };
      let fiveHour = tokenLimits[0];
      let weekly = tokenLimits[1];
      if (fiveHour?.unit === 6) [fiveHour, weekly] = [weekly, fiveHour];
      const intervalRemaining = 100 - (fiveHour?.percentage ?? 0);
      const weeklyRemaining = 100 - (weekly?.percentage ?? 0);
      const now = Date.now();
      const resets = tokenLimits
        .map((x: any) => x.nextResetTime)
        .filter((t: any) => typeof t === "number" && t > now);
      const nearestReset = resets.length > 0 ? Math.min(...resets) : null;
      return {
        modelPrefix: "",
        display: formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, nearestReset),
        color: intervalRemaining < 20 || weeklyRemaining < 20 ? "err" as const : intervalRemaining < 50 || weeklyRemaining < 50 ? "warn" as const : "ok" as const,
      };
    },
  },
  {
    id: "kimi",
    name: "Kimi",
    matchProviders: ["moonshot-cn", "moonshot", "kimi"],
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.kimi.com",
    quotaPath: "/coding/v1/usages",
    authHeader: (key) => ({ Authorization: "Bearer " + key }),
    fetchQuota: async (plan: TokenPlan, key: string) => {
      const r = await fetch(plan.baseUrl + plan.quotaPath, {
        method: "GET",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error("Kimi 配额查询 HTTP " + r.status);
      return await r.json();
    },
    format: (data: any) => {
      const limits = data.limits || [];
      let intervalRemaining = 100;
      let nearestReset: number | null = null;
      if (limits.length > 0) {
        const d = limits[0].detail || {};
        const limit = d.limit || 1;
        const remaining = Math.max(d.remaining ?? 0, 0);
        intervalRemaining = (remaining / limit) * 100;
        const rt = d.resetTime;
        if (rt) {
          const ms = typeof rt === "string" ? new Date(rt).getTime() : rt;
          if (ms > Date.now()) nearestReset = ms;
        }
      }
      const usage = data.usage || {};
      let weeklyRemaining = 100;
      if (usage.limit) {
        const remaining = Math.max(usage.remaining ?? 0, 0);
        weeklyRemaining = (remaining / usage.limit) * 100;
        const rt = usage.resetTime;
        if (rt) {
          const ms = typeof rt === "string" ? new Date(rt).getTime() : rt;
          if (nearestReset === null || ms < nearestReset) nearestReset = ms;
        }
      }
      if (intervalRemaining >= 100 && weeklyRemaining >= 100) return { modelPrefix: "", display: "无数据", color: "err" as const };
      return {
        modelPrefix: "",
        display: formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, nearestReset),
        color: intervalRemaining < 20 || weeklyRemaining < 20 ? "err" as const : intervalRemaining < 50 || weeklyRemaining < 50 ? "warn" as const : "ok" as const,
      };
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    matchProviders: ["deepseek-cn", "deepseek"],
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    quotaPath: "/user/balance",
    authHeader: (key) => ({ Authorization: "Bearer " + key }),
    fetchQuota: async (plan: TokenPlan, key: string) => {
      const r = await fetch(plan.baseUrl + plan.quotaPath, {
        method: "GET",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error("DeepSeek 配额查询 HTTP " + r.status);
      return await r.json();
    },
    format: (data: any) => {
      const infos = data?.balance_infos || [];
      const cny = infos.find((x: any) => x.currency === "CNY") || infos[0];
      if (!cny) return { modelPrefix: "", display: "无数据", color: "err" as const };
      const total = parseFloat(cny.total_balance || "0");
      return {
        modelPrefix: "",
        display: "¥" + total.toFixed(1),
        color: total < 1 ? "warn" as const : "ok" as const,
      };
    },
  },
];

// ── 配置文件操作 ─────────────────────────────────────────

async function loadTokenConfig(): Promise<TokenConfig> {
  try {
    if (existsSync(TOKEN_CONFIG_FILE)) {
      const raw = await readFile(TOKEN_CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<TokenConfig>;
      return {
        ...DEFAULT_TOKEN_CONFIG,
        ...parsed,
        // search 深合并：旧配置无 search 字段时自动获得默认（开启 + deepseek 映射）
        search: { ...DEFAULT_TOKEN_CONFIG.search!, ...(parsed.search ?? {}) },
      };
    }
  } catch {}
  return {
    ...DEFAULT_TOKEN_CONFIG,
    search: { ...DEFAULT_TOKEN_CONFIG.search! },
  };
}

async function saveTokenConfig(cfg: TokenConfig) {
  await mkdir(TOKEN_CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

async function loadDisplayConfig(): Promise<DisplayConfig> {
  try {
    if (existsSync(DISPLAY_CONFIG_FILE)) {
      const raw = await readFile(DISPLAY_CONFIG_FILE, "utf-8");
      const saved = JSON.parse(raw) as DisplayConfig;
      // 与默认值合并，防止新增条目缺失
      const merged: DisplayConfig = {
        ...DEFAULT_DISPLAY_CONFIG,
        items: { ...DEFAULT_DISPLAY_CONFIG.items },
      };
      if (saved.items) {
        for (const key of Object.keys(merged.items) as DisplayKey[]) {
          if (typeof saved.items[key] === "boolean") merged.items[key] = saved.items[key];
        }
      }
      if (isContextStyle(saved.contextStyle)) merged.contextStyle = saved.contextStyle;
      if (isSpeedStyle(saved.speedStyle)) merged.speedStyle = saved.speedStyle;
      return merged;
    }
  } catch {}
  return { ...DEFAULT_DISPLAY_CONFIG, items: { ...DEFAULT_DISPLAY_CONFIG.items } };
}

function isContextStyle(v: unknown): v is ContextStyle {
  return typeof v === "string" && ["pct-window", "used-window", "pct", "used", "bar"].includes(v);
}
function isSpeedStyle(v: unknown): v is SpeedStyle {
  return typeof v === "string" && ["t/s", "tok/s", "T/s", "liveAt"].includes(v);
}

async function saveDisplayConfig(cfg: DisplayConfig) {
  await mkdir(TOKEN_CONFIG_DIR, { recursive: true });
  await writeFile(DISPLAY_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

// ── 缓存操作 ────────────────────────────────────────────

async function readQuotaCache(): Promise<QuotaCache> {
  try {
    if (existsSync(QUOTA_CACHE_FILE)) {
      const raw = await readFile(QUOTA_CACHE_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {}
  return {};
}

async function writeQuotaCache(cache: QuotaCache) {
  await ensureDir(LOGS_DIR);
  await writeFile(QUOTA_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

// ── 匹配逻辑 ───────────────────────────────────────────

function resolveActivePlan(provider?: string): TokenPlan | null {
  if (!tokenConfig) return null;
  const planId = provider ? (tokenConfig.providerPlans[provider] ?? null) : null;
  if (!planId) return null;
  return BUILTIN_PLANS.find(p => p.id === planId) || null;
}

function resolveApiKey(plan: TokenPlan, provider?: string): string | null {
  // 1. 环境变量优先
  if (plan.apiKeyEnv && process.env[plan.apiKeyEnv]) {
    return process.env[plan.apiKeyEnv]!;
  }
  // 2. 读取 pi 的 auth.json
  try {
    const authPath = join(homedir(), ".pi/agent/auth.json");
    if (existsSync(authPath)) {
      const raw = readFileSync(authPath, "utf-8");
      const auth = JSON.parse(raw);
      // 2a. 优先取「当前 provider」自己的 key：
      //     避免 provider 映射到套餐后盗用套餐原生 provider 的 key（如
      //     opencode-go 映射 deepseek 套餐时误用 deepseek 官方 key 查余额）。
      if (provider && auth[provider]?.key) return auth[provider].key;
      // 2b. 回退：套餐原生 provider 的 key
      for (const providerId of plan.matchProviders) {
        const entry = auth[providerId];
        if (entry?.key) return entry.key;
      }
    }
  } catch {}
  return null;
}

// ── 联网搜索（内嵌 deepseek-server，见 search.ts）────────

/** 当前应激活的搜索后端 id（由 syncSearchTool 计算，供 execute 守卫读取） */
let activeSearchBackendId: string | null = null;

const SEARCH_BACKENDS: SearchBackend[] = [
  createDeepseekBackend({
    resolveApiKey: () =>
      resolveApiKey(BUILTIN_PLANS.find((p) => p.id === "deepseek")!),
    isActive: () => activeSearchBackendId === "deepseek-server",
  }),
];

/**
 * 根据配置 + 当前 provider 的套餐，同步 web_search 工具注册状态。
 * 规则（套餐驱动）：search.enabled=false 或 backends[plan.id] 未命中 → 不启用；
 * 未命中时若已注册完整实现则覆盖为禁用空壳（pi 无注销 API，同名注册即覆盖）。
 */
function syncSearchTool(pi: ExtensionAPI, provider: string | null | undefined) {
  const searchCfg = tokenConfig?.search ?? DEFAULT_TOKEN_CONFIG.search!;
  let targetId: string | null = null;
  if (searchCfg.enabled) {
    const plan = resolveActivePlan(provider ?? undefined);
    if (plan) {
      const backendId = searchCfg.backends[plan.id];
      if (backendId && SEARCH_BACKENDS.some((b) => b.id === backendId)) {
        targetId = backendId;
      }
    }
  }
  for (const backend of SEARCH_BACKENDS) {
    if (backend.id === targetId) {
      backend.enable(pi);
      activeSearchBackendId = backend.id;
    } else {
      backend.disable(pi);
      if (activeSearchBackendId === backend.id) activeSearchBackendId = null;
    }
  }
}

/**
 * 检测并处理 provider 变化。
 * 返回 true 表示发生了切换（供调用者决定是否要 force refresh）。
 */
function detectAndHandleProviderChange(ctx: ExtensionContext): boolean {
  const curProvider = ctx.model?.provider ?? null;
  if (!curProvider) {
    // provider 缺失（P11）：清空 quotaState，不刷新
    if (quotaState) quotaState = null;
    lastQuotaProvider = null;
    return false;
  }
  if (curProvider === lastQuotaProvider) return false;
  // 切换发生：先记录新 provider，再清旧 state
  lastQuotaProvider = curProvider;
  quotaState = null;
  return true;
}

function buildErrorState(
  provider: string,
  planId: string,
  error: QuotaError,
): QuotaDisplayState {
  let display = "无数据";
  if (error.kind === "key_missing") {
    display = `❌ ${error.envVar} 未设置`;
  } else if (error.kind === "api_error") {
    display = `❌ ${truncateText(error.message, 24)}`;
  } else if (error.kind === "network_error") {
    display = `❌ 网络/超时`;
  } else if (error.kind === "no_data") {
    display = "无数据";
  } else if (error.kind === "no_plan") {
    display = "未启用";
  }
  return {
    planId,
    provider,
    display,
    modelPrefix: "",
    color: "err",
    error,
    fetchedAt: Date.now(),
  };
}

function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * 把 quotaState.error 格式化为人类可读提示。
 */
function formatQuotaError(state: QuotaDisplayState | null | undefined): string {
  if (!state || !state.error) return "未知错误";
  const e = state.error;
  switch (e.kind) {
    case "no_plan":
      return "该 provider 未配置套餐";
    case "key_missing":
      return `未设置环境变量 ${e.envVar} 或 ~/.pi/agent/auth.json 中 ${e.provider} 的 key 字段`;
    case "api_error":
      return `API 返回错误: ${e.message}`;
    case "network_error":
      return `网络/超时: ${e.message}`;
    case "no_data":
      return "接口返回无数据";
  }
}

/**
 * 刷新套餐用量。
 * force=true 时绕过缓存（用于 provider 切换 / 手动刷新 / session_start）。
 */
async function refreshQuota(ctx: ExtensionContext, force = false): Promise<void> {
  // 1. 先检测 provider 变化（可能清空 quotaState）
  detectAndHandleProviderChange(ctx);

  const curProvider = ctx.model?.provider;
  if (!curProvider) return; // provider 缺失：不显示

  // 2. 解析 plan
  const plan = resolveActivePlan(curProvider);
  if (!plan) {
    // 用户没启用套餐：静默隐藏该段（恢复 1.1.0 行为，避免"❌ 未启用"打扰）
    // 其它错误（key 缺失 / API 错误 / 网络错误 / 无数据）仍会显示具体原因
    quotaState = null;
    return;
  }

  // 3. 解析 key
  const key = resolveApiKey(plan, curProvider);
  if (!key) {
    quotaState = buildErrorState(curProvider, plan.id, {
      kind: "key_missing",
      envVar: plan.apiKeyEnv || "API_KEY",
      provider: curProvider,
    });
    return;
  }

  // 4. 读缓存（force 时跳过）
  const cache = await readQuotaCache();
  const cached = cache[plan.id];
  const ttlMs = (tokenConfig?.ttl || 60) * 1000;
  if (!force && cached && (Date.now() - cached.fetchedAt) < cached.ttl) {
    const fmt = plan.format(cached.data);
    quotaState = {
      planId: plan.id,
      provider: curProvider,
      display: fmt.display,
      modelPrefix: fmt.modelPrefix,
      color: fmt.color,
      fetchedAt: cached.fetchedAt,
    };
    return;
  }

  // 5. 调接口
  try {
    const data = await plan.fetchQuota(plan, key);
    cache[plan.id] = { fetchedAt: Date.now(), ttl: ttlMs, data };
    await writeQuotaCache(cache);
    const fmt = plan.format(data);
    // format 可能返回 "无数据" 颜色为 err
    if (fmt.color === "err" && fmt.display === "无数据") {
      quotaState = buildErrorState(curProvider, plan.id, { kind: "no_data" });
      quotaState.display = fmt.display;
      quotaState.modelPrefix = fmt.modelPrefix;
      return;
    }
    quotaState = {
      planId: plan.id,
      provider: curProvider,
      display: fmt.display,
      modelPrefix: fmt.modelPrefix,
      color: fmt.color,
      fetchedAt: Date.now(),
    };
  } catch (e: any) {
    // 区分网络错误与 API 业务错误
    const msg = e?.message || String(e);
    const isNetwork = /timeout|abort|fetch failed|network|econnreset|enotfound/i.test(msg);
    quotaState = buildErrorState(curProvider, plan.id, isNetwork
      ? { kind: "network_error", message: msg }
      : { kind: "api_error", message: msg },
    );
  }
}

async function forceRefreshQuota(ctx: ExtensionContext) {
  await refreshQuota(ctx, true);
  requestFooterRender?.();
}

/** 清空所有套餐缓存（session_start 调，避免 P7） */
async function invalidateAllQuotaCache() {
  try {
    if (existsSync(QUOTA_CACHE_FILE)) {
      await writeFile(QUOTA_CACHE_FILE, "{}", "utf-8");
    }
  } catch { /* ignore */ }
}

// ── /stats 命令 ──────────────────────────────────────────

function weightedCacheHitRate(d: { sumInput: number; sumCacheRead: number; sumCacheWrite: number }): number {
  const total = d.sumInput + d.sumCacheRead + d.sumCacheWrite;
  return total > 0 ? (d.sumCacheRead / total) * 100 : 0;
}

function renderDaySummary(daily: DailyRecord): string {
  const d = daily;
  const avgInput = d.count > 0 ? d.sumInput / d.count : 0;
  const avgOutput = d.count > 0 ? d.sumOutput / d.count : 0;
  const totalPrompt = d.sumInput + d.sumCacheRead + d.sumCacheWrite;
  const cacheHitRate = weightedCacheHitRate(d);

  const lines = [
    `对话次数:  ${d.count}`,
    `新增输入:  ${formatTokens(d.sumInput)}  (平均 ${formatTokens(avgInput)}/次，未命中缓存)`,
    `缓存输入:  ${formatTokens(d.sumCacheRead)}`,
    `总输出:    ${formatTokens(d.sumOutput)}  (平均 ${formatTokens(avgOutput)}/次)`,
    `总token:   ${formatTokens(totalPrompt)}  (新增 + 缓存)`,
    `缓存命中率: ${cacheHitRate.toFixed(1)}%`,
    `平均速率:  ${(d.sumTokensPerSec / d.count).toFixed(1)} t/s`,
  ];
  return lines.join("\n");
}

async function showStats(
  lines: string[],
  title: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) {
  const theme = ctx.ui.theme;
  const text = `${theme.fg("accent", theme.bold(title))}\n${theme.fg("dim", "─".repeat(42))}\n` +
    lines.map((l) => theme.fg("dim", l)).join("\n");
  pi.sendMessage({
    customType: "token-stats",
    content: text,
    display: true,
    details: {},
  });
}

async function showDay(date: string, ctx: ExtensionContext, pi: ExtensionAPI) {
  let records: DailyRecord[] = [];
  try {
    records = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    // nothing
  }
  const daily = records.find((r) => r.date === date) || null;

  if (!daily) {
    ctx.ui.notify(`${date} 暂无统计数据`, "info");
    return;
  }

  await showStats(
    renderDaySummary(daily).split("\n"),
    `Token 统计  |  ${date}`,
    ctx,
    pi,
  );
}

async function showHourly(date: string, ctx: ExtensionContext, pi: ExtensionAPI) {
  const file = join(HOURLY_DIR, `${date}.jsonl`);
  let records: HourlyRecord[] = [];
  try {
    records = (await readFile(file, "utf-8")).trim().split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    // nothing
  }

  if (records.length === 0) {
    ctx.ui.notify(`${date} 暂无按小时统计`, "info");
    return;
  }

  records.sort((a, b) => a.hour - b.hour);

  const lines = [
    "时  次数  输入      输出      命中率  速率",
    "─".repeat(40),
    ...records.map((r) =>
      `${String(r.hour).padStart(2, "0")}  ` +
      `${String(r.count).padStart(3)}  ` +
      `${formatTokens(r.sumInput).padStart(7)}  ` +
      `${formatTokens(r.sumOutput).padStart(7)}  ` +
      `${weightedCacheHitRate(r).toFixed(1).padStart(5)}%  ` +
      `${(r.sumTokensPerSec / r.count).toFixed(1).padStart(5)}`,
    ),
  ];

  await showStats(lines, `按小时分布  |  ${date}`, ctx, pi);
}

async function showWeek(ctx: ExtensionContext, pi: ExtensionAPI) {
  let records: DailyRecord[] = [];
  try {
    records = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    // nothing
  }

  // 最近 7 天
  const today = getDateStr();
  const sevenDaysAgo = getDateStr(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  );
  const weekRecords = records
    .filter((r) => r.date >= sevenDaysAgo && r.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (weekRecords.length === 0) {
    ctx.ui.notify("本周暂无统计数据", "info");
    return;
  }

  const lines = [
    "日期        次数  新增输入  缓存输入  输出      总token   命中率  速率",
    "─".repeat(70),
    ...weekRecords.map((r) => {
      const totalPrompt = r.sumInput + r.sumCacheRead + r.sumCacheWrite;
      return (
        `${r.date}  ` +
        `${String(r.count).padStart(3)}  ` +
        `${formatTokens(r.sumInput).padStart(7)}  ` +
        `${formatTokens(r.sumCacheRead).padStart(7)}  ` +
        `${formatTokens(r.sumOutput).padStart(7)}  ` +
        `${formatTokens(totalPrompt).padStart(7)}  ` +
        `${weightedCacheHitRate(r).toFixed(1).padStart(5)}%  ` +
        `${(r.sumTokensPerSec / r.count).toFixed(1).padStart(5)}`
      );
    }),
  ];

  await showStats(lines, "本周每天汇总", ctx, pi);
}

function getMonthStr(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function showMonth(month: string, ctx: ExtensionContext, pi: ExtensionAPI) {
  let records: DailyRecord[] = [];
  try {
    records = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    // nothing
  }

  const monthRecords = records
    .filter((r) => r.date.startsWith(month))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (monthRecords.length === 0) {
    ctx.ui.notify(`${month} 暂无统计数据`, "info");
    return;
  }

  // 累计
  const total = monthRecords.reduce(
    (acc, r) => {
      acc.count += r.count;
      acc.sumInput += r.sumInput;
      acc.sumCacheRead += r.sumCacheRead;
      acc.sumCacheWrite += r.sumCacheWrite;
      acc.sumOutput += r.sumOutput;
      acc.sumTokensPerSec += r.sumTokensPerSec;
      return acc;
    },
    { count: 0, sumInput: 0, sumCacheRead: 0, sumCacheWrite: 0, sumOutput: 0, sumTokensPerSec: 0 },
  );
  const totalPrompt = total.sumInput + total.sumCacheRead + total.sumCacheWrite;
  const cacheHitRate = weightedCacheHitRate(total);

  const lines = [
    "日期        次数  新增输入  缓存输入  输出      总token   命中率  速率",
    "─".repeat(70),
    ...monthRecords.map((r) => {
      const tp = r.sumInput + r.sumCacheRead + r.sumCacheWrite;
      return (
        `${r.date}  ` +
        `${String(r.count).padStart(3)}  ` +
        `${formatTokens(r.sumInput).padStart(7)}  ` +
        `${formatTokens(r.sumCacheRead).padStart(7)}  ` +
        `${formatTokens(r.sumOutput).padStart(7)}  ` +
        `${formatTokens(tp).padStart(7)}  ` +
        `${weightedCacheHitRate(r).toFixed(1).padStart(5)}%  ` +
        `${(r.sumTokensPerSec / r.count).toFixed(1).padStart(5)}`
      );
    }),
    "",
    `合计      ${String(total.count).padStart(3)}  ` +
    `${formatTokens(total.sumInput).padStart(7)}  ` +
    `${formatTokens(total.sumCacheRead).padStart(7)}  ` +
    `${formatTokens(total.sumOutput).padStart(7)}  ` +
    `${formatTokens(totalPrompt).padStart(7)}  ` +
    `${cacheHitRate.toFixed(1).padStart(5)}%  ` +
    `${(total.sumTokensPerSec / total.count).toFixed(1).padStart(5)}`,
  ];

  await showStats(lines, `${month} 月度汇总`, ctx, pi);
}

// ── 扩展入口 ─────────────────────────────────────────────

export default function tokenStatsExtension(pi: ExtensionAPI) {
  // ── message renderer: 渲染 /stats 发出的消息 ─────────
  pi.registerMessageRenderer("token-stats", (message, _options, _theme) => {
    return new Text(message.content, 0, 0);
  });

  // ── turn_start: 记录时间 + 检测供应商切换 ──────────

  pi.on("turn_start", async (_event, ctx) => {
    stats.turnStartTime = Date.now();
    stats.firstTokenTime = 0;
    stats.streaming = false;

    // P1 修复：turn_start 也能触发 provider 变化检测；切换时 force refresh
    if (ctx.model?.provider !== lastQuotaProvider) {
      lastQuotaProvider = ctx.model?.provider ?? null;
      quotaState = null; // 跨 provider 立即清旧 state
      await refreshQuota(ctx, true); // force 绕过缓存
      // 搜索后端跟随套餐：provider 切换时同步注册状态
      syncSearchTool(pi, ctx.model?.provider);
      requestFooterRender?.();
    }

    requestFooterRender?.();
  });

  // ── message_update: 流式实时估算 + rolling window ────

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const content = event.message.content;
    if (!Array.isArray(content)) return;

    const streamEvent = (event as any).assistantMessageEvent;
    if (
      streamEvent?.type !== "text_delta" &&
      streamEvent?.type !== "thinking_delta" &&
      streamEvent?.type !== "toolcall_delta"
    ) {
      // 非 delta 事件仍需要更新部分状态
      if (stats.firstTokenTime === 0) stats.firstTokenTime = Date.now();
      stats.streaming = true;
      return;
    }

    // 记录首个 token 到达时间
    if (stats.firstTokenTime === 0) stats.firstTokenTime = Date.now();
    stats.streaming = true;

    const nowMs = Date.now();
    stats.liveOutputChars += streamEvent.delta.length;

    // 优先使用 pi 框架返回的 partial usage
    const usageOutputTokens = streamEvent.partial?.usage?.output;
    let newTokens = 0;
    if (
      typeof usageOutputTokens === "number" &&
      usageOutputTokens > stats.liveUsageOutputTokens
    ) {
      newTokens = usageOutputTokens - stats.liveUsageOutputTokens;
      stats.liveUsageOutputTokens = usageOutputTokens;
      stats.liveEstimatedTokens = usageOutputTokens;
    } else if (stats.liveUsageOutputTokens <= 0) {
      // 回退到字符估算
      const estimated = estimateTokens(stats.liveOutputChars);
      newTokens = Math.max(0, estimated - stats.liveEstimatedTokens);
      stats.liveEstimatedTokens = estimated;
    }

    if (newTokens > 0) {
      stats.liveTokenSamples.push({ timestampMs: nowMs, tokens: newTokens });
    }

    requestFooterRender?.();
  });

  // ── message_end: 精确统计 + 持久化 ──────────────────

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const assistantMsg = event.message as AssistantMessage;
    const usage = assistantMsg.usage;
    if (!usage) return;

    // 去重：使用 responseId 防止 message_end + turn_end 重复累加
    const usageKey = assistantMsg.responseId ||
      `${assistantMsg.timestamp}:${assistantMsg.provider}:${assistantMsg.model}:${usage.input}:${usage.output}`;
    if (stats.accountedUsageKeys.has(usageKey)) return;
    stats.accountedUsageKeys.add(usageKey);

    // 流总耗时（秒）
    const totalElapsed =
      stats.turnStartTime > 0
        ? (Date.now() - stats.turnStartTime) / 1000
        : 0;
    // 过滤异常：< 50ms 视为不可信
    const tokensPerSec =
      totalElapsed >= 0.05 ? usage.output / totalElapsed : 0;
    // rolling window 速率（优先于平均速率）
    const liveSpeed = getRollingLiveTokenSpeed();
    // 首 token 延迟（毫秒）
    const firstTokenLatency =
      stats.firstTokenTime > 0 && stats.turnStartTime > 0
        ? stats.firstTokenTime - stats.turnStartTime
        : 0;
    // 词数
    const wordCount = countWords(
      extractTextContent(event.message.content),
    );
    // 缓存命中率（pi 内置公式）
    const promptTokens =
      usage.input + usage.cacheRead + usage.cacheWrite;
    const cacheHitRate =
      promptTokens > 0
        ? (usage.cacheRead / promptTokens) * 100
        : 0;
    // 花费
    const cost = usage.cost?.total ?? 0;

    // 更新本轮精确值
    stats.lastInput = usage.input;
    stats.lastOutput = usage.output;
    stats.lastCacheRead = usage.cacheRead;
    stats.lastCacheWrite = usage.cacheWrite;
    stats.lastCost = cost;
    stats.lastCacheHitRate = cacheHitRate;
    stats.lastTokensPerSec = tokensPerSec;
    stats.lastLiveTokenSpeed = liveSpeed;
    stats.lastFirstTokenLatency = firstTokenLatency;
    stats.lastWordCount = wordCount;
    stats.streaming = false;

    // 累加到会话
    stats.totalInput += usage.input;
    stats.totalOutput += usage.output;
    stats.totalCacheRead += usage.cacheRead;
    stats.totalCacheWrite += usage.cacheWrite;
    stats.totalCost += cost;
    stats.totalCacheHitRateSum += cacheHitRate;
    stats.turnCount++;

    requestFooterRender?.();

    // 持久化
    const sessionId =
      ctx.sessionManager.getSessionId?.() ?? "unknown";
    const model = `${event.message.provider}/${event.message.model}`;
    await persistTurn({
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      tokensPerSec,
      cacheHitRate,
      model,
      firstTokenLatency,
      wordCount,
      cost,
      liveTokenSpeed: liveSpeed,
    }, sessionId);

    // 重置 live 状态
    resetLiveState();
  });

  // ── agent_end: 整个对话结束，确保最终状态刷新 ────────

  pi.on("agent_end", async (_event, ctx) => {
    stats.streaming = false;
    resetLiveState();
    requestFooterRender?.();
  });

  // ── session_shutdown: 清理跨 session 资源（定时器 / footer 引用）───────

  pi.on("session_shutdown", async (_event, _ctx) => {
    // session 替换（/new /resume /fork）或 /reload 时旧 ctx 会失效，
    // 必须在此清掉旧实例的定时器与闭包引用，否则定时器回调访问旧 ctx
    // 会抛 "extension ctx is stale" 导致 pi 崩溃退出。
    // 注意：reload 会重新执行本文件（全新实例、quotaTimerId 为 null），
    // 所以只有这里能清掉旧实例的定时器，不能依赖 session_start 里的清理。
    sessionActive = false;
    if (quotaTimerId) {
      clearInterval(quotaTimerId);
      quotaTimerId = null;
    }
    requestFooterRender = null;
    lastQuotaProvider = null;
    quotaState = null;
    activeSearchBackendId = null;
  });

  // ── session_start: 恢复累计状态 + 注册 footer ───────

  pi.on("session_start", async (_event, ctx) => {
    sessionActive = true;
    rebuildFromHistory(ctx);

    // 套餐用量：加载配置 + 定时刷新
    tokenConfig = await loadTokenConfig();
    displayConfig = await loadDisplayConfig();
    // 联网搜索：按配置 + 当前套餐注册 web_search（默认开启）
    syncSearchTool(pi, ctx.model?.provider);
    lastQuotaProvider = null; // 强制让 refreshQuota 检测一次
    quotaState = null;
    // P7 修复：清空所有 plan 的缓存（避免跨 session 复用旧数据）
    await invalidateAllQuotaCache();
    if (quotaTimerId) clearInterval(quotaTimerId);
    // 第一次强制刷新（绕缓存）
    await refreshQuota(ctx, true);
    requestFooterRender?.();
    quotaTimerId = setInterval(async () => {
      if (!sessionActive) return;
      try {
        // 定时器也先检测 provider 变化；变化则 force refresh
        if (ctx.model?.provider !== lastQuotaProvider) {
          await refreshQuota(ctx, true);
        } else {
          await refreshQuota(ctx, false);
        }
      } catch { /* ctx 已失效（session 被替换），忽略本次刷新 */ }
      requestFooterRender?.();
    }, (tokenConfig?.ttl || 60) * 1000);


    ctx.ui.setFooter((tui, theme, footerData) => {
      const render = () => tui.requestRender();
      requestFooterRender = render;
      const unsub = footerData.onBranchChange(render);

      return {
        dispose() {
          unsub();
          if (requestFooterRender === render) requestFooterRender = null;
        },
        invalidate() {},
        render(width: number): string[] {
          // session 替换后旧 footer 可能仍被 TUI 渲染，此时 ctx 已失效，直接返回空
          if (!sessionActive) return [];
          // ── 上行：指标左对齐，模型名右对齐 ──────────
          const metrics = buildMetricParts(theme, ctx);
          const left = metrics.join(" | ");

          const modelName = ctx.model?.id || "";
          const provider = ctx.model?.provider || "";
          const rightSide = provider ? `(${provider}) ${modelName}` : modelName;

          const leftWidth = visibleWidth(left);
          const rightWidth = visibleWidth(rightSide);
          const topLine = leftWidth + rightWidth <= width
            ? left + " ".repeat(width - leftWidth - rightWidth) + rightSide
            : leftWidth <= width
              ? left + " ".repeat(width - leftWidth) + truncateToWidth(rightSide, Math.max(0, width - leftWidth), "")
              : truncateToWidth(left, width);

          // ── 下行：cwd + git 分支 + 其他扩展状态 ────
          const cwd = formatUserPath(ctx.cwd || "");
          const branch = footerData.getGitBranch();
          const cwdPart = branch ? `${cwd} (${branch})` : cwd;

          const statuses = footerData.getExtensionStatuses();
          const otherStatuses = Array.from(statuses.entries())
            .filter(([k]) => k !== "token-stats-webui")
            .map(([, v]) => v as string);

          const bottomParts: string[] = [theme.fg("dim", cwdPart)];
          if (otherStatuses.length > 0) {
            bottomParts.push(theme.fg("dim", "│"));
            bottomParts.push(...otherStatuses);
          }

          return [
            truncateToWidth(topLine, width),
            truncateToWidth(bottomParts.join(" "), width),
          ];
        },
      };
    });
  });

  // ── /stats 命令 ─────────────────────────────────────

  pi.registerCommand("stats", {
    description: "Token 统计 (day | hour | week | month | config)  无参默认进入套餐配置",
    handler: async (args, ctx) => {
      const arg = args.trim();

      // 无参 → 套餐配置
      if (!arg) {
        const provider = ctx.model?.provider;
        if (!provider) {
          ctx.ui.notify("无法获取当前供应商，请先切换对话", "warning");
          return;
        }
        // 套餐用量选择菜单
        const options = ["关闭", ...BUILTIN_PLANS.map(p => p.name)];
        const choice = await ctx.ui.select(
          "选择 " + provider + " 要显示配额的套餐（选中后退出）",
          options,
        );

        const defaults: TokenConfig = {
          providerPlans: {},
          ttl: 60,
          search: { ...DEFAULT_TOKEN_CONFIG.search! },
        };

        if (!choice || choice === "关闭") {
          tokenConfig = tokenConfig
            ? { ...tokenConfig, providerPlans: { ...tokenConfig.providerPlans, [provider]: null } }
            : { ...defaults, providerPlans: { [provider]: null } };
          await saveTokenConfig(tokenConfig);
          // 搜索跟随套餐：关闭套餐时同步注销搜索工具
          syncSearchTool(pi, provider);
          lastQuotaProvider = provider;
          quotaState = null;
          if (quotaTimerId) clearInterval(quotaTimerId);
          quotaTimerId = setInterval(async () => {
            if (!sessionActive) return;
            try {
              await refreshQuota(ctx);
            } catch { /* ctx 已失效（session 被替换），忽略 */ }
            requestFooterRender?.();
          }, (tokenConfig?.ttl || 60) * 1000);
          requestFooterRender?.();
          ctx.ui.notify(provider + " 的套餐用量已关闭", "info");
          return;
        }
        const plan = BUILTIN_PLANS.find(p => p.name === choice);
        if (plan) {
          tokenConfig = tokenConfig
            ? { ...tokenConfig, providerPlans: { ...tokenConfig.providerPlans, [provider]: plan.id } }
            : { ...defaults, providerPlans: { [provider]: plan.id } };
          await saveTokenConfig(tokenConfig);
          lastQuotaProvider = provider;
          // 立即查询
          await forceRefreshQuota(ctx);
          // 搜索跟随套餐：选择 deepseek 等带搜索后端的套餐时同步注册
          syncSearchTool(pi, provider);
          if (quotaTimerId) clearInterval(quotaTimerId);
          quotaTimerId = setInterval(async () => {
            if (!sessionActive) return;
            try {
              await refreshQuota(ctx);
            } catch { /* ctx 已失效（session 被替换），忽略 */ }
            requestFooterRender?.();
          }, (tokenConfig?.ttl || 60) * 1000);
          if (quotaState?.error) {
            // 仅当 quotaState 带有 error 字段时（key 缺失 / API 错误 / 网络错误 / 无数据）才提示"查询失败"
            // 不能用 color === "err" 判断，因为 5h 剩余 < 20% 的正常状态也会用 err 颜色（仅用于 footer 高亮）
            const errMsg = formatQuotaError(quotaState);
            ctx.ui.notify(`${plan.name} 配额查询失败：${errMsg}`, "info");
          } else {
            ctx.ui.notify(plan.name + " 配额已启用", "info");
          }
        }
        return;
      }

      if (arg === "config") {
        const subChoice = await ctx.ui.select("配置", [
          "显示样式",
          "显示内容",
          "刷新时间  (当前 " + (tokenConfig?.ttl || 60) + "s)",
          "🔍 联网搜索",
        ]);
        if (!subChoice) return;

        if (subChoice === "显示样式") {
          const catChoice = await ctx.ui.select("选择要配置的样式类别", [
            "🧠 上下文样式",
            "⚡ 速率样式",
          ]);
          if (!catChoice) return;

          if (catChoice === "🧠 上下文样式") {
            const items: { label: string; value: ContextStyle; preview: string }[] = [
              { label: "pct-window", value: "pct-window", preview: `🧠 5.3%/1.0M` },
              { label: "used-window", value: "used-window", preview: `🧠 256k/1.0M` },
              { label: "pct", value: "pct", preview: `🧠 5.3%` },
              { label: "used", value: "used", preview: `🧠 256k` },
              { label: "bar", value: "bar", preview: `🧠 [██░░░░░░] 25%` },
            ];
            const choice = await ctx.ui.select(
              "🧠 上下文样式（当前: " + displayConfig.contextStyle + "）",
              items.map(i =>
                (displayConfig.contextStyle === i.value ? "● " : "○ ") + i.label + "  " + i.preview
              ),
            );
            if (choice) {
              const idx = items.findIndex(i =>
                (displayConfig.contextStyle === i.value ? "● " : "○ ") + i.label + "  " + i.preview === choice
              );
              if (idx >= 0) {
                displayConfig = { ...displayConfig, contextStyle: items[idx].value };
                await saveDisplayConfig(displayConfig);
                requestFooterRender?.();
              }
            }
          } else {
            const items: { label: string; value: SpeedStyle; preview: string }[] = [
              { label: "t/s", value: "t/s", preview: `⚡77.7 t/s` },
              { label: "tok/s", value: "tok/s", preview: `⚡77.7 tok/s` },
              { label: "T/s", value: "T/s", preview: `⚡77.7 T/s` },
              { label: "live@速率", value: "liveAt", preview: `⚡1.2k@77.7` },
            ];
            const choice = await ctx.ui.select(
              "⚡ 速率样式（当前: " + displayConfig.speedStyle + "）",
              items.map(i =>
                (displayConfig.speedStyle === i.value ? "● " : "○ ") + i.label + "  " + i.preview
              ),
            );
            if (choice) {
              const idx = items.findIndex(i =>
                (displayConfig.speedStyle === i.value ? "● " : "○ ") + i.label + "  " + i.preview === choice
              );
              if (idx >= 0) {
                displayConfig = { ...displayConfig, speedStyle: items[idx].value };
                await saveDisplayConfig(displayConfig);
                requestFooterRender?.();
              }
            }
          }
          ctx.ui.notify("显示样式已保存", "info");
        } else if (subChoice === "显示内容") {
          const itemLabels: DisplayKey[] = [
            "input", "output", "totalTokens", "cacheHit", "speed", "context",
            "quota5h", "quotaWeek", "quotaClock",
          ];
          const itemNames: Record<DisplayKey, string> = {
            input: "输入", output: "输出", totalTokens: "总token",
            cacheHit: "缓存命中", speed: "速度", context: "容量",
            quota5h: "5h额度", quotaWeek: "周额度", quotaClock: "刷新时间",
          };
          while (true) {
            const options = itemLabels.map(k =>
              `${displayConfig.items[k] ? "✅" : "⬜"} ${itemNames[k]}`,
            );
            options.push("🔙 完成");
            const choice = await ctx.ui.select("选择要切换显示的项目", options);
            if (!choice || choice === "🔙 完成") break;
            const idx = options.indexOf(choice);
            if (idx >= 0 && idx < itemLabels.length) {
              const key = itemLabels[idx];
              displayConfig = {
                ...displayConfig,
                items: { ...displayConfig.items, [key]: !displayConfig.items[key] },
              };
              await saveDisplayConfig(displayConfig);
              requestFooterRender?.();
            }
          }
          ctx.ui.notify("状态栏显示配置已保存", "info");
        } else if (subChoice === "刷新时间  (当前 " + (tokenConfig?.ttl || 60) + "s)") {
          const input = await ctx.ui.input("输入刷新间隔（秒）", String(tokenConfig?.ttl || 60));
          if (input) {
            const sec = parseInt(input, 10);
            if (Number.isNaN(sec) || sec < 10) {
              ctx.ui.notify("刷新时间必须 >= 10 秒", "warning");
            } else {
              tokenConfig = tokenConfig
                ? { ...tokenConfig, ttl: sec }
                : { providerPlans: {}, ttl: sec };
              await saveTokenConfig(tokenConfig);
              // 重设定时器
              if (quotaTimerId) clearInterval(quotaTimerId);
              quotaTimerId = setInterval(async () => {
                if (!sessionActive) return;
                try {
                  await refreshQuota(ctx);
                } catch { /* ctx 已失效（session 被替换），忽略 */ }
                requestFooterRender?.();
              }, sec * 1000);
              ctx.ui.notify("刷新时间已设为 " + sec + " 秒", "info");
            }
          }
        } else if (subChoice === "🔍 联网搜索") {
          const searchCfg = (tokenConfig ?? DEFAULT_TOKEN_CONFIG).search!;
          const plan = resolveActivePlan(ctx.model?.provider);
          const backendId = searchCfg.enabled && plan
            ? searchCfg.backends[plan.id]
            : null;
          const backendName = backendId
            ? (SEARCH_BACKENDS.find((b) => b.id === backendId)?.name ?? backendId)
            : "无（该套餐暂无搜索后端）";
          const planName = plan ? `${plan.id} (${plan.name})` : "未配置套餐";
          ctx.ui.notify(`当前套餐: ${planName} | 搜索后端: ${backendName}`, "info");
          const toggleLabel = (searchCfg.enabled ? "✅" : "⬜") + " 启用联网搜索";
          const choice = await ctx.ui.select("🔍 联网搜索", [
            toggleLabel,
            "🔙 返回",
          ]);
          if (choice === toggleLabel) {
            const next = !searchCfg.enabled;
            tokenConfig = {
              ...(tokenConfig ?? DEFAULT_TOKEN_CONFIG),
              search: { ...searchCfg, enabled: next },
            };
            await saveTokenConfig(tokenConfig);
            syncSearchTool(pi, ctx.model?.provider);
            requestFooterRender?.();
            ctx.ui.notify(next ? "联网搜索已开启" : "联网搜索已关闭", "info");
          }
        }
        return;
      }

      if (arg === "today" || arg === "day") {
        await showDay(getDateStr(), ctx, pi);
      } else if (arg.startsWith("day ")) {
        const date = arg.slice(4).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          await showDay(date, ctx, pi);
        } else {
          ctx.ui.notify("用法: /stats day YYYY-MM-DD", "warning");
        }
      } else if (arg === "hour") {
        await showHourly(getDateStr(), ctx, pi);
      } else if (arg.startsWith("hour ")) {
        const date = arg.slice(5).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          await showHourly(date, ctx, pi);
        } else {
          ctx.ui.notify("用法: /stats hour YYYY-MM-DD", "warning");
        }
      } else if (arg === "week") {
        await showWeek(ctx, pi);
      } else if (arg === "month") {
        await showMonth(getMonthStr(), ctx, pi);
      } else if (arg.startsWith("month ")) {
        const ms = arg.slice(6).trim();
        if (/^\d{4}-\d{2}$/.test(ms)) {
          await showMonth(ms, ctx, pi);
        } else {
          ctx.ui.notify("用法: /stats month YYYY-MM", "warning");
        }
      } else {
        ctx.ui.notify(
          "用法: /stats [day [date] | hour [date] | week | month [YYYY-MM] | config]",
          "warning",
        );
      }
    },
  });
}
