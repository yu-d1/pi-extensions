/**
 * 套餐配额查询 —— MiniMax
 * 开放平台 coding_plan 余量：5h 窗口 + 周配额，general 优先。
 */

import type { TokenPlan } from "./shared";
import { formatTokenPlanDisplay, quotaColor } from "./shared";

export const minimaxPlan: TokenPlan = {
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
  format: (data: any, style) => {
    const models = data.model_remains || [];
    // 官方接口 2026-07 起 model_name 改为 general / video 等语义化命名，
    // 不再是 MiniMax-M2 / MiniMax-M3。优先取 "general"（通用文本/编码套餐），否则取第一项
    const m =
      models.find((x: any) => x.model_name === "general") ||
      models.find((x: any) => x.model_name?.includes("M2")) ||
      models[0];
    if (!m) return { modelPrefix: "", display: "无数据", color: "err" };
    const intervalRemaining = m.current_interval_remaining_percent ?? 0;
    const weeklyRemaining = m.current_weekly_remaining_percent ?? 0;
    const now = Date.now();
    const intervalReset = typeof m.end_time === "number" && m.end_time > now ? m.end_time : null;
    const weeklyReset = typeof m.weekly_end_time === "number" && m.weekly_end_time > now ? m.weekly_end_time : null;
    return {
      modelPrefix: "",
      display: formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, intervalReset, weeklyReset, style),
      color: quotaColor(intervalRemaining, weeklyRemaining),
    };
  },
};
