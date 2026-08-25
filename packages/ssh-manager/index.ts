import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 类型定义 ──────────────────────────────────────

interface SshConfig {
  id: string;
  name: string;
  description?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
}

interface PluginConfig {
  /** AI 是否只能执行读命令（ls/cat/ps 等） */
  ai_readonly: boolean;
  /** 执行前确认策略: never=不确认 / write=写操作前确认 / always=每次都确认 */
  confirm_before_exec: "never" | "write" | "always";
  /** 单条命令超时秒数 */
  command_timeout: number;
}

const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  ai_readonly: true,
  confirm_before_exec: "write",
  command_timeout: 30,
};

// ── 路径 ──────────────────────────────────────────

const CONFIG_FILE = join(homedir(), ".pi", "agent", "ssh-configs.json");
const PLUGIN_CONFIG_FILE = join(homedir(), ".pi", "agent", "ssh-plugin-config.json");

// ── 插件全局配置 ──────────────────────────────────

function loadPluginConfig(): PluginConfig {
  if (!existsSync(PLUGIN_CONFIG_FILE)) return { ...DEFAULT_PLUGIN_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(PLUGIN_CONFIG_FILE, "utf-8"));
    return { ...DEFAULT_PLUGIN_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_PLUGIN_CONFIG };
  }
}

function savePluginConfig(cfg: PluginConfig) {
  writeFileSync(PLUGIN_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getConfigSummary(cfg: PluginConfig): string {
  const readonlyLabel = cfg.ai_readonly ? "是" : "否";
  const confirmLabel =
    cfg.confirm_before_exec === "never" ? "不确认" :
    cfg.confirm_before_exec === "write" ? "写操作确认" : "每次都确认";
  return [
    `AI 只读: ${readonlyLabel}`,
    `执行确认: ${confirmLabel}`,
    `命令超时: ${cfg.command_timeout}s`,
  ].join("\n");
}

// ── 安全检查 ─────────────────────────────────────

/** 常见读命令列表（只读模式下允许） */
const READ_COMMANDS = [
  "ls", "cat", "less", "more", "head", "tail",
  "ps", "top", "htop", "df", "du", "free",
  "uptime", "who", "w", "id", "pwd", "echo",
  "which", "type", "date", "cal", "uname", "hostname",
  "dmesg", "journalctl", "env", "printenv", "history",
  "stat", "file", "lsof", "netstat", "ss", "ip",
  "ifconfig", "route", "dig", "nslookup", "ping",
  "traceroute", "curl", "wget",
  "grep", "find", "locate",
  "systemctl", "service",
  "docker", "docker ps", "docker images",
  "git", "git log", "git status", "git diff",
  "npm", "npm ls", "npm list",
  "node", "node -v", "node --version",
  "python", "python3", "python --version",
  "java", "java -version",
  "nvidia-smi", "lscpu", "lsblk", "lspci", "lsusb",
];

/** 判断命令是否为只读操作 */
function isReadCommand(command: string): boolean {
  const trimmed = command.trim();
  return READ_COMMANDS.some((cmd) => {
    // 精确匹配或前缀匹配（如 "ls -la" 匹配 "ls"）
    const re = new RegExp(`^${cmd}(\\s|$)`);
    return re.test(trimmed);
  });
}

/** 硬限制的危险命令（即使 ai_readonly=false 也禁止） */
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/|rm\s+-rf\s+\/\*|rm\s+-rf\s+~/, // 递归删除根目录
  /\b(shutdown|reboot|halt|poweroff)\b/,          // 关机/重启
  /init\s+[06]/,                                    // init 0/6
  /systemctl\s+(poweroff|reboot|halt)/,            // systemctl 关机重启
  /dd\s+if=\/(dev\/zero|dev\/urandom|dev\/null)/,  // 破坏性 dd
  /\b(mkfs|fdisk|parted|format)\b/,                // 格式化/分区
  /chmod\s+-R\s+0/,                                // 权限破坏
  /chown\s+-R\s+root:root\s+\//,                   // 所有权破坏
  /mv\s+\/\*\s+\/dev\/null/,                       // 移动文件到 null
  /:\(\s*\)\s*\{/,                                  // fork 炸弹
  /\>?\s*\/dev\/sd[a-z]/,                          // 直接写块设备
];

/** 检查命令是否危险（硬限制） */
function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(command));
}

// ── SSH 连接管理 ──────────────────────────────────

/** 扫描 ~/.ssh/ 下所有存在的密钥文件，按 ed25519 → rsa → ecdsa → dsa 顺序 */
function detectSshKeys(): string[] {
  const home = homedir();
  const candidates = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"];
  return candidates
    .map((name) => join(home, ".ssh", name))
    .filter((p) => existsSync(p));
}

/** 自动从 host 派生出连接名（仅作为默认值，可被用户修改） */
function deriveName(host: string, port: number): string {
  const base = host.replace(/[^\w.-]+/g, "-");
  return port === 22 ? base : `${base}-${port}`;
}

function loadConfigs(): SshConfig[] {
  if (!existsSync(CONFIG_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveConfigs(configs: SshConfig[]) {
  writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
}

function sortedByName(configs: SshConfig[]): SshConfig[] {
  return [...configs].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/** 构建与 /ssh 相同的"名称 - IP - 说明"列表 + 映射 */
function buildDisplayList(configs: SshConfig[]): {
  list: string[];
  map: Map<string, SshConfig>;
} {
  const map = new Map<string, SshConfig>();
  const list: string[] = [];
  for (const c of configs) {
    const desc = c.description ? ` - ${c.description}` : "";
    const display = `${c.name} - ${c.host}${desc}`;
    list.push(display);
    map.set(display, c);
  }
  return { list, map };
}

function testConnection(config: SshConfig, lastError: { value: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = new Client();
    conn.on("ready", () => { conn.end(); resolve(true); });
    conn.on("error", (err) => { lastError.value = err.message; resolve(false); });

    const opts: any = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 8000,
    };
    if (config.keyPath) {
      try { opts.privateKey = readFileSync(config.keyPath); }
      catch (err: any) { lastError.value = `无法读取密钥: ${err.message}`; resolve(false); return; }
    } else if (config.password) {
      opts.password = config.password;
    } else {
      lastError.value = "未提供密钥或密码";
      resolve(false);
      return;
    }
    conn.connect(opts);
  });
}

function buildSshCommand(config: SshConfig): string {
  return `ssh -p ${config.port} ${config.username}@${config.host}`;
}

function buildSshConfigBlock(config: SshConfig): string {
  const lines: string[] = [`Host ${config.name}`];
  if (config.description) lines.push(`    # ${config.description}`);
  lines.push(`    HostName ${config.host}`);
  lines.push(`    Port ${config.port}`);
  lines.push(`    User ${config.username}`);
  if (config.keyPath) lines.push(`    IdentityFile ${config.keyPath}`);
  return lines.join("\n");
}

function showConfigDetails(ctx: any, selected: SshConfig) {
  const sshCommand = buildSshCommand(selected);
  const sshConfigBlock = buildSshConfigBlock(selected);
  const auth = selected.keyPath
    ? `🔑 密钥: ${selected.keyPath}`
    : `🔒 密码: ${selected.password}`;

  const parts: string[] = [`【服务】 ${selected.name}`];
  if (selected.description) parts.push(`【说明】 ${selected.description}`);
  parts.push(
    `【地址】 ${selected.username}@${selected.host}:${selected.port}`,
    `【认证】 ${auth}`,
    ``,
    `▸ 直接连接: ${sshCommand}`,
    ``,
    `▸ ~/.ssh/config 片段:`,
    sshConfigBlock,
  );
  ctx.ui.notify(parts.join("\n"), "info");
}

/** 执行 SSH 远程命令，返回 stdout/stderr/exit code */
function executeSshCommand(
  config: SshConfig,
  command: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          reject(err);
          return;
        }
        stream.on("close", (code: number | null) => {
          if (timer) clearTimeout(timer);
          conn.end();
          resolve({ stdout, stderr, code });
        });
        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });

    conn.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    const opts: any = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: timeout * 1000,
    };
    if (config.keyPath) {
      try { opts.privateKey = readFileSync(config.keyPath); }
      catch (err: any) { reject(err); return; }
    } else if (config.password) {
      opts.password = config.password;
    } else {
      reject(new Error("未提供密钥或密码"));
      return;
    }
    conn.connect(opts);

    timer = setTimeout(() => {
      conn.end();
      reject(new Error(`命令执行超时 (${timeout}s)`));
    }, timeout * 1000);
  });
}

// ── 配置菜单 ──────────────────────────────────────

const showPluginConfigMenu = async (ctx: any) => {
  const cfg = loadPluginConfig();
  ctx.ui.notify(getConfigSummary(cfg), "info");
  await editPluginConfig(ctx, cfg);
};

const editPluginConfig = async (ctx: any, cfg: PluginConfig) => {
  const fields = [
    {
      key: "ai_readonly" as const,
      label: "AI 只读模式",
      current: cfg.ai_readonly ? "是" : "否",
      options: ["是", "否"],
    },
    {
      key: "confirm_before_exec" as const,
      label: "执行确认",
      current:
        cfg.confirm_before_exec === "never" ? "不确认" :
        cfg.confirm_before_exec === "write" ? "写操作确认" : "每次都确认",
      options: ["不确认", "写操作确认", "每次都确认"],
      valueMap: { "不确认": "never" as const, "写操作确认": "write" as const, "每次都确认": "always" as const },
    },
    {
      key: "command_timeout" as const,
      label: "命令超时(s)",
      current: String(cfg.command_timeout),
    },
  ];

  const fieldLabels = fields.map((f) => `${f.label}（当前: ${f.current}）`);
  fieldLabels.push("✅ 完成修改");

  const newCfg = { ...cfg };

  while (true) {
    const pick = await ctx.ui.select("选择要修改的配置项", fieldLabels);
    if (!pick || pick === "✅ 完成修改") break;

    const idx = fieldLabels.indexOf(pick);
    if (idx < 0) break;
    const field = fields[idx];

    if (field.options) {
      const val = await ctx.ui.select(`选择 ${field.label}`, field.options);
      if (!val) continue;
      if (field.valueMap) {
        (newCfg as any)[field.key] = field.valueMap[val];
      } else {
        (newCfg as any)[field.key] = val === "是";
      }
    } else {
      const input = await ctx.ui.input(`${field.label}（当前: ${field.current}）`, field.current);
      if (!input) continue;
      const num = parseInt(input, 10);
      if (isNaN(num) || num <= 0) {
        ctx.ui.notify("请输入正整数", "error");
        continue;
      }
      (newCfg as any)[field.key] = num;
    }

    const updatedFields = fields.map((f) => {
      const val = (newCfg as any)[f.key];
      const display =
        f.key === "ai_readonly" ? (val ? "是" : "否") :
        f.key === "confirm_before_exec" ?
          (val === "never" ? "不确认" : val === "write" ? "写操作确认" : "每次都确认") :
          String(val);
      return `${f.label}（当前: ${display}）`;
    });
    updatedFields.push("✅ 完成修改");
    fieldLabels.length = 0;
    fieldLabels.push(...updatedFields);
  }

  savePluginConfig(newCfg);
  ctx.ui.notify(`配置已保存\n${getConfigSummary(newCfg)}`, "success");
};

// ── 导出 ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── 注册工具 ────────────────────────────────────

  // 工具 1: ssh_exec
  pi.registerTool({
    name: "ssh_exec",
    label: "远程命令执行",
    description: "通过 SSH 在指定服务器上执行命令，返回输出结果。支持 ls/cat/ps 等读命令和写操作，受配置权限控制。",
    promptSnippet: "执行远程命令。先用 ssh_list_servers 查看可用服务器，再执行命令。",
    parameters: Type.Object({
      server: Type.String({ description: "SSH 连接名称" }),
      command: Type.String({ description: "要执行的命令" }),
    }),
    async execute(_toolCallId: string, params: { server: string; command: string }, _signal: any) {
      const cfg = loadPluginConfig();

      // 硬限制：禁止危险命令
      if (isDangerousCommand(params.command)) {
        return {
          content: [{ type: "text" as const, text: "禁止执行危险命令。如需执行，请手动通过 SSH 连接服务器操作。" }],
        };
      }

      // 只读检查
      if (cfg.ai_readonly && !isReadCommand(params.command)) {
        return {
          content: [{ type: "text" as const, text: "当前配置为 AI 只读模式，不允许执行写操作命令。如需修改，请执行 /ssh config 更改配置。" }],
        };
      }

      // 确认策略
      const isWrite = !isReadCommand(params.command);
      if (cfg.confirm_before_exec === "always" || (cfg.confirm_before_exec === "write" && isWrite)) {
        return {
          content: [{ type: "text" as const, text: "命令执行需要用户确认，请手动通过 SSH 连接执行此命令。" }],
        };
      }

      // 查找服务器
      const configs = loadConfigs();
      const config = configs.find((c) => c.name === params.server);
      if (!config) {
        const available = configs.map((c) => c.name).join(", ");
        return {
          content: [{ type: "text" as const, text: `服务器 "${params.server}" 未找到。可用服务器: ${available || "无"}` }],
        };
      }

      // 执行命令
      try {
        const result = await executeSshCommand(config, params.command, cfg.command_timeout);
        const text = [
          `命令: ${params.command}`,
          `退出码: ${result.code}`,
          result.stdout ? `\n标准输出:\n${result.stdout}` : "",
          result.stderr ? `\n错误输出:\n${result.stderr}` : "",
        ].filter(Boolean).join("\n");

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `执行失败: ${err.message}` }],
        };
      }
    },
  });

  // 工具 2: ssh_list_servers
  pi.registerTool({
    name: "ssh_list_servers",
    label: "列出 SSH 服务器",
    description: "列出所有已配置的 SSH 服务器连接，包含名称、IP、端口和说明。",
    promptSnippet: "列出 SSH 服务器列表，查看可用连接后再执行远程命令。",
    parameters: Type.Object({}),
    async execute() {
      const configs = sortedByName(loadConfigs());
      if (configs.length === 0) {
        return {
          content: [{ type: "text" as const, text: "尚未配置任何 SSH 连接。请通过 /ssh add 添加。" }],
        };
      }
      const lines = configs.map((c) => {
        const auth = c.keyPath ? "🔑密钥" : "🔒密码";
        const desc = c.description ? ` - ${c.description}` : "";
        return `  ${c.name} → ${c.username}@${c.host}:${c.port} (${auth})${desc}`;
      });
      return {
        content: [{ type: "text" as const, text: `SSH 连接 (${configs.length}):\n${lines.join("\n")}` }],
      };
    },
  });

  // ── 添加配置 ──────────────────────────────────────
  const addSshConfig = async (ctx: any) => {
    const host = (await ctx.ui.input("IP地址", ""))?.trim();
    if (!host) { ctx.ui.notify("IP地址不能为空", "error"); return; }

    const description = (await ctx.ui.input("用途说明（可选）", ""))?.trim() || undefined;

    const defaultUser = process.env.USER || process.env.USERNAME || "root";
    const username = (await ctx.ui.input("用户名", defaultUser))?.trim() || defaultUser;

    const portStr = await ctx.ui.input("端口", "22");
    const port = parseInt(portStr || "22", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ctx.ui.notify("端口无效", "error"); return;
    }

    const password = (await ctx.ui.input("密码（可选，留空使用密钥）", ""))?.trim() || undefined;

    let keyPath: string | undefined;
    if (!password) {
      const detected = detectSshKeys();
      if (detected.length === 0) {
        keyPath = (await ctx.ui.input("密钥路径（未找到默认密钥）", ""))?.trim() || undefined;
      } else {
        const CUSTOM = "➕ 自定义路径";
        const choice = await ctx.ui.select("选择 SSH 密钥", [...detected, CUSTOM]);
        if (choice === CUSTOM) {
          keyPath = (await ctx.ui.input("自定义密钥路径", ""))?.trim() || undefined;
        } else if (choice) {
          keyPath = choice;
        }
      }
    }

    if (!password && !keyPath) {
      ctx.ui.notify("密码和密钥至少填一个", "error");
      return;
    }

    const defaultName = deriveName(host, port);
    const name = (await ctx.ui.input("连接名称（可改）", defaultName))?.trim() || defaultName;

    const config: SshConfig = { id: randomUUID(), name, description, host, port, username, password, keyPath };

    const lastError = { value: "" };
    ctx.ui.notify("正在测试连接...", "info");
    if (!(await testConnection(config, lastError))) {
      ctx.ui.notify(`连接失败: ${lastError.value || "请检查信息后重试"}`, "error");
      return;
    }

    const configs = loadConfigs();
    if (configs.some((c) => c.name === name)) {
      ctx.ui.notify(`已存在同名配置: ${name}`, "error");
      return;
    }
    configs.push(config);
    saveConfigs(configs);
    ctx.ui.notify(`配置已保存: ${name}`, "success");
  };

  // ── 编辑配置 ──────────────────────────────────────
  const editSshConfig = async (ctx: any, original: SshConfig) => {
    // 顶部回显所有当前值
    const authDisplay = original.keyPath
      ? `🔑 密钥: ${original.keyPath}`
      : `🔒 密码: ${original.password}`;
    ctx.ui.notify(
      `编辑: ${original.name}（留空保持当前值，清空说明请输入 -）\n\n` +
      `  IP:     ${original.host}\n` +
      `  说明:   ${original.description || "(无)"}\n` +
      `  用户名: ${original.username}\n` +
      `  端口:   ${original.port}\n` +
      `  认证:   ${authDisplay}`,
      "info",
    );

    // 标题里明示当前值，placeholder 同步显示
    const host = (await ctx.ui.input(
      `IP地址（当前: ${original.host}）`,
      original.host,
    ))?.trim() || original.host;

    const descInput = await ctx.ui.input(
      `用途说明（当前: ${original.description || "无"}，清空请输入 -）`,
      original.description || "",
    );
    const description = descInput?.trim() === "-"
      ? undefined
      : (descInput?.trim() || original.description);

    const username = (await ctx.ui.input(
      `用户名（当前: ${original.username}）`,
      original.username,
    ))?.trim() || original.username;

    const portStr = await ctx.ui.input(
      `端口（当前: ${original.port}）`,
      String(original.port),
    );
    const port = parseInt(portStr || String(original.port), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ctx.ui.notify("端口无效", "error");
      return;
    }

    const name = (await ctx.ui.input(
      `连接名称（当前: ${original.name}）`,
      original.name,
    ))?.trim() || original.name;

    const updated: SshConfig = { ...original, name, host, port, username, description };

    const all = loadConfigs();
    if (updated.name !== original.name && all.some((c) => c.id !== original.id && c.name === updated.name)) {
      ctx.ui.notify(`已存在同名配置: ${updated.name}`, "error");
      return;
    }

    const idx = all.findIndex((c) => c.id === original.id);
    if (idx < 0) {
      ctx.ui.notify("找不到原配置（可能已被删除）", "error");
      return;
    }
    all[idx] = updated;
    saveConfigs(all);
    ctx.ui.notify(`已更新: ${updated.name}`, "success");
  };

  // ── 列出配置（菜单模式） ─────────────────────────────
  const listAndSelect = async (ctx: any) => {
    const configs = sortedByName(loadConfigs());
    const { list: displayList, map } = buildDisplayList(configs);

    const choice = await ctx.ui.select(
      configs.length === 0
        ? "尚未配置任何连接"
        : "选择SSH连接（格式：名称 - IP - 说明）",
      displayList,
    );
    if (!choice) return;
    const selected = map.get(choice);
    if (selected) showConfigDetails(ctx, selected);
  };

  // ── 列出配置（选择编辑） ─────────────────────────────
  const pickAndEdit = async (ctx: any) => {
    const configs = sortedByName(loadConfigs());
    if (configs.length === 0) {
      ctx.ui.notify("没有可编辑的配置，请先 /ssh add", "info");
      return;
    }
    const { list, map } = buildDisplayList(configs);
    const choice = await ctx.ui.select("选择要编辑的连接", list);
    if (!choice) return;
    const original = map.get(choice);
    if (original) await editSshConfig(ctx, original);
  };

  // ── 列出配置（选择删除） ─────────────────────────────
  const pickAndRemove = async (ctx: any) => {
    const configs = sortedByName(loadConfigs());
    if (configs.length === 0) {
      ctx.ui.notify("没有可删除的配置", "info");
      return;
    }
    const { list, map } = buildDisplayList(configs);
    const choice = await ctx.ui.select("选择要删除的连接", list);
    if (!choice) return;
    const target = map.get(choice);
    if (!target) return;

    const ok = await ctx.ui.confirm("确认删除", `确定删除 SSH 连接 ${target.name}（${target.host}）？此操作不可恢复。`);
    if (!ok) return;

    const all = loadConfigs();
    saveConfigs(all.filter((c) => c.id !== target.id));
    ctx.ui.notify(`已删除: ${target.name}`, "success");
  };

  // ── /ssh 命令 ──────────────────────────────────────
  pi.registerCommand("ssh", {
    description: "AI 远程操作服务器",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (!sub) {
        // 导航菜单
        const navActions = [
          "📋 查看连接",
          "➕ 新增连接",
          "✏️ 编辑连接",
          "🗑️ 删除连接",
          "⚙️ 配置",
        ];
        const navChoice = await ctx.ui.select("SSH 服务器管理", navActions);
        if (!navChoice) return;

        if (navChoice === "⚙️ 配置") {
          await showPluginConfigMenu(ctx);
        } else if (navChoice === "📋 查看连接") {
          await listAndSelect(ctx);
        } else if (navChoice === "➕ 新增连接") {
          await addSshConfig(ctx);
        } else if (navChoice === "✏️ 编辑连接") {
          await pickAndEdit(ctx);
        } else if (navChoice === "🗑️ 删除连接") {
          await pickAndRemove(ctx);
        }
      } else if (sub === "config" || sub === "c") {
        await showPluginConfigMenu(ctx);
      } else if (sub === "add" || sub === "new" || sub === "a") {
        await addSshConfig(ctx);
      } else if (sub === "edit" || sub === "e") {
        await pickAndEdit(ctx);
      } else if (sub === "rm" || sub === "remove" || sub === "del" || sub === "delete" || sub === "d") {
        await pickAndRemove(ctx);
      } else if (sub === "ls" || sub === "list") {
        await listAndSelect(ctx);
      } else {
        ctx.ui.notify(
          "用法: /ssh [add|edit|rm|ls|config]\n" +
          "  add    新增连接\n" +
          "  edit   编辑连接\n" +
          "  rm     删除连接\n" +
          "  ls     列出并选择（默认）\n" +
          "  config 查看/修改插件配置\n" +
          "  默认   打开管理菜单",
          "info",
        );
      }
    },
  });
}