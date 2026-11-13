import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIRM_LABELS,
  DEFAULT_PLUGIN_CONFIG,
  authLabel,
  configFilePath,
  configSummary,
  displayLine,
  findByName,
  loadConfigs,
  loadPluginConfig,
  persistConfig,
  saveConfigs,
  savePluginConfig,
  setEnabled,
  sortedByName,
  type ConfirmPolicy,
  type PluginConfig,
  type SshConfig,
} from "./config.js";
import { testConnection } from "./client.js";
import { pickEnabledItems } from "./toggle-selector.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 菜单文案 ──────────────────────────────────────

const MENU_ENABLE = "启用";
const MENU_EDIT = "编辑";
const MENU_VIEW = "查看";
const MENU_DELETE = "删除";
const MENU_SETTINGS = "设置";

const MENU_DONE = "完成";
const MENU_ADD = "新增连接";

const CUSTOM_KEY = "自定义路径";

const ON = "已启用";
const OFF = "已停用";

// ── 通用 ──────────────────────────────────────────

/** 扫描 ~/.ssh 下的常见密钥 */
function detectSshKeys(): string[] {
  const candidates = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"];
  return candidates
    .map((name) => join(homedir(), ".ssh", name))
    .filter((p) => existsSync(p));
}

/** 从 host 派生默认连接名，仅作默认值 */
export function deriveName(host: string, port: number): string {
  const base = host.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "ssh";
  return port === 22 ? base : `${base}-${port}`;
}

function buildSelection(configs: SshConfig[]): { list: string[]; map: Map<string, SshConfig> } {
  const map = new Map<string, SshConfig>();
  const list = configs.map((c) => {
    const line = `${c.enabled ? "" : "[停用] "}${displayLine(c)}`;
    map.set(line, c);
    return line;
  });
  return { list, map };
}

/** 逐项输入：回车保持原值，输入 - 置空 */
async function readField(
  ctx: ExtensionContext,
  label: string,
  current: string,
  placeholder: string,
): Promise<string | null | undefined> {
  const input = await ctx.ui.input(
    `${label}（当前: ${current || "空"}，回车保持，输入 - 置空）`,
    placeholder,
  );
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  if (trimmed === "-") return null;
  if (!trimmed) return current;
  return trimmed;
}

function canonical(port: number | string): number {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 22;
}

// ── 启用 ──────────────────────────────────────────

async function enableMenu(ctx: ExtensionContext) {
  const configs = sortedByName(loadConfigs());
  if (configs.length === 0) {
    ctx.ui.notify("尚未配置任何连接。请先在「编辑」中新增连接。", "info");
    return;
  }

  if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
    await enableMenuFallback(ctx);
    return;
  }

  // 把勾选结果写盘；^s 与退出时共用
  const save = (selected: string[]) => {
    const all = loadConfigs();
    const marked = new Set(selected);
    let changed = 0;
    for (const config of all) {
      const next = marked.has(config.id);
      if (config.enabled !== next) {
        config.enabled = next;
        changed++;
      }
    }
    if (changed > 0) saveConfigs(all);
  };

  const result = await pickEnabledItems(ctx, {
    title: "启用 - SSH 连接",
    subtitle: "勾选的连接对 AI 开放",
    hint: "空格切换，^a 全选，^s 保存，esc 完成",
    countLabel: "已启用",
    items: configs.map((c) => ({
      id: c.id,
      label: c.name,
      badge: `${c.username}@${c.host}:${c.port}`,
      detail: c.description,
    })),
    initialMarked: configs.filter((c) => c.enabled).map((c) => c.id),
    // ^s：保存后留在界面继续调整
    onSave: async ({ selected }) => {
      save(selected);
    },
  });

  // esc：未修改则完成，有未保存修改时已确认放弃（返回 null）
  if (result) save(result.selected);

  const latest = loadConfigs();
  const open = latest.filter((c) => c.enabled).map((c) => c.name);
  ctx.ui.notify(
    open.length > 0
      ? `当前对 AI 开放 (${open.length}/${latest.length}): ${open.join(", ")}`
      : "当前没有对 AI 开放的连接。",
    "info",
  );
}

/** 非 TUI 环境的逐项开关 */
async function enableMenuFallback(ctx: ExtensionContext) {
  while (true) {
    const configs = sortedByName(loadConfigs());
    const options = [
      ...configs.map((c) => `${c.enabled ? ON : OFF} ${displayLine(c)}`),
      MENU_DONE,
    ];
    const choice = await ctx.ui.select("启用 - SSH 连接", options);
    if (!choice || choice === MENU_DONE) break;

    const target = configs.find((c) => choice.endsWith(displayLine(c)));
    if (!target) continue;
    const updated = setEnabled(target.id, !target.enabled);
    ctx.ui.notify(`${updated?.enabled ? "已启用" : "已停用"}: ${target.name}`, "success");
  }
}

// ── 新增 ──────────────────────────────────────────

async function addConfig(ctx: ExtensionContext): Promise<SshConfig | undefined> {
  const host = (await ctx.ui.input("主机地址（IP 或域名）", ""))?.trim();
  if (!host) {
    ctx.ui.notify("主机地址不能为空", "error");
    return undefined;
  }

  const portInput = await ctx.ui.input("端口", "22");
  const port = canonical(portInput ?? 22);

  const description = (await ctx.ui.input("说明（可选）", ""))?.trim() || undefined;

  const defaultUser = process.env.USER || process.env.USERNAME || "root";
  const username = (await ctx.ui.input("账号", defaultUser))?.trim() || defaultUser;

  const password = (await ctx.ui.input("密码（留空则使用密钥）", ""))?.trim() || undefined;

  let keyPath: string | undefined;
  if (!password) {
    const detected = detectSshKeys();
    if (ctx.mode === "tui" && detected.length > 0) {
      const choice = await ctx.ui.select("选择密钥", [...detected, CUSTOM_KEY]);
      if (!choice) return undefined;
      keyPath = choice === CUSTOM_KEY
        ? (await ctx.ui.input("密钥路径", ""))?.trim() || undefined
        : choice;
    } else {
      keyPath = (await ctx.ui.input("密钥路径", ""))?.trim() || undefined;
    }
  }

  if (!password && !keyPath) {
    ctx.ui.notify("密码和密钥至少填写一项", "error");
    return undefined;
  }

  const defaultName = deriveName(host, port);
  const name = (await ctx.ui.input("连接名称", defaultName))?.trim() || defaultName;

  if (findByName(name)) {
    ctx.ui.notify(`已存在同名连接: ${name}`, "error");
    return undefined;
  }

  const config: SshConfig = {
    id: randomUUID(),
    name,
    host,
    port,
    username,
    description,
    password,
    keyPath,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  ctx.ui.notify("正在测试连接...", "info");
  const test = await testConnection(config);
  if (!test.ok) {
    const still = await ctx.ui.confirm(
      "连接失败",
      `${test.error ?? "未知错误"}\n\n仍然保存这条连接吗？`,
    );
    if (!still) return undefined;
  }

  const all = loadConfigs();
  all.push(config);
  saveConfigs(all);
  ctx.ui.notify(`连接已保存: ${name}`, "success");
  return config;
}

// ── 编辑 ──────────────────────────────────────────

async function editConfig(ctx: ExtensionContext, original: SshConfig) {
  const current: SshConfig = { ...original };

  const host = await readField(ctx, "主机地址", current.host, current.host);
  if (host === undefined) return;
  if (host !== null) current.host = host;

  const portInput = await readField(ctx, "端口", String(current.port), String(current.port));
  if (portInput === undefined) return;
  current.port = canonical(portInput ?? current.port);

  const username = await readField(ctx, "账号", current.username, current.username);
  if (username === undefined) return;
  if (username !== null) current.username = username;

  const description = await readField(ctx, "说明", current.description ?? "", current.description ?? "");
  if (description === undefined) return;
  current.description = description ?? undefined;

  const name = await readField(ctx, "连接名称", current.name, current.name);
  if (name === undefined) return;
  if (name !== null) current.name = name;

  // 认证信息单独走一遍，允许在密码与密钥之间切换
  const changeAuth = await ctx.ui.confirm("认证方式", `当前: ${authLabel(current)}。要修改认证信息吗？`);
  if (changeAuth === undefined) return;
  if (changeAuth) {
    const usePassword = await ctx.ui.confirm("认证方式", "使用密码认证？选「否」改为密钥");
    if (usePassword === undefined) return;
    if (usePassword) {
      const password = await readField(ctx, "密码", "", "");
      if (password === undefined) return;
      if (password !== null && password !== "") {
        current.password = password;
        current.keyPath = undefined;
      }
    } else {
      const detected = detectSshKeys();
      const choice = detected.length > 0
        ? await ctx.ui.select("选择密钥", [...detected, CUSTOM_KEY])
        : CUSTOM_KEY;
      if (!choice) return;
      const keyPath = choice === CUSTOM_KEY
        ? (await ctx.ui.input("密钥路径", current.keyPath ?? ""))?.trim() || undefined
        : choice;
      if (keyPath) {
        current.keyPath = keyPath;
        current.password = undefined;
      }
    }
  }

  if (current.name !== original.name && findByName(current.name)) {
    ctx.ui.notify(`已存在同名连接: ${current.name}`, "error");
    return;
  }

  // 只有连接信息变化才重测，改名称或说明不测
  const connChanged =
    current.host !== original.host ||
    current.port !== original.port ||
    current.username !== original.username ||
    current.password !== original.password ||
    current.keyPath !== original.keyPath;

  if (connChanged) {
    ctx.ui.notify("连接信息已变化，正在测试...", "info");
    const test = await testConnection(current);
    if (!test.ok) {
      const still = await ctx.ui.confirm(
        "连接失败",
        `${test.error ?? "未知错误"}\n\n仍然保存吗？`,
      );
      if (!still) return;
    }
  }

  if (!persistConfig(current)) {
    ctx.ui.notify("连接已不存在，可能已被删除", "error");
    return;
  }
  ctx.ui.notify(`已更新: ${current.name}`, "success");
}

async function pickAndEdit(ctx: ExtensionContext) {
  const configs = sortedByName(loadConfigs());
  const { list, map } = buildSelection(configs);
  const choice = await ctx.ui.select("选择要编辑的连接", [...list, MENU_ADD]);
  if (!choice) return;

  if (choice === MENU_ADD) {
    const created = await addConfig(ctx);
    if (created) {
      ctx.ui.notify(`已保存: ${created.name}，可继续编辑其他连接`, "success");
    }
    return;
  }

  const target = map.get(choice);
  if (target) await editConfig(ctx, target);
}

// ── 查看 ──────────────────────────────────────────

function viewConfigs(ctx: ExtensionContext) {
  const configs = sortedByName(loadConfigs());
  if (configs.length === 0) {
    ctx.ui.notify("尚未配置任何连接。", "info");
    return;
  }

  const blocks = configs.map((c) => {
    const lines = [
      `${c.enabled ? ON : OFF}  ${c.name}`,
      `  地址: ${c.username}@${c.host}:${c.port}`,
    ];
    if (c.description) lines.push(`  说明: ${c.description}`);
    lines.push(`  认证: ${authLabel(c)}`);
    if (c.keyPath) lines.push(`  密钥: ${c.keyPath}`);
    if (c.password) lines.push(`  密码: ${c.password}`);
    lines.push(`  直连: ssh -p ${c.port} ${c.username}@${c.host}`);
    return lines.join("\n");
  });

  const enabled = configs.filter((c) => c.enabled).length;
  ctx.ui.notify(
    `SSH 连接 (${configs.length}，已启用 ${enabled})\n\n${blocks.join("\n\n")}`,
    "info",
  );
}

// ── 删除 ──────────────────────────────────────────

async function deleteConfig(ctx: ExtensionContext) {
  const configs = sortedByName(loadConfigs());
  if (configs.length === 0) {
    ctx.ui.notify("没有可删除的连接。", "info");
    return;
  }

  const { list, map } = buildSelection(configs);
  const choice = await ctx.ui.select("选择要删除的连接", list);
  if (!choice) return;

  const target = map.get(choice);
  if (!target) return;

  const ok = await ctx.ui.confirm(
    "确认删除",
    `确定删除连接 ${target.name}（${target.username}@${target.host}:${target.port}）？此操作不可恢复。`,
  );
  if (!ok) return;

  saveConfigs(loadConfigs().filter((c) => c.id !== target.id));
  ctx.ui.notify(`已删除: ${target.name}`, "success");
}

// ── 设置 ──────────────────────────────────────────

const TIMEOUT_OPTIONS = ["5", "15", "30", "60", "120", "自定义输入"];

async function editSettings(ctx: ExtensionContext) {
  const cfg = loadPluginConfig();
  const next: PluginConfig = { ...cfg };

  while (true) {
    const options = [
      `只读模式（当前: ${next.ai_readonly ? "是" : "否"}）`,
      `执行确认（当前: ${CONFIRM_LABELS[next.confirm_before_exec]}）`,
      `命令超时（当前: ${next.command_timeout}s）`,
      MENU_DONE,
    ];
    const choice = await ctx.ui.select("设置", options);
    if (!choice || choice === MENU_DONE) break;

    if (choice.startsWith("只读模式")) {
      const pick = await ctx.ui.select("只读模式", ["是", "否"]);
      if (!pick) continue;
      next.ai_readonly = pick === "是";
    } else if (choice.startsWith("执行确认")) {
      const pick = await ctx.ui.select("执行确认", [
        CONFIRM_LABELS.never,
        CONFIRM_LABELS.write,
        CONFIRM_LABELS.always,
      ]);
      if (!pick) continue;
      const entry = (Object.entries(CONFIRM_LABELS) as [ConfirmPolicy, string][]).find(
        ([, label]) => label === pick,
      );
      if (entry) next.confirm_before_exec = entry[0];
    } else if (choice.startsWith("命令超时")) {
      const pick = await ctx.ui.select("命令超时（秒）", TIMEOUT_OPTIONS);
      if (!pick) continue;
      if (pick === "自定义输入") {
        const input = await ctx.ui.input("超时秒数", String(next.command_timeout));
        const num = Number(input);
        if (!Number.isFinite(num) || num <= 0) {
          ctx.ui.notify("请输入正整数", "error");
          continue;
        }
        next.command_timeout = Math.round(num);
      } else {
        next.command_timeout = Number(pick);
      }
    }
  }

  savePluginConfig(next);
  ctx.ui.notify(`设置已保存\n${configSummary(next)}`, "success");
}

export async function showSettings(ctx: ExtensionContext) {
  ctx.ui.notify(configSummary(loadPluginConfig()), "info");
  await editSettings(ctx);
}

export async function resetSettings(ctx: ExtensionContext) {
  const ok = await ctx.ui.confirm("恢复默认", "确定把所有设置恢复为默认值？");
  if (!ok) return;
  savePluginConfig({ ...DEFAULT_PLUGIN_CONFIG });
  ctx.ui.notify(`已恢复默认设置\n${configSummary(DEFAULT_PLUGIN_CONFIG)}`, "success");
}

// ── 命令入口 ──────────────────────────────────────

export async function handleSshCommand(args: string, ctx: ExtensionContext) {
  const sub = (args ?? "").trim().toLowerCase();

  if (!sub) {
    const choice = await ctx.ui.select("SSH 服务器管理", [
      MENU_ENABLE,
      MENU_EDIT,
      MENU_VIEW,
      MENU_DELETE,
      MENU_SETTINGS,
    ]);
    if (!choice) return;

    if (choice === MENU_ENABLE) await enableMenu(ctx);
    else if (choice === MENU_EDIT) await pickAndEdit(ctx);
    else if (choice === MENU_VIEW) viewConfigs(ctx);
    else if (choice === MENU_DELETE) await deleteConfig(ctx);
    else if (choice === MENU_SETTINGS) await showSettings(ctx);
    return;
  }

  if (sub === "enable" || sub === "en") {
    await enableMenu(ctx);
  } else if (sub === "edit" || sub === "e") {
    await pickAndEdit(ctx);
  } else if (sub === "add" || sub === "new" || sub === "a") {
    await addConfig(ctx);
  } else if (sub === "view" || sub === "ls" || sub === "list" || sub === "show" || sub === "v") {
    viewConfigs(ctx);
  } else if (sub === "del" || sub === "delete" || sub === "d") {
    await deleteConfig(ctx);
  } else if (sub === "config" || sub === "settings" || sub === "c") {
    await showSettings(ctx);
  } else if (sub === "reset") {
    await resetSettings(ctx);
  } else {
    ctx.ui.notify(
      [
        "用法: /ssh [enable|edit|add|view|del|config|reset]",
        "  enable 启用或停用连接",
        "  edit   编辑已有连接或新增连接",
        "  add    直接新增连接",
        "  view   查看所有连接",
        "  del    删除连接",
        "  config 查看与修改设置",
        "  reset  恢复默认设置",
        "  默认   打开管理菜单",
        `配置文件: ${configFilePath()}`,
      ].join("\n"),
      "info",
    );
  }
}
