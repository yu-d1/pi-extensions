import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FoldConfig } from "./config.js";
import type { BatchPlan, Candidates, FoldRange } from "./fold.js";
import {
  buildConsolidatePrompt,
  buildFoldPrompt,
  buildSplitPrompt,
  buildSummaryHeader,
  parseSplitResponse,
  serializeRange,
} from "./prompt.js";
import { estimateTokensFromSummary } from "./tokens.js";

/** 摘要请求总超时，避免后台任务一直挂着 */
const SUMMARY_TIMEOUT_MS = 90_000;
/** 切分只看用户原话，响应应该很快 */
const SPLIT_TIMEOUT_MS = 30_000;

export interface SummaryResult {
  /** 摘要正文，未加头部 */
  summary: string;
  /** 加了块头部的完整文本，直接写进头条目 */
  header: string;
  /** 摘要占用的 token 估算 */
  tokensAfter: number;
}
/** 块 id 必须在摘要生成前确定，头部一次性拼好，不做事后替换 */
export interface SummarizeInput {
  blockId: string;
  branch: SessionEntry[];
  range: FoldRange;
  signal?: AbortSignal;
  /** 本批主题，用作摘要侧重点与摘要头 */
  topic?: string;
  /** 当前会话的思考等级，与对话保持一致，不另外指定 */
  reasoning?: string;
  /**
   * 合并折叠时传入旧摘要。
   *
   * 旧摘要的原文已经不可见，只有并进新摘要才能保住那部分信息。
   */
  previousSummary?: string;
  /** 本次折叠总共覆盖多少条原文（合并时要算上旧块），用于摘要头 */
  totalEntryCount?: number;
  /** 折叠设置，决定用哪个模型、思考等级多强 */
  config: FoldConfig;
}

export class SummarizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummarizeError";
  }
}

function extractText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;
  const content = m.content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    // 只取正文，忽略 thinking 块
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("摘要请求超时")), ms);
  // 允许被外部 signal 取消
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  // 让 timer 不拖住进程退出
  const clear = () => clearTimeout(timer);
  controller.signal.addEventListener("abort", clear, { once: true });
  return controller.signal;
}

/**
 * 组装请求选项。
 *
 * 不设 maxTokens：交给模型自身的输出上限，与 pi 原生压缩的做法一致
 * （pi 源码：summaries use the model's output limit）。人为压低预算会让
 * 正文被思维链挤空而导致摘要残缺。
 *
 * reasoning 只在模型确实支持且等级不是 off 时传入。pi-ai 内部会把
 * "off" 直接转成 undefined，传了等于放弃控制，上游反而按默认最高强度思考。
 */
function requestOptions(model: unknown, level: string | undefined, signal: AbortSignal): Record<string, unknown> {
  const options: Record<string, unknown> = { signal };
  const supportsReasoning = (model as { reasoning?: boolean } | undefined)?.reasoning === true;
  if (supportsReasoning && level !== undefined && level !== "off") options.reasoning = level;
  return options;
}

/**
 * 折叠请求的候选模型：按配置的顺序降级。
 *
 * 配置为空就跟随当前会话；配置里的模型可能已被卸载或凭据失效，
 * 这些也一并跳过。全都不用时退回会话模型，至少还能跑。
 */
export function resolveCandidates(
  ctx: ExtensionContext,
  config: FoldConfig,
): Array<{ model: unknown; reasoning: string | undefined }> {
  if (config.foldModels.length === 0) return [{ model: ctx.model, reasoning: undefined }];

  const registry = ctx.modelRegistry as unknown as {
    find?: (provider: string, modelId: string) => unknown;
    hasConfiguredAuth?: (model: unknown) => boolean;
  };

  const picked: Array<{ model: unknown; reasoning: string | undefined }> = [];
  for (const ref of config.foldModels) {
    const model = registry.find?.(ref.provider, ref.modelId);
    if (model === undefined) continue;
    if (registry.hasConfiguredAuth !== undefined && !registry.hasConfiguredAuth(model)) continue;
    picked.push({ model, reasoning: ref.reasoning });
  }

  if (picked.length === 0) return [{ model: ctx.model, reasoning: undefined }];
  return picked;
}

/**
 * 沿候选链发一次请求，前一个跑不通就换下一个。
 *
 * 降级只在链内发生：同一个模型不会重试，避免在限流时反复撞同一个口。
 * 全部失败才抛错，由调用方决定是记一次失败还是退回兑底。
 */
async function completeWithFallback(
  ctx: ExtensionContext,
  config: FoldConfig,
  prompt: string,
  reasoning: string | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  const candidates = resolveCandidates(ctx, config);
  let lastError: unknown;
  let attempted = false;

  for (const candidate of candidates) {
    if (signal.aborted) break;
    if (candidate.model === undefined) continue;
    attempted = true;
    try {
      return await ctx.modelRegistry.complete(
        candidate.model as Parameters<typeof ctx.modelRegistry.complete>[0],
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        requestOptions(candidate.model, candidate.reasoning ?? reasoning, signal) as Parameters<
          typeof ctx.modelRegistry.complete
        >[2],
      );
    } catch (error) {
      lastError = error;
    }
  }

  if (!attempted) throw new SummarizeError("当前没有可用模型");
  throw lastError ?? new SummarizeError("所有折叠模型都不可用");
}

/**
 * 调用折叠模型生成摘要。
 *
 * 思考等级优先用模型配置里的值，未配置则跟随当前会话。
 */
export async function summarizeRange(
  ctx: ExtensionContext,
  input: SummarizeInput,
): Promise<SummaryResult> {
  const { blockId, branch, range, signal: externalSignal, topic, reasoning, previousSummary, config } = input;
  if (ctx.model === undefined) throw new SummarizeError("当前没有可用模型");

  const serialized = serializeRange(branch, range.entryIds);
  if (serialized.trim().length === 0) throw new SummarizeError("区间内没有可摘要的文本");

  const prompt = buildFoldPrompt({
    serialized,
    messageCount: range.entryIds.length,
    tokensInRange: range.tokensBefore,
    focus: topic,
    previousSummary,
  });

  const signal = withTimeout(externalSignal, SUMMARY_TIMEOUT_MS);

  let raw: unknown;
  try {
    raw = await completeWithFallback(ctx, config, prompt, reasoning, signal);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new SummarizeError(`摘要请求失败: ${msg}`);
  }

  if (signal.aborted) throw new SummarizeError("摘要请求已取消");

  // 不完整的结果不能当摘要用：截断说明输出上限不够，继续写进上下文会丢信息
  if ((raw as { stopReason?: string } | undefined)?.stopReason === "length") {
    throw new SummarizeError("摘要不完整（被输出上限截断）");
  }

  const summary = extractText(raw);
  if (summary.length === 0) throw new SummarizeError("模型返回的摘要为空");
  if (summary.length < 30) throw new SummarizeError("模型返回的摘要过短");

  const tokensAfter = estimateTokensFromSummary(summary);
  const header = buildSummaryHeader(blockId, input.totalEntryCount ?? range.entryIds.length, summary, topic);

  return { summary, header, tokensAfter };
}
export interface SplitInput {
  candidates: Candidates;
  signal?: AbortSignal;
  /** 当前会话的思考等级，与摘要请求保持一致 */
  reasoning?: string;
  /** 折叠设置，决定用哪个模型 */
  config: FoldConfig;
}

/**
 * 让模型决定候选区间怎么切成几批。
 *
 * 失败（网络、解析、超时）一律抛出，由调用方退化为按轮次均分。
 */
export async function splitCandidates(ctx: ExtensionContext, input: SplitInput): Promise<BatchPlan[]> {
  if (ctx.model === undefined) throw new SummarizeError("当前没有可用模型");

  const prompt = buildSplitPrompt({
    turns: input.candidates.turns.map((turn) => ({ index: turn.index, userText: turn.userText })),
    totalTokens: input.candidates.totalTokens,
  });

  const signal = withTimeout(input.signal, SPLIT_TIMEOUT_MS);

  let raw: unknown;
  try {
    raw = await completeWithFallback(ctx, input.config, prompt, input.reasoning, signal);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new SummarizeError(`切分请求失败: ${msg}`);
  }

  if (signal.aborted) throw new SummarizeError("切分请求已取消");

  if ((raw as { stopReason?: string } | undefined)?.stopReason === "length") {
    throw new SummarizeError("切分方案不完整（被输出上限截断）");
  }

  const text = extractText(raw);
  if (text.length === 0) throw new SummarizeError("模型返回的切分方案为空");

  try {
    return parseSplitResponse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new SummarizeError(`切分方案无法解析: ${msg}`);
  }
}

/**
 * 把已经积累的旧摘要压缩成一段。
 *
 * 它和本次各批摘要一起并发跑，所以会占用并发额度里的一格。
 * 失败返回 undefined，调用方退回使用旧摘要原文，不丢内容。
 */
export async function mergeSummaries(
  ctx: ExtensionContext,
  input: { summaries: string[]; signal?: AbortSignal; reasoning?: string; config: FoldConfig },
): Promise<string | undefined> {
  if (ctx.model === undefined) return undefined;

  const joined = input.summaries
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
  if (joined.length === 0) return undefined;

  const prompt = buildConsolidatePrompt(joined);
  const signal = withTimeout(input.signal, SUMMARY_TIMEOUT_MS);

  let raw: unknown;
  try {
    raw = await completeWithFallback(ctx, input.config, prompt, input.reasoning, signal);
  } catch {
    return undefined;
  }

  if (signal.aborted) return undefined;
  if ((raw as { stopReason?: string } | undefined)?.stopReason === "length") return undefined;

  const summary = extractText(raw);
  if (summary.length < 30) return undefined;
  return summary;
}
