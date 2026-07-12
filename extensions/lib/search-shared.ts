import { truncateHead, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import fs from "fs";
import path from "path";

const KEYS_FILE = path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent", "api-keys.json");
const COLLAPSED_OUTPUT_MAX_LINES = 4;
const EXPANDED_OUTPUT_MAX_LINES = 24;

type ToolResult = {
	content?: Array<{ type: string; text?: string }>;
	details?: any;
	error?: unknown;
};

export function loadKeys(): Record<string, string> {
	try {
		if (fs.existsSync(KEYS_FILE)) {
			return JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
		}
	} catch {
		// Ignore malformed or unreadable key files.
	}
	return {};
}

export function saveKeys(keys: Record<string, string>): void {
	try {
		fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
		fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), "utf-8");
	} catch {
		// Ignore key persistence failures.
	}
}

export function getApiKey(service: "brave" | "context7" | "exa"): string | undefined {
	const envKey = service === "brave" ? process.env.BRAVE_API_KEY : service === "context7" ? process.env.CONTEXT7_API_KEY : process.env.EXA_API_KEY;
	if (envKey) return envKey;

	const keys = loadKeys();
	return keys[service];
}

function firstText(result: ToolResult): string {
	return result.content?.find((content) => content.type === "text")?.text ?? "";
}

function errorText(result: ToolResult): string {
	const error = result.error ?? result.details?.error;
	if (!error) return "";
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error, null, 2);
	} catch {
		return String(error);
	}
}

export function renderTruncatedToolResult(
	result: ToolResult,
	{ expanded, isError }: { expanded: boolean; isError?: boolean },
	theme: any,
): Text {
	const error = errorText(result).trim();
	const text = (error || firstText(result)).trim();
	if (!text) return new Text("", 0, 0);

	const truncation = truncateHead(text, {
		maxLines: expanded ? EXPANDED_OUTPUT_MAX_LINES : COLLAPSED_OUTPUT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let output = truncation.content;
	if (truncation.truncated) {
		output += `\n[Output truncated for display: ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
	}

	const color = error || isError ? "error" : "toolOutput";
	return new Text(`\n${theme.fg(color, output)}`, 0, 0);
}
