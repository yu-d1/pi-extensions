import pg from "pg";
import mysql from "mysql2/promise";
import oracledb from "oracledb";

// ── 类型定义 ──────────────────────────────────────

export interface ConnConfig {
  type: "postgresql" | "mysql" | "oracle";
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: string;
  description: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
  comment: string;
}

export interface QueryResult {
  success: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  duration?: string;
  error?: string;
}

export interface ListTablesResult {
  success: boolean;
  tables?: TableInfo[];
  count?: number;
  error?: string;
}

export interface DescribeTableResult {
  success: boolean;
  columns?: ColumnInfo[];
  count?: number;
  error?: string;
}

export interface TestConnectionResult {
  success: boolean;
  version?: string;
  latency?: string;
  error?: string;
}

// ── 连接管理 ──────────────────────────────────────

type DbClient = pg.Client | mysql.Connection | oracledb.Connection;

interface DbConnection {
  type: ConnConfig["type"];
  client: DbClient;
  close(): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 超时（超过 ${timeoutMs / 1000} 秒）`));
    }, timeoutMs);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

export async function connect(config: ConnConfig, timeoutMs = 10_000): Promise<DbConnection> {
  const connPromise = _connect(config);
  const conn = await withTimeout(connPromise, timeoutMs, "连接数据库");
  return conn;
}

async function _connect(config: ConnConfig): Promise<DbConnection> {
  switch (config.type) {
    case "postgresql": {
      const client = new pg.Client({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database,
      });
      await client.connect();
      return {
        type: "postgresql",
        client,
        async close() { await client.end(); },
      };
    }
    case "mysql": {
      const conn = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database,
        charset: "utf8mb4",
      });
      return {
        type: "mysql",
        client: conn,
        async close() { await conn.end(); },
      };
    }
    case "oracle": {
      const conn = await oracledb.getConnection({
        user: config.username,
        password: config.password,
        connectString: `${config.host}:${config.port}/${config.database}`,
      });
      return {
        type: "oracle",
        client: conn,
        async close() { await conn.close(); },
      };
    }
  }
}

// ── SQL 拆分（支持多条语句） ──────────────────────

function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  let current: string[] = [];
  let inString = false;
  let stringChar: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      current.push(ch);
      if (ch === stringChar && (i === 0 || sql[i - 1] !== "\\")) {
        inString = false;
        stringChar = null;
      }
    } else if (ch === "'" || ch === '"') {
      current.push(ch);
      inString = true;
      stringChar = ch;
    } else if (ch === ";") {
      const stmt = current.join("").trim();
      if (stmt) stmts.push(stmt);
      current = [];
    } else {
      current.push(ch);
    }
  }
  const stmt = current.join("").trim();
  if (stmt) stmts.push(stmt);
  return stmts;
}

const NON_QUERY_RE = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|LOAD|MERGE|EXEC|EXECUTE|CALL)/i;
const DROP_TABLE_RE = /^\s*DROP\s+TABLE/i;

export function isWriteSql(sql: string): boolean {
  return NON_QUERY_RE.test(sql.trim());
}

export function isDropTable(sql: string): boolean {
  return DROP_TABLE_RE.test(sql.trim());
}

// ── 查询执行 ──────────────────────────────────────

export async function query(
  config: ConnConfig,
  sql: string,
  readonly: boolean,
  maxRows: number,
  timeoutSec: number,
): Promise<QueryResult> {
  const start = Date.now();

  if (!sql.trim()) {
    return { success: false, error: "SQL 语句不能为空" };
  }

  if (isDropTable(sql)) {
    return { success: false, error: "禁止通过 AI 执行 DROP TABLE 操作" };
  }

  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return { success: false, error: "没有有效的 SQL 语句" };
  }

  if (readonly) {
    for (const stmt of statements) {
      if (isWriteSql(stmt)) {
        return { success: false, error: `只读模式下不允许执行非查询语句: ${stmt.slice(0, 80)}` };
      }
    }
  }

  let conn: DbConnection | null = null;
  try {
    conn = await connect(config, timeoutSec * 1000);
    const { type, client: c } = conn;

    // 执行每条语句
    let lastResult: { columns: string[]; rows: unknown[][]; rowCount: number } = {
      columns: [], rows: [], rowCount: 0,
    };

    for (const stmt of statements) {
      const result = await executeWithTimeout(type, c, stmt, maxRows, timeoutSec * 1000);
      lastResult = result;
    }

    const duration = `${Date.now() - start}ms`;
    return { success: true, ...lastResult, duration };
  } catch (err: any) {
    const duration = `${Date.now() - start}ms`;
    return { success: false, error: err.message || String(err), duration };
  } finally {
    if (conn) await conn.close();
  }
}

async function executeWithTimeout(
  type: ConnConfig["type"],
  client: DbClient,
  stmt: string,
  maxRows: number,
  timeoutMs: number,
): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }> {
  if (type === "postgresql") {
    const pgClient = client as pg.Client;
    // 设置 statement_timeout
    await pgClient.query(`SET statement_timeout = '${timeoutMs}'`);
    const res = await pgClient.query(stmt);
    if (res.fields && res.fields.length > 0) {
      const columns = res.fields.map((f: any) => f.name);
      const rows = res.rows.slice(0, maxRows).map((r: any) => columns.map((col: string) => r[col]));
      return { columns, rows, rowCount: res.rows.length };
    }
    return { columns: [], rows: [], rowCount: res.rowCount ?? 0 };
  } else if (type === "mysql") {
    const mysqlConn = client as mysql.Connection;
    // 设置 max_execution_time
    await mysqlConn.execute(`SET max_execution_time = ${timeoutMs}`);
    const [rows, fields] = await mysqlConn.execute(stmt);
    if (Array.isArray(fields) && fields.length > 0) {
      const columns = fields.map((f: any) => f.name);
      const data = (rows as any[]).slice(0, maxRows).map((r: any) => columns.map((col: string) => r[col]));
      return { columns, rows: data, rowCount: (rows as any[]).length };
    }
    const affected = (rows as any)?.affectedRows ?? 0;
    return { columns: [], rows: [], rowCount: affected };
  } else {
    // oracle
    const oracleConn = client as oracledb.Connection;
    const res = await oracleConn.execute(stmt, [], {
      maxRows,
      fetchArraySize: maxRows,
      timeout: timeoutMs,
    });
    if (res.metaData && res.metaData.length > 0) {
      const columns = res.metaData.map((m: any) => m.name);
      const rows = (res.rows ?? []).slice(0, maxRows).map((r: any) => [...r]);
      return { columns, rows, rowCount: res.rows?.length ?? 0 };
    }
    return { columns: [], rows: [], rowCount: res.rowsAffected ?? 0 };
  }
}

// ── 列出表 ────────────────────────────────────────

export async function listTables(config: ConnConfig): Promise<ListTablesResult> {
  let conn: DbConnection | null = null;
  try {
    conn = await connect(config);
    const { type, client: c } = conn;

    let tables: TableInfo[] = [];

    if (type === "postgresql") {
      const pgClient = c as pg.Client;
      const res = await pgClient.query(`
        SELECT schemaname, tablename, obj_description(c.oid) AS description
        FROM pg_catalog.pg_tables t
        JOIN pg_catalog.pg_class c ON c.relname = t.tablename AND c.relnamespace = (
          SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = t.schemaname
        )
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, tablename
      `);
      tables = res.rows.map((r: any) => ({
        schema: r.schemaname,
        name: r.tablename,
        type: "TABLE",
        description: r.description || "",
      }));
    } else if (type === "mysql") {
      const mysqlConn = c as mysql.Connection;
      const [rows] = await mysqlConn.execute(
        "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        [config.database],
      );
      tables = (rows as any[]).map((r: any) => ({
        schema: "",
        name: r.TABLE_NAME,
        type: r.TABLE_TYPE === "BASE TABLE" ? "TABLE" : r.TABLE_TYPE,
        description: r.TABLE_COMMENT || "",
      }));
    } else {
      // oracle
      const oracleConn = c as oracledb.Connection;
      const res = await oracleConn.execute(
        `SELECT TABLE_NAME, OWNER, COMMENTS FROM ALL_TABLES T
         LEFT JOIN ALL_TAB_COMMENTS C ON T.TABLE_NAME = C.TABLE_NAME AND T.OWNER = C.OWNER
         WHERE T.OWNER NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'XDB')
         ORDER BY T.OWNER, T.TABLE_NAME`,
      );
      tables = (res.rows ?? []).map((r: any) => ({
        schema: r[1],
        name: r[0],
        type: "TABLE",
        description: r[2] || "",
      }));
    }

    return { success: true, tables, count: tables.length };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  } finally {
    if (conn) await conn.close();
  }
}

// ── 查看表结构 ────────────────────────────────────

export async function describeTable(config: ConnConfig, table: string): Promise<DescribeTableResult> {
  if (!table.trim()) {
    return { success: false, error: "表名不能为空" };
  }

  let conn: DbConnection | null = null;
  try {
    conn = await connect(config);
    const { type, client: c } = conn;

    let columns: ColumnInfo[] = [];

    if (type === "postgresql") {
      const pgClient = c as pg.Client;
      const parts = table.split(".");
      const schema = parts.length === 2 ? parts[0] : "public";
      const tableName = parts.length === 2 ? parts[1] : table;

      const res = await pgClient.query(`
        SELECT
          a.attname AS name,
          pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
          NOT a.attnotnull AS nullable,
          COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), '') AS default_val,
          COALESCE(ct.contype = 'p', FALSE) AS primary_key,
          COALESCE(cd.description, '') AS comment
        FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        LEFT JOIN pg_catalog.pg_description cd ON a.attrelid = cd.objoid AND a.attnum = cd.objsubid
        LEFT JOIN pg_catalog.pg_constraint ct ON a.attrelid = ct.conrelid
            AND ct.contype = 'p' AND a.attnum = ANY(ct.conkey)
        WHERE a.attrelid = (
          SELECT c.oid FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
          WHERE c.relname = $1 AND n.nspname = $2
        ) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [tableName, schema]);

      columns = res.rows.map((r: any) => ({
        name: r.name,
        type: r.type,
        nullable: r.nullable,
        default: r.default_val || null,
        primaryKey: r.primary_key,
        comment: r.comment,
      }));
    } else if (type === "mysql") {
      const mysqlConn = c as mysql.Connection;
      const safeTable = table.replace(/`/g, "``");
      const [rows] = await mysqlConn.execute(`DESCRIBE \`${safeTable}\``);
      columns = (rows as any[]).map((r: any) => ({
        name: r.Field,
        type: r.Type,
        nullable: r.Null === "YES",
        default: r.Default,
        primaryKey: r.Key === "PRI",
        comment: "",
      }));

      // 获取注释
      try {
        const [commentRows] = await mysqlConn.execute(
          "SELECT COLUMN_NAME, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
          [config.database, table],
        );
        const commentMap = new Map((commentRows as any[]).map((r: any) => [r.COLUMN_NAME, r.COLUMN_COMMENT]));
        for (const col of columns) {
          col.comment = commentMap.get(col.name) || "";
        }
      } catch { /* ignore */ }
    } else {
      // oracle
      const oracleConn = c as oracledb.Connection;
      const res = await oracleConn.execute(
        `SELECT
          COLUMN_NAME,
          DATA_TYPE || CASE WHEN DATA_PRECISION IS NOT NULL THEN '(' || DATA_PRECISION || ',' || DATA_SCALE || ')' WHEN DATA_LENGTH IS NOT NULL AND DATA_TYPE LIKE '%CHAR%' THEN '(' || DATA_LENGTH || ')' ELSE '' END,
          NULLABLE,
          DATA_DEFAULT,
          COMMENTS
        FROM ALL_TAB_COLUMNS C
        LEFT JOIN ALL_COL_COMMENTS COM ON C.TABLE_NAME = COM.TABLE_NAME AND C.COLUMN_NAME = COM.COLUMN_NAME AND C.OWNER = COM.OWNER
        WHERE C.TABLE_NAME = :1 AND C.OWNER NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'XDB')
        ORDER BY C.COLUMN_ID`,
        [table.toUpperCase()],
      );

      columns = (res.rows ?? []).map((r: any) => ({
        name: r[0],
        type: r[1],
        nullable: r[2] === "Y",
        default: r[3] || null,
        primaryKey: false,
        comment: r[4] || "",
      }));

      // 查主键
      try {
        const pkRes = await oracleConn.execute(
          `SELECT cc.COLUMN_NAME
           FROM ALL_CONS_COLUMNS cc
           JOIN ALL_CONSTRAINTS c ON cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND cc.OWNER = c.OWNER
           WHERE c.CONSTRAINT_TYPE = 'P' AND c.TABLE_NAME = :1`,
          [table.toUpperCase()],
        );
        const pkSet = new Set((pkRes.rows ?? []).map((r: any) => r[0]));
        for (const col of columns) {
          if (pkSet.has(col.name)) col.primaryKey = true;
        }
      } catch { /* ignore */ }
    }

    return { success: true, columns, count: columns.length };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  } finally {
    if (conn) await conn.close();
  }
}

// ── 测试连接 ──────────────────────────────────────

export async function testConnection(config: ConnConfig): Promise<TestConnectionResult> {
  const start = Date.now();
  let conn: DbConnection | null = null;
  try {
    conn = await connect(config);
    const { type, client: c } = conn;

    let version = "unknown";

    if (type === "postgresql") {
      const pgClient = c as pg.Client;
      const res = await pgClient.query("SELECT version()");
      version = res.rows[0].version.split(",")[0].trim();
    } else if (type === "mysql") {
      const mysqlConn = c as mysql.Connection;
      const [rows] = await mysqlConn.execute("SELECT version() AS v");
      version = (rows as any[])[0].v;
    } else {
      const oracleConn = c as oracledb.Connection;
      const res = await oracleConn.execute("SELECT version FROM v$instance");
      version = (res.rows ?? [])[0]?.[0] ?? "unknown";
    }

    const latency = `${Date.now() - start}ms`;
    return { success: true, version, latency };
  } catch (err: any) {
    const latency = `${Date.now() - start}ms`;
    return { success: false, error: err.message || String(err), latency };
  } finally {
    if (conn) await conn.close();
  }
}