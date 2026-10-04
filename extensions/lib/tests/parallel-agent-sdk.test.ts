import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
// The runtime loader resolves these to the installed CLI SDK.
import {
	createAgentSession,
	initTheme,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	ModelRuntime,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

/** Completes an offline provider response through the real SDK event stream. */
function respond(
	stream: AssistantMessageEventStream,
	content: AssistantMessage["content"] = [
		{ type: "text", text: "offline report" },
	],
): void {
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "sdk-test",
		model: "offline",
		stopReason: content.some((part) => part.type === "toolCall")
			? "toolUse"
			: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end();
}

/** Waits for observable SDK state and fails rather than hanging a regression test. */
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (check()) return;
		await sleep(10);
	}
	assert.fail("SDK state did not arrive within three seconds");
}

/** Invokes a registered tool through the real SDK's contextual tool wrapper. */
async function control(
	session: AgentSession,
	params: Record<string, unknown>,
	name: string = "parallel_agents_control",
): Promise<{
	content: Array<{ type: string; text?: string }>;
	details: Record<string, unknown>;
}> {
	const tool = session.agent.state.tools.find((tool) => tool.name === name);
	assert.ok(tool);
	return (await tool.execute(
		"sdk-control",
		params,
		new AbortController().signal,
	)) as {
		content: Array<{ type: string; text?: string }>;
		details: Record<string, unknown>;
	};
}

test(
	"Installed Pi SDK supervises busy/idle parents, approvals, overlapping resumes and setup failures offline",
	{ timeout: 15000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "parallel-agent-sdk-"));
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		let session: AgentSession | undefined;
		try {
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			mkdirSync(cwd);
			mkdirSync(agentDir);
			process.env.PI_CODING_AGENT_DIR = agentDir;
			initTheme("dark", false);
			writeFileSync(
				join(agentDir, "SYSTEM.md"),
				"BASE_SYSTEM_SENTINEL: retain user safety instructions.",
			);
			writeFileSync(
				join(cwd, "AGENTS.md"),
				"PROJECT_SENTINEL: do not edit unassigned files.",
			);
			mkdirSync(join(agentDir, "skills", "relevant"), { recursive: true });
			writeFileSync(
				join(agentDir, "skills", "relevant", "SKILL.md"),
				"---\nname: relevant\ndescription: SDK test metadata\n---\nUNRELATED_SKILL_BODY_SENTINEL",
			);
			writeFileSync(
				join(agentDir, "parallel-agents.json"),
				JSON.stringify({
					maxParallelAgents: 4,
					allowedExtensionTools: [],
					models: [
						{
							name: "offline",
							provider: "sdk-test",
							model: "offline",
							description: "offline SDK fixture",
							enabled: true,
						},
						{
							name: "missing",
							provider: "sdk-test",
							model: "missing",
							description: "setup failure fixture",
							enabled: true,
						},
					],
				}),
			);
			writeFileSync(
				join(agentDir, "tool-review.json"),
				JSON.stringify({
					reviewer: {
						provider: "sdk-test",
						model: "offline",
						thinkingLevel: "low",
					},
					gatedTools: ["bash"],
					rules: [],
				}),
			);
			const manager = SessionManager.create(cwd, join(root, "parents"));
			const tasks = ["A", "B", "C"].map((name) => ({
				name,
				model: name === "C" ? "missing" : "offline",
				reasoningLevel: "low",
				prompt: `Task ${name}. Never edit files.`,
			}));
			const childFiles = tasks.map((task) => {
				const child = SessionManager.create(cwd, join(root, "children"));
				child.appendMessage({
					role: "user",
					content: `Task ${task.name}`,
					timestamp: Date.now(),
				});
				child.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "interrupted checkpoint" }],
					api: "openai-completions",
					provider: "sdk-test",
					model: "offline",
					stopReason: "stop",
					timestamp: Date.now(),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				});
				return child.getSessionFile();
			});
			const runId = "parallel-sdk-test";
			manager.appendCustomEntry("parallel-agent-run", { id: runId });
			mkdirSync(join(agentDir, "parallel-agent-runs"));
			writeFileSync(
				join(agentDir, "parallel-agent-runs", `${runId}.json`),
				JSON.stringify({
					id: runId,
					owner: manager.getSessionId(),
					tasks,
					preferences: "Do not stop Swath. Never expose bearer credentials.",
					childFiles,
					stats: tasks.map((task) => ({
						name: task.name,
						model: task.model,
						reasoningLevel: task.reasoningLevel,
						status: "interrupted",
						iterations: 0,
						actions: 0,
						cost: 0,
						filesRead: [],
						filesEdited: [],
					})),
				}),
			);
			const childStreams = new Map<string, AssistantMessageEventStream>();
			const childContexts: string[] = [];
			const settingsManager = SettingsManager.create(cwd, agentDir, {
				projectTrusted: true,
			});
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: false,
				additionalExtensionPaths: [
					join(import.meta.dirname, "../../parallel-agents.ts"),
				],
				extensionFactories: [
					(pi) => {
						pi.registerProvider("sdk-test", {
							api: "openai-completions",
							apiKey: "offline-test-only",
							baseUrl: "http://offline.invalid",
							models: [
								{
									id: "offline",
									name: "offline",
									reasoning: false,
									input: ["text"],
									contextWindow: 32000,
									maxTokens: 1000,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								},
							],
							streamSimple: (_model, context) => {
								const stream = createAssistantMessageEventStream();
								const text = JSON.stringify(context);
								if (
									text.includes("submit_review") &&
									!text.includes("parallel_agents_control")
								)
									queueMicrotask(() =>
										respond(stream, [
											{
												type: "toolCall",
												id: "review-1",
												name: "submit_review",
												arguments: {
													decision: "escalate",
													reason: "Explicit offline test escalation",
													rules: [],
												},
											},
										]),
									);
								else if (
									!text.includes("Explicit parent resume") &&
									!text.includes("Task D")
								)
									queueMicrotask(() => respond(stream));
								else {
									childContexts.push(text);
									const name = text.includes("Task A")
										? "A"
										: text.includes("Task D")
											? "D"
											: "B";
									if (text.includes('"role":"toolResult"'))
										queueMicrotask(() => respond(stream));
									else childStreams.set(name, stream);
								}
								return stream;
							},
						});
					},
				],
				noPromptTemplates: true,
				noThemes: true,
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const runtime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				refreshOnCreate: false,
			});
			({ session } = await createAgentSession({
				cwd,
				agentDir,
				modelRuntime: runtime,
				settingsManager,
				resourceLoader: loader,
				sessionManager: manager,
				tools: ["parallel_agents", "parallel_agents_control"],
			}));
			await session.bindExtensions({ mode: "print" });
			await session.setModel(runtime.getModel("sdk-test", "offline")!);
			const parentRequests: string[] = [];
			let busyStream: AssistantMessageEventStream | undefined;
			let holdParent = false;
			session.agent.streamFunction = (_model, context) => {
				const stream = createAssistantMessageEventStream();
				parentRequests.push(JSON.stringify(context));
				if (holdParent) {
					busyStream = stream;
					holdParent = false;
				} else queueMicrotask(() => respond(stream));
				return stream;
			};
			await control(session, {
				action: "resume",
				runId,
				agents: ["C"],
				message: "Continue C",
			});
			await until(
				() =>
					JSON.parse(
						readFileSync(
							join(agentDir, "parallel-agent-runs", `${runId}.json`),
							"utf8",
						),
					).stats[2].status === "failed",
			);
			await control(session, {
				action: "resume",
				runId,
				agents: ["A"],
				message: "Continue A",
			});
			await until(() => childStreams.has("A"));
			assert.match(childContexts[0], /BASE_SYSTEM_SENTINEL/);
			assert.match(childContexts[0], /PROJECT_SENTINEL/);
			assert.match(childContexts[0], /Do not stop Swath/);
			assert.match(childContexts[0], /SDK test metadata/);
			assert.doesNotMatch(childContexts[0], /UNRELATED_SKILL_BODY_SENTINEL/);
			await control(session, {
				action: "resume",
				runId,
				agents: ["B"],
				message: "Continue B",
			});
			await until(() => childStreams.has("B"));
			respond(childStreams.get("B")!);
			await until(() =>
				parentRequests.some((text) =>
					text.includes("B · completed: Persisted report available"),
				),
			);
			// B's idle-parent completion must not make whole-run wait report A complete.
			const waiting = await control(session, {
				action: "wait",
				runId,
				timeoutSeconds: 0.03,
			});
			assert.equal(waiting.details.waitTimedOut, true);
			const status = await control(session, { action: "status", runId });
			assert.match(JSON.stringify(status.content), /A: active/);
			assert.match(JSON.stringify(status.content), /B: done/);
			// Exercise a real parent run, not a boolean "busy" stub.
			holdParent = true;
			const parentRun = session.prompt("BUSY_PARENT_SENTINEL");
			await until(() => !!busyStream && session!.isStreaming);
			const approvalWait = control(session, {
				action: "wait",
				runId,
				timeoutSeconds: 1,
			});
			respond(childStreams.get("A")!, [
				{
					type: "toolCall",
					id: "child-bash",
					name: "bash",
					arguments: { command: "printf sdk-no-execution" },
				},
			]);
			await until(() =>
				readFileSync(
					join(agentDir, "parallel-agents-debug.log"),
					"utf8",
				).includes("sub-agent-start"),
			);
			let approval: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 300; attempt++) {
				const pending = await control(session, {
					action: "pending_approvals",
					runId,
				});
				approval = (
					pending.details.pendingApprovals as Record<string, unknown>[]
				)[0];
				if (approval) break;
				await sleep(10);
			}
			assert.ok(approval);
			const released = await approvalWait;
			assert.equal((released.details.pendingApprovals as unknown[]).length, 1);
			assert.equal(released.details.waitTimedOut, undefined);
			assert.equal(
				parentRequests.some((text) => text.includes("approval_requested")),
				false,
			);
			respond(busyStream!);
			await parentRun;
			await until(() =>
				parentRequests.some((text) => text.includes("approval_requested")),
			);
			assert.match(JSON.stringify(approval), /printf sdk-no-execution/);
			await control(session, {
				action: "deny",
				runId,
				approvalId: approval.id,
			});
			await until(() =>
				parentRequests.some((text) =>
					text.includes("A · completed: Persisted report available"),
				),
			);
			// C fails before session construction. It must leave active and never announce success.
			const complete = await control(session, {
				action: "wait",
				runId,
				timeoutSeconds: 1,
			});
			assert.equal(complete.details.waitTimedOut, undefined);
			assert.match(JSON.stringify(complete.content), /C \[ERROR\]/);
			manager.appendCustomEntry("memories-snapshot", {
				global: {
					memories: [
						{
							text: "Use the exact edit tool shape. Write readable docstrings. Keep commands in foreground terminals. Never expose bearer credentials.",
						},
					],
				},
				project: { memories: [{ text: "Do not stop Swath." }] },
			});
			session.setActiveToolsByName([
				"parallel_agents",
				"parallel_agents_control",
			]);
			const spawned = await control(
				session,
				{
					blocking: false,
					tasks: [
						{
							name: "D",
							model: "offline",
							reasoningLevel: "low",
							prompt: "Task D. Read-only. Never mutate repository files.",
						},
					],
				},
				"parallel_agents",
			);
			await until(() => childStreams.has("D"));
			const freshContext = childContexts.find((text) =>
				text.includes("Task D"),
			)!;
			assert.match(freshContext, /exact edit tool shape/);
			assert.match(freshContext, /readable docstrings/);
			assert.match(freshContext, /foreground terminals/);
			assert.match(freshContext, /Never expose bearer credentials/);
			assert.match(freshContext, /Do not stop Swath/);
			assert.doesNotMatch(
				freshContext,
				/BUSY_PARENT_SENTINEL|UNRELATED_SKILL_BODY_SENTINEL/,
			);
			respond(childStreams.get("D")!);
			await control(session, {
				action: "wait",
				runId: spawned.details.runId,
				timeoutSeconds: 1,
			});
			await session.waitForIdle();
			assert.equal(
				parentRequests.some((text) => text.includes("C · completed:")),
				false,
			);
		} finally {
			session?.dispose();
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			rmSync(root, { recursive: true, force: true });
		}
	},
);
