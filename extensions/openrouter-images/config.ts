import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILE = path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent", "openrouter-images.json");

export interface CapabilityDescriptor {
	type: "enum" | "range" | "boolean" | string;
	values?: unknown[];
	min?: number;
	max?: number;
}

export interface ImageModel {
	id: string;
	name?: string;
	description?: string;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	supported_parameters?: Record<string, CapabilityDescriptor>;
	supports_streaming?: boolean;
}

export interface ImageConfig {
	models: ImageModel[];
	guidance: string;
}

const DEFAULT_GUIDANCE = "Choose the model whose supported parameters and description best match the request. Prefer economical models for drafts and higher-quality models for final assets. Do not send parameters absent from the selected model's supported_parameters.";

/** Loads the persisted OpenRouter image configuration. */
export function loadImageConfig(): ImageConfig {
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Partial<ImageConfig>;
		return {
			models: Array.isArray(parsed.models) ? parsed.models.filter((model) => typeof model?.id === "string") : [],
			guidance: typeof parsed.guidance === "string" ? parsed.guidance : DEFAULT_GUIDANCE,
		};
	} catch {
		return { models: [], guidance: DEFAULT_GUIDANCE };
	}
}

/** Persists the selected models and agent guidance. */
export function saveImageConfig(config: ImageConfig): void {
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
