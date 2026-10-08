/**
 * 套餐配额查询 —— Command Code（GO 套餐）
 * /alpha/billing/credits：5h / 7d 用量窗口 + 月度余额。
 *
 * 凭据说明：GO 登录写入 auth.json 的 commandcodego 条目，
 * access 与 refresh 是同一个长期 key（expires 在十年后），不是真正的 OAuth，
 * 因此无需像 kimi 那样自行刷新 token，resolveApiKey 的 2a 分支直接可用。
 */

import type { TokenPlan } from "./shared";
import { formatTokenPlanDisplay, quotaColor } from "./shared";

/** credits 响应里的一扇用量窗口 */
interface WindowEntry {
  used: number;
  cap: number;
  exceeded?: boolean;
  resetAt?: number;
}

/** 把一扇窗口换算成「剩余百分比 + 重置时间戳（毫秒）」
 *  cap <= 0 或字段缺失时返回 null（视为无数据，调用方跳过该段） */
function parseWindow(raw: unknown): { remaining: number; resetMs: number | null } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as WindowEntry;
  if (typeof w.used !== "number" || typeof w.cap !== "number") return null;
  // cap 为 0 表示不限量（unlimited），不算「无数据」，但也没有百分比可言
  if (!(w.cap > 0)) return null;
  const remaining = Math.max(0, Math.min(100, (1 - w.used / w.cap) * 100));
  // resetAt 是毫秒时间戳；过期的不展示（formatTokenPlanDisplay 也会再过滤一次）
  const resetMs = typeof w.resetAt === "number" && w.resetAt > Date.now() ? w.resetAt : null;
  return { remaining, resetMs };
}

/** 月度余额 = monthly + purchased + free（沿用官方 CLI 的算法） */
function parseBalance(data: any): { amount: number; digits: number } | null {
  const c = data?.credits;
  if (typeof c !== "object" || c === null) return null;
  const parts = [c.monthlyCredits, c.purchasedCredits, c.freeCredits].map((v) =>
    typeof v === "number" && isFinite(v) ? v : 0,
  );
  const amount = parts.reduce((a, b) => a + b, 0);
  if (!(amount > 0)) return null;
  return { amount, digits: 0 }; // digits 由 format 阶段用 ctx.amountDigits 覆盖
}

export const commandCodeGoPlan: TokenPlan = {
  id: "commandcodego",
  name: "Command Code (GO 套餐)",
  matchProviders: ["commandcodego"],
  /** 凭据在 auth.json（pi 的 /login 写入），没有对应的环境变量 */
  apiKeyEnv: "",
  baseUrl: "https://api.commandcode.ai",
  quotaPath: "/alpha/billing/credits",
  authHeader: (key) => ({ Authorization: "Bearer " + key, Accept: "application/json" }),
  fetchQuota: async (plan: TokenPlan, key: string) => {
    const r = await fetch(plan.baseUrl + plan.quotaPath, {
      method: "GET",
      headers: plan.authHeader(key),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error("Command Code 配额查询 HTTP " + r.status);
    return await r.json();
  },
  format: (data, ctx) => {
    const limits = typeof data?.windowLimits === "object" && data.windowLimits !== null
      ? data.windowLimits
      : {};
    const fiveHour = parseWindow(limits.fiveHour);
    const weekly = parseWindow(limits.weekly);
    // 两扇窗口都没有 → 无限制/无数据
    if (!fiveHour && !weekly) return { modelPrefix: "", display: "无数据", color: "err" };
    // 缺哪扇用 100% 占位（不限制），另一扇照常显示
    const intervalRemaining = fiveHour?.remaining ?? 100;
    const weeklyRemaining = weekly?.remaining ?? 100;
    const rawBalance = parseBalance(data);
    const balance = rawBalance ? { amount: rawBalance.amount, digits: ctx.amountDigits } : null;
    return {
      modelPrefix: "",
      display: formatTokenPlanDisplay(
        intervalRemaining,
        weeklyRemaining,
        fiveHour?.resetMs ?? null,
        weekly?.resetMs ?? null,
        ctx.style,
        ctx.percentDigits,
        balance,
      ),
      color: quotaColor(intervalRemaining, weeklyRemaining),
    };
  },
};