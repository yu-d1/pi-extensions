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
// 日统计 / 小时统计 / 周统计 / 月统计 / 年度按月统计
//
// 安装：pi install npm:@liziy/token-stats

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Input, Key, Text, fuzzyFilter, matchesKey, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { BUILTIN_PLANS, bindMimoFeedback, checkLoginPlanPrereq, mimoLog, resetMimoLoginBackoff } from "./plans";
import type { PlanFormatContext, QuotaStyle, TokenPlan } from "./plans";
import type { TokenPrecision } from "./format";
import { formatAmount, formatDuration, formatLatency, formatPercent, formatSpeed, formatTokens } from "./format";
export type { QuotaStyle } from "./plans";

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
interface TokenConfig {
  providerPlans: Record<string, string | null>;
  ttl: number;
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
  | "output"      // 输出（累计输出数 ↓）
  | "cost"        // 会话花费（$）
  | "input"       // 输入（累计输入数 ↑）
  | "totalTokens" // 总token（累计输入+输出）
  | "cacheHit"    // 缓存命中率
  | "speed"       // 速度（tok/s）
  | "latency"     // 首 token 延迟（TTFT）
  | "context"     // 容量（🧠 ctx%）
  | "quota"       // 套餐余量（样式由 quotaStyle 决定）
  | "thinking"    // 思考强度（TH）
  | "elapsed";    // 会话时长（T+）

/** 数值精度（各部分独立设置，互不影响） */
export interface PrecisionConfig {
  contextPercent: 0 | 1 | 2;
  cacheHitPercent: 0 | 1 | 2;
  quotaPercent: 0 | 1 | 2;
  token: TokenPrecision;
  speed: 0 | 1 | 2;
  costAmount: 1 | 2;
  balanceAmount: 1 | 2;
}

export interface DisplayConfig {
  items: Record<DisplayKey, boolean>;
  contextStyle: ContextStyle;
  speedStyle: SpeedStyle;
  quotaStyle: QuotaStyle;
  precision: PrecisionConfig;
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

/** footer 指标段：rank=0 为核心（窄终端永不裁剪），数值越大越先被裁掉 */
interface MetricSeg {
  text: string;
  rank: number;
}

/** 按宽度预算裁剪：先丢 rank 大的非核心段；仍超宽交给上层 truncateToWidth */
function fitSegments(segs: MetricSeg[], budget: number): string[] {
  const dropped = new Set<number>();
  const totalWidth = () =>
    segs.reduce((sum, seg, idx) => (dropped.has(idx) ? sum : sum + visibleWidth(seg.text) + 3), -3);
  if (totalWidth() > budget) {
    const dropOrder = segs
      .map((seg, idx) => idx)
      .filter((idx) => segs[idx].rank > 0)
      .sort((a, b) => segs[b].rank - segs[a].rank);
    for (const idx of dropOrder) {
      dropped.add(idx);
      if (totalWidth() <= budget) break;
    }
  }
  return segs.filter((_, idx) => !dropped.has(idx)).map((seg) => seg.text);
}

/** 会话开始时间（elapsed 段用） */
let sessionStartedAt = 0;

function buildMetricSegments(theme: ExtensionContext["ui"]["theme"], ctx: ExtensionContext): MetricSeg[] {
  const P = displayConfig.precision;
  const cfg = displayConfig.items;
  const dim = (s: string) => theme.fg("dim", s);
  const warn = (s: string) => theme.fg("warning", s);
  const ok = (s: string) => theme.fg("success", s);
  const muted = (s: string) => theme.fg("muted", s);

  const segs: MetricSeg[] = [];
  const push = (text: string, rank: number) => {
    if (text) segs.push({ text, rank });
  };

  // ── 产出段：↓ $ ↑ Σ CH TTFT T+ ─────────────────────
  {
    const segParts: string[] = [];
    if (cfg.output) segParts.push(`↓${formatTokens(stats.totalOutput, P.token)}`);
    // 没有花费数据（provider 不返回 usage.cost）时不显示 $0.00 误导用户
    if (cfg.cost && stats.totalCost > 0) segParts.push(formatAmount(stats.totalCost, P.costAmount));
    if (cfg.input) segParts.push(`↑${formatTokens(stats.totalInput, P.token)}`);
    if (cfg.totalTokens) {
      const total = stats.totalInput + stats.totalOutput;
      segParts.push(`Σ${formatTokens(total, P.token)}`);
    }
    if (cfg.cacheHit) {
      const totalPrompt = stats.totalInput + stats.totalCacheRead + stats.totalCacheWrite;
      // 无任何 prompt 数据时不显示 CH 0%（那是“无数据”而不是命中率为零）
      if (totalPrompt > 0) {
        const cumCH = (stats.totalCacheRead / totalPrompt) * 100;
        const chColor = cumCH >= 80 ? ok : cumCH >= 50 ? (s: string) => s : warn;
        segParts.push(`${dim("CH")} ${chColor(formatPercent(cumCH, P.cacheHitPercent))}`);
      }
    }
    if (cfg.latency) segParts.push(`${dim("TTFT")} ${formatLatency(stats.lastFirstTokenLatency)}`);
    if (cfg.elapsed && sessionStartedAt > 0) {
      segParts.push(`${dim("T+")} ${formatDuration(Date.now() - sessionStartedAt)}`);
    }
    push(segParts.join(" "), 1);
  }

  // ── 速度 ⚡（核心）──────────────────────────────────
  if (cfg.speed) {
    const liveSpeed = getRollingLiveTokenSpeed();
    const displaySpeed = liveSpeed !== null ? liveSpeed : stats.lastTokensPerSec;
    // 还没有任何输出时不显示 ⚡-- （无数据不是速度为零）
    if (displaySpeed > 0) {
      const speedNum = ok(formatSpeed(displaySpeed, P.speed));
      const speedStyle = displayConfig.speedStyle ?? "t/s";
      switch (speedStyle) {
        case "tok/s":
          push(`⚡${speedNum} tok/s`, 0);
          break;
        case "T/s":
          push(`⚡${speedNum} T/s`, 0);
          break;
        case "liveAt":
          if (stats.streaming && liveSpeed !== null) {
            push(`⚡${formatTokens(stats.liveEstimatedTokens, P.token)}@${speedNum}`, 0);
          } else {
            push(`⚡${speedNum} t/s`, 0);
          }
          break;
        default:
          push(`⚡${speedNum} t/s`, 0);
          break;
      }
    }
  }

  // ── 思考强度 TH ────────────────────────────────────
  if (cfg.thinking && ctx.thinkingLevel) {
    const level = ctx.thinkingLevel;
    push(level === "off" ? dim("TH off") : theme.fg("accent", `TH ${level}`), 2);
  }

  // ── 上下文占用 🧠（核心）───────────────────────────
  if (cfg.context) {
    try {
      const cu = ctx.getContextUsage();
      const ctxWindow = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const ctxPercent = typeof cu?.percent === "number" ? cu.percent : null;
      const ctxUsed = ctxPercent !== null && ctxWindow > 0 ? Math.round((ctxWindow * ctxPercent) / 100) : 0;
      const ctxStyle = displayConfig.contextStyle ?? "pct-window";
      let ctxStr: string;
      if (ctxWindow > 0 && ctxPercent !== null) {
        switch (ctxStyle) {
          case "used-window":
            ctxStr = `${formatTokens(ctxUsed, P.token)}/${formatTokens(ctxWindow, P.token)}`;
            break;
          case "pct":
            ctxStr = formatPercent(ctxPercent, P.contextPercent);
            break;
          case "used":
            ctxStr = formatTokens(ctxUsed, P.token);
            break;
          case "bar":
            ctxStr = `${progressBar(ctxPercent)} ${formatPercent(ctxPercent, P.contextPercent)}`;
            break;
          default:
            ctxStr = `${formatPercent(ctxPercent, P.contextPercent)}/${formatTokens(ctxWindow, P.token)}`;
            break;
        }
      } else {
        ctxStr = ctxWindow > 0 ? `--/${formatTokens(ctxWindow, P.token)}` : "--";
      }
      const ctxColor = ctxPercent !== null && ctxWindow > 0
        ? ctxPercent < 50 ? ok
          : ctxPercent < 65 ? (s: string) => theme.fg("accent", s)
            : ctxPercent < 75 ? muted
              : ctxPercent < 85 ? warn
                : (s: string) => theme.fg("error", s)
        : dim;
      push(`${muted("🧠")} ${ctxColor(ctxStr)}`, 0);
    } catch { /* ignore */ }
  }

  // ── 套餐用量（核心）：provider 变化时后台强制刷新 ──
  const curProvider = ctx.model?.provider ?? null;
  if (curProvider !== lastQuotaProvider) {
    // 跨 provider 切换：force refresh（绕过缓存，避免 P7）
    if (lastQuotaProvider !== null || curProvider !== null) {
      setTimeout(() => {
        if (!sessionActive) return;
        refreshQuotaOnce(ctx, true)
          .then(() => requestFooterRender?.())
          .catch(() => { /* ctx 已失效（session 被替换），忽略 */ });
      }, 0);
    }
    lastQuotaProvider = curProvider;
  }
  if (cfg.quota && quotaState && quotaState.display) {
    const qColor = quotaState.color === "ok" ? ok
      : quotaState.color === "warn" ? warn
        : quotaState.color === "err" ? (s: string) => theme.fg("error", s)
          : muted;
    const prefix = quotaState.modelPrefix ? quotaState.modelPrefix + " " : "";
    // 样式（紧凑 / 倒计时）已由套餐的 quotaStyle 决定，这里整段显示
    push(qColor(prefix + quotaState.display), 0);
  }

  return segs;
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

// ── 状态栏配置：选项表（中文 label + 效果预览）──────────────────────

const CONTEXT_STYLE_ITEMS: { value: ContextStyle; label: string; preview: string }[] = [
  { value: "pct-window", label: "百分比 / 窗口", preview: "5.3%/1.0M" },
  { value: "used-window", label: "已用 / 窗口", preview: "256k/1.0M" },
  { value: "pct", label: "仅百分比", preview: "5.3%" },
  { value: "used", label: "仅已用", preview: "256k" },
  { value: "bar", label: "进度条 + 百分比", preview: "[██░░░░░░] 25%" },
];
const SPEED_STYLE_ITEMS: { value: SpeedStyle; label: string; preview: string }[] = [
  { value: "t/s", label: "简写 t/s", preview: "⚡77.7 t/s" },
  { value: "tok/s", label: "完整单位", preview: "⚡77.7 tok/s" },
  { value: "T/s", label: "大写单位", preview: "⚡77.7 T/s" },
  { value: "liveAt", label: "流式时带已生成量", preview: "⚡1.2k@77.7" },
];
const QUOTA_STYLE_ITEMS: { value: QuotaStyle; label: string; preview: string }[] = [
  { value: "compact", label: "紧凑（不带倒计时）", preview: "5h: 89% 7d: 72%" },
  { value: "with-clock-7d", label: "各自带倒计时（精确到分）", preview: "5h: 89% ⏱ 4h15m 7d: 72% ⏱ 2d" },
  { value: "nearest-clock-7d", label: "仅最近一个倒计时", preview: "5h: 89% 7d: 72% ⏱ 4h15m" },
  { value: "largest-unit", label: "倒计时只显示最大单位", preview: "5h: 89% ⏱ 4h 7d: 72% ⏱ 2d" },
];

/** 显示内容分组（面板按组展示，组内顺序即 footer 中的顺序） */
const DISPLAY_GROUPS: { group: string; keys: DisplayKey[] }[] = [
  { group: "用量", keys: ["output", "cost", "input", "totalTokens", "cacheHit"] },
  { group: "性能", keys: ["speed", "latency", "thinking"] },
  { group: "状态", keys: ["context", "quota"] },
  { group: "元信息", keys: ["elapsed"] },
];
const DISPLAY_ITEM_NAMES: Record<DisplayKey, string> = {
  output: "输出 token",
  cost: "会话花费",
  input: "输入 token",
  totalTokens: "总 token",
  cacheHit: "缓存命中",
  speed: "速度",
  latency: "首 token 延迟",
  context: "上下文占用",
  quota: "套餐余量",
  thinking: "思考强度",
  elapsed: "会话时长",
};

/** 套餐段格式化上下文：样式 + 套餐余量百分比位数 + 余额金额位数 */
function planFormatCtx(): PlanFormatContext {
  return {
    style: displayConfig.quotaStyle,
    percentDigits: displayConfig.precision.quotaPercent,
    amountDigits: displayConfig.precision.balanceAmount,
  };
}

/** 面板右侧示例值：随当前精度联动，选之前就看到效果 */
function displayItemPreview(key: DisplayKey, cfg: DisplayConfig): string {
  const P = cfg.precision;
  switch (key) {
    case "output": return "↓" + formatTokens(804, P.token);
    case "cost": return formatAmount(0.12, P.costAmount);
    case "input": return "↑" + formatTokens(128400, P.token);
    case "totalTokens": return "Σ" + formatTokens(129204, P.token);
    case "cacheHit": return "CH " + formatPercent(82, P.cacheHitPercent);
    case "speed": return "⚡" + formatSpeed(77.7, P.speed) + " t/s";
    case "latency": return "TTFT " + formatLatency(420);
    case "context": return "🧠 " + formatPercent(5.3, P.contextPercent) + "/" + formatTokens(1000000, P.token);
    case "quota": return "5h: " + formatPercent(89, P.quotaPercent) + " ⏱ 4h15m";
    case "thinking": return "TH high";
    case "elapsed": return "T+" + formatDuration(72 * 60 * 1000);
  }
}

/** 精度摘要（菜单项右侧显示） */
function precisionSummary(p: PrecisionConfig): string {
  const tokenLabel = p.token === "auto" ? "自适应" : p.token === 0 ? "整数" : "1位";
  return `${p.contextPercent}位上下文 · CH ${p.cacheHitPercent}位 · 套餐 ${p.quotaPercent}位 · ${tokenLabel}token · ${p.speed}位速率 · ${p.costAmount}/${p.balanceAmount}位金额`;
}

/** 样式单选：中文 label + 效果预览，选中即保存并刷新 footer */
async function pickStyleOption<T extends string>(
  ctx: ExtensionContext,
  title: string,
  items: { value: T; label: string; preview: string }[],
  current: T,
  onPick: (value: T) => Promise<void>,
): Promise<void> {
  const render = (i: { value: T; label: string; preview: string }) =>
    (current === i.value ? "● " : "○ ") + i.label + "    " + i.preview;
  const choice = await ctx.ui.select(title, items.map(render));
  const picked = items.find((i) => render(i) === choice);
  if (picked && picked.value !== current) await onPick(picked.value);
}

/**
 * 套餐选择：TUI 走带搜索的单选组件（↑↓ 选择、输入即过滤、enter 选中即关闭），
 * 非 TUI 环境退回 select。返回 null = 用户取消。
 */
async function pickQuotaPlan(ctx: ExtensionContext, provider: string): Promise<string | null> {
  const options = ["关闭", ...BUILTIN_PLANS.map((p) => p.name)];
  if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
    const entries: ToggleEntry[] = options.map((name) => ({ id: name, primary: name }));
    const ids = await ctx.ui.custom<string[] | null>(
      (tui: any, theme: any, keybindings: any, done: (value: string[] | null) => void) =>
        new ToggleSelectorComponent(
          tui,
          {
            title: "选择 " + provider + " 的配额套餐",
            subtitle: "enter 选中即生效并关闭弹窗 · 直接输入可搜索过滤",
            countLabel: "套餐",
            mode: "single",
          },
          entries,
          [],
          keybindings,
          theme,
          done,
        ),
    );
    if (!ids || ids.length === 0) return null;
    return ids[0];
  }
  return (await ctx.ui.select("选择 " + provider + " 要显示配额的套餐（选中后关闭）", options)) ?? null;
}

/** 保存套餐选择（plan=null 表示关闭），刷新 footer 并提示结果。 */
async function applyQuotaPlan(ctx: ExtensionContext, provider: string, plan: TokenPlan | null): Promise<void> {
  const defaults: TokenConfig = { providerPlans: {}, ttl: 60 };
  const planId = plan ? plan.id : null;
  tokenConfig = tokenConfig
    ? { ...tokenConfig, providerPlans: { ...tokenConfig.providerPlans, [provider]: planId } }
    : { ...defaults, providerPlans: { [provider]: planId } };
  await saveTokenConfig(tokenConfig);
  lastQuotaProvider = provider;
  quotaState = null;
  if (plan) await forceRefreshQuota(ctx);
  if (quotaTimerId) clearInterval(quotaTimerId);
  quotaTimerId = setInterval(async () => {
    if (!sessionActive) return;
    try {
      await refreshQuotaOnce(ctx);
    } catch { /* ctx 已失效（session 被替换），忽略 */ }
    requestFooterRender?.();
  }, (tokenConfig?.ttl || 60) * 1000);
  requestFooterRender?.();
  if (!plan) {
    ctx.ui.notify(provider + " 的套餐用量已关闭", "info");
    return;
  }
  // forceRefreshQuota 在上面同步改写了 quotaState，这里重新读取（TS 看不到跨 await 的副作用）
  const st = quotaState as { error?: unknown; [k: string]: unknown } | null;
  if (st?.error) {
    // 仅当 quotaState 带有 error 字段时（key 缺失 / API 错误 / 网络错误 / 无数据）才提示"查询失败"
    // 不能用 color === "err" 判断，因为 5h 剩余 < 20% 的正常状态也会用 err 颜色（仅用于 footer 高亮）
    ctx.ui.notify(`${plan.name} 配额查询失败：${formatQuotaError(quotaState)}`, "info");
  } else {
    ctx.ui.notify(plan.name + " 配额已启用", "info");
  }
}

const TOKEN_CONFIG_DIR = join(homedir(), ".pi/agent/extensions/token-stats");
const TOKEN_CONFIG_FILE = join(TOKEN_CONFIG_DIR, "config.json");
const QUOTA_CACHE_FILE = join(LOGS_DIR, "quota-cache.json");

const DEFAULT_TOKEN_CONFIG: TokenConfig = {
  providerPlans: {},
  ttl: 60,
};

const DISPLAY_CONFIG_FILE = join(TOKEN_CONFIG_DIR, "display-config.json");
// 默认组合：产出（↓↑Σ CH）+ 速度 + 思考强度 + 上下文 + 套餐，一屏看完会话全貌
const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  items: {
    output: true,
    cost: false,
    input: true,
    totalTokens: true,
    cacheHit: true,
    speed: true,
    latency: false,
    context: true,
    quota: true,
    thinking: true,
    elapsed: false,
  },
  contextStyle: "used-window",
  speedStyle: "t/s",
  quotaStyle: "nearest-clock-7d",
  precision: {
    contextPercent: 1,
    cacheHitPercent: 1,
    quotaPercent: 0,
    token: "auto",
    speed: 1,
    costAmount: 2,
    balanceAmount: 1,
  },
};

let displayConfig: DisplayConfig = {
  ...DEFAULT_DISPLAY_CONFIG,
  items: { ...DEFAULT_DISPLAY_CONFIG.items },
  precision: { ...DEFAULT_DISPLAY_CONFIG.precision },
};

// ── 勾选组件（样式与交互对齐内置 /scoped-models 选择器）─────────────

interface ToggleEntry {
  id: string;
  primary: string;
  badge?: string;
  /** 分组标题（勾选面板按组分隔展示，仅用于显示） */
  group?: string;
  detail?: string;
}

interface ToggleSelectorOptions {
  title: string;
  subtitle: string;
  countLabel: string;
  /** single：enter 选中即返回（单选，如套餐选择）；toggle：勾选 + ctrl+s 保存（默认）。 */
  mode?: "toggle" | "single";
}

/**
 * 勾选组件：↑↓ 选择、enter 切换勾选、ctrl+a 全选、ctrl+x 清空、
 * ctrl+s 保存、esc 取消；支持模糊搜索过滤；条目按注册顺序固定展示（勾选不改变排序），
 * 可选 group 字段渲染分组标题。仅限 TUI 模式通过 ctx.ui.custom() 挂载；
 * done(ids) 保存，done(null) 取消。mode="single" 时为单选：enter 选中即返回。
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
      new Text(
        this.theme.fg(
          "muted",
          options.mode === "single" ? options.subtitle : `${options.subtitle} · ${this.keyLabel("app.models.save")} 保存`,
        ),
        0, 0,
      ),
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
    // 固定按注册顺序展示：勾选不改变排序，操作时条目不跳动、分组不重复割裂
    const markedSet = new Set(this.markedIds);
    return this.allIds
      .filter((id) => this.entriesById.has(id))
      .map((id) => ({ entry: this.entriesById.get(id) as ToggleEntry, marked: markedSet.has(id) }));
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
    const single = this.options.mode === "single";
    const parts = single
      ? [
          `${this.keyLabel("tui.select.confirm")} 选中并关闭`,
          "直接输入可搜索过滤",
          "esc 取消",
          `共 ${this.filteredItems.length} 项`,
        ]
      : [
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
    this.filteredItems = query ? fuzzyFilter(items, query, (item) => item.entry.primary) : items;
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
    // 分组标题：醒目分隔（色块 + 标题 + 横线），组间留白；分页时先补上当前页首项所属分组
    let lastGroup: string | undefined;
    if (startIndex > 0) {
      const g = this.filteredItems[startIndex]?.entry.group;
      if (g) {
        lastGroup = g;
        this.addGroupHeader(g, true);
      }
    }
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (item.entry.group && item.entry.group !== lastGroup) {
        if (lastGroup !== undefined) this.listContainer.addChild(new Spacer(1));
        lastGroup = item.entry.group;
        this.addGroupHeader(item.entry.group, false);
      }
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      // 层次：光标行 accent > 已勾选正常色 > 未勾选 dim
      const base = this.options.mode === "single" || item.marked
        ? item.entry.primary
        : this.theme.fg("dim", item.entry.primary);
      const primary = isSelected ? this.theme.fg("accent", item.entry.primary) : base;
      const badge = item.entry.badge ? this.theme.fg("muted", ` ${item.entry.badge}`) : "";
      const status = this.options.mode === "single" ? "" : item.marked ? this.theme.fg("success", " ✓") : this.theme.fg("dim", " ✗");
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

  /** 分组标题行：accent 色块 + 粗体标题 + 淡色横线，与条目形成清晰层次 */
  private addGroupHeader(group: string, continued: boolean): void {
    const title = (continued ? "  … " : "▌ ") + group;
    const line = this.theme.fg("border", " " + "─".repeat(Math.max(4, 44 - visibleWidth(title))));
    this.listContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(title)) + line, 0, 0));
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
      if (this.options.mode === "single") {
        if (item) this.done([item.entry.id]);
        return;
      }
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
      if (this.options.mode === "single") return;
      const targets = this.searchInput.getValue() ? this.filteredItems.map((i) => i.entry.id) : this.allIds;
      for (const id of targets) {
        if (!this.markedIds.includes(id)) this.markedIds.push(id);
      }
      this.isDirty = true;
      this.refresh();
      return;
    }
    if (kb.matches(data, "app.models.clearAll")) {
      if (this.options.mode === "single") return;
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
      if (this.options.mode === "single") return;
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

// ── 内置套餐定义 ─────────────────────────────────────────

// ── 配置文件操作 ─────────────────────────────────────────

async function loadTokenConfig(): Promise<TokenConfig> {
  try {
    if (existsSync(TOKEN_CONFIG_FILE)) {
      const raw = await readFile(TOKEN_CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<TokenConfig>;
      return {
        ...DEFAULT_TOKEN_CONFIG,
        ...parsed,
      };
    }
  } catch {}
  return { ...DEFAULT_TOKEN_CONFIG };
}

async function saveTokenConfig(cfg: TokenConfig) {
  await mkdir(TOKEN_CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

/** 迁移并归一化旧配置：新增字段取默认、quota5h/quotaWeek 双开关合并为 quota、精度容错 */
function normalizeDisplayConfig(saved: any): DisplayConfig {
  const items = { ...DEFAULT_DISPLAY_CONFIG.items };
  const savedItems = (saved && typeof saved === "object" && saved.items) || {};
  for (const key of Object.keys(items) as DisplayKey[]) {
    if (typeof savedItems[key] === "boolean") items[key] = savedItems[key];
  }
  // 旧配置用两个独立开关控制额度段（5h / 周），任一开启即视为额度段可见
  if (typeof savedItems.quota5h === "boolean" || typeof savedItems.quotaWeek === "boolean") {
    items.quota = !!(savedItems.quota5h || savedItems.quotaWeek);
  }
  const p = (saved && typeof saved === "object" && saved.precision) || {};
  const digits = <T extends number>(v: unknown, allowed: readonly T[], dflt: T): T =>
    typeof v === "number" && allowed.includes(v as T) ? (v as T) : dflt;
  // 旧配置的 percent 只作用于上下文（套餐当时还是写死取整），amount 对应会话花费
  const oldPercent = digits(p.percent, [0, 1, 2] as const, 1);
  const oldAmount = digits(p.amount, [1, 2] as const, 2);
  return {
    items,
    contextStyle: isContextStyle(saved?.contextStyle) ? saved.contextStyle : DEFAULT_DISPLAY_CONFIG.contextStyle,
    speedStyle: isSpeedStyle(saved?.speedStyle) ? saved.speedStyle : DEFAULT_DISPLAY_CONFIG.speedStyle,
    quotaStyle: isQuotaStyle(saved?.quotaStyle) ? saved.quotaStyle : DEFAULT_DISPLAY_CONFIG.quotaStyle,
    precision: {
      contextPercent: digits(p.contextPercent, [0, 1, 2] as const, oldPercent),
      cacheHitPercent: digits(p.cacheHitPercent, [0, 1, 2] as const, 0),
      quotaPercent: digits(p.quotaPercent, [0, 1, 2] as const, 0),
      token: p.token === 0 || p.token === 1 ? p.token : "auto",
      speed: digits(p.speed, [0, 1, 2] as const, 1),
      costAmount: digits(p.costAmount, [1, 2] as const, oldAmount),
      balanceAmount: digits(p.balanceAmount, [1, 2] as const, 1),
    },
  };
}

async function loadDisplayConfig(): Promise<DisplayConfig> {
  try {
    if (existsSync(DISPLAY_CONFIG_FILE)) {
      const raw = await readFile(DISPLAY_CONFIG_FILE, "utf-8");
      return normalizeDisplayConfig(JSON.parse(raw));
    }
  } catch {}
  return {
    ...DEFAULT_DISPLAY_CONFIG,
    items: { ...DEFAULT_DISPLAY_CONFIG.items },
    precision: { ...DEFAULT_DISPLAY_CONFIG.precision },
  };
}

function isContextStyle(v: unknown): v is ContextStyle {
  return typeof v === "string" && ["pct-window", "used-window", "pct", "used", "bar"].includes(v);
}
function isSpeedStyle(v: unknown): v is SpeedStyle {
  return typeof v === "string" && ["t/s", "tok/s", "T/s", "liveAt"].includes(v);
}
function isQuotaStyle(v: unknown): v is QuotaStyle {
  return typeof v === "string" && ["compact", "with-clock-7d", "nearest-clock-7d", "largest-unit"].includes(v);
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
  if (!tokenConfig || !provider) return null;
  // 套餐必须按当前 provider 显式选择；保留 matchProviders 仅用于旧配置兼容，
  // 不再根据 provider 名称自动推断，避免误匹配或绕过用户明确关闭的配置。
  const planId = tokenConfig.providerPlans[provider];
  if (!planId) return null;
  return BUILTIN_PLANS.find((p) => p.id === planId) ?? null;
}

function readAuthEntry(providerId: string): any | null {
  try {
    const authPath = join(homedir(), ".pi/agent/auth.json");
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    return auth[providerId] ?? null;
  } catch {}
  return null;
}

// ── OAuth token 自刷新 ───────────────────────────────
// pi 对 OAuth 凭证惰性刷新（真正发起模型调用时才刷），启动时扩展若直接用旧
// access 查配额会必败 401。此处用 refresh_token 自行刷新，与 pi 内置
// kimi-coding 实现同端点同参数（见 pi 包 bundle/chunks/kimi-coding.js）。
const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const refreshedOAuthAccess = new Map<string, { access: string; expires: number }>();

function persistAuthEntry(providerId: string, entry: any): void {
  // best-effort 回写 auth.json：refresh_token 可能轮换，不回写会导致 pi 里存的旧
  // refresh_token 失效；pi 的 AuthStorage.modify 加锁重读文件再合并，不会覆盖丢数据。
  try {
    const authPath = join(homedir(), ".pi/agent/auth.json");
    if (!existsSync(authPath)) return;
    const data = JSON.parse(readFileSync(authPath, "utf-8"));
    if (JSON.stringify(data[providerId]) === JSON.stringify(entry)) return;
    data[providerId] = entry;
    // ponytail: 无锁读改写，极端并发下可能丢 pi 同刻的其它字段写入；tmp+rename 保证不损坏文件
    const tmp = authPath + ".token-stats.tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, authPath);
  } catch {}
}

async function ensureFreshOAuth(providerId: string, entry: any): Promise<string | null> {
  const mem = refreshedOAuthAccess.get(providerId);
  if (mem && mem.expires > Date.now() + 60_000) return mem.access;
  if (!(providerId === "kimi" || providerId.startsWith("kimi"))) return null;
  if (typeof entry?.refresh !== "string") return null;
  try {
    const host = (process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || "https://auth.kimi.com").replace(/\/+$/, "");
    const r = await fetch(host + "/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: KIMI_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: entry.refresh,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => null);
    if (typeof j?.access_token !== "string" || typeof j?.refresh_token !== "string" || typeof j?.expires_in !== "number") return null;
    const tok = { access: j.access_token as string, expires: Date.now() + j.expires_in * 1000 };
    refreshedOAuthAccess.set(providerId, tok);
    persistAuthEntry(providerId, { ...entry, access: j.access_token, refresh: j.refresh_token, expires: tok.expires });
    return tok.access;
  } catch {}
  return null;
}

function resolveApiKey(plan: TokenPlan, provider?: string): string | null {
  // 0. 登录态套餐：凭据是控制台网页登录 Cookie，单独存放；
  //    auth.json 里同名的 api key 是推理域用的，拿来查套餐必 401。
  if (plan.needsLogin) return plan.readCredential?.() ?? null;
  // 1. 环境变量优先
  if (plan.apiKeyEnv && process.env[plan.apiKeyEnv]) {
    return process.env[plan.apiKeyEnv]!;
  }
  // 2a. 优先取「当前 provider」自己的 key：
  //     避免 provider 映射到套餐后盗用套餐原生 provider 的 key（如
  //     opencode-go 映射 deepseek 套餐时误用 deepseek 官方 key 查余额）。
  if (provider) {
    const entry = readAuthEntry(provider);
    if (entry?.key) return entry.key;
    // ponytail: OAuth 登录的 provider（如 kimi-coding）只有 access 字段，复用其 token 查配额；扩展更新后需重打此补丁
    if (entry?.access) return entry.access;
  }
  // 2b. 回退：套餐原生 provider 的 key
  for (const providerId of plan.matchProviders) {
    const entry = readAuthEntry(providerId);
    if (entry?.key) return entry.key;
  }
  return null;
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

  // 1.5 主动刷新（启用套餐 / 手动刷新 / 首次进入）时清掉登录退避，
  //     否则用户刚点完「启用」就被上一次失败的 10 分钟退避卡住，看起来像没反应。
  if (force) resetMimoLoginBackoff();

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

  // 2.5 OAuth 凭证可能已过期（pi 惰性刷新，仅在真正发起模型调用时才刷新并
  //     回写 auth.json），启动时立即查配额会必败 401。先自行用 refresh_token
  //     刷新；刷新失败仍过期时不发请求，改用缓存（无缓存则静默隐藏）。
  const authEntry = curProvider ? readAuthEntry(curProvider) : null;
  let freshAccess: string | null = null;
  let oauthExpired = false;
  if (authEntry?.type === "oauth"
    && typeof authEntry.expires === "number"
    && Date.now() >= authEntry.expires - 60_000 && curProvider) {
    freshAccess = await ensureFreshOAuth(curProvider, authEntry);
    const mem = freshAccess ? refreshedOAuthAccess.get(curProvider) : null;
    oauthExpired = !mem || Date.now() >= mem.expires - 60_000;
  }

  // 3. 解析 key
  const key = freshAccess ?? resolveApiKey(plan, curProvider);
  if (!key && !plan.needsLogin) {
    quotaState = buildErrorState(curProvider, plan.id, {
      kind: "key_missing",
      envVar: plan.apiKeyEnv || "API_KEY",
      provider: curProvider,
    });
    return;
  }
  // 登录态套餐即使没有凭据也要往下走：它的 fetchQuota 会自行静默续期

  // 4. 读缓存（force 时跳过）
  const cache = await readQuotaCache();
  const cached = cache[plan.id];
  if (oauthExpired) {
    if (cached) {
      const fmt = plan.format(cached.data, planFormatCtx());
      quotaState = {
        planId: plan.id,
        provider: curProvider,
        display: fmt.display,
        modelPrefix: fmt.modelPrefix,
        color: fmt.color,
        fetchedAt: cached.fetchedAt,
      };
    } else {
      quotaState = null;
    }
    return;
  }
  const ttlMs = (tokenConfig?.ttl || 60) * 1000;
  if (!force && cached && (Date.now() - cached.fetchedAt) < cached.ttl) {
    const fmt = plan.format(cached.data, planFormatCtx());
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
    const data = await plan.fetchQuota(plan, key ?? "");
    cache[plan.id] = { fetchedAt: Date.now(), ttl: ttlMs, data };
    await writeQuotaCache(cache);
    const fmt = plan.format(data, planFormatCtx());
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
    // 套餐自带静默失败（如 mimo 登录态不可用）：隐藏该段，不打扰
    if (e?.silent) {
      quotaState = null;
      mimoLog("silent-fail", e.message);
      return;
    }
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
  await refreshQuotaOnce(ctx, true);
  requestFooterRender?.();
}

/**
 * 单飞：session_start / provider 变化检测 / 定时器 / 手动刷新
 * 都可能同时打到 refreshQuota，并发会同时启多个 Chrome 并互相抢 profile。
 */
let quotaRefreshInFlight: Promise<void> | null = null;
/** 在途刷新期间收到的 force 请求：不能被降级成复用，结束后补跑一次 */
let quotaRefreshPendingForce = false;
function refreshQuotaOnce(ctx: ExtensionContext, force = false): Promise<void> {
  if (quotaRefreshInFlight) {
    if (force) quotaRefreshPendingForce = true;
    mimoLog("refresh-dedup", `force=${force} 复用进行中的刷新${force ? "（已标记补跑 force）" : ""}`);
    return quotaRefreshInFlight;
  }
  const p = (async () => {
    let nextForce = force;
    for (;;) {
      quotaRefreshPendingForce = false;
      await refreshQuota(ctx, nextForce);
      if (!quotaRefreshPendingForce) break;
      nextForce = true;
      mimoLog("refresh-deferred-force", "在途刷新结束，补跑一次 force");
    }
  })().finally(() => {
    quotaRefreshInFlight = null;
  });
  quotaRefreshInFlight = p;
  return p;
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

async function showYear(year: string, ctx: ExtensionContext, pi: ExtensionAPI) {
  let records: DailyRecord[] = [];
  try {
    records = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    // nothing
  }

  const monthlyMap = new Map<string, DailyRecord>();
  for (const record of records) {
    if (!record.date.startsWith(`${year}-`)) continue;
    const month = record.date.slice(0, 7);
    const current = monthlyMap.get(month);
    if (current) {
      current.count += record.count;
      current.sumInput += record.sumInput;
      current.sumCacheRead += record.sumCacheRead;
      current.sumCacheWrite += record.sumCacheWrite;
      current.sumOutput += record.sumOutput;
      current.sumTokensPerSec += record.sumTokensPerSec;
    } else {
      monthlyMap.set(month, {
        date: month,
        count: record.count,
        sumInput: record.sumInput,
        sumOutput: record.sumOutput,
        sumCacheRead: record.sumCacheRead,
        sumCacheWrite: record.sumCacheWrite,
        sumTokensPerSec: record.sumTokensPerSec,
        avgCacheHitRate: record.avgCacheHitRate,
      });
    }
  }

  const monthlyRecords = [...monthlyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (monthlyRecords.length === 0) {
    ctx.ui.notify(`${year} 年暂无统计数据`, "info");
    return;
  }

  const total = monthlyRecords.reduce(
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
    "月份        次数  新增输入  缓存输入  输出      总token   命中率  速率",
    "─".repeat(70),
    ...monthlyRecords.map((r) => {
      const totalPromptForMonth = r.sumInput + r.sumCacheRead + r.sumCacheWrite;
      return (
        `${r.date}      ` +
        `${String(r.count).padStart(3)}  ` +
        `${formatTokens(r.sumInput).padStart(7)}  ` +
        `${formatTokens(r.sumCacheRead).padStart(7)}  ` +
        `${formatTokens(r.sumOutput).padStart(7)}  ` +
        `${formatTokens(totalPromptForMonth).padStart(7)}  ` +
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

  await showStats(lines, `${year} 年度汇总（按月）`, ctx, pi);
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
    // content 可能是字符串，也可能是内容块数组（如 pi.sendMessage 传入的 TextContent[]）
    const content: any = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
        : "";
    return new Text(text, 0, 0);
  });

  // ── turn_start: 记录时间 + 检测供应商切换 ──────────

  // 思考强度切换时立即刷新 footer
  pi.on("thinking_level_select", async () => {
    requestFooterRender?.();
  });

  pi.on("turn_start", async (_event, ctx) => {
    stats.turnStartTime = Date.now();
    stats.firstTokenTime = 0;
    stats.streaming = false;

    // P1 修复：turn_start 也能触发 provider 变化检测；切换时 force refresh
    if (ctx.model?.provider !== lastQuotaProvider) {
      lastQuotaProvider = ctx.model?.provider ?? null;
      quotaState = null; // 跨 provider 立即清旧 state
      await refreshQuotaOnce(ctx, true); // force 绕过缓存
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
    sessionStartedAt = 0;
    if (quotaTimerId) {
      clearInterval(quotaTimerId);
      quotaTimerId = null;
    }
    requestFooterRender = null;
    lastQuotaProvider = null;
    quotaState = null;
    sessionStartedAt = 0;
    bindMimoFeedback(null, null);
  });

  // ── session_start: 恢复累计状态 + 注册 footer ───────

  pi.on("session_start", async (_event, ctx) => {
    sessionActive = true;
    sessionStartedAt = Date.now();
    rebuildFromHistory(ctx);
    bindMimoFeedback(
      typeof ctx.ui?.setWorkingMessage === "function"
        ? (message: string) => ctx.ui.setWorkingMessage!(message)
        : null,
      (message: string) => ctx.ui.notify(message, "info"),
    );

    // 套餐用量：加载配置 + 定时刷新
    tokenConfig = await loadTokenConfig();
    displayConfig = await loadDisplayConfig();
    lastQuotaProvider = null; // 强制让 refreshQuota 检测一次
    quotaState = null;
    // P7 修复：清空所有 plan 的缓存（避免跨 session 复用旧数据）
    await invalidateAllQuotaCache();
    if (quotaTimerId) clearInterval(quotaTimerId);
    // 第一次强制刷新（绕缓存）
    await refreshQuotaOnce(ctx, true);
    requestFooterRender?.();
    quotaTimerId = setInterval(async () => {
      if (!sessionActive) return;
      try {
        // 定时器也先检测 provider 变化；变化则 force refresh
        if (ctx.model?.provider !== lastQuotaProvider) {
          await refreshQuotaOnce(ctx, true);
        } else {
          await refreshQuotaOnce(ctx, false);
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
          const metrics = buildMetricSegments(theme, ctx);

          const modelName = ctx.model?.id || "";
          const provider = ctx.model?.provider || "";
          const rightSide = provider ? `(${provider}) ${modelName}` : modelName;
          const rightWidth = visibleWidth(rightSide);
          // 宽度预算：右侧模型名固定，左侧按优先级裁剪（核心段永不丢）
          const left = fitSegments(metrics, width - rightWidth - 1).join(" | ");
          const leftWidth = visibleWidth(left);
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
    description: "Token 统计：/stats 打开主菜单；/stats day|hour|week|month|year 查询；/stats config 状态栏配置",
    handler: async (args, ctx) => {
      let arg = args.trim();
      const fromMainMenu = !arg;

      mainMenu: while (true) {
        // 无参 → 主菜单：统计查询不再需要记参数，套餐/配置入口也在这里
        if (!arg) {
          const main = await ctx.ui.select("Token 统计", [
            "状态栏配置",
            "套餐配额配置",
            "统计查询",
          ]);
          if (!main) return;
          if (main === "统计查询") {
            const report = await ctx.ui.select("统计查询", [
              "今日统计",
              "按小时分布（今日）",
              "本周汇总",
              "月度汇总",
              "年度汇总（按月）",
            ]);
            if (!report) continue mainMenu;
            if (report === "今日统计") {
              await showDay(getDateStr(), ctx, pi);
            } else if (report === "按小时分布（今日）") {
              await showHourly(getDateStr(), ctx, pi);
            } else if (report === "本周汇总") {
              await showWeek(ctx, pi);
            } else if (report === "月度汇总") {
              await showMonth(getMonthStr(), ctx, pi);
            } else if (report === "年度汇总（按月）") {
              await showYear(String(new Date().getFullYear()), ctx, pi);
            }
            continue mainMenu;
          }
          if (main === "套餐配额配置") arg = "plan";
          else if (main === "状态栏配置") arg = "config";
          else return;
        }

        // 套餐配额配置
      if (arg === "plan") {
        const provider = ctx.model?.provider;
        if (!provider) {
          ctx.ui.notify("无法获取当前供应商，请先切换对话", "warning");
          return;
        }
        // 套餐选择：TUI 用带搜索的单选组件，非 TUI 退回 select。
        // 前置检查不通过（如缺 Chrome）时留在界面重选；选中后保存并关闭弹窗。
        while (true) {
          const choice = await pickQuotaPlan(ctx, provider);
          if (!choice) return; // esc：直接关闭
          const plan = choice === "关闭" ? null : (BUILTIN_PLANS.find((p) => p.name === choice) ?? null);
          if (choice !== "关闭" && !plan) continue;
          if (plan) {
            const prereq = await checkLoginPlanPrereq(plan);
            if (prereq) {
              ctx.ui.notify("无法启用「" + plan.name + "」\n" + prereq, "warning");
              continue; // 留在选择界面重选
            }
          }
          await applyQuotaPlan(ctx, provider, plan);
          return; // 选中即关闭弹窗
        }
      }
      if (arg === "config") {
        configMenu: while (true) {
        const allDisplayKeys = DISPLAY_GROUPS.flatMap((g) => g.keys);
        const enabledCount = allDisplayKeys.filter((k) => displayConfig.items[k]).length;
        const subChoice = await ctx.ui.select("状态栏配置", [
          "显示内容    已开 " + enabledCount + "/" + allDisplayKeys.length,
          "显示精度    " + precisionSummary(displayConfig.precision),
          "上下文样式  " + (CONTEXT_STYLE_ITEMS.find((i) => i.value === displayConfig.contextStyle)?.label ?? displayConfig.contextStyle),
          "速率样式    " + (SPEED_STYLE_ITEMS.find((i) => i.value === displayConfig.speedStyle)?.label ?? displayConfig.speedStyle),
          "套餐样式    " + (QUOTA_STYLE_ITEMS.find((i) => i.value === displayConfig.quotaStyle)?.label ?? displayConfig.quotaStyle),
          "查询间隔    " + (tokenConfig?.ttl || 60) + "s",
          "恢复默认",
        ]);
        if (!subChoice) break configMenu;

        if (subChoice.startsWith("显示内容")) {
          // 分组勾选面板：右侧示例值随精度联动，ctrl+s 保存并实时刷新 footer
          if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
            const entries: ToggleEntry[] = DISPLAY_GROUPS.flatMap((g) =>
              g.keys.map((k) => ({
                id: k,
                primary: DISPLAY_ITEM_NAMES[k],
                badge: displayItemPreview(k, displayConfig),
                group: g.group,
              })),
            );
            const initialMarked = allDisplayKeys.filter((k) => displayConfig.items[k]);
            await ctx.ui.custom<string[] | null>(
              (tui: any, theme: any, keybindings: any, done: (value: string[] | null) => void) =>
                new ToggleSelectorComponent(
                  tui,
                  {
                    title: "状态栏显示内容",
                    subtitle: "勾选 = 在 footer 中显示该项（右侧为当前精度下的效果）",
                    countLabel: "显示",
                  },
                  entries,
                  initialMarked,
                  keybindings,
                  theme,
                  done,
                  async (ids) => {
                    const marked = new Set(ids);
                    displayConfig = {
                      ...displayConfig,
                      items: Object.fromEntries(
                        allDisplayKeys.map((k) => [k, marked.has(k)]),
                      ) as Record<DisplayKey, boolean>,
                    };
                    await saveDisplayConfig(displayConfig);
                    requestFooterRender?.();
                  },
                ),
            );
          } else {
            // 非 TUI：循环 select 切换
            while (true) {
              const options = allDisplayKeys.map(
                (k) => `${displayConfig.items[k] ? "[✓]" : "[ ]"} ${DISPLAY_ITEM_NAMES[k]}  ${displayItemPreview(k, displayConfig)}`,
              );
              options.push("完成");
              const choice = await ctx.ui.select("选择要切换显示的项目", options);
              if (!choice || choice === "完成") break;
              const idx = options.indexOf(choice);
              if (idx >= 0 && idx < allDisplayKeys.length) {
                const key = allDisplayKeys[idx];
                displayConfig = {
                  ...displayConfig,
                  items: { ...displayConfig.items, [key]: !displayConfig.items[key] },
                };
                await saveDisplayConfig(displayConfig);
                requestFooterRender?.();
              }
            }
          }
        } else if (subChoice.startsWith("显示精度")) {
          precisionMenu: while (true) {
            const P = displayConfig.precision;
            const pChoice = await ctx.ui.select("显示精度（各部分独立设置）", [
              "上下文百分比    当前 " + P.contextPercent + " 位",
              "缓存命中率      当前 " + P.cacheHitPercent + " 位",
              "套餐余量百分比  当前 " + P.quotaPercent + " 位",
              "token 精度      当前 " + (P.token === "auto" ? "自适应" : P.token + " 位"),
              "速率小数位      当前 " + P.speed + " 位",
              "会话花费金额    当前 " + P.costAmount + " 位",
              "套餐余额金额    当前 " + P.balanceAmount + " 位",
            ]);
            if (!pChoice) break precisionMenu;
            const apply = async <K extends keyof PrecisionConfig>(key: K, value: PrecisionConfig[K]) => {
              displayConfig = { ...displayConfig, precision: { ...displayConfig.precision, [key]: value } };
              await saveDisplayConfig(displayConfig);
              // 套餐段的 display 是已格式化的字符串，需重新格式化（缓存命中不重发请求）
              await refreshQuotaOnce(ctx);
              requestFooterRender?.();
            };
            /** 0/1/2 位选择，示例值随选项实时展示 */
            const pickDigits = async (title: string, sample: (d: number) => string) => {
              const c = await ctx.ui.select(title, [0, 1, 2].map((d) => `${d} 位    ${sample(d)}`));
              const d = c ? parseInt(c[0], 10) : NaN;
              return Number.isNaN(d) ? null : (d as 0 | 1 | 2);
            };
            /** 1/2 位选择（金额） */
            const pickAmount = async (title: string, sample: (d: number) => string) => {
              const c = await ctx.ui.select(title, [1, 2].map((d) => `${d} 位    ${sample(d)}`));
              const d = c ? parseInt(c[0], 10) : NaN;
              return Number.isNaN(d) ? null : (d as 1 | 2);
            };
            if (pChoice.startsWith("上下文百分比")) {
              const d = await pickDigits("上下文占用百分比小数位", (d) => formatPercent(5.3, d) + "/" + formatTokens(1000000, P.token));
              if (d !== null && d !== P.contextPercent) await apply("contextPercent", d);
            } else if (pChoice.startsWith("缓存命中率")) {
              const d = await pickDigits("缓存命中率小数位（惯例为整数）", (d) => "CH " + formatPercent(82.4, d));
              if (d !== null && d !== P.cacheHitPercent) await apply("cacheHitPercent", d);
            } else if (pChoice.startsWith("套餐余量")) {
              const d = await pickDigits("套餐余量百分比小数位", (d) => "5h: " + formatPercent(89.34, d) + " ⏱ 4h15m");
              if (d !== null && d !== P.quotaPercent) await apply("quotaPercent", d);
            } else if (pChoice.startsWith("token")) {
              const c = await ctx.ui.select("token 精度（自适应最省心）", [
                "自适应    " + formatTokens(128400, "auto"),
                "整数      " + formatTokens(128400, 0),
                "1 位小数  " + formatTokens(128400, 1),
              ]);
              const t = c ? (c.startsWith("整数") ? 0 : c.startsWith("1 位") ? 1 : "auto") : null;
              if (t !== null && t !== P.token) await apply("token", t as TokenPrecision);
            } else if (pChoice.startsWith("速率")) {
              const d = await pickDigits("速率小数位", (d) => formatSpeed(77.7, d) + " t/s");
              if (d !== null && d !== P.speed) await apply("speed", d);
            } else if (pChoice.startsWith("会话花费")) {
              const d = await pickAmount("会话花费金额小数位", (d) => formatAmount(0.124, d));
              if (d !== null && d !== P.costAmount) await apply("costAmount", d);
            } else {
              const d = await pickAmount("套餐余额金额小数位", (d) => formatAmount(12.34, d, "¥"));
              if (d !== null && d !== P.balanceAmount) await apply("balanceAmount", d);
            }
          }
        } else if (subChoice.startsWith("上下文样式")) {
          await pickStyleOption(ctx, "上下文样式", CONTEXT_STYLE_ITEMS, displayConfig.contextStyle, async (v) => {
            displayConfig = { ...displayConfig, contextStyle: v };
            await saveDisplayConfig(displayConfig);
            requestFooterRender?.();
          });
        } else if (subChoice.startsWith("速率样式")) {
          await pickStyleOption(ctx, "速率样式", SPEED_STYLE_ITEMS, displayConfig.speedStyle, async (v) => {
            displayConfig = { ...displayConfig, speedStyle: v };
            await saveDisplayConfig(displayConfig);
            requestFooterRender?.();
          });
        } else if (subChoice.startsWith("套餐样式")) {
          await pickStyleOption(ctx, "套餐样式", QUOTA_STYLE_ITEMS, displayConfig.quotaStyle, async (v) => {
            displayConfig = { ...displayConfig, quotaStyle: v };
            await saveDisplayConfig(displayConfig);
            // 缓存数据重新格式化即可，不必重新请求接口
            await refreshQuotaOnce(ctx);
            requestFooterRender?.();
          });
        } else if (subChoice.startsWith("查询间隔")) {
          const input = await ctx.ui.input("输入刷新间隔（秒）", String(tokenConfig?.ttl || 60));
          if (input) {
            const sec = parseInt(input, 10);
            if (Number.isNaN(sec) || sec < 10) {
              ctx.ui.notify("查询间隔必须 >= 10 秒", "warning");
            } else {
              tokenConfig = tokenConfig
                ? { ...tokenConfig, ttl: sec }
                : { providerPlans: {}, ttl: sec };
              await saveTokenConfig(tokenConfig);
              if (quotaTimerId) clearInterval(quotaTimerId);
              quotaTimerId = setInterval(async () => {
                if (!sessionActive) return;
                try {
                  await refreshQuotaOnce(ctx);
                } catch { /* ctx 已失效（session 被替换），忽略 */ }
                requestFooterRender?.();
              }, sec * 1000);
              ctx.ui.notify("查询间隔已设为 " + sec + " 秒", "info");
            }
          }
        } else if (subChoice === "恢复默认") {
          const ok = await ctx.ui.confirm("恢复默认", "显示项、精度、样式全部恢复默认？");
          if (ok) {
            displayConfig = normalizeDisplayConfig({});
            await saveDisplayConfig(displayConfig);
            requestFooterRender?.();
            ctx.ui.notify("已恢复默认显示配置", "info");
          }
        }
        continue configMenu;
        }
        if (fromMainMenu) {
          arg = "";
          continue mainMenu;
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
      } else if (arg === "year") {
        await showYear(String(new Date().getFullYear()), ctx, pi);
      } else if (arg.startsWith("year ")) {
        const year = arg.slice(5).trim();
        if (/^\d{4}$/.test(year)) {
          await showYear(year, ctx, pi);
        } else {
          ctx.ui.notify("用法: /stats year YYYY", "warning");
        }
      } else {
        ctx.ui.notify(
          "用法: /stats [day [date] | hour [date] | week | month [YYYY-MM] | year [YYYY] | config]",
          "warning",
        );
      }
      if (fromMainMenu) {
        arg = "";
        continue mainMenu;
      }
      return;
      }
    },
  });
}
