import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Meta Model API (https://api.meta.ai/v1), OpenAI-compatible chat completions.
 * Auth: `Authorization: Bearer <key>`, handled by the openai-completions api.
 * Key comes from /login (stored in auth.json) or $META_API_KEY.
 *
 * Caching is automatic on any stable prefix and reported as
 * usage.prompt_tokens_details.cached_tokens, which pi reads as cacheRead.
 * Meta bills each token once (cached at the lower rate), so cacheWrite is 0.
 */
export default function metaProvider(pi: ExtensionAPI): void {
	pi.registerProvider("meta", {
		name: "Meta",
		baseUrl: "https://api.meta.ai/v1",
		api: "openai-completions",
		apiKey: "$META_API_KEY",
		models: [
			{
				id: "muse-spark-1.2",
				name: "Muse Spark 1.2",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1048576,
				// ponytail: Meta publishes no output cap; 131072 is third-party reported and the API accepts it.
				maxTokens: 131072,
			},
			{
				id: "muse-spark-1.2-contributor",
				name: "Muse Spark 1.2 Contributor",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 131072,
			},
		],
	});
}
