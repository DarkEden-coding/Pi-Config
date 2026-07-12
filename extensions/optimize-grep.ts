import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPTIMIZED_TOOL_NAMES = new Set(["grep", "find", "bash", "terminal", "shell"]);
const MIN_MATCHES_FOR_GENERIC_TOOL = 5;
const MIN_PATH_LINES_FOR_LIST = 5;

interface ParsedGrepLine {
  filePath: string;
  lineNumber: string;
  text: string;
  isMatch: boolean;
}

interface ParsedPathLine {
  path: string;
  dir: string;
  base: string;
}

type TextContentPart = { type: "text"; text: string };

function isTextContentPart(part: unknown): part is TextContentPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

function parseGrepLine(line: string): ParsedGrepLine | undefined {
  const cleanLine = line.replace(/\r$/, "");
  // grep/rg/vimgrep style: path:line:content, path-line-content, and context lines.
  // Require a non-empty path and a numeric line so ordinary log/status lines are ignored.
  // The non-greedy path still works for Windows drive paths because the separator must be
  // followed by a line number (for example C:\\repo\\file.ts:12:content).
  const match = /^(.+?)([:-])(\d+)([:-])(.*)$/.exec(cleanLine);
  if (!match) return undefined;

  const [, filePath, sep1, lineNumber, , text] = match;
  if (!filePath.trim()) return undefined;

  return {
    filePath,
    lineNumber: lineNumber.padStart(4, " "),
    text,
    isMatch: sep1 === ":",
  };
}

function getPathParts(inputPath: string): { dir: string; base: string } {
  const expanded = inputPath.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "~");
  const parser = /^(?:[A-Za-z]:)?[\\/]/.test(expanded) || expanded.includes("\\") ? path.win32 : path.posix;
  return {
    dir: parser.dirname(expanded),
    base: parser.basename(expanded),
  };
}

function parsePathLine(line: string): ParsedPathLine | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[") || trimmed.startsWith("...") || trimmed.startsWith("$ ")) return undefined;

  const startsLikePath = /^([./~]|[A-Za-z]:[\\/])/.test(trimmed);
  const containsPathSeparator = trimmed.includes("/") || trimmed.includes("\\");
  if (!startsLikePath && !containsPathSeparator) return undefined;

  // Bare relative paths with whitespace are more likely to be prose/status output. Allow
  // whitespace for explicit/absolute paths so `find` output such as `./dir/my file.ts` and
  // Windows paths like `C:\\repo\\my file.ts` can still be grouped.
  if (!startsLikePath && /\s/.test(trimmed)) return undefined;

  const { dir, base } = getPathParts(trimmed);
  return { path: trimmed, dir, base };
}

function shouldPreserveLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    !trimmed ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("(...") ||
    trimmed.startsWith("...") ||
    trimmed.startsWith("(unable to read file)") ||
    /^Command (exited|timed out|aborted)/.test(trimmed)
  );
}

function optimizeGrepLikeOutput(text: string, options: { force: boolean }): string | undefined {
  const lines = text.split(/\r?\n/);
  const parsedLines = lines.map(parseGrepLine);
  const matchCount = parsedLines.filter(Boolean).length;

  if (!options.force && matchCount < MIN_MATCHES_FOR_GENERIC_TOOL) return undefined;
  if (matchCount === 0) return undefined;

  const formattedLines: string[] = [];
  let currentFile: string | null = null;
  let changed = false;

  for (const line of lines) {
    if (shouldPreserveLine(line)) {
      if (line.trim()) formattedLines.push(line);
      continue;
    }

    const parsed = parseGrepLine(line);
    if (!parsed) {
      formattedLines.push(line);
      currentFile = null;
      continue;
    }

    changed = true;
    if (parsed.filePath !== currentFile) {
      currentFile = parsed.filePath;
      if (formattedLines.length > 0) formattedLines.push("");
      formattedLines.push(parsed.filePath);
    }

    formattedLines.push(`${parsed.lineNumber}: ${parsed.text}`);
  }

  if (!changed) return undefined;
  return formattedLines.join("\n").trim();
}

function optimizePathListOutput(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const parsed = lines.map(parsePathLine).filter((line): line is ParsedPathLine => Boolean(line));
  if (parsed.length < MIN_PATH_LINES_FOR_LIST) return undefined;

  const uniquePaths = new Set(parsed.map((entry) => entry.path));
  if (uniquePaths.size < MIN_PATH_LINES_FOR_LIST) return undefined;

  const groups = new Map<string, string[]>();
  const order: string[] = [];

  for (const entry of parsed) {
    if (!groups.has(entry.dir)) order.push(entry.dir);
    const list = groups.get(entry.dir) ?? [];
    list.push(entry.base);
    groups.set(entry.dir, list);
  }

  const formattedLines: string[] = [];
  for (const dir of order) {
    const files = groups.get(dir);
    if (!files?.length) continue;
    if (formattedLines.length > 0) formattedLines.push("");
    formattedLines.push(dir);
    for (const file of files) formattedLines.push(`  ${file}`);
  }

  return formattedLines.length > 0 ? formattedLines.join("\n") : undefined;
}

function optimizeTerminalOutput(text: string, force: boolean): string | undefined {
  const grepOptimized = optimizeGrepLikeOutput(text, { force });
  if (grepOptimized) return grepOptimized;

  const pathListOptimized = optimizePathListOutput(text);
  if (pathListOptimized) return pathListOptimized;

  return undefined;
}

export default function optimizeGrep(pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (!OPTIMIZED_TOOL_NAMES.has(event.toolName)) return;

    if (!Array.isArray(event.content)) return;

    let changed = false;
    const content = event.content.map((part: unknown) => {
      if (!isTextContentPart(part) || !part.text) return part;

      const optimized = optimizeTerminalOutput(part.text, event.toolName === "grep");
      if (!optimized) return part;

      changed = true;
      return {
        ...part,
        text: `[Terminal output optimized: grouped paths and grep-like matches]\n${optimized}`,
      };
    });

    if (!changed) return;
    return { content };
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\nNote: terminal output from grep/find-style commands is optimized by grouping paths and grep-like matches.",
    };
  });
}
