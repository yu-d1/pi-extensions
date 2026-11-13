import { readFileSync } from "node:fs";
import { Client } from "ssh2";
import type { SshConfig } from "./config.js";

// ── 类型 ──────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

/** 输出上限，避免 `cat` 大文件把上下文撑爆 */
const MAX_OUTPUT_BYTES = 60 * 1024;

function capOutput(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  // 按字符安全截断，避免切断多字节
  let acc = 0;
  let out = "";
  for (const ch of text) {
    acc += Buffer.byteLength(ch);
    if (acc > MAX_OUTPUT_BYTES) break;
    out += ch;
  }
  return { text: out, truncated: true };
}

/** 组装连接参数，密钥优先于密码 */
function connectOptions(config: SshConfig, readyTimeoutMs: number): Record<string, unknown> | { error: string } {
  const opts: Record<string, unknown> = {
    host: config.host,
    port: config.port || 22,
    username: config.username,
    readyTimeout: readyTimeoutMs,
    // 不保留残留的 keepalive，连接生命周期由调用方控制
    keepaliveInterval: 0,
  };

  if (config.keyPath) {
    try {
      opts.privateKey = readFileSync(config.keyPath);
    } catch (err: any) {
      return { error: `无法读取密钥 ${config.keyPath}: ${err?.message ?? err}` };
    }
  } else if (config.password) {
    opts.password = config.password;
  } else {
    return { error: "未提供密钥或密码" };
  }
  return opts;
}

// ── 测试连通性 ────────────────────────────────────

export function testConnection(config: SshConfig, timeoutSec = 8): Promise<TestResult> {
  return new Promise((resolve) => {
    const built = connectOptions(config, Math.max(1, Math.round(timeoutSec * 1000)));
    if ("error" in built && typeof built.error === "string") {
      resolve({ ok: false, error: built.error });
      return;
    }

    const conn = new Client();
    let settled = false;

    // 无论成功失败都必须 end()，否则半开连接会留在后台
    const finish = (result: TestResult) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        // 已关闭时忽略
      }
      resolve(result);
    };

    conn.once("ready", () => finish({ ok: true }));
    conn.once("error", (err: Error) => finish({ ok: false, error: err.message }));
    conn.once("close", () => finish({ ok: false, error: "连接已关闭" }));

    try {
      conn.connect(built as any);
    } catch (err: any) {
      finish({ ok: false, error: err?.message ?? String(err) });
    }
  });
}

// ── 执行命令 ──────────────────────────────────────

/**
 * 执行远程命令。
 *
 * 所有退出路径（成功、exec 失败、连接错误、超时）都会关闭连接并销毁流，
 * 避免旧实现中超时后连接与 stream 双双泄漏。
 */
export function executeCommand(
  config: SshConfig,
  command: string,
  timeoutSec: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
    const built = connectOptions(config, timeoutMs);
    if ("error" in built && typeof built.error === "string") {
      reject(new Error(built.error));
      return;
    }

    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stream: any;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // 先销毁流再关连接，防止 stream 的后续事件再次触发回调
      if (stream) {
        try {
          stream.destroy?.();
        } catch {
          // 已销毁时忽略
        }
        stream = undefined;
      }
      try {
        conn.end();
      } catch {
        // 已关闭时忽略
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const out = capOutput(stdout);
      const err = capOutput(stderr);
      resolve({
        stdout: out.truncated ? `${out.text}\n[输出已截断]` : out.text,
        stderr: err.truncated ? `${err.text}\n[输出已截断]` : err.text,
        code,
      });
    };

    conn.once("ready", () => {
      conn.exec(command, (err, s) => {
        if (err) {
          fail(err);
          return;
        }
        if (settled) {
          // 超时已先触发，此时流已无用，直接销毁
          try {
            (s as any).destroy?.();
          } catch {
            // 忽略
          }
          return;
        }
        stream = s;
        s.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        s.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        s.once("close", (code: number | null) => succeed(code));
        s.once("error", (streamErr: Error) => fail(streamErr));
      });
    });

    conn.once("error", (err: Error) => fail(err));
    conn.once("close", () => {
      if (!settled) fail(new Error("连接在命令执行完成前关闭"));
    });

    timer = setTimeout(() => {
      fail(new Error(`命令执行超时 (${timeoutSec}s)`));
    }, timeoutMs);

    try {
      conn.connect(built as any);
    } catch (err: any) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
