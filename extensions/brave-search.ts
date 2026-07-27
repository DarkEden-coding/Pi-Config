import { Type } from "@sinclair/typebox";
import { type ExtensionAPI, truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { Input, Text } from "@earendil-works/pi-tui";
import { getApiKey, loadKeys, renderTruncatedToolResult, saveKeys } from "./lib/search-shared.js";

/** Extract text from a bracketed paste (both ESC-prefixed and stripped forms) or a raw multi-line chunk. */
function extractPastedText(data: string): string | undefined {
  const start = /\x1b?\[200~/.exec(data);
  if (start) {
    const contentStart = start.index + start[0].length;
    const end = /\x1b?\[201~/.exec(data.slice(contentStart));
    return end ? data.slice(contentStart, contentStart + end.index) : undefined;
  }
  // Some terminals deliver a paste as one raw, unbracketed chunk.
  return data.length > 1 && /[\r\n]/.test(data) ? data : undefined;
}

export default function braveSearch(pi: ExtensionAPI) {
  // Set while the key prompt is open; see the terminal-input listener below.
  let deliverPaste: ((text: string) => void) | undefined;
  let unsubscribeTerminalInput: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    unsubscribeTerminalInput?.();
    // Terminal-input listeners run before Pi dispatches to the focused component, and
    // clipboard-image-paste.ts consumes every paste into the main editor. Claiming a
    // listener slot first keeps pasted keys in the key prompt while it is open, and
    // stays out of the way (returns undefined) at every other time.
    unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
      if (!deliverPaste) return undefined;
      const pasted = extractPastedText(data);
      if (pasted === undefined) return undefined;
      deliverPaste(pasted);
      return { consume: true };
    });
  });

  pi.on("session_shutdown", () => {
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    deliverPaste = undefined;
  });

  pi.registerCommand("set-keys", {
    description: "Set API keys for extensions (Brave, Context7, Exa, OpenRouter)",
    handler: async (_args, ctx) => {
      const services = [
        { id: "brave", label: "Brave Search" },
        { id: "context7", label: "Context7" },
        { id: "exa", label: "Exa" },
        { id: "openrouter", label: "OpenRouter" },
      ] as const;
      const choice = await ctx.ui.select(
        "Select an API key to change:",
        services.map((service) => `${service.label} — ${getApiKey(service.id) ? "configured" : "not configured"}`),
      );
      if (!choice) return;

      const service = services.find((candidate) => choice.startsWith(`${candidate.label} —`));
      if (!service) return;

      let value: string | undefined;
      try {
        value = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
          const input = new Input();
          const title = new Text(theme.fg("accent", `Enter ${service.label} API key`), 0, 0);
          const help = new Text(theme.fg("dim", "Enter saves • Esc cancels • paste is supported"), 0, 0);
          input.onSubmit = (submitted) => done(submitted);
          input.onEscape = () => done(undefined);
          deliverPaste = (text) => {
            input.handleInput(`\x1b[200~${text}\x1b[201~`);
            tui.requestRender();
          };

          return {
            get focused() {
              return input.focused;
            },
            set focused(focused: boolean) {
              input.focused = focused;
            },
            render(width: number) {
              return [...title.render(width), ...input.render(width), ...help.render(width)];
            },
            handleInput(data: string) {
              input.handleInput(data);
              tui.requestRender();
            },
            invalidate() {
              title.invalidate();
              input.invalidate();
              help.invalidate();
            },
          };
        });
      } finally {
        deliverPaste = undefined;
      }
      if (!value?.trim()) return;

      const keys = loadKeys();
      keys[service.id] = value.trim();
      saveKeys(keys);
      ctx.ui.notify(`${service.label} API key updated and saved.`, "info");
    }
  });

  pi.registerTool({
    name: "brave_llm_search",
    label: "Brave LLM Search",
    description: "Web search optimized for AI agents using Brave LLM Context API. Returns pre-extracted text, tables, and code ready for LLM consumption.",
    promptSnippet: "Use brave_llm_search for factual queries or real-time web research.",
    parameters: Type.Object({
      queries: Type.Array(Type.String({ description: "Search queries" })),
      count: Type.Optional(Type.Integer({ description: "Max search results per query (1-50, default 20)" })),
      maximum_number_of_tokens: Type.Optional(Type.Integer({ description: "Approx max tokens per search (1024-32768, default 8192)" })),
      freshness: Type.Optional(Type.String({ description: "Filter by freshness (pd: 24h, pw: 7d, pm: 31d, py: 1y)" })),
      context_threshold_mode: Type.Optional(Type.String({ description: "Relevance threshold: strict, balanced (default), lenient, disabled" })),
    }),
    
    renderCall(args, theme, context) {
      const queries = Array.isArray(args.queries) ? args.queries.join(", ") : "";
      const title = theme.fg("toolTitle", theme.bold("brave"));
      if (!context.expanded) return new Text(title, 0, 0);
      return new Text(`${title} ${theme.fg("accent", queries)}`, 0, 0);
    },
    renderResult: renderTruncatedToolResult,
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const apiKey = getApiKey("brave");
      if (!apiKey) {
        throw new Error("Brave API Key not set. Use /set-keys to configure.");
      }

      onUpdate?.({
        content: [{ type: "text", text: `Searching Brave for: ${params.queries.map(q => `"${q}"`).join(", ")}...` }],
        details: {}
      });

      const results = await Promise.all(params.queries.map(async (query) => {
        const url = new URL("https://api.search.brave.com/res/v1/llm/context");
        url.searchParams.append("q", query);
        
        if (params.count) url.searchParams.append("count", params.count.toString());
        if (params.maximum_number_of_tokens) url.searchParams.append("maximum_number_of_tokens", params.maximum_number_of_tokens.toString());
        if (params.freshness) url.searchParams.append("freshness", params.freshness);
        if (params.context_threshold_mode) url.searchParams.append("context_threshold_mode", params.context_threshold_mode);

        const response = await fetch(url.toString(), {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "X-Subscription-Token": apiKey,
          },
          signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP Error ${response.status} for query "${query}": ${response.statusText}`);
        }

        return { query, data: await response.json() };
      }));

      let resultText = "";
      let totalResultsCount = 0;

      for (const { query, data } of results) {
        resultText += `# Results for: ${query}\n\n`;
        constGenericResults(query, data);
      }

      function constGenericResults(query: string, data: any) {
        if (!data.grounding?.generic || data.grounding.generic.length === 0) {
          resultText += "No relevant web content found.\n\n";
          return;
        }

        totalResultsCount += data.grounding.generic.length;
        for (const item of data.grounding.generic) {
          resultText += `## ${item.title} (${item.url})\n\n`;
          for (const snippet of item.snippets) {
            resultText += `${snippet}\n\n`;
          }
          resultText += "---\n\n";
        }
      }
      
      const truncation = truncateHead(resultText, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let contentText = truncation.content;

      if (truncation.truncated) {
        contentText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
        contentText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
      }

      return {
        content: [{ type: "text", text: contentText }],
        details: { resultCount: totalResultsCount }
      };
    },
  });
}