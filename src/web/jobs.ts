/**
 * Job runner of the web interface: ONE job at a time (the stages are long
 * and share the model), each with its own abort switch, progress lines
 * in a ring buffer so a browser that connects later still sees them, and
 * subscribers (the SSE connections) that receive every line and every
 * state change. Pure in-memory state; the server routes are the only
 * callers.
 */

export type JobKind = "search" | "selection" | "index" | "report" | "chat" | "chat-report" | "pull" | "check";
export type JobState = "running" | "done" | "failed" | "cancelled";

export interface JobInfo {
	id: string;
	kind: JobKind;
	label: string;
	state: JobState;
	/** ISO timestamps. */
	started: string;
	finished?: string;
	error?: string;
	/** Whatever the work returned (route-specific, JSON-serialisable). */
	result?: unknown;
}

export interface LineEvent {
	type: "line";
	job: string;
	time: string;
	text: string;
}

export interface JobEvent {
	type: "job";
	job: JobInfo;
}

export type RunnerEvent = LineEvent | JobEvent;

export interface JobContext {
	signal: AbortSignal;
	log(text: string): void;
}

/** Lines kept for late subscribers. */
export const LINE_BUFFER = 500;
/** Finished jobs kept in the history list. */
const HISTORY_LIMIT = 20;

export class JobBusyError extends Error {
	readonly running: JobInfo;
	constructor(running: JobInfo) {
		super(`a job is already running: ${running.label}`);
		this.name = "JobBusyError";
		this.running = running;
	}
}

export class JobRunner {
	private current: { info: JobInfo; controller: AbortController } | null = null;
	private readonly history: JobInfo[] = [];
	private readonly lines: LineEvent[] = [];
	private readonly listeners = new Set<(event: RunnerEvent) => void>();
	private counter = 0;
	private readonly now: () => Date;

	constructor(now: () => Date = () => new Date()) {
		this.now = now;
	}

	/** Start the work; throws JobBusyError while another job runs. The
	 * returned info is a snapshot; subscribe for the outcome. */
	start(kind: JobKind, label: string, work: (ctx: JobContext) => Promise<unknown>): JobInfo {
		if (this.current) throw new JobBusyError({ ...this.current.info });
		const controller = new AbortController();
		const info: JobInfo = {
			id: `${kind}-${++this.counter}`,
			kind,
			label,
			state: "running",
			started: this.now().toISOString(),
		};
		this.current = { info, controller };
		this.emit({ type: "job", job: { ...info } });
		const log = (text: string) => this.pushLine(info.id, text);
		work({ signal: controller.signal, log }).then(
			(result) => this.finish(info, controller.signal.aborted ? "cancelled" : "done", undefined, result),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.finish(info, controller.signal.aborted ? "cancelled" : "failed", message);
			},
		);
		return { ...info };
	}

	/** Abort the running job (by id, or whatever runs). */
	cancel(id?: string): boolean {
		if (!this.current) return false;
		if (id && this.current.info.id !== id) return false;
		this.pushLine(this.current.info.id, "cancel requested");
		this.current.controller.abort();
		return true;
	}

	subscribe(listener: (event: RunnerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshot(): { current: JobInfo | null; history: JobInfo[]; lines: LineEvent[] } {
		return {
			current: this.current ? { ...this.current.info } : null,
			history: this.history.map((job) => ({ ...job })),
			lines: [...this.lines],
		};
	}

	/** The last finished job of a kind (its result feeds a reloaded page). */
	last(kind: JobKind): JobInfo | null {
		for (let i = this.history.length - 1; i >= 0; i--) {
			if (this.history[i].kind === kind) return { ...this.history[i] };
		}
		return null;
	}

	private finish(info: JobInfo, state: JobState, error?: string, result?: unknown): void {
		info.state = state;
		info.finished = this.now().toISOString();
		if (error !== undefined) info.error = error;
		if (result !== undefined) info.result = result;
		this.current = null;
		this.history.push(info);
		if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
		this.pushLine(info.id, state === "done" ? `${info.label}: done` : `${info.label}: ${state}${error ? ` -- ${error}` : ""}`);
		this.emit({ type: "job", job: { ...info } });
	}

	private pushLine(job: string, text: string): void {
		const line: LineEvent = { type: "line", job, time: this.now().toISOString(), text };
		this.lines.push(line);
		if (this.lines.length > LINE_BUFFER) this.lines.splice(0, this.lines.length - LINE_BUFFER);
		this.emit(line);
	}

	private emit(event: RunnerEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// a broken subscriber never breaks the job
			}
		}
	}
}
