import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

const CONFIG_FILE = join(homedir(), ".pi", "agent", "ssh-configs.json");

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

export default function (pi: ExtensionAPI) {
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

    const all = loadConfigs();
    saveConfigs(all.filter((c) => c.id !== target.id));
    ctx.ui.notify(`已删除: ${target.name}`, "success");
  };

  // ── /ssh ── 单一命令，子命令通过 args 解析 ──────────
  pi.registerCommand("ssh", {
    description: "管理SSH连接（add/edit/rm/ls）",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (!sub) {
        await listAndSelect(ctx);
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
          `用法: /ssh [add|edit|rm|ls]\n` +
          `  add   新增连接\n` +
          `  edit  编辑连接\n` +
          `  rm    删除连接\n` +
          `  ls    列出并选择（默认）`,
          "info",
        );
      }
    },
  });
}
