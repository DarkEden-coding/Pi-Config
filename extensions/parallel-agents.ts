import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { loadToolReviewConfig, terminalToolReviewExtension } from "./tool-review.ts";
import { AgentActivityLog } from "./lib/parallel-agent-activity.ts";
import { AgentSteeringController, MAX_STEERING_MESSAGE_CHARS } from "./lib/parallel-agent-steering.ts";

type ThinkingLevel = "low" | "medium" | "high";

interface AgentModel {
	provider: string;
	name: string;
	model: string;
	description: string;
	enabled: boolean;
}

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
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Unique task name within this run. Defaults to the configured model name; name tasks explicitly when reusing a model." })),
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
		description: "Whether to wait for all sub-agents before returning. Defaults to true. Set false to continue working and use parallel_agents_control with the returned runId to inspect, steer, wait for, or cancel the run.",
	})),
});

const PARALLEL_AGENTS_CONTROL_SCHEMA = Type.Object({
	action: Type.String({
		description: "One of: status, wait, read_actions (compact tool activity), read_action_details (explicit argument/result detail), read_results, steer (queue a correction for named agents), or cancel.",
	}),
	runId: Type.String({ description: "Run ID returned from a non-blocking parallel_agents call." }),
	agents: Type.Optional(Type.Array(Type.String(), {
		description: "Task names to select. Required and nonempty for steer; otherwise omit for all. Unknown names are errors. Wait always waits for the complete run.",
	})),
	readRegion: Type.Optional(Type.Object({
		start: Type.Integer({ minimum: 0, description: "First recorded action index to include (inclusive)." }),
		end: Type.Integer({ minimum: 0, description: "Last recorded action index to include (inclusive)." }),
	}, {
		description: "For read_actions: inclusive activity change indexes. Responses remain bounded. Omit after and readRegion for the four newest events; tool starts/ends in the page are combined.",
	})),
	reportRegion: Type.Optional(Type.Object({
		start: Type.Integer({ minimum: 0, description: "First report character offset to include (inclusive)." }),
		end: Type.Integer({ minimum: 0, description: "Last report character offset to include (inclusive)." }),
	}, {
		description: "For read_results: an explicit inclusive character range from each selected sub-agent report. Each call returns at most 4,000 characters per report; make another call for later text.",
	})),
	after: Type.Optional(Type.Integer({ minimum: -1, description: "For read_actions: return changes after this cursor, oldest first. Start with -1; reuse nextCursor with the same agents filter. Tool completion receives a new index." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "For read_actions: maximum events scanned, up to 20 and a 4,000-character total response budget." })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Deprecated: offset in filtered activity events. Prefer after for incremental reads." })),
	actionIndex: Type.Optional(Type.Integer({ minimum: 0, description: "For read_action_details: activity index from the compact feed. Details retain at most 64,000 characters per event." })),
	detailRegion: Type.Optional(Type.Object({
		start: Type.Integer({ minimum: 0 }),
		end: Type.Integer({ minimum: 0 }),
	}, { description: "For read_action_details: inclusive character range within retained detail; each response is capped at 4,000 characters." })),
	message: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_STEERING_MESSAGE_CHARS, description: "For steer: a literal correction. Queued for the next turn boundary, not an interrupt or proof of compliance." })),
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

type ParallelAgentRun = {
	id: string;
	tasks: SubAgentTask[];
	stats: AgentRunStats[];
	activity: AgentActivityLog;
	controllers: Array<AgentSteeringController | undefined>;
	results?: Array<{ ok: boolean; name: string; output: string }>;
	completion: Promise<Array<{ ok: boolean; name: string; output: string }>>;
};

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

/** Creates the user configuration directory before persistence. */
function ensureConfigDir(): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

/** Loads configured native Pi models and their tool allowlist. */
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

/** Persists the model configuration edited through the management command. */
function saveConfig(config: ParallelAgentsConfig): void {
	ensureConfigDir();
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** Rejects malformed entries and removed external harness configurations. */
function isModelLike(value: unknown): boolean {
	const model = value as Record<string, unknown> | undefined;
	if (
		!model ||
		typeof model.name !== "string" ||
		typeof model.model !== "string" ||
		typeof model.description !== "string" ||
		(model.enabled !== undefined && typeof model.enabled !== "boolean")
	) return false;
	return (model.backend === undefined || model.backend === "pi") &&
		typeof model.provider === "string" && model.provider !== "cursor";
}

/** Loads only the fields needed by native Pi sessions. */
function normalizeModel(value: unknown): AgentModel {
	const model = value as Record<string, unknown>;
	return {
		provider: model.provider as string,
		name: model.name as string,
		model: model.model as string,
		description: model.description as string,
		enabled: model.enabled !== false,
	};
}

/** Finds a model by its configured task-facing name. */
function findModel(config: ParallelAgentsConfig, name: string): AgentModel | undefined {
	return config.models.find((model) => model.name === name);
}

/** Resolves only models enabled for task execution. */
function findEnabledModel(config: ParallelAgentsConfig, name: string): AgentModel | undefined {
	const model = findModel(config, name);
	return model?.enabled ? model : undefined;
}

/** Combines native coding tools with explicitly allowed extension tools. */
function taskTools(allowedExtensionTools: string[]): string[] {
	const builtins = ["read", "grep", "find", "ls", "write", "edit", "bash"];
	return [...new Set([...builtins, ...allowedExtensionTools])];
}

/** Identifies models requiring the existing edit-argument compatibility instructions. */
function isKimiModel(model: AgentModel): boolean {
	return `${model.provider}/${model.model}`.toLowerCase().includes("kimi");
}

/** Formats the native provider and model for management UI. */
function formatModelBackend(model: AgentModel): string {
	return `${model.provider}/${model.model}`;
}

/** Writes lifecycle diagnostics without recording tool bodies or entire reports. */
function debugLog(message: string, details?: unknown): void {
	try {
		ensureConfigDir();
		const suffix = details === undefined ? "" : ` ${JSON.stringify(details, (_key, value) => value instanceof Set ? [...value] : value)}`;
		appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}${suffix}\n`, "utf-8");
	} catch {
		// Debug logging must never break agent execution.
	}
}

/** Builds the isolated task instructions and model-specific tool constraints. */
function buildSubAgentPrompt(task: SubAgentTask, model: AgentModel): string {
	const kimiEditRules = isKimiModel(model)
		? `\n\nKimi/tool-use compatibility rules:\n- The edit tool requires this exact shape: {"path":"relative/or/absolute/path","edits":[{"oldText":"exact unique text copied from the current file","newText":"replacement text"}]}. Do not send oldText/newText at the top level.\n- Always read the target file immediately before an edit and copy oldText verbatim from that read result.\n- If an edit fails once because oldText is not unique or not found, re-read the file and either make a smaller exact edit or use bash with a short python script to rewrite the file deterministically.\n- For risky rewrites, first create an easily reverted backup outside the repo at /tmp/pi-parallel-agent-backups/<timestamp>-<basename>.bak, then report the backup path in your final answer.\n- Do not repeatedly retry the same failing edit arguments.`
		: "";
	return `You are an isolated coding sub-agent running as part of a parallel multi-agent task.\n\nRules:\n- Complete only the task below.\n- Follow all task constraints exactly, including any instruction that the work is read-only and must not edit files, mutate the repository, or perform state-changing actions.\n- If editing is allowed, keep edits focused and touch only files assigned in the task.\n- Do not ask the user questions. If information is missing, state assumptions in the final answer.\n- Avoid interactive commands and tools.\n- Final answer should be concise and directly useful to the main agent.${kimiEditRules}\n\nTask:\n${task.prompt}`;
}

const MAX_SUB_AGENT_RESULT_CHARS = 4_000;

/** Extracts the final visible assistant report without copying its conversation. */
function getFinalAssistantText(session: AgentSession): string {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		const content = msg.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.map((part) => (part.type === "text" ? part.text : ""))
				.filter(Boolean)
				.join("\n");
			if (text) return text;
		}
	}
	return "(sub-agent completed without a final text response)";
}

/** Runs one task in a native Pi session and records compact supervision events. */
async function runPiSubAgent(
	task: SubAgentTask,
	modelConfig: AgentModel,
	config: ParallelAgentsConfig,
	ctx: ExtensionContext,
	stats: AgentRunStats,
	onStatsChange: () => void,
	onControllerReady: (controller: AgentSteeringController) => void,
	activity: AgentActivityLog,
): Promise<{ ok: boolean; name: string; output: string }> {
	// Use the live context model registry instead of creating a fresh one.
	// Provider/model registrations from extensions
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

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, steeringMode: "one-at-a-time" });
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

	const controller = new AgentSteeringController(session, (type, text) => {
		activity.record(stats.name, type, text);
		onStatsChange();
	});
	onControllerReady(controller);
	debugLog("sub-agent-start", { name: task.name, model: modelConfig.name, reasoningLevel: task.reasoningLevel });
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "user") {
			const content = event.message.content;
			controller.observeUserMessage(typeof content === "string" ? content : content
				.filter((part) => part.type === "text").map((part) => part.text).join(""));
		}
		if (event.type === "turn_start") {
			stats.iterations++;
			onStatsChange();
			return;
		}
		if (event.type === "tool_execution_start") {
			stats.actions++;
			const args = event.args as Record<string, unknown>;
			if (event.toolName === "read" && typeof args.path === "string") stats.filesRead.add(args.path);
			if ((event.toolName === "edit" || event.toolName === "write") && typeof args.path === "string") stats.filesEdited.add(args.path);
			activity.startTool(stats.name, event.toolCallId, event.toolName, args);
			onStatsChange();
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			stats.cost += event.message.usage?.cost?.total ?? 0;
			onStatsChange();
			return;
		}
		if (event.type === "tool_execution_end") {
			activity.endTool(stats.name, event.toolCallId, event.toolName, event.result, event.isError);
		}
	});

	try {
		// Cancellation may arrive while the session is still being constructed.
		if (stats.status === "cancelled") return { ok: false, name: stats.name, output: "Cancelled." };
		await session.prompt(buildSubAgentPrompt(task, modelConfig), { source: "extension" });
		// The control tool can change this status while prompt is awaiting completion.
		if ((stats.status as AgentRunStatus) === "cancelled") {
			onStatsChange();
			return { ok: false, name: task.name ?? modelConfig.name, output: "Cancelled." };
		}
		stats.status = "done";
		activity.record(stats.name, "completed");
		onStatsChange();
		const output = getFinalAssistantText(session);
		debugLog("sub-agent-done", { name: task.name ?? modelConfig.name, filesRead: stats.filesRead, filesEdited: stats.filesEdited });
		return { ok: true, name: task.name ?? modelConfig.name, output };
	} catch (error) {
		const wasCancelled = stats.status === "cancelled";
		stats.status = wasCancelled ? "cancelled" : "failed";
		activity.record(stats.name, wasCancelled ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
		onStatsChange();
		debugLog("sub-agent-failed", { name: task.name ?? modelConfig.name, error: error instanceof Error ? error.stack ?? error.message : String(error) });
		throw error;
	} finally {
		controller.finish();
		unsubscribe();
		session.dispose();
	}
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

/** Collects an authenticated native model and its routing description. */
async function selectPiAgentModel(ctx: ExtensionContext): Promise<AgentModel | undefined> {
	const available = ctx.modelRegistry.getAvailable().filter((model) => model.provider !== "cursor");
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
	return { name: modelId, provider, model: modelId, description: description.trim(), enabled: true };
}

/** Registers native sub-agent execution, supervision, and configuration tools. */
export default function parallelAgentsExtension(pi: ExtensionAPI): void {
	const sessionCostByModel = new Map<string, number>();
	const runs = new Map<string, ParallelAgentRun>();
	const progressWidgetKeys = new Set<string>();
	let nextRunId = 1;

	/** Displays estimated API-equivalent sub-agent usage separately from the main model. */
	const renderCostStatus = (ctx: ExtensionContext): void => {
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
		description: "Run multiple isolated sub-agents concurrently. Every task selects a configured model, a required low/medium/high reasoning level, and a detailed prompt. To make a task read-only, explicitly instruct its sub-agent never to edit files, mutate the repository, or perform any other state-changing action. Uses native Pi sessions only. Blocks by default; set blocking=false to supervise and steer while running.",
		promptSnippet: "Spawn isolated parallel sub-agents with per-task models and reasoning levels.",
		promptGuidelines: [
			"Use parallel_agents when independent research or implementation tasks can run concurrently.",
			"parallel_agents requires every task to specify a configured model and a low, medium, or high reasoning level.",
			"For read-only parallel_agents tasks, explicitly state in the task prompt that the sub-agent must never edit files, mutate the repository, or perform other state-changing actions.",
			"For parallel_agents tasks that may edit, assign non-overlapping files or directories to concurrent sub-agents.",
			"Use parallel_agents blocking=false and unique task names to supervise work. Poll parallel_agents_control read_actions with after=nextCursor; steer named agents to correct direction. Steering is queued after current tools, not an emergency stop.",
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
			const names = params.tasks.map((task) => task.name ?? task.model);
			if (names.some((name) => !name.trim() || name.length > 120) || new Set(names).size !== names.length) {
				throw new Error("Task names must be nonempty, at most 120 characters, and unique within a run. Name each task when reusing a model.");
			}
			const selectedModels = params.tasks.map((task) => findEnabledModel(config, task.model)!);

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
			/** Refreshes the task progress widget without adding model context. */
			const renderStats = (): void => {
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
			/** Adds newly reported usage and refreshes progress for one task. */
			const updateStatsAndCosts = (index: number): void => {
				const costDelta = stats[index].cost - reportedCosts[index];
				if (costDelta !== 0) {
					sessionCostByModel.set(stats[index].model, (sessionCostByModel.get(stats[index].model) ?? 0) + costDelta);
					reportedCosts[index] = stats[index].cost;
					renderCostStatus(ctx);
				}
				renderStats();
			};
			const run: ParallelAgentRun = { id: runId, tasks: params.tasks, stats, activity: new AgentActivityLog(), controllers: [], completion: Promise.resolve([]) };
			runs.set(runId, run);
			const settled = Promise.allSettled(params.tasks.map((task, index) => runPiSubAgent(
				task, selectedModels[index], config, ctx, stats[index], () => updateStatsAndCosts(index),
				(controller) => { run.controllers[index] = controller; },
				run.activity,
			)));
			run.completion = settled.then((items) => {
				const results = items.map((item, index) => {
					if (item.status === "fulfilled") return item.value;
					if (stats[index].status === "active") {
						stats[index].status = "failed";
						run.activity.record(stats[index].name, "failed", String(item.reason));
					}
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
			if (params.blocking === false) return { content: [{ type: "text", text: `Started ${params.tasks.length} background sub-agent(s). Run ID: ${runId}. Use parallel_agents_control to inspect, steer, wait, read actions, or cancel.` }], details: { runId } };
			const results = await run.completion;
			return { content: [{ type: "text", text: formatResults(results) }], details: { runId } };
		},
	});


	pi.registerTool({
		name: "parallel_agents_control",
		label: "Parallel Agents Control",
		description: "Supervise native Pi sub-agents: status, wait, read_actions, read_action_details, read_results, steer, cancel. read_actions returns compact tool metadata, no successful outputs or code bodies, capped at 20 events and 4,000 characters. Default: four newest events. Poll with after=nextCursor for changes, using the same agents filter; after=-1 starts at the beginning. read_action_details explicitly pages retained args/results by actionIndex and detailRegion. read_results pages reports with reportRegion. steer requires named agents and a message, queues at the next turn boundary, and records delivery separately from acceptance. Startup/completed agents reject steering. wait timeoutSeconds never cancels agents.",
		parameters: PARALLEL_AGENTS_CONTROL_SCHEMA,
		renderCall(args, theme) {
			const timeout = typeof args.timeoutSeconds === "number" ? ` · timeout ${args.timeoutSeconds}s` : "";
			return new Text(theme.fg("toolTitle", theme.bold(`parallel_agents_control · ${args.action}`)) + theme.fg("dim", ` · ${args.runId}${timeout}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "Waiting for background sub-agents…"), 0, 0);
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
			const unknown = params.agents?.filter((name) => !run.stats.some((stat) => stat.name === name)) ?? [];
			if (unknown.length > 0) throw new Error(`Unknown task names: ${unknown.join(", ")}.`);
			if (params.action === "status") return { content: [{ type: "text", text: indexes.map((index) => `${run.stats[index].name}: ${run.stats[index].status}; ${run.stats[index].actions} actions; ${run.controllers[index]?.pendingCount ?? 0} queued corrections`).join("\n") }], details: { runId: run.id } };
			if (params.action === "steer") {
				if (!params.agents?.length || !params.message) throw new Error("steer requires explicit agents and a nonempty message.");
				const controllers = indexes.map((index) => {
					if (run.stats[index].status !== "active") throw new Error(`${run.stats[index].name} is ${run.stats[index].status}; cannot steer.`);
					const controller = run.controllers[index];
					if (!controller) throw new Error(`${run.stats[index].name} is still starting. Retry after it begins running.`);
					controller.assertCanSteer(params.message!);
					return controller;
				});
				// Report each target separately if a session finishes during multi-agent delivery.
				const receipts = await Promise.allSettled(controllers.map((controller) => controller.steer(params.message!)));
				return {
					content: [{ type: "text", text: receipts.map((receipt, index) => receipt.status === "fulfilled"
						? `${run.stats[indexes[index]].name}: accepted ${receipt.value} into Pi's steering queue. See read_actions for delivery; acceptance does not mean applied.`
						: `${run.stats[indexes[index]].name}: not queued: ${String(receipt.reason)}`).join("\n") }],
					details: { runId: run.id },
				};
			}
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
				const page = run.activity.read({ agents: indexes.map((index) => run.stats[index].name), after: params.after, readRegion: params.readRegion, limit: params.limit, offset: params.offset });
				return { content: [{ type: "text", text: page.text }], details: { runId: run.id, nextCursor: page.nextCursor, hasMore: page.hasMore } };
			}
			if (params.action === "read_action_details") {
				if (params.actionIndex === undefined) throw new Error("read_action_details requires actionIndex.");
				const page = run.activity.readDetails(params.actionIndex, params.detailRegion, indexes.map((index) => run.stats[index].name));
				return { content: [{ type: "text", text: page.text }], details: { runId: run.id } };
			}
			if (params.action === "cancel") {
				await Promise.all(indexes.map(async (index) => {
					if (run.stats[index].status !== "active") return;
					run.stats[index].status = "cancelled";
					run.activity.record(run.stats[index].name, "cancelled", "Cancellation requested.");
					await run.controllers[index]?.abort();
				}));
				return { content: [{ type: "text", text: `Cancellation requested for ${indexes.map((index) => run.stats[index].name).join(", ")}.` }], details: { runId: run.id } };
			}
			throw new Error("action must be status, wait, read_actions, read_action_details, read_results, steer, or cancel.");
		},
	});

	pi.registerCommand("parallel-agents", {
		description: "Manage parallel sub-agent models",
		handler: async (_args, ctx) => {
			const config = loadConfig();
			while (true) {
				const action = await ctx.ui.select("Parallel agents", ["List models", "Add model", "Edit description", "Enable or disable model", "Delete model", `Set max parallel agents (current ${config.maxParallelAgents})`, "Show config path", "Done"]);
				if (!action || action === "Done") break;
				if (action === "List models") {
					const list = config.models.map((model) => `- ${model.name} [${model.enabled ? "enabled" : "disabled"}] (${formatModelBackend(model)}): ${model.description}`).join("\n");
					ctx.ui.notify(list || "No models configured.", "info");
				} else if (action === "Add model") {
					const model = await selectPiAgentModel(ctx);
					if (model) {
						config.models = [...config.models.filter((entry) => entry.name !== model.name), model];
						saveConfig(config);
						ctx.ui.notify(`Saved model ${model.name}`, "info");
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
		await Promise.all([...runs.values()].map((run) => Promise.all(run.stats.map(async (stat, index) => {
			if (stat.status !== "active") return;
			// Include starting agents whose controllers have not been constructed yet.
			stat.status = "cancelled";
			await run.controllers[index]?.abort();
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
