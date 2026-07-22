import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CONTROLLER_KEY = Symbol.for("pi.reference-tool-cards.controller");
const PATCH_KEY = Symbol.for("pi.reference-tool-cards.patched");
const PARALLEL_WIDGET_KEY = "reference-tool-cards.parallel";
const TIMING_ENTRY_TYPE = "reference-tool-cards.timing-v1";
const PI_DIFF_COMPAT_KEY = Symbol.for("pi.reference-tool-cards.pi-diff-compatible");
const PI_DIFF_MAX_PREVIEW_LINES = 60;
const COLLAPSED_PREVIEW_LINES = 8;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type ToolExecutionInstance = {
	args?: Record<string, unknown>;
	expanded?: boolean;
	isPartial?: boolean;
	result?: { details?: unknown; isError?: boolean };
	resultRendererComponent?: PiDiffTextComponent;
	toolCallId?: string;
	toolName?: string;
};

type ToolExecutionPrototype = {
	getRenderContext(lastComponent: unknown): Record<string, unknown>;
	markExecutionStarted(): void;
	render(width: number): string[];
	updateResult(result: { isError?: boolean }, isPartial?: boolean): void;
	[PATCH_KEY]?: boolean;
};

interface ToolTiming {
	startedAt?: number;
	endedAt?: number;
	isError: boolean;
	parallelPeak: number;
	parallelGroupId?: string;
	parallelIndex?: number;
	parallelTotal?: number;
	reasoningLevel?: ThinkingLevel;
}

interface PersistedToolTiming {
	version: 1;
	toolCallId: string;
	startedAt: number;
	endedAt: number;
	isError: boolean;
	parallelPeak: number;
	parallelGroupId?: string;
	parallelIndex?: number;
	parallelTotal?: number;
	reasoningLevel?: ThinkingLevel;
}

interface ToolCardController {
	theme?: Theme;
	timings: Map<string, ToolTiming>;
	runningIds: Set<string>;
	preflightedIds: Set<string>;
	parallelPeak: number;
	parallelGroupCounter: number;
	parallelGroupIds: string[];
	runtimeId: string;
	piDiff?: PiDiffModule;
}

interface ToolExecutionModule {
	ToolExecutionComponent?: { prototype: ToolExecutionPrototype };
}

interface PiDiffLine {
	type: "add" | "del" | "ctx" | "sep";
	content: string;
	oldNum?: number | null;
	newNum?: number | null;
}

interface PiDiffDetails {
	_type: "editInfo" | "multiEditInfo";
	diff: { lines: PiDiffLine[]; added: number; removed: number; chars: number };
	language?: string;
}

interface PiDiffRenderOptions {
	compactGutter?: boolean;
}

interface PiDiffModule {
	resolveDiffColors(theme: Theme): unknown;
	renderUnified(
		diff: PiDiffDetails["diff"],
		language: string | undefined,
		maxLines: number,
		colors: unknown,
		width: number,
		options?: PiDiffRenderOptions,
	): Promise<string>;
}

interface PiDiffTask {
	render(width: number): Promise<string> | string;
	[PI_DIFF_COMPAT_KEY]?: boolean;
}

interface PiDiffTextComponent {
	__piDiffTask?: PiDiffTask;
}

/** Returns process-global state so the prototype patch remains reload-safe. */
function getController(): ToolCardController {
	const globalState = globalThis as typeof globalThis & { [CONTROLLER_KEY]?: ToolCardController };
	globalState[CONTROLLER_KEY] ??= {
		timings: new Map<string, ToolTiming>(),
		runningIds: new Set<string>(),
		preflightedIds: new Set<string>(),
		parallelPeak: 0,
		parallelGroupCounter: 0,
		parallelGroupIds: [],
		runtimeId: createRuntimeId(),
	};
	globalState[CONTROLLER_KEY].preflightedIds ??= new Set<string>();
	globalState[CONTROLLER_KEY].parallelGroupCounter ??= 0;
	globalState[CONTROLLER_KEY].parallelGroupIds ??= [];
	globalState[CONTROLLER_KEY].runtimeId ??= createRuntimeId();
	return globalState[CONTROLLER_KEY];
}

/** Creates an opaque prefix so persisted parallel-group IDs cannot collide across runtimes. */
function createRuntimeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Locates Pi's live ToolExecutionComponent module without loading a second SDK copy. */
function findToolExecutionModulePath(): string | undefined {
	const relativePath = join("modes", "interactive", "components", "tool-execution.js");
	const candidates: string[] = [];
	const cliEntry = process.argv[1];
	if (cliEntry) candidates.push(resolve(dirname(cliEntry), relativePath));
	if (process.env.APPDATA) {
		candidates.push(
			resolve(
				process.env.APPDATA,
				"npm",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"dist",
				relativePath,
			),
		);
	}
	return candidates.find((candidate) => existsSync(candidate));
}

/** Loads pi-diff's rendering helpers when that optional package is installed. */
async function loadPiDiffModule(): Promise<PiDiffModule | undefined> {
	const relativePath = join(
		"npm",
		"node_modules",
		"@heyhuynhgiabuu",
		"pi-diff",
		"dist",
		"review",
		"hunk-preview.js",
	);
	const candidates = [join(getAgentDir(), relativePath), join(process.cwd(), ".pi", relativePath)];
	const modulePath = candidates.find((candidate) => existsSync(candidate));
	if (!modulePath) return undefined;
	try {
		return (await import(pathToFileURL(modulePath).href)) as PiDiffModule;
	} catch {
		return undefined;
	}
}

/** Gets or creates metadata for one tool row without assuming execution has started. */
function getTiming(controller: ToolCardController, toolCallId: string): ToolTiming {
	let timing = controller.timings.get(toolCallId);
	if (!timing) {
		timing = { isError: false, parallelPeak: 1 };
		controller.timings.set(toolCallId, timing);
	}
	return timing;
}

/** Finds every sibling tool call from the assistant message containing this call. */
function findToolBatchIds(ctx: ExtensionContext, toolCallId: string): string[] {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const ids = entry.message.content
			.filter((part) => part.type === "toolCall")
			.map((part) => part.id);
		if (ids.includes(toolCallId)) return ids;
	}
	return [toolCallId];
}

/** Starts a batch timer once every sibling has completed tool-call preflight. */
function markBatchReady(ctx: ExtensionContext, controller: ToolCardController, toolCallId: string): void {
	controller.preflightedIds.add(toolCallId);
	const batchIds = findToolBatchIds(ctx, toolCallId);
	if (!batchIds.every((id) => controller.preflightedIds.has(id))) return;
	const startedAt = Date.now();
	for (const id of batchIds) {
		getTiming(controller, id).startedAt ??= startedAt;
		controller.preflightedIds.delete(id);
	}
}

/** Maps a saved reasoning level to the matching colors in the active theme. */
function getReasoningColor(level: ThinkingLevel | undefined): ThemeColor {
	switch (level) {
		case "off":
			return "thinkingOff";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "borderAccent";
	}
}

/** Checks persisted values before allowing session data into the render controller. */
function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value));
}

/** Parses one versioned timing entry from the active session branch. */
function parsePersistedTiming(data: unknown): PersistedToolTiming | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = data as Partial<PersistedToolTiming>;
	if (
		value.version !== 1 ||
		typeof value.toolCallId !== "string" ||
		typeof value.startedAt !== "number" ||
		!Number.isFinite(value.startedAt) ||
		typeof value.endedAt !== "number" ||
		!Number.isFinite(value.endedAt) ||
		value.endedAt < value.startedAt ||
		typeof value.isError !== "boolean" ||
		typeof value.parallelPeak !== "number" ||
		!Number.isInteger(value.parallelPeak) ||
		value.parallelPeak < 1
	) return undefined;
	if (value.reasoningLevel !== undefined && !isThinkingLevel(value.reasoningLevel)) return undefined;
	if (value.parallelGroupId !== undefined) {
		if (
			typeof value.parallelGroupId !== "string" ||
			typeof value.parallelIndex !== "number" ||
			!Number.isInteger(value.parallelIndex) ||
			value.parallelIndex < 0 ||
			typeof value.parallelTotal !== "number" ||
			!Number.isInteger(value.parallelTotal) ||
			value.parallelTotal < 2 ||
			value.parallelIndex >= value.parallelTotal
		) return undefined;
	}
	return value as PersistedToolTiming;
}

/** Restores exact saved metadata and infers grouping/colors for older session entries. */
function restoreTimings(ctx: ExtensionContext, controller: ToolCardController): void {
	controller.timings.clear();
	controller.runningIds.clear();
	controller.preflightedIds.clear();
	controller.parallelPeak = 0;
	controller.parallelGroupCounter = 0;
	controller.parallelGroupIds = [];
	controller.runtimeId = createRuntimeId();
	let reasoningLevel: ThinkingLevel | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "thinking_level_change") {
			reasoningLevel = isThinkingLevel(entry.thinkingLevel) ? entry.thinkingLevel : undefined;
			continue;
		}
		if (entry.type === "custom" && entry.customType === TIMING_ENTRY_TYPE) {
			const persisted = parsePersistedTiming(entry.data);
			if (persisted) {
				controller.timings.set(persisted.toolCallId, {
					startedAt: persisted.startedAt,
					endedAt: persisted.endedAt,
					isError: persisted.isError,
					parallelPeak: persisted.parallelPeak,
					parallelGroupId: persisted.parallelGroupId,
					parallelIndex: persisted.parallelIndex,
					parallelTotal: persisted.parallelTotal,
					reasoningLevel: persisted.reasoningLevel,
				});
			}
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			const calls = entry.message.content.filter((part) => part.type === "toolCall");
			const groupId = calls.length > 1 ? `inferred:${entry.id}` : undefined;
			calls.forEach((call, index) => {
				if (controller.timings.has(call.id)) return;
				controller.timings.set(call.id, {
					isError: false,
					parallelPeak: calls.length,
					parallelGroupId: groupId,
					parallelIndex: groupId ? index : undefined,
					parallelTotal: groupId ? calls.length : undefined,
					reasoningLevel,
				});
			});
		} else if (entry.message.role === "toolResult") {
			const timing = controller.timings.get(entry.message.toolCallId);
			if (timing) timing.isError = entry.message.isError;
		}
	}
}

/** Appends exact completed timing metadata without adding anything to LLM context. */
function persistTiming(pi: ExtensionAPI, toolCallId: string, timing: ToolTiming): void {
	if (timing.startedAt === undefined || timing.endedAt === undefined) return;
	pi.appendEntry(TIMING_ENTRY_TYPE, {
		version: 1,
		toolCallId,
		startedAt: timing.startedAt,
		endedAt: timing.endedAt,
		isError: timing.isError,
		parallelPeak: timing.parallelPeak,
		parallelGroupId: timing.parallelGroupId,
		parallelIndex: timing.parallelIndex,
		parallelTotal: timing.parallelTotal,
		reasoningLevel: timing.reasoningLevel,
	} satisfies PersistedToolTiming);
}

/** Formats a compact elapsed duration suitable for a card footer. */
function formatDuration(startedAt: number, endedAt: number): string {
	const elapsedMs = Math.max(0, endedAt - startedAt);
	if (elapsedMs < 1_000) return `${elapsedMs}ms`;
	if (elapsedMs < 10_000) return `${(elapsedMs / 1_000).toFixed(1)}s`;
	if (elapsedMs < 60_000) return `${Math.round(elapsedMs / 1_000)}s`;
	const minutes = Math.floor(elapsedMs / 60_000);
	const seconds = Math.round((elapsedMs % 60_000) / 1_000);
	return `${minutes}m ${seconds}s`;
}

/** Pads or truncates ANSI-styled text to an exact terminal-cell width. */
function fitLine(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const truncated = truncateToWidth(text, safeWidth, safeWidth >= 2 ? "…" : "");
	return truncated + " ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)));
}

/** Removes blank padding lines emitted by Pi's default tool shell. */
function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && plainText(lines[start] ?? "").trim().length === 0) start++;
	while (end > start && plainText(lines[end - 1] ?? "").trim().length === 0) end--;
	return lines.slice(start, end);
}

/** Removes terminal styling when deciding whether a rendered line is visually blank. */
function plainText(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
}

/** Limits built-in edit backgrounds to their content while retaining symmetric padding. */
function limitEditBackground(text: string): string {
	return text.replace(/( +)(\x1b\[49m)$/, (_match, spaces: string, reset: string) => {
		const highlightedPadding = spaces.slice(0, 1);
		return `${highlightedPadding}${reset}${spaces.slice(highlightedPadding.length)}`;
	});
}

/** Identifies the namespaced result payload emitted by the pi-diff edit override. */
function getPiDiffDetails(instance: ToolExecutionInstance): PiDiffDetails | undefined {
	if (instance.toolName !== "edit") return undefined;
	const details = instance.result?.details;
	if (!details || typeof details !== "object") return undefined;
	const value = details as Partial<PiDiffDetails>;
	if ((value._type !== "editInfo" && value._type !== "multiEditInfo") || !value.diff) return undefined;
	if (!Array.isArray(value.diff.lines)) return undefined;
	return value as PiDiffDetails;
}

/** Builds the same visible split rows pi-diff uses before applying its preview limit. */
function getPiDiffSplitRows(lines: PiDiffLine[]): Array<[PiDiffLine | undefined, PiDiffLine | undefined]> {
	const rows: Array<[PiDiffLine | undefined, PiDiffLine | undefined]> = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (!line) break;
		if (line.type === "ctx" || line.type === "sep") {
			rows.push([line, line]);
			index++;
			continue;
		}
		const deletions: PiDiffLine[] = [];
		while (lines[index]?.type === "del") deletions.push(lines[index++]!);
		const additions: PiDiffLine[] = [];
		while (lines[index]?.type === "add") additions.push(lines[index++]!);
		const count = Math.max(deletions.length, additions.length);
		for (let row = 0; row < count; row++) rows.push([deletions[row], additions[row]]);
	}
	return rows.slice(0, PI_DIFF_MAX_PREVIEW_LINES);
}

/** Determines whether pi-diff's visible split columns would create continuation rows. */
function piDiffSplitWouldWrap(details: PiDiffDetails, width: number): boolean {
	const bodyWidth = Math.max(1, width - 1);
	const maxLineNumber = details.diff.lines.reduce(
		(maximum, line) => Math.max(maximum, line.oldNum ?? 0, line.newNum ?? 0),
		0,
	);
	const numberWidth = Math.max(2, String(maxLineNumber).length);
	const codeWidth = Math.max(12, Math.floor(bodyWidth / 2) - (numberWidth + 3));
	return getPiDiffSplitRows(details.diff.lines).some(([left, right]) =>
		[left, right].some(
			(line) => line !== undefined && line.type !== "sep" && line.content.replace(/\t/g, "  ").length > codeWidth,
		),
	);
}

/** Adds pi-diff's one-cell body inset and closes its persistent base background. */
function framePiDiffUnifiedPreview(rendered: string, width: number, theme: Theme): string {
	const leftPadding = theme.bg("toolSuccessBg", " ");
	const body = rendered
		.split("\n")
		.map((line) => `${leftPadding}${line}\x1b[49m`)
		.join("\n");
	const bottomPadding = theme.bg("toolSuccessBg", " ".repeat(Math.max(1, width)));
	return `${body}\n${bottomPadding}`;
}

/** Adapts pi-diff to the card's inner width and suppresses split continuation rows. */
function preparePiDiffCompatibility(
	instance: ToolExecutionInstance,
	controller: ToolCardController,
): void {
	const details = getPiDiffDetails(instance);
	const task = instance.resultRendererComponent?.__piDiffTask;
	const piDiff = controller.piDiff;
	const theme = controller.theme;
	if (!details || !task || task[PI_DIFF_COMPAT_KEY] || !piDiff || !theme) return;

	const originalRender = task.render.bind(task);
	task.render = async (width: number): Promise<string> => {
		let rendered: string;
		if (piDiffSplitWouldWrap(details, width)) {
			const bodyWidth = Math.max(1, width - 1);
			const colors = piDiff.resolveDiffColors(theme);
			const unified = await piDiff.renderUnified(
				details.diff,
				details.language,
				PI_DIFF_MAX_PREVIEW_LINES,
				colors,
				bodyWidth,
				{ compactGutter: true },
			);
			rendered = framePiDiffUnifiedPreview(unified, width, theme);
		} else {
			rendered = await originalRender(width);
		}
		return rendered
			.split("\n")
			.map((line) => `${line}\x1b[49m`)
			.join("\n");
	};
	task[PI_DIFF_COMPAT_KEY] = true;
}

/** Composes a full-width rule with optional badges aligned to its right edge. */
function composeRuleHeader(right: string, width: number, renderRule: (text: string) => string): string {
	if (!right) return renderRule("─".repeat(width));
	const clippedRight = truncateToWidth(right, Math.max(1, width - 2), "…");
	const ruleWidth = Math.max(1, width - visibleWidth(clippedRight) - 1);
	return `${renderRule("─".repeat(ruleWidth))} ${clippedRight}`;
}

/** Places left and right content at opposite edges of a fixed-width row. */
function composeRow(left: string, right: string, width: number): string {
	const clippedRight = truncateToWidth(right, Math.max(1, width - 2), "…");
	const rightWidth = visibleWidth(clippedRight);
	const clippedLeft = truncateToWidth(left, Math.max(1, width - rightWidth - 1), "…");
	const gap = Math.max(1, width - visibleWidth(clippedLeft) - rightWidth);
	return fitLine(`${clippedLeft}${" ".repeat(gap)}${clippedRight}`, width);
}

/** Renders one complete reference-style tool card around Pi's existing tool output. */
function renderCard(
	instance: ToolExecutionInstance,
	originalLines: string[],
	width: number,
	controller: ToolCardController,
): string[] {
	const theme = controller.theme;
	if (!theme || width < 18) return originalLines;

	const trimmed = trimBlankLines(originalLines);
	const toolCallId = instance.toolCallId ?? "";
	const timing = toolCallId ? controller.timings.get(toolCallId) : undefined;
	const isDone = instance.isPartial === false || timing?.endedAt !== undefined;
	const isError = timing?.isError === true || instance.result?.isError === true;
	const reasoningColor = getReasoningColor(timing?.reasoningLevel);
	const badgeColor = isError ? "error" : reasoningColor;
	const status = theme.fg(badgeColor, isDone ? (isError ? "✕ Failed" : "✓ Completed") : "● Running");
	const isParallel = timing?.parallelGroupId !== undefined;
	const parallel = isParallel ? theme.fg(reasoningColor, "⇉ Parallel") : "";
	const timeout = typeof instance.args?.timeout === "number"
		? theme.fg(reasoningColor, `◷ timeout ${instance.args.timeout}s`)
		: "";
	const badges = [timeout, parallel, status].filter(Boolean).join(theme.fg("dim", "  "));

	const border = (text: string) => theme.fg(isError ? "error" : reasoningColor, text);
	const outerInnerWidth = width - 2;
	const topContentWidth = Math.max(1, width - 6);
	const hasPreviousParallelCard = isParallel && (timing?.parallelIndex ?? 0) > 0;
	const hasNextParallelCard =
		isParallel && (timing?.parallelIndex ?? 0) < (timing?.parallelTotal ?? 1) - 1;
	const header = composeRuleHeader(badges, topContentWidth, border);
	const lines = hasPreviousParallelCard
		? [`${border("│ ")}${composeRow("", badges, outerInnerWidth - 2)}${border(" │")}`]
		: [`${border("╭─")} ${header} ${border("─╮")}`];

	let body = trimBlankLines(trimmed);
	const piDiffDetails = getPiDiffDetails(instance);
	if (instance.toolName === "edit" && !piDiffDetails) body = body.map(limitEditBackground);
	if (piDiffDetails) body = body.map((line) => `${line}\x1b[49m`);
	if (body.length === 0) {
		body = [theme.fg("dim", isDone ? "No output" : "Waiting for output…")];
	}
	const maxBodyLines = instance.expanded ? body.length : COLLAPSED_PREVIEW_LINES;
	const hiddenLineCount = Math.max(0, body.length - maxBodyLines);
	body = body.slice(0, maxBodyLines);
	if (hiddenLineCount > 0) {
		body.push(
			theme.fg("dim", `… ${hiddenLineCount} more lines · ${keyHint("app.tools.expand", "expand")}`),
		);
	}

	const nestedRuleWidth = Math.max(0, width - 6);
	const nestedContentWidth = Math.max(1, width - 8);
	lines.push(`${border("│ ")}${theme.fg("borderMuted", `╭${"─".repeat(nestedRuleWidth)}╮`)}${border(" │")}`);
	for (const bodyLine of body) {
		lines.push(
			`${border("│ ")}${theme.fg("borderMuted", "│ ")}${fitLine(bodyLine, nestedContentWidth)}${theme.fg("borderMuted", " │")}${border(" │")}`,
		);
	}
	lines.push(`${border("│ ")}${theme.fg("borderMuted", `╰${"─".repeat(nestedRuleWidth)}╯`)}${border(" │")}`);

	let duration: string;
	if (timing?.startedAt !== undefined && timing.endedAt !== undefined) {
		duration = `◷ Took ${formatDuration(timing.startedAt, timing.endedAt)}`;
	} else if (isDone) {
		duration = "◷ Timing unavailable";
	} else {
		duration = timing?.startedAt === undefined ? "◷ Waiting to start" : "◷ In progress";
	}
	const durationLabel = theme.fg("dim", duration);
	lines.push(`${border("│")}${fitLine(` ${durationLabel}`, outerInnerWidth)}${border("│")}`);
	if (!hasNextParallelCard) {
		lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	}
	return lines;
}

/** Patches Pi's transcript component while delegating all tool-specific rendering. */
async function installToolExecutionPatch(): Promise<void> {
	const modulePath = findToolExecutionModulePath();
	if (!modulePath) throw new Error("Could not locate Pi's ToolExecutionComponent module.");
	const module = (await import(pathToFileURL(modulePath).href)) as ToolExecutionModule;
	const prototype = module.ToolExecutionComponent?.prototype;
	if (!prototype) throw new Error("Pi's ToolExecutionComponent export was not found.");
	if (prototype[PATCH_KEY]) return;

	const originalGetRenderContext = prototype.getRenderContext;
	const originalMarkExecutionStarted = prototype.markExecutionStarted;
	const originalUpdateResult = prototype.updateResult;
	const originalRender = prototype.render;

	prototype.getRenderContext = function (lastComponent: unknown): Record<string, unknown> {
		return originalGetRenderContext.call(this, lastComponent);
	};
	prototype.markExecutionStarted = function (): void {
		const instance = this as unknown as ToolExecutionInstance;
		if (instance.toolCallId) getTiming(getController(), instance.toolCallId);
		originalMarkExecutionStarted.call(this);
	};
	prototype.updateResult = function (result: { isError?: boolean }, isPartial = false): void {
		const instance = this as unknown as ToolExecutionInstance;
		const controller = getController();
		if (instance.toolCallId && !isPartial) {
			const timing = controller.timings.get(instance.toolCallId);
			if (timing?.startedAt !== undefined) {
				timing.endedAt ??= Date.now();
				timing.isError = result.isError === true;
			}
		}
		originalUpdateResult.call(this, result, isPartial);
	};
	prototype.render = function (width: number): string[] {
		const instance = this as unknown as ToolExecutionInstance;
		const controller = getController();
		preparePiDiffCompatibility(instance, controller);
		const contentWidth = Math.max(1, width - 8);
		const originalLines = originalRender.call(this, contentWidth);
		return renderCard(instance, originalLines, width, controller);
	};
	prototype[PATCH_KEY] = true;
}

/** Updates the temporary global indicator for concurrently executing tools. */
function updateParallelWidget(ctx: ExtensionContext, controller: ToolCardController): void {
	if (controller.parallelPeak <= 1 || controller.runningIds.size === 0) {
		ctx.ui.setWidget(PARALLEL_WIDGET_KEY, undefined);
		if (controller.runningIds.size === 0) controller.parallelPeak = 0;
		return;
	}
	const active = controller.runningIds.size;
	const activeLevel = [...controller.runningIds]
		.map((id) => controller.timings.get(id)?.reasoningLevel)
		.find((level): level is ThinkingLevel => level !== undefined);
	ctx.ui.setWidget(PARALLEL_WIDGET_KEY, [
		ctx.ui.theme.fg(getReasoningColor(activeLevel), "⇉ Parallel tools") +
			ctx.ui.theme.fg("dim", `  ${active} running · ${controller.parallelPeak} in batch`),
	]);
}

/** Installs reference-style cards for every built-in and extension-provided tool. */
export default async function toolCardsExtension(pi: ExtensionAPI): Promise<void> {
	const controller = getController();
	controller.piDiff = await loadPiDiffModule();
	await installToolExecutionPatch();

	pi.on("session_start", (_event, ctx) => {
		controller.theme = ctx.ui.theme;
		restoreTimings(ctx, controller);
		ctx.ui.setWidget(PARALLEL_WIDGET_KEY, undefined);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (controller.runningIds.size > 0) return;
		controller.theme = ctx.ui.theme;
		restoreTimings(ctx, controller);
		ctx.ui.setWidget(PARALLEL_WIDGET_KEY, undefined);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const timing = getTiming(controller, event.toolCallId);
		timing.reasoningLevel = pi.getThinkingLevel();
		controller.runningIds.add(event.toolCallId);
		controller.parallelPeak = Math.max(controller.parallelPeak, controller.runningIds.size);
		if (controller.parallelPeak > 1) {
			if (controller.parallelGroupIds.length === 0) {
				controller.parallelGroupCounter++;
				controller.parallelGroupIds = [...controller.runningIds];
			} else if (!controller.parallelGroupIds.includes(event.toolCallId)) {
				controller.parallelGroupIds.push(event.toolCallId);
			}
			const groupId = `${controller.runtimeId}:${controller.parallelGroupCounter}`;
			const total = controller.parallelGroupIds.length;
			controller.parallelGroupIds.forEach((runningId, index) => {
				const runningTiming = getTiming(controller, runningId);
				runningTiming.parallelPeak = Math.max(runningTiming.parallelPeak, controller.parallelPeak);
				runningTiming.parallelGroupId = groupId;
				runningTiming.parallelIndex = index;
				runningTiming.parallelTotal = total;
			});
			timing.parallelPeak = controller.parallelPeak;
		}
		updateParallelWidget(ctx, controller);
	});

	pi.on("tool_call", (event, ctx) => {
		markBatchReady(ctx, controller, event.toolCallId);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const timing = getTiming(controller, event.toolCallId);
		timing.endedAt ??= Date.now();
		timing.isError = event.isError;
		timing.parallelPeak = Math.max(timing.parallelPeak, controller.parallelPeak || 1);
		controller.runningIds.delete(event.toolCallId);
		controller.preflightedIds.delete(event.toolCallId);
		updateParallelWidget(ctx, controller);
		if (timing.parallelGroupId === undefined) persistTiming(pi, event.toolCallId, timing);
		if (controller.runningIds.size === 0 && controller.parallelGroupIds.length > 0) {
			for (const groupedId of controller.parallelGroupIds) {
				const groupedTiming = controller.timings.get(groupedId);
				if (groupedTiming) persistTiming(pi, groupedId, groupedTiming);
			}
			controller.parallelGroupIds = [];
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget(PARALLEL_WIDGET_KEY, undefined);
		controller.runningIds.clear();
		controller.preflightedIds.clear();
		controller.parallelPeak = 0;
	});
}
