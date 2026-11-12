import { DEFAULT_PORTS, type DbConfig, type DbType } from "./config.js";

export interface ParsedJdbcUrl {
  type: DbType;
  host: string;
  port: number;
  /** 库名（Oracle 为服务名）可空：空表示连接不绑定具体库，连上后再选择要启用的库 */
  database?: string;
}

const SUPPORTED_HINT = [
  "支持格式（库名可省略，省略后可查询该连接下的全部库）:",
  "  PostgreSQL: jdbc:postgresql://host:5432",
  "  MySQL:      jdbc:mysql://host:3306",
  "  Oracle:     jdbc:oracle:thin:@//host:1521/service（Oracle 必须提供服务名）",
  "  Oracle SID: jdbc:oracle:thin:@host:1521:sid",
].join("\n");

export function jdbcFormatHint(): string {
  return SUPPORTED_HINT;
}

function toPort(raw: string | undefined, type: DbType): number {
  const port = raw ? Number.parseInt(raw, 10) : DEFAULT_PORTS[type];
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORTS[type];
}

/** 解析 JDBC URL，无法识别时返回 undefined。库名可省略 */
export function parseJdbcUrl(url: string): ParsedJdbcUrl | undefined {
  const raw = url.trim();
  if (!raw) return undefined;

  // 允许省略 jdbc: 前缀，例如 postgresql://host:5432/db
  const input = raw.toLowerCase().startsWith("jdbc:") ? raw.slice(5) : raw;

  // PostgreSQL / MySQL: postgresql://host:port[/database]
  const simple = input.match(/^(postgresql|postgres|mysql):\/\/([^/:?]+)(?::(\d+))?(?:\/([^?;/]*))?/i);
  if (simple) {
    const type: DbType = simple[1].toLowerCase().startsWith("postgres") ? "postgresql" : "mysql";
    const database = (simple[4] ?? "").trim();
    return {
      type,
      host: simple[2],
      port: toPort(simple[3], type),
      database: database || undefined,
    };
  }

  // Oracle service name: oracle:thin:@//host:port/service
  const oraService = input.match(/^oracle:thin:@\/\/([^/:?]+)(?::(\d+))?\/([^?;/]+)/i);
  if (oraService) {
    return {
      type: "oracle",
      host: oraService[1],
      port: toPort(oraService[2], "oracle"),
      database: oraService[3],
    };
  }

  // Oracle SID: oracle:thin:@host:port:sid
  const oraSid = input.match(/^oracle:thin:@([^/:?]+)(?::(\d+))?:([^?;]+)/i);
  if (oraSid) {
    return {
      type: "oracle",
      host: oraSid[1],
      port: toPort(oraSid[2], "oracle"),
      database: oraSid[3],
    };
  }

  return undefined;
}

export function buildJdbcUrl(config: Pick<DbConfig, "type" | "host" | "port" | "database">): string {
  if (config.type === "oracle") {
    return `jdbc:oracle:thin:@//${config.host}:${config.port}/${config.database}`;
  }
  const base = `jdbc:${config.type}://${config.host}:${config.port}`;
  return config.database ? `${base}/${config.database}` : base;
}
