/**
 * Logic tests for the pure enrichment functions (no network). The records
 * and API objects below are synthetic fixtures -- never shown as papers.
 *
 * Run: node src/enrich.test.ts
 */

import assert from "node:assert/strict";
import { addCodeLinks, applyEnrichment, applyJournalScores, bareArxivId, codeLookupCandidates, codeUrlFromAbstract, enrichAll, lookupDoi, pickCodeRepo } from "./enrich.ts";

const base = {
	title: "A Title",
	doi: "",
	arxiv_id: "",
	cites: null as number | null,
	venue: "",
	venue_id: undefined as string | undefined,
};

// enrichAll: an abstract still missing after the OpenAlex
// lookup is asked from Semantic Scholar by DOI (injected here; stubbed
// OpenAlex fetch delivers cites+venue but no abstract); provenance
// "semanticscholar"; a record whose OpenAlex answer carries the abstract
// never asks S2; arXiv-only records (no own DOI) never ask S2 either;
// a failing S2 lookup keeps the record, loudly.
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		const u = String(url);
		if (u.includes("/doi:10.1/withabs")) {
			return new Response(JSON.stringify({ cited_by_count: 3, abstract_inverted_index: { Own: [0], text: [1] } }), { status: 200 });
		}
		return new Response(JSON.stringify({ cited_by_count: 5, primary_location: { source: { display_name: "V" } } }), { status: 200 });
	}) as typeof fetch;
	try {
		const asked: string[] = [];
		const lookup = async (doi: string) => {
			asked.push(doi);
			if (doi === "10.1/fail") throw new Error("boom");
			return doi === "10.1/s2" ? "From S2." : null;
		};
		const warnings: string[] = [];
		const out = await enrichAll([
			{ title: "S2", doi: "10.1/s2", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "None", doi: "10.1/none", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "OA", doi: "10.1/withabs", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "Arx", doi: "", arxiv_id: "2401.00001", cites: null, venue: "", abstract: "" },
			{ title: "Fail", doi: "10.1/fail", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "After", doi: "10.1/after", arxiv_id: "", cites: null, venue: "", abstract: "" },
		], (m) => warnings.push(m), lookup);
		// the failure trips the breaker: "After" is not asked any more
		assert.deepEqual(asked, ["10.1/s2", "10.1/none", "10.1/fail"]);
		assert.equal(out[5].abstract, "");
		assert.equal(out[5].cites, 5);
		assert.equal(out[0].abstract, "From S2.");
		assert.equal(out[0].enriched?.abstract, "semanticscholar");
		assert.equal(out[0].enriched?.cites, "openalex");
		assert.equal(out[1].abstract, "");
		assert.equal(out[2].abstract, "Own text");
		assert.equal(out[2].enriched?.abstract, "openalex");
		assert.equal(out[4].abstract, "");
		assert.equal(out[4].cites, 5);
		assert.ok(warnings.some((m) => m.includes("abstract lookup at Semantic Scholar for \"Fail\" failed: boom") && m.includes("skipped this run")));
		assert.ok(warnings.some((m) => m.includes("abstract lookups at Semantic Scholar: 3, 1 abstract(s) filled")));
	} finally {
		globalThis.fetch = realFetch;
	}
}

// lookupDoi: own DOI wins; arXiv falls back to its DataCite DOI, version dropped
{
	assert.equal(lookupDoi({ ...base, doi: "10.1234/abc" }), "10.1234/abc");
	assert.equal(lookupDoi({ ...base, arxiv_id: "2311.10579v2" }), "10.48550/arxiv.2311.10579");
	assert.equal(lookupDoi({ ...base, arxiv_id: "physics/0604089" }), "10.48550/arxiv.physics/0604089");
	assert.equal(lookupDoi(base), null); // no identifier -> no lookup, never by title
}

// applyEnrichment: fills only gaps, marks provenance per field
{
	const work = { cited_by_count: 42, primary_location: { source: { display_name: " Remote Sensing " } } };
	const { record, filled } = applyEnrichment({ ...base, doi: "10.1/x" }, work);
	assert.equal(record.cites, 42);
	assert.equal(record.venue, "Remote Sensing"); // trimmed
	assert.deepEqual(filled.sort(), ["cites", "venue"]);
	assert.deepEqual(record.enriched, { cites: "openalex", venue: "openalex" });
}

// applyEnrichment: a missing abstract fills from the inverted index of
// the SAME work object (2026-08-10; CrossRef ships most records without
// one), marked like any filled field; an existing abstract never changes.
{
	const work = {
		cited_by_count: 1,
		abstract_inverted_index: { Water: [0], mapping: [1], works: [2] },
	};
	const { record, filled } = applyEnrichment({ ...base, doi: "10.1/x", abstract: "" }, work);
	assert.equal(record.abstract, "Water mapping works");
	assert.ok(filled.includes("abstract"));
	assert.equal(record.enriched?.abstract, "openalex");
	const kept = applyEnrichment({ ...base, doi: "10.1/x", cites: 1, venue: "V", abstract: "Own text." }, work);
	assert.equal(kept.record.abstract, "Own text.");
	assert.ok(!kept.filled.includes("abstract"));
}

// applyEnrichment: existing values are never overwritten
{
	const work = { cited_by_count: 999, primary_location: { source: { display_name: "Other Journal" } } };
	const { record, filled } = applyEnrichment(
		{ ...base, doi: "10.1/x", cites: 7, venue: "Original Journal" },
		work,
	);
	assert.equal(record.cites, 7);
	assert.equal(record.venue, "Original Journal");
	assert.deepEqual(filled, []);
	assert.equal("enriched" in record, false); // no marker when nothing was filled
}

// applyEnrichment: garbage API shapes fill nothing
{
	const { record, filled } = applyEnrichment({ ...base, doi: "10.1/x" }, {
		cited_by_count: "not a number",
		primary_location: { source: { display_name: 42 } },
	});
	assert.deepEqual(filled, []);
	assert.equal(record.cites, null);
	assert.equal(record.venue, "");
}

// applyEnrichment: cites 0 is a real value, distinct from unknown
{
	const { record, filled } = applyEnrichment({ ...base, doi: "10.1/x" }, { cited_by_count: 0 });
	assert.equal(record.cites, 0);
	assert.deepEqual(filled, ["cites"]);
}

// applyEnrichment: journal ID is captured quietly (plumbing, not metadata)
{
	const work = { primary_location: { source: { id: "https://openalex.org/S43295729", display_name: "Remote Sensing" } } };
	const { record, filled } = applyEnrichment({ ...base, doi: "10.1/x", cites: 7, venue: "Remote Sensing" }, work);
	assert.equal(record.venue_id, "S43295729");
	assert.deepEqual(filled, []); // not reported as an enriched field
}

// applyJournalScores: stamps by venue_id, never overwrites, unknown stays unset
{
	const scores = new Map([["S1", 4.42]]);
	const scored = applyJournalScores(
		[
			{ ...base, doi: "10.1/a", venue_id: "S1" },
			{ ...base, doi: "10.1/b", venue_id: "S2" },
			{ ...base, doi: "10.1/c" },
		],
		scores,
	);
	assert.equal(scored[0].journal_2yr_citedness, 4.42);
	assert.equal("journal_2yr_citedness" in scored[1], false);
	assert.equal("journal_2yr_citedness" in scored[2], false);
}

// applyEnrichment MERGES into an existing enriched map (2026-08-07 fix:
// overwriting would erase another stage's provenance, e.g. code_url).
{
	const { record } = applyEnrichment(
		{ ...base, doi: "10.1/x", enriched: { code_url: "github" } } as typeof base & { enriched: Record<string, string> },
		{ cited_by_count: 7 },
	);
	assert.deepEqual(record.enriched, { code_url: "github", cites: "openalex" });
}

// pickCodeRepo (2026-08-07): first best-match repo with a usable URL; junk
// and empty answers yield null; aggregator/list repos are skipped (live
// find: "Robust_arXiv_daily" was the only hit for a SAR water paper)
{
	assert.equal(
		pickCodeRepo({ items: [
			{ name: "b", html_url: "https://github.com/a/b" },
			{ name: "d", html_url: "https://github.com/c/d" },
		] }),
		"https://github.com/a/b",
	);
	assert.equal(
		pickCodeRepo({ items: [
			{ name: "Robust_arXiv_daily", html_url: "https://github.com/x/Robust_arXiv_daily" },
			{ name: "awesome-water-segmentation", html_url: "https://github.com/x/awesome-water-segmentation" },
			{ name: "IWSeg-SAR-Poison", html_url: "https://github.com/GVCL/IWSeg-SAR-Poison" },
		] }),
		"https://github.com/GVCL/IWSeg-SAR-Poison",
	);
	assert.equal(pickCodeRepo({ items: [{ name: "cv-papers", html_url: "https://github.com/x/cv-papers" }] }), null);
	assert.equal(pickCodeRepo({ items: [{ html_url: "" }, { name: "x" }] }), null);
	assert.equal(pickCodeRepo({ total_count: 0, items: [] }), null);
	assert.equal(pickCodeRepo({}), null);
}

// codeUrlFromAbstract (2026-08-07): the paper's own abstract naming its
// repository is the most precise signal -- live find: the SAR paper's
// GitHub search hit was only an aggregator, while the abstract carried
// "(GitHub link - https://github.com/GVCL/IWSeg-SAR-Poison.git)"
{
	assert.equal(
		codeUrlFromAbstract("... are publicly available. (GitHub link - https://github.com/GVCL/IWSeg-SAR-Poison.git)"),
		"https://github.com/GVCL/IWSeg-SAR-Poison",
	);
	assert.equal(
		codeUrlFromAbstract("Code at https://github.com/acme/sandbar-net."),
		"https://github.com/acme/sandbar-net",
	);
	assert.equal(codeUrlFromAbstract("No code mentioned here."), null);
	assert.equal(codeUrlFromAbstract(undefined), null);
	// A bare profile link (no repo path) is not a code link.
	assert.equal(codeUrlFromAbstract("See https://github.com/acme for our work"), null);
}

// codeLookupCandidates: arXiv records only, on_target first, capped
{
	const records = [
		{ arxiv_id: "", group: "on_target" },
		{ arxiv_id: "2401.00001", group: "adjacent" },
		{ arxiv_id: "2401.00002", group: "on_target" },
		{ arxiv_id: "2401.00003" },
	];
	assert.deepEqual(
		codeLookupCandidates(records).map((r) => r.arxiv_id),
		["2401.00002", "2401.00001", "2401.00003"],
	);
	assert.deepEqual(
		codeLookupCandidates(records, 2).map((r) => r.arxiv_id),
		["2401.00002", "2401.00001"],
	);
}

// bareArxivId + candidate dedupe (2026-08-11 review find): the same paper
// can enter the pool twice (junk drops are collected per query variant,
// pre-dedupe) -- a duplicate must not burn a capped slot on an identical
// GitHub search; the on_target instance wins the shared slot
{
	assert.equal(bareArxivId("2401.00001v2"), "2401.00001");
	assert.equal(bareArxivId("2401.00001"), "2401.00001");
	const dupes = [
		{ arxiv_id: "2401.00001", group: "adjacent" },
		{ arxiv_id: "2401.00001v2", group: "on_target" },
		{ arxiv_id: "2401.00002" },
	];
	assert.deepEqual(
		codeLookupCandidates(dupes).map((r) => r.arxiv_id),
		["2401.00001v2", "2401.00002"],
	);
}

// addCodeLinks: one output per input, in input order (the engine re-zips
// kept and dropped records positionally -- this 1:1 mapping is contract),
// and duplicate arXiv records share ONE lookup, both carrying the link
{
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		return new Response(
			JSON.stringify({ items: [{ name: "sandbar-net", html_url: "https://github.com/acme/sandbar-net" }] }),
			{ status: 200 },
		);
	}) as typeof fetch;
	try {
		const records = [
			{ title: "A", doi: "10.1/a", arxiv_id: "", cites: null, venue: "", abstract: "Code at https://github.com/acme/a-repo." },
			{ title: "B", doi: "", arxiv_id: "2401.00007", cites: null, venue: "" },
			{ title: "B dup", doi: "", arxiv_id: "2401.00007v2", cites: null, venue: "" },
			{ title: "C", doi: "10.1/c", arxiv_id: "", cites: null, venue: "" },
		];
		const warnings: string[] = [];
		const out = await addCodeLinks(records, (message) => warnings.push(message));
		assert.equal(out.length, records.length);
		assert.deepEqual(out.map((r) => r.title), ["A", "B", "B dup", "C"]);
		assert.equal(out[0].code_url, "https://github.com/acme/a-repo");
		assert.equal(out[0].enriched?.code_url, "abstract");
		assert.equal(calls.length, 1); // the two duplicates share one search
		assert.equal(out[1].code_url, "https://github.com/acme/sandbar-net");
		assert.equal(out[1].enriched?.code_url, "github");
		assert.equal(out[2].code_url, "https://github.com/acme/sandbar-net");
		assert.equal(out[3].code_url, undefined);
		assert.ok(warnings.some((m) => m.includes("1 from abstract(s), 1/1 from GitHub lookup(s)")));
	} finally {
		globalThis.fetch = realFetch;
	}
}

console.log("enrich.test.ts: all assertions passed");
