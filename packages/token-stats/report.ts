// 网页报表数据生成器（索引 + 按天分片）
// =============================================================================
// 模板 report.html 固定不变，数据旁路加载：
//   索引：report-index.js        字典（模型/会话）+ 日期列表，很小
//   分片：report-day-YYYY-MM-DD.js  单日逐轮记录
//
// 为什么拆成索引 + 分片：
//   旧方案每次生成都要重算全部历史（4.8 万轮 / 1.6 MB / 约 190ms），
//   因此只能在手动执行 /stats html 时重建，日常对话产生的数据进不去报表。
//   拆分后「重建今天」只需读当天一个文件（几百轮，毫秒级），
//   可以挂在 agent_end 上每轮自动更新，历史分片永不再算。
//
// 为什么数据是 .js 而不是 .json：
//   file:// 下 fetch() 读本地 JSON 会被 CORS 拦死，<script src> 不受此限制。
//
// 为什么模板不内联数据：
//   内联则每查一次就要新生成一个 HTML，收藏的链接会随文件名变化失效。

import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { UNKNOWN_MODEL_KEY, detectInputScope, getModelKey } from "./format";

/** 本文件所在目录 = 插件安装目录（report.html 与生成的数据文件都放这里） */
export const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

export const REPORT_HTML_PATH = join(PACKAGE_DIR, "report.html");
export const REPORT_INDEX_PATH = join(PACKAGE_DIR, "report-index.js");
/** 旧版单文件，仅用于清理遗留文件 */
const LEGACY_DATA_PATH = join(PACKAGE_DIR, "report-data.js");

const LOGS_DIR = join(homedir(), ".pi/agent/extensions/token-stats-logs");
const RAW_DIR = join(LOGS_DIR, "raw");

/**
 * 逐轮记录压缩后的单行形态（数组，靠位置表达含义，比对象字面量省一半体积）。
 * 顺序与 `REPORT_DATA_VERSION` 绑定，改动必须同步升级版本号，否则旧分片会错位。
 */
type PackedTurn = [
  number, // 0  当天秒数 0..86399
  number, // 1  模型索引 → index.models[i]
  number, // 2  新增输入
  number, // 3  输出
  number, // 4  缓存读
  number, // 5  缓存写
  number, // 6  输出速率 × 10（取整，省掉小数点和 0）
  number, // 7  会话索引 → index.sessions[i]
];

/** 索引文件结构 */
interface ReportIndex {
  version: number;
  generatedAt: string;
  /** 模型名字典，分片第 1 列是它的下标 */
  models: string[];
  /** 会话字典，分片第 7 列是它的下标 */
  sessions: string[];
  /** 有数据的日期（升序），页面据此判断哪个分片存在 */
  dates: string[];
  /** 总轮数，仅用于展示 */
  turns: number;
}

/** 单个日期分片的结构 */
interface ReportDay {
  version: number;
  date: string;
  turns: PackedTurn[];
}

/** 数据格式版本。结构有任何变动都要 +1，report.html 会据此拒绝错位数据。 */
export const REPORT_DATA_VERSION = 2;

interface RawLine {
  ts?: string;
  inputScope?: "exclusive" | "inclusive";
  model?: string;
  provider?: string;
  modelId?: string;
  session?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tokensPerSec?: number;
}

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** 与 index.ts 的 recordModelKey 保持同一口径（优先显式字段，回退解析 model） */
function modelKeyOf(line: RawLine): string {
  if (line.provider || line.modelId) return getModelKey(line.provider, line.modelId);
  const raw = (line.model ?? "").trim();
  return raw.includes("/") ? raw : UNKNOWN_MODEL_KEY;
}

/**
 * 把记录的 UTC 时间戳换算成「本地时间的当天秒数」。
 *
 * 为什么不直接截取 ISO 里的时分秒：raw 里的 ts 是 UTC（带 Z），
 * 直接截取会在 UTC+8 下少 8 小时——页面显示 09:33，实际对话发生在 17:33。
 * 日期键仍沿用文件名的 UTC 日期（与终端视图、文件名一致），
 * 只有展示用的时分秒按本地时间还原。
 */
function secOfDay(iso: string, fallback: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return fallback;
  const d = new Date(t);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

/** 把可能为 undefined/NaN/负数 的数值收敛成非负整数 */
function int(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 判定某条记录的 input 是否含缓存。
 * 已落盘的值优先；否则现场推断，并把结论按模型固化（口径是 provider 固有属性）。
 */
function resolveInclusive(
  declared: "exclusive" | "inclusive" | undefined,
  decided: Map<string, boolean>,
  modelKey: string,
  prevInput: number,
  cacheRead: number,
): boolean {
  if (declared) {
    const v = declared === "inclusive";
    decided.set(modelKey, v);
    return v;
  }
  const known = decided.get(modelKey);
  if (known !== undefined) return known;
  const guessed = detectInputScope(prevInput, cacheRead);
  if (guessed !== undefined) {
    const v = guessed === "inclusive";
    decided.set(modelKey, v);
    return v;
  }
  // 判定不出来时按 pi-ai 官方语义处理，宁可少算缓存也不放大命中率
  return false;
}

/** 列出 raw 目录下所有日期（升序） */
async function listRawDates(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(RAW_DIR);
  } catch {
    return [];
  }
  return names
    .map((name) => DATE_FILE_RE.exec(name)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort();
}

/** 读一条 raw 文件，返回解析成功的行（坏行跳过） */
async function readRawLines(date: string): Promise<RawLine[]> {
  let text: string;
  try {
    text = await readFile(join(RAW_DIR, `${date}.jsonl`), "utf-8");
  } catch {
    return [];
  }
  const out: RawLine[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RawLine);
    } catch {
      // 半行（进程被杀）不该拖垮整份报表
    }
  }
  return out;
}

/** 分片文件名 */
function dayFileName(date: string): string {
  return `report-day-${date}.js`;
}

/** 写一个文件，内容为 `window.__X__ = <json>;` */
async function writeJsFile(path: string, varName: string, value: unknown): Promise<number> {
  const body = `window.${varName}=${JSON.stringify(value)};`;
  await writeFile(path, body, "utf-8");
  return Buffer.byteLength(body, "utf-8");
}

/**
 * 字典（模型名 / 会话 ID）。
 *
 * 集中放在索引里，分片只存下标：分片每轮只有 8 个数字，体积最小。
 * 代价是新增模型/会话时要重写索引——但索引本身只有几百字节，可忽略。
 */
class Dictionary {
  readonly models: string[] = [];
  readonly sessions: string[] = [];
  private readonly modelAt = new Map<string, number>();
  private readonly sessionAt = new Map<string, number>();

  constructor(index?: ReportIndex) {
    if (index) {
      for (const key of index.models) {
        this.modelAt.set(key, this.models.push(key) - 1);
      }
      for (const id of index.sessions) {
        this.sessionAt.set(id, this.sessions.push(id) - 1);
      }
    }
  }

  model(key: string): number {
    const hit = this.modelAt.get(key);
    if (hit !== undefined) return hit;
    const index = this.models.push(key) - 1;
    this.modelAt.set(key, index);
    return index;
  }

  session(id: string): number {
    const hit = this.sessionAt.get(id);
    if (hit !== undefined) return hit;
    const index = this.sessions.push(id) - 1;
    this.sessionAt.set(id, index);
    return index;
  }
}

/**
 * 把一天的 raw 行打包成 PackedTurn[]。
 *
 * scopeState 跨日期共享：口径判定需要「同会话上一轮 input」，
 * 而会话可能跨天，所以状态必须由调用方持有并贯穿整个遍历。
 */
function packDay(lines: RawLine[], dict: Dictionary, scopeState: ScopeState): PackedTurn[] {
  const packed: PackedTurn[] = [];
  for (const record of lines) {
    const ts = typeof record.ts === "string" ? record.ts : "";
    // inclusive 口径下 input 已含缓存，必须拆成「新增」再存，
    // 否则前端把两者相加会把缓存算两遍，命中率被钉在 50%（详见 format.ts 的 InputScope）
    const cacheRead = int(record.cacheRead);
    const cacheWrite = int(record.cacheWrite);
    const rawInput = int(record.input);
    const modelKey = modelKeyOf(record);
    const sessionId = record.session ?? "";

    const inclusive = resolveInclusive(
      record.inputScope,
      scopeState.decided,
      modelKey,
      scopeState.lastInput.get(sessionId) ?? 0,
      cacheRead,
    );
    scopeState.lastInput.set(sessionId, rawInput);

    const input = inclusive ? Math.max(0, rawInput - cacheRead - cacheWrite) : rawInput;
    packed.push([
      secOfDay(ts, 0),
      dict.model(modelKey),
      input,
      int(record.output),
      cacheRead,
      cacheWrite,
      Math.round((Number(record.tokensPerSec) || 0) * 10),
      dict.session(sessionId),
    ]);
  }
  return packed;
}

/** 跨日期保留的口径判定状态 */
interface ScopeState {
  decided: Map<string, boolean>;
  lastInput: Map<string, number>;
}

function newScopeState(): ScopeState {
  return { decided: new Map(), lastInput: new Map() };
}

async function readIndex(): Promise<ReportIndex | null> {
  try {
    const raw = await readFile(REPORT_INDEX_PATH, "utf-8");
    // 文件内容是 `window.__REPORT_INDEX__={...};`，取出对象部分
    const json = raw.slice(raw.indexOf("=") + 1).replace(/;\s*$/, "");
    const parsed = JSON.parse(json) as ReportIndex;
    return parsed.version === REPORT_DATA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** 删掉旧版单文件，避免页面/用户误读 */
async function removeLegacy(): Promise<void> {
  try {
    await unlink(LEGACY_DATA_PATH);
  } catch {
    // 不存在就算了
  }
}

/**
 * 全量重建：索引 + 所有日期分片。
 *
 * 只在首次生成或数据格式升级时用。日常增量走 rebuildToday()。
 */
export async function writeReportData(): Promise<{
  path: string;
  files: number;
  turns: number;
  bytes: number;
  days: number;
}> {
  await removeLegacy();

  const dates = await listRawDates();
  const dict = new Dictionary();
  const scopeState = newScopeState();

  let turns = 0;
  let bytes = 0;
  const kept: string[] = [];

  for (const date of dates) {
    const lines = await readRawLines(date);
    if (!lines.length) continue;
    const packed = packDay(lines, dict, scopeState);
    if (!packed.length) continue;
    const day: ReportDay = { version: REPORT_DATA_VERSION, date, turns: packed };
    bytes += await writeJsFile(join(PACKAGE_DIR, dayFileName(date)), "__REPORT_DAY__", day);
    turns += packed.length;
    kept.push(date);
  }

  const index: ReportIndex = {
    version: REPORT_DATA_VERSION,
    generatedAt: new Date().toISOString(),
    models: dict.models,
    sessions: dict.sessions,
    dates: kept,
    turns,
  };
  bytes += await writeJsFile(REPORT_INDEX_PATH, "__REPORT_INDEX__", index);

  // 清掉已无数据的历史分片（手动清理 raw 后目录不该留孤儿）
  await removeOrphanShards(kept);

  return {
    path: REPORT_INDEX_PATH,
    files: dates.length,
    turns,
    bytes,
    days: kept.length,
  };
}

/**
 * 增量重建：只重算指定日期（默认今天），沿用已有索引的字典。
 *
 * 这是挂在 agent_end 上的热路径，只读当天一个 raw 文件，通常几毫秒。
 * 索引不存在（从未全量生成过）时退回全量，保证第一次就能用。
 */
export async function rebuildDay(date?: string): Promise<{
  path: string;
  turns: number;
  bytes: number;
  created: boolean;
} | null> {
  const index = await readIndex();
  if (!index) {
    // 从未生成过索引：不在对话热路径上做全量重建（可能几百毫秒），
    // 留给用户主动执行 /stats html。页面此时会提示「请执行 /stats html」。
    return null;
  }

  const target = date ?? localDateStr();
  const lines = await readRawLines(target);

  // 字典从索引恢复；口径状态只带今天的（跨天会话的精确判定由已落盘的 inputScope 保证）
  const dict = new Dictionary(index);
  const scopeState = newScopeState();

  const packed = packDay(lines, dict, scopeState);
  const dayPath = join(PACKAGE_DIR, dayFileName(target));

  let bytes: number;
  if (packed.length) {
    const day: ReportDay = { version: REPORT_DATA_VERSION, date: target, turns: packed };
    bytes = await writeJsFile(dayPath, "__REPORT_DAY__", day);
  } else {
    // 当天还没数据：删掉可能存在的空分片，日期列表也不该包含它
    try {
      await unlink(dayPath);
    } catch {
      // 本来就不存在
    }
    bytes = 0;
  }

  const hadDate = index.dates.includes(target);
  const dates = packed.length
    ? (hadDate ? index.dates : [...index.dates, target].sort())
    : index.dates.filter((d) => d !== target);

  const dictChanged = dict.models.length !== index.models.length
    || dict.sessions.length !== index.sessions.length
    || (packed.length === 0 && hadDate);
  const datesChanged = dates.length !== index.dates.length;

  // 字典或日期列表没变就不用重写索引（绝大多数轮次都是这种情况）
  if (dictChanged || datesChanged) {
    const next: ReportIndex = {
      version: REPORT_DATA_VERSION,
      generatedAt: new Date().toISOString(),
      models: dict.models,
      sessions: dict.sessions,
      dates,
      turns: index.turns + (hadDate ? 0 : packed.length),
    };
    bytes += await writeJsFile(REPORT_INDEX_PATH, "__REPORT_INDEX__", next);
  }

  return { path: dayPath, turns: packed.length, bytes, created: !hadDate && packed.length > 0 };
}

/** 本地日期 YYYY-MM-DD（与 raw 文件名的 UTC 日期口径一致时优先，这里用于定位当天文件） */
function localDateStr(): string {
  // raw 文件名由 record.ts.slice(0,10) 决定，ts 是 UTC，所以按 UTC 取日期才对齐
  return new Date().toISOString().slice(0, 10);
}

/** 删除不该存在的分片（raw 里已无对应日期） */
async function removeOrphanShards(keep: string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(PACKAGE_DIR);
  } catch {
    return;
  }
  const keepSet = new Set(keep);
  for (const name of names) {
    const m = /^report-day-(\d{4}-\d{2}-\d{2})\.js$/.exec(name);
    if (!m || keepSet.has(m[1]!)) continue;
    try {
      await unlink(join(PACKAGE_DIR, name));
    } catch {
      // 删不掉不影响正确性，页面只按索引里的日期列表加载
    }
  }
}
