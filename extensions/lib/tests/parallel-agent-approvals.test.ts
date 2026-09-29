import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApprovalQueue } from "../parallel-agent-approvals.ts";
import { commandsAreAllowed, loadToolReviewConfig, parseDecision } from "../../tool-review.ts";

test("reviewer accepts documented schema and legacy boolean/reject decisions", () => {
	assert.equal(parseDecision('{"decision":"approve","rules":[]}').decision, "approve");
	assert.deepEqual(parseDecision('text {"approved":false,"reason":"unsafe"}'), { decision: "escalate", reason: "unsafe", rules: [] });
	assert.equal(parseDecision('{"decision":"reject","reason":"unsafe"}').decision, "escalate");
	assert.equal(parseDecision('{"decision":"reject","approved":true}').decision, "escalate");
	assert.throws(() => parseDecision('{"approved":"yes"}'), /invalid decision/);
});

test("shell substitutions inside double quotes never bypass preapproved command rules", () => {
	const rules = loadToolReviewConfig().rules;
	assert.equal(commandsAreAllowed(['rg "$(rm -rf ~/data)"'], rules), false);
	assert.equal(commandsAreAllowed(['rg "`rm -rf ~/data`"'], rules), false);
	assert.equal(commandsAreAllowed(['rg "ordinary quoted text"'], rules), true);
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
