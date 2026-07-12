import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
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

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type TaskMode = "readonly" | "editing";

interface ModelProfile {
	name: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
}

interface ParallelAgentsConfig {
	maxParallelAgents: number;
	allowedExtensionTools: string[];
	profiles: ModelProfile[];
}

const CONFIG_PATH = join(getAgentDir(), "parallel-agents.json");
const SEARCH_AGENT_PROFILE_NAME = "search-agent";
const SEARCH_AGENT_TOOLS = ["brave_llm_search", "context7_search_library", "context7_get_context", "exa_web_search"];

const DEBUG_LOG_PATH = join(getAgentDir(), "parallel-agents-debug.log");
const DEFAULT_CONFIG: ParallelAgentsConfig = {
	maxParallelAgents: 4,
	allowedExtensionTools: [],
	profiles: [],
};

const TASK_SCHEMA = Type.Object({
	name: Type.Optional(Type.String({ description: "Short human-readable task name." })),
	profile: Type.String({ description: "Configured model profile name from ~/.pi/agent/parallel-agents.json." }),
	mode: Type.Union([Type.Literal("readonly"), Type.Literal("editing")], {
		description: "readonly disables write/edit/bash; editing enables read/grep/find/ls/write/edit/bash.",
	}),
	prompt: Type.String({
		description:
			"Detailed architectural prompt for the sub-agent. Include objective, files to inspect/touch, constraints, and expected final answer.",
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
	profile: string;
	mode: TaskMode;
	status: AgentRunStatus;
	actions: number;
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
			profiles: Array.isArray(parsed.profiles)
				? parsed.profiles.filter(isProfileLike).map((p: ModelProfile) => ({ ...p }))
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

function isProfileLike(value: unknown): value is ModelProfile {
	const p = value as Partial<ModelProfile>;
	return (
		!!p &&
		typeof p.name === "string" &&
		typeof p.provider === "string" &&
		typeof p.model === "string" &&
		["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(p.thinkingLevel))
	);
}

function findProfile(config: ParallelAgentsConfig, name: string): ModelProfile | undefined {
	return config.profiles.find((p) => p.name === name);
}

function resolveProfile(config: ParallelAgentsConfig, name: string): ModelProfile | undefined {
	return findProfile(config, name);
}

function getSupportedThinkingLevelsLocal(model: Model<Api>): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
	return levels.filter((level) => {
		const mapped = (model as any).thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

function taskTools(mode: TaskMode, allowedExtensionTools: string[], profileName?: string): string[] {
	const builtins =
		mode === "editing"
			? ["read", "grep", "find", "ls", "write", "edit", "bash"]
			: ["read", "grep", "find", "ls", "brave_llm_search", "context7_search_library", "context7_get_context"];
	const presetTools = profileName === SEARCH_AGENT_PROFILE_NAME ? SEARCH_AGENT_TOOLS : [];
	return [...new Set([...builtins, ...presetTools, ...allowedExtensionTools])];
}

function isKimiProfile(profile: ModelProfile): boolean {
	return `${profile.provider}/${profile.model}`.toLowerCase().includes("kimi");
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

function buildSubAgentPrompt(task: SubAgentTask, profile: ModelProfile): string {
	const searchAgentRules = task.profile === SEARCH_AGENT_PROFILE_NAME
		? "\n\nSearch-agent preset instructions:\n- You are a specific-purpose research sub-agent. Gather evidence first, then synthesize.\n- Prefer exa_web_search for semantic/neural AI-agent optimized web discovery.\n- Prefer brave_llm_search for factual/current context aggregation.\n- Use context7_search_library and context7_get_context for programming/library documentation.\n- Use filesystem tools to inspect the current repository when local project context is relevant.\n- Cite URLs and file paths. Explicitly list uncertainty and recommended follow-up searches."
		: "";
	const kimiEditRules = isKimiProfile(profile) && task.mode === "editing"
		? `\n\nKimi/tool-use compatibility rules:\n- The edit tool requires this exact shape: {"path":"relative/or/absolute/path","edits":[{"oldText":"exact unique text copied from the current file","newText":"replacement text"}]}. Do not send oldText/newText at the top level.\n- Always read the target file immediately before an edit and copy oldText verbatim from that read result.\n- If an edit fails once because oldText is not unique or not found, re-read the file and either make a smaller exact edit or use bash with a short python script to rewrite the file deterministically.\n- For risky rewrites, first create an easily reverted backup outside the repo at /tmp/pi-parallel-agent-backups/<timestamp>-<basename>.bak, then report the backup path in your final answer.\n- Do not repeatedly retry the same failing edit arguments.`
		: "";
	const modeRules =
		task.mode === "editing"
			? "You may edit files and run shell commands. Keep edits focused. If multiple agents are running, touch only files assigned in this prompt."
			: "You are in read-only mode. Do not modify files or run shell commands. Only inspect and reason.";
	return `You are a pi sub-agent running as part of a parallel multi-agent task.\n\nRules:\n- Complete only the task below.\n- ${modeRules}\n- Do not ask the user questions. If information is missing, state assumptions in the final answer.\n- Avoid interactive commands and tools.\n- Final answer should be concise and directly useful to the main agent.${searchAgentRules}${kimiEditRules}\n\nTask:\n${task.prompt}`;
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
	profile: ModelProfile,
	config: ParallelAgentsConfig,
	ctx: ExtensionContext,
	stats: AgentRunStats,
	onStatsChange: () => void,
): Promise<{ ok: boolean; name: string; output: string }> {
	// Use the live context model registry instead of creating a fresh one.
	// Provider/model registrations from extensions (for example cursor/composer-2.5)
	// are applied to ctx.modelRegistry; a new registry only contains built-in/static
	// models and would fail to find extension-provided profiles.
	const modelRegistry = ctx.modelRegistry;
	const model = modelRegistry.find(profile.provider, profile.model);
	if (!model) {
		const available = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`).sort();
		throw new Error(
			`Profile ${profile.name}: model not found: ${profile.provider}/${profile.model}. Available models in active registry: ${available.join(", ") || "(none)"}`,
		);
	}
	if (!modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`Profile ${profile.name}: no auth configured for provider ${profile.provider}`);
	}

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } as any });
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: config.allowedExtensionTools.length === 0 && profile.name !== SEARCH_AGENT_PROFILE_NAME,
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
		thinkingLevel: profile.thinkingLevel,
		modelRegistry,
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		tools: taskTools(task.mode as TaskMode, config.allowedExtensionTools, profile.name),
	});

	debugLog("sub-agent-start", { name: task.name, profile, mode: task.mode });
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "tool_execution_start") {
			stats.actions++;
			const args = event.args ?? {};
			if (event.toolName === "read" && typeof args.path === "string") stats.filesRead.add(args.path);
			if ((event.toolName === "edit" || event.toolName === "write") && typeof args.path === "string") stats.filesEdited.add(args.path);
			debugLog("tool-start", { agent: task.name ?? profile.name, tool: event.toolName, args });
			onStatsChange();
			return;
		}
		if (event.type === "tool_execution_end") {
			debugLog("tool-end", { agent: task.name ?? profile.name, tool: event.toolName, isError: event.isError, result: event.result });
		}
	});

	try {
		await session.prompt(buildSubAgentPrompt(task, profile), { source: "extension" as any });
		stats.status = "done";
		onStatsChange();
		const output = getFinalAssistantText(session);
		debugLog("sub-agent-done", { name: task.name ?? profile.name, filesRead: stats.filesRead, filesEdited: stats.filesEdited, output });
		return { ok: true, name: task.name ?? profile.name, output };
	} catch (error) {
		stats.status = "failed";
		onStatsChange();
		debugLog("sub-agent-failed", { name: task.name ?? profile.name, error: error instanceof Error ? error.stack ?? error.message : String(error) });
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

async function selectModelProfile(ctx: ExtensionContext, existing?: ModelProfile): Promise<ModelProfile | undefined> {
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify("No authenticated models available. Use /login or configure API keys first.", "error");
		return undefined;
	}

	const name = await ctx.ui.input("Profile name", existing?.name ?? "");
	if (!name?.trim()) return undefined;

	const providers = [...new Set(available.map((m) => m.provider))].sort();
	const provider = await ctx.ui.select("Select provider", providers);
	if (!provider) return undefined;

	const providerModels = available.filter((m) => m.provider === provider).sort((a, b) => a.id.localeCompare(b.id));
	const modelId = await ctx.ui.select(
		`Select model (${provider})`,
		providerModels.map((m) => m.id),
	);
	if (!modelId) return undefined;
	const model = providerModels.find((m) => m.id === modelId) as Model<Api> | undefined;
	if (!model) return undefined;

	const levels = getSupportedThinkingLevelsLocal(model);
	const preferred = existing?.thinkingLevel && levels.includes(existing.thinkingLevel) ? existing.thinkingLevel : levels[0];
	const thinkingLevel = (await ctx.ui.select("Select thinking level", levels)) as ThinkingLevel | undefined;
	if (!thinkingLevel) return undefined;

	return { name: name.trim(), provider, model: modelId, thinkingLevel };
}

export default function parallelAgentsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "parallel_agents",
		label: "Parallel Agents",
		description:
			"Run multiple isolated sub-agents concurrently. Each task must specify a configured profile, readonly/editing mode, and detailed prompt. A configured profile named search-agent receives special research instructions and search tools. Blocks until all sub-agents finish.",
		promptSnippet: "Spawn isolated parallel sub-agents for research or focused edits.",
		promptGuidelines: [
			"Use parallel_agents when independent research or implementation tasks can run concurrently.",
			"When using parallel_agents in editing mode, assign non-overlapping files/directories to each task.",
			"parallel_agents requires every task to specify a valid configured profile name.",
			"Create and use a configured profile named \"search-agent\" for broad research tasks needing Exa, Brave, Context7, and filesystem search."
		],
		parameters: PARALLEL_AGENTS_SCHEMA,
		async execute(_toolCallId, params: ParallelAgentsInput, _signal, onUpdate, ctx) {
			const config = loadConfig();
			if (config.profiles.length === 0) {
				return {
					isError: true,
					content: [{ type: "text", text: `No parallel-agent profiles configured. Run /parallel-agents to create profiles in ${CONFIG_PATH}. Create a profile named ${SEARCH_AGENT_PROFILE_NAME} to enable the built-in search preset.` }],
					details: {},
				};
			}
			if (params.tasks.length === 0) {
				return { isError: true, content: [{ type: "text", text: "No sub-agent tasks provided." }], details: {} };
			}
			if (params.tasks.length > config.maxParallelAgents) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Requested ${params.tasks.length} sub-agents, but maxParallelAgents is ${config.maxParallelAgents} in ${CONFIG_PATH}.`,
						},
					],
					details: {},
				};
			}

			const missing = params.tasks.map((t) => t.profile).filter((name) => !resolveProfile(config, name));
			if (missing.length > 0) {
				return {
					isError: true,
					content: [{ type: "text", text: `Unknown parallel-agent profile(s): ${[...new Set(missing)].join(", ")}. Run /parallel-agents to configure profiles.` }],
					details: {},
				};
			}

			const stats: AgentRunStats[] = params.tasks.map((task) => ({
				name: task.name ?? task.profile,
				profile: task.profile,
				mode: task.mode as TaskMode,
				status: "active",
				actions: 0,
				filesRead: new Set<string>(),
				filesEdited: new Set<string>(),
			}));
			let spinnerIndex = 0;
			const renderStats = () => {
				const lines = stats.map((s) => {
					const icon =
						s.status === "active"
							? ctx.ui.theme.fg("accent", SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length])
							: s.status === "done"
								? ctx.ui.theme.fg("success", "✓")
								: ctx.ui.theme.fg("error", "✗");
					const label = `${s.name} (${s.profile}, ${s.mode})`;
					const counts = `${s.filesRead.size} read · ${s.filesEdited.size} edited · ${s.actions} actions`;
					return `${icon} ${label} ${ctx.ui.theme.fg("dim", counts)}`;
				});
				ctx.ui.setWidget("parallel-agents", [ctx.ui.theme.fg("accent", "Parallel sub-agents"), ...lines]);
			};
			renderStats();
			const spinnerTimer = setInterval(() => {
				spinnerIndex++;
				renderStats();
			}, 120);
			onUpdate?.({ content: [{ type: "text", text: `Starting ${params.tasks.length} parallel sub-agent(s)...` }], details: {} });
			const settled = await Promise.allSettled(
				params.tasks.map(async (task, index) => runSubAgent(task, resolveProfile(config, task.profile)!, config, ctx, stats[index], renderStats)),
			);
			clearInterval(spinnerTimer);
			renderStats();
			const results = settled.map((item, index) => {
				const task = params.tasks[index];
				if (item.status === "fulfilled") return item.value;
				return { ok: false, name: task.name ?? task.profile, output: item.reason instanceof Error ? item.reason.message : String(item.reason) };
			});
			setTimeout(() => ctx.ui.setWidget("parallel-agents", undefined), 1500);
			return { content: [{ type: "text", text: formatResults(results) }], details: { results } };
		},
	});

	pi.registerCommand("parallel-agents", {
		description: "Manage parallel sub-agent model profiles",
		handler: async (_args, ctx) => {
			const config = loadConfig();
			while (true) {
				const action = await ctx.ui.select("Parallel agents", [
					"List profiles",
					"Add profile",
					"Edit profile",
					"Delete profile",
					`Set max parallel agents (current ${config.maxParallelAgents})`,
					"Show config path",
					"Done",
				]);
				if (!action || action === "Done") break;

				if (action === "List profiles") {
					if (config.profiles.length === 0) {
						ctx.ui.notify("No profiles configured.", "info");
					} else {
						const list = config.profiles.map(p => `- ${p.name} (${p.provider}/${p.model}, thinking: ${p.thinkingLevel})`).join("\n");
						ctx.ui.notify(`Current profiles:\n${list}`, "info");
					}
				} else if (action === "Add profile") {
					const profile = await selectModelProfile(ctx);
					if (profile) {
						config.profiles = config.profiles.filter((p) => p.name !== profile.name);
						config.profiles.push(profile);
						saveConfig(config);
						ctx.ui.notify(`Saved profile ${profile.name}`, "info");
					}
				} else if (action === "Edit profile") {
					if (config.profiles.length === 0) {
						ctx.ui.notify("No profiles to edit", "warning");
						continue;
					}
					const selected = await ctx.ui.select("Select profile", config.profiles.map((p) => p.name));
					const existing = selected ? findProfile(config, selected) : undefined;
					if (!existing) continue;

					const editAction = await ctx.ui.select("Select field to edit", ["Name", "Provider/Model", "Thinking Level"]);
					if (!editAction) continue;

					let profile = { ...existing };
					if (editAction === "Name") {
						const name = await ctx.ui.input("Profile name", existing.name);
						if (!name?.trim()) continue;
						profile.name = name.trim();
					} else if (editAction === "Provider/Model") {
						const available = ctx.modelRegistry.getAvailable();
						const providers = [...new Set(available.map((m) => m.provider))].sort();
						const provider = await ctx.ui.select("Select provider", providers);
						if (!provider) continue;

						const providerModels = available.filter((m) => m.provider === provider).sort((a, b) => a.id.localeCompare(b.id));
						const modelId = await ctx.ui.select(
							`Select model (${provider})`,
							providerModels.map((m) => m.id),
						);
						if (!modelId) continue;
						profile.provider = provider;
						profile.model = modelId;
					} else if (editAction === "Thinking Level") {
						const available = ctx.modelRegistry.getAvailable();
						const model = available.find((m) => m.provider === profile.provider && m.id === profile.model) as Model<Api> | undefined;
						if (!model) {
							ctx.ui.notify(`Model ${profile.provider}/${profile.model} not available`, "error");
							continue;
						}
						const levels = getSupportedThinkingLevelsLocal(model);
						const thinkingLevel = (await ctx.ui.select("Select thinking level", levels)) as ThinkingLevel | undefined;
						if (!thinkingLevel) continue;
						profile.thinkingLevel = thinkingLevel;
					}

					config.profiles = config.profiles.filter((p) => p.name !== existing.name && p.name !== profile.name);
					config.profiles.push(profile);
					saveConfig(config);
					ctx.ui.notify(`Saved profile ${profile.name}`, "info");
				} else if (action === "Delete profile") {
					if (config.profiles.length === 0) {
						ctx.ui.notify("No profiles to delete", "warning");
						continue;
					}
					const selected = await ctx.ui.select("Delete profile", config.profiles.map((p) => p.name));
					if (selected) {
						config.profiles = config.profiles.filter((p) => p.name !== selected);
						saveConfig(config);
						ctx.ui.notify(`Deleted profile ${selected}`, "info");
					}
				} else if (action.startsWith("Set max")) {
					const value = await ctx.ui.input("Max parallel agents", String(config.maxParallelAgents));
					const parsed = Number(value);
					if (Number.isFinite(parsed) && parsed > 0) {
						config.maxParallelAgents = Math.floor(parsed);
						saveConfig(config);
						ctx.ui.notify(`maxParallelAgents = ${config.maxParallelAgents}`, "info");
					} else if (value) {
						ctx.ui.notify("Enter a positive number", "warning");
					}
				} else if (action === "Show config path") {
					ctx.ui.notify(CONFIG_PATH, "info");
				}
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const config = loadConfig();
		ctx.ui.setStatus("parallel-agents", ctx.ui.theme.fg("dim", `subagents:${config.profiles.length}`));
	});

	pi.on("before_agent_start", (event) => {
		const config = loadConfig();
		const profileNames = config.profiles.map((profile) => profile.name);
		if (profileNames.length === 0) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\nConfigured parallel_agents profiles by name:\n${profileNames.map((name) => `- ${name}`).join("\n")}`,
		};
	});
}
