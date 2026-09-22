import assert from "node:assert/strict";
import test from "node:test";
import { AgentActivityLog } from "../parallel-agent-activity.ts";

test("compact tool rows suppress edit bodies and successful results", () => {
	const log = new AgentActivityLog();
	log.startTool("a", "edit-1", "edit", {
		path: "src/a.ts",
		oldText: "x".repeat(10_000),
		newText: "SECRET".repeat(10_000),
	});
	log.endTool("a", "edit-1", "edit", { content: "successful output should not be displayed".repeat(200) }, false);
	const page = log.read({ agents: ["a"], after: -1 });
	assert.match(page.text, /edit · ok/);
	assert.match(page.text, /edits=1/);
	assert.doesNotMatch(page.text, /SECRET/);
	assert.doesNotMatch(page.text, /successful output/);
	assert.equal(page.nextCursor, 1);
});

test("interleaved IDs retain identity and completion is visible after start cursor", () => {
	const log = new AgentActivityLog();
	log.startTool("one", "one-read", "read", { path: "one.txt" }); // 0
	log.startTool("two", "two-grep", "grep", { path: "two.txt", pattern: "needle" }); // 1
	const first = log.read({ agents: ["one", "two"], after: -1 });
	log.endTool("one", "one-read", "read", { text: "fine" }, false); // 2
	log.endTool("two", "two-grep", "grep", { error: "permission denied at two.txt" }, true); // 3
	const later = log.read({ agents: ["one", "two"], after: first.nextCursor });
	assert.match(later.text, /2\. one · read · ok .*details:2/);
	assert.match(later.text, /3\. two · grep · error: permission denied/);
	assert.match(log.readDetails(3).text, /permission denied/);
	assert.equal(later.nextCursor, 3);
});

test("event caps advance without skips and metadata is included", () => {
	const log = new AgentActivityLog();
	for (let index = 0; index < 25; index++) log.record("a", "turn", String(index));
	const first = log.read({ agents: ["a"], after: -1, limit: 100 });
	assert.equal(first.nextCursor, 19);
	assert.equal(first.hasMore, true);
	assert.match(first.text, /nextCursor: 19; hasMore: true/);
	const second = log.read({ agents: ["a"], after: first.nextCursor, limit: 100 });
	assert.equal(second.nextCursor, 24);
	assert.equal(second.hasMore, false);
	assert.match(second.text, /20\. a · turn · 20 · details:20/);
	assert.ok(first.text.length <= 4000 && second.text.length <= 4000);
});

test("details return full snapshots in honest bounded chunks", () => {
	const log = new AgentActivityLog();
	log.startTool("a", "write-1", "write", { path: "large.txt", content: "z".repeat(8_000) });
	log.endTool("a", "write-1", "write", { output: "done" }, false);
	const first = log.readDetails(0);
	assert.match(first.text, /args:/);
	assert.match(first.text, /hasMore: true; next detailRegion:/);
	assert.ok(first.text.length <= 4000);
	const later = log.readDetails(0, { start: 4000, end: 7999 });
	assert.match(later.text, /z/);
	assert.throws(() => log.readDetails(0, { start: 3, end: 2 }), RangeError);
	// Follow the returned offsets and reconstruct the retained snapshot without gaps.
	let offset = 0;
	let reconstructed = "";
	for (;;) {
		const page = log.readDetails(0, { start: offset, end: offset + 3999 }).text;
		const notice = page.lastIndexOf("\n[chars ");
		reconstructed += page.slice(0, notice);
		const next = page.match(/next detailRegion: \{start: (\d+)/);
		if (!next) break;
		offset = Number(next[1]);
	}
	assert.match(reconstructed, new RegExp("z".repeat(8_000)));
	assert.match(log.readDetails(1).text, /result:\n[\s\S]*done/);
});

test("same tool ID across agents stays separate and a large feed never skips budget-excluded events", () => {
	const log = new AgentActivityLog();
	log.startTool("a", "same-id", "read", { path: "a.txt" });
	log.startTool("b", "same-id", "read", { path: "b.txt" });
	log.endTool("b", "same-id", "read", { content: [{ type: "text", text: "access denied" }] }, true);
	log.endTool("a", "same-id", "read", {}, false);
	const page = log.read({ agents: ["a", "b"], after: -1 });
	assert.match(page.text, /2\. b · read · error: access denied · path="b.txt"/);
	assert.match(page.text, /3\. a · read · ok · path="a.txt"/);
	assert.match(log.readDetails(2).text, /b.txt/);
	assert.doesNotMatch(log.readDetails(2).text, /a.txt/);

	const large = new AgentActivityLog();
	for (let index = 0; index < 25; index++) large.record("a", "event", "x".repeat(2_000));
	let cursor = -1;
	const observed: number[] = [];
	for (;;) {
		const chunk = large.read({ agents: ["a"], readRegion: { start: cursor + 1, end: 24 } });
		assert.ok(chunk.text.length <= 4000);
		observed.push(...Array.from(chunk.text.matchAll(/^(\d+)\./gm), (match) => Number(match[1])));
		assert.ok(chunk.nextCursor > cursor);
		cursor = chunk.nextCursor;
		if (!chunk.hasMore) break;
	}
	assert.deepEqual(
		observed,
		Array.from({ length: 25 }, (_, index) => index),
	);
	assert.throws(() => large.read({ agents: ["a"], after: -1, readRegion: { start: 0, end: 1 } }), /only one/);
});
