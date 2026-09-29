import type { PendingToolReview } from "../tool-review.ts";

export interface AgentApproval extends PendingToolReview {
	id: string;
	agent: string;
}

/** Holds escalated sub-agent calls until the parent decides or the child aborts. */
export class AgentApprovalQueue {
	private nextId = 1;
	private readonly pending = new Map<string, { review: AgentApproval; decide: (allowed: boolean) => void }>();
	private readonly listeners = new Set<() => void>();

	/** Requests approval and wakes any parent tool waiting for the first escalation. */
	request(agent: string, review: PendingToolReview): Promise<boolean> {
		if (review.signal?.aborted) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			const id = `approval-${this.nextId++}`;
			const pending: AgentApproval = { ...review, id, agent };
			const abort = () => this.decide(id, false);
			const decide = (allowed: boolean) => {
				review.signal?.removeEventListener("abort", abort);
				resolve(allowed);
			};
			this.pending.set(id, { review: pending, decide });
			review.signal?.addEventListener("abort", abort, { once: true });
			for (const listener of this.listeners) listener();
		});
	}

	/** Returns unresolved requests without exposing AbortSignals to the model. */
	list(): Array<Omit<AgentApproval, "signal">> {
		return [...this.pending.values()].map(({ review: { signal: _signal, ...review } }) => review);
	}

	/** Resolves exactly one still-pending request. */
	decide(id: string, allowed: boolean): AgentApproval | undefined {
		const entry = this.pending.get(id);
		if (!entry) return undefined;
		this.pending.delete(id);
		entry.decide(allowed);
		return entry.review;
	}

	/** Wakes once a request arrives; caller must also race task completion. */
	waitForRequest(): { promise: Promise<void>; cancel: () => void } {
		if (this.pending.size) return { promise: Promise.resolve(), cancel: () => {} };
		let listener: () => void;
		const promise = new Promise<void>((resolve) => {
			listener = () => { this.listeners.delete(listener); resolve(); };
			this.listeners.add(listener);
		});
		return { promise, cancel: () => this.listeners.delete(listener) };
	}

	/** Denies requests when a run is cancelled or shut down. */
	denyAll(): void {
		for (const id of this.pending.keys()) this.decide(id, false);
	}
}
