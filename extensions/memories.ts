import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getAgentDir, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

type Scope = "global" | "project";
type MemoryAction = "list" | "add" | "update" | "remove" | "clear";

interface MemoryItem {
	id: number;
	text: string;
	createdAt: string;
	updatedAt: string;
}

interface MemoryStore {
	version: 1;
	nextId: number;
	memories: MemoryItem[];
}

interface MemorySnapshot {
	global: MemoryStore;
	project: MemoryStore;
}

interface ToolResponse {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

const MEMORY_ACTIONS = ["list", "add", "update", "remove", "clear"] as const;
const MEMORY_SCOPES = ["global", "project"] as const;
const SNAPSHOT_TYPE = "memories-snapshot";
const GLOBAL_FILE = join(getAgentDir(), "memories.json");
const NEW_CHATS_NOTE = "It will affect new chats only.";
const VIEWER_STATUS_NOTE = "Saved changes apply to new chats only";
const VIEWER_WARNING = "Edits are saved now but only affect new chats, not the current one.";
const MAX_VISIBLE_MEMORIES = 8;

const MemoryParams = Type.Object({
	action: Type.Union(MEMORY_ACTIONS.map((action) => Type.Literal(action))),
	scope: Type.Union(MEMORY_SCOPES.map((scope) => Type.Literal(scope))),
	id: Type.Optional(Type.Number({ description: "Memory id for update/remove" })),
	text: Type.Optional(Type.String({ description: "Memory text" })),
});

function emptyStore(): MemoryStore {
	return { version: 1, nextId: 1, memories: [] };
}

function emptySnapshot(): MemorySnapshot {
	return { global: emptyStore(), project: emptyStore() };
}

function findProjectRoot(startDir: string): string {
	let current = resolve(startDir);

	while (true) {
		if (existsSync(join(current, ".pi"))) return current;
		if (existsSync(join(current, ".git"))) return current;

		const parent = dirname(current);
		if (parent === current) return resolve(startDir);
		current = parent;
	}
}

function formatScopeLabel(scope: Scope): string {
	return scope === "global" ? "Global" : "Project";
}

function formatMemoryList(memories: MemoryItem[]): string {
	if (memories.length === 0) return "(none)";
	return memories.map((memory) => `#${memory.id}: ${memory.text}`).join("\n");
}

function formatPromptSection(scopeLabel: string, memories: MemoryItem[]): string {
	return memories.length
		? `\n${scopeLabel}:\n${memories.map((memory) => `- [#${memory.id}] ${memory.text}`).join("\n")}`
		: `\n${scopeLabel}: (none)`;
}

function buildMemoryPrompt(snapshot: MemorySnapshot): string | undefined {
	if (snapshot.global.memories.length === 0 && snapshot.project.memories.length === 0) return undefined;

	return [
		"## Saved memories",
		"These are durable user instructions and preferences.",
		"Project memories override global memories when they conflict.",
		formatPromptSection("Global memories", snapshot.global.memories),
		formatPromptSection("Project memories", snapshot.project.memories),
		"",
		"Use the remember tool to add or refine memories when the user gives persistent instructions. Changes made during this chat apply only to new chats, not the current one.",
	].join("\n");
}

function normalizeScope(input: string | undefined): Scope | undefined {
	if (!input) return undefined;
	const value = input.trim().toLowerCase();
	return value === "global" || value === "project" ? value : undefined;
}

function parseCommandArgs(args: string): { scope?: Scope; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { rest: "" };

	const [first, ...remaining] = trimmed.split(/\s+/);
	const scope = normalizeScope(first);
	if (scope) return { scope, rest: remaining.join(" ") };
	return { rest: trimmed };
}

async function askForScope(ctx: any): Promise<Scope | undefined> {
	if (!ctx.hasUI) return undefined;
	const choice = await ctx.ui.select("Choose memory scope", ["project", "global"]);
	return normalizeScope(choice ?? undefined);
}

async function askForMemoryText(ctx: any, initialText = ""): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const value = await ctx.ui.editor("Memory instruction", initialText || "");
	const text = value?.trim();
	return text ? text : undefined;
}

async function askForMemoryId(ctx: any, memories: MemoryItem[]): Promise<number | undefined> {
	if (!ctx.hasUI || memories.length === 0) return undefined;
	const choice = await ctx.ui.select(
		"Choose a memory",
		memories.map((memory) => `#${memory.id}: ${memory.text}`),
	);
	if (!choice) return undefined;
	const match = /^#(\d+)/.exec(choice);
	return match ? Number(match[1]) : undefined;
}

function toolText(text: string, details: Record<string, unknown> = {}): ToolResponse {
	return { content: [{ type: "text", text }], details };
}

function toolError(scope: Scope, text: string): ToolResponse {
	return toolText(text, { scope, error: true });
}

function toolCancelled(scope: Scope): ToolResponse {
	return toolText("Cancelled", { scope, cancelled: true });
}

function viewerStatusLines(activeScope: Scope): string[] {
	return [VIEWER_STATUS_NOTE, `Active scope: ${formatScopeLabel(activeScope)}`];
}

class MemoryRepository {
	scopeFile(scope: Scope, cwd: string): string {
		if (scope === "global") return GLOBAL_FILE;
		const projectRoot = findProjectRoot(cwd);
		return join(projectRoot, ".pi", "memories.json");
	}

	async readStore(filePath: string): Promise<MemoryStore> {
		try {
			const raw = await readFile(filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<MemoryStore>;
			if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.memories)) return emptyStore();

			return {
				version: 1,
				nextId: typeof parsed.nextId === "number" && parsed.nextId > 0 ? parsed.nextId : 1,
				memories: parsed.memories
					.filter((entry): entry is MemoryItem => !!entry && typeof entry.id === "number" && typeof entry.text === "string")
					.map((entry) => ({
						id: entry.id,
						text: entry.text,
						createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
						updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
					})),
			};
		} catch {
			return emptyStore();
		}
	}

	async writeStore(filePath: string, store: MemoryStore): Promise<void> {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	}

	async mutateStore<T>(filePath: string, mutator: (store: MemoryStore) => Promise<T> | T): Promise<T> {
		return await withFileMutationQueue(filePath, async () => {
			const store = await this.readStore(filePath);
			const result = await mutator(store);
			await this.writeStore(filePath, store);
			return result;
		});
	}

	async loadSnapshot(cwd: string): Promise<MemorySnapshot> {
		const projectRoot = findProjectRoot(cwd);
		const [global, project] = await Promise.all([
			this.readStore(GLOBAL_FILE),
			this.readStore(join(projectRoot, ".pi", "memories.json")),
		]);
		return { global, project };
	}

	async list(scope: Scope, cwd: string): Promise<MemoryStore> {
		return await this.readStore(this.scopeFile(scope, cwd));
	}

	async add(scope: Scope, cwd: string, text: string): Promise<MemoryItem> {
		const filePath = this.scopeFile(scope, cwd);
		return await this.mutateStore(filePath, async (store) => {
			const now = new Date().toISOString();
			const item: MemoryItem = { id: store.nextId++, text, createdAt: now, updatedAt: now };
			store.memories.push(item);
			return item;
		});
	}

	async update(scope: Scope, cwd: string, id: number, text: string): Promise<MemoryItem | undefined> {
		const filePath = this.scopeFile(scope, cwd);
		return await this.mutateStore(filePath, async (store) => {
			const memory = store.memories.find((entry) => entry.id === id);
			if (!memory) return undefined;
			memory.text = text;
			memory.updatedAt = new Date().toISOString();
			return memory;
		});
	}

	async remove(scope: Scope, cwd: string, id: number): Promise<MemoryItem | undefined> {
		const filePath = this.scopeFile(scope, cwd);
		return await this.mutateStore(filePath, async (store) => {
			const index = store.memories.findIndex((entry) => entry.id === id);
			if (index === -1) return undefined;
			const [removed] = store.memories.splice(index, 1);
			return removed;
		});
	}

	async clear(scope: Scope, cwd: string): Promise<number> {
		const filePath = this.scopeFile(scope, cwd);
		return await this.mutateStore(filePath, async (store) => {
			const count = store.memories.length;
			store.memories = [];
			store.nextId = 1;
			return count;
		});
	}
}

const memories = new MemoryRepository();

class MemoryBrowser {
	private snapshot: MemorySnapshot = emptySnapshot();
	private activeScope: Scope = "project";
	private selectedByScope: Record<Scope, number> = { global: 0, project: 0 };
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly ctx: any,
		private readonly theme: any,
		private readonly done: () => void,
		private readonly refreshFromDisk: () => Promise<MemorySnapshot>,
	) {}

	setSnapshot(snapshot: MemorySnapshot) {
		this.snapshot = snapshot;
		this.clampSelection();
		this.invalidate();
	}

	private invalidate() {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private clampSelection() {
		for (const scope of MEMORY_SCOPES) {
			const maxIndex = Math.max(0, this.getStore(scope).memories.length - 1);
			this.selectedByScope[scope] = Math.min(Math.max(0, this.selectedByScope[scope]), maxIndex);
		}
	}

	private getStore(scope: Scope): MemoryStore {
		return scope === "global" ? this.snapshot.global : this.snapshot.project;
	}

	private getSelectedMemory(scope: Scope): MemoryItem | undefined {
		const store = this.getStore(scope);
		if (store.memories.length === 0) return undefined;
		const index = this.selectedByScope[scope] ?? 0;
		return store.memories[Math.min(Math.max(0, index), store.memories.length - 1)];
	}

	private currentMemory(): MemoryItem | undefined {
		return this.getSelectedMemory(this.activeScope);
	}

	private setStatus() {
		this.ctx.ui.setWidget("memories-status", viewerStatusLines(this.activeScope), { placement: "belowEditor" });
	}

	private async refresh() {
		this.setSnapshot(await this.refreshFromDisk());
		this.setStatus();
		this.ctx.ui.notify("Memories refreshed", "info");
	}

	private switchScope() {
		this.activeScope = this.activeScope === "project" ? "global" : "project";
		this.invalidate();
		this.setStatus();
		this.ctx.ui.notify(`Viewing ${this.activeScope} memories`, "info");
	}

	private moveSelection(delta: number) {
		const store = this.getStore(this.activeScope);
		if (store.memories.length === 0) return;

		const current = this.selectedByScope[this.activeScope] ?? 0;
		const next = Math.min(Math.max(0, store.memories.length - 1), current + delta);
		if (next !== current) {
			this.selectedByScope[this.activeScope] = next;
			this.invalidate();
		}
	}

	private async addMemory() {
		const text = await askForMemoryText(this.ctx);
		if (!text) return;

		await memories.add(this.activeScope, this.ctx.cwd, text);
		await this.refresh();
	}

	private async editCurrentMemory() {
		const current = this.currentMemory();
		if (!current) {
			this.ctx.ui.notify(`No ${this.activeScope} memory selected`, "warning");
			return;
		}

		const text = await askForMemoryText(this.ctx, current.text);
		if (!text) return;

		await memories.update(this.activeScope, this.ctx.cwd, current.id, text);
		await this.refresh();
	}

	private async deleteCurrentMemory() {
		const current = this.currentMemory();
		if (!current) {
			this.ctx.ui.notify(`No ${this.activeScope} memory selected`, "warning");
			return;
		}

		const confirmed = await this.ctx.ui.confirm(
			`Delete ${this.activeScope} memory #${current.id}?`,
			"This only affects future chats; the current chat keeps its snapshot.",
		);
		if (!confirmed) return;

		await memories.remove(this.activeScope, this.ctx.cwd, current.id);
		await this.refresh();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.switchScope();
			return;
		}

		if (matchesKey(data, "up")) {
			this.moveSelection(-1);
			return;
		}

		if (matchesKey(data, "down")) {
			this.moveSelection(1);
			return;
		}

		if (data === "a") {
			void this.addMemory();
			return;
		}

		if (data === "e") {
			void this.editCurrentMemory();
			return;
		}

		if (data === "d") {
			void this.deleteCurrentMemory();
			return;
		}

		if (data === "r") {
			void this.refresh();
		}
	}

	private renderHeader(width: number): string {
		const header = this.theme.fg("accent", " Memories ") + this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 11)));
		return truncateToWidth(header, width);
	}

	private renderMemoryLine(memory: MemoryItem, isSelected: boolean, width: number): string {
		const prefix = isSelected ? this.theme.fg("accent", ">") : " ";
		const label = `  ${prefix} #${memory.id} ${memory.text}`;
		return truncateToWidth(isSelected ? this.theme.fg("accent", label) : label, width);
	}

	private renderScopeSection(scope: Scope, width: number): string[] {
		const store = this.getStore(scope);
		const active = scope === this.activeScope;
		const lines = [
			truncateToWidth(`${active ? this.theme.fg("accent", ">") : " "} ${formatScopeLabel(scope)} (${store.memories.length})`, width),
		];

		if (store.memories.length === 0) {
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", "(none)")}`, width));
			return lines;
		}

		const selected = this.selectedByScope[scope] ?? 0;
		const start = Math.max(0, Math.min(selected - Math.floor(MAX_VISIBLE_MEMORIES / 2), Math.max(0, store.memories.length - MAX_VISIBLE_MEMORIES)));
		const visible = store.memories.slice(start, start + MAX_VISIBLE_MEMORIES);

		for (let index = 0; index < visible.length; index++) {
			const memory = visible[index]!;
			const isSelected = active && start + index === selected;
			lines.push(this.renderMemoryLine(memory, isSelected, width));
		}

		if (store.memories.length > visible.length) {
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", `… ${store.memories.length - visible.length} more`)}`, width));
		}

		return lines;
	}

	private renderPreview(width: number): string[] {
		const current = this.currentMemory();
		return [
			truncateToWidth(this.theme.fg("muted", "Selected memory preview:"), width),
			truncateToWidth(current ? current.text : this.theme.fg("dim", "(no memory selected)"), width),
		];
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines = [
			this.renderHeader(width),
			truncateToWidth(this.theme.fg("muted", "Tab switches scope • a add • e edit • d delete • r refresh • Esc close"), width),
			truncateToWidth(this.theme.fg("warning", VIEWER_WARNING), width),
			"",
			...this.renderScopeSection("global", width),
			"",
			...this.renderScopeSection("project", width),
			"",
			...this.renderPreview(width),
		];

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

function toolResultForList(scope: Scope, store: MemoryStore): ToolResponse {
	return {
		content: [{ type: "text", text: `${formatScopeLabel(scope)} memories\n${formatMemoryList(store.memories)}` }],
		details: { scope, memories: store.memories },
	};
}

async function runRememberToolAction(action: MemoryAction, params: any, ctx: any): Promise<ToolResponse> {
	const scope = params.scope as Scope;

	if (action === "list") {
		const store = await memories.list(scope, ctx.cwd);
		return toolResultForList(scope, store);
	}

	if (action === "clear") {
		if (!ctx.hasUI) {
			return toolError(scope, `Error: UI required to confirm clearing ${scope} memories.`);
		}

		const confirmed = await ctx.ui.confirm(
			`Clear ${scope} memories?`,
			"This will delete all saved instructions in that scope. The current chat will still use its cached snapshot.",
		);
		if (!confirmed) return toolCancelled(scope);

		const count = await memories.clear(scope, ctx.cwd);
		return {
			content: [{ type: "text", text: `Cleared ${count} ${scope} memory${count === 1 ? "" : "s"}` }],
			details: { scope, cleared: count },
		};
	}

	if (action === "add") {
		let text = params.text?.trim();
		if (!text && ctx.hasUI) text = await askForMemoryText(ctx);
		if (!text) return toolError(scope, "Error: memory text is required.");

		const memory = await memories.add(scope, ctx.cwd, text);
		const updatedStore = await memories.list(scope, ctx.cwd);
		return {
			content: [{ type: "text", text: `Saved ${scope} memory #${memory.id}. ${NEW_CHATS_NOTE}` }],
			details: { scope, memory, memories: updatedStore.memories },
		};
	}

	if (action === "update") {
		const store = await memories.list(scope, ctx.cwd);
		let id = params.id;
		if (id === undefined && ctx.hasUI) id = await askForMemoryId(ctx, store.memories);
		if (id === undefined) return toolError(scope, "Error: memory id is required for update.");

		const existing = store.memories.find((entry) => entry.id === id);
		if (!existing) return toolError(scope, `Error: memory #${id} not found.`);

		let text = params.text?.trim();
		if (!text && ctx.hasUI) text = await askForMemoryText(ctx, existing.text);
		if (!text) return toolError(scope, "Error: memory text is required for update.");

		const updated = await memories.update(scope, ctx.cwd, id, text);
		if (!updated) return toolError(scope, `Error: memory #${id} not found.`);

		const updatedStore = await memories.list(scope, ctx.cwd);
		return {
			content: [{ type: "text", text: `Updated ${scope} memory #${updated.id}. ${NEW_CHATS_NOTE}` }],
			details: { scope, memory: updated, memories: updatedStore.memories },
		};
	}

	if (action === "remove") {
		const store = await memories.list(scope, ctx.cwd);
		let id = params.id;
		if (id === undefined && ctx.hasUI) id = await askForMemoryId(ctx, store.memories);
		if (id === undefined) return toolError(scope, "Error: memory id is required for remove.");

		const existing = store.memories.find((entry) => entry.id === id);
		if (!existing) return toolError(scope, `Error: memory #${id} not found.`);

		const removed = await memories.remove(scope, ctx.cwd, id);
		if (!removed) return toolError(scope, `Error: memory #${id} not found.`);

		const updatedStore = await memories.list(scope, ctx.cwd);
		return {
			content: [{ type: "text", text: `Removed ${scope} memory #${removed.id}. ${NEW_CHATS_NOTE}` }],
			details: { scope, removed, memories: updatedStore.memories },
		};
	}

	return toolError(scope, `Error: unsupported action ${action}`);
}

export default function memoriesExtension(pi: ExtensionAPI) {
	let activeSnapshot: MemorySnapshot = emptySnapshot();

	pi.on("session_start", async (_event, ctx) => {
		activeSnapshot = await memories.loadSnapshot(ctx.cwd);
		pi.appendEntry(SNAPSHOT_TYPE, activeSnapshot);
	});

	pi.on("before_agent_start", async (event) => {
		const prompt = buildMemoryPrompt(activeSnapshot);
		if (!prompt) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description: "Store durable user instructions or preferences in global or project scope.",
		promptSnippet: "Persist durable user preferences or project instructions in global or project scope.",
		promptGuidelines: [
			"Use this tool for durable user preferences, project instructions, and repeated workflow constraints.",
			"Prefer project scope for repo-specific instructions and global scope for personal preferences.",
			"If the instruction is ambiguous or incomplete, ask a follow-up question before storing it.",
			"When editing a memory, remember the change only affects new chats; the current chat keeps its cached snapshot.",
		],
		parameters: MemoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runRememberToolAction(params.action as MemoryAction, params, ctx);
		},
	});

	pi.registerCommand("memories", {
		description: "Open the memories viewer (usage: /memories [all|global|project])",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				const raw = args.trim().toLowerCase();
				const scopes: Scope[] = raw === "global" || raw === "project" ? [raw] : ["global", "project"];
				const snapshot = await memories.loadSnapshot(ctx.cwd);
				const lines = ["Memories", "", `Project root: ${findProjectRoot(ctx.cwd)}`, ""];
				for (const scope of scopes) {
					const store = scope === "global" ? snapshot.global : snapshot.project;
					lines.push(`${formatScopeLabel(scope)} (${store.memories.length})`);
					lines.push(formatMemoryList(store.memories));
					lines.push("");
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const component = new MemoryBrowser(
					ctx,
					theme,
					() => {
						ctx.ui.setWidget("memories-status", [], { placement: "belowEditor" });
						done();
					},
					() => memories.loadSnapshot(ctx.cwd),
				);

				component.setSnapshot(activeSnapshot);
				ctx.ui.setWidget("memories-status", viewerStatusLines("project"), { placement: "belowEditor" });

				return {
					render: (width) => component.render(width),
					handleInput: (data) => component.handleInput(data),
					invalidate: () => {
						// no-op; component manages its own cache
					},
				};
			});
		},
	});

	pi.registerCommand("remember", {
		description: "Add a memory (usage: /remember [global|project] <text>)",
		handler: async (args, ctx) => {
			let { scope, rest } = parseCommandArgs(args);
			if (!scope) scope = await askForScope(ctx);
			if (!scope) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			let text = rest.trim();
			if (!text && ctx.hasUI) text = (await askForMemoryText(ctx)) ?? "";
			if (!text) {
				ctx.ui.notify("Memory text is required", "error");
				return;
			}

			const memory = await memories.add(scope, ctx.cwd, text);
			ctx.ui.notify(`Saved ${scope} memory #${memory.id}. ${NEW_CHATS_NOTE}`, "info");
		},
	});

	pi.registerCommand("forget", {
		description: "Remove a memory (usage: /forget [global|project] <id>)",
		handler: async (args, ctx) => {
			let { scope, rest } = parseCommandArgs(args);
			if (!scope) scope = await askForScope(ctx);
			if (!scope) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const store = await memories.list(scope, ctx.cwd);
			let id = Number(rest.trim());
			if ((!Number.isFinite(id) || id <= 0) && ctx.hasUI) id = (await askForMemoryId(ctx, store.memories)) ?? NaN;
			if (!Number.isFinite(id) || id <= 0) {
				ctx.ui.notify("Memory id is required", "error");
				return;
			}

			const result = await memories.remove(scope, ctx.cwd, id);
			if (!result) {
				ctx.ui.notify(`Memory #${id} not found`, "warning");
				return;
			}

			ctx.ui.notify(`Removed ${scope} memory #${id}. ${NEW_CHATS_NOTE}`, "info");
		},
	});
}
