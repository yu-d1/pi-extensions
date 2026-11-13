// ── 只读命令判定 ──────────────────────────────────
//
// 旧实现只校验命令的第一个词，导致 `git push`、`curl -o`、`find -delete`
// 这类命令全部被当作只读放行。这里改为：先禁止复合命令，再逐段校验，
// 并且对「同名命令既可能读也可能写」的情况一律不放行。

/** 合法读命令及其允许的短参数范围（不带值的开关） */
interface ReadRule {
  /** 命令名 */
  command: string;
  /** 只允许这些开关（含组合，如 -la）；除以下外出现其它参数即判定为非只读 */
  allowFlags?: RegExp;
  /** 允许带值的参数名，如 --lines 10 */
  allowOptions?: string[];
  /** 允许位置参数（如 cat 的文件名） */
  allowOperand?: boolean;
  /** 该命令自身是否不接受操作数 */
  noOperand?: boolean;
}

const READ_RULES: ReadRule[] = [
  { command: "ls", allowFlags: /^-[a-zA-Z]+$/, allowOperand: true },
  { command: "cat", allowFlags: /^-[bnAsETuv]+$/, allowOperand: true },
  { command: "head", allowFlags: /^-[ncqvz]+$/, allowOptions: ["-n", "-c"], allowOperand: true },
  { command: "tail", allowFlags: /^-[ncqvfF]+$/, allowOptions: ["-n", "-c"], allowOperand: true },
  { command: "wc", allowFlags: /^-[lwcm]+$/, allowOperand: true },
  { command: "stat", allowOperand: true },
  { command: "file", allowFlags: /^-[bLis]+$/, allowOperand: true },
  { command: "pwd", noOperand: true },
  { command: "whoami", noOperand: true },
  { command: "hostname", allowFlags: /^-[fisdA]+$/, noOperand: true },
  { command: "uname", allowFlags: /^-[asnrvmpio]+$/, noOperand: true },
  { command: "uptime", noOperand: true },
  { command: "date", allowFlags: /^-[uR]+$/, noOperand: true },
  { command: "df", allowFlags: /^-[hHiklmPT]+$/, allowOperand: true },
  { command: "du", allowFlags: /^-[hsakcmx]+$/, allowOptions: ["-d", "--max-depth"], allowOperand: true },
  { command: "free", allowFlags: /^-[hHmkbtw]+$/, noOperand: true },
  { command: "ps", allowFlags: /^-[aAeEfFhjlLrsSTuUxXo]+$/, allowOptions: ["-o", "-u", "-p", "--sort", "-C"], allowOperand: true },
  { command: "id", allowFlags: /^-[GgnruZ]+$/, allowOperand: true },
  { command: "groups", allowOperand: true },
  { command: "nproc", noOperand: true },
  { command: "lscpu", noOperand: true },
  { command: "lsblk", allowFlags: /^-[aJlmnprStT]+$/, noOperand: true },
  { command: "lspci", allowFlags: /^-[tvmmk]+$/, noOperand: true },
  { command: "lsusb", allowFlags: /^-[tv]+$/, noOperand: true },
  { command: "locale", noOperand: true },
  { command: "printenv", allowOperand: true },
];

/** 出现在任何位置都视为写操作的关键字 */
const WRITE_KEYWORDS = /\b(sudo|su|doas|eval|exec|source|nohup|watch|xargs|tee)\b/;

/** 复合命令与重定向：只读模式一律不允许 */
const COMPOUND_PATTERN = /[;&|\n`]|\$\(|\$\{|\]|>|</;

/** 硬限制：任何模式下都禁止 */
const FORBIDDEN_COMMANDS = new Set([
  "shutdown", "reboot", "halt", "poweroff", "init", "telinit",
  "mkfs", "mke2fs", "fdisk", "parted", "dd", "wipefs",
  "rm", "rmdir", "shred", "unlink",
  "mv", "cp", "chmod", "chown", "chgrp", "chattr", "setfacl",
  "useradd", "userdel", "usermod", "groupadd", "groupdel", "passwd", "chpasswd",
  "mount", "umount", "swapoff", "modprobe", "rmmod", "insmod",
  "iptables", "ip6tables", "nft", "ufw", "firewall-cmd",
  "truncate", "fallocate", "mkswap", "swapoff",
]);

/** 硬限制：绝对禁止的片段（不论参数如何） */
const FORBIDDEN_SNIPPETS = [
  /:\s*\(\s*\)\s*\{/,                      // fork 炸弹
  /\bfind\b[^;|&]*\s-delete\b/,            // find -delete
  /\bmkfs(\.\w+)?\b/,                       // 格式化
  /\bdd\b[^;|&]*\bof=\/dev\//,              // dd 写块设备
  /\b(shutdown|reboot|halt|poweroff)\b/,    // 关机重启
];

/** 取命令主词（去掉路径前缀与 sudo 之类） */
function commandWord(segment: string): string {
  const first = segment.trim().split(/\s+/)[0] ?? "";
  return first.replace(/^.*\//, "");
}

/** 检出最早出现的禁止命令 */
export function findForbiddenCommand(command: string): string | undefined {
  for (const pattern of FORBIDDEN_SNIPPETS) {
    if (pattern.test(command)) return command.match(pattern)?.[0] ?? "禁止的命令";
  }
  for (const segment of command.split(/[;&|\n`]+/)) {
    const word = commandWord(segment);
    if (word && FORBIDDEN_COMMANDS.has(word)) return word;
  }
  return undefined;
}

/** 判断单段命令是否符合只读规则 */
function isReadSegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const word = commandWord(segment);
  const rule = READ_RULES.find((r) => r.command === word);
  if (!rule) return false;

  // 只允许 word 出现一次（防止 `ls ls` 之类误判）
  const args = tokens.slice(1);
  if (args.some((a) => a === word)) return false;

  let sawOperand = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      const flag = eq >= 0 ? arg.slice(0, eq) : arg;
      if (rule.allowOptions?.includes(flag)) {
        // 形如 --lines=10 自带值，否则跳过下一个 token
        if (eq < 0) i++;
        continue;
      }
      if (rule.allowFlags?.test(flag)) continue;
      return false;
    }
    // 位置参数
    if (rule.noOperand) return false;
    if (!rule.allowOperand) return false;
    sawOperand = true;
  }
  return true;
}

/**
 * 判断命令是否为纯只读操作。
 * 只读模式下只要出现管道、重定向、命令串联、变量展开就一律拒绝。
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (WRITE_KEYWORDS.test(trimmed)) return false;
  if (COMPOUND_PATTERN.test(trimmed)) return false;
  return isReadSegment(trimmed);
}

/** 是否命中硬禁止（与只读配置无关） */
export function isForbiddenCommand(command: string): boolean {
  return findForbiddenCommand(command) !== undefined;
}

/** 用于提示的拒绝原因 */
export function explainReadonlyReject(command: string): string {
  if (COMPOUND_PATTERN.test(command)) {
    return "只读模式不允许管道、重定向或复合命令（; && | > 等）。";
  }
  if (WRITE_KEYWORDS.test(command)) {
    return "只读模式不允许 sudo、eval、xargs 等提权或间接执行。";
  }
  return "只读模式下仅允许明确无副作用的查看类命令（如 ls、cat、ps、df）。";
}
