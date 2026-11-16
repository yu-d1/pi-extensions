import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BatchPlan, Candidates, FoldRange } from "./fold.js";
import { buildFoldPrompt, buildSplitPrompt, buildSummaryHeader, parseSplitResponse, serializeRange } from "./prompt.js";
import { estimateTokensFromSummary } from "./tokens.js";

/** 摘要输出预算：论文实测中位数 185 token，2K 已经很宽松 */
const SUMMARY_MAX_TOKENS = 2_000;
/** 单次摘要请求总超时，避免后台任务一直挂着 */
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
 * 调用当前模型生成摘要。
 *
 * 关闭 reasoning：推理模型的思维链会把 2K 输出预算吃光，正文摘要变空。
 */
export async function summarizeRange(
  ctx: ExtensionContext,
  input: SummarizeInput,
): Promise<SummaryResult> {
  const { blockId, branch, range, signal: externalSignal, topic } = input;
  const model = ctx.model;
  if (model === undefined) throw new SummarizeError("当前没有可用模型");

  const serialized = serializeRange(branch, range.entryIds);
  if (serialized.trim().length === 0) throw new SummarizeError("区间内没有可摘要的文本");

  const prompt = buildFoldPrompt({
    serialized,
    messageCount: range.entryIds.length,
    tokensInRange: range.tokensBefore,
    focus: topic,
  });

  const signal = withTimeout(externalSignal, SUMMARY_TIMEOUT_MS);

  let raw: unknown;
  try {
    raw = await ctx.modelRegistry.complete(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      {
        maxTokens: SUMMARY_MAX_TOKENS,
        reasoning: "off",
        signal,
      },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new SummarizeError(`摘要请求失败: ${msg}`);
  }

  if (signal.aborted) throw new SummarizeError("摘要请求已取消");

  const summary = extractText(raw);
  if (summary.length === 0) throw new SummarizeError("模型返回的摘要为空");
  if (summary.length < 30) throw new SummarizeError("模型返回的摘要过短");

  const tokensAfter = estimateTokensFromSummary(summary);
  const header = buildSummaryHeader(blockId, range.entryIds.length, summary, topic);

  return { summary, header, tokensAfter };
}
export interface SplitInput {
  candidates: Candidates;
  signal?: AbortSignal;
}

/** 切分请求的输出预算：几十条边界，1K 足够 */
const SPLIT_MAX_TOKENS = 1_500;

/**
 * 让模型决定候选区间怎么切成几批。
 *
 * 失败（网络、解析、超时）一律抛出，由调用方退化为按轮次均分。
 */
export async function splitCandidates(ctx: ExtensionContext, input: SplitInput): Promise<BatchPlan[]> {
  const model = ctx.model;
  if (model === undefined) throw new SummarizeError("当前没有可用模型");

  const prompt = buildSplitPrompt({
    turns: input.candidates.turns.map((turn) => ({ index: turn.index, userText: turn.userText })),
    totalTokens: input.candidates.totalTokens,
  });

  const signal = withTimeout(input.signal, SPLIT_TIMEOUT_MS);

  let raw: unknown;
  try {
    raw = await ctx.modelRegistry.complete(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { maxTokens: SPLIT_MAX_TOKENS, reasoning: "off", signal },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new SummarizeError(`切分请求失败: ${msg}`);
  }

  if (signal.aborted) throw new SummarizeError("切分请求已取消");

  const text = extractText(raw);
  if (text.length === 0) throw new SummarizeError("模型返回的切分方案为空");

  try {
    return parseSplitResponse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new SummarizeError(`切分方案无法解析: ${msg}`);
  }
}
