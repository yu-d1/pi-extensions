/**
 * 套餐配额查询 —— mimo（小米）
 * =============================================================================
 * 控制台账户余额：/api/v1/balance，凭据是网页登录 Cookie（不是推理用的 api key）。
 * Cookie 通过 Chrome + CDP 静默续期：
 *   1. 无头 Chrome 试一次（profile 登录态还在就直接续上，零打扰）；
 *   2. 失败才弹有头窗口人工登录（进行中仅状态行提示，失败才通知）。
 * 零 npm 依赖：WebSocket 用 Node 内置，CDP 协议手写。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
/** cookie 有效期约 24h，提前 4h 主动续期（避免每天首个请求浪费一次 401） */
const MIMO_COOKIE_TTL = 20 * 3600_000;
/** 排查日志上限，超过即清空重建 */
const MIMO_LOG_MAX_BYTES = 1_000_000;

let mimoLoginBlockedUntil = 0;
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
 * 静默续期：系统 Chrome + CDP 读 cookie，零依赖、不下载浏览器。
 * 先无头静默试一次（cookie 文件在、或 profile 里登录态还在都可能直接续上）；
 * 失败才弹有头窗口让人工登录。
 */
async function silentMimoLogin(): Promise<boolean> {
  const chrome = findChrome();
  mimoLog("login-begin", `chrome=${chrome ?? "未找到"}`);
  if (!chrome) return false;
  mkdirSync(MIMO_PROFILE_DIR, { recursive: true });
  try {
    if (await cdpCollectCookies(chrome, true, 5_000)) {
      mimoLog("login-headless-ok");
      return true;
    }
    mimoLog("login-headless-fail");
  } catch (e: any) {
    mimoLog("login-headless-error", String(e?.message ?? e));
  }
  // 需要人工登录：弹有头窗口。进行中只显示轻量状态行（完成即消失），失败才通知
  try {
    setQuotaStatus?.("mimo 登录中：在 Chrome 窗口完成登录，完成后自动关闭");
  } catch {}
  mimoLog("login-headed-begin");
  try {
    const ok = await cdpCollectCookies(chrome, false, 180_000);
    try { setQuotaStatus?.(""); } catch {}
    mimoLog(ok ? "login-headed-ok" : "login-headed-timeout");
    if (!ok) {
      try {
        notifyQuota?.(
          "mimo 登录未完成（已等 3 分钟）。\n"
          + "若之前手动打开过 mimo 专用浏览器窗口（" + MIMO_PROFILE_DIR + "），\n"
          + "请先关闭它再重试——profile 被占用时新窗口会秒退。",
        );
      } catch {}
    }
    return ok;
  } catch (e: any) {
    try { setQuotaStatus?.(""); } catch {}
    mimoLog("login-headed-error", String(e?.message ?? e));
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
 * 清理孤儿 profile 锁。Chrome 被强杀/进程崩溃后会留下 SingletonLock，
 * 下次启动时它会认为「已有实例占用该 profile」而把请求转发后自己退出，
 * 结果就是既没窗口也读不到调试端口。这里把指向已死进程的锁删掉。
 */
function clearStaleSingletonLock(): void {
  if (profileLockedByLiveProcess()) return;
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { unlinkSync(join(MIMO_PROFILE_DIR, name)); } catch {}
  }
}

/**
 * 启一个 Chrome（可选无头）打开控制台页面，轮询等登录 cookie 出现。
 * 拿到就写盘并关窗，超时/出错一律返回 false。
 */
async function cdpCollectCookies(chrome: string, headless: boolean, waitMs: number): Promise<boolean> {
  let proc: any;
  let ws: any;
  let reused = false;
  try {
    let port = "";
    // ① 已有 Chrome 正占用该 profile：直接复用它的调试端口，
    //    不要再启一个（会被转发后秒退，还把 DevToolsActivePort 读成陈旧的）
    if (profileLockedByLiveProcess()) {
      port = readDevToolsPort();
      if (port) {
        reused = true;
        mimoLog("reuse-running-instance", `port=${port}`);
      }
    }
    // ② 没有活实例 → 启一个
    if (!port) {
      const args = [
        "--remote-debugging-port=0",
        `--user-data-dir=${MIMO_PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(headless ? [] : ["--new-window"]),
        `${MIMO_BASE}/console/plan-manage`,
      ];
      if (headless) args.unshift("--headless=new");
      clearStaleSingletonLock();
      proc = spawn(chrome, args, { stdio: "ignore" });
      mimoLog("chrome-spawned", `pid=${proc.pid} headless=${headless}`);
      const startDeadline = Date.now() + 15_000;
      while (Date.now() < startDeadline) {
        port = readDevToolsPort();
        if (port) break;
        // 进程已退（例如 profile 被占导致转发后退出）：立即放弃，不空等
        if (proc.exitCode !== null || proc.signalCode) {
          mimoLog("chrome-exited-early", `code=${proc.exitCode} signal=${proc.signalCode}`);
          return false;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!port) {
        mimoLog("chrome-port-timeout", `等 15000ms 未读到 DevToolsActivePort`);
        return false;
      }
    }
    mimoLog("cdp-port-ok", `port=${port} reused=${reused}`);

    const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json());
    if (!version?.webSocketDebuggerUrl) return false;
    ws = new WebSocket(version.webSocketDebuggerUrl);
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
        mimoLog("cdp-getcookies-error", String(e?.message ?? e));
        break;
      }
      const keep = cookies.filter((c: any) => MIMO_COOKIE_NAMES.includes(c?.name));
      if (keep.some((c: any) => c.name === "api-platform_serviceToken")) {
        writeMimoCookie(keep.map((c: any) => `${c.name}="${String(c.value).replace(/"/g, "")}"`).join("; "));
        mimoLog("cookie-captured", `${keep.length} 个`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  } finally {
    try { ws?.close(); } catch {}
    // 复用的实例是用户/上次的进程，不能杀
    if (!reused) {
      try { proc?.kill(); } catch {}
      // profile 被 Chrome 独占，等无头实例彻底退出后再开有头窗口
      if (headless) await new Promise((r) => setTimeout(r, 800));
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
 * cookie 缺失 / 临近过期 / 401 时静默续期一次后重试。
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
  if (Date.now() < mimoLoginBlockedUntil) {
    mimoLog("backoff-skip", `还需等 ${Math.ceil((mimoLoginBlockedUntil - Date.now()) / 1000)}s`);
    throw silentError("mimo 登录态不可用");
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
