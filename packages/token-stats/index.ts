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
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { BUILTIN_PLANS, bindMimoFeedback, checkLoginPlanPrereq, mimoLog, resetMimoLoginBackoff } from "./plans";
import type { PlanFormatContext, QuotaStyle, TokenPlan } from "./plans";
import type { TokenPrecision } from "./format";
import {
  UNKNOWN_MODEL_KEY,
  addUsageToBucket,
  bucketPromptTokens,
  calcCacheHitRate,
  detectInputScope,
  createEmptyBucket,
  formatAmount,
  formatDuration,
  formatLatency,
  formatPercent,
  formatSpeed,
  formatTokens,
  getModelKey,
  normalizeBucket,
  normalizeInputTokens,
} from "./format";
import type { InputScope, ModelKey, TokenBucket, UsageDelta } from "./format";
import { REPORT_HTML_PATH, rebuildDay, writeReportData } from "./report";
import { formatBytes, isEmpty, listAllDates, planPurge, runPurge } from "./purge";
import { DEFAULT_PORT, MIN_INTERVAL_MS, StatsServer } from "./server";
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

/**
 * 落盘的逐轮记录：按模型归类统计的唯一数据源。
 * model 形如 `provider/modelId`（首版就有，最完整）；provider/modelId 是后加的显式字段。
 */
interface RawRecord extends TurnStats {
  ts: string;
  session: string;
  provider?: string;
  modelId?: string;
  /**
   * 该轮 input 字段是否已包含缓存。
   *
   * 不同 provider 的 Anthropic 兼容端点行为不一致：有的（标准）把 input 当纯新增，
   * 有的（实测 minimax、commandcodego）把 input 当含缓存的总量。判定后落盘，
   * 避免每轮重新推断——推断需要「上一轮 input」，而聚合时顺序可能已被打乱。
   * 缺省视为 exclusive（与 pi-ai 的 OpenAI 通道一致，也是历史数据的实际口径）。
   */
  inputScope?: InputScope;
}

/** 按模型归类的累计量（会话、时间窗口、报表都复用它） */
interface ModelUsage {
  modelKey: ModelKey;
  bucket: TokenBucket;
  /** 该区间内输出速率之和，配合 turns 求均值 */
  sumTokensPerSec: number;
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
  /** 历史遗留字段（算术平均，展示已改用加权口径），仅为兼容旧文件保留 */
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
  /** 历史遗留字段（算术平均，展示已改用加权口径），仅为兼容旧文件保留 */
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

/** 单轮快照（用于单轮命中率骤降时提示缓存失效） */
interface TurnSnapshot extends TokenBucket {
  modelKey: ModelKey;
  tokensPerSec: number;
  cacheHitRate: number | null;
  at: number;
}

/**
 * 会话统计状态机：按模型分桶（byModel）+ 当前激活模型指针 + 全会话汇总。
 * KV Cache 按 provider+model 隔离，累计量不能混在一个桶里，否则切模型后
 * 旧模型的 cacheRead 会污染新模型的命中率，且不可修复（只能等重启会话）。
 */
const stats = {
  /** 当前激活模型（`provider/model`），footer 的 CH% 以它为准 */
  activeModelKey: null as ModelKey | null,
  /** 按模型归类的累计量 */
  byModel: new Map<ModelKey, TokenBucket>(),
  /** 每个模型最近一轮的快照 */
  lastTurnByModel: new Map<ModelKey, TurnSnapshot>(),
  // 本轮计时
  turnStartTime: 0,
  firstTokenTime: 0,
  streaming: false,
  lastTokensPerSec: 0,           // 平均速率（output / elapsed）
  lastLiveTokenSpeed: null as number | null, // rolling window 速率
  lastFirstTokenLatency: 0,      // 首 token 延迟（毫秒）
  // ── 流式 rolling window 状态 ─────────────────────────
  liveOutputChars: 0,
  liveEstimatedTokens: 0,
  liveUsageOutputTokens: 0,
  liveTokenSamples: [] as LiveTokenSample[],
  // ── 去重（防止 message_end + turn_end 重复累加）───
  accountedUsageKeys: new Set<string>(),
};

/** 取指定模型（缺省为当前激活模型）的累计桶，不自动建桶 */
function getModelBucket(modelKey: ModelKey | null = stats.activeModelKey): TokenBucket | null {
  if (!modelKey) return null;
  return stats.byModel.get(modelKey) ?? null;
}

/** 取指定模型的累计桶，不存在则建空桶 */
function ensureModelBucket(modelKey: ModelKey): TokenBucket {
  let bucket = stats.byModel.get(modelKey);
  if (!bucket) {
    bucket = createEmptyBucket();
    stats.byModel.set(modelKey, bucket);
  }
  return bucket;
}

/** 会话统计重置（session_start / 历史重放前） */
function resetSessionStats() {
  stats.byModel = new Map();
  stats.lastTurnByModel = new Map();
  stats.accountedUsageKeys = new Set();
  stats.lastTokensPerSec = 0;
  scopeCache.clear();
}

/** 当前模型键：优先用 ctx 里的模型，缺失时回退到已记住的激活模型 */
function resolveActiveModelKey(ctx: ExtensionContext): ModelKey | null {
  const m = ctx.model;
  if (m?.provider || m?.id) return getModelKey(m.provider, m.id);
  return stats.activeModelKey;
}

/** 当前模型是否已存在历史累计（切换后用于区分「新模型冷启动」与「切回旧模型」） */
function hasHistory(modelKey: ModelKey | null): boolean {
  const bucket = getModelBucket(modelKey);
  return !!bucket && bucket.turns > 0;
}
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
    // 一律只统计当前模型：不同模型缓存机制与单价不同，混算出来的数没有参考价值
    const modelBucket = getModelBucket();
    // 切到还没用过的模型时桶为空，用量按 0 显示（保持 footer 布局稳定，不闪段）
    const bucket = modelBucket ?? createEmptyBucket();

    const segParts: string[] = [];
    if (cfg.output) segParts.push(`↓${formatTokens(bucket.output, P.token)}`);
    // 没有花费数据（provider 不返回 usage.cost）时不显示 $0.00 误导用户
    if (cfg.cost && bucket.cost > 0) segParts.push(formatAmount(bucket.cost, P.costAmount));
    if (cfg.input) segParts.push(`↑${formatTokens(bucket.input, P.token)}`);
    if (cfg.totalTokens) {
      const total = bucket.input + bucket.output;
      segParts.push(`Σ${formatTokens(total, P.token)}`);
    }
    if (cfg.cacheHit) {
      // CH% 只算当前模型（跨模型算平均命中率没有工程意义）
      // 切到还没用过的模型时没有分母，命中率按 0% 显示并保持该段不消失
      const cumCH = calcCacheHitRate(modelBucket) ?? 0;
      const chColor = cumCH >= 80 ? ok : cumCH >= 50 ? (s: string) => s : warn;
      const lastTurn = stats.activeModelKey ? stats.lastTurnByModel.get(stats.activeModelKey) : undefined;
      const lastCH = lastTurn?.cacheHitRate ?? null;
      // 累计命中率尚可但最新一轮跌得很惨 → 前缀缓存断了（Prefix Break）
      const brokenPrefix = cumCH >= 60 && lastCH !== null && lastCH < 20;
      const label = brokenPrefix ? warn("CH!") : dim("CH");
      segParts.push(`${label} ${chColor(formatPercent(cumCH, P.cacheHitPercent))}`);
      if (brokenPrefix && lastCH !== null) {
        segParts.push(warn(`↓${formatPercent(lastCH, P.cacheHitPercent)}`));
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

/**
 * 从逐轮记录解析模型键。
 * 优先用显式 provider/modelId；缺失时回退解析 model 字段（首版就有，覆盖最全）。
 * modelId 自己可能含 "/"（如 deepseek/deepseek-v4.1-flash），所以只按第一个 "/" 切。
 */
function recordModelKey(record: Partial<RawRecord>): ModelKey {
  if (record.provider || record.modelId) return getModelKey(record.provider, record.modelId);
  const raw = (record.model ?? "").trim();
  return raw.includes("/") ? raw : UNKNOWN_MODEL_KEY;
}

/** 把一轮消耗并入时间窗口聚合（hourly / daily 共用） */
function mergePeriodRecord(
  target: HourlyRecord | DailyRecord,
  record: RawRecord,
): void {
  const prevCount = Number(target.count) || 0;
  const newCount = prevCount + 1;
  const prevAvg = Number(target.avgCacheHitRate) || 0;

  // 与 groupByModel 同口径归一，否则 daily/hourly 的总量会比 raw 明细偏大
  const usage = recordUsage(record);
  target.count = newCount;
  target.sumInput += usage.input;
  target.sumOutput += usage.output;
  target.sumCacheRead += usage.cacheRead;
  target.sumCacheWrite += usage.cacheWrite;
  target.sumTokensPerSec += record.tokensPerSec;
  // 历史遗留字段（展示已改用加权口径），继续维护仅为兼容旧版本读取
  target.avgCacheHitRate = (prevAvg * prevCount + record.cacheHitRate) / newCount;
}

/** 新建一个时间窗口记录 */
function createPeriodRecord(date: string, record: RawRecord): HourlyRecord | DailyRecord {
  const empty: HourlyRecord | DailyRecord = {
    date,
    count: 0,
    sumInput: 0,
    sumOutput: 0,
    sumCacheRead: 0,
    sumCacheWrite: 0,
    sumTokensPerSec: 0,
    avgCacheHitRate: 0,
  };
  mergePeriodRecord(empty, record);
  return empty;
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
    mergePeriodRecord(records[idx], record);
  } else {
    records.push({ ...(createPeriodRecord(date, record) as HourlyRecord), hour });
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
    mergePeriodRecord(records[idx], record);
  } else {
    records.push(createPeriodRecord(date, record) as DailyRecord);
  }

  await writeFile(
    DAILY_FILE,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
}

// ── 当天分片自动重建 ────────────────────────────────────
// 分片化之后「重建今天」只需读当天一个 raw 文件，通常几毫秒，
// 所以可以挂在 agent_end 上自动跑，日常对话产生的数据无需再手动执行 /stats html。
// 仍做节流：连续多轮对话时没必要每轮都写文件，攒一会儿一次性重建即可。

const SHARD_REBUILD_INTERVAL_MS = 30_000;
let shardRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let shardRebuildAt = 0;

/**
 * 自动统计总开关。
 * 关掉后 agent_end 不再重建分片——否则用户点了「停止服务」，
 * 却因为继续对话而看到数据仍在更新，语义矛盾。
 * 手动「立刻统计」不受此开关限制。
 */
let autoStatsEnabled = true;

/** 供服务端调用：跟随自动统计开关启停 agent_end 重建 */
function setAutoStatsEnabled(enabled: boolean): void {
  autoStatsEnabled = enabled;
  if (!enabled && shardRebuildTimer) {
    clearTimeout(shardRebuildTimer);
    shardRebuildTimer = null;
  }
}

function scheduleShardRebuild(): void {
  if (!autoStatsEnabled) return;   // 自动统计已停：不排重建
  const now = Date.now();
  const wait = Math.max(0, shardRebuildAt + SHARD_REBUILD_INTERVAL_MS - now);
  if (shardRebuildTimer) return; // 已排队，等它跑
  shardRebuildTimer = setTimeout(() => {
    shardRebuildTimer = null;
    shardRebuildAt = Date.now();
    // 失败不影响对话：报表数据是旁路功能，不能因为写文件出错就报错给用户
    void rebuildDay().catch(() => {});
  }, wait);
  // 不阻止进程退出
  (shardRebuildTimer as { unref?: () => void }).unref?.();
}

// ── 本地统计服务 ────────────────────────────────────────
// 报表页面是 file:// 静态页，无法创建进程，所以「启动/停止定时统计」
// 必须由 pi 进程内的 HTTP 服务承接。服务随 /stats 统计查询拉起，
// 页面只负责查询状态和下发停止指令。
// 跨 /reload 复用：新实例若发现端口已在监听，说明旧实例还在跑，直接沿用状态。

let statsServer: StatsServer | null = null;
let statsServerStarting: Promise<StatsServer | null> | null = null;
let statsServerUrl = "";

const STATS_INTERVAL_MS = 60_000;   // 默认 1 分钟

async function ensureStatsServer(
  pi: ExtensionAPI,
  notify?: (text: string) => void,
): Promise<StatsServer | null> {
  if (statsServer) return statsServer;
  if (statsServerStarting) return statsServerStarting;

  statsServerStarting = (async () => {
    const srv = new StatsServer({
      port: DEFAULT_PORT,
      intervalMs: STATS_INTERVAL_MS,
      runOnce: async () => {
        const r = await rebuildDay();
        return r?.turns ?? 0;
      },
      // 停止时同步关掉 agent_end 那条路径，避免「已停止仍在统计」
      onAutoToggle: (enabled) => setAutoStatsEnabled(enabled),
    });
    try {
      await srv.listen();
      statsServer = srv;
      statsServerUrl = `http://127.0.0.1:${srv.port}/`;
      // 服务不阻止进程退出：pi 关掉后页面自然显示「服务未运行」
      return srv;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        notify?.(`端口 ${DEFAULT_PORT} 已被其它程序占用，服务未启动`);
      } else {
        notify?.(`本地服务启动失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    } finally {
      statsServerStarting = null;
    }
  })();
  return statsServerStarting;
}

/**
 * 查该模型最近一条已落盘记录的口径，作为首轮/无法判定时的兜底。
 * 口径是 provider 的固有属性，同一模型不会每轮变来变去。
 *
 * 返回 null 表示「查不到已判定的口径」：宁可让调用方保持未知，
 * 也不能把默认的 exclusive 当成既定事实写回缓存——
 * 那会让 inclusive 的模型（minimax / commandcodego）第一轮冷启动后
 * 永远按错误口径统计。
 */
async function modelInputScope(provider: string, modelId: string): Promise<InputScope | null> {
  const key = getModelKey(provider, modelId);
  const today = getDateStr();
  const yesterday = getDateStr(Date.now() - 86400000);
  for (const date of [today, yesterday]) {
    let text: string;
    try {
      text = await readFile(join(RAW_DIR, `${date}.jsonl`), "utf-8");
    } catch {
      continue;
    }
    const lines = text.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const prev = JSON.parse(line) as RawRecord;
        if (recordModelKey(prev) === key && prev.inputScope) return prev.inputScope;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * 读同一会话最近一条记录的 input，用于判定本轮 input 的口径。
 * 只回看今天与昨天的文件：一次会话极少跨更多天，全量扫描得不偿失。
 */
async function lastSessionInput(sessionId: string): Promise<number> {
  const today = getDateStr();
  const yesterday = getDateStr(Date.now() - 86400000);
  for (const date of [today, yesterday]) {
    let text: string;
    try {
      text = await readFile(join(RAW_DIR, `${date}.jsonl`), "utf-8");
    } catch {
      continue;
    }
    const lines = text.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const prev = JSON.parse(line) as RawRecord;
        if (prev.session === sessionId && prev.input > 0) return prev.input;
      } catch {
        continue;
      }
    }
  }
  return 0;
}

/**
 * 会话内的口径缓存。
 * 口径是 provider+model 的固有属性（同一模型不会这轮 inclusive、下一轮 exclusive），
 * 判定一次就记住，后续轮次零 IO。
 */
const scopeCache = new Map<ModelKey, InputScope>();

/**
 * 判定某模型本轮的 input 口径。
 *
 * 优先用「cacheRead ≈ 同会话上一轮 input」现场判定（最准）；
 * 判不出时沿用该模型最近一次落盘记录的口径；
 * 都没有则返回 null（未知）——未知就保持未知，等下一轮拿到参照物再判，
 * 避免把猜测固化成事实。
 */
async function resolveUsageScope(
  provider: string,
  modelId: string,
  sessionId: string,
  cacheRead: number,
): Promise<InputScope | null> {
  const key = getModelKey(provider, modelId);
  const cached = scopeCache.get(key);
  if (cached) return cached;
  const prevInput = await lastSessionInput(sessionId);
  const detected = detectInputScope(prevInput, cacheRead);
  if (detected) {
    scopeCache.set(key, detected);
    return detected;
  }
  const known = await modelInputScope(provider, modelId);
  if (known) {
    scopeCache.set(key, known);
    return known;
  }
  return null;
}

async function persistTurn(
  record: TurnStats,
  sessionId: string,
  provider: string,
  modelId: string,
  knownScope?: InputScope,
) {
  // 判定 input 口径：cacheRead ≈ 上一轮 input 说明 input 已含缓存。
  // 首轮（无上一条）无从判断，沿用同模型已有记录的口径；
  // 都判不出时留空（不写 inputScope），留给读取阶段现场推断，
  // 避免把 exclusive 当成事实落盘、反过来污染 modelInputScope 的判断。
  const prevInput = await lastSessionInput(sessionId);
  const detected = detectInputScope(prevInput, record.cacheRead);
  const resolved = knownScope ?? detected ?? (await modelInputScope(provider, modelId));
  if (resolved) scopeCache.set(getModelKey(provider, modelId), resolved);

  const raw: RawRecord = {
    ...record,
    ts: getISO(),
    session: sessionId,
    provider,
    modelId,
    inputScope: resolved ?? undefined,
  };
  await appendRaw(raw);
  await updateHourly(raw);
  await updateDaily(raw);
}

// ── 逐轮明细读取（按模型归类统计的数据源） ───────────────
// 模型维度不落在 hourly/daily 聚合里：那需要逐日累积，漏跑一天就永远是空的。
// raw 是逐轮落盘的事实源，天然带 model，且文件名就是日期，区间查询可预筛。

/** 读取日期区间 [from, to] 内的逐轮记录（用文件名预筛，不解析无关文件） */
async function loadRawRecords(from: string, to: string): Promise<RawRecord[]> {
  let names: string[];
  try {
    names = await readdir(RAW_DIR);
  } catch {
    return [];
  }

  const files = names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .map((n) => n.slice(0, 10))
    .filter((d) => d >= from && d <= to)
    .sort();

  const out: RawRecord[] = [];
  for (const date of files) {
    let text: string;
    try {
      text = await readFile(join(RAW_DIR, `${date}.jsonl`), "utf-8");
    } catch {
      continue; // 单个文件读失败不影响整体
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as RawRecord);
      } catch {
        // 坏行跳过，不阻断整份报表
      }
    }
  }
  backfillScope(out);
  return out;
}

/**
 * 给缺 inputScope 的老记录补上口径。
 *
 * 老数据没有这个字段，但口径是 provider 的固有属性，同一模型不会来回变：
 * 用该模型已判定过的口径回填；从未判定过的，用「cacheRead ≈ 同会话上一轮 input」
 * 现场推断（这正是 inclusive 的特征）。推断不出来的保持 undefined，
 * 由 recordUsage 按 exclusive 处理——沿用 pi-ai 官方语义，
 * 宁可少算缓存，也不凭空放大命中率。
 */
function backfillScope(records: RawRecord[]): void {
  const decided = new Map<ModelKey, InputScope>();
  for (const record of records) {
    if (record.inputScope) decided.set(recordModelKey(record), record.inputScope);
  }

  // 按时间正序推断：同会话上一条的 input 是本轮缓存量的参照上限
  const ordered = records.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const lastInput = new Map<string, number>();
  for (const record of ordered) {
    const key = recordModelKey(record);
    const session = record.session || "";
    if (!record.inputScope) {
      const guessed = decided.get(key)
        ?? detectInputScope(lastInput.get(session) ?? 0, Number(record.cacheRead) || 0);
      if (guessed) {
        record.inputScope = guessed;
        decided.set(key, guessed);
      }
    }
    lastInput.set(session, Number(record.input) || 0);
  }
}

/**
 * 解析一条记录的口径。优先用落盘时判定的 inputScope；
 * 老记录没有该字段时由 backfillScope 在读取阶段补齐。
 */
function resolveScope(record: RawRecord, fallback: InputScope): InputScope {
  return record.inputScope ?? fallback;
}

/**
 * 把一条 raw 记录转成标准 TokenBucket 增量。
 *
 * inclusive 口径（provider 返回的 input 已含缓存）必须在这里拆开还原：
 * 否则下游把 input 当「纯新增」，总 prompt 会把缓存算两遍，命中率被钉在 50%。
 * 归一化后 TokenBucket 的语义全库统一，聚合/展示层都不必再关心口径。
 */
function recordUsage(record: RawRecord, scope?: InputScope): UsageDelta {
  const cacheRead = Number(record.cacheRead) || 0;
  const cacheWrite = Number(record.cacheWrite) || 0;
  const rawInput = Number(record.input) || 0;
  const effective = resolveScope(record, scope ?? "exclusive");
  const input = normalizeInputTokens(rawInput, cacheRead, cacheWrite, effective);
  return {
    input,
    output: Number(record.output) || 0,
    cacheRead,
    cacheWrite,
    turns: 1,
    cost: Number(record.cost) || 0,
  };
}

/** 把逐轮记录聚合成 per-model 明细，按 prompt 用量降序 */
function groupByModel(records: RawRecord[]): ModelUsage[] {
  const map = new Map<ModelKey, ModelUsage>();
  for (const record of records) {
    const modelKey = recordModelKey(record);
    let entry = map.get(modelKey);
    if (!entry) {
      entry = { modelKey, bucket: createEmptyBucket(), sumTokensPerSec: 0 };
      map.set(modelKey, entry);
    }
    addUsageToBucket(entry.bucket, recordUsage(record));
    entry.sumTokensPerSec += Number(record.tokensPerSec) || 0;
  }
  return [...map.values()].sort(
    (a, b) => bucketPromptTokens(b.bucket) - bucketPromptTokens(a.bucket),
  );
}

/** 记录所属日期（ts 为 ISO 字符串，取前 10 位即可） */
function recordDate(record: RawRecord): string {
  return typeof record.ts === "string" && record.ts.length >= 10
    ? record.ts.slice(0, 10)
    : "";
}

/** 按日期分组（时间报表的模型明细行用） */
function groupByDate(records: RawRecord[]): Map<string, ModelUsage[]> {
  const byDate = new Map<string, RawRecord[]>();
  for (const record of records) {
    const date = recordDate(record);
    if (!date) continue;
    const list = byDate.get(date);
    if (list) list.push(record);
    else byDate.set(date, [record]);
  }
  const out = new Map<string, ModelUsage[]>();
  for (const [date, list] of byDate) out.set(date, groupByModel(list));
  return out;
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

async function rebuildFromHistory(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  resetSessionStats();

  // 遍历 entries 按消息自身的 provider/model 归入各自的桶，同时推算历史速率
  let latestAssistantSpeed: number | null = null;
  let latestModelKey: ModelKey | null = null;
  /**
   * 同会话上一轮的原始 prompt 大小（inclusive 口径的参照物）。
   * 增量会话里 cacheRead ≈ 上一轮 prompt，说明 provider 返回的 input 已含缓存。
   */
  let lastPromptInput = 0;

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = (entry as any).message;
    if (msg.role !== "assistant" || !msg.usage) continue;

    // 模型归属以消息自带的为准（历史里可能混了多个模型）
    const modelKey = getModelKey(msg.provider, msg.model);
    const rawInput = msg.usage.input ?? 0;
    const cacheRead = msg.usage.cacheRead ?? 0;
    const cacheWrite = msg.usage.cacheWrite ?? 0;

    // 口径判定：命中缓存后 input 已含缓存 → 扣掉缓存才是纯新增
    const knownScope =
      detectInputScope(lastPromptInput, cacheRead)
      ?? scopeCache.get(modelKey)
      ?? (await modelInputScope(msg.provider ?? "", msg.model ?? ""));
    const scope = knownScope ?? "exclusive";
    if (knownScope) scopeCache.set(modelKey, knownScope);
    const input = normalizeInputTokens(rawInput, cacheRead, cacheWrite, scope);
    lastPromptInput = rawInput;

    const bucket = ensureModelBucket(modelKey);
    addUsageToBucket(bucket, {
      input,
      output: msg.usage.output ?? 0,
      cacheRead,
      cacheWrite,
      turns: 1,
      cost: msg.usage.cost?.total ?? 0,
    });
    latestModelKey = modelKey;

    // 单轮快照无条件记录（命中率与速率无关，无 timestamp 也能算出 CH）
    const turnBucket = createEmptyBucket();
    addUsageToBucket(turnBucket, {
      input,
      output: msg.usage.output ?? 0,
      cacheRead,
      cacheWrite,
      turns: 1,
    });
    let snapshotSpeed = stats.lastTurnByModel.get(modelKey)?.tokensPerSec ?? 0;

    // 推算历史速率：从上一个 user 消息到本条 assistant 的耗时
    if ((msg.usage.output ?? 0) > 0) {
      const endMs = getEntryTimestampMs(entry);
      if (endMs !== null) {
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
          snapshotSpeed = speed;

          if (prevMsg.role === "user") {
            latestAssistantSpeed = speed;
            break;
          }
          // 非 user 消息的 fallback
          if (latestAssistantSpeed === null) latestAssistantSpeed = speed;
        }
      }
    }

    const lastEntryMs = getEntryTimestampMs(entry);
    stats.lastTurnByModel.set(modelKey, {
      ...turnBucket,
      modelKey,
      tokensPerSec: snapshotSpeed,
      cacheHitRate: calcCacheHitRate(turnBucket),
      at: lastEntryMs ?? Date.now(),
    });
  }

  if (latestAssistantSpeed !== null) {
    stats.lastTokensPerSec = latestAssistantSpeed;
  }
  // 恢复后以最后一条 assistant 的模型为激活模型（ctx.model 会在拿完后另做修正）
  stats.activeModelKey = resolveActiveModelKey(ctx) ?? latestModelKey ?? stats.activeModelKey;
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
  { value: "with-balance", label: "月度余额 + 最近倒计时", preview: "$9.96 5h: 89% 7d: 72% ⏱ 4h15m" },
  { value: "with-balance-largest", label: "月度余额 + 倒计时最大单位", preview: "$9.96 5h: 89% ⏱ 4h 7d: 72% ⏱ 2d" },
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
  return typeof v === "string" && ["compact", "with-clock-7d", "nearest-clock-7d", "largest-unit", "with-balance", "with-balance-largest"].includes(v);
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

  // 注意：这里**不能**按 force 清登录退避。force 同时来自 session_start、
  // provider 变化、定时器检测等自动路径（config.ttl 可低至 30s），
  // 一旦被自动 force 反复重置，10 分钟退避形同虚设 —— 表现为每轮刷新都弹一次
  // Chrome 窗口，用户刚要登录就被下一轮 kill 掉。
  // 退避只由用户显式操作（启用/切换套餐 → forceRefreshQuota）清除。

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
  // 用户显式操作（启用/切换套餐）：清掉上次失败的登录退避，
  // 否则刚点完「启用」就被上一次失败的 10 分钟卡住，看起来像没反应。
  // 自动路径（session_start / provider 变化 / 定时器）一律不清。
  resetMimoLoginBackoff();
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

/** 时间窗口聚合记录 → TokenBucket（hourly / daily 共用） */
function periodBucket(d: {
  sumInput: number;
  sumOutput: number;
  sumCacheRead: number;
  sumCacheWrite: number;
  count: number;
  cost?: number;
}): TokenBucket {
  return normalizeBucket({
    input: d.sumInput,
    output: d.sumOutput,
    cacheRead: d.sumCacheRead,
    cacheWrite: d.sumCacheWrite,
    turns: d.count,
    cost: d.cost ?? 0,
  });
}

function fmtRate(hit: number | null, digits = 1): string {
  // 无数据时用同宽占位，保证表格列不错位
  return hit === null ? "     --" : `${hit.toFixed(digits).padStart(5)}%`.padStart(7);
}

/** 时间窗口表格的行前缀（日期或时次）；hideHit=true 时命中率列显示 -- */
function periodRow(
  label: string,
  bucket: TokenBucket,
  sumTokensPerSec: number,
  hideHit = false,
): string {
  const prompt = bucketPromptTokens(bucket);
  const rate = bucket.turns > 0 ? sumTokensPerSec / bucket.turns : 0;
  return (
    `${label}  ` +
    `${String(bucket.turns).padStart(3)}  ` +
    `${formatTokens(bucket.input).padStart(7)}  ` +
    `${formatTokens(bucket.cacheRead).padStart(7)}  ` +
    `${formatTokens(bucket.output).padStart(7)}  ` +
    `${formatTokens(prompt).padStart(7)}  ` +
    `${hideHit ? fmtRate(null) : fmtRate(calcCacheHitRate(bucket))}  ` +
    `${rate.toFixed(1).padStart(5)}`
  );
}

/**
 * 模型名截断：保留末尾而不是开头。
 * 同一家的模型差异常在尾段（MiniMax-M3.1-Flash vs MiniMax-M3.1-Flash-Preview），
 * 截开头会让两个不同模型看起来一模一样。
 */
function truncateModelName(name: string, width: number): string {
  if (name.length <= width) return name;
  return "…" + name.slice(name.length - width + 1);
}

/** 时间窗口下的模型明细行（缩进表示归属关系） */
function modelRow(
  modelKey: ModelKey,
  bucket: TokenBucket,
  sumTokensPerSec: number,
): string {
  const rate = bucket.turns > 0 ? sumTokensPerSec / bucket.turns : 0;
  return (
    `  ↳ ${truncateModelName(modelKey, 34).padEnd(34)}` +
    `${String(bucket.turns).padStart(3)}  ` +
    `${formatTokens(bucket.input).padStart(7)}  ` +
    `${formatTokens(bucket.cacheRead).padStart(7)}  ` +
    `${formatTokens(bucket.output).padStart(7)}  ` +
    `${fmtRate(calcCacheHitRate(bucket))}  ` +
    `${rate.toFixed(1).padStart(5)}`
  );
}

const PERIOD_HEADER = "日期        次数  新增输入  缓存输入  输出      总token   命中率  速率";
const PERIOD_RULE = "─".repeat(70);

/**
 * 把一份时间窗口列表展平为「汇总行 + 模型明细行」。
 * 模型明细来自逐轮记录（modelsByDate），不再依赖聚合文件里的累积字段。
 */
function renderPeriodRows(
  items: { label: string; record: DailyRecord; models?: ModelUsage[] }[],
  withModelBreakdown: boolean,
): string[] {
  const out: string[] = [];
  for (const item of items) {
    const total = periodBucket(item.record);
    const models = item.models ?? [];
    const multiModel = models.length > 1;
    // 多模型时汇总行的命中率是混算值，会误导分析（不同缓存机制不可比），直接隐去
    out.push(periodRow(item.label, total, item.record.sumTokensPerSec, multiModel));
    if (!withModelBreakdown) continue;
    // 只一个模型时不必拆解，避免重复两行
    if (models.length <= 1) continue;
    for (const m of models) out.push(modelRow(m.modelKey, m.bucket, m.sumTokensPerSec));
  }
  return out;
}

/** 汇总多份时间窗口为单个 bucket（合计行用） */
function sumPeriods(records: DailyRecord[]): TokenBucket {
  const total = createEmptyBucket();
  for (const record of records) addUsageToBucket(total, periodBucket(record));
  return total;
}

function renderDaySummary(daily: DailyRecord, models: ModelUsage[]): string {
  const d = daily;
  const total = periodBucket(d);
  const avgInput = total.turns > 0 ? total.input / total.turns : 0;
  const avgOutput = total.turns > 0 ? total.output / total.turns : 0;
  const prompt = bucketPromptTokens(total);
  const hit = calcCacheHitRate(total);
  const rate = total.turns > 0 ? d.sumTokensPerSec / total.turns : 0;

  const lines = [
    `对话次数:  ${total.turns}`,
    `新增输入:  ${formatTokens(total.input)}  (平均 ${formatTokens(avgInput)}/次，未命中缓存)`,
    `缓存输入:  ${formatTokens(total.cacheRead)}`,
    `总输出:    ${formatTokens(total.output)}  (平均 ${formatTokens(avgOutput)}/次)`,
    `总token:   ${formatTokens(prompt)}  (新增 + 缓存)`,
    `缓存命中率: ${hit === null ? "--" : hit.toFixed(1) + "%"}`,
    `平均速率:  ${rate.toFixed(1)} t/s`,
  ];
  // 多模型时按模型拆开：跨模型混算的命中率没有工程意义
  if (models.length > 1) {
    // 上方那个总命中率是混算值，标注清楚避免被当成真实水平
    lines[5] = `缓存命中率: 跨模型混算值 ${hit === null ? "--" : hit.toFixed(1) + "%"}（请以下面明细为准）`;
    lines.push("", "按模型拆分：");
    for (const m of models) lines.push("", ...modelDetailBlock(m));
  }
  return lines.join("\n");
}

/**
 * 单个模型的纵向明细块（每项一行）。
 * 用汉字标签而不是 ↑↓ 符号：符号在中文报表里既不好读也不好对齐。
 */
function modelDetailBlock(m: ModelUsage): string[] {
  const hit = calcCacheHitRate(m.bucket);
  const avgInput = m.bucket.turns > 0 ? m.bucket.input / m.bucket.turns : 0;
  const avgOutput = m.bucket.turns > 0 ? m.bucket.output / m.bucket.turns : 0;
  const rate = m.bucket.turns > 0 ? m.sumTokensPerSec / m.bucket.turns : 0;
  return [
    `模型:      ${m.modelKey}`,
    `对话次数:  ${m.bucket.turns}`,
    `新增输入:  ${formatTokens(m.bucket.input)}  (平均 ${formatTokens(avgInput)}/次)`,
    `缓存输入:  ${formatTokens(m.bucket.cacheRead)}`,
    `总输出:    ${formatTokens(m.bucket.output)}  (平均 ${formatTokens(avgOutput)}/次)`,
    `总token:   ${formatTokens(bucketPromptTokens(m.bucket))}  (新增 + 缓存)`,
    `缓存命中率: ${hit === null ? "--" : hit.toFixed(1) + "%"}`,
    `平均速率:  ${rate.toFixed(1)} t/s`,
  ];
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

/**
 * 用系统默认浏览器打开一个本地路径。
 * 各平台都有现成的“打开”命令，不必像配额登录那样去探测 Chrome 路径。
 * 失败不抛错（例如无头环境），由调用方决定怎么提示。
 */
function openInBrowser(targetPath: string): boolean {
  const opts = { stdio: "ignore" as const, detached: true };
  // 用 file:// URL 而不是裸路径：Windows 路径常带空格，
  // URL 形式已被编码，不需再处理引号，也不会被重新拼成命令行。
  const url = pathToFileURL(targetPath).href;
  try {
    let child: ReturnType<typeof spawn>;
    if (process.platform === "win32") {
      // rundll32 比 cmd /c start 少一层 shell 解析，也没有 explorer 那种“成功也返回 1”的歧义
      child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        ...opts,
        windowsHide: true,
      });
    } else if (process.platform === "darwin") {
      child = spawn("open", [targetPath], opts);
    } else {
      child = spawn("xdg-open", [targetPath], opts);
    }
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 清除历史统计数据。
 *
 * 为什么不做成网页里的按钮：报表是 file:// 本地页面，浏览器受同源策略限制
 * 无法删除磁盘文件；要让「点一下就删」生效必须额外起一个本地服务，
 * 为一个低频操作多养一个端口不划算，因此入口放在 pi 的菜单里。
 */
async function purgeData(ctx: ExtensionContext, pi: ExtensionAPI) {
  const theme = ctx.ui.theme;

  const dates = await listAllDates();
  if (!dates.length) {
    ctx.ui.notify("没有可清除的统计数据", "info");
    return;
  }
  const today = getDateStr();
  const earliest = dates[0]!;

  // 1. 选择范围
  const mode = await ctx.ui.select("清除历史统计", [
    `最近 7 天（${getDateStr(Date.now() - 6 * 86400000)} ~ ${today}）`,
    `最近 30 天（${getDateStr(Date.now() - 29 * 86400000)} ~ ${today}）`,
    `最近 90 天（${getDateStr(Date.now() - 89 * 86400000)} ~ ${today}）`,
    `指定日期区间`,
    `全部历史数据（${earliest} ~ ${today}，共 ${dates.length} 天）`,
  ]);
  if (!mode) return;

  let from = earliest;
  let to = today;
  if (mode.startsWith("最近 7 天")) from = getDateStr(Date.now() - 6 * 86400000);
  else if (mode.startsWith("最近 30 天")) from = getDateStr(Date.now() - 29 * 86400000);
  else if (mode.startsWith("最近 90 天")) from = getDateStr(Date.now() - 89 * 86400000);
  else if (mode.startsWith("指定")) {
    const picked = await pickDateRange(ctx, earliest, today);
    if (!picked) return;
    from = picked.from;
    to = picked.to;
  }

  // 2. 先算清楚要删什么，再让用户确认
  const plan = await planPurge({ from, to });
  if (isEmpty(plan)) {
    ctx.ui.notify(`${from} ~ ${to} 之间没有统计数据`, "info");
    return;
  }

  const summary = [
    theme.fg("accent", theme.bold("即将删除")),
    "",
    `  区间      ${from} ~ ${to}`,
    `  涉及天数  ${plan.dates.length} 天（${plan.dates[0]} ~ ${plan.dates[plan.dates.length - 1]}）`,
    `  逐轮明细  ${plan.rawFiles.length} 个文件`,
    `  小时聚合  ${plan.hourlyFiles.length} 个文件`,
    `  日聚合    ${plan.dailyDates.length} 条${plan.dropDailyFile ? "（整个文件删除）" : ""}`,
    `  合计体积  ${formatBytes(plan.bytes)}`,
    "",
    theme.fg("warning", "  删除后无法恢复。"),
  ].join("\n");

  const ok = await ctx.ui.confirm("确认清除统计数据", summary);
  if (!ok) return;

  // 3. 执行
  const result = await runPurge(plan);

  const lines = [
    theme.fg(result.failures.length ? "warning" : "accent", theme.bold("清除完成")),
    "",
    `  删除文件  ${result.removedFiles} 个`,
    `  删除天数  ${result.removedDays} 天`,
    `  释放空间  ${formatBytes(result.bytes)}`,
  ];
  if (result.failures.length) {
    lines.push("", theme.fg("error", `  ${result.failures.length} 项失败：`));
    for (const f of result.failures.slice(0, 5)) lines.push(theme.fg("dim", `    ${f}`));
    if (result.failures.length > 5) {
      lines.push(theme.fg("dim", `    …另有 ${result.failures.length - 5} 项`));
    }
  }
  lines.push("", theme.fg("dim", "  下次查询会按剩余数据重新统计"));

  pi.sendMessage({ customType: "token-stats", content: lines.join("\n"), display: true });
}

/** 手输日期区间，任一端为空或格式不对就返回 null */
async function pickDateRange(
  ctx: ExtensionContext,
  earliest: string,
  today: string,
): Promise<{ from: string; to: string } | null> {
  const from = (await ctx.ui.input(`起始日期（YYYY-MM-DD，不早于 ${earliest}）`, earliest))?.trim();
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
  const to = (await ctx.ui.input(`结束日期（YYYY-MM-DD，不晚于 ${today}）`, today))?.trim();
  if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * 网页视图：重新生成数据文件，然后用系统浏览器打开固定模板。
 *
 * 不再依赖终端超链接：实测 Tabby 等终端不支持 OSC 8，ctrl+click 无反应。
 * 改为直接开浏览器；即使打开失败也会把路径打出来，可手动复制。
 */
async function showHtmlReport(ctx: ExtensionContext, pi: ExtensionAPI) {
  const theme = ctx.ui.theme;
  let result: Awaited<ReturnType<typeof writeReportData>>;
  try {
    result = await writeReportData();
  } catch (error) {
    ctx.ui.notify(
      `生成网页数据失败：${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  const url = pathToFileURL(REPORT_HTML_PATH).href;
  const opened = openInBrowser(REPORT_HTML_PATH);
  const sizeKb = Math.round(result.bytes / 1024);

  // 顺手拉起本地服务并开始定时统计：页面顶部据此显示服务状态
  const srv = await ensureStatsServer(pi, (msg) => ctx.ui.notify(msg, "warning"));
  if (srv) srv.start();

  const serviceLine = srv
    ? theme.fg("dim", `  服务：${statsServerUrl}（每 1 分钟自动统计，页面可停）`)
    : theme.fg("warning", "  服务未启动，页面只能看历史数据");

  const text = [
    theme.fg("accent", theme.bold("Token 统计  |  网页视图")),
    theme.fg("dim", "─".repeat(42)),
    "",
    opened ? `  已在浏览器中打开` : theme.fg("warning", "  打开浏览器失败，请手动复制下面的路径"),
    "",
    theme.fg("dim", `  ${url}`),
    serviceLine,
    theme.fg("dim", `  数据：${result.days} 天 / ${result.turns} 轮 / ${result.files} 个日志 / ${sizeKb} KB`),
    theme.fg("dim", "  之后每轮对话结束会自动重建「当天」分片，页面点刷新即可看到新数据"),
  ].join("\n");

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

  // 模型明细从逐轮明细现算，不依赖聚合文件里的累积字段
  const models = groupByModel(await loadRawRecords(date, date));

  await showStats(
    renderDaySummary(daily, models).split("\n"),
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

  // 按小时拆模型明细：逐轮记录自带 ts，先按小时分组再归类
  const rawByHour = new Map<number, RawRecord[]>();
  for (const record of await loadRawRecords(date, date)) {
    const hour = new Date(record.ts).getHours();
    const list = rawByHour.get(hour);
    if (list) list.push(record);
    else rawByHour.set(hour, [record]);
  }

  const lines = [
    PERIOD_HEADER,
    PERIOD_RULE,
    ...renderPeriodRows(
      records.map((r) => ({
        label: String(r.hour).padStart(2, "0"),
        record: r as unknown as DailyRecord,
        models: groupByModel(rawByHour.get(r.hour) ?? []),
      })),
      true,
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

  const modelsByDate = groupByDate(await loadRawRecords(sevenDaysAgo, today));

  const lines = [
    PERIOD_HEADER,
    PERIOD_RULE,
    ...renderPeriodRows(
      weekRecords.map((r) => ({ label: r.date, record: r, models: modelsByDate.get(r.date) })),
      true,
    ),
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

  const total = sumPeriods(monthlyRecords);
  const totalPerSec = monthlyRecords.reduce((sum, r) => sum + r.sumTokensPerSec, 0);
  // 全年模型明细：按月对逐轮记录归类
  const raw = await loadRawRecords(`${year}-01-01`, `${year}-12-31`);
  const rawByMonth = new Map<string, RawRecord[]>();
  for (const record of raw) {
    const month = recordDate(record).slice(0, 7);
    if (!month) continue;
    const list = rawByMonth.get(month);
    if (list) list.push(record);
    else rawByMonth.set(month, [record]);
  }
  const allModels = groupByModel(raw);
  // 合计行跨月聚合，模型往往不止一个 → 命中率不混算

  const lines = [
    PERIOD_HEADER,
    PERIOD_RULE,
    ...renderPeriodRows(
      monthlyRecords.map((r) => ({
        label: r.date.padEnd(9),
        record: r,
        models: groupByModel(rawByMonth.get(r.date) ?? []),
      })),
      true,
    ),
    "",
    periodRow("合计     ", total, totalPerSec, allModels.length > 1),
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
  const total = sumPeriods(monthRecords);
  const totalPerSec = monthRecords.reduce((sum, r) => sum + r.sumTokensPerSec, 0);
  // 该月模型明细：逐轮记录按日期归类
  const raw = await loadRawRecords(`${month}-01`, `${month}-31`);
  const modelsByDate = groupByDate(raw);
  const allModels = groupByModel(raw);

  const lines = [
    PERIOD_HEADER,
    PERIOD_RULE,
    ...renderPeriodRows(
      monthRecords.map((r) => ({ label: r.date, record: r, models: modelsByDate.get(r.date) })),
      true,
    ),
    "",
    // 合计行跨天聚合，模型往往不止一个 → 命中率不混算
    periodRow("合计     ", total, totalPerSec, allModels.length > 1),
  ];

  await showStats(lines, `${month} 月度汇总`, ctx, pi);
}

/**
 * 按模型归类汇总：区间内各模型的轮数 / 输入 / 缓存 / 输出 / 真实命中率 / token 占比。
 * 数据源是逐轮明细（raw），所以任何时候查都不用等聚合累积。
 * 跨模型汇总行不显示命中率（不同缓存机制混算没有意义）。
 */
async function showByModel(
  from: string,
  to: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) {
  const records = await loadRawRecords(from, to);
  if (records.length === 0) {
    ctx.ui.notify(`${from} ~ ${to} 暂无逐轮明细（该区间没有新日志）`, "info");
    return;
  }

  const rows = groupByModel(records);
  // 逐轮明细里没有可用模型信息时，单独提示，避免被当成统计坏掉
  const onlyLegacy = rows.length === 1 && rows[0].modelKey === UNKNOWN_MODEL_KEY;

  const grand = createEmptyBucket();
  for (const row of rows) addUsageToBucket(grand, row.bucket);
  const grandPrompt = bucketPromptTokens(grand);

  const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
  const lines = [
    "模型                          次数  新增输入  缓存输入  输出      占比    命中率",
    "─".repeat(78),
    ...rows.map((row) => {
      const prompt = bucketPromptTokens(row.bucket);
      const share = grandPrompt > 0 ? (prompt / grandPrompt) * 100 : 0;
      return (
        truncateModelName(row.modelKey, 28).padEnd(28) + "  " +
        `${String(row.bucket.turns).padStart(3)}  ` +
        `${formatTokens(row.bucket.input).padStart(7)}  ` +
        `${formatTokens(row.bucket.cacheRead).padStart(7)}  ` +
        `${formatTokens(row.bucket.output).padStart(7)}  ` +
        `${share.toFixed(1).padStart(5)}%  ` +
        `${fmtRate(calcCacheHitRate(row.bucket))}`
      );
    }),
    "─".repeat(78),
    pad("合计（命中率不跨模型统计）", 28) + "  " +
    `${String(grand.turns).padStart(3)}  ` +
    `${formatTokens(grand.input).padStart(7)}  ` +
    `${formatTokens(grand.cacheRead).padStart(7)}  ` +
    `${formatTokens(grand.output).padStart(7)}  ` +
    `${(grandPrompt > 0 ? 100 : 0).toFixed(1).padStart(5)}%  ${fmtRate(null)}`,
  ];

  await showStats(
    onlyLegacy
      ? [...lines, "", `注：该区间 ${records.length} 条记录未带模型信息，无法按模型归类`]
      : lines,
    `按模型归类  |  ${from} ~ ${to}`,
    ctx,
    pi,
  );
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

  // ── model_select: 切换模型后立即切到目标模型的统计 ──
  // KV Cache 按 provider+model 隔离：不切换口径的话，新模型首轮会沿用旧模型的
  // cacheRead 算出「虚假高命中率」。切回用过的模型则自动恢复它自己的历史值。
  pi.on("model_select", async (event) => {
    const m = event?.model;
    const nextKey = m ? getModelKey(m.provider, m.id) : stats.activeModelKey;
    if (!nextKey || nextKey === stats.activeModelKey) {
      requestFooterRender?.();
      return;
    }
    stats.activeModelKey = nextKey;
    // 新模型先建空桶：CH% 显示为无数据（--）而不是 0%
    if (!hasHistory(nextKey)) ensureModelBucket(nextKey);
    // 速率/延迟也属于上一个模型的观测值，切模型后不应用来误导当前模型
    stats.lastTokensPerSec = stats.lastTurnByModel.get(nextKey)?.tokensPerSec ?? 0;
    stats.lastFirstTokenLatency = 0;
    requestFooterRender?.();
  });

  pi.on("turn_start", async (_event, ctx) => {
    stats.turnStartTime = Date.now();
    stats.firstTokenTime = 0;
    stats.streaming = false;

    // 兜底同步激活模型（model_select 可能因恢复历史/子会话而未触发）
    if (ctx.model?.provider || ctx.model?.id) {
      stats.activeModelKey = getModelKey(ctx.model.provider, ctx.model.id);
    }

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
    // 模型归属：以响应消息自身的 provider/model 为准（异步任务/子会话可能用别的模型），
    // 兜底才用当前激活模型，避免串账
    const provider = assistantMsg.provider || ctx.model?.provider || "unknown";
    const modelId = assistantMsg.model || ctx.model?.id || "unknown";
    const modelKey = getModelKey(provider, modelId);
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";

    // 口径判定：provider 返回的 input 可能已含缓存（inclusive）。
    // 必须先归一成「纯新增」再入桶，否则命中率分母会把缓存算两遍，
    // CH% 被永久钉在 50% 附近（真实值可能 99%）。
    const knownScope = await resolveUsageScope(provider, modelId, sessionId, usage.cacheRead ?? 0);
    const scope = knownScope ?? "exclusive";
    const input = normalizeInputTokens(
      usage.input ?? 0,
      usage.cacheRead ?? 0,
      usage.cacheWrite ?? 0,
      scope,
    );

    // 单轮增量先落成一个桶，命中率统一走 calcCacheHitRate（分母为 0 时为 null）
    const turnBucket = createEmptyBucket();
    addUsageToBucket(turnBucket, {
      input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      turns: 1,
      cost: usage.cost?.total ?? 0,
    });
    const cacheHitRate = calcCacheHitRate(turnBucket);
    // 花费
    const cost = usage.cost?.total ?? 0;

    // 更新本轮精确值（仅保留展示用的速率/延迟类字段）
    stats.lastTokensPerSec = tokensPerSec;
    stats.lastLiveTokenSpeed = liveSpeed;
    stats.lastFirstTokenLatency = firstTokenLatency;
    stats.streaming = false;

    // 按模型入账 + 全会话汇总
    const bucket = ensureModelBucket(modelKey);
    addUsageToBucket(bucket, turnBucket);
    stats.lastTurnByModel.set(modelKey, {
      ...turnBucket,
      modelKey,
      tokensPerSec,
      cacheHitRate,
      at: Date.now(),
    });
    // 单轮消耗归入它自己的模型桶（异步任务/队列可能用别的模型，不能串账）；
    // 但 footer 的激活模型以 ctx.model 为准 —— 它才是右侧显示的那个模型，
    // 否则异步响应会让 CH% 悄悄跳到别的模型上。
    stats.activeModelKey = resolveActiveModelKey(ctx) ?? modelKey;

    requestFooterRender?.();

    // 持久化（raw 保留 provider 原始口径 + inputScope，由读取阶段负责归一）
    await persistTurn({
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      tokensPerSec,
      cacheHitRate: cacheHitRate ?? 0,
      model: `${provider}/${modelId}`,
      firstTokenLatency,
      wordCount,
      cost,
      liveTokenSpeed: liveSpeed,
    }, sessionId, provider, modelId, knownScope ?? undefined);

    // 重置 live 状态
    resetLiveState();
  });

  // ── agent_end: 整个对话结束，确保最终状态刷新 ────────

  pi.on("agent_end", async (_event, ctx) => {
    stats.streaming = false;
    resetLiveState();
    requestFooterRender?.();
    scheduleShardRebuild();
  });

  // ── session_shutdown: 清理跨 session 资源（定时器 / footer 引用）───────

  pi.on("session_shutdown", async (_event, _ctx) => {
    // session 替换（/new /resume /fork）或 /reload 时旧 ctx 会失效，
    // 必须在此清掉旧实例的定时器与闭包引用，否则定时器回调访问旧 ctx
    // 会抛 "extension ctx is stale" 导致 pi 崩溃退出。
    // 注意：reload 会重新执行本文件（全新实例、quotaTimerId 为 null），
    // 所以只有这里能清掉旧实例的定时器，不能依赖 session_start 里的清理。
    sessionActive = false;
    resetSessionStats();
    // 不保留上一个会话的模型指针：新 session 由重放/ctx 重新确定
    stats.activeModelKey = null;
    sessionStartedAt = 0;
    if (quotaTimerId) {
      clearInterval(quotaTimerId);
      quotaTimerId = null;
    }
    // 本地服务随 session 一起停：/reload 时旧实例必须让出端口，
    // 否则新实例 listen 会 EADDRINUSE，页面右上角一直显示「服务未运行」
    if (statsServer) {
      void statsServer.close().catch(() => {});
      statsServer = null;
      statsServerUrl = "";
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
    await rebuildFromHistory(ctx);
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
    description: "Token 统计与网页报表",
    handler: async (args, ctx) => {
      let arg = args.trim();
      const fromMainMenu = !arg;

      mainMenu: while (true) {
        // 无参 → 主菜单：统计查询不再需要记参数，套餐/配置入口也在这里
        if (!arg) {
          const main = await ctx.ui.select("Token 统计", [
            "统计查询",
            "状态栏配置",
            "套餐配额配置",
            "清除历史统计",
          ]);
          if (!main) return;
          if (main === "清除历史统计") {
            await purgeData(ctx, pi);
            return;
          }
          if (main === "统计查询") {
            // 统计查询直接出网页报表并开浏览器，选中即结束，不回主菜单
            // （网页已覆盖日/周/月/年所有查询维度，终端不再另列表格入口）
            await showHtmlReport(ctx, pi);
            return;
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
      } else if (arg === "models" || arg === "model") {
        // 按模型归类：默认最近 7 天
        await showByModel(
          getDateStr(Date.now() - 7 * 24 * 60 * 60 * 1000),
          getDateStr(),
          ctx,
          pi,
        );
      } else if (arg.startsWith("models ")) {
        const range = arg.slice(7).trim().split(/\s+/);
        const from = range[0] ?? getDateStr();
        const to = range[1] ?? getDateStr();
        if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
          await showByModel(from, to, ctx, pi);
        } else {
          ctx.ui.notify("用法: /stats models [from] [to]（YYYY-MM-DD）", "warning");
        }
      } else if (arg === "html" || arg === "web" || arg === "report") {
        await showHtmlReport(ctx, pi);
      } else if (arg === "clear" || arg === "purge") {
        await purgeData(ctx, pi);
        return;
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
          "用法: /stats [day [date] | hour [date] | week | month [YYYY-MM] | year [YYYY] | models [from] [to] | html | config]",
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
