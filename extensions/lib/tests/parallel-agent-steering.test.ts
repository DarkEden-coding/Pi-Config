import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AgentSteeringController,
	MAX_STEERING_MESSAGE_CHARS,
	type SteeringSession,
} from "../parallel-agent-steering.ts";

class TestSession implements SteeringSession {
	isStreaming = true;
	messages: string[] = [];
	aborted = false;
	failure?: Error;

	async steer(text: string): Promise<void> {
		if (this.failure) throw this.failure;
		this.messages.push(text);
	}

	async abort(): Promise<void> {
		this.aborted = true;
		this.isStreaming = false;
	}
}

test("queues literal corrections and distinguishes acceptance, delivery, and undelivered messages", async () => {
	const session = new TestSession();
	const events: Array<{ type: string; text: string }> = [];
	const controller = new AgentSteeringController(session, (type, text) => events.push({ type, text }));
	const first = await controller.steer("/do-not-expand Keep the API");
	const second = await controller.steer("/do-not-expand Keep the API");
	assert.notEqual(first, second);
	assert.match(session.messages[0], /^\[Parent correction correction-1\]\n\/do-not-expand/);
	assert.equal(controller.pendingCount, 2);
	assert.deepEqual(
		events.map((event) => event.type),
		["steering_queued", "steering_queued"],
	);

	controller.observeUserMessage("unrelated task prompt");
	assert.equal(controller.pendingCount, 2);
	controller.observeUserMessage(session.messages[0]);
	assert.equal(controller.pendingCount, 1);
	assert.deepEqual(events.at(-1), { type: "steering_delivered", text: first });
	controller.finish();
	assert.equal(controller.pendingCount, 0);
	assert.match(events.at(-1)!.text, new RegExp(second));
	assert.equal(events.at(-1)!.type, "steering_undelivered");
	controller.finish();
	assert.equal(events.length, 4);
	await assert.rejects(controller.steer("more"), /no longer accepting/);
});

test("rejects startup, invalid messages, and queue overflow without adding another queue", async () => {
	const session = new TestSession();
	const controller = new AgentSteeringController(session, () => {});
	session.isStreaming = false;
	await assert.rejects(controller.steer("correction"), /starting or finishing/);
	assert.equal(controller.pendingCount, 0);
	session.isStreaming = true;
	await assert.rejects(controller.steer(" \n "), /Correction must contain/);
	await assert.rejects(controller.steer("x".repeat(MAX_STEERING_MESSAGE_CHARS + 1)), /Correction must contain/);
	for (let index = 0; index < 8; index++) await controller.steer(`correction ${index}`);
	await assert.rejects(controller.steer("overflow"), /already has 8/);
	assert.equal(session.messages.length, 8);
	controller.observeUserMessage(session.messages[0]);
	await controller.steer("room for one more");
	assert.equal(controller.pendingCount, 8);
});

test("failed delivery and cancellation cannot leave corrections reported as pending", async () => {
	const session = new TestSession();
	const events: string[] = [];
	const controller = new AgentSteeringController(session, (type) => events.push(type));
	session.failure = new Error("queue unavailable");
	await assert.rejects(controller.steer("correction"), /queue unavailable/);
	assert.equal(controller.pendingCount, 0);
	assert.equal(events.at(-1), "steering_failed");
	session.failure = undefined;
	await controller.steer("queued correction");
	await controller.abort();
	assert.equal(session.aborted, true);
	assert.equal(controller.pendingCount, 0);
	assert.equal(events.at(-1), "steering_undelivered");
	await assert.rejects(controller.steer("after cancellation"), /no longer accepting/);
});
