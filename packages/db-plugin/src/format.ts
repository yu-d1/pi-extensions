import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { DbConfig, PluginConfig } from "./config.js";
import type { ConnConfig } from "./connection.js";

// ── 配置到连接的转换 ──────────────────────────────

/** 用连接配置 + 目标库拼出实际连接参数；database 可省略 */
export function toConnConfig(target: { config: DbConfig; database?: string }): ConnConfig {
  return {
    type: target.config.type,
    host: target.config.host,
    port: target.config.port,
    username: target.config.username,
    password: target.config.password,
    database: target.database || undefined,
  };
}

// ── 结果格式化 ────────────────────────────────────

/** 单元格转文本：null 显式标注，换行与制表符压平，过长截断 */
function formatCell(value: unknown, maxLength = 300): string {
  if (value === null || value === undefined) return "NULL";
  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === "object") {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  text = text.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export interface TableTextOptions {
  columns: string[];
  rows: unknown[][];
  /** 总行数（可能大于已返回行数） */
  rowCount: number;
}

/** 渲染为 Markdown 表格文本，并统一截断到工具输出上限 */
export function renderRows(options: TableTextOptions): { text: string; truncatedOutput: boolean } {
  const { columns, rows, rowCount } = options;
  if (columns.length === 0) {
    return { text: `执行成功，影响 ${rowCount} 行。`, truncatedOutput: false };
  }

  const lines: string[] = [];
  lines.push(`列: ${columns.join(", ")}`);
  lines.push("");
  lines.push(`| ${columns.join(" | ")} |`);
  lines.push(`| ${columns.map(() => "---").join(" | ")} |`);

  for (const row of rows) {
    lines.push(`| ${columns.map((_c, i) => formatCell(row[i])).join(" | ")} |`);
  }

  if (rows.length === 0) {
    lines.push("");
    lines.push("无数据返回。");
  } else if (rowCount > rows.length) {
    lines.push("");
    lines.push(`结果共 ${rowCount} 行，已按最大行数限制显示前 ${rows.length} 行。`);
  }

  const result = truncateHead(lines.join("\n"), {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!result.truncated) return { text: result.content, truncatedOutput: false };

  return {
    text:
      `${result.content}\n\n[输出已截断: ${result.outputLines}/${result.totalLines} 行, ` +
      `${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}。请缩小查询范围或增加过滤条件。]`,
    truncatedOutput: true,
  };
}

/** 摘要行：目标、耗时、行数 */
export function renderSummary(label: string, durationMs: number, rowCount: number, cfg: PluginConfig): string {
  const limit = cfg.max_rows > 0 ? `${cfg.max_rows}` : "不限制";
  return `数据库: ${label} | 耗时: ${durationMs}ms | 返回行数: ${rowCount} | 最大行数: ${limit}`;
}

// ── 通用错误文本 ──────────────────────────────────

export function truncatePlainText(text: string): { text: string; truncated: boolean } {
  const result = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!result.truncated) return { text: result.content, truncated: false };
  return {
    text: `${result.content}\n\n[输出已截断: ${result.outputLines}/${result.totalLines} 行]`,
    truncated: true,
  };
}
