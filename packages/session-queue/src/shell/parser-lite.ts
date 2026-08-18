import * as fs from "node:fs";
import * as path from "node:path";
import type { ParsedFileOperations } from "../types";

/**
 * 针对本地项目回滚场景的简化 bash 解析：
 * - 只处理单/双引号和反斜杠转义；
 * - 识别 rm/del、mv、`>` / `>>` 重定向；
 * - 不做命令替换、here-doc、复杂控制流等极端情况。
 */

type WordKind = "word" | "op";

interface Word {
  kind: WordKind;
  value: string;
}

const OPERATORS = new Set([";", "|", "&", "<", ">"]);

function tokenize(command: string): Word[] {
  const words: Word[] = [];
  let i = 0;

  const pushWord = (value: string) => {
    if (value) words.push({ kind: "word", value });
  };

  while (i < command.length) {
    const ch = command[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (OPERATORS.has(ch)) {
      let value = ch;
      if ((ch === ">" || ch === "|" || ch === "&") && command[i + 1] === ch) {
        value += ch;
        i++;
      }
      words.push({ kind: "op", value });
      i++;
      continue;
    }

    let value = "";
    while (i < command.length) {
      const c = command[i];
      if (/\s/.test(c) || OPERATORS.has(c)) break;

      if (c === "'" || c === '"') {
        const quote = c;
        i++;
        while (i < command.length && command[i] !== quote) {
          if (quote === '"' && command[i] === "\\" && i + 1 < command.length) {
            const next = command[i + 1];
            if (next === '"' || next === "\\" || next === "$" || next === "`") {
              value += next;
              i += 2;
            } else {
              // Windows 路径：双引号内 `\t` 等不是 shell 转义，保留反斜杠，下一轮再处理后续字符。
              value += "\\";
              i++;
            }
            continue;
          }
          value += command[i];
          i++;
        }
        if (i < command.length) i++; // 跳过结束引号
        continue;
      }

      if (c === "\\" && i + 1 < command.length) {
        value += command[i + 1];
        i += 2;
        continue;
      }

      value += c;
      i++;
    }
    pushWord(value);
  }

  return words;
}

function commandName(word: string): string {
  return word.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? word.toLowerCase();
}

function isFlag(word: string, command: string): boolean {
  if (word === "--") return true;
  if (word.startsWith("-") && word.length > 1) return true;
  if (command === "del" && /^\/[A-Za-z]$/.test(word)) return true;
  return false;
}

/** 收集某个命令后面的参数，直到下一个控制符。 */
function commandArgs(words: Word[], command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const word of words) {
    if (word.kind === "op") {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    if (current.length === 0 && commandName(word.value) !== command) continue;
    current.push(word.value);
  }
  if (current.length > 0) segments.push(current);
  return segments.filter((args) => args.length > 1);
}

function collectRmTargets(words: Word[]): string[] {
  const targets: string[] = [];
  for (const command of ["rm", "del"]) {
    for (const args of commandArgs(words, command)) {
      let optionsEnded = false;
      for (let i = 1; i < args.length; i++) {
        if (!optionsEnded && isFlag(args[i], command)) {
          if (args[i] === "--") optionsEnded = true;
          continue;
        }
        optionsEnded = true;
        targets.push(args[i]);
      }
    }
  }
  return targets;
}

function collectMvPairs(words: Word[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const args of commandArgs(words, "mv")) {
    const files: string[] = [];
    let optionsEnded = false;
    for (let i = 1; i < args.length; i++) {
      if (!optionsEnded && isFlag(args[i], "mv")) {
        if (args[i] === "--") optionsEnded = true;
        continue;
      }
      optionsEnded = true;
      files.push(args[i]);
    }
    if (files.length >= 2) {
      const dest = files[files.length - 1];
      for (const source of files.slice(0, -1)) pairs.push([source, dest]);
    }
  }
  return pairs;
}

function collectRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < command.length && command[i] !== quote) {
        if (quote === '"' && command[i] === "\\" && i + 1 < command.length) i += 2;
        else i++;
      }
      if (i < command.length) i++;
      continue;
    }

    if (ch === "\\") {
      i += 2;
      continue;
    }

    if (ch === ">") {
      if (command[i + 1] === "<") {
        i += 2;
        continue;
      }
      let j = i;
      if (command[j + 1] === ">") j++;
      j++;
      while (j < command.length && /\s/.test(command[j])) j++;

      let target = "";
      while (j < command.length) {
        const c = command[j];
        if (/\s/.test(c) || OPERATORS.has(c)) break;
        if (c === "\\" && j + 1 < command.length) {
          target += command[j + 1];
          j += 2;
          continue;
        }
        if (c === "'" || c === '"') {
          const quote = c;
          j++;
          while (j < command.length && command[j] !== quote) {
            target += command[j];
            j++;
          }
          if (j < command.length) j++;
          continue;
        }
        target += c;
        j++;
      }
      if (target && !target.startsWith("&")) targets.push(target);
      i = j;
      continue;
    }

    i++;
  }

  return targets;
}

export function parseFileOperations(command: string): ParsedFileOperations {
  const trimmed = command.trim();
  if (!trimmed) return { rmTargets: [], mvPairs: [], redirectTargets: [] };
  const words = tokenize(trimmed);
  return {
    rmTargets: collectRmTargets(words),
    mvPairs: collectMvPairs(words),
    redirectTargets: collectRedirectTargets(trimmed),
  };
}

export function expandGlob(pattern: string, baseDir: string): string[] {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return [path.resolve(baseDir, pattern)];
  }

  const abs = path.resolve(baseDir, pattern);
  const dir = path.dirname(abs);
  const base = path.basename(abs);

  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [abs];
  }

  const escaped = base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  const re = new RegExp(`^${escaped}$`);
  const matches = names.filter((name) => re.test(name)).map((name) => path.join(dir, name));
  return matches.length > 0 ? matches : [abs];
}
