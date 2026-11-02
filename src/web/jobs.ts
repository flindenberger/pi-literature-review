/**
 * Job runner of the web interface: several jobs at once (searches,
 * reports and chat rounds of different conversations run side by side,
 * at most MAX_RUNNING), while kinds that write the same files or change
 * the setup (download, index, setup check, embedding pull) run alone of
 * their kind. Each job has its own abort switch; progress lines sit in a
 * ring buffer so a browser that connects later still sees them, and
 * subscribers (the SSE connections) receive every line and every state
 * change. Pure in-memory state; the server routes are the only callers.
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
/** Jobs running at the same time. */
export const MAX_RUNNING = 3;
/** Kinds that never run twice at once (same output files or the setup). */
const SINGLE_KINDS: ReadonlySet<JobKind> = new Set(["selection", "index", "pull", "check"]);

export class JobBusyError extends Error {
	readonly running: JobInfo;
	constructor(running: JobInfo) {
		super(SINGLE_KINDS.has(running.kind) ? `a job of this kind is already running: ${running.label}` : `${MAX_RUNNING} jobs are already running -- wait for one or stop it`);
		this.name = "JobBusyError";
		this.running = running;
	}
}

export class JobRunner {
	private readonly running = new Map<string, { info: JobInfo; controller: AbortController }>();
	private readonly history: JobInfo[] = [];
	private readonly lines: LineEvent[] = [];
	private readonly listeners = new Set<(event: RunnerEvent) => void>();
	private counter = 0;
	private readonly now: () => Date;

	constructor(now: () => Date = () => new Date()) {
		this.now = now;
	}

	/** Start the work; throws JobBusyError when a job of a single kind is
	 * already running or MAX_RUNNING jobs run. The returned info is a
	 * snapshot; subscribe for the outcome. */
	start(kind: JobKind, label: string, work: (ctx: JobContext) => Promise<unknown>): JobInfo {
		const all = [...this.running.values()].map((entry) => entry.info);
		const same = SINGLE_KINDS.has(kind) ? all.find((info) => info.kind === kind) : undefined;
		if (same) throw new JobBusyError({ ...same });
		if (all.length >= MAX_RUNNING) throw new JobBusyError({ ...all[all.length - 1] });
		const controller = new AbortController();
		const info: JobInfo = {
			id: `${kind}-${++this.counter}`,
			kind,
			label,
			state: "running",
			started: this.now().toISOString(),
		};
		this.running.set(info.id, { info, controller });
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

	/** Abort one running job by id, or every running job without an id. */
	cancel(id?: string): boolean {
		const targets = id ? [this.running.get(id)].filter((entry) => entry !== undefined) : [...this.running.values()];
		for (const entry of targets) {
			this.pushLine(entry.info.id, "cancel requested");
			entry.controller.abort();
		}
		return targets.length > 0;
	}

	isRunning(id: string): boolean {
		return this.running.has(id);
	}

	subscribe(listener: (event: RunnerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** `current` is the newest running job (null when none runs); `running` lists them all. */
	snapshot(): { current: JobInfo | null; running: JobInfo[]; history: JobInfo[]; lines: LineEvent[] } {
		const running = [...this.running.values()].map((entry) => ({ ...entry.info }));
		return {
			current: running.length ? running[running.length - 1] : null,
			running,
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
		this.running.delete(info.id);
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
