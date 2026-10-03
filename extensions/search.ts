import type {
  AgentToolResult,
  ExtensionAPI,
  ToolLoadout,
  ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";
import { Type, type JsonValue, type TSchema } from "@earendil-works/pi-ai";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTruncatedToolResult } from "./lib/search-shared.js";

export const BACKENDS = [
  "fffind",
  "ffgrep",
  "brave_llm_search",
  "exa_web_search",
  "context7_search_library",
  "context7_get_context",
] as const;
const options = Type.Optional(
  Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Native backend options; validated by the backend schema. See available keys in the tool description.",
  }),
);
const query = Type.String({ minLength: 1 });
export const searchParameters = Type.Union([
  Type.Object(
    { operation: Type.Literal("paths"), query, options },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("content"), query, options },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("web"),
      provider: Type.Union([Type.Literal("brave"), Type.Literal("exa")]),
      queries: Type.Array(query, { minItems: 1 }),
      options,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("docs"),
      action: Type.Literal("discover"),
      libraryName: query,
      queries: Type.Array(query, { minItems: 1 }),
      options,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("docs"),
      action: Type.Literal("retrieve"),
      libraryId: query,
      queries: Type.Array(query, { minItems: 1 }),
      options,
    },
    { additionalProperties: false },
  ),
]);
const description =
  "Unified search: paths = fuzzy/glob filenames; content = literal/regex file contents; web = explicit brave/exa provider; docs discover = Context7 library lookup plus context, retrieve = Context7 context by libraryId. Local scope, exclusions, pagination and provider controls go in options. Read top local matches instead of repeated searches. Results over 24 KiB are saved in full to a readable temporary JSON file; previews explicitly indicate omitted text. Metadata, cursors and reference IDs are retained.";

type Backend = (typeof BACKENDS)[number];

/** Read backend object properties for option discovery; Pi still validates the full native schema. */
function backendProperties(schema: TSchema): Record<string, { type?: string }> {
  return (
    (schema as { properties?: Record<string, { type?: string }> }).properties ??
    {}
  );
}
interface SearchResults {
  backend: string;
  results: Array<AgentToolResult<unknown> & { isError: boolean }>;
  truncated: boolean;
  fullOutputPath?: string;
}

/** Combine registered search backends without duplicating their declarations or validators. */
export default function search(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const prompt = event.systemPromptOptions;
    if (!prompt.selectedTools.includes("search")) return;
    prompt.selectedTools = prompt.selectedTools.filter(
      (name) => !BACKENDS.includes(name as Backend),
    );
    for (const name of BACKENDS) {
      delete prompt.toolSnippets[name];
      delete prompt.toolGuidelines[name];
    }
    // Only remove search-routing advice, not shell safety or unrelated guidance.
    const conflicts = (rule: string) =>
      /\b(use|prefer)\b.*\bbash\b.*\b(search|searching|find|grep)\b/i.test(
        rule,
      );
    prompt.promptGuidelines = prompt.promptGuidelines.filter(
      (rule) => !conflicts(rule),
    );
    for (const name of Object.keys(prompt.toolGuidelines)) {
      prompt.toolGuidelines[name] = prompt.toolGuidelines[name].filter(
        (rule) => !conflicts(rule),
      );
    }
    // The default shell-search rule is generated, not stored in promptGuidelines.
    // Replace just that section; preserve all other structured prompt sections.
    const existingRules = prompt.sections.rules;
    const rules =
      existingRules ??
      [
        ...new Set([
          ...prompt.selectedTools.flatMap(
            (name) => prompt.toolGuidelines[name] ?? [],
          ),
          ...prompt.promptGuidelines,
          "Be concise in your responses",
          "Show file paths clearly when working with files",
        ]),
      ]
        .map((rule) => `- ${rule}`)
        .join("\n");
    prompt.sections.rules = rules
      .split("\n")
      .filter((rule) => !conflicts(rule))
      .join("\n");
  });
  pi.registerTool({
    name: "search",
    label: "Search",
    description,
    promptSnippet:
      "Search local paths/content, the web, or Context7 docs with an explicit operation.",
    promptGuidelines: [
      "Use search for local paths/content and web/docs research; use bash for shell execution, not search.",
    ],
    parameters: searchParameters,
    outputSchema: Type.Object({
      backend: Type.String(),
      results: Type.Array(Type.Unknown()),
      truncated: Type.Boolean(),
      fullOutputPath: Type.Optional(Type.String()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    executionMode: "parallel",
    /** Keep native backends callable, but show only the unified entry point to the model. */
    prepareLoadout(loadout: ToolLoadout): ToolLoadoutChanges {
      const available = loadout.callable.filter((tool) =>
        BACKENDS.includes(tool.name as Backend),
      );
      const schemas = available.map((tool) => {
        const props = backendProperties(tool.parameters);
        return `${tool.name}: ${Object.entries(props)
          .map(([key, value]) => `${key}:${value.type ?? "value"}`)
          .join(", ")}`;
      });
      return {
        hiddenDeclarations: BACKENDS.filter((name) =>
          loadout.declared.some((tool) => tool.name === name),
        ),
        descriptions: {
          search: `${description}\nNative option keys (required query fields are supplied by the wrapper):\n${schemas.join("\n")}`,
        },
      };
    },
    renderResult: renderTruncatedToolResult,
    /** Route through Pi's tool execution so native validation, errors and cancellation remain intact. */
    async execute(
      _id,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<SearchResults>> {
      let backend: string;
      let requests: Record<string, unknown>[];
      switch (params.operation) {
        case "paths":
          backend = "fffind";
          requests = [{ pattern: params.query }];
          break;
        case "content":
          backend = "ffgrep";
          requests = [{ pattern: params.query }];
          break;
        case "web":
          backend =
            params.provider === "brave" ? "brave_llm_search" : "exa_web_search";
          requests =
            params.provider === "brave"
              ? [{ queries: params.queries }]
              : params.queries.map((query) => ({ query }));
          break;
        case "docs":
          backend =
            params.action === "discover"
              ? "context7_search_library"
              : "context7_get_context";
          requests = [
            {
              queries: params.queries,
              ...(params.action === "discover"
                ? { libraryName: params.libraryName }
                : { libraryId: params.libraryId }),
            },
          ];
          break;
      }
      const native = ctx.tools.find((tool) => tool.name === backend);
      if (!native)
        throw new Error(
          `Search backend ${backend} is not callable. Enable it alongside search.`,
        );
      for (const key of Object.keys(params.options ?? {})) {
        if (!Object.hasOwn(backendProperties(native.parameters), key))
          throw new Error(`Unknown ${backend} option: ${key}`);
        if (key in requests[0])
          throw new Error(`Use the search query fields, not options.${key}`);
      }
      const outcomes = await Promise.all(
        requests.map((args) =>
          ctx.executeTool(backend, { ...params.options, ...args }, { signal }),
        ),
      );
      const results = outcomes.map((outcome) => ({
        ...outcome.result,
        isError: outcome.isError,
      }));
      const full = { backend, results, truncated: false };
      const serialized = JSON.stringify(full);
      let structuredContent: SearchResults = full;
      if (Buffer.byteLength(serialized) > 24 * 1024) {
        const dir = await mkdtemp(join(tmpdir(), "pi-search-"));
        const fullOutputPath = join(dir, "result.json");
        await writeFile(fullOutputPath, serialized, { mode: 0o600 });
        // Keep all structured metadata; shorten only model-facing text blocks.
        const budget = Math.floor(
          12000 /
            Math.max(
              1,
              results.reduce((n, r) => n + r.content.length, 0),
            ),
        );
        structuredContent = {
          backend,
          truncated: true,
          fullOutputPath,
          results: results.map((result) => ({
            ...result,
            content: result.content.map((part) =>
              part.type === "text" && part.text.length > budget
                ? {
                    ...part,
                    text: `${part.text.slice(0, budget)}\n[Text omitted; full result: ${fullOutputPath}]`,
                  }
                : part,
            ),
          })),
        };
      }
      let text = JSON.stringify(structuredContent);
      if (Buffer.byteLength(text) > 24 * 1024) {
        text = JSON.stringify({
          backend,
          truncated: true,
          fullOutputPath: structuredContent.fullOutputPath,
          notice:
            "Metadata exceeds preview budget; all metadata, cursors and reference IDs remain in the full JSON file. Read it before continuing.",
        });
      }
      return {
        content: [{ type: "text", text }],
        details: structuredContent,
        structuredContent: JSON.parse(
          JSON.stringify(structuredContent),
        ) as JsonValue,
        isError: outcomes.some((outcome) => outcome.isError),
      };
    },
  });
}
