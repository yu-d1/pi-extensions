/**
 * 套餐配额查询 —— DeepSeek
 * /user/balance：只显余额（CNY 优先）。
 */

import type { TokenPlan } from "./shared";

export const deepseekPlan: TokenPlan = {
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
    if (!cny) return { modelPrefix: "", display: "无数据", color: "err" };
    const total = parseFloat(cny.total_balance || "0");
    return {
      modelPrefix: "",
      display: "¥" + total.toFixed(1),
      color: total < 1 ? "warn" : "ok",
    };
  },
};
