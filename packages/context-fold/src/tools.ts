import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { batchModeLabel, canFoldWindow, effectiveFoldAt, loadConfig, safetyFoldAt, tokenLabel } from "./config.js";
import { renderEntry } from "./prompt.js";
import type { FoldRecord, FoldState } from "./state.js";
import { sortedRecords } from "./state.js";

/** 单次 recall 返回的原文上限，防止一次拉爆上下文 */
const RECALL_MAX_CHARS = 30_000;

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}


/** 超长时保留头尾：折叠块里最可能被需要的是结尾（刚做完的事、最后的报错） */
function clipHeadsAndTails(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n\n…[中间省略 ${omitted} 字符，用 offset 参数可读取]…\n\n${text.slice(-tail)}`;
}

export function registerTools(pi: ExtensionAPI, state: FoldState): void {
  // ── 取回折叠块原文 ──────────────────────────────
  pi.registerTool({
    name: "recall",
    label: "取回折叠内容",
    description:
      "取回某个折叠块的原文。摘要不足以支撑当前任务时使用，例如需要原始报错、完整代码或具体数值。原文仅本次可见，不会改变上下文结构。块很大时可先用 query 定位，或用 offset 分段读取；不要为了读完整个块而反复调用。",
    promptSnippet:
      "取回折叠块原文。摘要缺细节（报错、代码、数值）时调用。块太大时用 query 按关键词筛选，或 offset 分段读；不要反复翻页读完整个块。",
    parameters: Type.Object({
      blockId: Type.String({
        description:
          '折叠块编号，形如 "b1"；多个块用逗号分隔（"b1,b2"），写 "all" 表示全部。编号见摘要头或 fold_status',
        minLength: 1,
      }),
      query: Type.Optional(
        Type.String({
          description: "只返回包含这些词的消息，空格分隔任意命中。常用于找报错、文件路径、函数名。",
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: "从第几个字符开始取，默认 0。块很大而需要看某一段时使用。多块时对每块分别生效。",
          minimum: 0,
        }),
      ),
    }),
    async execute(
      _id: string,
      params: { blockId: string; query?: string; offset?: number },
      _signal: unknown,
      _update: unknown,
      ctx: ExtensionContext,
    ) {
      const requested = resolveBlockIds(state, params.blockId);
      if (requested.length === 0) {
        const known = sortedRecords(state)
          .map((r) => r.blockId)
          .join(", ") || "无";
        return text(`未找到折叠块 "${params.blockId}"。当前可用的块: ${known}`);
      }

      const branch = ctx.sessionManager.getBranch() as Array<{ id: string }>;
      const byId = new Map(branch.map((entry) => [entry.id, entry]));

      const keywords = (params.query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 0);

      const sections: string[] = [];
      for (const blockId of requested) {
        const record = state.records.get(blockId);
        if (record === undefined) continue;
        sections.push(renderBlock(record.blockId, record, byId, keywords, params.query, params.offset));
      }

      if (sections.length === 0) return text("指定的折叠块都不存在。");
      return text(sections.join("\n\n────────\n\n"));
    },
  });

  // ── 折叠状态 ────────────────────────────────────
  pi.registerTool({
    name: "fold_status",
    label: "折叠状态",
    description: "查看当前上下文构成：占用比例、已折叠的块、还有多少空间可折叠。",
    promptSnippet: "查看上下文折叠状态。",
    parameters: Type.Object({}),
    async execute(_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: ExtensionContext) {
      return text(buildStatusText(state, ctx));
    },
  });
}

/** 状态文本，工具与 /fold 命令共用 */
export function buildStatusText(state: FoldState, ctx: ExtensionContext): string {
  const config = loadConfig();
  const usage = ctx.getContextUsage();
  const lines: string[] = [];

  if (usage?.tokens != null && usage.contextWindow > 0) {
    const pct = ((usage.tokens / usage.contextWindow) * 100).toFixed(1);
    lines.push(`上下文: ${tokenLabel(usage.tokens)} / ${tokenLabel(usage.contextWindow)} (${pct}%)`);
  } else {
    lines.push("上下文: 未知（等待下一次模型响应）");
  }

  const windowSize = usage?.contextWindow ?? 0;
  const safetyLabel =
    config.safetyRatio > 0
      ? `${Math.round(config.safetyRatio * 100)}% (${tokenLabel(safetyFoldAt(windowSize, config))})`
      : "关闭";

  const foldAt = effectiveFoldAt(config, windowSize);
  const capped = foldAt < config.foldAtTokens;
  lines.push(
    `触发阈值: ${tokenLabel(foldAt)}${capped ? `（设定 ${tokenLabel(config.foldAtTokens)}，受窗口限制）` : ""}  保留最近: ${tokenLabel(config.keepRecentTokens)}`,
  );
  // 系数明显偏离 1 时提示一下：阈值与保留量按真实 token 生效，
  // 而折叠刚完成时 pi 会回退到估算，两个数字会短暂对不上
  if (state.tokenScale > 0 && Math.abs(state.tokenScale - 1) > 0.1) {
    lines.push(`估算校正: 真实 token ≈ 本地估算 × ${state.tokenScale.toFixed(2)}（用于阈值与保留量）`);
  }
  lines.push(
    `保底触发: ${safetyLabel}  执行方式: ${batchModeLabel(config.batchMode)}${config.batchMode === "parallel" ? `（${config.batchConcurrency}）` : ""}`,
  );
  if (!canFoldWindow(config, windowSize)) {
    lines.push("注意: 当前模型窗口太小，折叠腾不出空间，已跳过自动触发。");
  }
  lines.push("");

  if (state.records.size === 0) {
    lines.push("尚未折叠任何内容。");
  } else {
    const records = sortedRecords(state);
    const totalBefore = records.reduce((s, r) => s + r.tokensBefore, 0);
    const totalAfter = records.reduce((s, r) => s + r.tokensAfter, 0);
    const totalEntries = records.reduce((s, r) => s + r.entryIds.length, 0);
    lines.push(`已折叠 ${records.length} 块（共覆盖 ${totalEntries} 条消息）:`);
    for (const record of records) {
      const preview = record.summary.replace(/\s+/g, " ").slice(0, 40);
      lines.push(
        `  ${record.blockId}  覆盖 ${record.entryIds.length} 条  ${tokenLabel(record.tokensBefore)} → ${tokenLabel(record.tokensAfter)}  ${preview}${record.summary.length > 40 ? "…" : ""}`,
      );
    }
    lines.push("");
    lines.push(`合计 ${tokenLabel(totalBefore)} → ${tokenLabel(totalAfter)}，节省 ${tokenLabel(totalBefore - totalAfter)}`);
  }

  if (state.summarizing) {
    lines.push("");
    lines.push(
      state.batchTotal > 1 ? `正在后台生成摘要… ${state.batchDone}/${state.batchTotal}` : "正在后台生成摘要…",
    );
  }
  if (state.pending !== undefined) {
    lines.push("");
    lines.push(
      state.pending.length === 1
        ? `块 ${state.pending[0].blockId} 已生成，将在本轮结束时生效。`
        : `${state.pending.length} 块已生成，将在本轮结束时生效。`,
    );
  }
  if (state.failures > 0) {
    lines.push("");
    lines.push(`连续失败 ${state.failures} 次${state.failures >= 3 ? "，已暂停自动折叠，用 /fold now 手动重试" : ""}。`);
  }

  return lines.join("\n");
}

/**
 * 把 blockId 参数解析成实际的块编号列表。
 *
 * 支持三种写法：单块 "b1"、多块 "b1,b2"、全部 "all"。
 * 顺序按编号排，不按用户书写顺序，避免输出忽前忽后。
 */
function resolveBlockIds(state: FoldState, raw: string): string[] {
  const all = sortedRecords(state);
  const text = raw.trim().toLowerCase();
  if (text === "all" || text === "*") return all.map((r) => r.blockId);

  const wanted = new Set<string>();
  for (const part of text.split(/[,\s]+/)) {
    const id = part.trim();
    if (id.length === 0) continue;
    if (state.records.has(id)) {
      wanted.add(id);
      continue;
    }
    // 允许只写序号："1" 等价于 "b1"
    const seq = Number.parseInt(id.replace(/^b/, ""), 10);
    if (Number.isFinite(seq)) {
      const blockId = `b${seq}`;
      if (state.records.has(blockId)) wanted.add(blockId);
    }
  }

  return all.map((r) => r.blockId).filter((id) => wanted.has(id));
}

/** 渲染单个折叠块的召回内容 */
function renderBlock(
  blockId: string,
  record: FoldRecord,
  byId: Map<string, { id: string }>,
  keywords: string[],
  rawQuery: string | undefined,
  rawOffset: number | undefined,
): string {
  const parts: string[] = [];
  let missing = 0;
  let filtered = 0;

  for (const entryId of record.entryIds) {
    const entry = byId.get(entryId);
    if (entry === undefined) {
      missing += 1;
      continue;
    }
    const rendered = renderEntry(entry as Parameters<typeof renderEntry>[0]);
    if (rendered === undefined) continue;
    if (keywords.length > 0 && !keywords.some((word) => rendered.toLowerCase().includes(word))) {
      filtered += 1;
      continue;
    }
    parts.push(rendered);
  }

  if (parts.length === 0) {
    if (keywords.length > 0) {
      return `折叠块 ${blockId} 里没有匹配「${rawQuery}」的内容。换个关键词，或不带 query 重新调用。`;
    }
    return `折叠块 ${blockId} 的原文已不在当前分支上，可能已被原生压缩清除。`;
  }

  const full = parts.join("\n\n");
  const offset = Math.max(0, Math.floor(rawOffset ?? 0));
  if (offset >= full.length) {
    return `折叠块 ${blockId}：offset ${offset} 超出范围，该块共 ${full.length} 字符。`;
  }

  // 没指定 offset 时按头尾保留（结尾往往最相关）；指定了 offset 就按顺序原样切片
  const useHeadTail = rawOffset === undefined && full.length > RECALL_MAX_CHARS;
  const slice = useHeadTail ? full.slice(0, RECALL_MAX_CHARS) : full.slice(offset, offset + RECALL_MAX_CHARS);
  const end = useHeadTail ? RECALL_MAX_CHARS : offset + slice.length;
  const truncated = useHeadTail ? true : end < full.length;

  const header: string[] = [
    `折叠块 ${blockId} 原文（覆盖 ${record.entryIds.length} 条消息，仅本次可见）`,
    useHeadTail
      ? `共 ${full.length} 字符，已展示开头 9K 与结尾 21K，中间未显示`
      : `字符 ${offset} - ${end} / ${full.length}${truncated ? `（还剩 ${full.length - end} 字符）` : "（已到末尾）"}`,
  ];
  if (record.topic !== undefined && record.topic.length > 0) header.splice(1, 0, `主题: ${record.topic}`);
  if (keywords.length > 0) header.push(`关键词 ${rawQuery} 命中 ${parts.length} 条，跳过 ${filtered} 条`);

  const body = useHeadTail ? clipHeadsAndTails(full, RECALL_MAX_CHARS) : slice;
  const footer: string[] = [];
  if (truncated) {
    const next = useHeadTail ? RECALL_MAX_CHARS : end;
    footer.push(`…中间部分用 recall("${blockId}", offset=${next}) 继续读。不要为了读完整块而反复翻页。`);
  }
  if (missing > 0) footer.push(`（其中 ${missing} 条已不在当前分支，已跳过）`);

  const sections = [header.join("\n\n"), "", body];
  if (footer.length > 0) sections.push("", footer.join("\n"));
  return sections.join("\n");
}
