import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { getApiKey, renderTruncatedToolResult } from "../lib/search-shared.js";
import { type ImageConfig, type ImageModel, loadImageConfig, saveImageConfig } from "./config.js";

const API_BASE = "https://openrouter.ai/api/v1";

const imageToolSchema = Type.Object({
	model: Type.String({ description: "Configured OpenRouter image model ID." }),
	prompt: Type.String({ description: "Detailed description of the image or requested edit." }),
	n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of images (model-dependent)." })),
	resolution: Type.Optional(Type.String({ description: "Resolution tier, such as 512, 1K, 2K, or 4K." })),
	aspect_ratio: Type.Optional(Type.String({ description: "Aspect ratio supported by the model, such as 1:1 or 16:9." })),
	size: Type.Optional(Type.String({ description: "Resolution tier or explicit dimensions. Do not combine conflicting explicit dimensions with resolution/aspect_ratio." })),
	quality: Type.Optional(Type.String({ description: "Model-dependent quality, commonly auto, low, medium, or high." })),
	output_format: Type.Optional(Type.String({ description: "Output format, commonly png, jpeg, webp, or svg." })),
	background: Type.Optional(Type.String({ description: "Background treatment: auto, transparent, or opaque when supported." })),
	output_compression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "JPEG/WebP compression level." })),
	seed: Type.Optional(Type.Integer({ description: "Deterministic seed when supported." })),
	stream: Type.Optional(Type.Boolean({ description: "Request SSE previews when the selected endpoint supports streaming." })),
	input_reference_paths: Type.Optional(Type.Array(Type.String(), { description: "Local paths, relative to cwd or absolute, for image editing/reference." })),
	provider: Type.Optional(Type.Object({
		only: Type.Optional(Type.Array(Type.String())),
		order: Type.Optional(Type.Array(Type.String())),
		ignore: Type.Optional(Type.Array(Type.String())),
		sort: Type.Optional(Type.Any({ description: "Provider routing sort value/object." })),
		allow_fallbacks: Type.Optional(Type.Boolean()),
		options: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Provider-specific options keyed by provider slug." })),
	}, { description: "OpenRouter provider routing and provider-specific parameters." })),
	additional_parameters: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Future or model-specific top-level Image API parameters not represented above." })),
});

export type OpenRouterImageInput = Static<typeof imageToolSchema>;

interface GeneratedImage { b64_json: string; media_type?: string }

/** Returns a useful error message from an unsuccessful OpenRouter response. */
async function responseError(response: Response): Promise<string> {
	const text = await response.text();
	try {
		const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
		return typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? text;
	} catch {
		return text || response.statusText;
	}
}

/** Converts a local reference image to OpenRouter's image-url content part. */
async function loadReference(filePath: string, cwd: string): Promise<{ type: "image_url"; image_url: { url: string } }> {
	const normalized = filePath.replace(/^@/, "");
	const absolutePath = path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized);
	const bytes = await fs.readFile(absolutePath);
	const extension = path.extname(absolutePath).toLowerCase();
	const mediaType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
		: extension === ".webp" ? "image/webp"
			: extension === ".gif" ? "image/gif"
				: extension === ".svg" ? "image/svg+xml" : "image/png";
	return { type: "image_url", image_url: { url: `data:${mediaType};base64,${bytes.toString("base64")}` } };
}

/** Extracts completed images and usage from a buffered JSON or SSE response. */
async function parseImageResponse(response: Response, streamed: boolean): Promise<{ images: GeneratedImage[]; usage?: unknown }> {
	if (!streamed) {
		const body = await response.json() as { data?: GeneratedImage[]; usage?: unknown };
		return { images: body.data ?? [], usage: body.usage };
	}
	const text = await response.text();
	const images: GeneratedImage[] = [];
	let usage: unknown;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
		try {
			const event = JSON.parse(line.slice(6)) as { type?: string; b64_json?: string; media_type?: string; data?: GeneratedImage[]; usage?: unknown };
			if (event.type?.includes("completed") && event.b64_json) images.push(event as GeneratedImage);
			if (event.data) images.push(...event.data);
			if (event.usage) usage = event.usage;
		} catch { /* Ignore non-JSON SSE bookkeeping lines. */ }
	}
	return { images, usage };
}

/** Chooses a file extension from response metadata or requested format. */
function imageExtension(mediaType: string | undefined, requestedFormat: string | undefined): string {
	if (mediaType === "image/jpeg") return "jpg";
	if (mediaType === "image/webp") return "webp";
	if (mediaType === "image/svg+xml") return "svg";
	return requestedFormat === "jpeg" ? "jpg" : requestedFormat ?? "png";
}

/** Validates normalized arguments against the selected model's advertised capabilities. */
function validateCapabilities(model: ImageModel, params: OpenRouterImageInput): void {
	const capabilities = model.supported_parameters ?? {};
	const values: Record<string, unknown> = {
		n: params.n,
		resolution: params.resolution,
		aspect_ratio: params.aspect_ratio,
		size: params.size,
		quality: params.quality,
		output_format: params.output_format,
		background: params.background,
		output_compression: params.output_compression,
		seed: params.seed,
		stream: params.stream,
		input_references: params.input_reference_paths?.length,
	};
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined || value === false || value === 0) continue;
		if (name === "stream") {
			if (!model.supports_streaming) throw new Error(`Model '${model.id}' does not advertise streaming support.`);
			continue;
		}
		const descriptor = capabilities[name];
		if (!descriptor) throw new Error(`Model '${model.id}' does not advertise support for parameter '${name}'.`);
		if (descriptor.type === "enum" && descriptor.values && !descriptor.values.includes(value)) {
			throw new Error(`Parameter '${name}' must be one of: ${descriptor.values.join(", ")}.`);
		}
		if (descriptor.type === "range" && typeof value === "number" && (value < (descriptor.min ?? -Infinity) || value > (descriptor.max ?? Infinity))) {
			throw new Error(`Parameter '${name}' must be between ${descriptor.min} and ${descriptor.max}.`);
		}
	}
}

/** Builds dynamic agent instructions from configured models and capabilities. */
function agentInstructions(config: ImageConfig): string {
	const catalog = config.models.map((model) => ({
		id: model.id,
		name: model.name,
		description: model.description,
		input_modalities: model.architecture?.input_modalities,
		supported_parameters: model.supported_parameters,
		supports_streaming: model.supports_streaming,
	}));
	return ["OpenRouter image generation configuration:", config.guidance, "Only use one of these configured models. Respect its capability descriptors:", JSON.stringify(catalog)].join("\n");
}

/** Fetches OpenRouter's current image-model catalog. */
async function fetchModels(apiKey: string, signal?: AbortSignal): Promise<ImageModel[]> {
	const response = await fetch(`${API_BASE}/images/models`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal });
	if (!response.ok) throw new Error(`OpenRouter model discovery failed (${response.status}): ${await responseError(response)}`);
	const body = await response.json() as { data?: ImageModel[] };
	return (body.data ?? []).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

/** Registers OpenRouter image generation and its interactive configuration command. */
export default function openRouterImages(pi: ExtensionAPI): void {
	pi.registerCommand("openrouter-images", {
		description: "Select OpenRouter image models and edit agent model guidance",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("/openrouter-images requires TUI mode.", "error"); return; }
			const apiKey = getApiKey("openrouter");
			if (!apiKey) { ctx.ui.notify("OpenRouter API key is not set. Use /set-keys first.", "error"); return; }
			let models: ImageModel[];
			try { models = await fetchModels(apiKey); }
			catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
			const previous = loadImageConfig();
			const selected = new Set(previous.models.map((model) => model.id));

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const items: SettingItem[] = models.map((model) => ({
					id: model.id,
					label: model.name ? `${model.name} (${model.id})` : model.id,
					description: model.description,
					currentValue: selected.has(model.id) ? "selected" : "not selected",
					values: ["selected", "not selected"],
				}));
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("OpenRouter Image Models")), 1, 0));
				container.addChild(new Text(theme.fg("dim", "Type to search • Enter/Space toggles • Esc continues to guidance"), 1, 0));
				const list = new SettingsList(items, Math.min(models.length + 2, 18), getSettingsListTheme(), (id, value) => {
					if (value === "selected") selected.add(id); else selected.delete(id);
				}, () => done(undefined), { enableSearch: true });
				container.addChild(list);
				return { render: (width: number) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data: string) => { list.handleInput?.(data); tui.requestRender(); } };
			});

			const guidance = await ctx.ui.editor("Agent guidance for choosing image models:", previous.guidance);
			if (guidance === undefined) { ctx.ui.notify("OpenRouter image configuration cancelled.", "warning"); return; }
			const config = { models: models.filter((model) => selected.has(model.id)), guidance: guidance.trim() };
			saveImageConfig(config);
			ctx.ui.notify(`Saved ${config.models.length} OpenRouter image model(s).`, "info");
		},
	});

	pi.on("before_agent_start", (event) => {
		const config = loadImageConfig();
		if (config.models.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${agentInstructions(config)}` };
	});

	pi.registerTool({
		name: "openrouter_image",
		label: "OpenRouter Image",
		description: "Generate or edit images with a configured OpenRouter image model. Supports every normalized Image API parameter, local references, provider routing/options, and future parameters. Generated files are temporary; move/rename assets that should be kept.",
		promptSnippet: "Generate or edit images with configured OpenRouter image models.",
		promptGuidelines: ["Use openrouter_image when the user asks to generate or edit an image.", "After openrouter_image returns, move and rename temporary output files when they should become durable project assets."],
		parameters: imageToolSchema,
		renderCall(args, theme, context) {
			const title = theme.fg("toolTitle", theme.bold("openrouter image"));
			if (!context.expanded) return new Text(title, 0, 0);
			return new Text(`${title} ${theme.fg("accent", args.model ?? "")}\n${theme.fg("dim", args.prompt ?? "")}`, 0, 0);
		},
		renderResult: renderTruncatedToolResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const apiKey = getApiKey("openrouter");
			if (!apiKey) throw new Error("OpenRouter API key is not set. Use /set-keys to configure it.");
			const config = loadImageConfig();
			const model = config.models.find((candidate) => candidate.id === params.model);
			if (!model) throw new Error(`Model '${params.model}' is not configured. Run /openrouter-images to select available models.`);
			validateCapabilities(model, params);
			onUpdate?.({ content: [{ type: "text", text: `Generating with ${params.model}...` }], details: {} });
			const references = await Promise.all((params.input_reference_paths ?? []).map((file) => loadReference(file, ctx.cwd)));
			const { input_reference_paths: _paths, additional_parameters, ...standard } = params;
			const body: Record<string, unknown> = { ...(additional_parameters ?? {}), ...standard, model: model.id, prompt: params.prompt };
			if (references.length > 0) body.input_references = references;
			const response = await fetch(`${API_BASE}/images`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
			if (!response.ok) throw new Error(`OpenRouter image generation failed (${response.status}): ${await responseError(response)}`);
			const result = await parseImageResponse(response, params.stream === true);
			if (result.images.length === 0) throw new Error("OpenRouter returned no completed images.");
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-openrouter-images-"));
			const paths: string[] = [];
			for (const [index, image] of result.images.entries()) {
				const extension = imageExtension(image.media_type, params.output_format);
				const outputPath = path.join(directory, `image-${index + 1}.${extension}`);
				await fs.writeFile(outputPath, Buffer.from(image.b64_json, "base64"));
				paths.push(outputPath);
			}
			const text = [`Generated ${paths.length} temporary image(s) with ${model.id}:`, ...paths.map((outputPath) => `- ${outputPath}`), "Move and rename any image that should be kept or used as a project asset; these paths are temporary."].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					paths,
					model: model.id,
					usage: result.usage,
					parameters: { ...params, input_reference_paths: params.input_reference_paths?.map((file) => path.resolve(ctx.cwd, file.replace(/^@/, ""))) },
				},
			};
		},
	});
}
