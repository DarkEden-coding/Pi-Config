import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { loadToolReviewConfig, terminalToolReviewExtension } from "./tool-review.ts";

type ThinkingLevel = "low" | "medium" | "high";

interface BaseAgentModel {
	name: string;
	model: string;
	description: string;
	enabled: boolean;
}

interface PiAgentModel extends BaseAgentModel {
	backend: "pi";
	provider: string;
}

interface ClaudeCodeAgentModel extends BaseAgentModel {
	backend: "claude-code";
}

type AgentModel = PiAgentModel | ClaudeCodeAgentModel;

interface ParallelAgentsConfig {
	maxParallelAgents: number;
	allowedExtensionTools: string[];
	models: AgentModel[];
}

const CONFIG_PATH = join(getAgentDir(), "parallel-agents.json");

const DEBUG_LOG_PATH = join(getAgentDir(), "parallel-agents-debug.log");
const DEFAULT_CONFIG: ParallelAgentsConfig = {
	maxParallelAgents: 4,
	allowedExtensionTools: [],
	models: [],
};

const TASK_SCHEMA = Type.Object({
	name: Type.Optional(Type.String({ description: "Short human-readable task name." })),
	model: Type.String({ description: "Configured model name from ~/.pi/agent/parallel-agents.json." }),
	reasoningLevel: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
		description: "Required reasoning level for this sub-agent run.",
	}),
	prompt: Type.String({
		description:
			"Detailed architectural prompt for the sub-agent. Include objective, files to inspect/touch, constraints, and expected final answer. For read-only work, explicitly tell the sub-agent never to edit files, mutate the repository, or perform other state-changing actions.",
	}),
});

const PARALLEL_AGENTS_SCHEMA = Type.Object({
	tasks: Type.Array(TASK_SCHEMA, {
		description: "Sub-agent tasks to run concurrently. Assign non-overlapping files for editing tasks.",
	}),
	blocking: Type.Optional(Type.Boolean({
		description: "Whether to wait for all sub-agents before returning. Defaults to true. Set false to continue working and use parallel_agents_control with the returned runId to inspect, wait for, or cancel the run.",
	})),
});

const PARALLEL_AGENTS_CONTROL_SCHEMA = Type.Object({
	action: Type.String({
		description: "One of: status (summarize progress), wait (wait for completion), read_actions (read recorded sub-agent actions), read_results (read a chunk of completed sub-agent reports), or cancel (stop active sub-agents).",
	}),
	runId: Type.String({ description: "Run ID returned from a non-blocking parallel_agents call." }),
	agents: Type.Optional(Type.Array(Type.String(), {
		description: "Optional task names to limit action reading or cancellation. Omit to operate on every task in the run. Wait always waits for the complete run.",
	})),
	readRegion: Type.Optional(Type.Object({
		start: Type.Integer({ minimum: 0, description: "First recorded action index to include (inclusive)." }),
		end: Type.Integer({ minimum: 0, description: "Last recorded action index to include (inclusive)." }),
	}, {
		description: "For read_actions: an explicit inclusive range of recorded action indexes. Omit to return only the four newest actions.",
	})),
	reportRegion: Type.Optional(Type.Object({
		start: Type.Integer({ minimum: 0, description: "First report character offset to include (inclusive)." }),
		end: Type.Integer({ minimum: 0, description: "Last report character offset to include (inclusive)." }),
	}, {
		description: "For read_results: an explicit inclusive character range from each selected sub-agent report. Each call returns at most 4,000 characters per report; make another call for later text.",
	})),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Deprecated: zero-based offset in the filtered action list. Use readRegion instead." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Deprecated: maximum actions from offset. Use readRegion instead." })),
	timeoutSeconds: Type.Optional(Type.Number({
		description: "For wait on a non-blocking run: maximum time to wait without cancelling the sub-agents. Omit to wait until completion.",
		exclusiveMinimum: 0,
	})),
});

type ParallelAgentsInput = Static<typeof PARALLEL_AGENTS_SCHEMA>;
type ParallelAgentsControlInput = Static<typeof PARALLEL_AGENTS_CONTROL_SCHEMA>;
type SubAgentTask = Static<typeof TASK_SCHEMA>;

type AgentRunStatus = "active" | "done" | "failed" | "cancelled";

type AgentRunStats = {
	name: string;
	model: string;
	reasoningLevel: ThinkingLevel;
	status: AgentRunStatus;
	iterations: number;
	actions: number;
	cost: number;
	filesRead: Set<string>;
	filesEdited: Set<string>;
};

type AgentAction = {
	index: number;
	timestamp: number;
	agent: string;
	type: "turn_start" | "tool_start" | "tool_end" | "completed" | "failed" | "cancelled";
	toolName?: string;
	details?: string;
};

interface RunningAgentController {
	abort(): Promise<void> | void;
}

type ParallelAgentRun = {
	id: string;
	tasks: SubAgentTask[];
	stats: AgentRunStats[];
	actions: AgentAction[];
	controllers: Array<RunningAgentController | undefined>;
	cancelRequested: Set<number>;
	results?: Array<{ ok: boolean; name: string; output: string }>;
	completion: Promise<Array<{ ok: boolean; name: string; output: string }>>;
};

type ClaudeResultMessage = {
	type: "result";
	subtype: string;
	is_error?: boolean;
	result?: string;
	errors?: string[];
	num_turns?: number;
	total_cost_usd?: number;
	modelUsage?: Record<string, unknown>;
	permission_denials?: unknown[];
};

type PiCliRunState = {
	finalText?: string;
	error?: string;
};

const CLAUDE_TOOLS = "Read,Glob,Grep,Edit,Write,Bash";
const CLAUDE_COMMAND = join(getAgentDir(), "bin", "claude");
const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;
const CLAUDE_AUTH_ENVIRONMENT_OVERRIDES = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_VERTEX",
] as const;

/** Maps a sub-agent reasoning level to the active theme's matching color. */
function getReasoningColor(level: ThinkingLevel): ThemeColor {
	switch (level) {
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
	}
}

function ensureConfigDir() {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

function loadConfig(): ParallelAgentsConfig {
	if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return {
			maxParallelAgents:
				typeof parsed.maxParallelAgents === "number" && parsed.maxParallelAgents > 0
					? Math.floor(parsed.maxParallelAgents)
					: DEFAULT_CONFIG.maxParallelAgents,
			allowedExtensionTools: Array.isArray(parsed.allowedExtensionTools)
				? parsed.allowedExtensionTools.filter((v: unknown) => typeof v === "string")
				: [],
			models: Array.isArray(parsed.models)
				? parsed.models.filter(isModelLike).map(normalizeModel)
				: [],
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: ParallelAgentsConfig) {
	ensureConfigDir();
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function isModelLike(value: unknown): boolean {
	const model = value as Record<string, unknown> | undefined;
	if (
		!model ||
		typeof model.name !== "string" ||
		typeof model.model !== "string" ||
		typeof model.description !== "string" ||
		(model.enabled !== undefined && typeof model.enabled !== "boolean")
	) return false;
	return model.backend === "claude-code" ||
		((model.backend === undefined || model.backend === "pi") && typeof model.provider === "string");
}

/** Converts legacy provider/model entries into explicitly pi-backed model entries. */
function normalizeModel(value: unknown): AgentModel {
	const model = value as Record<string, unknown>;
	const common = {
		name: model.name as string,
		model: model.model as string,
		description: model.description as string,
		enabled: model.enabled !== false,
	};
	if (model.backend === "claude-code") return { ...common, backend: "claude-code" };
	return { ...common, backend: "pi", provider: model.provider as string };
}

function findModel(config: ParallelAgentsConfig, name: string): AgentModel | undefined {
	return config.models.find((model) => model.name === name);
}

function findEnabledModel(config: ParallelAgentsConfig, name: string): AgentModel | undefined {
	const model = findModel(config, name);
	return model?.enabled ? model : undefined;
}

function taskTools(allowedExtensionTools: string[]): string[] {
	const builtins = ["read", "grep", "find", "ls", "write", "edit", "bash"];
	return [...new Set([...builtins, ...allowedExtensionTools])];
}

function isKimiModel(model: AgentModel): boolean {
	return model.backend === "pi" && `${model.provider}/${model.model}`.toLowerCase().includes("kimi");
}

/** Formats the configured execution backend and model for management UI. */
function formatModelBackend(model: AgentModel): string {
	return model.backend === "claude-code"
		? `Claude Code/${model.model}`
		: `${model.provider}/${model.model}`;
}

function debugLog(message: string, details?: unknown) {
	try {
		ensureConfigDir();
		const suffix = details === undefined ? "" : ` ${JSON.stringify(details, (_key, value) => value instanceof Set ? [...value] : value)}`;
		appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}${suffix}\n`, "utf-8");
	} catch {
		// Debug logging must never break agent execution.
	}
}

function buildSubAgentPrompt(task: SubAgentTask, model: AgentModel): string {
	const kimiEditRules = isKimiModel(model)
		? `\n\nKimi/tool-use compatibility rules:\n- The edit tool requires this exact shape: {"path":"relative/or/absolute/path","edits":[{"oldText":"exact unique text copied from the current file","newText":"replacement text"}]}. Do not send oldText/newText at the top level.\n- Always read the target file immediately before an edit and copy oldText verbatim from that read result.\n- If an edit fails once because oldText is not unique or not found, re-read the file and either make a smaller exact edit or use bash with a short python script to rewrite the file deterministically.\n- For risky rewrites, first create an easily reverted backup outside the repo at /tmp/pi-parallel-agent-backups/<timestamp>-<basename>.bak, then report the backup path in your final answer.\n- Do not repeatedly retry the same failing edit arguments.`
		: "";
	return `You are an isolated coding sub-agent running as part of a parallel multi-agent task.\n\nRules:\n- Complete only the task below.\n- Follow all task constraints exactly, including any instruction that the work is read-only and must not edit files, mutate the repository, or perform state-changing actions.\n- If editing is allowed, keep edits focused and touch only files assigned in the task.\n- Do not ask the user questions. If information is missing, state assumptions in the final answer.\n- Avoid interactive commands and tools.\n- Final answer should be concise and directly useful to the main agent.${kimiEditRules}\n\nTask:\n${task.prompt}`;
}

const MAX_ACTION_DETAIL_CHARS = 800;
const MAX_SUB_AGENT_RESULT_CHARS = 4_000;

/** Limits action metadata so diagnostic logs cannot dominate the parent agent's context. */
function formatActionDetails(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const text = typeof value === "string" ? value : JSON.stringify(value, (_key, item) => item instanceof Set ? [...item] : item);
	return text.length > MAX_ACTION_DETAIL_CHARS
		? `${text.slice(0, MAX_ACTION_DETAIL_CHARS)}… [truncated]`
		: text;
}

function getFinalAssistantText(session: any): string {
	const messages = Array.isArray(session.messages) ? session.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		const content = msg.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
				.filter(Boolean)
				.join("\n");
			if (text) return text;
		}
	}
	return "(sub-agent completed without a final text response)";
}

async function runPiSubAgent(
	task: SubAgentTask,
	modelConfig: PiAgentModel,
	config: ParallelAgentsConfig,
	ctx: ExtensionContext,
	stats: AgentRunStats,
	onStatsChange: () => void,
	onControllerReady: (controller: RunningAgentController) => void,
	onAction: (type: AgentAction["type"], toolName?: string, details?: unknown) => void,
): Promise<{ ok: boolean; name: string; output: string }> {
	// Use the live context model registry instead of creating a fresh one.
	// Provider/model registrations from extensions (for example cursor/composer-2.5)
	// are applied to ctx.modelRegistry; a new registry only contains built-in/static
	// models and would fail to find extension-provided model entries.
	const modelRegistry = ctx.modelRegistry;
	const registeredModel = modelRegistry.find(modelConfig.provider, modelConfig.model);
	if (!registeredModel) {
		const available = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`).sort();
		throw new Error(
			`Model ${modelConfig.name} not found: ${modelConfig.provider}/${modelConfig.model}. Available models in active registry: ${available.join(", ") || "(none)"}`,
		);
	}
	if (!modelRegistry.hasConfiguredAuth(registeredModel)) {
		throw new Error(`Model ${modelConfig.name}: no auth configured for provider ${modelConfig.provider}`);
	}

	// Sub-agent sessions need their own runtime, but extension-provided providers
	// must be copied from the live registry before that runtime can stream them.
	const agentDir = getAgentDir();
	const provider = modelRegistry.getProvider(modelConfig.provider);
	if (!provider) {
		throw new Error(`Model ${modelConfig.name}: provider ${modelConfig.provider} is not registered`);
	}
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	modelRuntime.registerNativeProvider(provider);
	const reviewer = loadToolReviewConfig().reviewer;
	if (reviewer && reviewer.provider !== modelConfig.provider) {
		const reviewerProvider = modelRegistry.getProvider(reviewer.provider);
		if (reviewerProvider) modelRuntime.registerNativeProvider(reviewerProvider);
	}
	const model = modelRuntime.getModel(modelConfig.provider, modelConfig.model) ?? registeredModel;

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } as any });
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: config.allowedExtensionTools.length === 0,
		extensionFactories: config.allowedExtensionTools.length === 0
			? [{ name: "terminal-tool-review", factory: terminalToolReviewExtension }]
			: [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () =>
			"You are an isolated non-interactive sub-agent. Never request user interaction. Follow the provided task exactly.",
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		model,
		thinkingLevel: task.reasoningLevel,
		modelRuntime,
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		tools: taskTools(config.allowedExtensionTools),
	});

	onControllerReady(session);
	debugLog("sub-agent-start", { name: task.name, model: modelConfig.name, reasoningLevel: task.reasoningLevel });
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "turn_start") {
			stats.iterations++;
			onAction("turn_start");
			onStatsChange();
			return;
		}
		if (event.type === "tool_execution_start") {
			stats.actions++;
			const args = event.args ?? {};
			if (event.toolName === "read" && typeof args.path === "string") stats.filesRead.add(args.path);
			if ((event.toolName === "edit" || event.toolName === "write") && typeof args.path === "string") stats.filesEdited.add(args.path);
			debugLog("tool-start", { agent: task.name ?? modelConfig.name, tool: event.toolName, args });
			onAction("tool_start", event.toolName, args);
			onStatsChange();
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			stats.cost += event.message.usage?.cost?.total ?? 0;
			onStatsChange();
			return;
		}
		if (event.type === "tool_execution_end") {
			debugLog("tool-end", { agent: task.name ?? modelConfig.name, tool: event.toolName, isError: event.isError, result: event.result });
			onAction("tool_end", event.toolName, { isError: event.isError, result: event.result });
		}
	});

	try {
		await session.prompt(buildSubAgentPrompt(task, modelConfig), { source: "extension" as any });
		if (stats.status === "cancelled") {
			onStatsChange();
			return { ok: false, name: task.name ?? modelConfig.name, output: "Cancelled." };
		}
		stats.status = "done";
		onAction("completed");
		onStatsChange();
		const output = getFinalAssistantText(session);
		debugLog("sub-agent-done", { name: task.name ?? modelConfig.name, filesRead: stats.filesRead, filesEdited: stats.filesEdited, output });
		return { ok: true, name: task.name ?? modelConfig.name, output };
	} catch (error) {
		const wasCancelled = stats.status === "cancelled";
		stats.status = wasCancelled ? "cancelled" : "failed";
		onAction(wasCancelled ? "cancelled" : "failed", undefined, error instanceof Error ? error.message : String(error));
		onStatsChange();
		debugLog("sub-agent-failed", { name: task.name ?? modelConfig.name, error: error instanceof Error ? error.stack ?? error.message : String(error) });
		throw error;
	} finally {
		unsubscribe();
		session.dispose();
	}
}

/** Builds an environment that cannot override Claude subscription auth with metered providers. */
function createClaudeSubscriptionEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const name of CLAUDE_AUTH_ENVIRONMENT_OVERRIDES) delete environment[name];
	environment.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
	environment.CLAUDE_CODE_DISABLE_FAST_MODE = "1";
	return environment;
}

/** Runs a short Claude CLI command and captures its complete output. */
function captureClaudeCommand(args: string[], cwd: string, timeoutMs = 15_000): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(CLAUDE_COMMAND, args, {
			cwd,
			env: createClaudeSubscriptionEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`Claude Code command timed out after ${timeoutMs}ms.`));
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(new Error(`Could not start Claude Code. Ensure the claude executable is installed and on PATH: ${error.message}`));
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolve({ stdout, stderr, code: code ?? -1 });
		});
	});
}

/** Refuses Claude execution unless the installed CLI confirms first-party subscription auth. */
async function verifyClaudeSubscriptionAuth(cwd: string, requestedModels: ClaudeCodeAgentModel[] = []): Promise<void> {
	const result = await captureClaudeCommand(["--safe-mode", "auth", "status"], cwd);
	if (result.code !== 0) {
		throw new Error(`Claude Code authentication check failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
	}
	let status: Record<string, unknown>;
	try {
		status = JSON.parse(result.stdout) as Record<string, unknown>;
	} catch {
		throw new Error(`Claude Code returned invalid authentication status: ${result.stdout.trim() || "(empty output)"}`);
	}
	if (status.loggedIn !== true || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") {
		throw new Error(
			"Claude Code sub-agents require first-party claude.ai subscription authentication. Run `claude auth login` and select your Claude subscription; API, gateway, Bedrock, Vertex, and Foundry auth are intentionally rejected to prevent metered usage.",
		);
	}
	const requestsFable = requestedModels.some((model) => {
		const id = model.model.toLowerCase();
		return id === "fable" || id.startsWith("claude-fable-");
	});
	if (status.subscriptionType === "pro" && requestsFable) {
		throw new Error(
			"Claude Code reports a Pro subscription, which does not include Fable. Configure Opus, Sonnet, or Haiku instead; usage credits remain intentionally disabled.",
		);
	}

	const accountCachePath = join(homedir(), ".claude.json");
	try {
		const accountCache = JSON.parse(readFileSync(accountCachePath, "utf8")) as Record<string, any>;
		if (accountCache.oauthAccount?.hasExtraUsageEnabled !== false) {
			throw new Error("Claude usage credits appear enabled or could not be confirmed as disabled.");
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Cannot guarantee subscription-only Claude usage: ${reason} Disable usage credits in Claude Settings > Usage, then restart Claude Code before using Claude-backed sub-agents.`,
		);
	}
}

/** Returns the message content blocks carried by Claude stream events. */
function getClaudeContentBlocks(event: Record<string, any>): Array<Record<string, any>> {
	const content = event.message?.content;
	return Array.isArray(content) ? content : [];
}

/** Applies one Claude stream event to pi's shared run statistics and action log. */
function processClaudeEvent(
	event: Record<string, any>,
	stats: AgentRunStats,
	onStatsChange: () => void,
	onAction: (type: AgentAction["type"], toolName?: string, details?: unknown) => void,
	toolNames: Map<string, string>,
): ClaudeResultMessage | undefined {
	if (event.type === "assistant" && event.parent_tool_use_id == null) {
		stats.iterations++;
		onAction("turn_start");
	}
	if (event.type === "assistant") {
		for (const block of getClaudeContentBlocks(event)) {
			if (block.type !== "tool_use" || typeof block.name !== "string") continue;
			stats.actions++;
			if (typeof block.id === "string") toolNames.set(block.id, block.name);
			const input = block.input ?? {};
			const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
			if (["Read", "Glob", "Grep"].includes(block.name) && path) stats.filesRead.add(path);
			if (["Edit", "Write", "NotebookEdit"].includes(block.name) && path) stats.filesEdited.add(path);
			onAction("tool_start", block.name, input);
		}
	}
	if (event.type === "user") {
		for (const block of getClaudeContentBlocks(event)) {
			if (block.type !== "tool_result") continue;
			const toolName = typeof block.tool_use_id === "string" ? toolNames.get(block.tool_use_id) : undefined;
			onAction("tool_end", toolName, { isError: block.is_error === true, result: block.content });
		}
	}
	if (event.type === "result") {
		const result = event as ClaudeResultMessage;
		if (typeof result.num_turns === "number") stats.iterations = result.num_turns;
		if (typeof result.total_cost_usd === "number") stats.cost = result.total_cost_usd;
		onStatsChange();
		return result;
	}
	onStatsChange();
	return undefined;
}

/** Extracts visible assistant text from a pi JSON message. */
function getPiMessageText(message: Record<string, any> | undefined): string | undefined {
	if (message?.role !== "assistant") return undefined;
	if (typeof message.content === "string") return message.content.trim() || undefined;
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content
		.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
	return text || undefined;
}

/** Records one JSON event emitted by a non-interactive pi CLI run. */
function processPiCliEvent(
	event: Record<string, any>,
	state: PiCliRunState,
	stats: AgentRunStats,
	onStatsChange: () => void,
	onAction: (type: AgentAction["type"], toolName?: string, details?: unknown) => void,
): void {
	if (event.type === "turn_start") {
		stats.iterations++;
		onAction("turn_start");
	}
	if (event.type === "tool_execution_start") {
		stats.actions++;
		const args = event.args ?? {};
		if (["read", "grep", "find", "ls"].includes(event.toolName) && typeof args.path === "string") {
			stats.filesRead.add(args.path);
		}
		if (["edit", "write"].includes(event.toolName) && typeof args.path === "string") {
			stats.filesEdited.add(args.path);
		}
		onAction("tool_start", event.toolName, args);
	}
	if (event.type === "tool_execution_end") {
		onAction("tool_end", event.toolName, { isError: event.isError, result: event.result });
	}
	if (event.type === "message_end") {
		state.finalText = getPiMessageText(event.message) ?? state.finalText;
		stats.cost += event.message?.usage?.cost?.total ?? 0;
		if (event.message?.stopReason === "error" && typeof event.message.errorMessage === "string") {
			state.error = event.message.errorMessage;
		}
	}
	if (event.type === "agent_end" && Array.isArray(event.messages)) {
		for (const message of event.messages) {
			state.finalText = getPiMessageText(message) ?? state.finalText;
		}
	}
	onStatsChange();
}

/** Runs Cursor-backed models through pi exactly as a non-interactive user invocation. */
async function runCursorCliSubAgent(
	task: SubAgentTask,
	modelConfig: PiAgentModel,
	ctx: ExtensionContext,
	stats: AgentRunStats,
	onStatsChange: () => void,
	onControllerReady: (controller: RunningAgentController) => void,
	onAction: (type: AgentAction["type"], toolName?: string, details?: unknown) => void,
): Promise<{ ok: boolean; name: string; output: string }> {
	const args = [
		"--model", `${modelConfig.provider}/${modelConfig.model}`,
		"--thinking", task.reasoningLevel,
		"--cursor-mode", "agent",
		"--cursor-no-local-resume",
		"--no-session",
		"--mode", "json",
		"--print",
		"--exclude-tools", "parallel_agents,parallel_agents_control,ask_user_questions,ask_question",
		buildSubAgentPrompt(task, modelConfig),
	];
	const child: ChildProcessWithoutNullStreams = spawn("pi", args, {
		cwd: ctx.cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	onControllerReady({ abort: () => { if (!child.killed) child.kill("SIGTERM"); } });
	debugLog("cursor-cli-sub-agent-start", {
		name: task.name,
		model: `${modelConfig.provider}/${modelConfig.model}`,
		reasoningLevel: task.reasoningLevel,
	});

	const state: PiCliRunState = {};
	let stdoutBuffer = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		const lines = stdoutBuffer.split(/\r?\n/);
		stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				processPiCliEvent(JSON.parse(line), state, stats, onStatsChange, onAction);
			} catch (error) {
				debugLog("cursor-cli-stream-parse-failed", { line: line.slice(0, 2_000), error: String(error) });
			}
		}
	});
	child.stderr.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-8_000);
	});
	child.stdin.end();

	const exitCode = await new Promise<number>((resolve, reject) => {
		child.once("error", (error) => reject(new Error(`Could not start pi CLI: ${error.message}`)));
		child.once("close", (code) => resolve(code ?? -1));
	});
	if (stdoutBuffer.trim()) {
		try {
			processPiCliEvent(JSON.parse(stdoutBuffer), state, stats, onStatsChange, onAction);
		} catch (error) {
			debugLog("cursor-cli-final-stream-parse-failed", { line: stdoutBuffer.slice(0, 2_000), error: String(error) });
		}
	}
	if (stats.status === "cancelled") {
		return { ok: false, name: task.name ?? modelConfig.name, output: "Cancelled." };
	}
	if (exitCode !== 0 || state.error) {
		stats.status = "failed";
		const message = state.error || stderr.trim() || `pi CLI exited with code ${exitCode}`;
		onAction("failed", undefined, message);
		onStatsChange();
		throw new Error(message);
	}

	stats.status = "done";
	onAction("completed", undefined, { model: `${modelConfig.provider}/${modelConfig.model}` });
	onStatsChange();
	const output = state.finalText ?? "(Cursor sub-agent completed without a final text response)";
	debugLog("cursor-cli-sub-agent-done", { name: task.name ?? modelConfig.name, output });
	return { ok: true, name: task.name ?? modelConfig.name, output };
}

/** Runs an isolated task through the installed Claude Code CLI. */
async function runClaudeCodeSubAgent(
	task: SubAgentTask,
	modelConfig: ClaudeCodeAgentModel,
	ctx: ExtensionContext,
	stats: AgentRunStats,
	onStatsChange: () => void,
	onControllerReady: (controller: RunningAgentController) => void,
	onAction: (type: AgentAction["type"], toolName?: string, details?: unknown) => void,
): Promise<{ ok: boolean; name: string; output: string }> {
	const args = [
		"--safe-mode",
		"-p",
		"--output-format", "stream-json",
		"--verbose",
		"--no-session-persistence",
		"--prompt-suggestions", "false",
		"--model", modelConfig.model,
		"--effort", task.reasoningLevel,
		"--tools", CLAUDE_TOOLS,
		"--allowedTools", CLAUDE_TOOLS,
		"--permission-mode", "dontAsk",
	];
	const child: ChildProcessWithoutNullStreams = spawn(CLAUDE_COMMAND, args, {
		cwd: ctx.cwd,
		env: createClaudeSubscriptionEnvironment(),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	onControllerReady({ abort: () => { if (!child.killed) child.kill("SIGTERM"); } });
	debugLog("claude-sub-agent-start", { name: task.name, model: modelConfig.model, reasoningLevel: task.reasoningLevel });

	let resultMessage: ClaudeResultMessage | undefined;
	let stdoutBuffer = "";
	let stderr = "";
	const toolNames = new Map<string, string>();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		const lines = stdoutBuffer.split(/\r?\n/);
		stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as Record<string, any>;
				resultMessage = processClaudeEvent(parsed, stats, onStatsChange, onAction, toolNames) ?? resultMessage;
			} catch (error) {
				debugLog("claude-stream-parse-failed", { line: line.slice(0, 2_000), error: String(error) });
			}
		}
	});
	child.stderr.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-8_000);
	});

	const completion = new Promise<number>((resolve, reject) => {
		child.once("error", (error) => reject(new Error(`Could not start Claude Code: ${error.message}`)));
		child.once("close", (code) => resolve(code ?? -1));
	});
	child.stdin.end(buildSubAgentPrompt(task, modelConfig));

	try {
		const exitCode = await completion;
		if (stats.status === "cancelled") return { ok: false, name: task.name ?? modelConfig.name, output: "Cancelled." };
		if (stdoutBuffer.trim()) {
			try {
				const parsed = JSON.parse(stdoutBuffer) as Record<string, any>;
				resultMessage = processClaudeEvent(parsed, stats, onStatsChange, onAction, toolNames) ?? resultMessage;
			} catch (error) {
				debugLog("claude-final-stream-parse-failed", { line: stdoutBuffer.slice(0, 2_000), error: String(error) });
			}
		}
		if (exitCode !== 0 || !resultMessage || resultMessage.subtype !== "success" || resultMessage.is_error === true) {
			const errors = resultMessage?.errors?.join("; ");
			const denials = resultMessage?.permission_denials?.length
				? ` Permission denials: ${JSON.stringify(resultMessage.permission_denials)}`
				: "";
			throw new Error(errors || `${stderr.trim() || "Claude Code did not return a successful result."}${denials} (exit ${exitCode})`);
		}
		stats.status = "done";
		onAction("completed", undefined, { models: Object.keys(resultMessage.modelUsage ?? {}) });
		onStatsChange();
		const output = resultMessage.result?.trim() || "(Claude Code completed without a final text response)";
		debugLog("claude-sub-agent-done", { name: task.name ?? modelConfig.name, output });
		return { ok: true, name: task.name ?? modelConfig.name, output };
	} catch (error) {
		const wasCancelled = stats.status === "cancelled";
		stats.status = wasCancelled ? "cancelled" : "failed";
		onAction(wasCancelled ? "cancelled" : "failed", undefined, error instanceof Error ? error.message : String(error));
		onStatsChange();
		debugLog("claude-sub-agent-failed", { name: task.name ?? modelConfig.name, error: error instanceof Error ? error.stack ?? error.message : String(error) });
		throw error;
	}
}

/** Selects the configured execution backend for one sub-agent task. */
function runSubAgent(
	task: SubAgentTask,
	modelConfig: AgentModel,
	config: ParallelAgentsConfig,
	ctx: ExtensionContext,
	stats: AgentRunStats,
	onStatsChange: () => void,
	onControllerReady: (controller: RunningAgentController) => void,
	onAction: (type: AgentAction["type"], toolName?: string, details?: unknown) => void,
): Promise<{ ok: boolean; name: string; output: string }> {
	if (modelConfig.backend === "claude-code") {
		return runClaudeCodeSubAgent(task, modelConfig, ctx, stats, onStatsChange, onControllerReady, onAction);
	}
	if (modelConfig.provider === "cursor") {
		return runCursorCliSubAgent(task, modelConfig, ctx, stats, onStatsChange, onControllerReady, onAction);
	}
	return runPiSubAgent(task, modelConfig, config, ctx, stats, onStatsChange, onControllerReady, onAction);
}

/** Formats bounded report chunks so the parent can retrieve long reports without loading all of them at once. */
function formatResults(
	results: Array<{ ok: boolean; name: string; output: string }>,
	reportRegion?: { start: number; end: number },
): string {
	return results
		.map((result, index) => {
			const status = result.ok ? "OK" : "ERROR";
			const start = Math.min(reportRegion?.start ?? 0, result.output.length);
			const requestedEnd = reportRegion?.end === undefined
				? start + MAX_SUB_AGENT_RESULT_CHARS - 1
				: Math.min(reportRegion.end, start + MAX_SUB_AGENT_RESULT_CHARS - 1);
			const end = Math.min(requestedEnd + 1, result.output.length);
			const output = result.output.slice(start, end);
			const range = result.output.length > 0 ? `${start}-${Math.max(start, end - 1)}` : "empty";
			const remaining = end < result.output.length
				? `\n\n[Showing report characters ${range} of ${result.output.length}. Use parallel_agents_control read_results with reportRegion { start: ${end}, end: ${end + MAX_SUB_AGENT_RESULT_CHARS - 1} } for the next chunk.]`
				: "";
			return `## ${index + 1}. ${result.name} [${status}] · report ${range}/${result.output.length}\n\n${output}${remaining}`;
		})
		.join("\n\n---\n\n");
}

/** Waits for a background run without cancelling it when the caller times out or aborts. */
async function waitForRun(
	run: ParallelAgentRun,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
): Promise<"completed" | "timed_out" | "aborted"> {
	if (run.results) return "completed";

	let timeout: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | undefined;
	const timeoutPromise = timeoutSeconds === undefined
		? new Promise<"timed_out">(() => {})
		: new Promise<"timed_out">((resolve) => {
			timeout = setTimeout(() => resolve("timed_out"), timeoutSeconds * 1_000);
		});
	const abortPromise = new Promise<"aborted">((resolve) => {
		if (signal?.aborted) resolve("aborted");
		else if (signal) {
			abortHandler = () => resolve("aborted");
			signal.addEventListener("abort", abortHandler, { once: true });
		}
	});

	try {
		return await Promise.race([run.completion.then(() => "completed" as const), timeoutPromise, abortPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
	}
}

/** Formats a recorded sub-agent action for both model context and the interactive transcript. */
function formatRecordedAction(action: AgentAction): string {
	const tool = action.toolName ? `\n   Tool: ${action.toolName}` : "";
	const parameters = action.type === "tool_start" && action.details ? `\n   Parameters: ${action.details}` : "";
	const details = action.type !== "tool_start" && action.details ? `\n   Details: ${action.details}` : "";
	return `${action.index}. ${action.agent} ${action.type}${tool}${parameters}${details}`;
}

async function selectPiAgentModel(ctx: ExtensionContext): Promise<PiAgentModel | undefined> {
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify("No authenticated models available. Use /login or configure API keys first.", "error");
		return undefined;
	}
	const providers = [...new Set(available.map((model) => model.provider))].sort();
	const provider = await ctx.ui.select("Select provider", providers);
	if (!provider) return undefined;
	const providerModels = available.filter((model) => model.provider === provider).sort((a, b) => a.id.localeCompare(b.id));
	const modelId = await ctx.ui.select(`Select model (${provider})`, providerModels.map((model) => model.id));
	if (!modelId) return undefined;
	const description = await ctx.ui.input("What is this model good at?", "");
	if (!description?.trim()) return undefined;
	return { name: modelId, backend: "pi", provider, model: modelId, description: description.trim(), enabled: true };
}

/** Collects a Claude Code alias or full model ID and its agent-facing routing metadata. */
async function selectClaudeCodeModel(ctx: ExtensionContext): Promise<ClaudeCodeAgentModel | undefined> {
	const customChoice = "Custom model ID…";
	const selected = await ctx.ui.select("Select Claude Code model", [...CLAUDE_MODEL_ALIASES, customChoice]);
	if (!selected) return undefined;
	const model = selected === customChoice
		? (await ctx.ui.input("Claude Code model ID or alias", ""))?.trim()
		: selected;
	if (!model) return undefined;
	const defaultName = `claude-${model}`;
	const name = (await ctx.ui.input("Configured parallel-agent name", defaultName))?.trim();
	if (!name) return undefined;
	const description = await ctx.ui.input("What is this model good at?", "");
	if (!description?.trim()) return undefined;
	return { name, backend: "claude-code", model, description: description.trim(), enabled: true };
}

export default function parallelAgentsExtension(pi: ExtensionAPI) {
	const sessionCostByModel = new Map<string, number>();
	const runs = new Map<string, ParallelAgentRun>();
	const progressWidgetKeys = new Set<string>();
	let nextRunId = 1;

	/** Displays estimated API-equivalent sub-agent usage separately from the main model. */
	const renderCostStatus = (ctx: ExtensionContext) => {
		const costs = [...sessionCostByModel.entries()].filter(([, cost]) => cost > 0);
		if (costs.length === 0) {
			ctx.ui.setStatus("parallel-agent-cost", undefined);
			return;
		}
		const total = costs.reduce((sum, [, cost]) => sum + cost, 0);
		const byModel = costs.map(([model, cost]) => `${model} $${cost.toFixed(4)}`).join(" · ");
		ctx.ui.setStatus("parallel-agent-cost", ctx.ui.theme.fg("dim", `subagents est. $${total.toFixed(4)} · ${byModel}`));
	};

	pi.registerTool({
		name: "parallel_agents",
		label: "Parallel Agents",
		description: "Run multiple isolated sub-agents concurrently. Every task selects a configured model, a required low/medium/high reasoning level, and a detailed prompt. To make a task read-only, explicitly instruct its sub-agent never to edit files, mutate the repository, or perform any other state-changing action. Blocks until all sub-agents finish.",
		promptSnippet: "Spawn isolated parallel sub-agents with per-task models and reasoning levels.",
		promptGuidelines: [
			"Use parallel_agents when independent research or implementation tasks can run concurrently.",
			"parallel_agents requires every task to specify a configured model and a low, medium, or high reasoning level.",
			"For read-only parallel_agents tasks, explicitly state in the task prompt that the sub-agent must never edit files, mutate the repository, or perform other state-changing actions.",
			"For parallel_agents tasks that may edit, assign non-overlapping files or directories to concurrent sub-agents.",
		],
		parameters: PARALLEL_AGENTS_SCHEMA,
		async execute(_toolCallId, params: ParallelAgentsInput, _signal, onUpdate, ctx) {
			const config = loadConfig();
			if (config.models.length === 0) throw new Error(`No parallel-agent models configured in ${CONFIG_PATH}.`);
			if (params.tasks.length === 0) throw new Error("No sub-agent tasks provided.");
			if (params.tasks.length > config.maxParallelAgents) {
				throw new Error(`Requested ${params.tasks.length} sub-agents, but maxParallelAgents is ${config.maxParallelAgents} in ${CONFIG_PATH}.`);
			}
			const unavailable = params.tasks.map((task) => task.model).filter((name) => !findEnabledModel(config, name));
			if (unavailable.length > 0) throw new Error(`Unknown or disabled parallel-agent model(s): ${[...new Set(unavailable)].join(", ")}.`);
			const selectedModels = params.tasks.map((task) => findEnabledModel(config, task.model)!);
			if (selectedModels.some((model) => model.backend === "claude-code")) {
				onUpdate?.({ content: [{ type: "text", text: "Verifying first-party Claude subscription authentication..." }], details: {} });
				await verifyClaudeSubscriptionAuth(
					ctx.cwd,
					selectedModels.filter((model): model is ClaudeCodeAgentModel => model.backend === "claude-code"),
				);
			}

			const stats: AgentRunStats[] = params.tasks.map((task) => ({
				name: task.name ?? task.model,
				model: task.model,
				reasoningLevel: task.reasoningLevel,
				status: "active",
				iterations: 0,
				actions: 0,
				cost: 0,
				filesRead: new Set<string>(),
				filesEdited: new Set<string>(),
			}));
			const runId = `parallel-${nextRunId++}`;
			const progressWidgetKey = `parallel-agents:${runId}`;
			progressWidgetKeys.add(progressWidgetKey);
			const renderStats = () => {
				const lines = stats.map((stat) => {
					const reasoningColor = getReasoningColor(stat.reasoningLevel);
					const icon = stat.status === "active"
						? ctx.ui.theme.fg(reasoningColor, "●")
						: stat.status === "done" ? ctx.ui.theme.fg("success", "✓") : ctx.ui.theme.fg("error", "✗");
					const identity = ctx.ui.theme.fg(
						reasoningColor,
						`${stat.name} (${stat.model}, ${stat.reasoningLevel})`,
					);
					const counts = `${stat.iterations} iterations · ${stat.filesRead.size} read · ${stat.filesEdited.size} edited · ${stat.actions} actions`;
					return `${icon} ${identity} ${ctx.ui.theme.fg("dim", counts)}`;
				});
				ctx.ui.setWidget(progressWidgetKey, [ctx.ui.theme.fg("accent", `Parallel sub-agents · ${runId}`), ...lines]);
			};
			renderStats();
			onUpdate?.({ content: [{ type: "text", text: `Starting ${params.tasks.length} parallel sub-agent(s)...` }], details: {} });
			const reportedCosts = stats.map(() => 0);
			const updateStatsAndCosts = (index: number) => {
				const costDelta = stats[index].cost - reportedCosts[index];
				if (costDelta !== 0) {
					sessionCostByModel.set(stats[index].model, (sessionCostByModel.get(stats[index].model) ?? 0) + costDelta);
					reportedCosts[index] = stats[index].cost;
					renderCostStatus(ctx);
				}
				renderStats();
			};
			const run: ParallelAgentRun = { id: runId, tasks: params.tasks, stats, actions: [], controllers: [], cancelRequested: new Set(), completion: Promise.resolve([]) };
			runs.set(runId, run);
			const settled = Promise.allSettled(params.tasks.map((task, index) => runSubAgent(
				task, selectedModels[index], config, ctx, stats[index], () => updateStatsAndCosts(index),
				(controller) => { run.controllers[index] = controller; if (run.cancelRequested.has(index)) void controller.abort(); },
				(type, toolName, details) => run.actions.push({ index: run.actions.length, timestamp: Date.now(), agent: stats[index].name, type, toolName, details: formatActionDetails(details) }),
			)));
			run.completion = settled.then((items) => {
				const results = items.map((item, index) => {
					if (item.status === "fulfilled") return item.value;
					if (stats[index].status === "active") stats[index].status = "failed";
					return { ok: false, name: params.tasks[index].name ?? params.tasks[index].model, output: item.reason instanceof Error ? item.reason.message : String(item.reason) };
				});
				run.results = results;
				renderStats();
				setTimeout(() => {
					ctx.ui.setWidget(progressWidgetKey, undefined);
					progressWidgetKeys.delete(progressWidgetKey);
				}, 1500);
				return results;
			});
			if (params.blocking === false) return { content: [{ type: "text", text: `Started ${params.tasks.length} background sub-agent(s). Run ID: ${runId}. Use parallel_agents_control to inspect, wait, read actions, or cancel.` }], details: { runId } };
			const results = await run.completion;
			return { content: [{ type: "text", text: formatResults(results) }], details: { runId, results } };
		},
	});


	pi.registerTool({
		name: "parallel_agents_control",
		label: "Parallel Agents Control",
		description: "Inspect, wait for, read recent or explicitly ranged recorded actions, read bounded chunks of completed sub-agent reports, or cancel a background parallel_agents run. read_actions returns only the four newest actions by default; use readRegion for an explicit action-index range. Use read_results with reportRegion to retrieve a long report in 4,000-character chunks. The wait action accepts timeoutSeconds for a bounded wait and never cancels sub-agents when it expires.",
		parameters: PARALLEL_AGENTS_CONTROL_SCHEMA,
		renderCall(args, theme) {
			const timeout = typeof args.timeoutSeconds === "number" ? ` · timeout ${args.timeoutSeconds}s` : "";
			return new Text(theme.fg("toolTitle", theme.bold(`parallel_agents_control · ${args.action}`)) + theme.fg("dim", ` · ${args.runId}${timeout}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "Waiting for background sub-agents…"), 0, 0);
			const actions = (result.details as { actions?: AgentAction[] } | undefined)?.actions;
			if (actions) {
				const heading = theme.fg("accent", "Recorded sub-agent tool calls");
				const body = actions.length > 0
					? actions.map(formatRecordedAction).join("\n")
					: "No recorded actions in this segment.";
				return new Text(`${heading}\n${body}`, 0, 0);
			}
			const content = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			return new Text(content || theme.fg("dim", "Control action completed."), 0, 0);
		},
		async execute(_toolCallId, params: ParallelAgentsControlInput, signal) {
			const run = runs.get(params.runId);
			if (!run) throw new Error(`Unknown parallel-agent run ID: ${params.runId}.`);
			const indexes = params.agents?.length ? run.stats.flatMap((stat, index) => params.agents!.includes(stat.name) ? [index] : []) : run.stats.map((_stat, index) => index);
			if (indexes.length === 0) throw new Error("No matching task names in this run.");
			if (params.action === "status") return { content: [{ type: "text", text: indexes.map((index) => `${run.stats[index].name}: ${run.stats[index].status}; ${run.stats[index].actions} actions`).join("\n") }], details: { runId: run.id } };
			if (params.action === "wait") {
				const outcome = await waitForRun(run, params.timeoutSeconds, signal);
				if (outcome === "timed_out") {
					return { content: [{ type: "text", text: `Wait timed out; background sub-agents are still running.\n\n${indexes.map((index) => `${run.stats[index].name}: ${run.stats[index].status}`).join("\n")}` }], details: { runId: run.id, waitTimedOut: true } };
				}
				if (outcome === "aborted") {
					return { content: [{ type: "text", text: "Wait cancelled; background sub-agents were not stopped." }], details: { runId: run.id, waitCancelled: true } };
				}
				const results = run.results!;
				return { content: [{ type: "text", text: formatResults(indexes.map((index) => results[index])) }], details: { runId: run.id } };
			}
			if (params.action === "read_results") {
				if (params.reportRegion && params.reportRegion.end < params.reportRegion.start) {
					throw new Error("reportRegion.end must be greater than or equal to reportRegion.start.");
				}
				if (!run.results) {
					return { content: [{ type: "text", text: "Sub-agent reports are not available until the run completes. Use action wait or status first." }], details: { runId: run.id, status: "running" } };
				}
				const results = indexes.map((index) => run.results![index]);
				return {
					content: [{ type: "text", text: formatResults(results, params.reportRegion) }],
					details: { runId: run.id, reportRegion: params.reportRegion },
				};
			}
			if (params.action === "read_actions") {
				if (params.readRegion && params.readRegion.end < params.readRegion.start) {
					throw new Error("readRegion.end must be greater than or equal to readRegion.start.");
				}
				const matchingActions = run.actions.filter((entry) => indexes.some((index) => run.stats[index].name === entry.agent));
				const actions = params.readRegion
					? matchingActions.filter((entry) => entry.index >= params.readRegion!.start && entry.index <= params.readRegion!.end)
					: params.offset !== undefined || params.limit !== undefined
						? matchingActions.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 20))
						: matchingActions.slice(-4);
				return {
					content: [{ type: "text", text: actions.length ? actions.map(formatRecordedAction).join("\n") : "No recorded actions in this region." }],
					details: { runId: run.id, readRegion: params.readRegion, totalActions: matchingActions.length, actions },
				};
			}
			if (params.action === "cancel") { await Promise.all(indexes.map(async (index) => { if (run.stats[index].status !== "active") return; run.cancelRequested.add(index); run.stats[index].status = "cancelled"; run.actions.push({ index: run.actions.length, timestamp: Date.now(), agent: run.stats[index].name, type: "cancelled", details: "Cancellation requested." }); await run.controllers[index]?.abort(); })); return { content: [{ type: "text", text: `Cancellation requested for ${indexes.map((index) => run.stats[index].name).join(", ")}.` }], details: { runId: run.id } }; }
			throw new Error("action must be status, wait, read_actions, read_results, or cancel.");
		},
	});

	pi.registerCommand("parallel-agents", {
		description: "Manage parallel sub-agent models",
		handler: async (_args, ctx) => {
			const config = loadConfig();
			while (true) {
				const action = await ctx.ui.select("Parallel agents", ["List models", "Add pi model", "Add Claude Code model", "Check Claude Code subscription auth", "Edit description", "Enable or disable model", "Delete model", `Set max parallel agents (current ${config.maxParallelAgents})`, "Show config path", "Done"]);
				if (!action || action === "Done") break;
				if (action === "List models") {
					const list = config.models.map((model) => `- ${model.name} [${model.enabled ? "enabled" : "disabled"}] (${formatModelBackend(model)}): ${model.description}`).join("\n");
					ctx.ui.notify(list || "No models configured.", "info");
				} else if (action === "Add pi model" || action === "Add Claude Code model") {
					const model = action === "Add pi model"
						? await selectPiAgentModel(ctx)
						: await selectClaudeCodeModel(ctx);
					if (model) {
						config.models = [...config.models.filter((entry) => entry.name !== model.name), model];
						saveConfig(config);
						ctx.ui.notify(`Saved model ${model.name}`, "info");
					}
				} else if (action === "Check Claude Code subscription auth") {
					try {
						await verifyClaudeSubscriptionAuth(ctx.cwd);
						ctx.ui.notify("Claude Code is using first-party claude.ai subscription authentication.", "info");
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
				} else if (action === "Edit description") {
					const selected = await ctx.ui.select("Select model", config.models.map((model) => model.name));
					const model = selected ? findModel(config, selected) : undefined;
					if (!model) continue;
					const description = await ctx.ui.input("What is this model good at?", model.description);
					if (!description?.trim()) continue;
					model.description = description.trim();
					saveConfig(config);
				} else if (action === "Enable or disable model") {
					const selected = await ctx.ui.select("Select model", config.models.map((model) => `${model.name} [${model.enabled ? "enabled" : "disabled"}]`));
					const name = selected?.replace(/ \[(?:enabled|disabled)\]$/, "");
					const model = name ? findModel(config, name) : undefined;
					if (!model) continue;
					model.enabled = !model.enabled;
					saveConfig(config);
					ctx.ui.notify(`${model.name} is now ${model.enabled ? "enabled" : "disabled"}.`, "info");
				} else if (action === "Delete model") {
					const selected = await ctx.ui.select("Delete model", config.models.map((model) => model.name));
					if (selected) {
						config.models = config.models.filter((model) => model.name !== selected);
						saveConfig(config);
					}
				} else if (action.startsWith("Set max")) {
					const value = await ctx.ui.input("Max parallel agents", String(config.maxParallelAgents));
					const parsed = Number(value);
					if (Number.isFinite(parsed) && parsed > 0) {
						config.maxParallelAgents = Math.floor(parsed);
						saveConfig(config);
					} else if (value) ctx.ui.notify("Enter a positive number", "warning");
				} else if (action === "Show config path") ctx.ui.notify(CONFIG_PATH, "info");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCostByModel.clear();
		ctx.ui.setWidget("parallel-agents", undefined);
		for (const key of progressWidgetKeys) ctx.ui.setWidget(key, undefined);
		progressWidgetKeys.clear();
		ctx.ui.setStatus("parallel-agent-cost", undefined);
		const config = loadConfig();
		const enabledCount = config.models.filter((model) => model.enabled).length;
		ctx.ui.setStatus("parallel-agents", ctx.ui.theme.fg("dim", `subagents:${enabledCount}/${config.models.length}`));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const key of progressWidgetKeys) ctx.ui.setWidget(key, undefined);
		progressWidgetKeys.clear();
		await Promise.all([...runs.values()].map((run) => Promise.all(run.controllers.map(async (controller, index) => {
			if (controller && run.stats[index].status === "active") {
				run.cancelRequested.add(index);
				run.stats[index].status = "cancelled";
				await controller.abort();
			}
		}))));
		runs.clear();
	});

	pi.on("before_agent_start", (event) => {
		const models = loadConfig().models.filter((model) => model.enabled);
		if (models.length === 0) return;
		const entries = models.map((model) => `- ${model.name}: ${model.description}`).join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\nConfigured parallel_agents models:\n${entries}` };
	});
}
