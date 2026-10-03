import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentSupervisionQueue,
	codingPreferences,
	saveAgentRun,
	loadAgentRun,
	recoveredStatus,
} from "../parallel-agent-workflow.ts";
import { AgentApprovalQueue } from "../parallel-agent-approvals.ts";

test("approval and completion wake idle or busy parent, coalesce and respect branch ownership", async () => {
	for (const busy of [false, true]) {
		let owned = new Set(["parallel-one"]);
		const delivered: unknown[][] = [];
		const queue = new AgentSupervisionQueue(
			() => owned,
			(events) => {
				delivered.push(events);
			},
		);
		const event = {
			runId: "parallel-one",
			agent: "child",
			type: "approval_requested",
			detail: "approval-1 inspect then decide",
		};
		queue.enqueue(event);
		queue.enqueue(event);
		queue.enqueue({ ...event, runId: "parallel-two", type: "completed" });
		await Promise.resolve();
		assert.equal(delivered.length, 1, String(busy));
		assert.equal(delivered[0].length, 1);
		queue.wake();
		await Promise.resolve();
		assert.equal(delivered.length, 1); // no self-loop
		owned = new Set(["parallel-two"]);
		queue.wake();
		await Promise.resolve();
		assert.equal(delivered.length, 2);
	}
});
test("approval wait releases parent without auto approval", async () => {
	const approvals = new AgentApprovalQueue();
	const waiter = approvals.waitForRequest();
	let decided = false;
	const pending = approvals
		.request("child", {
			toolName: "bash",
			input: { command: "rm x" },
			reason: "review",
		} as any)
		.then((value) => {
			decided = true;
			return value;
		});
	await waiter.promise;
	assert.equal(decided, false);
	approvals.decide(approvals.list()[0].id, false);
	assert.equal(await pending, false);
});
test("disk recovery retains report and child path; active becomes interrupted, not restarted", () => {
	const directory = mkdtempSync(join(tmpdir(), "parallel-agent-test-"));
	try {
		const data = {
			status: "active",
			childFiles: ["/child.jsonl"],
			results: [{ output: "x".repeat(9000) }],
		};
		saveAgentRun(directory, "parallel-test", data);
		const recovered = loadAgentRun(directory, "parallel-test") as typeof data;
		assert.deepEqual(recovered, data);
		assert.equal(recoveredStatus(recovered.status), "interrupted");
		assert.equal(recoveredStatus("done"), "done");
	} finally {
		rmSync(directory, { recursive: true });
	}
});
test("inherit only latest coding/safety preference snapshot, never auth or transcript", () => {
	const entries = [
		{ type: "message", message: { content: "implement private transcript" } },
		{
			type: "custom",
			customType: "memories-snapshot",
			data: {
				global: {
					memories: [
						{ text: "Use tests and coding checks" },
						{ text: "Favorite food pizza" },
						{ text: "coding API key secret=abc" },
					],
				},
				project: { memories: [{ text: "Never auto approve sub-agents" }] },
			},
		},
	];
	assert.equal(
		codingPreferences(entries),
		"Use tests and coding checks\n\nFavorite food pizza\n\nNever auto approve sub-agents",
	);
});
