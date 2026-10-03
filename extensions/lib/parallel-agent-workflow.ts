import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SupervisionEvent = {
	runId: string;
	agent: string;
	type: string;
	detail: string;
};
/** One queue per extension runtime; inactive branches retain their own events. */
export class AgentSupervisionQueue {
	private pending = new Map<string, SupervisionEvent>();
	private scheduled = false;
	private current: () => Set<string>;
	private send: (events: SupervisionEvent[]) => void;
	constructor(
		current: () => Set<string>,
		send: (events: SupervisionEvent[]) => void,
	) {
		this.current = current;
		this.send = send;
	}
	enqueue(event: SupervisionEvent): void {
		this.pending.set(
			JSON.stringify([event.runId, event.agent, event.type, event.detail]),
			event,
		);
		this.wake();
	}
	wake(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			const owned = this.current();
			const events: SupervisionEvent[] = [];
			for (const [key, event] of this.pending)
				if (owned.has(event.runId)) {
					events.push(event);
					this.pending.delete(key);
					if (events.length === 12) break;
				}
			if (!events.length) return;
			try {
				this.send(events);
			} catch {
				for (const event of events)
					this.pending.set(JSON.stringify(event), event);
				return;
			}
			if ([...this.pending.values()].some((event) => owned.has(event.runId)))
				this.wake();
		});
	}
}
/** Atomic private run snapshots; no credentials or parent conversation are stored. */
export function saveAgentRun(
	directory: string,
	id: string,
	data: unknown,
): void {
	if (!/^parallel-[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid run ID");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const file = join(directory, `${id}.json`);
	const temp = `${file}.tmp`;
	writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
	renameSync(temp, file);
}
export function loadAgentRun(directory: string, id: string): unknown {
	if (!/^parallel-[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid run ID");
	return JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"));
}
/** Inherit trusted preference snapshots, never ordinary parent conversation messages. */
export function codingPreferences(entries: readonly unknown[]): string {
	const snapshots = entries.filter(
		(
			entry,
		): entry is {
			type: string;
			customType: string;
			data: {
				global?: { memories?: { text: string }[] };
				project?: { memories?: { text: string }[] };
			};
		} => {
			const value = entry as { type?: string; customType?: string } | undefined;
			return (
				value?.type === "custom" && value.customType === "memories-snapshot"
			);
		},
	);
	const snapshot = snapshots.at(-1)?.data;
	return [snapshot?.global, snapshot?.project]
		.flatMap((store) => store?.memories ?? [])
		.map((memory) => memory.text)
		.filter(
			(text) =>
				typeof text === "string" &&
				!/\b(?:api[_-]?key|access[_-]?token|password|secret|bearer)\s*[:=]\s*\S+/i.test(
					text,
				),
		)
		.join("\n\n");
}
export function recoveredStatus(status: string): string {
	return status === "active" ? "interrupted" : status;
}
