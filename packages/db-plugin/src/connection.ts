import pg from "pg";
import mysql from "mysql2/promise";
import oracledb from "oracledb";
import type { DbType } from "./config.js";

// ── 公共类型 ──────────────────────────────────────

export interface ConnConfig {
  type: DbType;
  host: string;
  port: number;
  username: string;
  password: string;
  /** 目标库；省略表示不绑定库（用于扫描库清单） */
  database?: string;
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

export interface ExecuteResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

export interface QueryResult extends ExecuteResult {
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface ListTablesResult {
  success: boolean;
  tables: TableInfo[];
  error?: string;
}

export interface DescribeTableResult {
  success: boolean;
  columns: ColumnInfo[];
  error?: string;
}

export interface TestConnectionResult {
  success: boolean;
  version?: string;
  latencyMs: number;
  error?: string;
}

export interface ListDatabasesResult {
  success: boolean;
  databases: string[];
  error?: string;
}

// ── 工具函数 ──────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** 按最大行数截取，0 表示不限制 */
function capRows<T>(rows: T[], maxRows: number): T[] {
  if (!maxRows || maxRows <= 0) return rows;
  return rows.length > maxRows ? rows.slice(0, maxRows) : rows;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

// ── 驱动会话抽象 ──────────────────────────────────

interface DriverSession {
  exec(statement: string, maxRows: number): Promise<ExecuteResult>;
  close(): Promise<void>;
}

async function openSession(config: ConnConfig, timeoutMs: number): Promise<DriverSession> {
  switch (config.type) {
    case "postgresql":
      return openPostgres(config, timeoutMs);
    case "mysql":
      return openMysql(config, timeoutMs);
    case "oracle":
      return openOracle(config, timeoutMs);
  }
}

async function openPostgres(config: ConnConfig, timeoutMs: number): Promise<DriverSession> {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    // PostgreSQL 必须指定一个库；未绑定库时用维护库 postgres（不存在时回退到与用户同名库）
    database: config.database || "postgres",
    // 服务端语句超时 + 客户端网络超时，避免长事务挂死
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
    connectionTimeoutMillis: timeoutMs,
  });

  // 必须常驻 error 监听：连接空闲时 socket 断开会 emit('error')，
  // 无监听者会让整个进程抛未捕获异常
  let sessionError: Error | undefined;
  client.on("error", (err: Error) => {
    sessionError = err;
  });

  try {
    await client.connect();
  } catch (err) {
    // 连接失败的 client 仍持有半开的 socket，必须显式 end
    await client.end().catch(() => undefined);
    throw err;
  }

  return {
    async exec(statement, maxRows) {
      if (sessionError) throw sessionError;
      const res = await client.query({ text: statement, rowMode: "array" });
      const columns = Array.isArray(res.fields) ? res.fields.map((f: any) => String(f.name)) : [];
      const rows = Array.isArray(res.rows) ? res.rows : [];
      return {
        columns,
        rows: capRows(rows, maxRows),
        rowCount: columns.length > 0 ? rows.length : (res.rowCount ?? 0),
      };
    },
    async close() {
      // end() 内部会在仍有活动查询时 destroy socket，不会卡住
      await client.end();
    },
  };
}

async function openMysql(config: ConnConfig, timeoutMs: number): Promise<DriverSession> {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    ...(config.database ? { database: config.database } : {}),
    charset: "utf8mb4",
    connectTimeout: timeoutMs,
    multipleStatements: false,
  });

  // 静默 socket 错误：连接断开后后续命令会 reject，无需监听器也能拿到错误；
  // 但未监听的 error 事件会直接抛到进程，这里先掳住
  let sessionError: Error | undefined;
  conn.on("error", (err: Error) => {
    sessionError = err;
  });

  // 服务端只对 SELECT 生效，其余靠客户端超时兜底
  try {
    await conn.query("SET SESSION MAX_EXECUTION_TIME = ?", [Math.round(timeoutMs)]);
  } catch {
    // 老版本 MySQL / MariaDB 不支持，忽略
  }

  return {
    async exec(statement, maxRows) {
      if (sessionError) throw sessionError;
      // 用 query 走文本协议：DDL 与预处理不兼容的语句也能执行
      const [rows, fields] = await conn.query({ sql: statement, timeout: timeoutMs });
      const fieldList = Array.isArray(fields) ? fields : [];
      if (fieldList.length > 0) {
        const columns = fieldList.map((f: any) => String(f.name));
        const data = Array.isArray(rows) ? (rows as any[]) : [];
        return {
          columns,
          rows: capRows(data.map((r) => columns.map((c) => r[c])), maxRows),
          rowCount: data.length,
        };
      }
      const affected = (rows as any)?.affectedRows;
      return { columns: [], rows: [], rowCount: Number(affected ?? 0) };
    },
    async close() {
      // 查询未结束时不发 QUIT，直接断 socket，避免 end() 等待挂死的命令队列
      if (sessionError) {
        conn.destroy();
        return;
      }
      await conn.end();
    },
  };
}

async function openOracle(config: ConnConfig, timeoutMs: number): Promise<DriverSession> {
  const conn = await oracledb.getConnection({
    user: config.username,
    password: config.password,
    connectString: `${config.host}:${config.port}/${config.database ?? ""}`,
  });

  // 连上之后的初始化失败也要回滚，不能把连接留在后台
  try {
    conn.callTimeout = Math.round(timeoutMs);
  } catch {
    // 驱动版本不支持时忽略
  }

  // 执行期间查询到的 LOB 游标需要显式销毁
  const lobs: Array<{ destroy(): Promise<void> | void }> = [];

  return {
    async exec(statement, maxRows) {
      const res = await conn.execute<any>(statement, [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        fetchArraySize: maxRows > 0 ? Math.min(maxRows, 1000) : 1000,
      });
      const columns = Array.isArray(res.metaData) ? res.metaData.map((m: any) => String(m.name)) : [];
      const rows = Array.isArray(res.rows) ? (res.rows as unknown[][]) : [];

      // 收集结果中的 LOB，close 前统一释放
      for (const row of rows) {
        for (const value of row) {
          if (value && typeof value === "object" && typeof (value as any).destroy === "function") {
            lobs.push(value as any);
          }
        }
      }

      return {
        columns,
        rows: capRows(rows, maxRows),
        rowCount: columns.length > 0 ? rows.length : Number(res.rowsAffected ?? 0),
      };
    },
    async close() {
      // 先释放 LOB，再关连接；close 失败时用 drop 强制断连，
      // 避免未提交事务把关闭操作阻塞住
      for (const lob of lobs.splice(0)) {
        try {
          await lob.destroy();
        } catch {
          // 已释放或驱动不支时忽略
        }
      }
      try {
        await conn.close();
      } catch {
        await conn.close({ drop: true }).catch(() => undefined);
      }
    },
  };
}

/**
 * 打开会话并执行一段逻辑，结束后一定会关闭连接。
 *
 * 注意：连接超时后底层的建连 promise 仍可能稍后完建，但我们已经抛错。
 * 如果不接住它，那个连接会永远泄漏，因此这里额外挂上关闭回调。
 */
async function withSession<T>(
  config: ConnConfig,
  timeoutMs: number,
  fn: (session: DriverSession) => Promise<T>,
): Promise<T> {
  const opening = openSession(config, timeoutMs);

  let session: DriverSession;
  try {
    session = await withTimeout(opening, timeoutMs, "连接数据库");
  } catch (err) {
    // 超时/提前失败：建连完成后立即关掉，避免连接泄漏
    void opening
      .then((late) => late.close())
      .catch(() => undefined);
    throw err;
  }

  try {
    return await fn(session);
  } finally {
    await session.close().catch(() => undefined);
  }
}

// ── 对外能力 ──────────────────────────────────────

export async function query(
  config: ConnConfig,
  statements: string[],
  maxRows: number,
  timeoutSec: number,
): Promise<QueryResult> {
  const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
  const start = Date.now();

  try {
    return await withSession(config, timeoutMs, async (session) => {
      let last: ExecuteResult = { columns: [], rows: [], rowCount: 0 };
      for (const statement of statements) {
        last = await withTimeout(session.exec(statement, maxRows), timeoutMs, "SQL 执行");
      }
      return { success: true, ...last, durationMs: Date.now() - start };
    });
  } catch (err) {
    return { success: false, columns: [], rows: [], rowCount: 0, durationMs: Date.now() - start, error: errorMessage(err) };
  }
}

export async function listTables(config: ConnConfig, timeoutSec = 15): Promise<ListTablesResult> {
  const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
  try {
    const tables = await withSession(config, timeoutMs, async (session) => {
      const { columns, rows } = await withTimeout(
        session.exec(listTablesSql(config.type), 0),
        timeoutMs,
        "查询表列表",
      );
      return normalizeTables(columns, rows);
    });
    return { success: true, tables };
  } catch (err) {
    return { success: false, tables: [], error: errorMessage(err) };
  }
}

export async function describeTable(
  config: ConnConfig,
  table: string,
  timeoutSec = 15,
): Promise<DescribeTableResult> {
  const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
  const target = table.trim();
  if (!target) {
    return { success: false, columns: [], error: "表名不能为空" };
  }

  try {
    const columns = await withSession(config, timeoutMs, async (session) => {
      let result: ColumnInfo[] = [];
      const primaryKeys = new Set<string>();
      for (const step of describeTablePlan(config, target)) {
        const { columns: names, rows } = await withTimeout(session.exec(step.sql, 0), timeoutMs, "查询表结构");
        if (step.kind === "primaryKeys") {
          for (const row of step.map(names, rows)) primaryKeys.add(row.name);
        } else {
          result = step.map(names, rows);
        }
      }
      if (primaryKeys.size > 0) {
        for (const column of result) {
          if (primaryKeys.has(column.name)) column.primaryKey = true;
        }
      }
      return result;
    });
    return { success: true, columns };
  } catch (err) {
    return { success: false, columns: [], error: errorMessage(err) };
  }
}

export async function testConnection(config: ConnConfig, timeoutSec = 10): Promise<TestConnectionResult> {
  const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
  const start = Date.now();
  try {
    const version = await withSession(config, timeoutMs, async (session) => {
      for (const sql of versionSqls(config.type)) {
        try {
          const { rows } = await withTimeout(session.exec(sql, 1), timeoutMs, "查询版本");
          const value = rows[0]?.[0];
          if (value !== undefined && value !== null) return String(value);
        } catch {
          // 当前账号无权限访问该视图，尝试下一条
        }
      }
      return "unknown";
    });
    return { success: true, version, latencyMs: Date.now() - start };
  } catch (err) {
    return { success: false, latencyMs: Date.now() - start, error: errorMessage(err) };
  }
}

// ── 方言 SQL ──────────────────────────────────────

/**
 * 列出服务器上可连接的库（Oracle 无法枚举服务名，返回当前服务名）。
 * 结果用于「启用」界面作为候选清单。
 */
export async function listDatabases(
  config: ConnConfig,
  timeoutSec = 10,
): Promise<ListDatabasesResult> {
  const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));

  if (config.type === "oracle") {
    return { success: true, databases: config.database ? [config.database] : [] };
  }

  const sql =
    config.type === "postgresql"
      ? "SELECT datname FROM pg_catalog.pg_database WHERE datallowconn = true AND NOT datistemplate ORDER BY datname"
      : "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME";

  // 未绑定库时，PostgreSQL 依次尝试维护库与同名库（去重，避免重复连接）
  const candidates: (string | undefined)[] =
    config.type === "postgresql" && !config.database
      ? [...new Set(["postgres", config.username].filter(Boolean))]
      : [config.database];

  let lastError = "";
  for (const database of candidates) {
    try {
      // database 可能为 undefined，此时由 openPostgres 自带回退逻辑处理
      const databases = await withSession({ ...config, database }, timeoutMs, async (session) => {
        const { rows } = await withTimeout(session.exec(sql, 0), timeoutMs, "查询库列表");
        return rows.map((row) => toText(row[0]).trim()).filter((name) => name.length > 0);
      });
      return { success: true, databases };
    } catch (err) {
      lastError = errorMessage(err);
    }
  }

  return { success: false, databases: [], error: lastError };
}

/** 版本查询按顺序尝试，低权限账号也能拿到可读结果 */
function versionSqls(type: DbType): string[] {
  switch (type) {
    case "postgresql":
      return ["SELECT version()"];
    case "mysql":
      return ["SELECT version()"];
    case "oracle":
      return [
        "SELECT banner FROM v$version WHERE ROWNUM = 1",
        "SELECT version_full FROM v$instance",
        "SELECT version FROM v$instance",
        "SELECT 1 FROM DUAL",
      ];
  }
}

function listTablesSql(type: DbType): string {
  switch (type) {
    case "postgresql":
      return `
        SELECT n.nspname AS schema_name,
               c.relname AS table_name,
               CASE c.relkind
                 WHEN 'r' THEN 'TABLE'
                 WHEN 'p' THEN 'TABLE'
                 WHEN 'v' THEN 'VIEW'
                 WHEN 'm' THEN 'MATERIALIZED VIEW'
                 WHEN 'f' THEN 'FOREIGN TABLE'
                 ELSE c.relkind::text
               END AS table_type,
               COALESCE(obj_description(c.oid, 'pg_class'), '') AS table_comment
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY n.nspname, c.relname`;
    case "mysql":
      return `
        SELECT TABLE_SCHEMA AS schema_name,
               TABLE_NAME AS table_name,
               CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'TABLE' ELSE TABLE_TYPE END AS table_type,
               COALESCE(TABLE_COMMENT, '') AS table_comment
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_SCHEMA, TABLE_NAME`;
    case "oracle":
      return `
        SELECT t.OWNER AS schema_name,
               t.TABLE_NAME AS table_name,
               'TABLE' AS table_type,
               COALESCE(c.COMMENTS, '') AS table_comment
        FROM ALL_TABLES t
        LEFT JOIN ALL_TAB_COMMENTS c
          ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
        WHERE t.OWNER NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'XDB', 'OUTLN', 'GSMADMIN_INTERNAL')
          AND t.OWNER = USER
        ORDER BY t.OWNER, t.TABLE_NAME`;
  }
}

function normalizeTables(columns: string[], rows: unknown[][]): TableInfo[] {
  const indexOf = (name: string) => columns.findIndex((c) => c.toLowerCase() === name);

  const schemaIdx = indexOf("schema_name");
  const tableIdx = indexOf("table_name");
  const typeIdx = indexOf("table_type");
  const commentIdx = indexOf("table_comment");

  return rows.map((row) => ({
    schema: toText(row[schemaIdx]),
    name: toText(row[tableIdx]),
    type: toText(row[typeIdx]) || "TABLE",
    description: toText(row[commentIdx]),
  }));
}

interface DescribeStep {
  sql: string;
  map: (columns: string[], rows: unknown[][]) => ColumnInfo[];
  /** primaryKeys 步骤只用于回填主键标记，不参与列清单 */
  kind?: "columns" | "primaryKeys";
}

function splitQualified(table: string): { schema?: string; name: string } {
  const dot = table.indexOf(".");
  if (dot < 0) return { name: table };
  return { schema: table.slice(0, dot), name: table.slice(dot + 1) };
}

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function describeTablePlan(config: ConnConfig, table: string): DescribeStep[] {
  const { schema, name } = splitQualified(table);

  if (config.type === "postgresql") {
    const schemaName = schema ?? "public";
    return [{
      sql: `
        SELECT a.attname AS column_name,
               pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
               NOT a.attnotnull AS is_nullable,
               COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), '') AS column_default,
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_constraint ct
                 WHERE ct.conrelid = a.attrelid AND ct.contype = 'p' AND a.attnum = ANY (ct.conkey)
               ) AS is_primary,
               COALESCE(cd.description, '') AS column_comment
        FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        LEFT JOIN pg_catalog.pg_description cd ON cd.objoid = a.attrelid AND cd.objsubid = a.attnum
        WHERE a.attrelid = (
                SELECT c.oid FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relname = '${escapeLiteral(name)}' AND n.nspname = '${escapeLiteral(schemaName)}'
              )
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum`,
      map: (columns, rows) => {
        const idx = (n: string) => columns.findIndex((c) => c.toLowerCase() === n);
        const nameIdx = idx("column_name");
        const typeIdx = idx("data_type");
        const nullIdx = idx("is_nullable");
        const defaultIdx = idx("column_default");
        const pkIdx = idx("is_primary");
        const commentIdx = idx("column_comment");
        return rows.map((r) => ({
          name: toText(r[nameIdx]),
          type: toText(r[typeIdx]),
          nullable: r[nullIdx] === true || r[nullIdx] === "t" || r[nullIdx] === 1,
          default: toText(r[defaultIdx]) || null,
          primaryKey: r[pkIdx] === true || r[pkIdx] === "t" || r[pkIdx] === 1,
          comment: toText(r[commentIdx]),
        }));
      },
    }];
  }

  if (config.type === "mysql") {
    const schemaName = schema ?? config.database;
    return [{
      sql: `
        SELECT COLUMN_NAME AS column_name,
               COLUMN_TYPE AS data_type,
               IS_NULLABLE AS is_nullable,
               COLUMN_DEFAULT AS column_default,
               COLUMN_KEY AS column_key,
               COALESCE(COLUMN_COMMENT, '') AS column_comment
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = '${escapeLiteral(schemaName)}' AND TABLE_NAME = '${escapeLiteral(name)}'
        ORDER BY ORDINAL_POSITION`,
      map: (columns, rows) => {
        const idx = (n: string) => columns.findIndex((c) => c.toLowerCase() === n);
        const nameIdx = idx("column_name");
        const typeIdx = idx("data_type");
        const nullIdx = idx("is_nullable");
        const defaultIdx = idx("column_default");
        const keyIdx = idx("column_key");
        const commentIdx = idx("column_comment");
        return rows.map((r) => ({
          name: toText(r[nameIdx]),
          type: toText(r[typeIdx]),
          nullable: toText(r[nullIdx]).toUpperCase() === "YES",
          default: toText(r[defaultIdx]) || null,
          primaryKey: toText(r[keyIdx]).toUpperCase() === "PRI",
          comment: toText(r[commentIdx]),
        }));
      },
    }];
  }

  // Oracle：列信息与主键分两步查，owner 缺省为当前用户可见范围
  const ownerFilter = schema
    ? `AND C.OWNER = '${escapeLiteral(schema.toUpperCase())}'`
    : "";
  return [{
    sql: `
      SELECT C.COLUMN_NAME AS column_name,
             C.DATA_TYPE ||
               CASE
                 WHEN C.DATA_TYPE IN ('NUMBER', 'FLOAT') AND C.DATA_PRECISION IS NOT NULL
                   THEN '(' || C.DATA_PRECISION || CASE WHEN NVL(C.DATA_SCALE, 0) > 0 THEN ',' || C.DATA_SCALE ELSE '' END || ')'
                 WHEN C.DATA_TYPE LIKE '%CHAR%' AND C.CHAR_LENGTH IS NOT NULL
                   THEN '(' || C.CHAR_LENGTH || ')'
                 ELSE ''
               END AS data_type,
             C.NULLABLE AS is_nullable,
             C.DATA_DEFAULT AS column_default,
             COALESCE(COM.COMMENTS, '') AS column_comment
      FROM ALL_TAB_COLUMNS C
      LEFT JOIN ALL_COL_COMMENTS COM
        ON COM.OWNER = C.OWNER AND COM.TABLE_NAME = C.TABLE_NAME AND COM.COLUMN_NAME = C.COLUMN_NAME
      WHERE C.TABLE_NAME = '${escapeLiteral(name.toUpperCase())}' ${ownerFilter}
      ORDER BY C.OWNER, C.COLUMN_ID`,
    map: (columns, rows) => {
      const idx = (n: string) => columns.findIndex((c) => c.toLowerCase() === n);
      const nameIdx = idx("column_name");
      const typeIdx = idx("data_type");
      const nullIdx = idx("is_nullable");
      const defaultIdx = idx("column_default");
      const commentIdx = idx("column_comment");
      return rows.map((r) => ({
        name: toText(r[nameIdx]),
        type: toText(r[typeIdx]),
        nullable: toText(r[nullIdx]).toUpperCase() === "Y",
        default: toText(r[defaultIdx]) || null,
        primaryKey: false,
        comment: toText(r[commentIdx]),
      }));
    },
  }, {
    sql: `
      SELECT CC.COLUMN_NAME AS column_name
      FROM ALL_CONS_COLUMNS CC
      JOIN ALL_CONSTRAINTS C
        ON C.OWNER = CC.OWNER AND C.CONSTRAINT_NAME = CC.CONSTRAINT_NAME
      WHERE C.CONSTRAINT_TYPE = 'P'
        AND C.TABLE_NAME = '${escapeLiteral(name.toUpperCase())}'
        ${schema ? `AND C.OWNER = '${escapeLiteral(schema.toUpperCase())}'` : ""}`,
    kind: "primaryKeys",
    map: (columns, rows) => {
      const nameIdx = columns.findIndex((c) => c.toLowerCase() === "column_name");
      return rows.map((r) => ({
        name: toText(r[nameIdx]),
        type: "",
        nullable: false,
        default: null,
        primaryKey: true,
        comment: "",
      }));
    },
  }];
}
