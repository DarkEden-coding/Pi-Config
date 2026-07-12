import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getApiKey, renderTruncatedToolResult } from "./lib/search-shared.js";

export default function exaSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "exa_web_search",
    label: "Exa Web Search",
    description: "Search the web with Exa's AI-agent optimized Search API. Returns URLs with highlights/text for agent workflows.",
    promptSnippet: "Search the web using Exa AI-agent optimized search with highlights or capped text.",
    promptGuidelines: ["Use exa_web_search for semantic/neural web search and source discovery; prefer highlights for token-efficient agent workflows."],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language semantic search query. Long, specific queries are supported." }),
      numResults: Type.Optional(Type.Integer({ description: "Number of results (1-100, default 5).", minimum: 1, maximum: 100 })),
      type: Type.Optional(Type.String({ description: "Exa search type: auto (default), fast, or instant. Deep/synthesis modes are intentionally not exposed." })),
      contents: Type.Optional(Type.String({ description: "Content mode: highlights (default), text, or highlights+text. Summary is intentionally not exposed." })),
      maxCharacters: Type.Optional(Type.Integer({ description: "Max characters for text/highlights when applicable. Text defaults to 2000; highlights default to Exa's recommended highlights: true." })),
      livecrawl: Type.Optional(Type.Boolean({ description: "If true, set contents.maxAgeHours=0 to force live crawl." })),
    }),
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("exa"));
      if (!context.expanded) return new Text(title, 0, 0);
      return new Text(`${title} ${theme.fg("accent", args.query ?? "")}`, 0, 0);
    },
    renderResult: renderTruncatedToolResult,
    async execute(_toolCallId, params, signal, onUpdate) {
      const apiKey = getApiKey("exa");
      if (!apiKey) throw new Error("Exa API Key not set. Use /set-keys to configure.");

      onUpdate?.({ content: [{ type: "text", text: `Searching Exa for: ${params.query}` }], details: {} });

      const mode = params.contents ?? "highlights";
      const maxCharacters = params.maxCharacters;
      const textMaxCharacters = maxCharacters ?? 2000;
      const contents: any = {};
      if (mode.includes("highlights")) contents.highlights = maxCharacters ? { maxCharacters } : true;
      if (mode.includes("text")) contents.text = { maxCharacters: textMaxCharacters };
      if (params.livecrawl) contents.maxAgeHours = 0;

      const requestedType = params.type ?? "auto";
      if (!["auto", "fast", "instant"].includes(requestedType)) {
        throw new Error("exa_web_search only allows type auto, fast, or instant; deep/synthesis modes are disabled for this extension.");
      }

      const body: any = {
        query: params.query,
        type: requestedType,
        numResults: params.numResults ?? 5,
        contents,
      };

      const response = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw new Error(`Exa HTTP Error ${response.status}: ${await response.text()}`);
      const data = await response.json() as any;

      const text = [
        `# Exa results for: ${params.query}`,
        `Search type: ${data.searchType ?? body.type}`,
        ...(data.output?.content ? [`\n## Synthesized output\n${typeof data.output.content === "string" ? data.output.content : JSON.stringify(data.output.content, null, 2)}`] : []),
        ...((data.results ?? []).map((r: any, i: number) => {
          const snippets = [
            ...(Array.isArray(r.highlights) ? r.highlights.map((h: string) => `- ${h}`) : []),
            r.text ? r.text : "",
          ].filter(Boolean).join("\n");
          return `\n## ${i + 1}. ${r.title ?? "Untitled"}\n${r.url}\n${snippets}`;
        })),
      ].join("\n\n");

      return { content: [{ type: "text", text }], details: { request: body, costDollars: data.costDollars, resultCount: data.results?.length ?? 0 } };
    },
  });
}
