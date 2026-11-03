// Background indexer: offline, with fake papers and a fake index step.
import assert from "node:assert/strict";
import type { LibraryPaper } from "../corpus.ts";
import { Indexer, type IndexerDeps, type IndexStatus } from "./indexer.ts";

const paper = (base: string): LibraryPaper => ({ file: `/lib/${base}.pdf`, base, key: `file:${base}` } as unknown as LibraryPaper);

function setup(bases: string[], options: { indexed?: string[]; fail?: string[]; busyTicks?: number; readyError?: string } = {}) {
	const indexed = new Set(options.indexed ?? []);
	const calls: string[] = [];
	let busyTicks = options.busyTicks ?? 0;
	let sleeps = 0;
	let pools = 0;
	const deps: IndexerDeps = {
		ready: async () => { if (options.readyError) throw new Error(options.readyError); },
		pool: async () => { pools++; return bases.map(paper); },
		isIndexed: (p) => indexed.has(p.base),
		indexOne: async (p) => {
			calls.push(p.base);
			if (options.fail?.includes(p.base)) return "no text";
			indexed.add(p.base);
			return null;
		},
		busy: () => busyTicks-- > 0,
		fileStamp: (path) => `${path}:1`,
		sleep: async () => { sleeps++; },
	};
	const indexer = new Indexer(deps);
	const seen: IndexStatus[] = [];
	indexer.subscribe((status) => seen.push(status));
	return { indexer, calls, seen, indexed, counts: () => ({ sleeps, pools }) };
}

// Indexes only the papers without an index, in order, and reports progress.
{
	const { indexer, calls, seen } = setup(["a", "b", "c"], { indexed: ["b"] });
	indexer.kick();
	await indexer.idle();
	assert.deepEqual(calls, ["a", "c"]);
	const last = indexer.snapshot();
	assert.equal(last.running, false);
	assert.equal(last.done, 3);
	assert.equal(last.total, 3);
	assert.equal(last.failed, 0);
	assert.ok(seen.some((status) => status.current === "a"));
	assert.ok(seen.some((status) => status.running && status.done === 1 && status.total === 3));
}

// Failed papers are counted and not retried by the next pass.
{
	const { indexer, calls } = setup(["a", "b"], { fail: ["a"] });
	indexer.kick();
	await indexer.idle();
	assert.equal(indexer.snapshot().failed, 1);
	indexer.kick();
	await indexer.idle();
	assert.deepEqual(calls, ["a", "b"]);
	assert.equal(indexer.snapshot().done, 2);
}

// Waits while a chat runs, then continues.
{
	const { indexer, calls, counts } = setup(["a"], { busyTicks: 3 });
	indexer.kick();
	await indexer.idle();
	assert.deepEqual(calls, ["a"]);
	assert.equal(counts().sleeps, 3);
}

// A kick during a pass runs exactly one more pass.
{
	const { indexer, counts } = setup(["a"]);
	indexer.kick();
	indexer.kick();
	indexer.kick();
	await indexer.idle();
	assert.equal(counts().pools, 2);
}

// The embedding server down: the pass stops with the reason, nothing indexed.
{
	const { indexer, calls } = setup(["a"], { readyError: "embedding server unreachable" });
	indexer.kick();
	await indexer.idle();
	assert.deepEqual(calls, []);
	assert.equal(indexer.snapshot().error, "embedding server unreachable");
	assert.equal(indexer.snapshot().running, false);
}

console.log("indexer tests ok");
