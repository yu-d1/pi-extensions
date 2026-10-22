// =============================================================================
// 统计数据清理
// =============================================================================
// 三层数据必须同步删除，否则同一段时间在报表与终端视图里会显示成两组数字：
//   raw/   逐轮明细（网页报表的唯一数据源）
//   hourly/ 小时聚合（/stats hour）
//   daily/  日聚合（/stats day|week|month|year）
//
// 删除前先把要删的文件全部找出来、统计体积，再逐个删；
// 中途失败不影响其它文件，最后按「已删 / 失败」分别汇报，不静默吞错。

import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const LOGS_DIR = join(homedir(), ".pi/agent/extensions/token-stats-logs");
const RAW_DIR = join(LOGS_DIR, "raw");
const HOURLY_DIR = join(LOGS_DIR, "hourly");
const DAILY_DIR = join(LOGS_DIR, "daily");
const DAILY_FILE = join(DAILY_DIR, "daily.jsonl");

/** `YYYY-MM-DD.jsonl` 这种按日分片的目录 */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface PurgeScope {
  /** 起始日期（含），`YYYY-MM-DD` */
  from: string;
  /** 结束日期（含），`YYYY-MM-DD` */
  to: string;
}

export interface PurgePlan {
  rawFiles: string[];
  hourlyFiles: string[];
  /** daily.jsonl 中需要删除的日期行 */
  dailyDates: string[];
  /** daily.jsonl 清空后是否整个删掉 */
  dropDailyFile: boolean;
  bytes: number;
  /** 命中范围内实际有数据的日期（升序） */
  dates: string[];
}

export interface PurgeResult {
  removedFiles: number;
  removedDays: number;
  bytes: number;
  failures: string[];
}

/** 列出目录下所有 `YYYY-MM-DD.jsonl` 的日期；给了范围就只保留范围内的 */
async function listDayFiles(dir: string, from?: string, to?: string) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const m = DAY_FILE.exec(name);
    const date = m?.[1];
    if (!date) continue;
    if (from !== undefined && date < from) continue;
    if (to !== undefined && date > to) continue;
    out.push(date);
  }
  return out.sort();
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** 读出 daily.jsonl 里所有日期（坏行忽略） */
async function listDailyDates(): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(DAILY_FILE, "utf-8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as { date?: unknown };
      if (typeof row.date === "string") out.push(row.date);
    } catch {
      // 坏行跳过
    }
  }
  return out.sort();
}

/** 所有有数据的日期（三层取并集，用于给用户展示可选范围） */
export async function listAllDates(): Promise<string[]> {
  const [raw, hourly, daily] = await Promise.all([
    listDayFiles(RAW_DIR),
    listDayFiles(HOURLY_DIR),
    listDailyDates(),
  ]);
  return Array.from(new Set([...raw, ...hourly, ...daily])).sort();
}

/** 统计某范围内要删什么，不实际删除（供确认弹窗展示） */
export async function planPurge(scope: PurgeScope): Promise<PurgePlan> {
  const { from, to } = scope;
  const [rawDates, hourlyDates, dailyAll] = await Promise.all([
    listDayFiles(RAW_DIR, from, to),
    listDayFiles(HOURLY_DIR, from, to),
    listDailyDates(),
  ]);

  const dailyDates = dailyAll.filter((d) => d >= from && d <= to);

  const rawFiles = rawDates.map((d) => join(RAW_DIR, `${d}.jsonl`));
  const hourlyFiles = hourlyDates.map((d) => join(HOURLY_DIR, `${d}.jsonl`));

  let bytes = 0;
  for (const f of [...rawFiles, ...hourlyFiles]) bytes += await sizeOf(f);
  bytes += await sizeOf(DAILY_FILE);

  const dates = Array.from(new Set([...rawDates, ...hourlyDates, ...dailyDates])).sort();

  return {
    rawFiles,
    hourlyFiles,
    dailyDates,
    dropDailyFile: dailyDates.length >= dailyAll.length && dailyAll.length > 0,
    bytes,
    dates,
  };
}

/** 执行删除。daily 是单个文件，按行过滤后写回，全删则直接移除文件 */
export async function runPurge(plan: PurgePlan): Promise<PurgeResult> {
  const failures: string[] = [];
  let removedFiles = 0;

  for (const file of [...plan.rawFiles, ...plan.hourlyFiles]) {
    try {
      await rm(file, { force: true });
      removedFiles++;
    } catch (error) {
      failures.push(`${file}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (plan.dailyDates.length) {
    const drop = new Set(plan.dailyDates);
    try {
      if (plan.dropDailyFile) {
        await rm(DAILY_FILE, { force: true });
        removedFiles++;
      } else {
        const text = await readFile(DAILY_FILE, "utf-8");
        const kept: string[] = [];
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          let date: unknown;
          try {
            date = (JSON.parse(t) as { date?: unknown }).date;
          } catch {
            kept.push(t); // 坏行原样保留，不因清理而丢数据
            continue;
          }
          if (typeof date !== "string" || !drop.has(date)) kept.push(t);
        }
        await writeFile(DAILY_FILE, kept.length ? kept.join("\n") + "\n" : "", "utf-8");
      }
    } catch (error) {
      failures.push(`${DAILY_FILE}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    removedFiles,
    removedDays: plan.dates.length,
    bytes: plan.bytes,
    failures,
  };
}

/** 人类可读体积 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 该范围内是否有任何数据 */
export function isEmpty(plan: PurgePlan): boolean {
  return plan.rawFiles.length === 0 && plan.hourlyFiles.length === 0 && plan.dailyDates.length === 0;
}
