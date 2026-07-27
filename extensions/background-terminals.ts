import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DynamicBorder,
	formatSize,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const START_SCHEMA = Type.Object({
	command: Type.Optional(Type.String({ description: "A shell command to run in the background." })),
	commands: Type.Optional(Type.Array(Type.String(), {
		description: "Ordered shell commands to run sequentially. Execution stops when a command fails.",
		minItems: 1,
	})),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project directory." })),
	maxRuntimeSeconds: Type.Optional(Type.Number({
		description: "Optional maximum runtime in seconds. The terminal is stopped when this limit expires.",
		exclusiveMinimum: 0,
	})),
});

const CONTROL_SCHEMA = Type.Object({
	action: Type.Union([
		Type.Literal("status"),
		Type.Literal("read"),
		Type.Literal("wait"),
		Type.Literal("stop"),
	], {
		description: "Operation to perform: status returns metadata, read returns log output, wait waits for completion, and stop terminates the terminal.",
	}),
	id: Type.String({ description: "Background terminal ID returned by background_terminal." }),
	timeoutSeconds: Type.Optional(Type.Number({
		description: "For wait: maximum time to wait without stopping the terminal. Omit to wait until it finishes.",
		exclusiveMinimum: 0,
	})),
	maxBytes: Type.Optional(Type.Integer({
		description: `For read: maximum log bytes to return from the tail (default ${formatSize(DEFAULT_MAX_BYTES)}).`,
		minimum: 1,
		maximum: 1024 * 1024,
	})),
	maxLines: Type.Optional(Type.Integer({
		description: `For read: maximum log lines to return from the tail (default ${DEFAULT_MAX_LINES}).`,
		minimum: 1,
		maximum: 10000,
	})),
});

type StartInput = Static<typeof START_SCHEMA>;
type ControlInput = Static<typeof CONTROL_SCHEMA>;
type TerminalStatus = "running" | "completed" | "failed" | "stopped" | "timed_out";

interface BackgroundTerminal {
	id: string;
	command: string;
	cwd: string;
	process: ChildProcess;
	logPath: string;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	status: TerminalStatus;
	maxRuntimeTimer?: NodeJS.Timeout;
	completion: Promise<void>;
	resolveCompletion: () => void;
}

/** Returns a shell command that runs all supplied commands in order and stops on failure. */
function buildCommand(params: StartInput): string {
	const hasCommand = typeof params.command === "string" && params.command.trim().length > 0;
	const hasCommands = Array.isArray(params.commands) && params.commands.length > 0;
	if (hasCommand === hasCommands) {
		throw new Error("Provide exactly one of command or commands.");
	}
	if (hasCommand) return params.command!.trim();
	if (params.commands!.some((command) => command.trim().length === 0)) {
		throw new Error("commands cannot contain empty commands.");
	}
	return params.commands!.map((command) => `(${command})`).join(" && ");
}

/** Stops a process and its descendants without waiting for process exit. */
function stopProcessTree(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null) return;
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.unref();
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
}

/** Reads all output currently captured for a terminal. */
function readFullLog(terminal: BackgroundTerminal): string {
	if (!existsSync(terminal.logPath)) return "(no output yet)";
	const output = readFileSync(terminal.logPath, "utf8");
	return output.length > 0 ? output : "(no output yet)";
}

/** Reads and truncates the newest terminal output for safe inclusion in model context. */
function readLog(terminal: BackgroundTerminal, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES): string {
	const output = readFullLog(terminal);
	if (output === "(no output yet)") return output;
	const truncation = truncateTail(output, { maxBytes, maxLines });
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n\n[Output truncated: showing the newest ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full log: ${terminal.logPath}]`;
}

/** Formats terminal metadata and its log location without reading terminal output. */
function formatTerminal(terminal: BackgroundTerminal): string {
	const elapsedMs = (terminal.finishedAt ?? Date.now()) - terminal.startedAt;
	const lines = [
		`ID: ${terminal.id}`,
		`Status: ${terminal.status}`,
		`PID: ${terminal.process.pid ?? "unknown"}`,
		`Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
		`Exit code: ${terminal.exitCode ?? "n/a"}`,
		`Working directory: ${terminal.cwd}`,
		`Command: ${terminal.command}`,
		`Log: ${terminal.logPath}`,
	];
	return lines.join("\n");
}

/** Resolves a terminal ID or throws an actionable error. */
function requireTerminal(terminals: Map<string, BackgroundTerminal>, id: string): BackgroundTerminal {
	const terminal = terminals.get(id);
	if (!terminal) throw new Error(`Unknown background terminal: ${id}. Terminal IDs are returned by background_terminal.`);
	return terminal;
}

export default function backgroundTerminalsExtension(pi: ExtensionAPI): void {
	const terminals = new Map<string, BackgroundTerminal>();
	let nextId = 1;
	let updateIndicator: (() => void) | undefined;

	/** Stops one terminal and waits briefly for its process tree to exit. */
	async function stopTerminal(terminal: BackgroundTerminal): Promise<void> {
		if (terminal.status !== "running") return;
		terminal.status = "stopped";
		updateIndicator?.();
		stopProcessTree(terminal.process);
		await Promise.race([
			terminal.completion,
			new Promise<void>((resolve) => setTimeout(resolve, 5000)),
		]);
	}

	/** Starts a background terminal and records its output and lifecycle. */
	function startTerminal(params: StartInput, defaultCwd: string): BackgroundTerminal {
		const command = buildCommand(params);
		const cwd = params.cwd ?? defaultCwd;
		const id = `term-${nextId++}`;
		const logDirectory = join(tmpdir(), `pi-background-terminals-${process.pid}`);
		mkdirSync(logDirectory, { recursive: true });
		const logPath = join(logDirectory, `${id}.log`);
		const log = createWriteStream(logPath, { flags: "w" });
		const child = spawn(command, {
			cwd,
			shell: true,
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout!.pipe(log, { end: false });
		child.stderr!.pipe(log, { end: false });

		let resolveCompletion!: () => void;
		const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
		const terminal: BackgroundTerminal = {
			id, command, cwd, process: child, logPath, startedAt: Date.now(), status: "running",
			completion, resolveCompletion,
		};
		terminals.set(id, terminal);

		child.once("error", (error) => {
			log.write(`\n[pi: failed to start terminal: ${error.message}]\n`);
		});
		child.once("close", (code, signal) => {
			if (terminal.maxRuntimeTimer) clearTimeout(terminal.maxRuntimeTimer);
			terminal.finishedAt = Date.now();
			terminal.exitCode = code;
			terminal.signal = signal;
			if (terminal.status === "running") terminal.status = code === 0 ? "completed" : "failed";
			log.end();
			terminal.resolveCompletion();
			updateIndicator?.();
		});

		if (params.maxRuntimeSeconds !== undefined) {
			terminal.maxRuntimeTimer = setTimeout(() => {
				if (terminal.status !== "running") return;
				terminal.status = "timed_out";
				updateIndicator?.();
				stopProcessTree(child);
			}, params.maxRuntimeSeconds * 1000);
		}
		return terminal;
	}

	pi.registerTool({
		name: "background_terminal",
		label: "Background Terminal",
		description: "Start one shell command or an ordered command list in a background terminal and return immediately. Output is written only to the returned log path; use background_terminal_control to inspect, read, wait for, or stop it. Optionally enforces a maximum runtime.",
		promptSnippet: "Start commands in a background terminal and return immediately.",
		promptGuidelines: [
			"Use background_terminal for useful long-running commands that can run while other work continues.",
			"Use background_terminal_control with action wait before relying on a background terminal's result.",
		],
		parameters: START_SCHEMA,
		async execute(_toolCallId, params: StartInput, _signal, _onUpdate, ctx) {
			const terminal = startTerminal(params, ctx.cwd);
			updateIndicator?.();
			return { content: [{ type: "text", text: formatTerminal(terminal) }], details: { id: terminal.id, logPath: terminal.logPath } };
		},
	});

	pi.registerTool({
		name: "background_terminal_control",
		label: "Background Terminal Control",
		description: `Inspect, read the output of, wait for, or stop a background terminal. The read action returns combined stdout and stderr, truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} by default; all other actions return metadata only.`,
		parameters: CONTROL_SCHEMA,
		async execute(_toolCallId, params: ControlInput, signal) {
			const terminal = requireTerminal(terminals, params.id);
			if (params.action === "status") {
				return { content: [{ type: "text", text: formatTerminal(terminal) }], details: { id: terminal.id, status: terminal.status, exitCode: terminal.exitCode, logPath: terminal.logPath } };
			}
			if (params.action === "read") {
				const output = readLog(terminal, params.maxBytes, params.maxLines);
				return { content: [{ type: "text", text: `${formatTerminal(terminal)}\n\n--- terminal output (tail) ---\n${output}` }], details: { id: terminal.id, status: terminal.status, logPath: terminal.logPath } };
			}
			if (params.action === "stop") {
				await stopTerminal(terminal);
				return { content: [{ type: "text", text: formatTerminal(terminal) }], details: { id: terminal.id, status: terminal.status, logPath: terminal.logPath } };
			}

			if (terminal.status === "running") {
				let timeout: NodeJS.Timeout | undefined;
				let abortHandler: (() => void) | undefined;
				const timeoutPromise = params.timeoutSeconds === undefined
					? new Promise<"timeout">(() => {})
					: new Promise<"timeout">((resolve) => { timeout = setTimeout(() => resolve("timeout"), params.timeoutSeconds! * 1000); });
				const abortPromise = new Promise<"aborted">((resolve) => {
					if (signal?.aborted) resolve("aborted");
					else if (signal) {
						abortHandler = () => resolve("aborted");
						signal.addEventListener("abort", abortHandler, { once: true });
					}
				});
				const result = await Promise.race([terminal.completion.then(() => "completed" as const), timeoutPromise, abortPromise]);
				if (timeout) clearTimeout(timeout);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				if (result === "timeout") return { content: [{ type: "text", text: `Wait timed out; terminal is still running.\n\n${formatTerminal(terminal)}` }], details: { id: terminal.id, status: terminal.status, waitTimedOut: true, logPath: terminal.logPath } };
				if (result === "aborted") return { content: [{ type: "text", text: `Wait cancelled; terminal was not stopped.\n\n${formatTerminal(terminal)}` }], details: { id: terminal.id, status: terminal.status, waitCancelled: true, logPath: terminal.logPath } };
			}
			return { content: [{ type: "text", text: formatTerminal(terminal) }], details: { id: terminal.id, status: terminal.status, exitCode: terminal.exitCode, logPath: terminal.logPath } };
		},
	});

	pi.registerCommand("kill-terminal", {
		description: "Stop one or all running background terminals",
		getArgumentCompletions: (prefix) => {
			const values = ["all", ...[...terminals.values()].filter((terminal) => terminal.status === "running").map((terminal) => terminal.id)];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const running = [...terminals.values()].filter((terminal) => terminal.status === "running");
			if (running.length === 0) {
				ctx.ui.notify("No running background terminals.", "info");
				return;
			}

			let selection = args.trim();
			if (!selection) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Specify a terminal ID or use /kill-terminal all.", "warning");
					return;
				}
				selection = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					container.addChild(new Text(theme.fg("accent", theme.bold("Running background terminals")), 1, 0));
					container.addChild(new Text(theme.fg("dim", "Select a terminal to stop, or stop all running terminals."), 1, 0));

					const items: SelectItem[] = [
						{
							value: "all",
							label: `Stop all (${running.length})`,
							description: "Stop every running background terminal",
						},
						...running.map((terminal) => {
							const elapsed = ((Date.now() - terminal.startedAt) / 1000).toFixed(1);
							return {
								value: terminal.id,
								label: `${terminal.id}  pid=${terminal.process.pid ?? "?"}  ${elapsed}s`,
								description: terminal.command,
							};
						}),
					];
					const list = new SelectList(items, Math.min(items.length, 12), {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					});
					list.onSelect = (item) => done(item.value);
					list.onCancel = () => done(undefined);
					container.addChild(list);
					container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter stop • esc cancel"), 1, 0));
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

					return {
						render: (width) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							list.handleInput(data);
							tui.requestRender();
						},
					};
				});
				if (!selection) return;
			}

			if (selection === "all") {
				await Promise.all(running.map(stopTerminal));
				ctx.ui.notify(`Stopped ${running.length} background terminal${running.length === 1 ? "" : "s"}.`, "info");
				return;
			}

			const terminal = terminals.get(selection);
			if (!terminal || terminal.status !== "running") {
				ctx.ui.notify(`No running background terminal named ${selection}.`, "warning");
				return;
			}
			await stopTerminal(terminal);
			ctx.ui.notify(`Stopped ${terminal.id}. Log: ${terminal.logPath}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		updateIndicator = () => {
			const count = [...terminals.values()].filter((terminal) => terminal.status === "running").length;
			const dots = count > 0 ? `${"●".repeat(Math.min(count, 8))}${count > 8 ? "+" : ""} ` : "";
			const color = count > 0 ? "accent" : "dim";
			ctx.ui.setWidget("background-terminal-count", [ctx.ui.theme.fg(color, `${dots}background terminals: ${count}`)]);
		};
		updateIndicator();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		updateIndicator = undefined;
		ctx.ui.setWidget("background-terminal-count", undefined);

		const running = [...terminals.values()].filter((terminal) => terminal.status === "running");
		for (const terminal of running) {
			terminal.status = "stopped";
			stopProcessTree(terminal.process);
		}
		await Promise.all(running.map((terminal) => Promise.race([
			terminal.completion,
			new Promise<void>((resolve) => setTimeout(resolve, 2000)),
		])));
	});
}
