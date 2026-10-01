/**
 * 套餐配额查询 —— 智谱 GLM
 * /api/monitor/usage/quota/limit：tokens_limit 两档（5h / 周），unit=6 为周。
 */

import type { TokenPlan } from "./shared";
import { formatTokenPlanDisplay, quotaColor } from "./shared";

export const glmPlan: TokenPlan = {
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
  format: (data: any, style) => {
    const limits = data?.data?.limits || [];
    const tokenLimits = limits.filter((x: any) => (x.type || "").toLowerCase() === "tokens_limit");
    if (tokenLimits.length === 0) return { modelPrefix: "", display: "无数据", color: "err" };
    let fiveHour = tokenLimits[0];
    let weekly = tokenLimits[1];
    if (fiveHour?.unit === 6) [fiveHour, weekly] = [weekly, fiveHour];
    const intervalRemaining = 100 - (fiveHour?.percentage ?? 0);
    const weeklyRemaining = 100 - (weekly?.percentage ?? 0);
    const now = Date.now();
    const intervalReset = typeof fiveHour?.nextResetTime === "number" && fiveHour.nextResetTime > now ? fiveHour.nextResetTime : null;
    const weeklyReset = typeof weekly?.nextResetTime === "number" && weekly.nextResetTime > now ? weekly.nextResetTime : null;
    return {
      modelPrefix: "",
      display: formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, intervalReset, weeklyReset, style),
      color: quotaColor(intervalRemaining, weeklyRemaining),
    };
  },
};
