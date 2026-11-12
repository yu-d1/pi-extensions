// ── SQL 解析与安全判定 ────────────────────────────
// 目标：在交给数据库之前把多语句拆开，逐条判定读写性质，
// 避免 "SELECT 1; DELETE FROM t" 或 "/*x*/UPDATE ..." 这类绕过。

export interface SqlStatement {
  /** 去掉前后空白后的原始语句（含注释，交给数据库执行） */
  sql: string;
  /** 去掉注释后的文本，用于关键字判定 */
  stripped: string;
}

/**
 * 移除 SQL 注释并把字符串字面量内容抹掉（只保留引号）。
 * 抹掉字面量是为了避免 `SELECT 'DROP TABLE t'` 这类文本被误判为危险语句。
 * 支持 -- 行注释、# 行注释（MySQL）、/* *\/ 块注释，以及 ' " ` 三种引号与 $$ 美元引号。
 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释。#> 与 #>> 是 PostgreSQL 的 JSON 操作符，不能当作注释
    const isHashComment = ch === "#" && next !== ">";
    if ((ch === "-" && next === "-") || isHashComment) {
      while (i < len && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    // 块注释（PostgreSQL 支持嵌套）
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }

    // 美元引号（PostgreSQL）：$$...$$ 或 $tag$...$tag$
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i, i + 64));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? len : end + tag.length;
        out += " '' ";
        continue;
      }
    }

    // 引号字面量：内容抹掉，只留引号
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < len) {
        const c = sql[i];
        if (c === "\\") { i += 2; continue; }
        if (c === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += `${quote}${quote}`;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** 按分号拆分语句，忽略引号与注释里的分号 */
export function splitStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let current = "";
  let i = 0;
  const len = sql.length;

  const push = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || /^;+$/.test(trimmed)) return;
    statements.push({ sql: trimmed, stripped: stripComments(trimmed).replace(/\s+/g, " ").trim() });
  };

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    const isHashComment = ch === "#" && next !== ">";
    if ((ch === "-" && next === "-") || isHashComment) {
      const start = i;
      while (i < len && sql[i] !== "\n") i++;
      current += sql.slice(start, i) + "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      current += sql.slice(start, i);
      continue;
    }

    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i, i + 64));
      if (tagMatch) {
        const tag = tagMatch[0];
        const start = i;
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? len : end + tag.length;
        current += sql.slice(start, i);
        continue;
      }
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const start = i;
      i++;
      while (i < len) {
        const c = sql[i];
        if (c === "\\") { i += 2; continue; }
        if (c === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      current += sql.slice(start, i);
      continue;
    }

    if (ch === ";") {
      push(current);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  push(current);
  return statements;
}

const WRITE_PATTERNS: RegExp[] = [
  /^(INSERT|UPDATE|DELETE|MERGE|UPSERT)\b/i,
  /^(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/i,
  /^(GRANT|REVOKE)\b/i,
  /^(CALL|EXEC|EXECUTE)\b/i,
  /^(DO|DECLARE|BEGIN)\b/i,
  /^(LOCK|UNLOCK)\b/i,
  /^(COMMENT)\b/i,
  /^(VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH)\b/i,
  /^(COPY)\b/i,
  /^(LOAD|REPLACE|IMPORT)\b/i,
  /^(SET|RESET)\b/i,
  /^(PRAGMA)\b/i,
];

/** 是否包含写入/变更意图（CTE 开头时会递归检查是否带写关键字） */
export function isWriteStatement(stripped: string): boolean {
  const text = stripped.trim();
  if (!text) return false;
  if (WRITE_PATTERNS.some((re) => re.test(text))) return true;
  // WITH ... INSERT/UPDATE/DELETE：跳过 WITH 子句主体，检查是否出现写关键字
  if (/^WITH\b/i.test(text)) {
    return /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(text);
  }
  return false;
}

/** 是否为 DROP TABLE（硬限制，任何配置下都禁止） */
export function isDropTableStatement(stripped: string): boolean {
  return /\bDROP\s+(TABLE|VIEW|INDEX|SCHEMA|DATABASE|MATERIALIZED\s+VIEW)\b/i.test(stripped.trim());
}

export interface SqlPolicyResult {
  allowed: boolean;
  /** 拒绝原因，allowed 为 true 时为空 */
  reason?: string;
}

/**
 * 按只读策略校验整段 SQL：逐条拆分后判定，任一条违规即整体拒绝。
 */
export function checkSqlPolicy(sql: string, readonly: boolean): SqlPolicyResult {
  if (!sql.trim()) {
    return { allowed: false, reason: "SQL 语句不能为空" };
  }

  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return { allowed: false, reason: "没有有效的 SQL 语句" };
  }

  for (const stmt of statements) {
    if (isDropTableStatement(stmt.stripped)) {
      return {
        allowed: false,
        reason: "禁止执行 DROP TABLE / DROP DATABASE 等删除结构操作。如需删除，请手动连接数据库执行。",
      };
    }
  }

  if (readonly) {
    for (const stmt of statements) {
      if (isWriteStatement(stmt.stripped)) {
        return {
          allowed: false,
          reason: `当前为只读模式，不允许执行非查询语句: ${stmt.sql.slice(0, 80)}`,
        };
      }
    }
  }

  return { allowed: true };
}
