/**
 * Logic tests for the pure enrichment functions (no network). The records
 * and API objects below are synthetic fixtures -- never shown as papers.
 *
 * Run: node src/enrich.test.ts
 */

import assert from "node:assert/strict";
import { applyEnrichment, applyJournalScores, codeLookupCandidates, codeUrlFromAbstract, lookupDoi, pickCodeRepo } from "./enrich.ts";

const base = {
	title: "A Title",
	doi: "",
	arxiv_id: "",
	cites: null as number | null,
	venue: "",
};

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

console.log("enrich.test.ts: all assertions passed");
