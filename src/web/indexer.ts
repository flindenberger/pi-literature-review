/**
 * Background indexing of the library for the web interface: every PDF
 * without an index gets one, one after the other, so a later question
 * over many PDFs only reads indexes. A pass starts on kick() (server
 * start, a folder added, an upload or a download); a kick during a pass
 * runs one more pass afterwards. Between two PDFs the pass waits while
 * busy() says a chat or report runs (they share the embedding server).
 * PDFs that failed (no text) are remembered by path and size and not
 * retried until the file changes. Not a job of the job runner: it takes
 * no place among the parallel jobs and has no Stop button.
 */

import type { LibraryPaper } from "../corpus.ts";

export interface IndexStatus {
	/** A pass is running. */
	running: boolean;
	/** PDFs of the pool with an index (or given up on). */
	done: number;
	/** PDFs in the pool. */
	total: number;
	/** Base name of the PDF being indexed, null between PDFs. */
	current: string | null;
	/** PDFs whose indexing failed (no text, unreadable). */
	failed: number;
	/** Why the last pass stopped early (embedding server down ...), else null. */
	error: string | null;
}

export interface IndexerDeps {
	/** Embedding server ready; throws with a readable reason otherwise. */
	ready(signal: AbortSignal): Promise<void>;
	/** The papers a chat can use (metadata lookups for new PDFs included). */
	pool(signal: AbortSignal): Promise<LibraryPaper[]>;
	/** True when the paper has a current index. */
	isIndexed(paper: LibraryPaper): boolean;
	/** Index one paper; resolves with the failure reason or null. */
	indexOne(paper: LibraryPaper, signal: AbortSignal): Promise<string | null>;
	/** A chat, report or index job runs: wait before the next PDF. */
	busy(): boolean;
	/** Identity of a file for the failure memory (path + size + mtime). */
	fileStamp(path: string): string;
	/** Waiting step while busy (injectable for tests). */
	sleep(ms: number): Promise<void>;
}

const BUSY_POLL_MS = 2_000;

export class Indexer {
	private status: IndexStatus = { running: false, done: 0, total: 0, current: null, failed: 0, error: null };
	private again = false;
	private controller: AbortController | null = null;
	private readonly failed = new Map<string, string>();
	private readonly listeners = new Set<(status: IndexStatus) => void>();
	private pass: Promise<void> | null = null;

	private readonly deps: IndexerDeps;

	constructor(deps: IndexerDeps) {
		this.deps = deps;
	}

	snapshot(): IndexStatus {
		return { ...this.status };
	}

	subscribe(listener: (status: IndexStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Start a pass, or queue one more after the running pass. */
	kick(): void {
		if (this.pass) {
			this.again = true;
			return;
		}
		this.pass = this.loop().finally(() => {
			this.pass = null;
		});
	}

	/** The running pass as a promise (tests, shutdown). */
	idle(): Promise<void> {
		return this.pass ?? Promise.resolve();
	}

	/** Stop the running pass (server shutdown). */
	stop(): void {
		this.again = false;
		this.controller?.abort();
	}

	private update(patch: Partial<IndexStatus>): void {
		this.status = { ...this.status, ...patch };
		const view = this.snapshot();
		for (const listener of this.listeners) listener(view);
	}

	private async loop(): Promise<void> {
		do {
			this.again = false;
			await this.runPass();
		} while (this.again);
	}

	private async runPass(): Promise<void> {
		const controller = new AbortController();
		this.controller = controller;
		const { signal } = controller;
		this.update({ running: true, current: null, error: null });
		try {
			await this.deps.ready(signal);
			const pool = await this.deps.pool(signal);
			const given = (paper: LibraryPaper): boolean => this.failed.get(paper.file) === this.deps.fileStamp(paper.file);
			const todo = pool.filter((paper) => !this.deps.isIndexed(paper) && !given(paper));
			const failedCount = (): number => pool.filter(given).length;
			this.update({ total: pool.length, done: pool.length - todo.length, failed: failedCount() });
			for (const paper of todo) {
				while (this.deps.busy()) {
					if (signal.aborted) return;
					await this.deps.sleep(BUSY_POLL_MS);
				}
				if (signal.aborted) return;
				// A chat may have indexed it meanwhile.
				if (!this.deps.isIndexed(paper)) {
					this.update({ current: paper.base });
					const reason = await this.deps.indexOne(paper, signal);
					if (reason) this.failed.set(paper.file, this.deps.fileStamp(paper.file));
				}
				this.update({ current: null, done: this.status.done + 1, failed: failedCount() });
			}
		} catch (error) {
			if (!signal.aborted) this.update({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (this.controller === controller) this.controller = null;
			this.update({ running: false, current: null });
		}
	}
}
