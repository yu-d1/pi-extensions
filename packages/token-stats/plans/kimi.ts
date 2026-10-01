/**
 * 套餐配额查询 —— Kimi（Moonshot）
 * /coding/v1/usages：5h 窗口（limits）与周配额（usage）分开计时，各自显示倒计时。
 */

import type { TokenPlan } from "./shared";
import { formatTokenPlanDisplay, quotaColor } from "./shared";

export const kimiPlan: TokenPlan = {
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
  format: (data, ctx) => {
    const limits = data.limits || [];
    let intervalRemaining = 100;
    let intervalReset: number | null = null;
    if (limits.length > 0) {
      const d = limits[0].detail || {};
      const limit = d.limit || 1;
      const remaining = Math.max(d.remaining ?? 0, 0);
      intervalRemaining = (remaining / limit) * 100;
      const rt = d.resetTime;
      if (rt) {
        const ms = typeof rt === "string" ? new Date(rt).getTime() : rt;
        if (ms > Date.now()) intervalReset = ms;
      }
    }
    const usage = data.usage || {};
    let weeklyRemaining = 100;
    let weeklyReset: number | null = null;
    if (usage.limit) {
      const remaining = Math.max(usage.remaining ?? 0, 0);
      weeklyRemaining = (remaining / usage.limit) * 100;
      const rt = usage.resetTime;
      if (rt) {
        const ms = typeof rt === "string" ? new Date(rt).getTime() : rt;
        if (ms > Date.now()) weeklyReset = ms;
      }
    }
    if (intervalRemaining >= 100 && weeklyRemaining >= 100) return { modelPrefix: "", display: "无数据", color: "err" };
    return {
      modelPrefix: "",
      display: formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, intervalReset, weeklyReset, ctx.style, ctx.percentDigits),
      color: quotaColor(intervalRemaining, weeklyRemaining),
    };
  },
};
