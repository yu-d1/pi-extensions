/**
 * 历史数据口径回填（一次性维护工具）
 * =============================================================================
 * 用途：旧版本用「cacheRead ≈ 同会话上一轮 input」逐轮判定 inputScope，参照物
 * 在跨模型时会取错，把 inclusive 的模型（实测 commandcodego / minimax）误标成
 * exclusive。被误标的记录在聚合时会把缓存再加一遍，导致总 prompt 翻倍
 * （实测 20.3M 被算成 40.8M）。
 *
 * 本工具按**模型级累计比值**重算口径并就地改写 raw/*.jsonl 的 inputScope 字段：
 *   - 只改口径标记，不动 input / cacheRead / output 等任何数值
 *   - 口径是模型级属性，同一模型的所有记录共享同一结论
 *   - 先整批读入、全部算完再写，中途失败不留半成品
 *
 * 用法（在包目录下）：
 *   node --experimental-strip-types backfill-scope.ts --dry-run   # 只看会改什么
 *   node --experimental-strip-types backfill-scope.ts             # 真正写入
 *
 * 写入前会自动把 raw 目录备份到 raw-backfill-<时间戳>/，可随时回滚。
 */

import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectInputScope } from "./format";
import type { InputScope } from "./format";

const LOGS_DIR = join(homedir(), ".pi/agent/extensions/token-stats-logs");
const RAW_DIR = join(LOGS_DIR, "raw");
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

interface RawLine {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputScope?: InputScope;
  provider?: string;
  modelId?: string;
  model?: string;
  [key: string]: unknown;
}

/** 与 index.ts 的 recordModelKey 同口径：优先显式字段，回退解析 model */
function modelKeyOf(record: RawLine): string {
  if (record.provider || record.modelId) {
    return `${record.provider || "unknown"}/${record.modelId || "unknown"}`;
  }
  const raw = (record.model ?? "").trim();
  return raw.includes("/") ? raw : "unknown/legacy";
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  let names: string[];
  try {
    names = await readdir(RAW_DIR);
  } catch {
    console.error(`找不到 raw 目录：${RAW_DIR}`);
    process.exitCode = 1;
    return;
  }
  const files = names.filter((n) => DATE_FILE.test(n)).sort();
  if (files.length === 0) {
    console.log("raw 目录下没有日期分片，无需处理");
    return;
  }

  // 阶段一：全量读入，按模型累计口径证据
  const byFile = new Map<string, RawLine[]>();
  const evidence = new Map<string, { input: number; cacheRead: number }>();
  for (const name of files) {
    const text = await readFile(join(RAW_DIR, name), "utf-8");
    const lines: RawLine[] = [];
    for (const raw of text.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed) as RawLine);
      } catch {
        // 坏行原样保留：不解析就无法改写，但绝不能丢
        lines.push({ __unparsed: raw } as unknown as RawLine);
      }
    }
    byFile.set(name, lines);
    for (const record of lines) {
      if ((record as { __unparsed?: string }).__unparsed !== undefined) continue;
      const key = modelKeyOf(record);
      let item = evidence.get(key);
      if (!item) {
        item = { input: 0, cacheRead: 0 };
        evidence.set(key, item);
      }
      const input = Number(record.input) || 0;
      const cacheRead = Number(record.cacheRead) || 0;
      if (input > 0) item.input += input;
      if (cacheRead > 0) item.cacheRead += cacheRead;
    }
  }

  // 阶段二：逐模型定口径
  const decided = new Map<string, InputScope>();
  for (const [key, item] of evidence) {
    const scope = detectInputScope(item.input, item.cacheRead);
    if (scope) decided.set(key, scope);
  }

  console.log("模型级判定结果：");
  for (const [key, scope] of decided) {
    const item = evidence.get(key)!;
    const ratio = item.input > 0 ? (item.cacheRead / item.input).toFixed(3) : "-";
    console.log(`  ${key.padEnd(46)} ${scope.padEnd(10)} cacheRead/input=${ratio}`);
  }
  const undecided = [...evidence.keys()].filter((k) => !decided.has(k));
  if (undecided.length > 0) {
    console.log(`  证据不足、保持原值的模型：${undecided.join(", ")}`);
  }

  // 阶段三：统计与改写
  let totalRecords = 0;
  let changedRecords = 0;
  const changedByModel = new Map<string, number>();
  for (const lines of byFile.values()) {
    for (const record of lines) {
      if ((record as { __unparsed?: string }).__unparsed !== undefined) continue;
      totalRecords++;
      const next = decided.get(modelKeyOf(record));
      if (!next || record.inputScope === next) continue;
      changedRecords++;
      const key = modelKeyOf(record);
      changedByModel.set(key, (changedByModel.get(key) ?? 0) + 1);
      record.inputScope = next;
    }
  }

  console.log(`\n记录总数 ${totalRecords}，需修正 ${changedRecords}`);
  for (const [key, count] of changedByModel) {
    console.log(`  ${key.padEnd(46)} ${count} 条`);
  }

  if (changedRecords === 0) {
    console.log("\n无需改动");
    return;
  }
  if (dryRun) {
    console.log("\n--dry-run：未写入任何文件");
    return;
  }

  // 阶段四：备份后原子写入
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = join(LOGS_DIR, `raw-backfill-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  for (const name of files) {
    await copyFile(join(RAW_DIR, name), join(backupDir, name));
  }
  console.log(`\n已备份原始数据到：${backupDir}`);

  for (const [name, lines] of byFile) {
    const body = lines
      .map((record) =>
        (record as { __unparsed?: string }).__unparsed !== undefined
          ? (record as { __unparsed: string }).__unparsed
          : JSON.stringify(record),
      )
      .join("\n");
    const target = join(RAW_DIR, name);
    const temp = `${target}.tmp`;
    // 先写临时文件再 rename：中途掉电也不会留下半截文件
    await writeFile(temp, body + "\n", "utf-8");
    await rename(temp, target);
  }

  console.log(`已改写 ${files.length} 个日期分片（口径标记，未触碰任何数值）`);
  console.log("如需回滚：把备份目录内容拷回 raw/ 覆盖即可");
}

main().catch((error) => {
  console.error("回填失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
