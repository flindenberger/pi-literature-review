/**
 * Offline tests for library matching and the embedding index: twin-first
 * resolution, filename recomputation (human-readable and legacy slug),
 * honest unmatched handling, and the cache-invalidation matrix of
 * ensureIndexed with fake IO deps. No filesystem, no network, no models.
 */

import assert from "node:assert/strict";
import {
	type CorpusDeps,
	ensureIndexed,
	entryFromTwin,
	filenameIndex,
	INDEX_SCHEMA,
	type LibraryPaper,
	matchLibraryCore,
	type PaperIndex,
	resolvePapersDir,
} from "./corpus.ts";
import type { SidecarEntry } from "./fetch.ts";

const vistula: SidecarEntry = {
	title: "Vistula", pdf_url: "", doi: "10.3390/rs13081505", arxiv_id: "",
	authors: ["Anna Kryniecka"], year: "2021",
};
const amazon: SidecarEntry = {
	title: "Amazon drought", pdf_url: "", doi: "", arxiv_id: "2401.16393",
	authors: [], year: null,
};

/* ---------------- entryFromTwin ---------------- */
{
	const hit = entryFromTwin({ title: "T", doi: "10.1/A", arxiv_id: "", authors: ["A B"], year: "2020" });
	assert.ok(hit);
	assert.equal(hit.key, "doi:10.1/a"); // identityKey casing
	assert.equal(hit.entry.title, "T");
	// No citable identity -> null (filename recomputation decides).
	assert.equal(entryFromTwin({ title: "T", doi: "", arxiv_id: "" }), null);
	assert.equal(entryFromTwin(null), null);
	assert.equal(entryFromTwin("junk"), null);
	// Junk field types are dropped, not trusted.
	const messy = entryFromTwin({ doi: "10.1/x", authors: ["ok", 5, null], year: 2021 });
	assert.ok(messy);
	assert.deepEqual(messy.entry.authors, ["ok"]);
	assert.equal(messy.entry.year, null);
}

/* ---------------- filenameIndex ---------------- */
{
	const names = filenameIndex(new Map([["doi:10.3390/rs13081505", vistula], ["arxiv:2401.16393", amazon]]));
	assert.ok(names.has("2021_Kryniecka_Vistula")); // human-readable
	assert.ok(names.has("10.3390_rs13081505")); // legacy DOI slug
	assert.ok(names.has("arxiv_2401.16393")); // legacy arXiv slug (no year/author -> only slug)
	assert.equal(names.get("arxiv_2401.16393")?.key, "arxiv:2401.16393");

	// Version-tolerance: a record saying "...v1" still matches the
	// versionless filename the fetch produced (live finding, 2026-07-15).
	const versioned = filenameIndex(new Map([["arxiv:2401.16393", { ...amazon, arxiv_id: "2401.16393v1" }]]));
	assert.ok(versioned.has("arxiv_2401.16393v1"));
	assert.ok(versioned.has("arxiv_2401.16393"));
	assert.equal(versioned.get("arxiv_2401.16393")?.key, "arxiv:2401.16393");
}

/* ---------------- resolvePapersDir ---------------- */
{
	const sep = (p: string) => p.replaceAll("\\", "/"); // join() uses the OS separator
	const chain = (dirsWithPdfs: string[]) =>
		sep(resolvePapersDir("/root", "/cwd", (dir) => dirsWithPdfs.includes(sep(dir))));
	// Canonical library first.
	assert.equal(chain(["/root/papers", "/cwd/papers", "/cwd"]), "/root/papers");
	// Then a papers/ folder next to where pi runs.
	assert.equal(chain(["/cwd/papers", "/cwd"]), "/cwd/papers");
	// Then loose PDFs right in the working directory.
	assert.equal(chain(["/cwd"]), "/cwd");
	// Nothing anywhere: report the canonical location (where fetch would fill).
	assert.equal(chain([]), "/root/papers");
}

/* ---------------- matchLibraryCore ---------------- */
{
	const index = new Map([["doi:10.3390/rs13081505", vistula], ["arxiv:2401.16393", amazon]]);
	const twins = new Map<string, unknown>([
		// Twin wins even when the filename would also match nothing.
		["oddly_named_file", { title: "Twin Title", doi: "10.9999/twin", arxiv_id: "" }],
		// Twin without identity falls through to filename recomputation.
		["2021_Kryniecka_Vistula", { title: "identity-less twin", doi: "", arxiv_id: "" }],
	]);
	const { matched, unmatched } = matchLibraryCore(
		["oddly_named_file", "2021_Kryniecka_Vistula", "arxiv_2401.16393", "alien_scan"],
		twins,
		index,
		"/papers",
	);
	assert.deepEqual(unmatched, ["alien_scan.pdf"]);
	assert.equal(matched.length, 3);
	const byBase = new Map(matched.map((p) => [p.base, p]));
	assert.equal(byBase.get("oddly_named_file")?.key, "doi:10.9999/twin");
	assert.equal(byBase.get("oddly_named_file")?.entry.title, "Twin Title");
	assert.equal(byBase.get("2021_Kryniecka_Vistula")?.key, "doi:10.3390/rs13081505");
	assert.equal(byBase.get("2021_Kryniecka_Vistula")?.entry.title, "Vistula"); // from the saved search
	assert.equal(byBase.get("arxiv_2401.16393")?.key, "arxiv:2401.16393");
	assert.equal(byBase.get("oddly_named_file")?.file, "/papers/oddly_named_file.pdf");
}

/* ---------------- ensureIndexed ---------------- */

const paper: LibraryPaper = { file: "/papers/p.pdf", base: "p", key: "doi:10.1/x", entry: {
	title: "P", pdf_url: "", doi: "10.1/x", arxiv_id: "", authors: ["A B"], year: "2020",
} };
const richPage = "The river sandbar was observed in the Sentinel-2 scene. ".repeat(20);

function makeDeps(overrides: Partial<CorpusDeps> = {}): {
	deps: CorpusDeps; calls: { extract: number; embed: number }; saved: Map<string, PaperIndex>;
} {
	const calls = { extract: 0, embed: 0 };
	const saved = new Map<string, PaperIndex>();
	const deps: CorpusDeps = {
		readPdf: () => new TextEncoder().encode("%PDF-fake"),
		sha256: () => "hash-1",
		extract: async () => {
			calls.extract++;
			return [richPage, richPage];
		},
		embed: async (texts) => {
			calls.embed++;
			return texts.map((_, i) => [i, 1]);
		},
		loadIndex: (file) => saved.get(file) ?? null,
		saveIndex: (file, index) => saved.set(file, index),
		...overrides,
	};
	return { deps, calls, saved };
}

// Fresh paper: extracted, embedded, saved; metadata copied verbatim.
{
	const { deps, calls, saved } = makeDeps();
	const progress: string[] = [];
	const { indexes, failures } = await ensureIndexed([paper], "/index", "emb-model", deps, {
		onProgress: (m) => progress.push(m),
	});
	assert.equal(failures.length, 0);
	assert.equal(indexes.length, 1);
	assert.equal(calls.extract, 1);
	assert.equal(calls.embed, 1);
	assert.ok(saved.has("/index/p.json"));
	const index = indexes[0];
	assert.equal(index.schema, INDEX_SCHEMA);
	assert.equal(index.embedding_model, "emb-model");
	assert.equal(index.paper.key, "doi:10.1/x");
	assert.equal(index.paper.title, "P");
	assert.ok(index.chunks.length >= 1);
	assert.deepEqual(index.chunks[0].embedding, [0, 1]);
	assert.equal(index.chunks[0].id, 0);
	assert.ok(progress.some((m) => m.includes("embedding")));
}

// Cache matrix: unchanged -> cached; hash/model change or force -> rebuild.
{
	const { deps, calls } = makeDeps();
	await ensureIndexed([paper], "/index", "emb-model", deps);
	assert.deepEqual(calls, { extract: 1, embed: 1 });

	const again = await ensureIndexed([paper], "/index", "emb-model", deps);
	assert.deepEqual(calls, { extract: 1, embed: 1 }); // untouched: cached
	assert.equal(again.indexes.length, 1);

	await ensureIndexed([paper], "/index", "other-model", deps);
	assert.deepEqual(calls, { extract: 2, embed: 2 }); // embedding model changed

	deps.sha256 = () => "hash-2";
	await ensureIndexed([paper], "/index", "other-model", deps);
	assert.deepEqual(calls, { extract: 3, embed: 3 }); // content changed

	await ensureIndexed([paper], "/index", "other-model", deps, { force: true });
	assert.deepEqual(calls, { extract: 4, embed: 4 }); // forced reindex
}

// Honest failures: scanned PDF and a throwing extractor are reported and
// skipped; the run continues and never saves a broken index.
{
	const { deps, saved } = makeDeps({ extract: async () => ["", ""] });
	const { indexes, failures } = await ensureIndexed([paper], "/index", "m", deps);
	assert.equal(indexes.length, 0);
	assert.equal(saved.size, 0);
	assert.deepEqual(failures, [{ file: "p.pdf", reason: "no extractable text (likely scanned)" }]);
}
{
	const broken: LibraryPaper = { ...paper, base: "broken" };
	const { deps } = makeDeps({
		extract: async (bytes) => {
			if (bytes.length > 0 && new TextDecoder().decode(bytes).includes("fake")) {
				throw new Error("bad xref");
			}
			return [richPage];
		},
	});
	const { indexes, failures } = await ensureIndexed([broken], "/index", "m", deps);
	assert.equal(indexes.length, 0);
	assert.equal(failures.length, 1);
	assert.ok(failures[0].reason.includes("bad xref"));
}

// A user abort throws instead of returning a partial result.
{
	const { deps } = makeDeps();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => ensureIndexed([paper], "/index", "m", deps, { signal: controller.signal }),
		/aborted/,
	);
}

console.log("corpus.test.ts: all assertions passed");
