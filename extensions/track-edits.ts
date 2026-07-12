import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Extension to track agent-edited files and open them in an editor.
 */
export default function trackEdits(pi: ExtensionAPI) {
  const trackedFiles = new Set<string>();

  // Restore state from session entries on startup/reload
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "tracked-edits") {
        if (Array.isArray(entry.data?.files)) {
          for (const file of entry.data.files) {
            trackedFiles.add(file);
          }
        }
      }
    }
  });

  // Track files when write or edit tools succeed
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    let filePath: string | undefined;

    if (isToolCallEventType("write", event)) {
      filePath = event.input.path;
    } else if (isToolCallEventType("edit", event)) {
      filePath = event.input.path;
    }

    if (filePath) {
      handleFilePath(filePath, ctx);
    }
  });

  function handleFilePath(filePath: string, ctx: ExtensionContext) {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(ctx.cwd, filePath);

    if (!trackedFiles.has(absolutePath)) {
      trackedFiles.add(absolutePath);
      // Persist to session
      pi.appendEntry("tracked-edits", { files: Array.from(trackedFiles) });
    }
  }

  pi.registerCommand("open-changes", {
    description: "Open agent-edited uncommitted files in VS Code",
    handler: async (args, ctx) => {
      if (trackedFiles.size === 0) {
        ctx.ui.notify("No files have been edited by the agent in this session.", "info");
        return;
      }

      const uncommittedFiles = filterUncommitted(Array.from(trackedFiles), ctx.cwd);

      if (uncommittedFiles.length === 0) {
        ctx.ui.notify("All agent edits have been committed or are clean.", "info");
        return;
      }

      ctx.ui.notify(`Opening ${uncommittedFiles.length} file(s) in VS Code...`, "info");
      
      for (const file of uncommittedFiles) {
        try {
          const relativePath = path.relative(ctx.cwd, file);
          const tmpFile = path.join(os.tmpdir(), `pi-diff-${path.basename(file)}`);
          
          openDiff(relativePath, tmpFile, file, ctx);
        } catch (e) {
          ctx.ui.notify(`Failed to open ${file}: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
      }
    },
  });

  function openDiff(relativePath: string, tmpFile: string, file: string, ctx: ExtensionContext) {
    try {
      // Get the base version from git (HEAD)
      execSync(`git show HEAD:"${relativePath}" > "${tmpFile}"`, { cwd: ctx.cwd });
      // Open VS Code in diff mode
      execSync(`code --diff "${tmpFile}" "${file}"`, { cwd: ctx.cwd });
    } catch {
      // If it's a new file or git show fails, just open it
      try {
        execSync(`code "${file}"`, { cwd: ctx.cwd });
      } catch {
        // ignore errors
      }
    }
  }

  /**
   * Filter the list of files to only those that are modified/untracked in Git.
   */
  function filterUncommitted(files: string[], cwd: string): string[] {
    try {
      // Get list of changed/untracked files from git
      const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
      const gitChangedFilesSet = new Set(
        status
          .split("\n")
          .map((line) => line.slice(3).trim())
          .filter(Boolean)
          .map((p) => path.resolve(cwd, p))
      );

      return files.filter((f) => {
        // Must exist on disk
        if (!fs.existsSync(f)) return false;
        // Must be in the git changed list
        return gitChangedFilesSet.has(f);
      });
    } catch {
      // Not a git repo or git not found? Just return files that exist.
      return files.filter((f) => fs.existsSync(f));
    }
  }
}
