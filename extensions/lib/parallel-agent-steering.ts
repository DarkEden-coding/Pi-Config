/** The native Pi session operations used to deliver parent corrections. */
export interface SteeringSession {
	readonly isStreaming: boolean;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
}

export const MAX_STEERING_MESSAGE_CHARS = 8_000;
const MAX_PENDING_MESSAGES = 8;

type PendingCorrection = { id: string };
type RecordCorrection = (type: string, text: string) => void;

/** Tracks delivery receipts around Pi's own queue, without creating a second queue. */
export class AgentSteeringController {
	private readonly session: SteeringSession;
	private readonly record: RecordCorrection;
	private readonly pending = new Map<string, PendingCorrection>();
	private nextMessageId = 1;
	private closed = false;

	/** Binds one controller to one native sub-agent session. */
	constructor(session: SteeringSession, record: RecordCorrection) {
		this.session = session;
		this.record = record;
	}

	/** Reports corrections accepted but not yet observed in the session. */
	get pendingCount(): number {
		return this.pending.size;
	}

	/** Checks readiness before a multi-target operation starts sending messages. */
	assertCanSteer(message: string): void {
		if (!message.trim() || message.length > MAX_STEERING_MESSAGE_CHARS) {
			throw new Error(`Correction must contain 1-${MAX_STEERING_MESSAGE_CHARS} characters.`);
		}
		if (this.closed) throw new Error("Sub-agent is no longer accepting corrections.");
		if (!this.session.isStreaming) {
			throw new Error(
				"Sub-agent is starting or finishing, not accepting corrections. Check status and retry while running.",
			);
		}
		if (this.pending.size >= MAX_PENDING_MESSAGES) {
			throw new Error(
				`Sub-agent already has ${MAX_PENDING_MESSAGES} queued corrections. Wait for delivery before sending more.`,
			);
		}
	}

	/** Queues a literal correction; acceptance is not a promise that the model will obey it. */
	async steer(message: string): Promise<string> {
		this.assertCanSteer(message);
		const id = `correction-${this.nextMessageId++}`;
		// Prefix prevents slash-command/template expansion and distinguishes identical messages.
		const text = `[Parent correction ${id}]\n${message}`;
		this.pending.set(text, { id });
		this.record("steering_queued", `${id}: ${message}`);
		try {
			await this.session.steer(text);
		} catch (error) {
			this.pending.delete(text);
			this.record("steering_failed", `${id}: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
		return id;
	}

	/** Records delivery only when Pi emits the corresponding user message. */
	observeUserMessage(text: string): void {
		const correction = this.pending.get(text);
		if (!correction) return;
		this.pending.delete(text);
		this.record("steering_delivered", correction.id);
	}

	/** Closes the controller and reports corrections that never reached the session. */
	finish(): void {
		this.closed = true;
		for (const correction of this.pending.values()) {
			this.record("steering_undelivered", `${correction.id}: sub-agent stopped before delivery`);
		}
		this.pending.clear();
	}

	/** Stops execution separately from queued steering and prevents further messages. */
	async abort(): Promise<void> {
		this.closed = true;
		try {
			await this.session.abort();
		} finally {
			// Let Pi drain in-flight message events before declaring them undelivered.
			this.finish();
		}
	}
}
