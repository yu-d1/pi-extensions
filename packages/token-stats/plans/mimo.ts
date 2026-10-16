/**
 * 套餐配额查询 —— mimo（小米）
 * =============================================================================
 * 控制台账户余额：/api/v1/balance，凭据是网页登录 Cookie（不是推理用的 api key）。
 * Cookie 通过 Chrome + CDP 续期，分两级：
 *   ① headless 静默续期：profile 里有小米 SSO 长期凭据 passToken 时，无头实例打开
 *      控制台即可自动换到 api-platform_serviceToken（实测 0.3s），全程无窗口、无交互；
 *   ② 有头登录：headless 拿不到（首次使用 / passToken 过期）才弹窗，CDP 轮询到
 *      serviceToken 就落盘；中途出错**不杀窗口**，让用户能从容登录。
 * 关键：收尾一律走 CDP Browser.close **优雅退出**，而不是 taskkill 强杀 —— passToken
 * 是「随进程消亡」的会话凭据，只有 Chrome 正常退出才会落盘（有效期约 30 天）。强杀会让
 * 它永远存不下来，表现为每次刷新都要重新登录。限时未退出才降级强杀。
 * 零 npm 依赖：WebSocket 用 Node 内置，CDP 协议手写。
 *
 * 两个曾把窗口秒退的坑，已在此规避：
 *   1. DevToolsActivePort 是残留文件 —— 复用同一 profile 启新 Chrome 时，
 *      会读到上一轮的陈旧端口（实测 spawn 后 1ms 就读到与 7 秒前被 kill 的
 *      实例相同的端口号），拿死端口 fetch /json/version 直接 ECONNREFUSED，
 *      异常一路冒泡到 finally，把刚弹出的窗口 kill 掉。
 *      现在：spawn 前清陈旧端口，且读到后必须探活才算数。
 *   2. 实例间争抢同一 --user-data-dir 会被转发后秒退。现在 headless 实例
 *      结束后（优雅退出、等 exit 事件）才启有头实例，绝不并发。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
/** headless 静默续期等待上限：passToken 有效时实测 0.3s 即命中，留足冷启动余量 */
const MIMO_HEADLESS_WAIT_MS = 15_000;
/** 优雅退出（CDP Browser.close）等待上限，超时才降级强杀 */
const MIMO_GRACEFUL_CLOSE_MS = 8_000;
/**
 * serviceToken 主动换票阈值。服务端寿命约 48h（实测 10-12 08:58 签发、
 * 10-14 09:23 首次 401），取一半做余量：到点就静默换一次票，用户不会撞上 401。
 * 换票失败不影响现状 —— 旧票可能仍被服务端认可。
 */
const MIMO_TOKEN_REFRESH_MS = 24 * 3600_000;
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

/** 读 cookie 文件（含捕获时间）；兼容早期纯文本格式（capturedAt=0 表示未知）。 */
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

/**
 * 取出当前 cookie 里的 api-platform_serviceToken 值，用于判断续期是否真换了新票。
 * 取值口径必须和 writeMimoCookie 一致（都去掉引号）：Chrome 会把服务端 Set-Cookie
 * 带的引号保留在 value 里，不归一化的话同一个 token 也会被判定成「换了新的」。
 */
function readMimoServiceToken(): string {
  const m = /(?:^|;\s*)api-platform_serviceToken="([^"]*)"/.exec(readMimoCookie());
  return m?.[1] ?? "";
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
 * 取 SSO 登录直链。平台自己不渲染登录表单，登录态由小米账号 SSO 发票：
 * /api/v1/genLoginUrl 会 302 到 account.xiaomi.com/pass/serviceLogin，并带上服务端
 * 签名好的 callback（指向 /sts?sign=…）。浏览器访问这个链接，passToken 有效时自动
 * 过检并换到新的 api-platform_serviceToken（实测约 0.8s）。
 */
async function genMimoLoginUrl(): Promise<string> {
  try {
    const r = await fetch(`${MIMO_BASE}/api/v1/genLoginUrl?currentPath=%2Fconsole%2Fplan-manage`, {
      redirect: "manual",
      headers: { Accept: "application/json, text/plain, */*", Referer: MIMO_BASE + "/", Origin: MIMO_BASE },
      signal: AbortSignal.timeout(8_000),
    });
    const loc = r.headers.get("location");
    return loc && loc.startsWith("http") ? loc : "";
  } catch {
    return "";
  }
}

/** 在浏览器里新开一个标签页访问指定 URL（浏览器级命令，无需 attach 到页面） */
function cdpCreateTarget(wsUrl: string, url: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url } }));
    ws.onmessage = (ev: any) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(!msg.error);
    };
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
  });
}

/**
 * 弹有头 Chrome 窗口让用户登录控制台，CDP 轮询到 serviceToken 就落盘并自动关窗。
 *
 * 单飞：定时刷新 / provider 变化 / 手动刷新可能同时打进来，重复启 Chrome 会互相
 * 抢 profile，表现为窗口刚弹出就被另一个实例挤掉。这里共用同一个 in-flight Promise。
 */
async function silentMimoLogin(prevToken = ""): Promise<boolean> {
  if (mimoLoginInFlight) {
    mimoLog("login-inflight-reuse", "登录流程进行中，复用同一个窗口");
    return mimoLoginInFlight;
  }
  const p = runMimoLogin(prevToken).finally(() => {
    mimoLoginInFlight = null;
  });
  mimoLoginInFlight = p;
  return p;
}

async function runMimoLogin(prevToken = ""): Promise<boolean> {
  const chrome = findChrome();
  mimoLog("login-begin", `chrome=${chrome ?? "未找到"}`);
  if (!chrome) return false;
  mkdirSync(MIMO_PROFILE_DIR, { recursive: true });

  // ① 先试 headless 静默续期：passToken 有效时无需任何交互（实测 0.3s 命中），用户无感。
  try {
    setQuotaStatus?.("mimo 续期检查中…");
  } catch {}
  mimoLog("login-headless-begin");
  try {
    if (await cdpCollectCookies(chrome, MIMO_HEADLESS_WAIT_MS, true, prevToken)) {
      try { setQuotaStatus?.(""); } catch {}
      mimoLog("login-headless-ok", "静默续期成功");
      return true;
    }
    mimoLog("login-headless-miss", "未拿到凭据，降级有头登录");
  } catch (e: any) {
    mimoLog("login-headless-error", String(e?.message ?? e));
  }

  // ② 降级有头：首次使用 / passToken 过期。进行中只显示轻量状态行，失败才通知
  try {
    setQuotaStatus?.("mimo 登录中：在 Chrome 窗口完成登录，完成后自动关闭");
  } catch {}
  mimoLog("login-headed-begin");
  try {
    const ok = await cdpCollectCookies(chrome, MIMO_LOGIN_TIMEOUT_MS, false, prevToken);
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
 * 以端口探活为唯一判据：SingletonLock 在 Windows 上可能不创建、或退化成普通文件，
 * readlinkSync 抛错只能说明「判不了」，不能据此断定没有活实例 —— 一旦误判，就会
 * 再启一个 Chrome 去抢同一 profile（转发后秒退），且用户那个窗口再也接不回来。
 * 能连上 /json/version 就说明确实有个 Chrome 活着，与锁文件无关。
 */
async function liveDevToolsPort(): Promise<string> {
  const port = readDevToolsPort();
  if (!port) return "";
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
  // 调用方已确认没有活实例（liveDevToolsPort 探活失败），此处一律清理残留。
  // 若还看 SingletonLock 决定清不清，锁文件判不了时会把残留留下，新实例会被转发后秒退。
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
 * 杀 Chrome 并等它真正退出（**仅作优雅退出的超时兜底**）。
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
 * 优雅关闭 Chrome：先发 CDP Browser.close 让 Chrome 走正常退出流程，
 * 小米的长期 SSO 凭据 passToken 才会落盘（有效期约 30 天）。
 *
 * 这是「登录一次、之后 headless 静默续期」的前提：taskkill 强杀会让 passToken
 * 随进程内存消亡、永远存不下来，表现为每次刷新都要重新登录。
 * 限时未退出（Chrome 卡住 / CDP 无响应）才降级 killChromeTree 强杀。
 * 必须用**尚未关闭**的 ws 发指令，所以调用方不能先 ws.close()。
 */
async function gracefulCloseChrome(ws: any, proc: any): Promise<void> {
  if (!proc?.pid) return;
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) return resolve();
    proc.once("exit", () => resolve());
  });
  if (ws) {
    try {
      ws.send(JSON.stringify({ id: 999_999, method: "Browser.close" }));
    } catch (e: any) {
      mimoLog("graceful-close-send-error", String(e?.message ?? e));
    }
  }
  const ok = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), MIMO_GRACEFUL_CLOSE_MS))]);
  if (ok) {
    mimoLog("graceful-close-ok", "Chrome 已优雅退出（passToken 有机会落盘）");
    // profile 句柄释放略有延迟，立刻启下一个会被挤掉
    await new Promise((r) => setTimeout(r, 300));
  } else {
    mimoLog("graceful-close-timeout", "未在限时内退出，降级强杀");
    await killChromeTree(proc);
  }
}

/**
 * 启 Chrome 打开控制台页面，轮询等登录 cookie 出现。
 * headless=true 时加 --headless=new：用于 passToken 有效时的静默续期（无窗口）。
 *
 * 取端口必须探活：DevToolsActivePort 是残留文件，读到即用会拿到上一轮的死端口，
 * fetch 失败后 finally 会把刚开的窗口 kill 掉 —— 这正是用户看到的「没登录就自动关闭」。
 *
 * 收尾分三种：
 *   - 拿到 cookie  → **优雅关窗**（正常路径，让 passToken 落盘）；
 *   - 等满 waitMs   → 优雅关窗（headless 失败降级有头 / 用户一直没登录）；
 *   - 中途异常      → **保留窗口**，让用户继续登录，下次刷新走 reuse 分支回收。
 */
async function cdpCollectCookies(chrome: string, waitMs: number, headless = false, prevToken = ""): Promise<boolean> {
  let proc: any;
  let ws: any;
  let reused = false;
  /** 已明确收尾（拿到 cookie / 等满超时 / 启动阶段失败）才关窗；异常中断一律保留 */
  let settled = false;
  try {
    // SSO 登录直链。必须主动访问它：只靠启动参数打开控制台首页是不够的 ——
    // 页面看到 profile 里还躺着那个已过期的 serviceToken，就认为已登录、不再跳
    // serviceLogin，实测等 20s token 也毫无变化，续期从未真正发生过。
    const loginUrl = await genMimoLoginUrl();
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
        ...(headless ? ["--headless=new"] : []),
        "--remote-debugging-port=0",
        `--user-data-dir=${MIMO_PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        // 上一次是被强杀的，别弹「上次未正确关闭」的恢复气泡挡住页面
        "--disable-session-crashed-bubble",
        // 有登录直链时不开默认页：下面用 Target.createTarget 精确控制访问哪个 URL
        ...(loginUrl ? [] : ["--new-window", `${MIMO_BASE}/console/plan-manage`]),
      ];
      // 关键：必须先清掉上一轮残留的端口文件，否则下面的等待循环会 1ms 内读到它就 break
      cleanStaleProfileArtifacts();
      proc = spawn(chrome, args, { stdio: "ignore" });
      mimoLog("chrome-spawned", `pid=${proc.pid} headless=${headless}`);
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

    // 关键一步：访问 SSO 登录直链，逼着重新走一次换票。passToken 有效时自动过检，
    // 无需任何交互；失效时落到小米登录页，由用户手动登录（有头模式）。
    if (loginUrl) {
      const ok = await cdpCreateTarget(wsUrl, loginUrl);
      mimoLog("sso-target", ok ? `已访问登录直链 ${loginUrl.slice(0, 48)}…` : "创建登录标签页失败，等待页面自行跳转");
    }

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
      const rawToken = keep.find((c: any) => c.name === "api-platform_serviceToken")?.value;
      // 与 writeMimoCookie 同样去掉引号再比：Chrome 会把服务端 Set-Cookie 带的引号
      // 保留在 value 里，不归一化时「同一个 token」也会被判定成换了新的。
      const token = rawToken ? String(rawToken).replace(/"/g, "") : "";
      // 成功条件不是「有 token」而是「token 换了新的」。它是 session cookie 却被 Chrome
      // 落盘，重启后原样读回旧值；只判存在时等待循环第一轮（约 60ms）就命中，而页面
      // 此时还没走完 SSO 换票 —— 结果每次都把同一个已过期的 token 又写回文件，表现为
      // 「静默续期成功，但两天后照样 401」，且退避永远不生效（一天空转 200+ 次）。
      // 判「换了新的」就会一直等到 SSO 真的换票完成（实测约 1.4s）。
      if (token && token !== prevToken) {
        writeMimoCookie(keep.map((c: any) => `${c.name}="${String(c.value).replace(/"/g, "")}"`).join("; "));
        mimoLog("cookie-captured", `${keep.length} 个（serviceToken ${prevToken ? "已换新" : "首次获取"}）`);
        settled = true;
        return true;
      }
      // headless 要尽快发现换票完成（实测约 1.4s），有头是等用户扫码，不必那么密
      await new Promise((r) => setTimeout(r, headless ? 300 : 1500));
    }
    // 等满仍没抓到：属于「用户一直没登录」，关窗并提示（下次会重新弹）
    settled = true;
    return false;
  } finally {
    if (reused) {
      // 复用的实例是用户/上次的进程，绝不能杀；关掉 ws 即可
      try { ws?.close(); } catch {}
    } else if (settled || headless) {
      // 有头异常时保留窗口供用户继续登录；headless 无窗口可留，一律优雅关闭，
      // 否则残留无头实例会占住 profile，让紧接着的有头登录起不来。
      // 优雅退出：发完 Browser.close 再关 ws，让 passToken 有机会落盘
      await gracefulCloseChrome(ws, proc);
      try { ws?.close(); } catch {}
    } else {
      try { ws?.close(); } catch {}
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
 * cookie 缺失 / 服务端返回 401 时拉起 Chrome 续期一次后重试。
 */
async function fetchMimoQuota(): Promise<{ amount: number }> {
  const run = async (cookie: string) => {
    const bal = (await mimoApi("/api/v1/balance", cookie))?.data ?? {};
    // 字段名以实测响应为准，兼容多种形态
    const amount = Number(bal.balance ?? bal.amount ?? bal.totalBalance ?? bal.total ?? 0);
    return { amount: isFinite(amount) ? amount : 0 };
  };

  let cred = readMimoCookieFile();

  // ① 凭据临近过期时先静默换票，用户就不会撞上 401。失败不破坏现状：旧票可能仍被
  //    服务端认可，照常往下走；退避也在这里置上，否则每隔一个刷新周期就白拉一次 Chrome。
  if (cred?.capturedAt && Date.now() - cred.capturedAt > MIMO_TOKEN_REFRESH_MS && Date.now() >= mimoLoginBlockedUntil) {
    const fresh = await refreshMimoToken();
    if (fresh) {
      // 后续分支一律改用新凭据：新票仍被拒时若拿旧票再试一遍，只是白费一次请求
      cred = fresh;
      try {
        return await run(fresh.cookie);
      } catch (e: any) {
        if (e?.message !== "__mimo_unauthorized__") throw e;
        mimoLog("refresh-still-401", "换到的新票仍被服务端拒绝，回退旧凭据");
        mimoLoginBlockedUntil = Date.now() + MIMO_LOGIN_RETRY_MS;
      }
    }
  }

  // ② 有凭据就直接用：只有服务端真的返回 401（凭据失效）才拉起浏览器重新登录。
  // 不再按本地 capturedAt 提前续期 —— 凭据是内存态 session cookie，本地无从得知
  // 真实有效期，提前续期只会平白多弹一次窗口（实测本地 20h 到期时 cookie 仍有效）。
  if (cred) {
    try {
      return await run(cred.cookie);
    } catch (e: any) {
      // 只在登录过期时续期；网络 / 服务端错误不该拉起浏览器
      if (e?.message !== "__mimo_unauthorized__") throw e;
      mimoLog("cookie-expired", "服务端返回 401，凭据已失效，需重新登录");
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
  mimoLog("login-required", cred ? "cookie 已失效（服务端 401）" : "无 cookie");
  // prevToken 传当前值：只有真换到新票才算续期成功。不传就会把磁盘上的死 token
  // 又读一遍当成成功，陷入「401 → 拉 Chrome → 还是 401」的死循环。
  const ok = await silentMimoLogin(readMimoServiceToken());
  mimoLoginBlockedUntil = ok ? 0 : Date.now() + MIMO_LOGIN_RETRY_MS;
  if (ok) {
    try {
      return await run(readMimoCookie());
    } catch (e: any) {
      if (e?.message !== "__mimo_unauthorized__") throw e;
      // 刚换的新票仍被拒：服务端会话异常。若就此抛出，index.ts 的兜底会把
      // "__mimo_unauthorized__" 当普通错误渲染成 `❌ __mimo_unauthorized__` 显示在状态行。
      // 降级成静默错误并退避，避免下一轮定时器立刻再拉一次 Chrome。
      mimoLog("relogin-still-401", "新换到的凭据仍被服务端拒绝");
      mimoLoginBlockedUntil = Date.now() + MIMO_LOGIN_RETRY_MS;
    }
  }
  // 登录未完成（窗口被关 / 超时）时，旧 cookie 可能仍被服务端认可，最后兜底试一次
  if (cred) {
    try { return await run(cred.cookie); } catch {}
  }
  throw silentError("mimo 登录态不可用");
}

/**
 * 静默换一次票：只有真拿到「新的」serviceToken 才算成功（判定逻辑在
 * cdpCollectCookies 里，靠值变化而非存在性）。失败时置退避。
 */
async function refreshMimoToken(): Promise<{ cookie: string; capturedAt: number } | null> {
  mimoLog("token-aging", "凭据临近过期，尝试静默换票");
  try {
    if (await silentMimoLogin(readMimoServiceToken())) {
      const fresh = readMimoCookieFile();
      if (fresh) return fresh;
    }
  } catch (e: any) {
    mimoLog("refresh-error", String(e?.message ?? e));
  }
  mimoLoginBlockedUntil = Date.now() + MIMO_LOGIN_RETRY_MS;
  return null;
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
