import * as fs from "node:fs";
import * as path from "node:path";
import type { ParsedFileOperations } from "../types";

type TokenKind = "word" | "op";

interface ShellToken {
  kind: TokenKind;
  value: string;
}

const OP_CHARS = new Set([";", "|", "&", "<", ">"]);

/**
 * 轻量 shell lexer：
 * - 正确处理单/双引号、反斜杠转义、# 注释；
 * - 把 `;`、`|`、`&&`、`||` 等控制符作为独立 op token；
 * - 递归展开 `$(...)` 和反引号里的命令，避免漏掉子命令里的 rm/mv。
 *
 * 这仍不是完整 shell 解释器，但比旧版正则方式可靠得多。
 */
export function lexShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let i = 0;

  function pushWord(value: string): void {
    if (value.length > 0) tokens.push({ kind: "word", value });
  }

  function readQuoted(quote: "'" | '"', start: number): { value: string; next: number } {
    let out = "";
    let j = start + 1;
    while (j < command.length) {
      const ch = command[j];
      if (quote === "'") {
        if (ch === "'") {
          j++;
          break;
        }
        out += ch;
        j++;
        continue;
      }

      // 双引号：只对 $ ` " \ 做转义处理，其余字符保留。
      if (ch === "\\" && j + 1 < command.length) {
        const next = command[j + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          out += next;
          j += 2;
          continue;
        }
        out += "\\";
        j++;
        continue;
      }
      if (ch === '"') {
        j++;
        break;
      }
      out += ch;
      j++;
    }
    return { value: out, next: j };
  }

  function readCommandSubstitution(start: number): { tokens: ShellToken[]; next: number } | null {
    const quote = command[start];
    const isBacktick = quote === "`";
    let j = start + 1;
    let depth = isBacktick ? 0 : 1;
    let inSingle = false;
    let inDouble = false;

    while (j < command.length) {
      const ch = command[j];
      if (inSingle) {
        if (ch === "'") inSingle = false;
        j++;
        continue;
      }
      if (inDouble) {
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === '"') inDouble = false;
        j++;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        j++;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        j++;
        continue;
      }
      if (isBacktick) {
        if (ch === "`") {
          const inner = command.slice(start + 1, j);
          return { tokens: lexShell(inner), next: j + 1 };
        }
        j++;
        continue;
      }
      if (ch === "(") {
        depth++;
        j++;
        continue;
      }
      if (ch === ")") {
        depth--;
        if (depth === 0) {
          const inner = command.slice(start + 2, j);
          return { tokens: lexShell(inner), next: j + 1 };
        }
        j++;
        continue;
      }
      if (ch === "\\") {
        j += 2;
        continue;
      }
      j++;
    }
    return null;
  }

  while (i < command.length) {
    const ch = command[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // 注释：出现在 token 开头的 # 之后整段忽略。
    if (ch === "#") {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }

    // 命令替换。
    if (ch === "$" && command[i + 1] === "(") {
      const sub = readCommandSubstitution(i);
      if (sub) {
        tokens.push(...sub.tokens);
        i = sub.next;
        continue;
      }
    }
    if (ch === "`") {
      const sub = readCommandSubstitution(i);
      if (sub) {
        tokens.push(...sub.tokens);
        i = sub.next;
        continue;
      }
    }

    // 控制符。
    if (OP_CHARS.has(ch)) {
      let value = ch;
      // `>>` 作为整体保留（redirection 会单独解析）。
      if (ch === ">" && command[i + 1] === ">") {
        value = ">>";
        i++;
      } else if (ch === "|" && command[i + 1] === "|") {
        value = "||";
        i++;
      } else if (ch === "&" && command[i + 1] === "&") {
        value = "&&";
        i++;
      }
      tokens.push({ kind: "op", value });
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quoted = readQuoted(ch, i);
      pushWord(quoted.value);
      i = quoted.next;
      continue;
    }

    let word = "";
    while (i < command.length) {
      const c = command[i];
      if (/\s/.test(c) || OP_CHARS.has(c)) break;
      if (c === "\\" && i + 1 < command.length) {
        word += command[i + 1];
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        const quoted = readQuoted(c, i);
        word += quoted.value;
        i = quoted.next;
        continue;
      }
      if (c === "$" && command[i + 1] === "(") {
        const sub = readCommandSubstitution(i);
        if (sub) {
          word += sub.tokens.map((t) => t.value).join(" ");
          i = sub.next;
          continue;
        }
      }
      if (c === "#") {
        // 单词中间的 # 不是注释，按普通字符继续。
        word += c;
        i++;
        continue;
      }
      word += c;
      i++;
    }
    pushWord(word);
  }

  return tokens;
}

function basenameOf(token: string): string {
  return token.replace(/\\/g, "/").split("/").pop() ?? token;
}

function isCommand(token: string, commandName: string): boolean {
  return basenameOf(token).toLowerCase() === commandName;
}

function isFlag(token: string, commandName: string): boolean {
  if (token === "--") return true;
  if (token.startsWith("-") && token.length > 1) return true;
  // Windows del 命令常用 /q /f /s 开关；bash 里的绝对路径 /tmp/... 不按 flag 处理。
  if (commandName === "del" && /^\/[A-Za-z]$/.test(token)) return true;
  return false;
}

function segmentWords(tokens: ShellToken[], commandName: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };

  for (const token of tokens) {
    if (token.kind === "op") {
      flush();
      continue;
    }
    if (current.length === 0 && !isCommand(token.value, commandName)) {
      continue;
    }
    current.push(token.value);
  }
  flush();
  return segments.filter((words) => words.length > 1);
}

function collectRmTargets(tokens: ShellToken[]): string[] {
  const targets: string[] = [];
  for (const words of segmentWords(tokens, "rm")) {
    let endOfFlags = false;
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (!endOfFlags && isFlag(word, "rm")) {
        if (word === "--") endOfFlags = true;
        continue;
      }
      endOfFlags = true;
      targets.push(word);
    }
  }
  // Windows del。
  for (const words of segmentWords(tokens, "del")) {
    let endOfFlags = false;
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (!endOfFlags && isFlag(word, "del")) {
        if (word === "--") endOfFlags = true;
        continue;
      }
      endOfFlags = true;
      targets.push(word);
    }
  }
  return targets;
}

function collectMvPairs(tokens: ShellToken[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const words of segmentWords(tokens, "mv")) {
    const args: string[] = [];
    let endOfFlags = false;
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (!endOfFlags && isFlag(word, "mv")) {
        if (word === "--") endOfFlags = true;
        continue;
      }
      endOfFlags = true;
      args.push(word);
    }
    if (args.length >= 2) {
      const dest = args[args.length - 1];
      for (const source of args.slice(0, -1)) {
        pairs.push([source, dest]);
      }
    }
  }
  return pairs;
}

/**
 * 引号感知的重定向目标提取。
 * 只处理 `>` 和 `>>`（写/追加），跳过 here-doc `<<`。
 */
function collectRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  let i = 0;

  function readTarget(start: number): { value: string; next: number } {
    let j = start;
    while (j < command.length && /\s/.test(command[j])) j++;
    if (j >= command.length) return { value: "", next: j };

    let value = "";
    if (command[j] === "'" || command[j] === '"') {
      const quote = command[j] as "'" | '"';
      j++;
      while (j < command.length) {
        const ch = command[j];
        if (quote === "'") {
          if (ch === "'") {
            j++;
            break;
          }
          value += ch;
          j++;
          continue;
        }
        if (ch === "\\" && j + 1 < command.length) {
          const next = command[j + 1];
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            value += next;
            j += 2;
            continue;
          }
        }
        if (ch === '"') {
          j++;
          break;
        }
        value += ch;
        j++;
      }
      return { value, next: j };
    }

    while (j < command.length) {
      const ch = command[j];
      if (/\s/.test(ch) || OP_CHARS.has(ch)) break;
      if (ch === "\\" && j + 1 < command.length) {
        value += command[j + 1];
        j += 2;
        continue;
      }
      value += ch;
      j++;
    }
    return { value, next: j };
  }

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'" || ch === '"') {
      const quote = ch as "'" | '"';
      i++;
      while (i < command.length) {
        if (command[i] === "\\" && quote === '"' && i + 1 < command.length) {
          i += 2;
          continue;
        }
        if (command[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "\\") {
      i += 2;
      continue;
    }

    if (ch === ">") {
      // `<<` 是输入重定向，与文件写入无关。
      if (command[i + 1] === "<") {
        i += 2;
        continue;
      }
      let j = i;
      if (command[j + 1] === ">") j++;
      const target = readTarget(j + 1);
      if (target.value && !target.value.startsWith("&")) targets.push(target.value);
      i = target.next;
      continue;
    }

    i++;
  }

  return targets;
}

export function parseFileOperations(command: string): ParsedFileOperations {
  const trimmed = command.trim();
  if (!trimmed) return { rmTargets: [], mvPairs: [], redirectTargets: [] };
  const tokens = lexShell(trimmed);
  return {
    rmTargets: collectRmTargets(tokens),
    mvPairs: collectMvPairs(tokens),
    redirectTargets: collectRedirectTargets(trimmed),
  };
}

export function expandGlob(pattern: string, baseDir: string): string[] {
  const hasGlob = pattern.includes("*") || pattern.includes("?");
  if (!hasGlob) return [pathResolve(baseDir, pattern)];

  const absPattern = pathResolve(baseDir, pattern);
  const dir = pathDirname(absPattern);
  const base = pathBasename(absPattern);

  let entries: string[] = [];
  try {
    entries = readDirNames(dir);
  } catch {
    // 目录不存在时保留原 pattern；trackPathBefore 会记录“文件不存在”状态。
    return [absPattern];
  }

  const re = globToRegExp(base);
  const matches = entries.filter((name) => re.test(name)).map((name) => pathJoin(dir, name));
  return matches.length > 0 ? matches : [absPattern];
}

function pathResolve(base: string, p: string): string {
  return path.resolve(base, p);
}
function pathDirname(p: string): string {
  return path.dirname(p);
}
function pathBasename(p: string): string {
  return path.basename(p);
}
function pathJoin(dir: string, name: string): string {
  return path.join(dir, name);
}
function readDirNames(dir: string): string[] {
  return fs.readdirSync(dir);
}
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
