import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Banner Stats Extension
 *
 * Shows a compact banner at the bottom of the chat with:
 * - Stats: Tools used, files read, edits made
 * - File Changes: List of changed files with line delta (+/-)
 */

export default function bannerStats(pi: ExtensionAPI) {
  const stats = {
    tools: 0,
    reads: 0,
    edits: 0,
    writes: 0,
  };

  // Map of filePath -> { added: number, deleted: number }
  const fileChanges = new Map<string, { added: number; deleted: number }>();

  function updateBanner(ctx: any) {
    const theme = ctx.ui.theme;
    
    // 1. Build stats line
    const statsParts = [
      `${theme.fg("accent", "Tools:")} ${stats.tools}`,
      `${theme.fg("accent", "Read:")} ${stats.reads}`,
      `${theme.fg("accent", "Edit:")} ${stats.edits}`,
      `${theme.fg("accent", "Write:")} ${stats.writes}`,
    ];
    const statsLine = statsParts.join(theme.fg("dim", " | "));

    // 2. Build file changes line
    const changesLine = buildChangesLine(theme);

    // 3. Set widget
    const lines = [statsLine];
    if (changesLine) {
      lines.push(changesLine);
    }

    ctx.ui.setWidget("chat-banner-stats", lines, { placement: "belowEditor" });
  }

  function buildChangesLine(theme: any) {
    if (fileChanges.size === 0) return "";
    
    const changesParts = Array.from(fileChanges.entries()).map(([path, delta]) => {
      const shortPath = path.split("/").pop() || path;
      const plus = delta.added > 0 ? theme.fg("success", `+${delta.added}`) : "";
      const minus = delta.deleted > 0 ? theme.fg("error", `-${delta.deleted}`) : "";
      const deltaText = [plus, minus].filter(Boolean).join(" ");
      return `${theme.fg("dim", shortPath)}${deltaText ? ` (${deltaText})` : ""}`;
    });
    return `${theme.fg("accent", "Changes:")} ` + changesParts.join(theme.fg("dim", ", "));
  }

  pi.on("session_start", async (_event, ctx) => {
    // Re-calculate stats from history on startup/reload
    stats.tools = 0;
    stats.reads = 0;
    stats.edits = 0;
    stats.writes = 0;
    fileChanges.clear();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        stats.tools++;
        if (entry.message.toolName === "read") stats.reads++;
        if (entry.message.toolName === "edit") {
          stats.edits++;
          processEditDiff(entry.message.toolName, entry.message.input, entry.message.details);
        }
        if (entry.message.toolName === "write") {
          stats.writes++;
          processWriteDelta(entry.message.toolName, entry.message.input);
        }
      }
    }
    updateBanner(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    stats.tools++;
    if (event.toolName === "read") stats.reads++;
    if (event.toolName === "edit") stats.edits++;
    if (event.toolName === "write") stats.writes++;
    updateBanner(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    if (event.toolName === "edit" || event.toolName === "write") {
      if (event.toolName === "edit") {
        processEditDiff(event.toolName, event.input, event.details);
      } else {
        processWriteDelta(event.toolName, event.input);
      }
      updateBanner(ctx);
    }
  });

  function processEditDiff(toolName: string, input: any, details: any) {
    if (toolName !== "edit" || !details?.diff || !input?.path) return;
    
    const diff = details.diff as string;
    const lines = diff.split("\n");
    let added = 0;
    let deleted = 0;

    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) deleted++;
    }

    const current = fileChanges.get(input.path) || { added: 0, deleted: 0 };
    fileChanges.set(input.path, {
      added: current.added + added,
      deleted: current.deleted + deleted,
    });
  }

  function processWriteDelta(toolName: string, input: any) {
    // For 'write', we don't have a diff, so we just mark it as changed.
    // In a more advanced version we could count lines in input.content
    if (toolName !== "write" || !input?.path) return;
    
    const current = fileChanges.get(input.path) || { added: 0, deleted: 0 };
    const lineCount = input.content?.split("\n").length || 0;
    
    // We treat write as "added everything", though it's technically an overwrite.
    // Without the previous version of the file, we can't know the true delta.
    fileChanges.set(input.path, {
      added: current.added + lineCount,
      deleted: current.deleted, 
    });
  }

  pi.registerCommand("clear-stats", {
    description: "Clear the chat banner stats",
    handler: async (_args, ctx) => {
      stats.tools = 0;
      stats.reads = 0;
      stats.edits = 0;
      stats.writes = 0;
      fileChanges.clear();
      updateBanner(ctx);
      ctx.ui.notify("Stats cleared", "info");
    }
  });
}
