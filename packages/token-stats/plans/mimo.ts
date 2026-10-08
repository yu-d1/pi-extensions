/**
 * 套餐配额查询 —— mimo（小米）
 * =============================================================================
 * 控制台账户余额：/api/v1/balance，凭据是网页登录 Cookie（不是推理用的 api key）。
 * Cookie 通过 Chrome + CDP 续期：弹出有头 Chrome 打开控制台，CDP 轮询到
 * serviceToken 就落盘并自动关窗；中途出错**不杀窗口**，让用户能从容登录，
 * 下次刷新走 reuse-running-instance 复用同一个实例再回收。
 * 零 npm 依赖：WebSocket 用 Node 内置，CDP 协议手写。
 *
 * 两个曾把窗口秒退的坑，已在此规避：
 *   1. DevToolsActivePort 是残留文件 —— 复用同一 profile 启新 Chrome 时，
 *      会读到上一轮的陈旧端口（实测 spawn 后 1ms 就读到与 7 秒前被 kill 的
 *      实例相同的端口号），拿死端口 fetch /json/version 直接 ECONNREFUSED，
 *      异常一路冒泡到 finally，把刚弹出的窗口 kill 掉。
 *      现在：spawn 前清陈旧端口，且读到后必须探活才算数。
 *   2. 无头实例与有头实例共用一个 --user-data-dir，被 kill 的无头 Chrome 会留下
 *      仍持有 profile 句柄的子进程，把紧接着启的有头窗口挤掉。
 *      现在：只保留有头阶段，不再有无头/有头争抢同一 profile。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { TokenPlan } from "./shared";
import { silentError } from "./shared";
import { formatAmount } from "../format";

// ── 常量 ────────────────────────────────────────────────────────────────

const MIMO_BASE = "https://platform.xiaomimimo.com";
const TOKEN_CONFIG_DIR = join(homedir(), ".pi/agent/extensions/token-stats");
const LOGS_DIR = join(homedir(), ".pi/agent/extensions/token-stats-logs");
const MIMO_COOKIE_FILE = join(TOKEN_CONFIG_DIR, "mimo-cookie.txt");
/** 上次成功使用的浏览器（检测结果记忆，避免每次刷新都遍历文件系统） */
const MIMO_BROWSER_FILE = join(TOKEN_CONFIG_DIR, "mimo-browser.json");
const MIMO_PROFILE_DIR = join(TOKEN_CONFIG_DIR, "mimo-browser-data");
const MIMO_COOKIE_NAMES = [
  "serviceToken",
  "xiaomichatbot_ph",
  "api-platform_serviceToken",
  "userId",
  "api-platform_slh",
  "api-platform_ph",
];
/** 登录失败后的退避时长，避免定时刷新反复拉起浏览器 */
const MIMO_LOGIN_RETRY_MS = 10 * 60_000;
/** 人工登录等待上限：走完才关窗并提示，中途出错一律保留窗口 */
const MIMO_LOGIN_TIMEOUT_MS = 300_000;
/** 关窗后等 Chrome 真正退出的上限（profile 句柄释放有延迟，立刻启下一个会被挤掉） */
const MIMO_KILL_GRACE_MS = 3_000;
/** cookie 有效期约 24h，提前 4h 主动续期（避免每天首个请求浪费一次 401） */
const MIMO_COOKIE_TTL = 20 * 3600_000;
/** 排查日志上限，超过即清空重建 */
const MIMO_LOG_MAX_BYTES = 1_000_000;

let mimoLoginBlockedUntil = 0;
/** 登录流程单飞：并发刷新共用同一个窗口，避免多个 Chrome 抢同一 profile */
let mimoLoginInFlight: Promise<boolean> | null = null;
/** 登录进行中的轻量状态（工作指示器行，完成即消失）；不可用时为 null */
let setQuotaStatus: ((message: string) => void) | null = null;
/** 仅失败时弹通知（登录成功/查询正常一律不打扰） */
let notifyQuota: ((message: string) => void) | null = null;

/** 绑定当前会话的 UI 反馈通道；传 null 解绑（session_end） */
export function bindMimoFeedback(
  setStatus: ((message: string) => void) | null,
  notify: ((message: string) => void) | null,
): void {
  setQuotaStatus = setStatus;
  notifyQuota = notify;
}

/** 主动刷新时清掉登录退避（用户刚操作完，不该被上一次失败的 10 分钟卡住） */
export function resetMimoLoginBackoff(): void {
  mimoLoginBlockedUntil = 0;
}

// ── 日志 / cookie ───────────────────────────────────────────────────────

/** mimo 排查日志：失败全程静默，不落盘就无法定位卡在哪一步 */
export function mimoLog(step: string, detail = ""): void {
  try {
    const file = join(LOGS_DIR, "mimo-quota.log");
    try { if (statSync(file).size > MIMO_LOG_MAX_BYTES) writeFileSync(file, ""); } catch {}
    appendFileSync(file, `${new Date().toISOString()} [${step}]${detail ? " " + detail : ""}\n`);
  } catch {}
}

/** 读 cookie 文件（含捕获时间）；兼容早期纯文本格式（capturedAt=0 视为需续期）。 */
function readMimoCookieFile(): { cookie: string; capturedAt: number } | null {
  try {
    if (!existsSync(MIMO_COOKIE_FILE)) return null;
    const raw = readFileSync(MIMO_COOKIE_FILE, "utf-8").trim();
    if (!raw) return null;
    if (raw.startsWith("{")) {
      try {
        const j = JSON.parse(raw);
        if (typeof j?.cookie === "string" && j.cookie) {
          return { cookie: j.cookie, capturedAt: typeof j.capturedAt === "number" ? j.capturedAt : 0 };
        }
      } catch {}
    }
    return { cookie: raw, capturedAt: 0 };
  } catch {}
  return null;
}

function readMimoCookie(): string {
  return readMimoCookieFile()?.cookie ?? "";
}

function writeMimoCookie(cookie: string): void {
  try {
    mkdirSync(TOKEN_CONFIG_DIR, { recursive: true });
    writeFileSync(MIMO_COOKIE_FILE, JSON.stringify({ cookie, capturedAt: Date.now() }), "utf-8");
  } catch {}
}

// ── Chrome / CDP ────────────────────────────────────────────────────────

/**
 * 找可用的 Chromium 内核浏览器（Chrome / Edge / Chromium，避免额外下载浏览器）。
 * 优先级：手动指定（MIMO_CHROME） > 上次成功用的（缓存） > 按平台依次探测。
 * Chromium 系命令行参数（--remote-debugging-port / DevToolsActivePort）三者完全一致。
 */
function findChrome(): string | null {
  // 1. 手动指定：环境变量优先，适合 Chromium 装在非标准路径
  const manual = process.env.MIMO_CHROME?.trim();
  if (manual && existsSync(manual)) return manual;

  // 2. 记忆上次成功的选择（缓存失效即回落探测）
  try {
    if (existsSync(MIMO_BROWSER_FILE)) {
      const cached = JSON.parse(readFileSync(MIMO_BROWSER_FILE, "utf-8"))?.path;
      if (typeof cached === "string" && cached && existsSync(cached)) return cached;
    }
  } catch {}

  // 3. 按平台探测：Chrome → Edge → Chromium（Edge 在 Windows 上是预装的）
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          `${process.env.LOCALAPPDATA ?? ""}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/microsoft-edge",
          "/usr/bin/microsoft-edge-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  const found = candidates.find((p) => p && existsSync(p)) ?? null;
  if (found) {
    try {
      writeFileSync(MIMO_BROWSER_FILE, JSON.stringify({ path: found, detectedAt: Date.now() }), "utf-8");
    } catch {}
  }
  return found;
}

/** CDP:Storage.getCookies —— 纯 Node WebSocket，零依赖 */
function cdpGetCookies(wsUrl: string, timeoutMs: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("CDP 超时"));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
    ws.onmessage = (ev: any) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) reject(new Error(msg.error.message ?? "CDP 失败"));
      else resolve(msg.result?.cookies ?? []);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP 连接失败"));
    };
  });
}

/**
 * 弹有头 Chrome 窗口让用户登录控制台，CDP 轮询到 serviceToken 就落盘并自动关窗。
 *
 * 单飞：定时刷新 / provider 变化 / 手动刷新可能同时打进来，重复启 Chrome 会互相
 * 抢 profile，表现为窗口刚弹出就被另一个实例挤掉。这里共用同一个 in-flight Promise。
 */
async function silentMimoLogin(): Promise<boolean> {
  if (mimoLoginInFlight) {
    mimoLog("login-inflight-reuse", "登录流程进行中，复用同一个窗口");
    return mimoLoginInFlight;
  }
  const p = runMimoLogin().finally(() => {
    mimoLoginInFlight = null;
  });
  mimoLoginInFlight = p;
  return p;
}

async function runMimoLogin(): Promise<boolean> {
  const chrome = findChrome();
  mimoLog("login-begin", `chrome=${chrome ?? "未找到"}`);
  if (!chrome) return false;
  mkdirSync(MIMO_PROFILE_DIR, { recursive: true });

  // 进行中只显示轻量状态行（完成即消失），失败才通知
  try {
    setQuotaStatus?.("mimo 登录中：在 Chrome 窗口完成登录，完成后自动关闭");
  } catch {}
  mimoLog("login-headed-begin");
  try {
    const ok = await cdpCollectCookies(chrome, MIMO_LOGIN_TIMEOUT_MS);
    try { setQuotaStatus?.(""); } catch {}
    mimoLog(ok ? "login-headed-ok" : "login-headed-unfinished");
    if (!ok) {
      try {
        notifyQuota?.(
          "mimo 登录未完成。\n"
          + "下次刷新会自动复用还开着的那个 Chrome 窗口——在窗口里登录完成后\n"
          + "无需关窗，稍等片刻即可；若窗口已消失，可先关闭占用\n"
          + MIMO_PROFILE_DIR + " 的浏览器再重试。",
        );
      } catch {}
    }
    return ok;
  } catch (e: any) {
    try { setQuotaStatus?.(""); } catch {}
    mimoLog("login-headed-error", String(e?.message ?? e));
    // 异常不等于用户没登录：窗口多半还开着，保留它让用户继续登录
    try {
      notifyQuota?.(
        "mimo 自动登录出错，但 Chrome 窗口已保留。\n"
        + "请在窗口里完成登录并保持窗口不关闭，下次刷新会自动复用它。\n"
        + "详细原因见 " + LOGS_DIR + "/mimo-quota.log",
      );
    } catch {}
    return false;
  }
}

/**
 * profile 是否被一个「存活」的 Chrome 占用。
 * 存在两种情况：上一次没关干净（可复用它的调试端口）或用户正在里面登录。
 */
function profileLockedByLiveProcess(): boolean {
  try {
    if (!existsSync(join(MIMO_PROFILE_DIR, "SingletonLock"))) return false;
    const pid = Number(readlinkSync(join(MIMO_PROFILE_DIR, "SingletonLock")).replace(/^.*-/, ""));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === "EPERM"; // 进程存在但无权限发信号
    }
  } catch {
    return false;
  }
}

/** 读 Chrome 写入的调试端口（无则空串） */
function readDevToolsPort(): string {
  try {
    const first = readFileSync(join(MIMO_PROFILE_DIR, "DevToolsActivePort"), "utf-8").split("\n")[0]?.trim();
    return first && /^\d+$/.test(first) ? first : "";
  } catch {
    return "";
  }
}

/**
 * 取「确实还活着」的 Chrome 实例的调试端口，无则返回空串。
 *
 * 不能只看 SingletonLock：该文件在 Windows 上可能不创建、或退化成普通文件，
 * 此时 readlinkSync 抛错 → 判定为无实例，实际上用户那个窗口还开着。
 * 结果是又去启一个 Chrome 抢同一 profile（转发后秒退），而且我们主动保留的
 * 窗口再也接不回来。因此用「端口能不能探活」做兜底判据 —— 能连上 /json/version
 * 就说明确实有个 Chrome 活着，与锁文件无关。
 */
async function liveDevToolsPort(): Promise<string> {
  const port = readDevToolsPort();
  if (!port) return "";
  if (profileLockedByLiveProcess()) return port;
  return (await probeCdp(port, 1_500)) ? port : "";
}

/**
 * 清理孤儿 profile 残留物。Chrome 被强杀/进程崩溃后会留下两类垃圾：
 *   - SingletonLock 等锁文件：Chrome 认为「已有实例占用该 profile」，
 *     把请求转发给那个不存在的实例后自己退出，结果既没窗口也读不到调试端口；
 *   - DevToolsActivePort：端口文件同样残留，且危害更大 —— 复用同一 profile 启新
 *     Chrome 时会在 spawn 后 1ms 内读到它，拿死端口 fetch 直接 ECONNREFUSED，
 *     异常冒泡到 finally 把刚弹出的窗口 kill 掉。
 * 仅在确认没有活实例时清理；有活实例一律走 reuse 分支。
 */
function cleanStaleProfileArtifacts(): void {
  if (profileLockedByLiveProcess()) return;
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) {
    try { unlinkSync(join(MIMO_PROFILE_DIR, name)); } catch {}
  }
}

/** CDP 探活：端口文件存在 ≠ 端口可用，必须真能连上 /json/version */
async function probeCdp(port: string, timeoutMs = 3_000): Promise<string | null> {
  try {
    const v = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    }).then((r) => r.json());
    return typeof v?.webSocketDebuggerUrl === "string" ? v.webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
}

/**
 * 杀 Chrome 并等它真正退出。
 * Windows 上 proc.kill() 只是 TerminateProcess 主进程，zygote / network service 等
 * 子进程会变孤儿并继续持有 profile 句柄，导致紧接着启的窗口秒退；因此走
 * taskkill /T 杀整棵进程树，并等 exit 事件（上限 MIMO_KILL_GRACE_MS）。
 */
async function killChromeTree(proc: any): Promise<void> {
  if (!proc?.pid) return;
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) return resolve();
    proc.once("exit", () => resolve());
  });
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 });
    } catch {}
  } else {
    try { proc.kill(); } catch {}
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, MIMO_KILL_GRACE_MS))]);
}

/**
 * 启一个有头 Chrome 打开控制台页面，轮询等登录 cookie 出现。
 *
 * 取端口必须探活：DevToolsActivePort 是残留文件，读到即用会拿到上一轮的死端口，
 * fetch 失败后 finally 会把刚开的窗口 kill 掉 —— 这正是用户看到的「没登录就自动关闭」。
 *
 * 收尾分三种：
 *   - 拿到 cookie  → 关窗（正常路径）；
 *   - 等满 MIMO_LOGIN_TIMEOUT_MS → 关窗并提示；
 *   - 中途异常      → **保留窗口**，让用户继续登录，下次刷新走 reuse 分支回收。
 */
async function cdpCollectCookies(chrome: string, waitMs: number): Promise<boolean> {
  let proc: any;
  let ws: any;
  let reused = false;
  /** 已明确收尾（拿到 cookie / 等满超时 / 启动阶段失败）才关窗；异常中断一律保留 */
  let settled = false;
  try {
    let port = "";
    let wsUrl = "";
    // ① 已有 Chrome 正占用该 profile：直接复用它的调试端口，
    //    不要再启一个（会被转发后秒退，还把 DevToolsActivePort 读成陈旧的）
    const livePort = await liveDevToolsPort();
    if (livePort) {
      port = livePort;
      reused = true;
      mimoLog("reuse-running-instance", `port=${port}`);
    }
    // ② 没有活实例 → 清残留后启一个
    if (!port) {
      const args = [
        "--remote-debugging-port=0",
        `--user-data-dir=${MIMO_PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        // 上一次是被 kill 强杀的，别弹「上次未正确关闭」的恢复气泡挡住页面
        "--disable-session-crashed-bubble",
        "--new-window",
        `${MIMO_BASE}/console/plan-manage`,
      ];
      // 关键：必须先清掉上一轮残留的端口文件，否则下面的等待循环会 1ms 内读到它就 break
      cleanStaleProfileArtifacts();
      proc = spawn(chrome, args, { stdio: "ignore" });
      mimoLog("chrome-spawned", `pid=${proc.pid}`);
      const startDeadline = Date.now() + 15_000;
      let probeFailStreak = 0;
      while (Date.now() < startDeadline) {
        // 进程已退（例如 profile 被占导致转发后退出）：立即放弃，不空等
        if (proc.exitCode !== null || proc.signalCode) {
          mimoLog("chrome-exited-early", `code=${proc.exitCode} signal=${proc.signalCode}`);
          settled = true;
          return false;
        }
        const p = readDevToolsPort();
        if (p) {
          const url = await probeCdp(p);
          if (url) {
            port = p;
            wsUrl = url;
            break;
          }
          // Chrome 刚写端口时 HTTP server 可能还没监听，所以连续探不通若干次
          // 才判定是上一轮的陈旧端口，届时清掉文件继续等新实例写。
          probeFailStreak++;
          if (probeFailStreak >= 3) {
            mimoLog("port-verify-fail", `port=${p} 连续探不通，判定为陈旧残留并清理`);
            try { unlinkSync(join(MIMO_PROFILE_DIR, "DevToolsActivePort")); } catch {}
            probeFailStreak = 0;
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!wsUrl) {
        mimoLog("chrome-port-timeout", "等 15000ms 未拿到可用调试端口");
        settled = true;
        return false;
      }
    } else {
      // 复用的实例同样要探活：它可能正好在这几秒内被用户关掉了
      const url = await probeCdp(port);
      if (!url) {
        mimoLog("port-verify-fail", `复用的实例 port=${port} 探不通`);
        settled = true;
        return false;
      }
      wsUrl = url;
    }
    mimoLog("cdp-port-ok", `port=${port} reused=${reused} 探活通过`);

    ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP 连接超时")), 5000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("CDP 连接失败")); };
    });

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      let cookies: any[] = [];
      try {
        cookies = await cdpGetCookies(ws.url, 5000);
      } catch (e: any) {
        // CDP 链路断了不代表窗口没了：保留窗口，让用户继续登录，下次刷新再复用
        mimoLog("cdp-getcookies-error", String(e?.message ?? e));
        return false;
      }
      const keep = cookies.filter((c: any) => MIMO_COOKIE_NAMES.includes(c?.name));
      if (keep.some((c: any) => c.name === "api-platform_serviceToken")) {
        writeMimoCookie(keep.map((c: any) => `${c.name}="${String(c.value).replace(/"/g, "")}"`).join("; "));
        mimoLog("cookie-captured", `${keep.length} 个`);
        settled = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // 等满仍没抓到：属于「用户一直没登录」，关窗并提示（下次会重新弹）
    settled = true;
    return false;
  } finally {
    try { ws?.close(); } catch {}
    if (reused) {
      // 复用的实例是用户/上次的进程，绝不能杀
    } else if (settled) {
      await killChromeTree(proc);
    } else {
      mimoLog("window-kept", "中途异常，保留 Chrome 窗口供用户继续登录（下次刷新复用）");
    }
  }
}

// ── 余额查询 ────────────────────────────────────────────────────────────

async function mimoApi(path: string, cookie: string): Promise<any> {
  const r = await fetch(MIMO_BASE + path, {
    headers: {
      Cookie: cookie,
      Accept: "application/json, text/plain, */*",
      Referer: MIMO_BASE + "/",
      Origin: MIMO_BASE,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 401) throw new Error("__mimo_unauthorized__");
  if (!r.ok) throw new Error("mimo HTTP " + r.status);
  const body = await r.json();
  if (body?.code === 401) throw new Error("__mimo_unauthorized__");
  return body;
}

/**
 * 查询账户余额（与 DeepSeek 套餐同款：只显金额）。
 * cookie 缺失 / 临近过期 / 401 时拉起 Chrome 续期一次后重试。
 */
async function fetchMimoQuota(): Promise<{ amount: number }> {
  const run = async (cookie: string) => {
    const bal = (await mimoApi("/api/v1/balance", cookie))?.data ?? {};
    // 字段名以实测响应为准，兼容多种形态
    const amount = Number(bal.balance ?? bal.amount ?? bal.totalBalance ?? bal.total ?? 0);
    return { amount: isFinite(amount) ? amount : 0 };
  };

  const cred = readMimoCookieFile();
  const fresh = !!cred && Date.now() - cred.capturedAt < MIMO_COOKIE_TTL;
  if (cred && fresh) {
    try {
      return await run(cred.cookie);
    } catch (e: any) {
      // 只在登录过期时续期；网络 / 服务端错误不该拉起浏览器
      if (e?.message !== "__mimo_unauthorized__") throw e;
    }
  }
  // 退避期内：若用户之前那个 Chrome 窗口还开着（可能正在登录），仍允许复用它，
  // 否则用户明明已经在登录，却要干等 10 分钟才有机会被采集一次。
  if (Date.now() < mimoLoginBlockedUntil) {
    const livePort = await liveDevToolsPort();
    if (!livePort) {
      mimoLog("backoff-skip", `还需等 ${Math.ceil((mimoLoginBlockedUntil - Date.now()) / 1000)}s`);
      throw silentError("mimo 登录态不可用");
    }
    mimoLog("backoff-bypass-live", `退避期内检测到活实例 port=${livePort}，直接复用`);
  }
  mimoLog("login-required", cred ? (fresh ? "cookie 已失效" : "cookie 临近过期，主动续期") : "无 cookie");
  const ok = await silentMimoLogin();
  mimoLoginBlockedUntil = ok ? 0 : Date.now() + MIMO_LOGIN_RETRY_MS;
  if (ok) return run(readMimoCookie());
  // 保守 TTL 提前续期失败时，旧 cookie 可能仍在有效期内，最后兜底试一次
  if (cred) {
    try { return await run(cred.cookie); } catch {}
  }
  throw silentError("mimo 登录态不可用");
}

// ── 前置检查 ────────────────────────────────────────────────────────────

/**
 * 启用登录态套餐前的前置检查：没有现成 cookie 时必须有 Chrome，
 * 否则永远拿不到凭据（而 mimo 失败是静默的，启用后只会看到空白）。
 * 返回 null = 可启用，否则返回要提示用户的原因。
 */
export async function checkLoginPlanPrereq(plan: TokenPlan): Promise<string | null> {
  if (!plan.needsLogin) return null;
  if (plan.readCredential?.()) return null;
  if (findChrome()) return null;
  return "未检测到 Chrome / Chromium / Edge，无法自动登录取额度。\n"
    + "装一个 Chrome 即可（无需任何 npm 包）；\n"
    + `也可手动把浏览器 Cookie 写入 ${MIMO_COOKIE_FILE}`;
}

// ── 套餐定义 ────────────────────────────────────────────────────────────

export const mimoPlan: TokenPlan = {
  id: "mimo",
  name: "mimo (小米·账户余额)",
  matchProviders: ["mimo"],
  apiKeyEnv: "",
  /** 凭据是控制台网页登录 Cookie（存 mimo-cookie.txt），不是 auth.json 的推理 api key */
  readCredential: () => readMimoCookie(),
  needsLogin: true,
  baseUrl: "https://platform.xiaomimimo.com",
  quotaPath: "/api/v1/balance",
  authHeader: (key) => ({ Cookie: key, Accept: "application/json" }),
  /** fetchQuota 的 key 由 resolveApiKey 提供（此处为 cookie 串），但取数自带重登逻辑，故忽略 */
  fetchQuota: async () => fetchMimoQuota(),
  format: (data, ctx) => {
    const amount = Number(data?.amount ?? 0);
    return {
      modelPrefix: "",
      display: formatAmount(amount, ctx.amountDigits, "¥"),
      color: amount < 1 ? "warn" : "ok",
    };
  },
};
