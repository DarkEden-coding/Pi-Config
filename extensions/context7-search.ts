import { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { getApiKey, renderTruncatedToolResult } from "./lib/search-shared.js";

const API_BASE = "https://context7.com/api/v2";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const apiKey = getApiKey("context7");
    if (!apiKey) {
      ctx.ui.notify("Context7 extension loaded. Set API key using /set-keys.", "warning");
    } else {
      ctx.ui.notify("Context7 extension loaded.", "info");
    }
  });

  const headers = () => ({
    "Authorization": `Bearer ${getApiKey("context7") || ""}`,
    "Content-Type": "application/json"
  });

  // Search Library Tool
  pi.registerTool({
    name: "context7_search_library",
    label: "Context7 Search Library",
    description: "Search for programming libraries in Context7 by name",
    promptSnippet: "Search for programming libraries in Context7 by name",
    parameters: Type.Object({
      libraryName: Type.String({ description: "Name of the library to search for (e.g., 'react', 'next.js')" }),
      queries: Type.Array(Type.String({ description: "Queries to find the most relevant documentation snippets" })),
    }),
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("context7 search"));
      const queries = Array.isArray(args.queries) ? args.queries.join(", ") : "";
      if (!context.expanded) return new Text(title, 0, 0);
      return new Text(`${title} ${theme.fg("accent", args.libraryName ?? "")} ${theme.fg("dim", queries)}`, 0, 0);
    },
    renderResult: renderTruncatedToolResult,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = getApiKey("context7");
      if (!apiKey) throw new Error("Context7 API Key not set. Use /set-keys to configure.");
      
      try {
        // Step 1: Find the library
        const searchUrl = new URL(`${API_BASE}/libs/search`);
        searchUrl.searchParams.append("libraryName", params.libraryName);
        searchUrl.searchParams.append("query", params.queries.join("\n"));
        
        const searchResponse = await fetch(searchUrl.toString(), { headers: headers(), signal });
        if (!searchResponse.ok) {
          throw new Error(`Library search failed: ${searchResponse.status} ${searchResponse.statusText}`);
        }
        const searchData = await searchResponse.json();
        const library = Array.isArray(searchData.results) ? searchData.results[0] : searchData.results || searchData.libraries?.[0] || searchData[0]; // Context7 v2 returns results

        if (!library || !library.id) {
          return {
            content: [{ type: "text", text: `Library "${params.libraryName}" not found.` }],
            details: searchData
          };
        }

        const libraryId = library.id;

        // Step 2: Execute multiple context queries in parallel
        const contextResults = await Promise.all(params.queries.map(async (query) => {
          const url = new URL(`${API_BASE}/context`);
          url.searchParams.append("libraryId", libraryId);
          url.searchParams.append("query", query);
          url.searchParams.append("type", "json");

          const response = await fetch(url.toString(), { headers: headers(), signal });
          if (!response.ok) {
            return { query, error: `API Error: ${response.status} ${response.statusText}` };
          }
          return { query, data: await response.json() };
        }));

        return {
          content: [{ type: "text", text: JSON.stringify({ library, results: contextResults }, null, 2) }],
          details: { library, results: contextResults }
        };
      } catch (error: any) {
        throw new Error(`Search error: ${error.message}`);
      }
    }
  });

  // Get Context Tool (also updated for parallel)
  pi.registerTool({
    name: "context7_get_context",
    label: "Context7 Get Context",
    description: "Retrieve documentation context snippets for a library using Context7",
    promptSnippet: "Retrieve documentation snippets for a specific library from Context7",
    parameters: Type.Object({
      libraryId: Type.String({ description: "The ID of the library from a previous search (e.g., '/vercel/next.js')" }),
      queries: Type.Array(Type.String({ description: "Specific questions or topics to get documentation for" })),
      type: Type.Optional(Type.String({ description: "Format: json or txt" })),
    }),
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("context7 context"));
      const queries = Array.isArray(args.queries) ? args.queries.join(", ") : "";
      if (!context.expanded) return new Text(title, 0, 0);
      return new Text(`${title} ${theme.fg("accent", args.libraryId ?? "")} ${theme.fg("dim", queries)}`, 0, 0);
    },
    renderResult: renderTruncatedToolResult,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
       const apiKey = getApiKey("context7");
       if (!apiKey) throw new Error("Context7 API Key not set. Use /set-keys to configure.");

       try {
        const results = await Promise.all(params.queries.map(async (query) => {
          const url = new URL(`${API_BASE}/context`);
          url.searchParams.append("libraryId", params.libraryId);
          url.searchParams.append("query", query);
          url.searchParams.append("type", params.type || "json");

          const response = await fetch(url.toString(), { headers: headers(), signal });
          
          if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            return { query, error: `API Error: ${response.status} ${response.statusText}${errorData ? ` - ${JSON.stringify(errorData)}` : ''}` };
          }

          const responseType = params.type || "json";
          return { query, data: responseType === "txt" ? await response.text() : await response.json() };
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          details: results
        };
      } catch (error: any) {
        throw new Error(`Fetch error: ${error.message}`);
      }
    }
  });
  
  // Command moved to brave-search.ts
}
