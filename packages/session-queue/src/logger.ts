import { LOG_PREFIX } from "./constants";
import type { Logger } from "./types";

export interface LoggerOptions {
  /** pi 提供的 log 函数（可选），例如 pi.log?.(...) */
  piLog?: (message: string, level?: string) => void;
  /** 是否输出到 console；默认仅 warn/error 输出，避免污染 TUI。 */
  consoleEnabled?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const piLog = options.piLog;
  const consoleEnabled = options.consoleEnabled ?? true;

  function log(level: "debug" | "info" | "warn" | "error", message: string, args: unknown[]): void {
    const full = `${LOG_PREFIX} ${message}${args.length > 0 ? " " + args.map(String).join(" ") : ""}`;
    try {
      piLog?.(full, level);
    } catch {
      // 日志失败不影响主流程。
    }
    if (!consoleEnabled) return;
    if (level === "warn") console.warn(full);
    if (level === "error") console.error(full);
  }

  return {
    debug: (m, ...a) => log("debug", m, a),
    info: (m, ...a) => log("info", m, a),
    warn: (m, ...a) => log("warn", m, a),
    error: (m, ...a) => log("error", m, a),
  };
}
