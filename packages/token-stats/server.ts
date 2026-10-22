/**
 * 本地统计服务：给 file:// 打开的报表页面提供状态查询与控制入口。
 *
 * 为什么需要它：报表是静态 HTML，用 file:// 打开时无法创建进程、也无法
 * 感知后台任务是否在跑。启停统计这类动作必须有个活着的进程接住，
 * 所以这里在 pi 进程内起一个只监听回环地址的 HTTP 服务。
 *
 * 「自动统计」的总开关由 autoEnabled 表示，语义覆盖全部自动写入路径：
 * 定时器，以及宿主进程里挂的每轮对话后重建（通过 onAutoToggle 通知）。
 * 停止时两者一起停，否则会出现「已停止却还在出数据」的矛盾状态。
 *
 * 只监听 127.0.0.1，不对外暴露；带 Origin 白名单，避免任意网页跨站调它。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ServerState {
  /** 自动统计是否开启（定时器 + 宿主每轮重建，两者一起开关） */
  autoEnabled: boolean;
  /** 定时间隔（毫秒） */
  intervalMs: number;
  /** 上次统计完成时间（毫秒时间戳，0 表示还没跑过） */
  lastRunAt: number;
  /** 上次统计耗时（毫秒） */
  lastCostMs: number;
  /** 上次统计写入的轮数 */
  lastTurns: number;
  /** 上次统计的错误信息 */
  lastError: string | null;
  /** 下次预计执行时间（毫秒时间戳，0 表示未排期） */
  nextRunAt: number;
  /** 服务启动时间 */
  startedAt: number;
  /** 累计执行次数 */
  runCount: number;
}

export interface ServerOptions {
  port?: number;
  /** 实际执行一次统计，返回本轮写入的轮数 */
  runOnce: () => Promise<number>;
  /** 默认间隔 */
  intervalMs?: number;
  /** 状态变化回调（用于同步到终端） */
  onStateChange?: (state: ServerState) => void;
  /**
   * 自动统计总开关变化时通知宿主。
   * 宿主用它同步「每轮对话后自动重建分片」那条路径——
   * 只停定时器不够，那条路径也会写数据，用户会看到「停了还在统计」。
   */
  onAutoToggle?: (enabled: boolean) => void;
}

export const DEFAULT_PORT = 7788;
export const MIN_INTERVAL_MS = 10_000;
export const MAX_INTERVAL_MS = 60 * 60 * 1000;

/** 允许访问的来源：file:// 页面的 Origin 是 "null"，外加本机调试地址 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;               // 同源 / 非浏览器请求
  if (origin === "null") return true;     // file:// 打开时浏览器发送的 Origin
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      data += chunk.toString("utf-8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export class StatsServer {
  private server: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: ServerState;
  private busy = false;
  private readonly opts: Required<Omit<ServerOptions, "onStateChange" | "onAutoToggle">> &
    Pick<ServerOptions, "onStateChange" | "onAutoToggle">;

  constructor(opts: ServerOptions) {
    this.opts = {
      port: opts.port ?? DEFAULT_PORT,
      runOnce: opts.runOnce,
      intervalMs: clampInterval(opts.intervalMs ?? 60_000),
      onStateChange: opts.onStateChange,
      onAutoToggle: opts.onAutoToggle,
    };
    this.state = {
      autoEnabled: false,
      intervalMs: this.opts.intervalMs,
      lastRunAt: 0,
      lastCostMs: 0,
      lastTurns: 0,
      lastError: null,
      nextRunAt: 0,
      startedAt: Date.now(),
      runCount: 0,
    };
  }

  get port(): number {
    return this.opts.port;
  }

  getState(): ServerState {
    return { ...this.state };
  }

  /** 启动 HTTP 监听。端口被占用时抛错，由调用方决定提示方式。 */
  async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      // 只监听回环，不暴露到局域网
      server.listen(this.opts.port, "127.0.0.1");
    });
    this.server = server;
    (server as { unref?: () => void }).unref?.();
  }

  /**
   * 开启自动统计。
   * 同时打开定时器和宿主的每轮重建，二者必须一致，
   * 否则用户会看到「已停止却还在出数据」。
   */
  start(intervalMs?: number): void {
    if (intervalMs !== undefined) {
      this.state.intervalMs = clampInterval(intervalMs);
    }
    this.state.autoEnabled = true;
    this.state.lastError = null;
    this.opts.onAutoToggle?.(true);
    this.arm();
    this.emit();
  }

  /** 关闭自动统计：定时器与宿主每轮重建一起停。正在跑的那一轮会自然结束。 */
  stop(): void {
    this.state.autoEnabled = false;
    this.state.nextRunAt = 0;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.opts.onAutoToggle?.(false);
    this.emit();
  }

  /**
   * 手动统计一次。与自动开关无关——即使自动统计已停，
   * 用户主动点「立刻统计」仍然应该生效。
   */
  async runNow(): Promise<ServerState> {
    await this.execute();
    if (this.state.autoEnabled) this.arm();  // 手动跑完重置计时起点
    return this.getState();
  }

  setInterval(ms: number): void {
    this.state.intervalMs = clampInterval(ms);
    if (this.state.autoEnabled) this.arm();
    this.emit();
  }

  /** 彻底关闭 HTTP 监听：释放端口，页面此后连不上 */
  async close(): Promise<void> {
    this.stop();
    const server = this.server;
    this.server = null;
    if (server) {
      // 浏览器会复用 keep-alive 连接，只调 close() 时旧连接仍能响应一阵，
      // 表现为「服务已停但页面还能连上」。先断开全部连接再关闭。
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private arm(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.state.autoEnabled) {
      this.state.nextRunAt = 0;
      return;
    }
    const interval = this.state.intervalMs;
    this.state.nextRunAt = Date.now() + interval;
    this.timer = setInterval(() => {
      void this.execute().then(() => {
        if (this.state.autoEnabled) this.state.nextRunAt = Date.now() + this.state.intervalMs;
        this.emit();
      });
    }, interval);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** 执行一次统计。重叠调用直接忽略，避免上一个还没写完又开一个。 */
  private async execute(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const began = Date.now();
    try {
      const turns = await this.opts.runOnce();
      this.state.lastRunAt = Date.now();
      this.state.lastCostMs = this.state.lastRunAt - began;
      this.state.lastTurns = turns;
      this.state.lastError = null;
      this.state.runCount += 1;
    } catch (error) {
      this.state.lastRunAt = Date.now();
      this.state.lastCostMs = this.state.lastRunAt - began;
      this.state.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  private emit(): void {
    this.opts.onStateChange?.(this.getState());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      json(res, 403, { ok: false, error: "来源不被允许" });
      return;
    }
    if (origin) {
      // file:// 页面的 Origin 字面量就是 "null"，必须原样回写这个字符串，
      // 用通配符 * 在某些浏览器下会与凭证/自定义头冲突
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.opts.port}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /api/status") {
        json(res, 200, { ok: true, state: this.getState(), port: this.opts.port });
        return;
      }
      if (route === "POST /api/start") {
        const body = await readBody(req);
        const ms = body ? (JSON.parse(body) as { intervalMs?: number }).intervalMs : undefined;
        this.start(typeof ms === "number" ? ms : undefined);
        json(res, 200, { ok: true, state: this.getState() });
        return;
      }
      if (route === "POST /api/stop") {
        this.stop();
        json(res, 200, { ok: true, state: this.getState() });
        return;
      }
      if (route === "POST /api/interval") {
        const body = await readBody(req);
        const ms = (JSON.parse(body) as { intervalMs?: number }).intervalMs;
        if (typeof ms !== "number" || !isFinite(ms)) {
          json(res, 400, { ok: false, error: "intervalMs 必须是数字" });
          return;
        }
        this.setInterval(ms);
        json(res, 200, { ok: true, state: this.getState() });
        return;
      }
      if (route === "POST /api/shutdown") {
        // 真正停止服务：关掉自动统计并释放端口。
        // 必须先回包再关闭，否则页面拿不到确认、只看到连接中断。
        const finalState = this.getState();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, state: finalState, stopped: true }));
        setTimeout(() => { void this.close().catch(() => {}); }, 60);
        return;
      }
      if (route === "POST /api/run-now") {
        const state = await this.runNow();
        json(res, 200, { ok: true, state });
        return;
      }
      json(res, 404, { ok: false, error: "未知接口" });
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        state: this.getState(),
      });
    }
  }
}

export function clampInterval(ms: number): number {
  if (!isFinite(ms)) return 60_000;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}
