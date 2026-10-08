import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/**
 * Command Code（GO 套餐）内置供应商。
 *
 * GO 套餐与 Provider 套餐的能力边界（实测）：
 *   GET  /provider/v1/models   → 200，模型目录可拉
 *   POST /provider/v1/*        → 403 upgrade_required（GO 套餐无 API 对话权限）
 *   POST /alpha/generate       → 200，唯一的对话通道
 *
 * 因此本模块自带传输层：把 pi 的 TranscriptContext 转成 Command Code CLI 的
 * 私有请求体，并解析它返回的 NDJSON 流（AI SDK 风格事件，非标准 SSE）。
 */

// ── 常量 ──────────────────────────────────────────────────────────────

export const CCGO_PROVIDER_ID = "commandcodego";
export const CCGO_LABEL = "Command Code (GO)";
export const CCGO_BASE_URL = "https://api.commandcode.ai";
/** 请求头里声明的 CLI 版本，服务端据此决定能力集。 */
const CLI_VERSION = "1.72.4";
const DEFAULT_MAX_COMPLETION_TOKENS = 64_000;
const REQUEST_TIMEOUT_MS = 600_000;

// ── 配置 ──────────────────────────────────────────────────────────────

export interface CommandCodeGoConfig {
	/** API 根地址，默认 https://api.commandcode.ai */
	baseUrl: string;
	/** 覆盖 max_tokens；不设则用模型自身的 maxTokens。 */
	maxCompletionTokens?: number;
	/** 传给 params.reasoning_effort；不设则不下发该字段。 */
	reasoningEffort?: string;
	temperature?: number;
}

export const DEFAULT_CCGO: CommandCodeGoConfig = { baseUrl: CCGO_BASE_URL };

export function asCommandCodeGoConfig(raw: unknown): CommandCodeGoConfig {
	const o = (raw ?? {}) as Record<string, unknown>;
	const num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
	const str = (v: unknown): string | undefined =>
		typeof v === "string" && v.trim() ? v.trim() : undefined;
	return {
		baseUrl: str(o.baseUrl) ?? CCGO_BASE_URL,
		maxCompletionTokens: num(o.maxCompletionTokens),
		reasoningEffort: str(o.reasoningEffort),
		temperature: typeof o.temperature === "number" ? (o.temperature as number) : undefined,
	};
}

// ── 模型目录 ──────────────────────────────────────────────────────────

export interface CommandCodeGoModel {
	id: string;
	name: string;
	contextWindow: number;
	input: ("text" | "image")[];
	/** 服务端声明该模型应答的 wire；GO 套餐实际只用 /alpha/generate。 */
	supportedEndpoints: string[];
}

/** GET /provider/v1/models —— GO 账号可访问（只有对话端点被墙）。 */
export async function fetchCommandCodeGoModels(
	apiKey: string | undefined,
	baseUrl = CCGO_BASE_URL,
	signal?: AbortSignal,
): Promise<CommandCodeGoModel[]> {
	if (!apiKey) return [];
	const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/provider/v1/models`, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal,
	});
	if (!res.ok) throw new Error(`拉取模型列表失败：HTTP ${res.status}`);
	const body: any = await res.json();
	const arr: any[] = Array.isArray(body) ? body : (body.data ?? body.models ?? []);
	return arr
		.map((m) => ({
			id: String(m.id ?? ""),
			name: String(m.name ?? m.id ?? ""),
			// 目录用 context_length；个别网关用 context_window / max_context_length
			contextWindow: Number(m.context_length ?? m.context_window ?? m.max_context_length) || 0,
			input: (Array.isArray(m.input) ? m.input : m.input_modalities) as ("text" | "image")[],
			supportedEndpoints: Array.isArray(m.supported_endpoints) ? m.supported_endpoints : [],
		}))
		.filter((m) => m.id.length > 0);
}

// ── 上游事件（NDJSON，每行一个 JSON）──────────────────────────────────

interface CcUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cachedInputTokens?: number;
	reasoningTokens?: number;
	inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number };
	outputTokenDetails?: { textTokens?: number; reasoningTokens?: number };
	raw?: Record<string, unknown>;
}

interface CcEvent {
	type: string;
	// 文本
	id?: string;
	text?: string;
	delta?: string;
	// 工具
	toolCallId?: string;
	toolName?: string;
	input?: unknown;
	// 收尾
	finishReason?: string;
	usage?: CcUsage;
	totalUsage?: CcUsage;
	[key: string]: unknown;
}

// ── 消息与工具转换 ────────────────────────────────────────────────────

function isImagePart(p: any): boolean {
	return p?.type === "image";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => (typeof b?.text === "string" ? b.text : ""))
		.join("\n");
}

function imagesOf(content: unknown): Record<string, string>[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter(isImagePart)
		.map((b: any) => {
			const src = b?.source ?? {};
			const url = typeof src.url === "string" ? src.url : typeof b?.image === "string" ? b.image : "";
			const mediaType = typeof src.mediaType === "string" ? src.mediaType : "image/png";
			return { type: "image", mediaType, data: url.startsWith("data:") ? url : url };
		})
		.filter((x) => x.data);
}

/**
 * pi Message[] → Command Code params.messages
 *
 * 上游只接受 user / assistant / tool 三种 role，且 assistant 的工具调用用
 * `{type:"tool-call"}`（连字符）、工具结果用 `{type:"tool-result"}` 且 output
 * 必须是 `{type,value}` 对象 —— 与 OpenAI 格式不同，务必按此拼装。
 */
export function messagesToCC(
	messages: readonly Message[] | undefined,
	options: { allowImages?: boolean } = {},
): unknown[] {
	const allowImages = options.allowImages ?? false;
	const out: unknown[] = [];
	const callIds = new Set<string>();
	const resultIds = new Set<string>();
	const raw = messages ?? [];

	for (const m of raw) {
		if (m.role === "toolResult") {
			const id = (m as any).toolCallId;
			if (id) resultIds.add(id);
		}
	}
	for (const m of raw) {
		if (m.role === "assistant") {
			for (const c of (m as any).content ?? []) {
				if (c?.type === "toolCall" && c.id) callIds.add(c.id);
			}
		}
	}

	for (let i = 0; i < raw.length; i++) {
		const msg = raw[i] as any;
		if (msg.role === "user" || msg.role === "developer") {
			// 上游不接受 developer，OMP 之类注入的 steering 消息降级为 user
			const text = textOf(msg.content);
			const images = allowImages ? imagesOf(msg.content) : [];
			if (!text && images.length === 0) continue;
			const content: unknown[] = [];
			if (text) content.push({ type: "text", text });
			content.push(...images);
			out.push({ role: "user", content: content.length === 1 && text ? text : content });
		} else if (msg.role === "assistant") {
			const parts: unknown[] = [];
			const missing: unknown[] = [];
			for (const c of msg.content ?? []) {
				if (c?.type === "text") {
					parts.push({ type: "text", text: typeof c.text === "string" ? c.text : "" });
				} else if (c?.type === "toolCall" && c.id) {
					parts.push({
						type: "tool-call",
						toolCallId: c.id,
						toolName: typeof c.name === "string" ? c.name : "",
						input: c.arguments ?? {},
					});
					if (!resultIds.has(c.id)) {
						missing.push({
							type: "tool-result",
							toolCallId: c.id,
							toolName: typeof c.name === "string" ? c.name : "",
							output: { type: "error-text", value: "No result — the tool call did not complete (interrupted or lost)." },
						});
					}
				}
			}
			if (parts.length > 0) out.push({ role: "assistant", content: parts });
			if (missing.length > 0) out.push({ role: "tool", content: missing });
		} else if (msg.role === "toolResult") {
			if (!msg.toolCallId || !callIds.has(msg.toolCallId)) continue;
			const text = textOf(msg.content);
			const images = allowImages ? imagesOf(msg.content) : [];
			const value =
				text ||
				(images.length > 0 ? "[Image omitted: model does not support images]" : "");
			out.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: msg.toolCallId,
						toolName: typeof msg.toolName === "string" ? msg.toolName : "",
						output: msg.isError ? { type: "error-text", value } : { type: "text", value },
					},
				],
			});
			if (images.length > 0) {
				out.push({ role: "user", content: images });
			}
		}
	}
	return out;
}

/** 工具名原样透传（上游不改名，实测 37 字符双下划线名可原样返回）。 */
export function toolsToJson(tools: readonly Tool[] | undefined): unknown[] {
	if (!tools || tools.length === 0) return [];
	return tools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description,
		input_schema: t.parameters ?? { type: "object", properties: {} },
	}));
}

/**
 * 思考深度：把 pi 的 thinking level 映射成上游认识的 reasoning_effort。
 *
 * 实测（deepseek-v4.1-flash，同一问题）：
 *   low=1.4s/42tk  medium=1.3s/47tk  high=1.9s/63tk  off=1.9s/0tk
 *   不下发=12.8s/105tk  ← 服务端默认按最高强度推理，是最慢的
 * 因此 off 必须显式下发 "off"（上游支持且真的关掉思考），不能省略字段。
 * 上游只接受小写的 low/medium/high/xhigh/max/off；none、minimal 会返回 400。
 * CommandCodeGoConfig.reasoningEffort 是显式覆盖，优先级高于档位映射。
 */
export const CCGO_THINKING_LEVEL_MAP: Record<string, string> = {
	off: "off",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const CCGO_EFFORT_VALUES = ["off", "low", "medium", "high", "xhigh", "max"];

function resolveReasoningEffort(model: Model<Api>, options?: SimpleStreamOptions): string | undefined {
	const cfg = getConfig();
	// 显式配置优先
	if (cfg.reasoningEffort) return cfg.reasoningEffort;
	const level = typeof options?.reasoning === "string" ? (options.reasoning as string) : undefined;
	// pi 未给出档位时才不下发，交给上游默认（实测为最高强度，最慢）
	if (!level) return undefined;
	const mapped = (model as any)?.thinkingLevelMap?.[level] ?? CCGO_THINKING_LEVEL_MAP[level];
	if (!mapped || !CCGO_EFFORT_VALUES.includes(mapped)) return undefined;
	return mapped;
}

// ── Transcript 解析（与 minimax.ts 同法，不依赖 pi-ai 的 reader 导出）──

interface ResolvedTranscript {
	systemPrompt?: string;
	tools: Map<string, Tool>;
	messages: Message[];
}

function resolveTranscript(context: Context): ResolvedTranscript {
	const tools = new Map<string, Tool>();
	const systemParts: string[] = [];
	const messages: Message[] = [];
	for (const msg of context.messages ?? []) {
		const raw = msg as any;
		if (raw.role === "system") {
			const text = textOf(raw.content);
			if (text.trim()) systemParts.push(text);
			for (const t of raw.toolsRemoved ?? []) tools.delete(t.name);
			for (const t of raw.toolsAdded ?? []) tools.set(t.name, t);
			continue;
		}
		messages.push(msg);
	}
	for (const t of (context as any).tools ?? []) tools.set(t.name, t);
	return {
		systemPrompt: (context as any).systemPrompt ?? (systemParts.length > 0 ? systemParts.join("\n\n") : undefined),
		tools,
		messages,
	};
}

// ── threadId ──────────────────────────────────────────────────────────
// 上游要求合法 UUID；同一会话内复用可保持服务端侧多轮上下文。
let sessionThreadId: string | undefined;
function resolveThreadId(options?: SimpleStreamOptions): string {
	const sid = (options as any)?.sessionId;
	if (typeof sid === "string" && sid.trim()) return sid.trim();
	if (!sessionThreadId) sessionThreadId = randomUUID();
	return sessionThreadId;
}

// ── 登录 ──────────────────────────────────────────────────────────────
// 站点现状：/studio/auth/cli 授权页在中文 locale 下会因 Next.js locale 中间件
// 重定向丢失 query 而报 Missing callback or state，浏览器自动回调不可靠；
// 但 /studio/auth/cli/fallback 页面会直接展示 API key 供复制。因此用 onSelect
// 让用户显式二选一，而不是靠提示语模糊解析。两条路径最终都只产出 apiKey ——
// Command Code 的 key 不过期，按 OAuth 凭据保存（access = refresh = key）。

const DEFAULT_PORT = 5959;
const DEFAULT_PORT_RANGE = 10;
const DEFAULT_TIMEOUT_MS = 180_000;

export interface CcGoCallbacks {
	onSelect(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
	onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
	onAuth(info: { url: string; instructions?: string }): void;
	onProgress?(message: string): void;
	signal?: AbortSignal;
}

export interface CcGoCredentials {
	refresh: string;
	access: string;
	expires: number;
}

/** 终端粘贴会带 bracketed paste 控制符，必须清掉。 */
export function sanitizeApiKey(input: string): string {
	const esc = String.fromCharCode(27);
	return Array.from(
		String(input ?? "")
			.replaceAll(`${esc}[200~`, "")
			.replaceAll(`${esc}[201~`, "")
			.replaceAll("[200~", "")
			.replaceAll("[201~", ""),
	)
		.filter((ch) => {
			const c = ch.charCodeAt(0);
			return c > 31 && c !== 127;
		})
		.join("")
		.trim();
}

function farFuture(): number {
	return Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
}

export function credentialsFromApiKey(apiKey: string): CcGoCredentials {
	return { refresh: apiKey, access: apiKey, expires: farFuture() };
}

export function getApiKey(credentials: CcGoCredentials): string {
	return credentials.access;
}

export function refreshToken(credentials: CcGoCredentials): CcGoCredentials {
	return credentialsFromApiKey(credentials.refresh);
}

export async function validateApiKey(apiKey: string, apiBase: string): Promise<void> {
	let res: Response;
	try {
		res = await fetch(`${apiBase.replace(/\/+$/, "")}/alpha/whoami`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
	} catch (e) {
		throw new Error(`无法校验 Command Code 密钥：${e instanceof Error ? e.message : String(e)}`);
	}
	if (res.status === 401) throw new Error("Command Code 密钥无效");
	if (!res.ok) throw new Error(`无法校验 Command Code 密钥（HTTP ${res.status}）`);
}

// ── 一次性本地回调服务 ────────────────────────────────────────────────

interface AuthServer {
	port: number;
	server: Server;
	waitForCallback: Promise<{ apiKey: string; state: string }>;
}

function listenOnAvailablePort(server: Server, startPort: number, range: number): Promise<number> {
	return new Promise((resolve, reject) => {
		let offset = 0;
		const tryListen = () => {
			const useFallback = startPort === 0 || offset >= range;
			const port = useFallback ? 0 : startPort + offset;
			const onError = (err: NodeJS.ErrnoException) => {
				server.off("listening", onListening);
				if (err.code === "EADDRINUSE" && !useFallback) {
					offset += 1;
					tryListen();
				} else reject(err);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve((server.address() as AddressInfo).port);
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(port, "127.0.0.1");
		};
		tryListen();
	});
}

async function startAuthServer(expectedState: string): Promise<AuthServer> {
	let resolveCb: (v: { apiKey: string; state: string }) => void;
	let rejectCb: (e: Error) => void;
	const waitForCallback = new Promise<{ apiKey: string; state: string }>((res, rej) => {
		resolveCb = res;
		rejectCb = rej;
	});

	const server = createServer((req, res) => {
		// ── CORS ──────────────────────────────────────────────────────
		// Studio 页面（HTTPS）用 fetch POST 到本地 HTTP 回调，浏览器会先发
		// OPTIONS 预检，且 Private Network Access 还要求额外放行头，缺任何一个
		// 都会导致浏览器根本不发真正的 POST。
		const origin = req.headers.origin || "";
		const allowed = ["https://commandcode.ai", "https://staging.commandcode.ai", "http://localhost:3000"];
		const responseOrigin = allowed.includes(origin) ? origin : allowed[0];
		const requestedHeaders = req.headers["access-control-request-headers"];
		res.setHeader("Access-Control-Allow-Origin", responseOrigin);
		res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
		res.setHeader(
			"Access-Control-Allow-Headers",
			typeof requestedHeaders === "string" && requestedHeaders.length > 0 ? requestedHeaders : "Content-Type",
		);
		res.setHeader("Access-Control-Allow-Private-Network", "true");
		res.setHeader("Content-Type", "application/json");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const path = (req.url ?? "/").split("?")[0];
		if (path !== "/callback") {
			res.writeHead(404);
			res.end(JSON.stringify({ success: false, error: "Not found" }));
			return;
		}
		// 官方 CLI 页面用 POST；保留 GET 兼容手工打开回调地址的场景。
		if (req.method !== "POST" && req.method !== "GET") {
			res.writeHead(405);
			res.end(JSON.stringify({ success: false, error: "Method not allowed. Use POST." }));
			return;
		}

		const finish = (status: number, payload: unknown, settle?: () => void) => {
			res.writeHead(status);
			res.end(JSON.stringify(payload));
			settle?.();
		};

		// ── GET：参数在 query 上 ─────────────────────────────────────
		if (req.method === "GET") {
			const url = new URL(req.url ?? "/", "http://localhost");
			const state = url.searchParams.get("state") ?? "";
			const apiKey = url.searchParams.get("apiKey") ?? url.searchParams.get("key") ?? "";
			if (state !== expectedState) {
				finish(403, { success: false, error: "Invalid state token" }, () =>
					rejectCb(new Error("OAuth state mismatch")),
				);
				return;
			}
			if (!apiKey) {
				finish(400, { success: false, error: "Missing apiKey" });
				return;
			}
			finish(200, { success: true }, () => resolveCb({ apiKey, state }));
			return;
		}

		// ── POST：body 为 JSON ───────────────────────────────────────
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString();
			if (body.length > 10_000) req.destroy();
		});
		req.on("end", () => {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(body || "{}");
			} catch {
				finish(400, { success: false, error: "Invalid JSON body" });
				return;
			}

			// 用户拒绝授权
			if (parsed.error) {
				const description =
					typeof parsed.error_description === "string" ? parsed.error_description : String(parsed.error);
				finish(200, { success: true }, () =>
					rejectCb(
						new Error(
							parsed.error === "access_denied" ? `授权被拒绝：${description}` : description,
						),
					),
				);
				return;
			}

			const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : "";
			const state = typeof parsed.state === "string" ? parsed.state : "";
			const userId = typeof parsed.userId === "string" ? parsed.userId : "";
			const userName = typeof parsed.userName === "string" ? parsed.userName : "";
			const keyName = typeof parsed.keyName === "string" ? parsed.keyName : "";

			// 与官方一致：五个字段缺一不可（少字段说明回调不是本次登录发起的）
			if (!apiKey || !state || !userId || !userName || !keyName) {
				finish(400, { success: false, error: "Missing required fields" });
				return;
			}
			if (state !== expectedState) {
				finish(403, { success: false, error: "Invalid state token" }, () =>
					rejectCb(new Error("OAuth state mismatch")),
				);
				return;
			}
			finish(200, { success: true }, () => resolveCb({ apiKey, state }));
		});
	});

	const port = await listenOnAvailablePort(server, DEFAULT_PORT, DEFAULT_PORT_RANGE);
	return { port, server, waitForCallback };
}

// ── 登录流程 ──────────────────────────────────────────────────────────

const STUDIO = "https://commandcode.ai";

async function loginViaBrowser(callbacks: CcGoCallbacks, apiBase: string): Promise<CcGoCredentials> {
	const state = randomBytes(32).toString("base64url");
	let auth: AuthServer;
	try {
		auth = await startAuthServer(state);
	} catch (e) {
		throw new Error(
			`无法启动本地回调服务（端口 ${DEFAULT_PORT}-${DEFAULT_PORT + DEFAULT_PORT_RANGE} 均被占用）：${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}

	const callbackUrl = `http://localhost:${auth.port}/callback`;
	const url = `${STUDIO}/zh/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;
	callbacks.onAuth({
		url,
		instructions:
			"在浏览器完成 Command Code 登录。若页面显示「自动传输失败 / Missing callback or state」，请改用「粘贴 API 密钥」——该站点的中文页面已知会丢失回调参数。",
	});

	const timer = setTimeout(() => auth.server.close(), DEFAULT_TIMEOUT_MS);
	try {
		const cb = await Promise.race([
			auth.waitForCallback,
			new Promise<never>((_, rej) => {
				if (!callbacks.signal) return;
				if (callbacks.signal.aborted) return rej(new Error("Login cancelled"));
				callbacks.signal.addEventListener(
					"abort",
					() => rej(new Error("Login cancelled")),
					{ once: true },
				);
			}),
		]);
		clearTimeout(timer);
		auth.server.close();
		await validateApiKey(cb.apiKey, apiBase);
		return credentialsFromApiKey(cb.apiKey);
	} catch (e) {
		clearTimeout(timer);
		auth.server.close();
		throw e;
	}
}

async function loginViaPrompt(callbacks: CcGoCallbacks, apiBase: string): Promise<CcGoCredentials> {
	callbacks.onProgress?.("请在 commandcode.ai 的 Studio 页面复制 API 密钥后粘贴");
	const answer = sanitizeApiKey(
		await callbacks.onPrompt({
			message: "粘贴 Command Code API 密钥（形如 user_…）：",
			placeholder: "user_…",
		}),
	);
	if (!answer) throw new Error("Login cancelled");
	await validateApiKey(answer, apiBase);
	return credentialsFromApiKey(answer);
}

export async function login(callbacks: CcGoCallbacks, apiBase: string): Promise<CcGoCredentials> {
	const choice = await callbacks.onSelect({
		message: "Command Code (GO) 登录方式：",
		options: [
			{ id: "browser", label: "浏览器登录（自动回传密钥）" },
			{ id: "paste", label: "粘贴 API 密钥（推荐）" },
		],
	});
	if (!choice) throw new Error("Login cancelled");
	return choice === "browser"
		? loginViaBrowser(callbacks, apiBase)
		: loginViaPrompt(callbacks, apiBase);
}

// ── 传输层 ────────────────────────────────────────────────────────────

function mapStopReason(raw: string | undefined): StopReason {
	switch ((raw ?? "").toLowerCase()) {
		case "stop":
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "length":
		case "max_tokens":
			return "aborted";
		case "tool-calls":
		case "tool_use":
			return "toolUse";
		case "error":
			return "error";
		default:
			return "stop";
	}
}

export function streamCommandCodeGo(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const cfg = { ...DEFAULT_CCGO, ...(getConfig() as CommandCodeGoConfig) };
		const base = (cfg.baseUrl || CCGO_BASE_URL).replace(/\/+$/, "");
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey ?? "";
			const allowImages = (model.input ?? ["text"]).includes("image");
			const { systemPrompt, tools, messages } = resolveTranscript(context);
			const maxTokens =
				cfg.maxCompletionTokens ?? options?.maxTokens ?? model.maxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
			const effort = resolveReasoningEffort(model, options);

			const body: unknown = {
				config: {
					workingDir: process.cwd(),
					date: new Date().toISOString().split("T")[0],
					environment: "cli",
					structure: [],
					isGitRepo: false,
					currentBranch: "",
					mainBranch: "",
					gitStatus: "",
					recentCommits: [],
				},
				memory: null,
				taste: null,
				skills: null,
				params: {
					model: model.id,
					messages: messagesToCC(messages, { allowImages }),
					tools: toolsToJson([...tools.values()]),
					system: systemPrompt ?? "",
					max_tokens: Math.max(1, Math.floor(maxTokens)),
					stream: true,
					...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
					...(effort ? { reasoning_effort: effort } : {}),
				},
				threadId: resolveThreadId(options),
			};

			const ac = new AbortController();
			const onAbort = () => ac.abort();
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
			const res = await fetch(`${base}/alpha/generate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					"x-command-code-version": CLI_VERSION,
					"x-cli-environment": "production",
					"x-taste-learning": "true",
					"User-Agent": "cli",
					...(options?.sessionId ? { "x-session-id": String(options.sessionId) } : {}),
				},
				body: JSON.stringify(body),
				signal: ac.signal,
			});
			options?.onResponse?.(res, model as any);

			if (!res.ok) {
				const text = await res.text().catch(() => "");
				if (res.status === 403 || res.status === 401) {
					throw new Error(
						`Command Code 拒绝了该请求（HTTP ${res.status}）。请确认已通过 /login 登录 GO 套餐账号。${text.slice(0, 200)}`,
					);
				}
				throw new Error(`Command Code 请求失败：HTTP ${res.status} ${text.slice(0, 300)}`);
			}
			if (!res.body) throw new Error("Command Code 返回了空响应体");

			options?.onPayload?.(body as any);

			// 逐行解析 NDJSON
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			// pi 的流事件必须带 contentIndex 与 partial（完整的当前消息快照），
			// 否则 TUI 不会渲染流式内容（只会显示最终的 done 快照）。
			let textIndex = -1;
			let textBuf = "";
			let thinkingIndex = -1;
			let thinkingBuf = "";
			/** toolCallId -> { index, json }，用于把 tool-input-delta 累积成完整参数 */
			const toolBlocks = new Map<string, { index: number; json: string }>();
			/**
			 * 已完成的 toolCallId。上游会先发 tool-input-* 再发一条汇总的 tool-call，
			 * tool-input-end 时就从 toolBlocks 删掉了，所以必须另用这个集合去重，
			 * 否则同一个调用会在 content 里出现两次，pi 执行时报 [object Object]。
			 */
			const closedToolIds = new Set<string>();

			const endText = () => {
				if (textIndex < 0) return;
				stream.push({ type: "text_end", contentIndex: textIndex, content: textBuf, partial: output } as any);
				textIndex = -1;
				textBuf = "";
			};
			const endThinking = () => {
				if (thinkingIndex < 0) return;
				stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinkingBuf, partial: output } as any);
				thinkingIndex = -1;
				thinkingBuf = "";
			};

			const handle = (line: string) => {
				const t = line.trim();
				if (!t) return;
				let ev: CcEvent;
				try {
					ev = JSON.parse(t) as CcEvent;
				} catch {
					return; // 忽略非 JSON 行
				}
				switch (ev.type) {
					case "text-start": {
						endThinking();
						endText();
						output.content.push({ type: "text", text: "" } satisfies TextContent);
						textIndex = output.content.length - 1;
						textBuf = "";
						stream.push({ type: "text_start", contentIndex: textIndex, partial: output } as any);
						break;
					}
					case "text-delta": {
						if (typeof ev.text !== "string" || !ev.text) break;
						if (textIndex < 0) {
							output.content.push({ type: "text", text: "" } satisfies TextContent);
							textIndex = output.content.length - 1;
							stream.push({ type: "text_start", contentIndex: textIndex, partial: output } as any);
						}
						textBuf += ev.text;
						(output.content[textIndex] as TextContent).text = textBuf;
						stream.push({ type: "text_delta", contentIndex: textIndex, delta: ev.text, partial: output } as any);
						break;
					}
					case "text-end": {
						endText();
						break;
					}
					case "reasoning-start": {
						endText();
						endThinking();
						output.content.push({ type: "thinking", thinking: "" } satisfies ThinkingContent);
						thinkingIndex = output.content.length - 1;
						thinkingBuf = "";
						stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output } as any);
						break;
					}
					case "reasoning-delta": {
						if (typeof ev.text !== "string" || !ev.text) break;
						if (thinkingIndex < 0) {
							output.content.push({ type: "thinking", thinking: "" } satisfies ThinkingContent);
							thinkingIndex = output.content.length - 1;
							stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output } as any);
						}
						thinkingBuf += ev.text;
						(output.content[thinkingIndex] as ThinkingContent).thinking = thinkingBuf;
						stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: ev.text, partial: output } as any);
						break;
					}
					case "reasoning-end": {
						endThinking();
						break;
					}
					case "tool-input-start": {
						if (!ev.id) break;
						endText();
						endThinking();
						output.content.push({
							type: "toolCall",
							id: ev.id,
							name: ev.toolName ?? "",
							arguments: {},
						} as ToolCall);
						const index = output.content.length - 1;
						toolBlocks.set(ev.id, { index, json: "" });
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output } as any);
						break;
					}
					case "tool-input-delta": {
						if (!ev.id) break;
						const blk = toolBlocks.get(ev.id);
						if (!blk || typeof ev.delta !== "string" || !ev.delta) break;
						blk.json += ev.delta;
						stream.push({ type: "toolcall_delta", contentIndex: blk.index, delta: ev.delta, partial: output } as any);
						break;
					}
					case "tool-input-end": {
						if (!ev.id) break;
						closeToolCall(ev.id, ev.input);
						break;
					}
					case "tool-call": {
						// 汇总事件；已由 tool-input-* 处理过则忽略，避免同一个调用入账两次
						if (!ev.toolCallId || closedToolIds.has(ev.toolCallId)) break;
						endText();
						endThinking();
						output.content.push({
							type: "toolCall",
							id: ev.toolCallId,
							name: ev.toolName ?? "",
							arguments: (ev.input ?? {}) as never,
						} as ToolCall);
						const index = output.content.length - 1;
						closedToolIds.add(ev.toolCallId);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output } as any);
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: output.content[index] as ToolCall, partial: output } as any);
						break;
					}
					case "finish": {
						endText();
						endThinking();
						const u = ev.totalUsage ?? ev.usage;
						if (u) {
							output.usage = mapUsage(u, model);
							output.stopReason = mapStopReason((ev.finishReason ?? ev.rawFinishReason) as string | undefined);
						}
						break;
					}
					case "error": {
						throw new Error(String((ev as any).message ?? (ev as any).error ?? "Command Code 返回错误事件"));
					}
				}
			};

			function closeToolCall(id: string, fallbackInput?: unknown): void {
				if (closedToolIds.has(id)) return;
				const blk = toolBlocks.get(id);
				if (!blk) return;
				toolBlocks.delete(id);
				closedToolIds.add(id);
				const call = output.content[blk.index] as ToolCall | undefined;
				if (!call) return;
				let args: unknown = fallbackInput;
				if (args === undefined) {
					try {
						args = blk.json ? JSON.parse(blk.json) : {};
					} catch {
						args = {};
					}
				}
				(call as any).arguments = args;
				stream.push({ type: "toolcall_end", contentIndex: blk.index, toolCall: call, partial: output } as any);
			}

			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					handle(buf.slice(0, nl));
					buf = buf.slice(nl + 1);
				}
			}
			handle(buf);

			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onAbort);

			// 流未给出 usage 时兜底
			if (output.usage.totalTokens === 0) {
				output.usage = mapUsage({}, model);
			}
			// done 只接受 stop / length / toolUse / deferred
			const doneReason =
				output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "aborted" ? "length" : "stop";
			stream.push({ type: "done", reason: doneReason, message: output } as any);
			stream.end();
		} catch (e) {
			clearTimeout(REQUEST_TIMEOUT_MS);
			const message = e instanceof Error ? e.message : String(e);
			output.stopReason = "error";
			output.errorMessage = message;
			output.usage = mapUsage({}, model);
			stream.push({ type: "error", reason: "error", error: output } as any);
			stream.end();		}
	})();

	return stream;
}

function mapUsage(u: CcUsage, model: Model<Api>): AssistantMessage["usage"] {
	const input = u.inputTokens ?? 0;
	const output = u.outputTokens ?? 0;
	const cacheRead = u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0;
	const totalTokens = u.totalTokens ?? input + output;
	// pi-ai 的 calculateCost 是“就地写入 usage.cost”，所以 usage 必须先带上
	// 一个完整的零值 cost 对象，否则会在给 undefined.input 赋值时抛错。
	const usage: AssistantMessage["usage"] = {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// 手动新增的模型可能没有 cost 费率，补一份零费率避免 calculateCost 读空
	const priced = model?.cost ? model : ({ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>);
	try {
		usage.cost = calculateCost(priced, usage);
	} catch {
		// 定价信息异常不应中断对话
	}
	return usage;
}

// ── ProviderConfig 构造 ───────────────────────────────────────────────

/** pi 侧的模型条目结构（只声明用到的字段，避免额外类型依赖）。 */
export interface CcGoModelConfig {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	input: ("text" | "image")[];
	cost: Record<string, number>;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}

export interface CcGoCallbacks2 {
	/** 登录期间打开浏览器 / 读取输入，由 pi 的 /login 界面提供。 */
	onSelect(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
	onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
	onAuth(info: { url: string; instructions?: string }): void;
	onProgress?(message: string): void;
	signal?: AbortSignal;
}

/**
 * 组装 registerProvider 所需的配置。
 *
 * oauth 的存在会让该 provider 出现在 `/login` 的「Sign in with an account」里；
 * 不传 apiKey 是刻意的——pi 会用 oauth.getApiKey 从凭据里取 key。
 */
export function buildCommandCodeGoConfig(params: {
	config: CommandCodeGoConfig;
	models: CcGoModelConfig[];
	/** refreshModels 拿到远端目录后回调，用于写回本地配置。 */
	persist?: (models: unknown[]) => Promise<void>;
}): Record<string, unknown> {
	const cfg = params.config;
	const base = (cfg.baseUrl || CCGO_BASE_URL).replace(/\/+$/, "");
	return {
		name: CCGO_LABEL,
		api: CCGO_PROVIDER_ID,
		baseUrl: base,
		authHeader: true,
		// /provider/v1/models 不返回能力位，统一按支持推理处理，否则 TUI 不会渲染思考块
		// （normalizeModel 已把 reasoning 填成 false，?? 不会生效，所以这里必须无条件置 true）
		models: params.models.map((m) => ({
			...m,
			reasoning: true,
			thinkingLevelMap: m.thinkingLevelMap ?? { ...CCGO_THINKING_LEVEL_MAP },
		})),
		streamSimple: streamCommandCodeGo,
		refreshModels: async (context: any) => {
			// 本地变更触发的无网络刷新：原样返回，不访问远端
			if (context?.allowNetwork !== true || context?.signal?.aborted) return params.models;
			const key = extractCredentialKey(context?.credential);
			try {
				const fetched = await fetchCommandCodeGoModels(key, base, context.signal);
				if (fetched.length === 0) return params.models;
				await params.persist?.(fetched);
				return params.models;
			} catch {
				// 拉取失败保留当前列表，不清空
				return params.models;
			}
		},
		oauth: {
			name: "Command Code",
			isSubscription: true,
			login: (callbacks: CcGoCallbacks2) => login(callbacks as CcGoCallbacks, base),
			refreshToken: async (credentials: CcGoCredentials) => refreshToken(credentials),
			getApiKey: (credentials: CcGoCredentials) => getApiKey(credentials),
		},
	};
}

/** 从 pi 的凭据对象里取出 API key（与 index.ts 的同名逻辑保持一致）。 */
function extractCredentialKey(credential: unknown): string | undefined {
	if (typeof credential === "string") return credential.trim() || undefined;
	if (!credential || typeof credential !== "object") return undefined;
	const c = credential as Record<string, unknown>;
	for (const k of ["apiKey", "key", "access", "token"]) {
		const v = c[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

// ── 宿主配置注入（由 index.ts 在注册时调用）───────────────────────────

let injectedConfig: CommandCodeGoConfig | null = null;
function getConfig(): CommandCodeGoConfig {
	return injectedConfig ?? DEFAULT_CCGO;
}
export function setCommandCodeGoConfig(cfg: CommandCodeGoConfig): void {
	injectedConfig = cfg;
}
