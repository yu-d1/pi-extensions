import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 多批折叠的执行方式 */
export type BatchMode = "serial" | "parallel";

/** 折叠设置。字段少是刻意的，暴露太多反而不知道该调哪个。 */
export interface FoldConfig {
  /** 是否启用自动折叠 */
  enabled: boolean;
  /** 触发折叠的上下文 token 数（固定值，不按比例） */
  foldAtTokens: number;
  /** 保留最近多少 token 的原文不折叠 */
  keepRecentTokens: number;
  /** 保底触发比例：占用到这个占比时无条件折叠，0 表示关闭保底 */
  safetyRatio: number;
  /** 距离上次折叠至少增长多少 token 才再次触发（固定值，不暴露） */
  minGrowth: number;
  /** 区间小于这个 token 数不值得折，白白付一次摘要费用（固定值，不暴露） */
  minFoldTokens: number;
  /** 多批折叠时逐批串行，还是并发 */
  batchMode: BatchMode;
  /** 并发时的同时请求数 */
  batchConcurrency: number;
}

export const DEFAULT_CONFIG: FoldConfig = {
  enabled: true,
  foldAtTokens: 150_000,
  keepRecentTokens: 20_000,
  safetyRatio: 0.9,
  minGrowth: 15_000,
  minFoldTokens: 8_000,
  batchMode: "serial",
  batchConcurrency: 3,
};

/**
 * 留给模型输出的余量。
 *
 * 阈值是固定 token 数，但小窗口模型的窗口可能比阈值还小；
 * 实际生效值取 min(阈值, 窗口 - 余量)，否则那些模型永远不会触发。
 */
export const OUTPUT_RESERVE_TOKENS = 16_000;

/** 阈值必须低于窗口这么多，否则压了也没意义 */
export const MIN_HEADROOM_TOKENS = 8_000;

/**
 * 保底触发比例。
 *
 * 与触发阈值无关：上下文到这个占比时无条件折叠，
 * 防止阈值设得过高导致上下文一直涨。
 */
export const SAFETY_RATIO_OPTIONS = [0, 0.8, 0.9, 0.95] as const;

/** 执行方式选项 */
export const BATCH_MODE_OPTIONS = ["逐步", "并发"] as const;

/** 并发个数选项 */
export const CONCURRENCY_OPTIONS = [2, 5, 10, 20] as const;

/** 并发上限。再高就只是在刷新服务端限流，不会更快。 */
export const MAX_CONCURRENCY = 20;

/**
 * 给 pi 原生压缩留的余量。
 *
 * pi 自己在「窗口 - 16K」时压缩。保底线必须比它更早，否则还没等我们折，
 * 就已经被原生压缩盖掉了。小窗口下 90% 可能已经晚于它（128K 窗口：
 * 原生 87.2%），所以保底线取两者中更早的那个。
 */
export const SAFETY_MARGIN_TOKENS = 24_000;

/** 保底线对应的 token 数：模型占比与原生压缩阈值中取更早者 */
export function safetyFoldAt(contextWindow: number, config: FoldConfig): number {
  if (contextWindow <= 0 || config.safetyRatio <= 0) return 0;
  const byRatio = contextWindow * config.safetyRatio;
  const byNative = contextWindow - SAFETY_MARGIN_TOKENS;
  const limit = Math.min(byRatio, byNative);
  // 别折得太早：小窗口下按原生命中会只剩 25%，至少留半个窗口给模型干活。
  // 但如果这个下限已经等于或超过原生压缩阈值，就没有保底空间了，交给 canFoldWindow 判定。
  const floor = contextWindow * 0.5;
  return Math.min(Math.max(floor, limit), byNative);
}

/** 当前占用是否已到保底线 */
export function atSafetyLimit(tokens: number, contextWindow: number, config: FoldConfig): boolean {
  if (contextWindow <= 0 || tokens <= 0) return false;
  if (!canFoldWindow(config, contextWindow)) return false;
  const limit = safetyFoldAt(contextWindow, config);
  if (limit <= 0) return false;
  return tokens >= limit;
}

/** pi 的 agent 目录，支持 PI_CODING_AGENT_DIR 覆盖 */
export function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}

export function configFilePath(): string {
  return join(agentDir(), "context-fold-config.json");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 非法值一律回退默认，不静默放宽限制 */
export function normalizeConfig(raw: unknown): FoldConfig {
  const base = { ...DEFAULT_CONFIG };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return base;

  const r = raw as Record<string, unknown>;

  if (typeof r.enabled === "boolean") base.enabled = r.enabled;

  if (r.batchMode === "serial" || r.batchMode === "parallel") {
    base.batchMode = r.batchMode;
  }

  if (typeof r.batchConcurrency === "number" && Number.isFinite(r.batchConcurrency)) {
    base.batchConcurrency = clamp(Math.floor(r.batchConcurrency), 1, MAX_CONCURRENCY);
  }

  if (typeof r.foldAtTokens === "number" && Number.isFinite(r.foldAtTokens)) {
    base.foldAtTokens = clamp(Math.floor(r.foldAtTokens), 20_000, 2_000_000);
  }

  if (typeof r.keepRecentTokens === "number" && Number.isFinite(r.keepRecentTokens)) {
    base.keepRecentTokens = clamp(Math.floor(r.keepRecentTokens), 2_000, 200_000);
  }

  if (typeof r.safetyRatio === "number" && Number.isFinite(r.safetyRatio)) {
    // 0 表示关闭保底；其余夹在 50%-98%
    base.safetyRatio = r.safetyRatio <= 0 ? 0 : clamp(r.safetyRatio, 0.5, 0.98);
  }

  // minGrowth / minFoldTokens 允许被高级用户覆盖，但同样夹住范围
  if (typeof r.minGrowth === "number" && Number.isFinite(r.minGrowth)) {
    base.minGrowth = clamp(Math.floor(r.minGrowth), 1_000, 200_000);
  }
  if (typeof r.minFoldTokens === "number" && Number.isFinite(r.minFoldTokens)) {
    base.minFoldTokens = clamp(Math.floor(r.minFoldTokens), 1_000, 100_000);
  }

  return base;
}

export function loadConfig(): FoldConfig {
  const path = configFilePath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: FoldConfig): void {
  const dir = agentDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configFilePath(), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** 实际生效的触发阈值：固定值，但不超过窗口能容纳的范围 */
export function effectiveFoldAt(config: FoldConfig, contextWindow: number): number {
  if (contextWindow <= 0) return config.foldAtTokens;
  const ceiling = Math.max(0, contextWindow - OUTPUT_RESERVE_TOKENS);
  return Math.min(config.foldAtTokens, ceiling);
}

/** 这一窗口下还有没有折叠余地（太小就别折腾了） */
export function canFoldWindow(config: FoldConfig, contextWindow: number): boolean {
  if (contextWindow <= 0) return true;
  return effectiveFoldAt(config, contextWindow) > MIN_HEADROOM_TOKENS;
}

/** token 数的简短显示 */
export function tokenLabel(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** 执行方式的显示文案，菜单与设置摘要共用 */
export function batchModeLabel(mode: BatchMode): string {
  return mode === "parallel" ? "并发" : "逐步";
}

export function configSummary(config: FoldConfig): string[] {
  const lines = [
    `启用折叠: ${config.enabled ? "是" : "否"}`,
    `触发阈值: ${tokenLabel(config.foldAtTokens)}`,
    `保留最近: ${tokenLabel(config.keepRecentTokens)}`,
    `保底触发: ${config.safetyRatio > 0 ? `${Math.round(config.safetyRatio * 100)}%` : "关闭"}`,
    `执行方式: ${batchModeLabel(config.batchMode)}`,
  ];
  if (config.batchMode === "parallel") {
    lines.push(`并发个数: ${config.batchConcurrency}`);
  }
  return lines;
}
