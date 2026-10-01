/**
 * 套餐配额查询 —— 公共类型与格式化
 * =============================================================================
 * TokenPlan 契约（各套餐实现的唯一约定）、展示格式化、颜色阈值、静默错误标记。
 * 各套餐实现见 minimax.ts / glm.ts / kimi.ts / deepseek.ts / mimo.ts，
 * 汇总清单见 index.ts。
 */

export type QuotaColor = "ok" | "warn" | "err";

/** 配额展示样式（对应展示配置里的 quotaStyle） */
export type QuotaStyle = "compact" | "with-clock-7d" | "nearest-clock-7d";

export interface TokenPlan {
  id: string;
  name: string;
  matchProviders: string[];
  apiKeyEnv: string;
  /** 凭据来自登录态（网页登录 Cookie 等），而非环境变量 API key。 */
  needsLogin?: boolean;
  /** 登录态套餐的凭据读取（各套餐自备，如读 cookie 文件）；空则视为无凭据。 */
  readCredential?: () => string | null;
  baseUrl: string;
  quotaPath: string;
  authHeader: (key: string) => Record<string, string>;
  fetchQuota: (plan: TokenPlan, key: string) => Promise<any>;
  /** style 来自用户当前的展示配置，由调用方（index）注入 */
  format: (data: any, style: QuotaStyle) => { modelPrefix: string; display: string; color: QuotaColor };
}

/** 标记为静默错误：调用方遇到它直接隐藏该段，不在 footer 报错 */
export function silentError(message: string): Error {
  return Object.assign(new Error(message), { silent: true });
}

/** 剩余百分比 → 颜色阈值（<20 红、<50 黄、其余绿） */
export function quotaColor(intervalRemaining: number, weeklyRemaining: number): QuotaColor {
  return intervalRemaining < 20 || weeklyRemaining < 20
    ? "err"
    : intervalRemaining < 50 || weeklyRemaining < 50
      ? "warn"
      : "ok";
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const mins = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatTokenPlanDisplay(
  intervalRemaining: number,
  weeklyRemaining: number,
  intervalResetMs?: number | null,
  weeklyResetMs?: number | null,
  style: QuotaStyle = "with-clock-7d",
): string {
  const formatPercent = (value: number) => `${Math.round(value)}%`;
  const formatClock = (resetMs?: number | null) => {
    if (!resetMs || resetMs <= 0) return "";
    const diff = resetMs - Date.now();
    return diff > 0 && diff < 30 * 24 * 60 * 60 * 1000
      ? ` ⏱ ${formatDuration(diff)}`
      : "";
  };
  const interval = `5h: ${formatPercent(intervalRemaining)}`;
  const weeklyLabel = "7d";
  const weekly = `${weeklyLabel}: ${formatPercent(weeklyRemaining)}`;
  if (style === "compact") return `${interval} ${weekly}`;
  if (style === "nearest-clock-7d") {
    const resets = [intervalResetMs, weeklyResetMs].filter(
      (value): value is number => typeof value === "number" && value > Date.now(),
    );
    const nearest = resets.length > 0 ? Math.min(...resets) : null;
    const clock = formatClock(nearest);
    return `${interval} ${weekly}${clock}`;
  }
  const intervalClock = formatClock(intervalResetMs);
  const weeklyClock = formatClock(weeklyResetMs);
  return `${interval}${intervalClock} ${weekly}${weeklyClock}`;
}
