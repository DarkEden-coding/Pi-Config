import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

type ThinkingLevel = "low" | "medium" | "high";

interface AgentModel {
	name: string;
	provider: string;
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
});

type ParallelAgentsInput = Static<typeof PARALLEL_AGENTS_SCHEMA>;
type SubAgentTask = Static<typeof TASK_SCHEMA>;

type AgentRunStatus = "active" | "done" | "failed";

type AgentRunStats = {
	name: string;
	model: string;
	reasoningLevel: ThinkingLevel;
	status: AgentRunStatus;
	actions: number;
	cost: number;
	filesRead: Set<string>;
	filesEdited: Set<string>;
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
				? parsed.models.filter(isModelLike).map((model: AgentModel) => ({ ...model, enabled: model.enabled !== false }))
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

function isModelLike(value: unknown): value is AgentModel {
	const model = value as Partial<AgentModel>;
	return (
		!!model &&
		typeof model.name === "string" &&
		typeof model.provider === "string" &&
		typeof model.model === "string" &&
		typeof model.description === "string" &&
		(model.enabled === undefined || typeof model.enabled === "boolean")
	);
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
	return `${model.provider}/${model.model}`.toLowerCase().includes("kimi");
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
	return `You are a pi sub-agent running as part of a parallel multi-agent task.\n\nRules:\n- Complete only the task below.\n- Follow all task constraints exactly, including any instruction that the work is read-only and must not edit files, mutate the repository, or perform state-changing actions.\n- If editing is allowed, keep edits focused and touch only files assigned in the task.\n- Do not ask the user questions. If information is missing, state assumptions in the final answer.\n- Avoid interactive commands and tools.\n- Final answer should be concise and directly useful to the main agent.${kimiEditRules}\n\nTask:\n${task.prompt}`;
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

async function runSubAgent(
	task: SubAgentTask,
	modelConfig: AgentModel,
	config: ParallelAgentsConfig,
	ctx: ExtensionContext,
	stats: AgentRunStats,
	onStatsChange: () => void,
): Promise<{ ok: boolean; name: string; output: string }> {
	// Use the live context model registry instead of creating a fresh one.
	// Provider/model registrations from extensions (for example cursor/composer-2.5)
	// are applied to ctx.modelRegistry; a new registry only contains built-in/static
	// models and would fail to find extension-provided model entries.
	const modelRegistry = ctx.modelRegistry;
	const model = modelRegistry.find(modelConfig.provider, modelConfig.model);
	if (!model) {
		const available = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`).sort();
		throw new Error(
			`Model ${modelConfig.name} not found: ${modelConfig.provider}/${modelConfig.model}. Available models in active registry: ${available.join(", ") || "(none)"}`,
		);
	}
	if (!modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`Model ${modelConfig.name}: no auth configured for provider ${modelConfig.provider}`);
	}

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } as any });
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: config.allowedExtensionTools.length === 0,
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
		agentDir: getAgentDir(),
		model,
		thinkingLevel: task.reasoningLevel,
		modelRegistry,
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		tools: taskTools(config.allowedExtensionTools),
	});

	debugLog("sub-agent-start", { name: task.name, model: modelConfig.name, reasoningLevel: task.reasoningLevel });
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "tool_execution_start") {
			stats.actions++;
			const args = event.args ?? {};
			if (event.toolName === "read" && typeof args.path === "string") stats.filesRead.add(args.path);
			if ((event.toolName === "edit" || event.toolName === "write") && typeof args.path === "string") stats.filesEdited.add(args.path);
			debugLog("tool-start", { agent: task.name ?? modelConfig.name, tool: event.toolName, args });
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
		}
	});

	try {
		await session.prompt(buildSubAgentPrompt(task, modelConfig), { source: "extension" as any });
		stats.status = "done";
		onStatsChange();
		const output = getFinalAssistantText(session);
		debugLog("sub-agent-done", { name: task.name ?? modelConfig.name, filesRead: stats.filesRead, filesEdited: stats.filesEdited, output });
		return { ok: true, name: task.name ?? modelConfig.name, output };
	} catch (error) {
		stats.status = "failed";
		onStatsChange();
		debugLog("sub-agent-failed", { name: task.name ?? modelConfig.name, error: error instanceof Error ? error.stack ?? error.message : String(error) });
		throw error;
	} finally {
		unsubscribe();
		session.dispose();
	}
}

function formatResults(results: Array<{ ok: boolean; name: string; output: string }>): string {
	return results
		.map((result, index) => {
			const status = result.ok ? "OK" : "ERROR";
			return `## ${index + 1}. ${result.name} [${status}]\n\n${result.output}`;
		})
		.join("\n\n---\n\n");
}

async function selectAgentModel(ctx: ExtensionContext): Promise<AgentModel | undefined> {
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
	return { name: modelId, provider, model: modelId, description: description.trim(), enabled: true };
}

export default function parallelAgentsExtension(pi: ExtensionAPI) {
	const sessionCostByModel = new Map<string, number>();

	/** Displays total sub-agent cost separately from the cost of each model used. */
	const renderCostStatus = (ctx: ExtensionContext) => {
		const costs = [...sessionCostByModel.entries()].filter(([, cost]) => cost > 0);
		if (costs.length === 0) {
			ctx.ui.setStatus("parallel-agent-cost", undefined);
			return;
		}
		const total = costs.reduce((sum, [, cost]) => sum + cost, 0);
		const byModel = costs.map(([model, cost]) => `${model} $${cost.toFixed(4)}`).join(" · ");
		ctx.ui.setStatus("parallel-agent-cost", ctx.ui.theme.fg("dim", `subagents $${total.toFixed(4)} · ${byModel}`));
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

			const stats: AgentRunStats[] = params.tasks.map((task) => ({
				name: task.name ?? task.model,
				model: task.model,
				reasoningLevel: task.reasoningLevel,
				status: "active",
				actions: 0,
				cost: 0,
				filesRead: new Set<string>(),
				filesEdited: new Set<string>(),
			}));
			let spinnerIndex = 0;
			const renderStats = () => {
				const lines = stats.map((stat) => {
					const icon = stat.status === "active"
						? ctx.ui.theme.fg("accent", SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length])
						: stat.status === "done" ? ctx.ui.theme.fg("success", "✓") : ctx.ui.theme.fg("error", "✗");
					const counts = `${stat.filesRead.size} read · ${stat.filesEdited.size} edited · ${stat.actions} actions`;
					return `${icon} ${stat.name} (${stat.model}, ${stat.reasoningLevel}) ${ctx.ui.theme.fg("dim", counts)}`;
				});
				ctx.ui.setWidget("parallel-agents", [ctx.ui.theme.fg("accent", "Parallel sub-agents"), ...lines]);
			};
			renderStats();
			const spinnerTimer = setInterval(() => { spinnerIndex++; renderStats(); }, 120);
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
			const settled = await Promise.allSettled(params.tasks.map((task, index) =>
				runSubAgent(task, findEnabledModel(config, task.model)!, config, ctx, stats[index], () => updateStatsAndCosts(index))));
			clearInterval(spinnerTimer);
			renderStats();
			const results = settled.map((item, index) => item.status === "fulfilled" ? item.value : {
				ok: false,
				name: params.tasks[index].name ?? params.tasks[index].model,
				output: item.reason instanceof Error ? item.reason.message : String(item.reason),
			});
			setTimeout(() => ctx.ui.setWidget("parallel-agents", undefined), 1500);
			return { content: [{ type: "text", text: formatResults(results) }], details: { results } };
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
					const list = config.models.map((model) => `- ${model.name} [${model.enabled ? "enabled" : "disabled"}] (${model.provider}/${model.model}): ${model.description}`).join("\n");
					ctx.ui.notify(list || "No models configured.", "info");
				} else if (action === "Add model") {
					const model = await selectAgentModel(ctx);
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
		ctx.ui.setStatus("parallel-agent-cost", undefined);
		const config = loadConfig();
		const enabledCount = config.models.filter((model) => model.enabled).length;
		ctx.ui.setStatus("parallel-agents", ctx.ui.theme.fg("dim", `subagents:${enabledCount}/${config.models.length}`));
	});

	pi.on("before_agent_start", (event) => {
		const models = loadConfig().models.filter((model) => model.enabled);
		if (models.length === 0) return;
		const entries = models.map((model) => `- ${model.name}: ${model.description}`).join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\nConfigured parallel_agents models:\n${entries}` };
	});
}
