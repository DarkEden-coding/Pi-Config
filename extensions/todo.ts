import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Status = "unapproved" | "pending" | "in_progress" | "completed";

type TodoTask = {
	id: string;
	title: string;
	description: string;
	acceptanceCriteria: string[];
	notes: string[];
	dependencies: string[];
	status: Status;
};

type CompletionRequest = {
	id: string;
};

type TodoWeb = {
	title: string;
	tasks: TodoTask[];
};

type TodoState = {
	web?: TodoWeb;
	approved: boolean;
	lastAction?: string;
	lastCompletedTaskId?: string;
	lastCompletedTaskIds?: string[];
	newlyUnblocked?: TodoTask[];
	stillBlocked?: TodoTask[];
	error?: string;
};

const VALID_STATUSES = new Set<Status>(["unapproved", "pending", "in_progress", "completed"]);

const CompletionParams = Type.Object({
	id: Type.String({ description: "Task id being completed." }),
});

const TodoWebParams = Type.Object({
	action: StringEnum(["set", "get", "complete", "clear", "approve"] as const),
	web: Type.Optional(Type.Any({ description: "Full todo web JSON for action=set." })),
	taskId: Type.Optional(Type.String({ description: "Task id for action=complete (single-task shorthand)." })),
	completions: Type.Optional(Type.Array(CompletionParams, { description: "One or more completed task ids for action=complete. Use this for parallel task completions." })),
});

function cloneWeb(web?: TodoWeb): TodoWeb | undefined {
	return web ? JSON.parse(JSON.stringify(web)) as TodoWeb : undefined;
}

function normalizeStringArray(value: unknown, field: string, errors: string[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		errors.push(`${field} must be an array of strings`);
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") errors.push(`${field} contains a non-string item`);
		else out.push(item);
	}
	return out;
}

function validateAndNormalizeWeb(input: unknown): { web?: TodoWeb; errors: string[] } {
	const errors: string[] = [];
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { errors: ["web must be an object with { title, tasks }"] };
	}

	const raw = input as Record<string, unknown>;
	const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Todo Web";
	if (!Array.isArray(raw.tasks)) errors.push("web.tasks must be an array");
	const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];

	const tasks: TodoTask[] = [];
	const ids = new Set<string>();
	for (let i = 0; i < rawTasks.length; i++) {
		const item = rawTasks[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			errors.push(`tasks[${i}] must be an object`);
			continue;
		}
		const t = item as Record<string, unknown>;
		const id = typeof t.id === "string" ? t.id.trim() : "";
		if (!id) errors.push(`tasks[${i}].id must be a non-empty string`);
		if (id && ids.has(id)) errors.push(`duplicate task id: ${id}`);
		if (id) ids.add(id);

		const title = typeof t.title === "string" ? t.title.trim() : "";
		if (!title) errors.push(`tasks[${i}].title must be a non-empty string`);
		const description = typeof t.description === "string" ? t.description.trim() : "";
		if (!description) errors.push(`tasks[${i}].description must be a non-empty string`);

		const status = t.status === undefined ? "unapproved" : t.status as Status;
		if (!VALID_STATUSES.has(status)) errors.push(`task ${id || i} has invalid status: ${String(t.status)}`);

		tasks.push({
			id,
			title,
			description,
			acceptanceCriteria: normalizeStringArray(t.acceptanceCriteria, `task ${id || i}.acceptanceCriteria`, errors),
			notes: normalizeStringArray(t.notes, `task ${id || i}.notes`, errors),
			dependencies: normalizeStringArray(t.dependencies, `task ${id || i}.dependencies`, errors),
			status: VALID_STATUSES.has(status) ? status : "unapproved",
		});
	}

	for (const task of tasks) {
		for (const dep of task.dependencies) {
			if (!ids.has(dep)) errors.push(`task ${task.id} depends on missing task id: ${dep}`);
			if (dep === task.id) errors.push(`task ${task.id} cannot depend on itself`);
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(tasks.map((t) => [t.id, t]));
	function visit(id: string, path: string[]): void {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			errors.push(`dependency cycle detected: ${[...path, id].join(" -> ")}`);
			return;
		}
		visiting.add(id);
		const task = byId.get(id);
		for (const dep of task?.dependencies ?? []) if (byId.has(dep)) visit(dep, [...path, id]);
		visiting.delete(id);
		visited.add(id);
	}
	for (const task of tasks) if (task.id) visit(task.id, []);

	return errors.length ? { errors } : { web: { title, tasks }, errors: [] };
}

function isUnblocked(task: TodoTask, web: TodoWeb): boolean {
	if (task.status === "completed") return false;
	const byId = new Map(web.tasks.map((t) => [t.id, t]));
	return task.dependencies.every((id) => byId.get(id)?.status === "completed");
}

function blockedTasks(web?: TodoWeb): TodoTask[] {
	if (!web) return [];
	return web.tasks.filter((t) => t.status !== "completed" && !isUnblocked(t, web));
}

function unblockedTasks(web?: TodoWeb): TodoTask[] {
	if (!web) return [];
	return web.tasks.filter((t) => isUnblocked(t, web));
}

function taskLabel(task: TodoTask | undefined, id: string): string {
	return task ? `${task.id}: ${task.title}` : id;
}

function relationText(task: TodoTask, web: TodoWeb): { deps: string; unlocks: string } {
	const byId = new Map(web.tasks.map((t) => [t.id, t]));
	const dependents = web.tasks.filter((candidate) => candidate.dependencies.includes(task.id));
	return {
		deps: task.dependencies.length ? task.dependencies.map((id) => `${taskLabel(byId.get(id), id)}${byId.get(id)?.status === "completed" ? " ✓" : ""}`).join(", ") : "none",
		unlocks: dependents.length ? dependents.map((t) => `${t.id}: ${t.title}`).join(", ") : "none",
	};
}

function formatWeb(web?: TodoWeb): string {
	if (!web) return "No todo web.";
	return [`# ${web.title}`, "", ...web.tasks.map((t) => {
		const rel = relationText(t, web);
		const blocked = t.status !== "completed" && !isUnblocked(t, web) ? " blocked" : "";
		const criteria = t.acceptanceCriteria.length ? `\n  acceptance: ${t.acceptanceCriteria.join("; ")}` : "";
		const notes = t.notes.length ? `\n  notes: ${t.notes.join("; ")}` : "";
		return `- [${t.status === "completed" ? "x" : " "}] ${t.id}: ${t.title} (${t.status}${blocked})\n  ${t.description}\n  deps: ${rel.deps}\n  unlocks: ${rel.unlocks}${criteria}${notes}`;
	})].join("\n");
}

function normalizeCompletionRequests(params: {
	taskId?: string;
	completions?: unknown;
}): { completions: CompletionRequest[]; errors: string[] } {
	const completions: CompletionRequest[] = [];
	const errors: string[] = [];

	if (params.taskId !== undefined) {
		completions.push({
			id: typeof params.taskId === "string" ? params.taskId.trim() : "",
		});
	}

	if (params.completions !== undefined) {
		if (!Array.isArray(params.completions)) errors.push("completions must be an array");
		else for (let i = 0; i < params.completions.length; i++) {
			const item = params.completions[i];
			if (!item || typeof item !== "object" || Array.isArray(item)) {
				errors.push(`completions[${i}] must be an object`);
				continue;
			}
			const c = item as Record<string, unknown>;
			completions.push({
				id: typeof c.id === "string" ? c.id.trim() : "",
			});
		}
	}

	if (!completions.length) errors.push("action=complete requires either taskId or completions[].");
	const seen = new Set<string>();
	for (let i = 0; i < completions.length; i++) {
		const c = completions[i];
		if (!c.id) errors.push(`completion ${i + 1} is missing id/taskId`);
		if (c.id && seen.has(c.id)) errors.push(`duplicate completion for task id: ${c.id}`);
		if (c.id) seen.add(c.id);
	}
	return { completions, errors };
}

class TodoWebComponent {
	constructor(private state: TodoState, private theme: Theme, private onClose: () => void) {}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}
	render(width: number): string[] {
		return renderTodoWebLines(this.state, this.theme, width, ["Press Escape to close"]);
	}
	invalidate(): void {}
}

class TodoReviewComponent {
	private selectedIndex = 0;
	private actions = ["Approve", "Refine", "Cancel"] as const;

	constructor(
		private state: TodoState,
		private theme: Theme,
		private tui: TUI,
		private done: (choice: "Approve" | "Refine" | "Cancel") => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done("Cancel");
		else if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(this.actions.length - 1, this.selectedIndex + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			this.done(this.actions[this.selectedIndex]);
		}
	}

	render(width: number): string[] {
		const lines = renderTodoWebLines(this.state, this.theme, width, []);
		lines.push("", this.theme.fg("accent", " Actions "));
		for (let i = 0; i < this.actions.length; i++) {
			const prefix = i === this.selectedIndex ? this.theme.fg("accent", "▶") : " ";
			const label = i === this.selectedIndex ? this.theme.bold(this.actions[i]) : this.actions[i];
			lines.push(truncateToWidth(`${prefix} ${label}`, width));
		}
		lines.push("", this.theme.fg("dim", "Use ↑/↓ then Enter · Escape cancels"));
		return lines.map((l) => truncateToWidth(l, width));
	}
	invalidate(): void {}
}

function renderTodoWebLines(state: TodoState, theme: Theme, width: number, footer: string[]): string[] {
	const th = theme;
	const web = state.web;
	const lines: string[] = ["", th.fg("accent", ` Todo Web${state.approved ? " ✓ approved" : ""} `), ""];
	if (!web) lines.push(th.fg("dim", "No todo web yet."));
	else {
		lines.push(th.fg("text", web.title));
		lines.push(th.fg("muted", `${web.tasks.filter((t) => t.status === "completed").length}/${web.tasks.length} completed · ${unblockedTasks(web).length} unblocked · ${blockedTasks(web).length} blocked`));
		lines.push("");
		for (const t of web.tasks) {
			const mark = t.status === "completed" ? th.fg("success", "✓") : isUnblocked(t, web) ? th.fg("warning", "○") : th.fg("dim", "⊘");
			const rel = relationText(t, web);
			lines.push(`${mark} ${th.fg("accent", `${t.id}:`)} ${th.fg(t.status === "completed" ? "dim" : "text", t.title)} ${th.fg("muted", `[${t.status}]`)}`);
			lines.push(th.fg("dim", `  ${t.description}`));
			lines.push(th.fg("dim", `  deps: ${rel.deps}`));
			lines.push(th.fg("dim", `  unlocks: ${rel.unlocks}`));
			if (t.acceptanceCriteria.length) lines.push(th.fg("dim", `  acceptance: ${t.acceptanceCriteria.join("; ")}`));
			if (t.notes.length) lines.push(th.fg("dim", `  notes: ${t.notes.join("; ")}`));
		}
	}
	if (footer.length) lines.push("", ...footer.map((l) => th.fg("dim", l)));
	return lines.map((l) => truncateToWidth(l, width));
}

export default function todoExtension(pi: ExtensionAPI): void {
	let state: TodoState = { approved: false };
	let awaitingReview = false;

	function persist(action: string, extra: Partial<TodoState> = {}) {
		pi.appendEntry("todo-web-state", { ...state, ...extra, lastAction: action });
	}

	function reconstruct(ctx: ExtensionContext) {
		state = { approved: false };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo_web") {
				const d = entry.message.details as TodoState | undefined;
				if (d) state = { ...state, ...d, web: cloneWeb(d.web) };
			}
			if (entry.type === "custom" && entry.customType === "todo-web-state") {
				const d = entry.data as TodoState | undefined;
				if (d) state = { ...state, ...d, web: cloneWeb(d.web) };
			}
		}
	}

	function systemCreatePrompt(userPrompt?: string, refinement?: string): string {
		return `Create or revise a dependency-aware todo web for the user's large task. Call todo_web with action=set and a full JSON web. Do not mark it approved. If you omit a task status, todo_web will treat it as unapproved.\n\nSchema:\n{\n  "title": "string",\n  "tasks": [{\n    "id": "stable-short-id",\n    "title": "string",\n    "description": "string",\n    "acceptanceCriteria": ["string"],\n    "notes": ["string"],\n    "dependencies": ["task-id"],\n    "status": "unapproved"\n  }]\n}\n\nRules: every task must have a non-empty title/name and description; dependencies are task ids that must be completed before the task is unblocked; use only statuses unapproved/pending/in_progress/completed; avoid cycles; make tasks small enough to complete one at a time.${userPrompt ? `\n\nUser prompt for this todo web:\n${userPrompt}` : ""}${refinement ? `\n\nUser refinement request:\n${refinement}` : ""}`;
	}

	function runPrompt(): string {
		return `Run the approved todo web. Choose currently unblocked non-completed task(s) from the todo_web state. You may execute independent unblocked tasks in parallel when safe. After completing task work, call todo_web with action=complete and either taskId for one task or completions: [{ id }] for multiple parallel completions. Continue until all tasks are completed or no unblocked tasks remain.`;
	}

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	async function reviewTodoWeb(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || !state.web || state.error) return;

		const choice = await ctx.ui.custom<"Approve" | "Refine" | "Cancel">((tui, theme, _kb, done) => new TodoReviewComponent(state, theme, tui, done));
		if (choice === "Approve") {
			state.approved = true;
			persist("approve");
			ctx.ui.notify("Todo web approved. Use /todo → Run approved todo web.", "info");
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoWebComponent(state, theme, () => done()));
		} else if (choice === "Refine") {
			const refinement = await ctx.ui.input("How should the todo web be refined?", "Describe requested changes");
			if (refinement?.trim()) {
				awaitingReview = true;
				pi.sendUserMessage(systemCreatePrompt(undefined, refinement.trim()));
			}
		}
	}

	pi.on("agent_end", async (_event, ctx) => {
		if (!awaitingReview || !ctx.hasUI || !state.web || state.error) return;
		awaitingReview = false;
		await reviewTodoWeb(ctx);
	});

	pi.registerTool({
		name: "todo_web",
		label: "Todo Web",
		description: "Create, inspect, approve, clear, or complete one or more tasks in a branch-aware dependency todo web. Created tasks require names/titles and descriptions; completion supports parallel task batches by id.",
		promptSnippet: "Manage the branch-local dependency todo web for large tasks.",
		promptGuidelines: [
			"Use todo_web action=set to create or revise the full todo web before executing large tasks.",
			"Use todo_web action=complete immediately after completing unblocked task work.",
			"Use todo_web action=complete with completions: [{ id }] to record multiple independent unblocked tasks completed in parallel.",
		],
		parameters: TodoWebParams,
		async execute(_id, params) {
			if (params.action === "get") {
				return { content: [{ type: "text", text: formatWeb(state.web) }], details: { ...state, lastAction: "get" } satisfies TodoState };
			}
			if (params.action === "clear") {
				state = { approved: false };
				return { content: [{ type: "text", text: "Todo web cleared." }], details: { ...state, lastAction: "clear" } satisfies TodoState };
			}
			if (params.action === "approve") {
				state.approved = true;
				return { content: [{ type: "text", text: `Todo web approved.\n\n${formatWeb(state.web)}` }], details: { ...state, lastAction: "approve" } satisfies TodoState };
			}
			if (params.action === "set") {
				const result = validateAndNormalizeWeb(params.web);
				if (!result.web) {
					const error = `Invalid todo web:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
					return { content: [{ type: "text", text: error }], details: { ...state, approved: false, error, lastAction: "set" } satisfies TodoState };
				}
				state = { web: result.web, approved: false, lastAction: "set" };
				return { content: [{ type: "text", text: `Todo web parsed and accepted.\n\n${formatWeb(state.web)}\n\nWaiting for user review/approval.` }], details: { ...state } satisfies TodoState };
			}
			if (params.action === "complete") {
				if (!state.web) return { content: [{ type: "text", text: "No todo web exists." }], details: { ...state, error: "no web", lastAction: "complete" } satisfies TodoState };
				const normalized = normalizeCompletionRequests(params);
				if (normalized.errors.length) {
					const error = `Invalid completion request:\n${normalized.errors.map((e) => `- ${e}`).join("\n")}`;
					return { content: [{ type: "text", text: error }], details: { ...state, error, lastAction: "complete" } satisfies TodoState };
				}

				const beforeUnblocked = new Set(unblockedTasks(state.web).map((t) => t.id));
				const tasksToComplete: Array<{ task: TodoTask; completion: CompletionRequest }> = [];
				const validationErrors: string[] = [];
				for (const completion of normalized.completions) {
					const task = state.web.tasks.find((t) => t.id === completion.id);
					if (!task) {
						validationErrors.push(`Task ${completion.id} not found.`);
						continue;
					}
					if (task.status !== "completed" && !beforeUnblocked.has(task.id)) validationErrors.push(`Task ${task.id}: ${task.title} is still blocked by incomplete dependencies: ${relationText(task, state.web).deps}`);
					tasksToComplete.push({ task, completion });
				}
				if (validationErrors.length) {
					const error = `Could not complete task batch:\n${validationErrors.map((e) => `- ${e}`).join("\n")}`;
					return { content: [{ type: "text", text: error }], details: { ...state, error, lastAction: "complete" } satisfies TodoState };
				}

				for (const { task } of tasksToComplete) {
					task.status = "completed";
				}
				const completedIds = tasksToComplete.map(({ task }) => task.id);
				const nowUnblocked = unblockedTasks(state.web);
				const newlyUnblocked = nowUnblocked.filter((t) => !beforeUnblocked.has(t.id));
				const stillBlocked = blockedTasks(state.web);
				state = { ...state, lastAction: "complete", lastCompletedTaskId: completedIds[completedIds.length - 1], lastCompletedTaskIds: completedIds, newlyUnblocked, stillBlocked, error: undefined };
				const remaining = nowUnblocked.filter((t) => t.status !== "completed");
				const completedText = tasksToComplete.map(({ task }) => `- ${task.id}: ${task.title}`).join("\n");
				const text = `Completed ${completedIds.length} task${completedIds.length === 1 ? "" : "s"}:\n${completedText}\n\nNewly unblocked:\n${newlyUnblocked.length ? newlyUnblocked.map((t) => `- ${t.id}: ${t.title}`).join("\n") : "- none"}\n\nStill blocked:\n${stillBlocked.length ? stillBlocked.map((t) => `- ${t.id}: ${t.title} (deps: ${relationText(t, state.web!).deps})`).join("\n") : "- none"}\n\nFull todo web:\n${formatWeb(state.web)}\n\nNext: choose currently unblocked non-completed task(s) yourself. You may run independent unblocked tasks in parallel. Then call todo_web action=complete for every completed task. ${remaining.length ? `Currently unblocked: ${remaining.map((t) => `${t.id}: ${t.title}`).join("; ")}` : "No unblocked pending tasks remain."}`;
				return { content: [{ type: "text", text }], details: { ...state } satisfies TodoState };
			}
			return { content: [{ type: "text", text: `Unknown action ${params.action}` }], details: { ...state, error: "unknown action" } satisfies TodoState };
		},
		renderCall(args, theme) {
			let s = theme.fg("toolTitle", theme.bold("todo_web ")) + theme.fg("muted", args.action);
			if (args.taskId) s += " " + theme.fg("accent", args.taskId);
			if (Array.isArray(args.completions) && args.completions.length) s += " " + theme.fg("accent", args.completions.map((c: { id?: string }) => c.id).filter(Boolean).join(", "));
			return new Text(s, 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as TodoState | undefined;
			if (!d?.web) return new Text(theme.fg(d?.error ? "error" : "muted", d?.error ?? "No todo web"), 0, 0);
			const done = d.web.tasks.filter((t) => t.status === "completed").length;
			const unblocked = unblockedTasks(d.web);
			const blocked = blockedTasks(d.web);
			const status = d.approved ? theme.fg("success", "approved") : theme.fg("warning", "unapproved");
			const lastCompleted = d.lastCompletedTaskIds?.length ? `\n${theme.fg("success", "completed: ")}${d.lastCompletedTaskIds.map((id) => taskLabel(d.web?.tasks.find((t) => t.id === id), id)).join(", ")}` : "";
			const next = unblocked.length ? `\n${theme.fg("warning", "unblocked: ")}${unblocked.map((t) => `${t.id}: ${t.title}`).join(", ")}` : "";
			const blockedLine = blocked.length ? `\n${theme.fg("muted", "blocked: ")}${blocked.map((t) => `${t.id}: ${t.title}`).join(", ")}` : "";
			return new Text(`${theme.fg("accent", d.web.title)} ${theme.fg("muted", `${done}/${d.web.tasks.length} completed · ${unblocked.length} unblocked · ${blocked.length} blocked`)} ${status}${lastCompleted}${next}${blockedLine}`, 0, 0);
		},
	});

	pi.registerCommand("todo", {
		description: "Create/review, run, show, or clear the branch-local todo web",
		handler: async (_args, ctx) => {
			reconstruct(ctx);
			const choice = await ctx.ui.select("Todo", ["Create/review todo web", "Run approved todo web", "Show current todo web", "Clear todo web"]);
			if (choice === "Create/review todo web") {
				if (state.web && !state.error) {
					await reviewTodoWeb(ctx);
				} else {
					const prompt = await ctx.ui.input("Prompt for the agent", "Optional: describe what the todo web should cover");
					if (prompt === undefined) return;
					awaitingReview = true;
					pi.sendUserMessage(systemCreatePrompt(prompt.trim() || undefined));
				}
			} else if (choice === "Run approved todo web") {
				if (!state.web) return ctx.ui.notify("No todo web exists. Create one first.", "error");
				if (!state.approved) return ctx.ui.notify("Todo web is not approved yet.", "error");
				pi.sendUserMessage(runPrompt());
			} else if (choice === "Show current todo web") {
				if (ctx.hasUI) await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoWebComponent(state, theme, () => done()));
				else ctx.ui.notify(formatWeb(state.web), "info");
			} else if (choice === "Clear todo web") {
				const ok = await ctx.ui.confirm("Clear todo web?", "This records a clear state on the current branch.");
				if (ok) {
					state = { approved: false };
					persist("clear");
					ctx.ui.notify("Todo web cleared.", "info");
				}
			}
		},
	});
}
