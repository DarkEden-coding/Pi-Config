import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApprovalQueue } from "../parallel-agent-approvals.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandsAreAllowed, loadToolReviewConfig, parseReviewToolCall, reviewOnce } from "../../tool-review.ts";

const reviewCall = (args: Record<string, unknown>): AssistantMessage["content"] => [
	{ type: "toolCall", id: "review-1", name: "submit_review", arguments: args },
];

test("reviewer reads only the named tool call and fails closed on invalid decisions", () => {
	assert.deepEqual(parseReviewToolCall(reviewCall({ decision: "approve", reason: "safe", rules: [] })), { decision: "approve", reason: "safe", rules: [] });
	assert.deepEqual(parseReviewToolCall(reviewCall({ decision: "escalate", reason: "unsafe", rules: [{ kind: "feature", value: "redirect", rationale: "ignore" }] })), { decision: "escalate", reason: "unsafe", rules: [] });
	assert.deepEqual(parseReviewToolCall(reviewCall({ decision: "approve", reason: "safe", rules: [{ kind: "feature", value: "pipe", rationale: "safe" }, { kind: "structured", executable: "rm", argsPrefix: [], allowAdditionalArgs: true, forbiddenArgs: [], rationale: "unsafe" }] })).rules, [{ kind: "feature", value: "pipe", rationale: "safe" }]);
	for (const malformed of ["es需calate", "es escalate"]) {
		const result = parseReviewToolCall(reviewCall({ decision: malformed, reason: "This changes the review policy", rules: [{ kind: "feature", value: "redirect", rationale: "unsafe" }] }));
		assert.equal(result.decision, "escalate");
		assert.match(result.reason!, /This changes the review policy/);
		assert.deepEqual(result.rules, []);
	}
	assert.throws(() => parseReviewToolCall([{ type: "text", text: '{"decision":"approve"}' }]), /did not call/);
	assert.throws(() => parseReviewToolCall([...reviewCall({ decision: "approve", reason: "safe", rules: [] }), ...reviewCall({ decision: "approve", reason: "safe", rules: [] })]), /exactly once/);
	assert.throws(() => parseReviewToolCall(reviewCall({ decision: "approve", reason: "safe" })), /rules array/);
	assert.throws(() => parseReviewToolCall(reviewCall({ decision: "approve", reason: "", rules: [] })), /no reason/);
});

test("review request uses the registry to declare submit_review and preserves provider errors", async () => {
	let sent: { tools?: Array<{ name: string; parameters: unknown }> } | undefined;
	let requestedToolChoice: string | undefined;
	const response = {
		content: reviewCall({ decision: "escalate", reason: "ask the parent", rules: [] }),
		stopReason: "toolUse",
		errorMessage: undefined as string | undefined,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const streamSimple = (_model: unknown, context: typeof sent, options: { toolChoice?: string }) => { sent = context; requestedToolChoice = options.toolChoice; return { result: async () => response }; };
	const model = { provider: "test", id: "reviewer", api: "openai-codex-responses" };
	const ctx = {
		cwd: "/tmp", sessionManager: { getBranch: () => [] },
		modelRegistry: { find: () => model, streamSimple },
	} as unknown as ExtensionContext;
	const decision = await reviewOnce(ctx, { reviewer: { provider: "test", model: "reviewer", thinkingLevel: "off" }, gatedTools: ["bash"], rules: [] }, "bash", { command: "echo hello" }, () => {});
	assert.equal(decision.decision, "escalate");
	assert.deepEqual(sent?.tools?.map((tool) => tool.name), ["submit_review"]);
	assert.equal(requestedToolChoice, "required");
	assert.ok(sent?.tools?.[0]?.parameters);
	response.content = [{ type: "text", text: '{"decision":"approve","reason":"safe","rules":[]}' }];
	await assert.rejects(reviewOnce(ctx, { reviewer: { provider: "test", model: "reviewer", thinkingLevel: "off" }, gatedTools: ["bash"], rules: [] }, "bash", { command: "echo hello" }, () => {}), /did not call submit_review/);
	response.stopReason = "error";
	response.errorMessage = "Codex error: Tool choice 'required' must be specified with 'tools' parameter.";
	await assert.rejects(reviewOnce(ctx, { reviewer: { provider: "test", model: "reviewer", thinkingLevel: "off" }, gatedTools: ["bash"], rules: [] }, "bash", { command: "echo hello" }, () => {}), /Codex error: Tool choice 'required'/);
});

test("shell substitutions inside double quotes never bypass preapproved command rules", () => {
	const rules = loadToolReviewConfig().rules;
	assert.equal(commandsAreAllowed(['rg "$(rm -rf ~/data)"'], rules), false);
	assert.equal(commandsAreAllowed(['rg "`rm -rf ~/data`"'], rules), false);
	assert.equal(commandsAreAllowed(['rg "ordinary quoted text"'], rules), true);
	assert.equal(commandsAreAllowed(["rm -rf /"], [{ id: "broken-regex", enabled: true, kind: "regex", value: '^for f in [^;]+; do node --check "\\$f" >/dev/null || exit 1; done$', rationale: "bad alternation", createdAt: "test" }]), false);
});

test("parent can approve or deny independent requests and cancellation fails closed", async () => {
	const queue = new AgentApprovalQueue();
	const abort = new AbortController();
	const waiting = queue.waitForRequest();
	const first = queue.request("agent-a", { toolName: "bash", input: { command: "echo hi" }, reason: "reviewer uncertain" });
	await waiting.promise;
	const second = queue.request("agent-b", { toolName: "bash", input: { command: "rm -rf /" }, reason: "destructive", signal: abort.signal });
	const [a, b] = queue.list();
	assert.equal(a.agent, "agent-a");
	assert.equal(b.reason, "destructive");
	assert.equal(queue.decide(a.id, true)?.id, a.id);
	assert.equal(await first, true);
	const denied = queue.request("agent-a", { toolName: "bash", input: { command: "false" }, reason: "needs correction" });
	assert.equal(queue.decide(queue.list().find((review) => review.agent === "agent-a")!.id, false)?.agent, "agent-a");
	assert.equal(await denied, false);
	abort.abort();
	assert.equal(await second, false);
	assert.deepEqual(queue.list(), []);
	assert.equal(queue.decide(b.id, true), undefined);
});
