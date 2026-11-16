/**
 * Offline tests for the snowball search: seed parsing, seed labels, and
 * one round on a stubbed OpenAlex (backward batches, forward per seed with
 * the cap and the citation sort, provenance merged per work, seeds never
 * listed as finds, directions, unknown seeds reported).
 * Run: node src/snowball.test.ts
 */

import assert from "node:assert/strict";
import { MAX_CITING_PER_SEED, runSnowball, seedDois, seedLabel, type SnowballDeps } from "./snowball.ts";

// Seed identifiers: DOI forms and arXiv ids; junk ignored.
assert.deepEqual(seedDois(["https://doi.org/10.3390/RS13081505", "doi: 10.1234/x", "2405.11494v2", "arXiv:2101.00001", "not an id"]), [
	{ seed: "https://doi.org/10.3390/RS13081505", doi: "10.3390/rs13081505", arxiv: "" },
	{ seed: "doi: 10.1234/x", doi: "10.1234/x", arxiv: "" },
	{ seed: "2405.11494v2", doi: "10.48550/arxiv.2405.11494", arxiv: "2405.11494" },
	{ seed: "arXiv:2101.00001", doi: "10.48550/arxiv.2101.00001", arxiv: "2101.00001" },
]);

// Labels: surname + year; without authors the title.
assert.equal(seedLabel({ publication_year: 2021, authorships: [{ author: { display_name: "Anna M. Kryniecka" } }] }), "Kryniecka 2021");
assert.equal(seedLabel({ title: "Untitled work", authorships: [] }), "Untitled work (n.d.)");

// A stub OpenAlex: two seeds (one by DOI, one by arXiv id via its
// location), a shared reference, a reference that is itself a seed.
const work = (id: string, extra: Record<string, unknown> = {}) => ({
	id: `https://openalex.org/${id}`, title: `Work ${id}`, publication_year: 2020,
	authorships: [{ author: { display_name: `Author ${id}` } }], abstract_inverted_index: { text: [0] }, ...extra,
});
const seedA = work("W1", { doi: "https://doi.org/10.1234/a", authorships: [{ author: { display_name: "Ann Lee" } }], publication_year: 2021, referenced_works: ["https://openalex.org/W10", "https://openalex.org/W11", "https://openalex.org/W2"] });
const seedB = work("W2", { doi: "https://doi.org/10.1234/b-journal", authorships: [{ author: { display_name: "Bo Kim" } }], publication_year: 2022, locations: [{ landing_page_url: "https://arxiv.org/abs/2201.00001" }], referenced_works: ["https://openalex.org/W11"] });
const calls: string[] = [];
const deps: SnowballDeps = {
	worksPage: async (filter, _select, perPage, _cursor, sort) => {
		calls.push(`${filter}|${perPage}|${sort ?? ""}`);
		if (filter.startsWith("doi:")) return { items: [seedA, seedB], next: null, count: 2 };
		if (filter.startsWith("ids.openalex:")) return { items: filter.slice(13).split("|").map((id) => work(id)), next: null, count: null };
		if (filter === "cites:W1") return { items: [work("W20"), work("W11"), work("W2")], next: null, count: 3 };
		if (filter === "cites:W2") return { items: [work("W20")], next: null, count: 1 };
		throw new Error(`unexpected ${filter}`);
	},
};

{
	const result = await runSnowball(["10.1234/a", "2201.00001", "10.1234/missing"], "both", { deps });
	assert.deepEqual(result.seeds, ["Lee 2021", "Kim 2022"]);
	assert.deepEqual(result.missing, ["10.1234/missing"]);
	assert.equal(calls[0], "doi:10.1234/a|10.48550/arxiv.2201.00001|10.1234/missing|50|");
	assert.equal(calls[1], "ids.openalex:W10|W11|50|");
	assert.deepEqual(calls.slice(2), [`cites:W1|${MAX_CITING_PER_SEED}|cited_by_count:desc`, `cites:W2|${MAX_CITING_PER_SEED}|cited_by_count:desc`]);
	assert.equal(result.requests, 4);
	const byId = Object.fromEntries(result.records.map((r) => [r.title, r]));
	// Seeds are never finds, even when one cites or references the other.
	assert.ok(!byId["Work W1"] && !byId["Work W2"]);
	assert.deepEqual(byId["Work W10"].snowball, ["references of: Lee 2021"]);
	assert.deepEqual(byId["Work W11"].snowball, ["references of: Lee 2021", "references of: Kim 2022", "cites: Lee 2021"]);
	assert.deepEqual(byId["Work W20"].snowball, ["cites: Lee 2021", "cites: Kim 2022"]);
	assert.ok(result.records.every((r) => r.source === "snowball"));
	assert.equal(result.backward, 2);
	assert.equal(result.forward, 2);
}

// Directions: back only asks no cites:, forward only no ids batch.
{
	calls.length = 0;
	const back = await runSnowball(["10.1234/a"], "back", { deps });
	assert.ok(!calls.some((c) => c.startsWith("cites:")));
	assert.equal(back.forward, 0);
	calls.length = 0;
	const forward = await runSnowball(["10.1234/a"], "forward", { deps });
	assert.ok(!calls.some((c) => c.startsWith("ids.openalex:")));
	// W2 is no seed in this run, so the work citing W1 counts as a find.
	assert.deepEqual(forward.records.map((r) => r.title).sort(), ["Work W11", "Work W2", "Work W20"]);
}

// Abort between requests.
{
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(runSnowball(["10.1234/a"], "both", { deps, signal: controller.signal }), /aborted/);
}

console.log("snowball.test.ts: all assertions passed");
