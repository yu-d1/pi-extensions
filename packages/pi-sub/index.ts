/**
 * pi-sub —— 独立子进程调度插件
 *
 * 理念：
 *  - 主对话是父进程。每个子进程 = 一个独立 pi 子进程（`pi --mode json -p`），
 *    拥有独立的模型、系统提示词、工具与上下文；主进程只回收子进程返回的文本。
 *    子进程不参与、不污染、不拦截主对话的任何流程。
 *  - 包内提供 file-scout、review、research、vision 四个内置子进程；用户新增子进程
 *    保存为 ~/.pi/agent/extensions/pi-sub/agents/<name>.md，由当前主模型生成配置。
 *  - 主进程模型在对话中主动调用工具 sub 唤醒子进程，把任务（及图片路径）写进 task。
 *  - 认证：子进程是完整 pi 实例，自动读取 auth.json，不需要手动传递 API key。
 *
 * 命令：
 *  /sub                    打开子进程管理菜单（配置 / 让主模型新增 / 删除）
 *  /sub <agent> [任务]     直接运行子进程（快捷方式）
 *  /sub list               查看子进程清单
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── 常量 ───────────────────────────────────────────────
const EXT_DIR = __dirname;
const BUILTIN_AGENTS_DIR = path.join(EXT_DIR, "agents");
const USER_EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-sub");
const USER_AGENTS_DIR = path.join(USER_EXTENSION_DIR, "agents");
const THINKING_VALUES: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_CHOICES = new Set(["off", ...THINKING_VALUES]);
const REPLY_TYPE = "pi-sub-reply";
const AGENT_NAME_RE = /^[^\s()（）<>:"\/\\|?*]{1,30}$/;
/** `tools: plan` 权限：不传 --tools（全部工具自动启用，新工具无需改配置），仅排除破坏性/交互类工具 */
const PLAN_TOOL_EXCLUDES = ["edit", "write", "ask_user_question", "todo", "sub"];
const PLAN_MODE_PROMPT_ADDON = `
[Plan 权限 - 只读子进程]

你拥有全部工具（内置 + 扩展）的只读权限：read、grep、find、ls、bash（仅只读命令）以及全部扩展只读工具（数据库查询、SSH 等）。

禁止行为：
- 禁止修改、创建、删除或移动任何文件（write、edit 已禁用；bash 中同样禁止 rm、mv、cp 覆盖、重定向 > 写文件、sed -i 等写操作）
- 禁止调用交互类工具（ask_user_question、todo 已禁用）
- 禁止调用 sub 再启动子进程（已禁用）

允许所有只读操作：ls、cat、find、grep、git log/diff/status、数据库 SELECT、SSH 只读命令等。
`.trim();

const USER_AGENTS_DIR_DISPLAY = USER_AGENTS_DIR.replace(/\\/g, "/");

/** pi-sub 自身配置（~/.pi/agent/extensions/pi-sub/config.json） */
const PI_SUB_CONFIG_FILE = path.join(USER_EXTENSION_DIR, "config.json");
/** 实时输出固定显示行数（滚动窗口，显示最新 N 行） */
const DEFAULT_PROGRESS_LINES = 5;
/** 可配置显示行数上限 */
const MAX_PROGRESS_LINES = 10;

interface PiSubConfig {
	/** 子进程实时输出固定显示行数（最新 N 行滚动窗口） */
	progressLines: number;
}

function loadPiSubConfig(): PiSubConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(PI_SUB_CONFIG_FILE, "utf8")) as Partial<PiSubConfig>;
		const n = Number(raw.progressLines);
		if (Number.isInteger(n) && n >= 1 && n <= MAX_PROGRESS_LINES) return { progressLines: n };
	} catch {
		// 配置缺失或损坏时回退默认值
	}
	return { progressLines: DEFAULT_PROGRESS_LINES };
}

function savePiSubConfig(config: PiSubConfig): void {
	fs.mkdirSync(USER_EXTENSION_DIR, { recursive: true });
	fs.writeFileSync(PI_SUB_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// ─── Agent 定义与解析 ──────────────────────────────────
type AgentSource = "builtin" | "user";

interface AgentDef {
	name: string;
	aliases?: string[];
	description?: string;
	prompt?: string;
	model?: string;
	thinking?: string;
	tools?: string;
	maxTokens?: number;
	inheritProjectContext?: boolean;
	body: string; // 正文（充当系统提示词）
	filePath: string;
	source: AgentSource;
}

/** 简单 frontmatter 解析：`---` 包裹的 YAML 子集（key: value），支持引号与 # 注释 */
function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const trimmed = text.replace(/^\uFEFF/, "");
	if (!trimmed.startsWith("---")) return { frontmatter, body: text };
	const end = trimmed.indexOf("\n---", 3);
	if (end === -1) return { frontmatter, body: text };
	const block = trimmed.slice(3, end);
	const body = trimmed.slice(end + 4).replace(/^\n+/, "");
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf(":");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (value === "") continue;
		frontmatter[key] = value;
	}
	return { frontmatter, body };
}

function toBool(v: string | undefined): boolean | undefined {
	if (v === undefined) return undefined;
	return v === "true" || v === "1" || v === "yes";
}

/** 解析 aliases：支持逗号/空白分隔，或 YAML 数组写法 ["a", "b"] */
function parseAliases(v: string | undefined): string[] | undefined {
	if (!v) return undefined;
	const s = v.trim().replace(/^\[|\]$/g, "");
	const list = s
		.split(/[,，\s]+/)
		.map((x) => x.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

function loadAgentFile(filePath: string, source: AgentSource): AgentDef | null {
	try {
		const text = fs.readFileSync(filePath, "utf8");
		const { frontmatter, body } = parseFrontmatter(text);
		const name = (frontmatter.name ?? path.basename(filePath, ".md")).trim();
		if (!AGENT_NAME_RE.test(name)) return null;
		const maxTokens = frontmatter.maxTokens ? Number(frontmatter.maxTokens) : undefined;
		return {
			name,
			aliases: parseAliases(frontmatter.aliases),
			description: frontmatter.description,
			prompt: frontmatter.prompt,
			model: frontmatter.model || undefined,
			thinking: frontmatter.thinking || undefined,
			tools: frontmatter.tools,
			maxTokens: maxTokens && Number.isFinite(maxTokens) ? maxTokens : undefined,
			inheritProjectContext: toBool(frontmatter.inheritProjectContext),
			body: body || "(空)",
			filePath,
			source,
		};
	} catch {
		return null;
	}
}

function loadAgentsFrom(dir: string, source: AgentSource): AgentDef[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.map((file) => loadAgentFile(path.join(dir, file), source))
		.filter((agent): agent is AgentDef => agent !== null);
}

function loadAgents(): AgentDef[] {
	const agents = new Map<string, AgentDef>();
	for (const agent of loadAgentsFrom(BUILTIN_AGENTS_DIR, "builtin")) agents.set(agent.name, agent);
	for (const agent of loadAgentsFrom(USER_AGENTS_DIR, "user")) agents.set(agent.name, agent);
	return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function findAgent(name: string): AgentDef | undefined {
	const n = name.trim();
	return loadAgents().find((a) => a.name === n || (a.aliases ?? []).includes(n));
}

const AGENT_LABEL_MAX_WIDTH = 72;

function agentChoiceLabel(a: AgentDef): string {
	const model = a.model || "继承当前";
	const thinking = a.thinking || "默认";
	return truncateToWidth(`${a.name}（模型=${model}，思考=${thinking}）`, AGENT_LABEL_MAX_WIDTH, "…");
}

function choiceAgentName(label: string): string {
	return label.split("（")[0].trim();
}

const AGENT_CATALOG_ITEM_MAX_WIDTH = 180;
const AGENT_CATALOG_MAX_WIDTH = 1600;

function compactAgentText(value: string | undefined, fallback: string): string {
	const text = (value || fallback).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
	return truncateToWidth(text || fallback, AGENT_CATALOG_ITEM_MAX_WIDTH, "…");
}

function buildAgentCatalog(agents: AgentDef[] = loadAgents()): string {
	if (agents.length === 0) return "（暂无已配置的子进程）";
	const catalog = agents
		.map((agent) => {
			const aliases = agent.aliases?.length ? `（别名：${agent.aliases.join("、")}）` : "";
			const description = compactAgentText(agent.description, "未填写用途说明");
			return `- ${agent.name}${aliases}：${description}`;
		})
		.join("\n");
	return truncateToWidth(catalog, AGENT_CATALOG_MAX_WIDTH, "…");
}

function buildAgentParameterDescription(agents: AgentDef[]): string {
	const names = [...new Set(agents.flatMap((agent) => [agent.name, ...(agent.aliases ?? [])]))];
	const choices = names.length > 0 ? truncateToWidth(names.join("、"), 900, "…") : "（暂无）";
	return `子进程名称或别名。当前可用：${choices}`;
}

function buildSubToolDescription(agents: AgentDef[]): string {
	return [
		"唤醒一个独立的 pi 子进程执行任务并返回结果文本（子进程有独立模型、系统提示词、工具与上下文，不污染当前对话）。",
		"当前可用子进程：",
		buildAgentCatalog(agents),
		"每个 agent 的调用提示由其配置文件中的 prompt 字段自动注册。",
		"如需新增子进程，不要修改 index.ts；请根据用户需求生成完整配置，并使用 write 工具写入用户配置目录：",
		USER_AGENTS_DIR_DISPLAY,
		"文件应包含 name、aliases、description、prompt、model、thinking、tools、maxTokens、inheritProjectContext 等 frontmatter 字段，以及子进程系统提示词正文。写入后请提示用户执行 /reload。",
		"task 为任务说明；images 可显式传入图片 base64，插件会保存为临时文件并把路径追加到 task；context 可给子进程附加一段上下文；model 可临时覆盖子进程模型。",
	].join("\n");
}

function buildSubPromptGuidelines(agents: AgentDef[]): string[] {
	return [
		`当用户要求新增或设计子进程时，由当前主模型根据需求生成完整配置，并使用 write 写入 ${USER_AGENTS_DIR_DISPLAY}/<name>.md；不要让用户逐项填写，也不要修改 index.ts。写入后提示用户执行 /reload。`,
		...agents.map((agent) => agent.prompt?.trim()).filter((prompt): prompt is string => Boolean(prompt)),
	];
}

// ─── 模型与思考解析 ─────────────────────────────────────
/** 拆出 `provider/modelId` 及可选 `:level` 后缀 */
function splitModelSpec(spec: string): { base: string; level?: string } {
	const m = spec.trim().match(/^(.*):(minimal|low|medium|high|xhigh|max|off)$/i);
	if (m) return { base: m[1], level: m[2].toLowerCase() };
	return { base: spec.trim() };
}

/** 解析子进程模型 spec：显式 model > 继承当前会话模型。返回 "provider/modelId" */
function resolveModelSpec(ctx: ExtensionContext, spec?: string, overrideSpec?: string): string {
	const raw = overrideSpec || spec;
	if (raw) return splitModelSpec(raw).base;
	if (ctx.model) return `${ctx.model.provider}/${ctx.model.id}`;
	throw new Error("未配置子进程模型且当前会话没有活动模型（可在 /sub 菜单配置，或指定 model 参数）");
}

/** 解析思考等级：agent.thinking > 模型 spec 的 :level 后缀 > 不指定 */
function resolveThinkingLevel(agent: AgentDef, spec?: string, overrideSpec?: string): string | undefined {
	if (agent.thinking && THINKING_CHOICES.has(agent.thinking)) return agent.thinking;
	const raw = overrideSpec || spec;
	if (raw) return splitModelSpec(raw).level;
	return undefined;
}

// ─── 图片落盘（显式 images 参数 → 临时文件，供子进程用 read 读取）──
function sniffMime(b64: string): string {
	const s = b64.replace(/^data:[^;]+;base64,/, "");
	let buf: Buffer;
	try {
		buf = Buffer.from(s, "base64");
	} catch {
		return "image/png";
	}
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if ((buf.length >= 6 && buf.toString("ascii", 0, 6) === "GIF87a") || (buf.length >= 6 && buf.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
	if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return "image/png";
}

function mimeToExt(mime: string): string {
	if (mime.includes("jpeg")) return "jpg";
	if (mime.includes("gif")) return "gif";
	if (mime.includes("webp")) return "webp";
	if (mime.includes("bmp")) return "bmp";
	return "png";
}

/** 把显式传入的图片 base64 落盘为临时文件，返回 { 文件路径列表, 临时目录 } */
function saveImagesToTemp(images: string[] | undefined): { paths: string[]; dir?: string } {
	if (!images || images.length === 0) return { paths: [] };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-img-"));
	const paths: string[] = [];
	images.forEach((b64, i) => {
		try {
			const data = b64.replace(/^data:[^;]+;base64,/, "");
			const ext = mimeToExt(sniffMime(data));
			const file = path.join(dir, `image-${i + 1}.${ext}`);
			fs.writeFileSync(file, Buffer.from(data, "base64"));
			paths.push(file);
		} catch {
			// 单张失败跳过
		}
	});
	return { paths, dir };
}

/** 递归删除临时目录（忽略错误） */
function cleanupTempDir(dir: string | undefined): void {
	if (!dir) return;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// 忽略
	}
}

// ─── 子进程运行（spawn 独立 pi CLI，--mode json 回收结果）──────
interface RunOptions {
	task: string;
	images?: string[]; // 显式传入的图片 base64（落盘后交给子进程 read）
	context?: string;
	modelOverride?: string;
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}

interface RunResult {
	text: string;
	modelUsed: string;
	exitCode: number;
	usage?: { input?: number; output?: number };
}

/** 解析 pi 入口：env 覆盖 > 当前进程入口（真实 pi 进程内即 pi CLI）> PATH 上的 pi */
function resolvePiCommand(): { command: string; argsPrefix: string[] } {
	const envBinary = process.env.PI_SUB_PI_BINARY?.trim();
	if (envBinary) return { command: envBinary, argsPrefix: [] };
	const entry = process.argv[1];
	if (entry && /\.(mjs|cjs|js)$/i.test(entry) && fs.existsSync(entry)) {
		return { command: process.execPath, argsPrefix: [entry] };
	}
	return { command: "pi", argsPrefix: [] };
}

function runPiCli(
	args: string[],
	opts: {
		cwd?: string;
		signal?: AbortSignal;
		onEvent?: (event: any) => boolean | void;
	},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const { command, argsPrefix } = resolvePiCommand();
	const fullArgs = [...argsPrefix, ...args];
	return new Promise((resolve, reject) => {
		let proc;
		let settled = false;
		let onAbort: (() => void) | undefined;
		let stdout = "";
		let stderr = "";
		let stdoutRemainder = "";
		const removeAbortListener = () => {
			if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
		};
		const terminate = () => {
			try {
				proc?.kill();
			} catch {
				// 已退出
			}
			if (process.platform === "win32" && proc?.pid) {
				try {
					spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
				} catch {
					// 强制终止失败时仍使用 proc.kill 的结果
				}
			}
		};
		const settle = (exitCode: number) => {
			if (settled) return;
			settled = true;
			removeAbortListener();
			resolve({ exitCode, stdout, stderr });
		};
		try {
			proc = spawn(command, fullArgs, {
				cwd: opts.cwd,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				...(process.platform === "win32" && command === "pi" ? { shell: true } : {}),
			});
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const handleStdoutLine = (line: string) => {
			if (!line.trim() || settled) return;
			try {
				const shouldStop = opts.onEvent?.(JSON.parse(line));
				if (shouldStop) {
					settle(0);
					terminate();
				}
			} catch {
				// JSON 模式下只把可解析的 JSONL 事件用于实时进度；原始内容仍保留在 stdout 中。
			}
		};
		const handleStdout = (chunk: string, flush = false) => {
			stdoutRemainder += chunk;
			let newline = stdoutRemainder.indexOf("\n");
			while (newline !== -1) {
				const line = stdoutRemainder.slice(0, newline).replace(/\r$/, "");
				stdoutRemainder = stdoutRemainder.slice(newline + 1);
				handleStdoutLine(line);
				newline = stdoutRemainder.indexOf("\n");
			}
			if (flush && stdoutRemainder) {
				handleStdoutLine(stdoutRemainder.replace(/\r$/, ""));
				stdoutRemainder = "";
			}
		};
		proc.stdout.on("data", (d: Buffer) => {
			const chunk = d.toString("utf8");
			stdout += chunk;
			handleStdout(chunk);
		});
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
		proc.on("error", (error) => {
			if (settled) return;
			removeAbortListener();
			reject(new Error(`无法启动子进程：${error.message}`));
		});
		onAbort = () => {
			terminate();
			settle(-1);
		};
		if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
		proc.on("close", (code) => {
			if (settled) return;
			handleStdout("", true);
			settle(code ?? -1);
		});
	});
}

function extractEventText(value: any): string {
	if (typeof value === "string") return value.trim();
	if (!value) return "";
	if (Array.isArray(value)) {
		return value
			.filter((item) => item?.type === "text" && typeof item.text === "string")
			.map((item) => item.text)
			.join("\n")
			.trim();
	}
	if (Array.isArray(value.content)) return extractEventText(value.content);
	return "";
}

/** 固定显示最新 N 行（滚动窗口）；不足 N 行时用空格占位保持高度稳定 */
function lastProgressLines(text: string, fallback = "等待子进程输出…", lines = DEFAULT_PROGRESS_LINES): string {
	const count = Math.min(Math.max(Math.trunc(lines) || DEFAULT_PROGRESS_LINES, 1), MAX_PROGRESS_LINES);
	const visible = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-count);
	if (visible.length === 0) visible.push(fallback);
	while (visible.length < count) visible.unshift(" ");
	return visible.map((line) => truncateToWidth(line, 140, "…")).join("\n");
}

function createProgressReporter(callback?: (text: string) => void): {
	report: (text: string, immediate?: boolean) => void;
	finish: () => void;
} {
	// 无节流：事件到达即透传，让子进程输出节奏决定刷新频率（流式追加效果）
	const report = (text: string, _immediate = false) => {
		if (!callback || !text) return;
		try {
			callback(text);
		} catch {
			// 进度展示失败不应影响子进程执行。
		}
	};
	return {
		report,
		finish: () => {
			// 无节流缓冲，无需清理
		},
	};
}

/** 判定：assistant 的最终纯文本 message_end（不含工具调用块），作为子进程回答完成的信号 */
function isFinalAssistantMessageEnd(event: any): boolean {
	if (event?.type !== "message_end" || event?.message?.role !== "assistant") return false;
	const content = event.message?.content;
	if (!Array.isArray(content)) return true;
	return !content.some((c: any) => c?.type === "toolCall");
}

interface LiveOutputState {
	text: string;
	 /** 固定显示行数（来自 pi-sub 配置） */
	lines: number;
}

/** @returns 累积真响应文本的最新 N 行（滚动窗口，无合成状态文案）；无增量时返回 undefined */
function realtimeSubOutput(event: any, state: LiveOutputState): string | undefined {
	const appendText = (text: string) => {
		if (!text) return;
		// message_end 全文与已流式的 text_delta 重叠时去重，避免窗口内容重复
		if (state.text.endsWith(text)) return;
		state.text = state.text.length > 8000 ? state.text.slice(-8000) : state.text;
		state.text += text;
	};
	const show = (text: string) => lastProgressLines(text, "等待子进程输出…", state.lines);
	switch (event?.type) {
		case "message_update": {
			const me = event.assistantMessageEvent;
			if (me?.type === "text_delta" && typeof me.delta === "string" && me.delta) {
				appendText(me.delta);
				return show(state.text);
			}
			return undefined;
		}
		// 中间 toolCall message_end 无文本，不判停
		case "message_end": {
			if (event.message?.role !== "assistant") return undefined;
			const text = extractEventText(event.message?.content);
			if (!text) return undefined;
			appendText(text);
			return show(state.text);
		}
		case "tool_execution_update": {
			const text = extractEventText(event.partialResult);
			if (text) {
				appendText(text);
				return show(state.text);
			}
			return undefined;
		}
		case "tool_execution_end": {
			const text = extractEventText(event.result);
			if (text) {
				appendText(text);
				return show(state.text);
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

/** 解析 `pi --mode json` 输出，取最后一条 assistant message_end 的文本 */
function parseSubOutput(stdout: string): { text: string; model?: string; usage?: { input?: number; output?: number }; errorMessage?: string } {
	let text = "";
	let model: string | undefined;
	let usage: { input?: number; output?: number } | undefined;
	let errorMessage: string | undefined;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const m = ev.message;
			const t = (m.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n")
				.trim();
			if (t) text = t;
			if (m.model) model = m.model;
			if (m.usage) usage = { input: m.usage.input, output: m.usage.output };
			if (m.errorMessage) errorMessage = m.errorMessage;
		}
	}
	return { text, model, usage, errorMessage };
}

async function runSub(ctx: ExtensionContext, agent: AgentDef, opts: RunOptions): Promise<RunResult> {
	// 1. 模型与思考等级
	const modelSpec = resolveModelSpec(ctx, agent.model, opts.modelOverride);
	const thinking = resolveThinkingLevel(agent, agent.model, opts.modelOverride);

	// 2. 系统提示词（写临时文件，避免 argv 过长）
	const toolList = agent.tools?.split(/[,，\s]+/).filter(Boolean) ?? [];
	const planMode = toolList.includes("plan");
	const sysParts: string[] = [agent.body];
	if (planMode) sysParts.push(PLAN_MODE_PROMPT_ADDON);
	if (agent.inheritProjectContext) sysParts.push(`当前工作目录：${ctx.cwd}`);
	if (opts.context && opts.context.trim()) sysParts.push(`<附加上下文>\n${opts.context.trim()}\n</附加上下文>`);
	const sys = sysParts.join("\n\n").trim();

	// 3. task 组装：显式 images 落盘后把路径追加进 task，子进程用 read 工具读取
	let task = opts.task;
	const savedImages = saveImagesToTemp(opts.images);
	if (savedImages.paths.length > 0) {
		task += `\n\n以下 ${savedImages.paths.length} 张图片已保存到本地文件，请用 read 工具逐一读取并理解：\n${savedImages.paths.map((p) => `- ${p}`).join("\n")}`;
	}

	// 4. 构造子进程命令
	const args = ["--mode", "json", "-p", "--model", modelSpec, "--no-session", "--no-context-files", "--no-skills"];
	if (thinking) args.push("--thinking", thinking);
	if (planMode) {
		// Plan 权限：不传 --tools（全部工具自动启用，后续新增工具无需改配置），仅排除破坏性/交互类工具
		args.push("--exclude-tools", PLAN_TOOL_EXCLUDES.join(","));
	} else if (toolList.length > 0) {
		args.push("--tools", toolList.join(","));
	}
	let promptFile: string | undefined;
	let promptDir: string | undefined;
	if (sys) {
		promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-"));
		promptFile = path.join(promptDir, "system-prompt.md");
		fs.writeFileSync(promptFile, sys, "utf8");
		args.push("--system-prompt", promptFile);
	}
	args.push(`Task: ${task}`);

	// 5. 运行并回收：固定显示最新 N 行（滚动窗口），不做合成状态文案；
	//    最终 assistant message_end 到达即返回 true，立即结束子进程，避免收尾卡顿。
	const progress = createProgressReporter(opts.onProgress);
	const liveOutput: LiveOutputState = { text: "", lines: loadPiSubConfig().progressLines };
	const { exitCode, stdout, stderr } = await runPiCli(args, {
		cwd: ctx.cwd,
		signal: opts.signal,
		onEvent: (event) => {
			const text = realtimeSubOutput(event, liveOutput);
			if (text) progress.report(text);
			return isFinalAssistantMessageEnd(event);
		},
	});
	progress.finish();
	const parsed = parseSubOutput(stdout);
	// 清理临时文件
	cleanupTempDir(savedImages.dir);
	cleanupTempDir(promptDir);
	if (!parsed.text) {
		const detail = parsed.errorMessage || stderr.trim() || "(无输出)";
		throw new Error(`子进程执行失败（退出码 ${exitCode}）：${detail.slice(0, 500)}`);
	}
	return {
		text: parsed.text,
		modelUsed: parsed.model ?? modelSpec,
		exitCode,
		usage: parsed.usage,
	};
}

// ─── Agent 文件写入（仅写入用户配置目录）────────────────
function serializeAgentFile(agent: AgentDef, currentText: string): string {
	const { frontmatter } = parseFrontmatter(currentText);
	const ordered: Array<[keyof AgentDef, string]> = [
		["name", "name"],
		["aliases", "aliases"],
		["description", "description"],
		["prompt", "prompt"],
		["model", "model"],
		["thinking", "thinking"],
		["tools", "tools"],
		["maxTokens", "maxTokens"],
		["inheritProjectContext", "inheritProjectContext"],
	];
	const lines = ["---"];
	// 以更新后的 agent 对象为准；空值字段不写出（可手动再补）
	for (const [field, key] of ordered) {
		const v = agent[field];
		if (v === undefined || v === "") continue;
		lines.push(`${key}: ${quoteYaml(String(v))}`);
	}
	// 保留原文件里的未知自定义字段
	for (const [k, v] of Object.entries(frontmatter)) {
		if (!ordered.some(([, key]) => key === k)) lines.push(`${k}: ${quoteYaml(v)}`);
	}
	lines.push("---", "");
	return `${lines.join("\n")}${agent.body}`;
}

function quoteYaml(v: string): string {
	if (v === "") return "";
	// 冒号后接空格 / 行首特殊字符 / 含 # 时加引号
	if (/[:#]/.test(v) || /^[\s\-*?[\]{}&!|>'"%`@]/.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
	return v;
}

function writableAgentFile(agent: AgentDef): string | undefined {
	if (agent.source === "user") return agent.filePath;
	if (!fs.existsSync(agent.filePath)) return undefined;
	fs.mkdirSync(USER_AGENTS_DIR, { recursive: true });
	const userPath = path.join(USER_AGENTS_DIR, `${agent.name}.md`);
	if (!fs.existsSync(userPath)) fs.copyFileSync(agent.filePath, userPath);
	return userPath;
}

function updateAgentField(agent: AgentDef, key: string, value: string): boolean {
	const filePath = writableAgentFile(agent);
	if (!filePath) return false;
	const text = fs.readFileSync(filePath, "utf8");
	const current = loadAgentFile(filePath, "user");
	const merged: AgentDef = current ?? { ...agent, filePath, source: "user" };
	if (key === "model") merged.model = value || undefined;
	else if (key === "thinking") merged.thinking = value || undefined;
	else if (key === "description") merged.description = value || undefined;
	else if (key === "maxTokens") merged.maxTokens = Number(value) || undefined;
	fs.writeFileSync(filePath, serializeAgentFile(merged, text), "utf8");
	const updated = loadAgentFile(filePath, "user");
	if (updated) Object.assign(agent, updated);
	return Boolean(updated);
}

// ─── 工具：sub（模型主动调用入口）──────────────────────
function registerSubTool(pi: ExtensionAPI): void {
	const agents = loadAgents();
	pi.registerTool({
		name: "sub",
		label: "sub 子进程",
		description: buildSubToolDescription(agents),
		promptSnippet: "sub(agent, task, context?, model?)",
		promptGuidelines: buildSubPromptGuidelines(agents),
		parameters: Type.Object({
			agent: Type.String({ description: buildAgentParameterDescription(agents) }),
			task: Type.String({ description: "交给子进程的具体任务说明" }),
			images: Type.Optional(Type.Array(Type.String({ description: "显式传入的图片 base64 数据（可选；也可以把图片文件路径写进 task 让子进程读取）" }))),
			context: Type.Optional(Type.String({ description: "附加给子进程的上下文文本（可选）" })),
			model: Type.Optional(Type.String({ description: "临时覆盖子进程模型，如 openai/gpt-4o 或 provider/modelId:high" })),
		}),
		// 工具标题显示子进程名（而非固定 "sub"）
		renderCall: (args: any, theme: any) =>
			new Text(theme.fg("toolTitle", theme.bold(String(args?.agent ?? "sub"))), 0, 0),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const { agent, task, images, context, model: modelOverride } = params;
			const def = findAgent(agent);
			if (!def) {
				return {
					content: [{ type: "text", text: `未知子进程：${agent}。可用 agent：${loadAgents().map((a) => a.name + (a.aliases?.length ? `（${a.aliases.join("/")}）` : "")).join(", ") || "（无）"}` }],
					details: { agent, error: "unknown agent" },
				};
			}
			try {
				const result = await runSub(ctx, def, {
					task,
					images,
					context,
					modelOverride,
					signal: signal ?? undefined,
					onProgress: (text) => {
						onUpdate?.({
							content: [{ type: "text", text }],
							details: { status: "running", progress: text },
						});
					},
				});
				return {
					content: [{ type: "text", text: `【子进程 ${agent} 返回 · ${result.modelUsed}】\n${result.text}` }],
					details: { agent, model: result.modelUsed, usage: result.usage, exitCode: result.exitCode },
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `【子进程 ${agent} 执行失败】${msg}` }],
					details: { agent, error: msg },
				};
			}
		},
	});
}

// ─── 消息渲染（确保结果在 TUI 中可靠显示）──────────────
function registerReplyRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(REPLY_TYPE, (message) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
		return new Text(content || "(空)", 0, 0);
	});
}

// ─── 运行与展示 ────────────────────────────────────────
async function runSubAndReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, def: AgentDef, task: string): Promise<void> {
	ctx.ui.notify(`运行子进程「${def.name}」…${def.model ? `（模型：${def.model}）` : "（继承当前模型）"}`, "info");
	try {
		const result = await runSub(ctx, def, {
			task,
			signal: ctx.signal ?? undefined,
		});
		pi.sendMessage({
			customType: REPLY_TYPE,
			content: `【子进程 ${def.name} 返回 · ${result.modelUsed}】\n\n${result.text}`,
			display: true,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`子进程「${def.name}」失败：${msg}`, "error");
	}
}

function listAgentsText(): string {
	const agents = loadAgents();
	const lines = ["## 子进程清单", "| 名称 | 模型 | 思考 | 工具 | 说明 |", "|---|---|---|---|---|"];
	for (const a of agents) {
		const model = a.model || "继承当前";
		const think = a.thinking || "默认";
		lines.push(`| ${a.name} | ${model} | ${think} | ${a.tools || "默认"} | ${a.description || ""} |`);
	}
	if (agents.length === 0) lines.push("（暂无子进程，可在 /sub 菜单中新增）");
	lines.push(
		"",
		`用户配置目录：${USER_AGENTS_DIR_DISPLAY}`,
		"新增子进程：通过 /sub 菜单把需求交给当前主模型，由主模型生成并写入配置；写入后执行 /reload",
		`实时输出：固定显示最新 ${loadPiSubConfig().progressLines} 行（/sub 菜单「通用设置」可调整）`,
	);
	return lines.join("\n");
}

// ─── 菜单流程 ──────────────────────────────────────────
async function openMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/sub 菜单需要 TUI 交互；可直接使用 /sub <agent> [任务] 或 /sub list", "warning");
		return;
	}
	const choice = await ctx.ui.select("sub 子进程", [
		"配置子进程（模型/思考等级）",
		"新增子进程",
		"通用设置",
		"删除子进程",
	]);
	if (!choice) return; // 取消退出
	if (choice.startsWith("配置子进程")) await flowConfig(ctx);
	else if (choice.startsWith("新增子进程")) await flowAdd(pi, ctx);
	else if (choice.startsWith("通用设置")) await flowGeneralSettings(ctx);
	else if (choice.startsWith("删除子进程")) await flowDelete(ctx);
}

/** 通用设置：设置项列表（当前：实时输出显示行数），循环返回列表直到完成 */
async function flowGeneralSettings(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const cur = `实时输出显示行数：${loadPiSubConfig().progressLines} 行`;
		const item = await ctx.ui.select(`通用设置（${cur}）`, [
			"实时输出显示行数",
			"完成",
		]);
		if (!item || item.startsWith("完成")) return; // 取消或完成退出
		if (item.startsWith("实时输出显示行数")) {
			const current = loadPiSubConfig().progressLines;
			const options = Array.from({ length: MAX_PROGRESS_LINES }, (_, i) => String(i + 1));
			const value = await ctx.ui.select(`实时输出显示行数（当前：${current}）`, options);
			if (!value) return;
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1 || n > MAX_PROGRESS_LINES) return;
			savePiSubConfig({ progressLines: n });
			ctx.ui.notify(`已设置实时输出显示行数为 ${n} 行；下次运行子进程即生效`, "info");
			continue; // 返回设置项列表
		}
	}
}

async function pickAgent(ctx: ExtensionCommandContext, title: string): Promise<AgentDef | undefined> {
	const agents = loadAgents();
	if (agents.length === 0) {
		ctx.ui.notify("还没有子进程，请在 /sub 菜单中「新增子进程」", "warning");
		return undefined;
	}
	const label = await ctx.ui.select(title, agents.map(agentChoiceLabel));
	if (!label) return undefined;
	return findAgent(choiceAgentName(label));
}

async function flowConfig(ctx: ExtensionCommandContext): Promise<void> {
	const def = await pickAgent(ctx, "选择要配置的子进程");
	if (!def) return;
	// 配置完一个字段后返回本页（可继续配置另一项），直到用户取消或选择「完成」
	for (;;) {
		const cur = `当前：模型=${def.model || "继承当前"}，思考=${def.thinking || "默认"}`;
		const field = await ctx.ui.select(`配置「${def.name}」（${cur}）`, [
			"model（模型）",
			"thinking（思考等级）",
			"完成",
		]);
		if (!field || field.startsWith("完成")) return; // 取消或完成退出

		if (field.startsWith("model")) {
			const available = loadAvailableModels(ctx);
			const inherit = "继承当前会话模型（不指定）";
			const options = [inherit, ...available.map((m) => `${m.provider}/${m.id}`)];
			const value = await ctx.ui.select(`选择模型（当前：${def.model || "继承当前"}）`, options);
			if (!value) return;
			const final = value === inherit ? "" : value;
			if (!updateAgentField(def, "model", final)) {
				ctx.ui.notify(`无法保存 ${def.name} 的模型配置`, "error");
				return;
			}
			ctx.ui.notify(`已设置 ${def.name} 模型=${final || "继承当前会话模型"}`, "info");
			continue; // 返回字段选择页
		}

		const cur2 = def.thinking || "默认";
		const value = await ctx.ui.select(`思考等级（当前：${cur2}）`, ["off", ...THINKING_VALUES, "默认（不强制）"]);
		if (!value) return;
		const final = value === "默认（不强制）" ? "" : value;
		if (!updateAgentField(def, "thinking", final)) {
			ctx.ui.notify(`无法保存 ${def.name} 的 thinking 配置`, "error");
			return;
		}
		ctx.ui.notify(`已设置 ${def.name} thinking=${final || "默认"}`, "info");
		continue; // 返回字段选择页
	}
}

function buildAgentCreationPrompt(requirement: string, pi: ExtensionAPI, ctx: ExtensionContext): string {
	const existing = loadAgents()
		.map((agent) => `- ${agent.name}${agent.aliases?.length ? `（别名：${agent.aliases.join("、")}）` : ""}`)
		.join("\n") || "（暂无）";
	try {
		ctx.modelRegistry.refresh?.();
	} catch {
		// 使用当前已缓存的模型列表
	}
	const models = (ctx.modelRegistry.getAvailable() ?? [])
		.map((model) => `${model.provider}/${model.id}`)
		.filter((model, index, list) => list.indexOf(model) === index)
		.join("、") || "（未读取到模型列表；可省略 model）";
	const tools = pi.getActiveTools().join("、") || "（当前没有启用工具）";
	return [
		"请根据下面的用户需求，直接创建一个新的 pi-sub 子进程配置。",
		"",
		"<用户需求>",
		requirement.trim(),
		"</用户需求>",
		"",
		"请直接完成，不要只输出设计方案：",
		"1. 分析需求并自行设计完整的子进程方案，包括名称、别名、用途、触发规则、模型、思考等级、工具、输出格式和系统提示词。",
		"2. 先使用 ls 查看该目录，再按需使用 read 查看现有配置，避免名称、别名和职责重复。",
		"3. 不要调用 sub 创建配置，直接由当前主模型使用 write 工具创建一个新的 Markdown 配置文件；不要让用户逐项填写配置。",
		`4. 文件必须使用绝对路径写入这个目录：${USER_AGENTS_DIR_DISPLAY}`, 
		`5. 文件路径应为：${USER_AGENTS_DIR_DISPLAY}/<name>.md；name 必须是 1-30 个字符，不能含空格、括号或 Windows 文件名非法字符；不得覆盖已有文件。`,
		"6. 不要修改 pi-sub/index.ts、README.md、settings.json 或其他已有 agent 文件。",
		`7. 当前可选模型：${models}；model 只能从此列表选择，无法确定合适的固定模型时可以省略，让它继承当前会话模型。`,
		`8. 当前可用工具名：${tools}；tools 可写 plan（Plan 权限：全部只读工具自动可用，含以后新增的扩展工具，适合审查/调研类）或逗号分隔的白名单工具名（只启用列出的工具，适合单一职责），禁止凭空编造工具名。涉及数据库、SSH 或测试验证时遵守只读和非破坏性原则。`,
		"9. 写入成功后返回文件路径、子进程名称、职责、模型、工具和触发规则摘要，并明确提示用户执行 /reload。",
		"10. frontmatter 的每个值保持单行；值中包含冒号或 # 时使用双引号，避免破坏配置解析。",
		"11. 如果需求存在多种合理实现，选择最符合需求且最小权限的方案直接创建一个 agent，不要只返回多个草案。",
		"",
		"配置文件格式：",
		"---",
		"name: <名称>",
		"aliases: <逗号分隔的别名>",
		"description: <一句话用途>",
		"prompt: <什么时候应调用 sub，以及 agent 名称>",
		"model: <provider/modelId，可省略>",
		"thinking: <off|minimal|low|medium|high|xhigh|max，可省略>",
		"tools: <plan 或逗号分隔的工具名，可省略>；plan = 全部只读工具（排除 edit/write/交互类），新工具自动可用",
		"maxTokens: <正整数，可省略>",
		"inheritProjectContext: <true 或 false，可省略>",
		"---",
		"",
		"这里写子进程的系统提示词正文。正文必须明确它的职责、工作步骤、输出格式和禁止事项。",
		"",
		`当前已有子进程（不要重复创建）：\n${existing}`,
		"",
		"再次强调：这是创建操作，请使用 write 实际写入上述目录，不要只在回答中展示 Markdown 草稿。",
	].join("\n");
}

async function flowAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!pi.getActiveTools().includes("write")) {
		ctx.ui.notify("当前主模型未启用 write 工具，无法自动创建子进程配置；请先启用 write 工具。", "error");
		return;
	}
	const requirement = await ctx.ui.input("描述想要的子进程", "如：创建一个只读审查 SQL 和数据库结构的子进程");
	if (!requirement?.trim()) return;
	const prompt = buildAgentCreationPrompt(requirement, pi, ctx);
	try {
		pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: false });
		ctx.ui.notify("已将创建需求交给当前主模型；主模型会生成完整配置并写入 agents 目录，完成后请执行 /reload。", "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`无法将创建需求交给当前主模型：${message}`, "error");
	}
}

async function flowDelete(ctx: ExtensionCommandContext): Promise<void> {
	const def = await pickAgent(ctx, "选择要删除的子进程");
	if (!def) return;
	const ok = await ctx.ui.confirm(`确定删除子进程「${def.name}」吗？删除不可恢复`, true);
	if (!ok) return;
	if (def.source === "builtin") {
		ctx.ui.notify(`内置子进程 ${def.name} 不能删除；如需修改，请通过「配置子进程」创建用户副本`, "warning");
		return;
	}
	fs.unlinkSync(def.filePath);
	ctx.ui.notify(`已删除子进程 ${def.name}；请执行 /reload 使模型侧的 sub 工具描述同步`, "info");
}

/** 当前已可用模型（已配置好认证的模型，与 /model 列表一致） */
function loadAvailableModels(ctx: ExtensionContext): Model<any>[] {
	try {
		ctx.modelRegistry.refresh?.();
	} catch {
		// 忽略刷新失败，使用最后一次列表
	}
	const list = ctx.modelRegistry.getAvailable() ?? [];
	if (list.length === 0) ctx.ui.notify("当前没有可用模型，请先在 /model 中配置模型", "warning");
	return list;
}

// ─── 命令：/sub ────────────────────────────────────────
function registerSubCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sub", {
		description: "子进程：/sub 打开管理菜单（新增时由当前主模型生成配置）；/sub <agent> [任务] 直接运行；/sub list 查看清单",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "menu") {
				await openMenu(pi, ctx);
				return;
			}
			if (trimmed === "list" || trimmed === "ls") {
				pi.sendMessage({ customType: REPLY_TYPE, content: listAgentsText(), display: true });
				return;
			}
			const space = trimmed.search(/\s/);
			const name = space === -1 ? trimmed : trimmed.slice(0, space);
			const task = space === -1 ? "" : trimmed.slice(space + 1).trim();
			const def = findAgent(name);
			if (!def) {
				ctx.ui.notify(`未知子进程：${name}。可用：${loadAgents().map((a) => a.name).join(", ") || "（无）"}`, "error");
				return;
			}
			await runSubAndReport(pi, ctx, def, task || "请执行你的职责，输出结构化结论。");
		},
	});
}

// ─── 入口 ──────────────────────────────────────────────
export default function (pi: ExtensionAPI): void {
	registerReplyRenderer(pi);
	registerSubTool(pi);
	registerSubCommand(pi);
}
