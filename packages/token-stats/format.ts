/**
 * 状态栏统一格式化层
 * =============================================================================
 * footer 状态栏、/stats 报告、配置面板预览共用同一套数字格式：
 * 同一个数值在任何地方显示都一致，精度由 DisplayConfig.precision 统一控制。
 * 绝不打印 NaN / undefined：缺失一律 "--"。
 */

/** token 精度：auto 随量级自适应（<1k 原值、k/M 档自动切小数），0/1 为固定档位 */
export type TokenPrecision = "auto" | 0 | 1;

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
