import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENDPOINT = "https://codex-everywhere.com/v1";
const CONFIG_PATH = join(getAgentDir(), "codex-everywhere.json");
const MODEL_STORE_PATH = join(getAgentDir(), "models-store.json");
const LOG_PATH = join(getAgentDir(), "codex-everywhere.log");
const STATUS_KEY = "codex-everywhere";

type Mode = "on" | "off" | "toggle";

interface Config {
	apiKey: string;
	enabled: boolean;
}

interface StoredModel {
	id: string;
	provider?: string;
	baseUrl?: string;
	api?: string;
	compat?: unknown;
	[key: string]: unknown;
}

/** Loads the endpoint credential and persisted routing state. */
function loadConfig(): Config {
	const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
	if (typeof config.apiKey !== "string" || !config.apiKey) {
		throw new Error(`Missing apiKey in ${CONFIG_PATH}`);
	}
	return { apiKey: config.apiKey, enabled: config.enabled === true };
}

/** Persists the routing state without changing the endpoint credential. */
function saveEnabled(enabled: boolean): void {
	const config = loadConfig();
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...config, enabled }, null, "\t")}\n`, { mode: 0o600 });
}

/** Copies Pi's current Codex catalogue while changing only its transport. */
function proxyModels(): StoredModel[] {
	const store = JSON.parse(readFileSync(MODEL_STORE_PATH, "utf8")) as {
		"openai-codex"?: { models?: StoredModel[] };
	};
	const models = store["openai-codex"]?.models;
	if (!models?.length) throw new Error("No cached openai-codex models found in models-store.json");

	return models.map(({ provider: _provider, baseUrl: _baseUrl, api: _api, compat: _compat, ...model }) => ({
		...model,
		api: "openai-completions",
	}));
}

/** Writes a sanitized routing diagnostic that can be inspected outside Swath's private stderr buffer. */
function logDiagnostic(entry: Record<string, unknown>): void {
	appendFileSync(LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

/** Returns a non-reversible identifier for a credential without writing it to logs. */
function keyFingerprint(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

/** Installs the OpenAI-compatible proxy over Pi's built-in Codex provider. */
function enableProxy(pi: ExtensionAPI): void {
	const { apiKey } = loadConfig();
	pi.registerProvider("openai-codex", {
		name: "OpenAI Codex via Codex Everywhere",
		baseUrl: ENDPOINT,
		apiKey,
		// Pi may resolve an OpenAI Codex OAuth credential for this provider; pin the proxy's key
		// so it cannot be replaced by that unrelated credential.
		headers: { Authorization: `Bearer ${apiKey}` },
		authHeader: true,
		api: "openai-completions",
		models: proxyModels(),
	});
}

/** Updates the persistent footer indicator. */
function setStatus(ctx: ExtensionContext, enabled: boolean): void {
	ctx.ui.setStatus(STATUS_KEY, `Codex Everywhere: ${enabled ? "on" : "off"}`);
}

/** Re-selects the active Codex model so the new provider configuration applies immediately. */
async function refreshActiveCodexModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.model?.provider !== "openai-codex") return;
	const replacement = ctx.modelRegistry.find("openai-codex", ctx.model.id);
	if (replacement) await pi.setModel(replacement);
}

/** Parses the optional command argument. */
function parseMode(args: string): Mode | undefined {
	const mode = args.trim().toLowerCase();
	return mode === "" || mode === "toggle" ? "toggle" : mode === "on" || mode === "off" ? mode : undefined;
}

export default function codexEverywhere(pi: ExtensionAPI): void {
	let enabled = false;

	try {
		enabled = loadConfig().enabled;
		logDiagnostic({ event: "startup", enabled });
		if (enabled) enableProxy(pi);
	} catch (error) {
		console.error(`codex-everywhere: ${error instanceof Error ? error.message : String(error)}`);
	}

	pi.on("session_start", (_event, ctx) => setStatus(ctx, enabled));

	pi.on("before_provider_headers", (event, ctx) => {
		if (!enabled || ctx.model?.provider !== "openai-codex") return;
		const { apiKey } = loadConfig();
		event.headers.Authorization = `Bearer ${apiKey}`;
		logDiagnostic({
			event: "request",
			model: ctx.model.id,
			authorization: "bearer",
			keyFingerprint: keyFingerprint(apiKey),
		});
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!enabled || ctx.model?.provider !== "openai-codex") return;
		logDiagnostic({
			event: "response",
			model: ctx.model.id,
			status: event.status,
			requestId: event.headers["x-request-id"] ?? event.headers["request-id"] ?? null,
		});
	});

	pi.registerCommand("codex-everywhere", {
		description: "Toggle Codex Everywhere routing for OpenAI Codex models",
		handler: async (args, ctx) => {
		const mode = parseMode(args);
		if (!mode) {
			ctx.ui.notify("Usage: /codex-everywhere [on|off|toggle]", "warning");
			return;
		}

		const nextEnabled = mode === "toggle" ? !enabled : mode === "on";
		if (nextEnabled === enabled) {
			setStatus(ctx, enabled);
			return;
		}

		try {
			if (nextEnabled) enableProxy(pi);
			else pi.unregisterProvider("openai-codex");
			enabled = nextEnabled;
			saveEnabled(enabled);
			await refreshActiveCodexModel(pi, ctx);
			setStatus(ctx, enabled);
			ctx.ui.notify(`Codex Everywhere routing ${enabled ? "enabled" : "disabled"}`, "info");
		} catch (error) {
			ctx.ui.notify(`Codex Everywhere: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	},
	});
}
