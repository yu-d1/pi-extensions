/**
 * 状态栏统一格式化层
 * =============================================================================
 * footer 状态栏、/stats 报告、配置面板预览共用同一套数字格式：
 * 同一个数值在任何地方显示都一致，精度由 DisplayConfig.precision 统一控制。
 * 绝不打印 NaN / undefined：缺失一律 "--"。
 */

/** token 精度：auto 随量级自适应（<1k 原值、k/M 档自动切小数），0/1 为固定档位 */
export type TokenPrecision = "auto" | 0 | 1;

// ── 分模型统计：TokenBucket 与命中率口径 ─────────────────────────────────
// KV Cache 在服务端严格按 provider + model 分区，跨模型混算会让「切换模型后的
// 首轮冷启动」沿用旧模型的高命中率，并把不支持缓存的模型永久拖在分母里。
// 因此累计量一律按 ModelKey 分桶，命中率只允许通过 calcCacheHitRate(bucket) 计算。

/** 模型唯一标识：`provider/modelId` */
export type ModelKey = string;

/** 历史日志缺失模型字段时的兜底桶 */
export const UNKNOWN_MODEL_KEY: ModelKey = "unknown/legacy";

/** 一个模型（或一个时间窗口内的一个模型）的 token 累计量 */
export interface TokenBucket {
  /** 未命中缓存的输入 token */
  input: number;
  /** 输出 token */
  output: number;
  /** 缓存命中读取 token */
  cacheRead: number;
  /** 缓存写入（创建）token */
  cacheWrite: number;
  /** 请求轮数 */
  turns: number;
  /** 预估费用 */
  cost: number;
}

/** 单轮消耗增量（字段缺省按 0 处理） */
export interface UsageDelta {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  turns?: number;
  cost?: number;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 拼接模型键；provider 与 model 都缺失时归入 legacy 桶 */
export function getModelKey(provider?: string | null, model?: string | null): ModelKey {
  const p = (provider ?? "").trim();
  const m = (model ?? "").trim();
  if (!p && !m) return UNKNOWN_MODEL_KEY;
  return `${p || "unknown"}/${m || "unknown"}`;
}

/** 拆回 provider / model（model 名本身可能带 "/"） */
export function splitModelKey(key: ModelKey): { provider: string; model: string } {
  const idx = key.indexOf("/");
  if (idx < 0) return { provider: "unknown", model: key };
  return { provider: key.slice(0, idx), model: key.slice(idx + 1) };
}

export function createEmptyBucket(): TokenBucket {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 };
}

/** 补齐字段（读取旧日志 / 旧配置时可能出现缺失项） */
export function normalizeBucket(raw: Partial<TokenBucket> | null | undefined): TokenBucket {
  return {
    input: toCount(raw?.input),
    output: toCount(raw?.output),
    cacheRead: toCount(raw?.cacheRead),
    cacheWrite: toCount(raw?.cacheWrite),
    turns: toCount(raw?.turns),
    cost: toCount(raw?.cost),
  };
}

/** 原地累加：单轮入账、会话汇总、时间窗口聚合共用同一套逻辑 */
export function addUsageToBucket(target: TokenBucket, delta: UsageDelta | null | undefined): void {
  target.input += toCount(delta?.input);
  target.output += toCount(delta?.output);
  target.cacheRead += toCount(delta?.cacheRead);
  target.cacheWrite += toCount(delta?.cacheWrite);
  target.turns += toCount(delta?.turns);
  target.cost += toCount(delta?.cost);
}

/**
 * 输入口径：`input` 字段到底含不含缓存。两种口径都要支持。
 *
 * OpenAI 通道的适配器会主动做减法（input = prompt_tokens - cached_tokens），
 * 所以那边 input 是「纯新增」。但 Anthropic 兼容端点只是原样透传 provider 的
 * input_tokens，遵不遵守规范取决于服务端——实测 minimax 与 commandcodego
 * 返回的 input_tokens 已经包含缓存，这时再与 cacheRead 相加就会把缓存算两遍，
 * 命中率被永久钉在 50% 附近（真实值可能是 99%）。
 */
export type InputScope = "exclusive" | "inclusive";

/**
 * 判定口径。依据是「cacheRead ≈ 上一轮的 input」：
 *   - input 含缓存时，本轮能命中的正是上一轮整个 prompt，比值≈1
 *   - input 是纯新增时，缓存命中量远大于本轮新增，比值远大于 1 或毫无规律
 * 无法判定（轮数不足 / 从没命中过）时返回 undefined，由调用方决定默认值。
 */
export function detectInputScope(prevInput: number, cacheRead: number): InputScope | undefined {
  if (prevInput <= 0 || cacheRead <= 0) return undefined;
  const ratio = cacheRead / prevInput;
  return ratio > 0.8 && ratio < 1.25 ? "inclusive" : "exclusive";
}

/**
 * prompt token 总量：命中率的分母，也是账单侧的「总输入」。
 * inclusive 口径下 input 已含缓存，不能重复相加。
 */
export function bucketPromptTokens(
  bucket: TokenBucket | null | undefined,
  scope: InputScope = "exclusive",
): number {
  if (!bucket) return 0;
  const input = toCount(bucket.input);
  const cache = toCount(bucket.cacheRead) + toCount(bucket.cacheWrite);
  return scope === "inclusive" ? input : input + cache;
}

/**
 * 缓存命中率（百分比）：cacheRead / 总输入。分母为 0 返回 null，
 * 由调用方显示 "--" 或隐藏该段。
 */
export function calcCacheHitRate(
  bucket: TokenBucket | null | undefined,
  scope: InputScope = "exclusive",
): number | null {
  const total = bucketPromptTokens(bucket, scope);
  if (total <= 0) return null;
  return (toCount(bucket?.cacheRead) / total) * 100;
}

function clampDigits(d: unknown, allowed: readonly number[], dflt: number): number {
  return typeof d === "number" && allowed.includes(d) ? d : dflt;
}

/** token 数：1234 → auto "1.2k" / 0 "1k" / 1 "1.2k"；12345 → auto "12k" */
export function formatTokens(count: number, precision: TokenPrecision = "auto"): string {
  const n = Number(count);
  if (!Number.isFinite(n)) return "--";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) {
    const fixed = precision === 1;
    return sign + (fixed ? abs.toFixed(1) : String(Math.round(abs)));
  }
  if (abs < 1_000_000) return sign + formatScaled(abs / 1000, precision) + "k";
  return sign + formatScaled(abs / 1_000_000, precision) + "M";
}

function formatScaled(v: number, precision: TokenPrecision): string {
  if (precision === 0) return String(Math.round(v));
  if (precision === 1) return v.toFixed(1);
  return v < 10 ? v.toFixed(1) : String(Math.round(v)); // auto
}

/** 百分比：value 为 0-100 的数值 */
export function formatPercent(value: number, digits: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${n.toFixed(clampDigits(digits, [0, 1, 2], 1))}%`;
}

/** 速率：digits=1 时低速给两位小数、中速一位、高速取整（103 而不是 103.0） */
export function formatSpeed(tokensPerSecond: number, digits: number): string {
  const n = Number(tokensPerSecond);
  if (!Number.isFinite(n) || n <= 0) return "--";
  const d = clampDigits(digits, [0, 1, 2], 1);
  if (d === 0) return String(Math.round(n));
  if (d === 1) return n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : String(Math.round(n));
  return n.toFixed(2);
}

/** 金额：$0.12 / ¥12.34 */
export function formatAmount(value: number, digits: number, currency: "$" | "¥" = "$"): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return currency + n.toFixed(clampDigits(digits, [1, 2], 2));
}

/** 时长：2d 3h / 2d / 1h 12m / 45m / 30s（配额倒计时与会话时长共用） */
export function formatDuration(ms: number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "--";
  const totalSec = Math.floor(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  // 超过一天优先用天（周配额的倒计时常有 48h 这种，写成 2d 更直观）
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const restH = h % 24;
    if (restH > 0) return m > 0 ? `${d}d ${restH}h ${m}m` : `${d}d ${restH}h`;
    return m > 0 ? `${d}d ${m}m` : `${d}d`;
  }
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** 时长（只显示最大单位）：6d / 4h / 50m / 45s —— 倒计时嵌在状态栏里用，最省地方 */
export function formatDurationLargest(ms: number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const totalSec = Math.floor(n / 1000);
  const d = Math.floor(totalSec / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) return `${h}h`;
  const m = Math.floor((totalSec % 3600) / 60);
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

/** 首 token 延迟：<10s 用毫秒，更长用时长 */
export function formatLatency(ms: number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "--";
  return n < 10_000 ? `${Math.round(n)}ms` : formatDuration(n);
}
