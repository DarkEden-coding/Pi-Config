/** Inclusive activity indexes or character offsets, depending on the reader. */
export type ActivityRegion = { start: number; end: number };

export type ActivityReadOptions = {
	agents: string[];
	after?: number;
	readRegion?: ActivityRegion;
	limit?: number;
	offset?: number;
};

type ActivityEvent = {
	index: number;
	agent: string;
	toolKey?: string;
	row: string;
	details: string;
};

type ToolStart = { summary: string; args: string };

const EVENT_CAP = 20;
const TEXT_CAP = 4_000;
const DETAIL_CAP = 64_000;
const DETAIL_PAGE_CHARS = 3_600;
const SUMMARY_VALUE_CAP = 180;

/** Bounds text while making loss explicit. */
function clipped(value: string, limit: number): string {
	const notice = `… [truncated; ${value.length} chars]`;
	return value.length <= limit ? value : `${value.slice(0, limit - notice.length)}${notice}`;
}

/** Serializes tool data with bounded strings and support for non-JSON extension values. */
function stringify(value: unknown, limit: number): string {
	const seen = new WeakSet<object>();
	const text =
		JSON.stringify(
			value,
			(_key, item: unknown) => {
				if (typeof item === "string") return clipped(item, limit);
				if (typeof item === "bigint") return String(item);
				if (typeof item === "object" && item !== null) {
					if (seen.has(item)) return "[circular]";
					seen.add(item);
				}
				return item;
			},
			2,
		) ?? String(value);
	return clipped(text, limit);
}

/** Reads one parameter without imposing a tool-specific argument interface. */
function valueAt(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** Keeps activity rows single-line even when commands or error messages span lines. */
function singleLine(value: string, limit: number): string {
	return clipped(value.replace(/\s+/g, " ").trim(), limit);
}

/** Produces small tool parameters without exposing edit or write bodies. */
function summarizeArgs(toolName: string, args: unknown): string {
	/** Selects the useful scalar parameters for known tools. */
	const pick = (...keys: string[]): Array<[string, unknown]> =>
		keys.map((key): [string, unknown] => [key, valueAt(args, key)]).filter(([, value]) => value !== undefined);
	let entries: Array<[string, unknown]>;
	switch (toolName.toLowerCase()) {
		case "read":
		case "grep":
		case "find":
		case "ls":
		case "fffind":
		case "ffgrep":
			entries = pick("path", "pattern", "query", "exclude", "offset", "limit", "context", "caseSensitive");
			break;
		case "edit":
		case "write": {
			entries = pick("path");
			const edits = valueAt(args, "edits");
			if (Array.isArray(edits)) entries.push(["edits", edits.length]);
			else if (toolName.toLowerCase() === "edit") entries.push(["edits", 1]);
			const content = valueAt(args, "content");
			if (typeof content === "string") entries.push(["contentChars", content.length]);
			break;
		}
		case "apply_patch": {
			const changes = valueAt(args, "changes");
			entries = Array.isArray(changes)
				? [
						["changes", changes.length],
						...changes
							.slice(0, 4)
							.map((change): [string, unknown] => [
								String(valueAt(change, "action") ?? "change"),
								valueAt(change, "path"),
							]),
					]
				: [["patch", "[body omitted]"]];
			break;
		}
		case "bash":
		case "background_terminal":
		case "background_terminal_control":
			entries = pick("command", "commands", "cwd", "timeout", "maxRuntimeSeconds", "timeoutSeconds", "id", "action");
			break;
		default:
			entries = Object.entries(args !== null && typeof args === "object" ? args : {})
				.slice(0, 6)
				.map(([key, value]) => [
					key,
					/content|body|text|prompt|script|patch|edits|changes/i.test(key)
						? `[omitted${typeof value === "string" ? ` ${value.length} chars` : ""}]`
						: value !== null && typeof value === "object"
							? "[structured value]"
							: value,
				]);
	}
	return singleLine(
		entries
			.map(([key, value]) => `${key}=${singleLine(stringify(value, SUMMARY_VALUE_CAP), SUMMARY_VALUE_CAP)}`)
			.join(" "),
		700,
	);
}

/** Extracts useful error text from native Pi tool results without their full envelope. */
function errorExcerpt(result: unknown): string {
	const content = valueAt(result, "content");
	const text = Array.isArray(content)
		? content
				.filter((part) => valueAt(part, "type") === "text")
				.map((part) => valueAt(part, "text"))
				.join(" ")
		: undefined;
	const error = text || valueAt(result, "error") || valueAt(result, "message") || result;
	return singleLine(typeof error === "string" ? error : stringify(error, 400), 400);
}

/** Prevents identical tool-call IDs in different sub-agent sessions from colliding. */
function toolKey(agent: string, toolCallId: string): string {
	return JSON.stringify([agent, toolCallId]);
}

/** Validates ranges for direct callers as well as schema-validated tool calls. */
function validateRegion(region: ActivityRegion | undefined): void {
	if (
		region &&
		(!Number.isSafeInteger(region.start) ||
			!Number.isSafeInteger(region.end) ||
			region.start < 0 ||
			region.end < region.start)
	) {
		throw new RangeError("Region must contain nonnegative integer offsets with end >= start.");
	}
}

/** Stores per-event bounded snapshots until the parent session shuts down. */
export class AgentActivityLog {
	private readonly events: ActivityEvent[] = [];
	private readonly starts = new Map<string, ToolStart>();

	/** Records an immutable snapshot and a compact row at the next global change index. */
	private append(agent: string, summary: string, details: string, key?: string): void {
		const index = this.events.length;
		this.events.push({
			index,
			agent,
			toolKey: key,
			row: `${index}. ${singleLine(agent, 120)} · ${summary} · details:${index}`,
			details: clipped(`actionIndex: ${index}\nagent: ${agent}\n${details}`, DETAIL_CAP),
		});
	}

	/** Records a start; only its bounded arguments are kept for pairing with completion. */
	startTool(agent: string, toolCallId: string, toolName: string, args: unknown): void {
		const key = toolKey(agent, toolCallId);
		const start = { summary: summarizeArgs(toolName, args), args: stringify(args, 30_000) };
		this.starts.set(key, start);
		this.append(
			agent,
			`${singleLine(toolName, 120)} · running · ${start.summary}`,
			`tool: ${toolName}\ntoolCallId: ${toolCallId}\nstatus: running\nargs:\n${start.args}`,
			key,
		);
	}

	/** Records completion at a new index so polling after the start cannot miss it. */
	endTool(agent: string, toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
		const key = toolKey(agent, toolCallId);
		const start = this.starts.get(key);
		const state = isError ? `error: ${errorExcerpt(result)}` : "ok";
		this.append(
			agent,
			`${singleLine(toolName, 120)} · ${state}${start ? ` · ${start.summary}` : ""}`,
			`tool: ${toolName}\ntoolCallId: ${toolCallId}\nstatus: ${isError ? "error" : "ok"}\nresult:\n${stringify(result, 30_000)}\nargs:\n${start?.args ?? "[start unavailable]"}`,
			key,
		);
		this.starts.delete(key);
	}

	/** Records lifecycle and steering receipts without assistant narration. */
	record(agent: string, type: string, text?: string): void {
		this.append(
			agent,
			`${singleLine(type, 120)}${text ? ` · ${singleLine(text, 700)}` : ""}`,
			`type: ${type}\ntext:\n${text ?? ""}`,
		);
	}

	/** Reads compact changes with a total budget, advancing only over events represented in the page. */
	read(options: ActivityReadOptions): { text: string; nextCursor: number; hasMore: boolean } {
		validateRegion(options.readRegion);
		if (options.after !== undefined && (!Number.isSafeInteger(options.after) || options.after < -1))
			throw new RangeError("after must be an integer >= -1.");
		if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0))
			throw new RangeError("offset must be a nonnegative integer.");
		if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1))
			throw new RangeError("limit must be a positive integer.");
		if ([options.after, options.readRegion, options.offset].filter((value) => value !== undefined).length > 1)
			throw new Error("Use only one of after, readRegion, or offset.");
		const agents = new Set(options.agents);
		let matches = this.events.filter((event) => agents.has(event.agent));
		if (options.readRegion)
			matches = matches.filter(
				(event) => event.index >= options.readRegion!.start && event.index <= options.readRegion!.end,
			);
		else if (options.after !== undefined) matches = matches.filter((event) => event.index > options.after!);
		else if (options.offset !== undefined) matches = matches.slice(options.offset);
		else matches = matches.slice(-(options.limit ?? 4));
		const limit = Math.min(EVENT_CAP, options.limit ?? EVENT_CAP);
		let rows = new Map<string, string>();
		let consumed = 0;
		for (const event of matches.slice(0, limit)) {
			const candidate = new Map(rows);
			const key = event.toolKey ?? `event:${event.index}`;
			// A completion replaces its start in this page, in completion order.
			candidate.delete(key);
			candidate.set(key, event.row);
			if ([...candidate.values()].join("\n").length > TEXT_CAP - 160) break;
			rows = candidate;
			consumed++;
		}
		const nextCursor = consumed
			? matches[consumed - 1].index
			: (options.after ?? (options.readRegion ? options.readRegion.start - 1 : -1));
		const hasMore = matches.length > consumed;
		const body = [...rows.values()].join("\n") || "No recorded actions.";
		return { text: `${body}\nnextCursor: ${nextCursor}; hasMore: ${hasMore}`, nextCursor, hasMore };
	}

	/** Reads an immutable detail snapshot with exact continuation offsets and explicit retention limits. */
	readDetails(actionIndex: number, region?: ActivityRegion, agents?: string[]): { text: string } {
		validateRegion(region);
		if (!Number.isSafeInteger(actionIndex) || actionIndex < 0)
			throw new RangeError("actionIndex must be a nonnegative integer.");
		const event = this.events[actionIndex];
		if (!event) throw new Error(`No action at index ${actionIndex}.`);
		if (agents && !agents.includes(event.agent))
			throw new Error(`Action ${actionIndex} belongs to ${event.agent}, outside the selected agents.`);
		const full = event.details;
		const start = Math.min(region?.start ?? 0, full.length);
		const end = Math.min(full.length, (region?.end ?? full.length - 1) + 1, start + DETAIL_PAGE_CHARS);
		const more = end < full.length;
		const notice = `[chars ${start}-${Math.max(start, end - 1)} of ${full.length}; hasMore: ${more}${more ? `; next detailRegion: {start: ${end}, end: ${end + DETAIL_PAGE_CHARS - 1}}` : ""}]`;
		return { text: `${full.slice(start, end)}\n${notice}` };
	}
}
