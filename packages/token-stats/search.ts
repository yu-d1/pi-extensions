// @liziy/token-stats —— 内嵌联网搜索后端
// =============================================================================
// deepseek-server: 核心调用移植自 pi-deepseek-search v1.0.20 (MIT, bxff)
// 与官方完全一致：
//   - 端点 https://api.deepseek.com/anthropic/v1/messages（Anthropic 兼容协议）
//   - 搜索模型 deepseek-v4-flash（环境变量 DEEPSEEK_SEARCH_MODEL 可覆盖）
//   - 服务端工具 web_search_20260209（max_uses 8，60s 超时）
//   - SSE 流式解析回答文本 + 来源链接，结果附 markdown 引用
// 与官方（pi-deepseek-search）的差异，仅在外层控制：
//   - 注册由套餐驱动：config.search.backends[plan.id] 命中才启用，
//     /stats config → 🔍 联网搜索 可开关（默认开启）
//   - execute 带守卫：仅当前 provider+套餐命中本后端时才真正执行
//   - API key 复用 token-stats 的 resolveApiKey（环境变量 + auth.json）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── 常量 ──────────────────────────────────────────────────

const TOOL_NAME = "web_search";
const ANTHROPIC_BASE = "https://api.deepseek.com/anthropic";
const SEARCH_MODEL = process.env.DEEPSEEK_SEARCH_MODEL || "deepseek-v4-flash";
const DEFAULT_MAX_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 60_000;
const CITATION_REMINDER =
  "\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

// 清理工具调用标记残留
const XTAG_RE = /<[^>]*(?:tool_calls|invoke|parameter)[^>]*>/g;

// ── 依赖注入（由 index.ts 提供）─────────────────────────

export interface SearchDeps {
  /** 解析 DeepSeek API key（环境变量 → auth.json） */
  resolveApiKey: () => string | null;
  /** 当前会话 provider+套餐是否命中本后端 */
  isActive: () => boolean;
}

export interface SearchBackend {
  id: string;
  name: string;
  /** 命中此后端的套餐 id 列表（用于 UI 展示） */
  matchPlans: string[];
  /** 注册完整实现（幂等；从未启用过则不注册任何东西） */
  enable(pi: ExtensionAPI): void;
  /** 覆盖注册为禁用空壳（幂等；仅在已注册完整实现时生效） */
  disable(pi: ExtensionAPI): void;
}

// ── 类型 ──────────────────────────────────────────────────

interface SearchSource {
  title: string;
  url: string;
  pageAge?: string | null;
}

interface SearchOutcome {
  answerParts: string[];
  sources: SearchSource[];
  model: string;
  tokens: number;
}

// ── 核心调用（与官方 pi-deepseek-search 一致）────────────

async function callAnthropic(
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<SearchOutcome> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: s,
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const err = (await response.json()) as { error?: { message?: string } };
      detail = err.error?.message || detail;
    } catch { /* non-JSON */ }
    throw new Error(`DeepSeek API ${response.status}: ${detail}`);
  }

  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const answerParts: string[] = [];
  const sources: SearchSource[] = [];
  let modelName = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data);
        if (event.type === "message_start") {
          if (event.message?.model) modelName = event.message.model;
          if (event.message?.usage) inputTokens = event.message.usage.input_tokens || 0;
        }
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
            const count = block.content.length;
            onProgress?.(`找到 ${count} 条结果…`);
            for (const entry of block.content) {
              if (entry.type === "web_search_result") {
                sources.push({
                  title: entry.title || "Untitled",
                  url: entry.url || "",
                  pageAge: entry.page_age,
                });
              }
            }
          }
        }
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta?.type === "text_delta" && delta.text) {
            const lastIdx = answerParts.length - 1;
            if (lastIdx >= 0) answerParts[lastIdx] += delta.text;
            else answerParts.push(delta.text);
          }
        }
        if (event.type === "message_delta") {
          if (event.usage) outputTokens = event.usage.output_tokens || 0;
        }
      } catch { /* skip malformed */ }
    }
  }

  return {
    answerParts,
    sources,
    model: modelName || SEARCH_MODEL,
    tokens: inputTokens + outputTokens,
  };
}

function formatSources(sources: SearchSource[]): string {
  if (sources.length === 0) return "";
  return [
    "",
    "Links:",
    ...sources.map(
      (s, i) =>
        `${i + 1}. [${s.title}](${s.url})${s.pageAge ? ` (${s.pageAge})` : ""}`,
    ),
  ].join("\n");
}

function cleanAnswer(text: string): string {
  return text.replace(XTAG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── 参数 schema（与官方一致）─────────────────────────────

const webSearchParams = Type.Object({
  query: Type.String({
    minLength: 2,
    description: "The search query. Be specific and include relevant keywords.",
  }),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Restrict results to these domains (e.g. ['python.org']). Cannot combine with blocked_domains.",
    }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Exclude these domains from results. Cannot combine with allowed_domains.",
    }),
  ),
});

// ── 后端工厂 ──────────────────────────────────────────────

export function createDeepseekBackend(deps: SearchDeps): SearchBackend {
  let registeredFull = false;

  const buildFullTool = () => ({
    name: TOOL_NAME,
    label: "Web Search",
    description:
      `Search the web via DeepSeek. Returns search results with titles, URLs, and a brief summary. The current date is ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })} — use the current year for recent queries.`,
    promptSnippet:
      "web_search: search the web via DeepSeek. Returns results with titles, URLs, and a brief summary.",
    promptGuidelines: [
      "Use web_search when you need current or source-backed information outside your training data.",
      "After receiving search results, synthesize a clear answer and cite sources with markdown hyperlinks.",
    ],
    parameters: webSearchParams,

    renderCall(args, theme) {
      const p = args as { query: string; allowed_domains?: string[]; blocked_domains?: string[] };
      let text = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${p.query || "..."}"`);
      const tags: string[] = [];
      if (p.allowed_domains?.length) tags.push(`+${p.allowed_domains.length}d`);
      if (p.blocked_domains?.length) tags.push(`-${p.blocked_domains.length}d`);
      if (tags.length) text += " " + theme.fg("dim", tags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const text = result.content[0];
      const body = text?.type === "text" ? text.text : "";
      const clean = cleanAnswer(body.replace(/\n*REMINDER:.*$/s, ""));
      const lines = clean.split("\n");
      if (!expanded) {
        const preview = lines.slice(0, 6);
        if (lines.length > 6) preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
        return new Text(preview.join("\n"), 0, 0);
      }
      return new Text(clean, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // 守卫：仅当前 provider+套餐命中本后端时执行（防止跨套餐误用/竞态）
      if (!deps.isActive()) {
        return {
          content: [{
            type: "text",
            text: "联网搜索未启用：当前套餐未配置搜索后端，请在 /stats config → 🔍 联网搜索 中开启。",
          }],
          isError: true,
        };
      }

      const p = params as {
        query: string;
        allowed_domains?: string[];
        blocked_domains?: string[];
      };
      const query = p.query?.trim();
      if (!query) {
        return { content: [{ type: "text", text: "Error: query is required." }], isError: true };
      }

      onUpdate?.({ content: [{ type: "text", text: "搜索中…" }] });

      let firstProgress = true;
      const onProgress = (msg: string) => {
        if (firstProgress) {
          onUpdate?.({ content: [{ type: "text", text: msg }] });
          firstProgress = false;
        }
      };

      try {
        const apiKey = deps.resolveApiKey();
        if (!apiKey) {
          return {
            content: [{
              type: "text",
              text: "DeepSeek API key 未配置（环境变量 DEEPSEEK_API_KEY 或 ~/.pi/agent/auth.json）。",
            }],
            isError: true,
          };
        }
        const tool: Record<string, unknown> = {
          type: "web_search_20260209",
          name: "web_search",
          max_uses: 8,
        };
        if (p.allowed_domains?.length) tool.allowed_domains = p.allowed_domains;
        if (p.blocked_domains?.length) tool.blocked_domains = p.blocked_domains;

        const result = await callAnthropic(
          apiKey,
          {
            model: SEARCH_MODEL,
            max_tokens: DEFAULT_MAX_TOKENS,
            messages: [{ role: "user", content: query }],
            system: "You are an assistant for performing a web search tool use. Do not output tool call syntax.",
            tools: [tool],
          },
          signal,
          onProgress,
        );

        const answer = cleanAnswer(result.answerParts.join("\n\n")) ||
          `No results for: ${query}`;
        const sourceText = answer + formatSources(result.sources) + CITATION_REMINDER;
        const footer = `\n\n*${result.tokens.toLocaleString()} tokens · ${result.model}*`;
        return { content: [{ type: "text", text: sourceText + footer }], details: { sources: result.sources } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Search failed: ${message}` }], isError: true };
      }
    },
  });

  const buildDisabledTool = () => ({
    name: TOOL_NAME,
    label: "Web Search",
    description: "Web search is currently disabled for this session. Do not call this tool.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),

    renderCall(args, theme) {
      const p = args as { query: string };
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) +
          theme.fg("accent", `"${p.query || "..."}"`) +
          " " + theme.fg("dim", "(disabled)"),
        0,
        0,
      );
    },

    async execute() {
      return {
        content: [{
          type: "text",
          text: "联网搜索未启用：当前套餐未配置搜索后端，请在 /stats config → 🔍 联网搜索 中开启。",
        }],
        isError: true,
      };
    },
  });

  return {
    id: "deepseek-server",
    name: "DeepSeek 服务端搜索",
    matchPlans: ["deepseek"],
    enable(pi) {
      if (registeredFull) return;
      pi.registerTool(buildFullTool());
      registeredFull = true;
    },
    disable(pi) {
      // pi 无工具注销 API；同扩展内同名注册为覆盖语义，
      // 因此用禁用空壳覆盖完整实现即可让工具"失效"。
      if (!registeredFull) return; // 从未启用过则不注册任何东西
      pi.registerTool(buildDisabledTool());
      registeredFull = false;
    },
  };
}
