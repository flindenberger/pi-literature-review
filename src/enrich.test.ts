/**
 * Logic tests for the pure enrichment functions (no network). The records
 * and API objects below are synthetic fixtures -- never shown as papers.
 *
 * Run: node src/enrich.test.ts
 */

import assert from "node:assert/strict";
import { addAccessStatus, addCodeLinks, applyEnrichment, applyJournalScores, bareArxivId, codeLookupCandidates, codeSearchKey, codeUrlFromAbstract, enrichAll, lookupDoi, ownerMatchesAuthor, pickCodeRepo } from "./enrich.ts";

const base = {
	title: "A Title",
	doi: "",
	arxiv_id: "",
	cites: null as number | null,
	venue: "",
	venue_id: undefined as string | undefined,
};

// Stubbed OpenAlex batch endpoint: answers filter=doi:a|b|... with one work
// per DOI (10.1/withabs carries an abstract, the rest cites + venue).
const openalexRequests: string[] = [];
const batchStub = (async (url: unknown) => {
	const u = String(url);
	openalexRequests.push(u);
	const filter = new URL(u).searchParams.get("filter") ?? "";
	const dois = filter.replace(/^doi:/, "").split("|").filter(Boolean);
	const results = dois.map((doi) => doi === "10.1/withabs"
		? { doi: `https://doi.org/${doi}`, cited_by_count: 3, abstract_inverted_index: { Own: [0], text: [1] } }
		: { doi: `https://doi.org/${doi}`, cited_by_count: 5, primary_location: { source: { display_name: "V" } } });
	return new Response(JSON.stringify({ results }), { status: 200 });
}) as typeof fetch;

// enrichAll: an abstract still missing after the OpenAlex
// lookup is asked from Semantic Scholar by DOI (injected here; stubbed
// OpenAlex fetch delivers cites+venue but no abstract); provenance
// "semanticscholar"; a record whose OpenAlex answer carries the abstract
// never asks S2; arXiv-only records (no own DOI) never ask S2 either.
// A failing S2 lookup keeps the record and DEGRADES the run: every later
// lookup is still tried, but with retry:false (single attempt, no backoff
// sleeps), a recovered pool still fills later records, and every failed
// DOI lands in s2AbstractFailures so the caller can word the drop reason
// as "lookup failed" instead of "delivered none".
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = batchStub;
	openalexRequests.length = 0;
	try {
		const asked: Array<{ doi: string; retry: boolean | undefined }> = [];
		const lookup = async (doi: string, opts?: { retry?: boolean }) => {
			asked.push({ doi, retry: opts?.retry });
			if (doi === "10.1/fail" || doi === "10.1/alsofail") throw new Error("boom");
			return doi === "10.1/s2" || doi === "10.1/late" ? "From S2." : null;
		};
		const warnings: string[] = [];
		const { records: out, s2AbstractFailures } = await enrichAll([
			{ title: "S2", doi: "10.1/s2", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "None", doi: "10.1/none", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "OA", doi: "10.1/withabs", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "Arx", doi: "", arxiv_id: "2401.00001", cites: null, venue: "", abstract: "" },
			{ title: "Fail", doi: "10.1/fail", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "AlsoFail", doi: "10.1/alsofail", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "Late", doi: "10.1/late", arxiv_id: "", cites: null, venue: "", abstract: "" },
		], (m) => warnings.push(m), lookup, true);
		// ONE batched OpenAlex request for all seven records (incl. the
		// arXiv DataCite DOI), not one per record
		assert.equal(openalexRequests.length, 1);
		assert.ok(openalexRequests[0].includes("10.48550%2Farxiv.2401.00001"));
		// the first failure degrades instead of skipping: every later record
		// is still asked, but with retry:false; a recovered pool fills "Late"
		assert.deepEqual(asked, [
			{ doi: "10.1/s2", retry: true },
			{ doi: "10.1/none", retry: true },
			{ doi: "10.1/fail", retry: true },
			{ doi: "10.1/alsofail", retry: false },
			{ doi: "10.1/late", retry: false },
		]);
		assert.equal(out[0].abstract, "From S2.");
		assert.equal(out[0].enriched?.abstract, "semanticscholar");
		assert.equal(out[0].enriched?.cites, "openalex");
		assert.equal(out[1].abstract, "");
		assert.equal(out[2].abstract, "Own text");
		assert.equal(out[2].enriched?.abstract, "openalex");
		assert.equal(out[4].abstract, "");
		assert.equal(out[4].cites, 5);
		assert.equal(out[6].abstract, "From S2.");
		assert.equal(out[6].enriched?.abstract, "semanticscholar");
		assert.deepEqual([...s2AbstractFailures.entries()], [["10.1/fail", "boom"], ["10.1/alsofail", "boom"]]);
		// first failure warns loudly and announces the degraded mode; later
		// failures are counted, not repeated
		assert.ok(warnings.some((m) => m.includes("abstract lookup at Semantic Scholar for \"Fail\" failed: boom") && m.includes("tried once each without retries")));
		assert.equal(warnings.filter((m) => m.includes("abstract lookup at Semantic Scholar for")).length, 1);
		assert.ok(warnings.some((m) => m.includes("abstract lookups at Semantic Scholar: 5, 2 abstract(s) filled, 2 lookup(s) failed")));
	} finally {
		globalThis.fetch = realFetch;
	}
}

// enrichAll WITHOUT an S2 API key: Semantic Scholar is not asked at all
// (its anonymous pool is saturated nearly always); OpenAlex still fills.
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = batchStub;
	try {
		let asked = 0;
		const lookup = async () => {
			asked++;
			return "never";
		};
		const warnings: string[] = [];
		const { records: out, s2AbstractFailures } = await enrichAll([
			{ title: "N", doi: "10.1/none", arxiv_id: "", cites: null, venue: "", abstract: "" },
			{ title: "OA", doi: "10.1/withabs", arxiv_id: "", cites: null, venue: "", abstract: "" },
		], (m) => warnings.push(m), lookup, false);
		assert.equal(asked, 0);
		assert.equal(s2AbstractFailures.size, 0);
		assert.equal(out[0].cites, 5);
		assert.equal(out[1].abstract, "Own text");
		assert.ok(!warnings.some((m) => m.includes("Semantic Scholar")));
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
// find: "Robust_arXiv_daily" was the only hit for a SAR water paper).
// An empty context keeps every guard inactive (no year = no date gate).
const noPaper = { year: null, title: "" };
{
	assert.equal(
		pickCodeRepo({ items: [
			{ name: "b", html_url: "https://github.com/a/b" },
			{ name: "d", html_url: "https://github.com/c/d" },
		] }, noPaper),
		"https://github.com/a/b",
	);
	assert.equal(
		pickCodeRepo({ items: [
			{ name: "Robust_arXiv_daily", html_url: "https://github.com/x/Robust_arXiv_daily" },
			{ name: "awesome-water-segmentation", html_url: "https://github.com/x/awesome-water-segmentation" },
			{ name: "IWSeg-SAR-Poison", html_url: "https://github.com/GVCL/IWSeg-SAR-Poison" },
		] }, noPaper),
		"https://github.com/GVCL/IWSeg-SAR-Poison",
	);
	assert.equal(pickCodeRepo({ items: [{ name: "cv-papers", html_url: "https://github.com/x/cv-papers" }] }, noPaper), null);
	assert.equal(pickCodeRepo({ items: [{ html_url: "" }, { name: "x" }] }, noPaper), null);
	assert.equal(pickCodeRepo({ total_count: 0, items: [] }, noPaper), null);
	assert.equal(pickCodeRepo({}, noPaper), null);
}

// Date gate (2026-09-02 field test): repositories created more than a
// year AFTER the paper are third-party reimplementations, not the
// authors' code (measured: correct picks -1..0, wrong ones +2..+11).
// Fixtures from the test: a 2023 repo "for" a 2012 paper dies; the real
// feevos/resuneta (created 2019, journal paper 2020) survives the
// preprint->journal delay; an unreadable year disables the gate.
{
	const late = { items: [{ name: "Tree-species-classification", html_url: "https://github.com/SiruiWang0731/Tree-species-classification", created_at: "2023-01-08T00:00:00Z" }] };
	assert.equal(pickCodeRepo(late, { year: "2012", title: "Tree Species Classification with Random Forest" }), null);
	assert.equal(pickCodeRepo(late, { year: null, title: "" }), "https://github.com/SiruiWang0731/Tree-species-classification");
	assert.equal(
		pickCodeRepo(
			{ items: [{ name: "resuneta", html_url: "https://github.com/feevos/resuneta", created_at: "2019-07-04T00:00:00Z" }] },
			{ year: "2020", title: "ResUNet-a: a deep learning framework" },
		),
		"https://github.com/feevos/resuneta",
	);
	// Missing created_at on the item: gate inactive for that item.
	assert.equal(
		pickCodeRepo({ items: [{ name: "b", html_url: "https://github.com/a/b" }] }, { year: "2012", title: "" }),
		"https://github.com/a/b",
	);
}

// Title-word preference: among survivors, a repo whose name shares a
// word (>= 4 chars, split on separators and camelCase) with the paper
// title beats an earlier one without -- but it is NEVER a requirement
// (field case Multihuntr/gff: correct repo, no title word).
{
	const items = { items: [
		{ name: "some-toolkit", html_url: "https://github.com/x/some-toolkit" },
		{ name: "DisasterNets", html_url: "https://github.com/HydroPML/DisasterNets" },
	] };
	assert.equal(
		pickCodeRepo(items, { year: null, title: "DisasterNets: Embedding Machine Learning in Disaster Mapping" }),
		"https://github.com/HydroPML/DisasterNets",
	);
	assert.equal(pickCodeRepo(items, { year: null, title: "Something Unrelated" }), "https://github.com/x/some-toolkit");
}

// ownerMatchesAuthor (2026-09-02 field test): on the DOI path the owner
// name separated correct from wrong picks perfectly -- real cases pinned.
// kvos matches via the initial+surname login pattern ("vos" alone is
// under the 4-char floor).
{
	assert.equal(ownerMatchesAuthor("kvos", ["Kilian Vos"]), true);
	assert.equal(ownerMatchesAuthor("connorlee77", ["Connor Lee", "Someone Else"]), true);
	assert.equal(ownerMatchesAuthor("IamShubhamGupto", ["Shubham Gupta"]), true);
	assert.equal(ownerMatchesAuthor("raadcostellomahmoud", ["Marc Wieland", "Sandro Martinis"]), false);
	assert.equal(ownerMatchesAuthor("7Kitsu7", ["R Archana", "P. S. Eliahim Jeevaraj"]), false);
	assert.equal(ownerMatchesAuthor("", ["Kilian Vos"]), false);
	assert.equal(ownerMatchesAuthor("kvos", []), false);
}

// DOI path (requireOwner): a match is only linked when the owner looks
// like an author -- field fixtures: the title-word hit without an owner
// match (raadcostellomahmoud, Wieland 2023 paper) and the plain first
// survivor (7Kitsu7, citing repo) both die; the real author repo passes.
{
	const wieland = { items: [{ name: "geospatial-water-masking", html_url: "https://github.com/raadcostellomahmoud/geospatial-water-masking", created_at: "2024-11-13T00:00:00Z", owner: { login: "raadcostellomahmoud" } }] };
	const paper = { year: "2023", title: "Semantic segmentation of water bodies in very high-resolution satellite imagery", authors: ["Marc Wieland", "Sandro Martinis"] };
	assert.equal(pickCodeRepo(wieland, { ...paper, requireOwner: true }), null);
	// Same answer without the owner rule (arXiv path) would link it.
	assert.equal(pickCodeRepo(wieland, paper), "https://github.com/raadcostellomahmoud/geospatial-water-masking");
	assert.equal(
		pickCodeRepo(
			{ items: [{ name: "CoastSat", html_url: "https://github.com/kvos/CoastSat", created_at: "2018-09-28T00:00:00Z", owner: { login: "kvos" } }] },
			{ year: "2019", title: "CoastSat: A Google Earth Engine-enabled Python toolkit", authors: ["Kilian Vos"], requireOwner: true },
		),
		"https://github.com/kvos/CoastSat",
	);
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

// codeUrlFromAbstract, further hosts (2026-09-02): abstracts may name
// GitLab/Bitbucket/Codeberg/Hugging Face/Zenodo/OSF; a GitHub link wins
// when several appear; forge profile links (owner only) stay null.
{
	assert.equal(codeUrlFromAbstract("Code: https://gitlab.com/acme/river-net."), "https://gitlab.com/acme/river-net");
	assert.equal(codeUrlFromAbstract("at https://bitbucket.org/lab/model.git here"), "https://bitbucket.org/lab/model");
	assert.equal(codeUrlFromAbstract("see https://codeberg.org/acme/tool,"), "https://codeberg.org/acme/tool");
	assert.equal(codeUrlFromAbstract("weights at https://huggingface.co/acme/water-seg"), "https://huggingface.co/acme/water-seg");
	assert.equal(codeUrlFromAbstract("data and code https://zenodo.org/records/1234567."), "https://zenodo.org/records/1234567");
	assert.equal(codeUrlFromAbstract("archived at https://osf.io/ab1cd"), "https://osf.io/ab1cd");
	assert.equal(
		codeUrlFromAbstract("mirror https://gitlab.com/acme/mirror and main https://github.com/acme/main"),
		"https://github.com/acme/main",
	);
	assert.equal(codeUrlFromAbstract("our group https://gitlab.com/acme published it"), null);
}

// codeLookupCandidates: arXiv OR doi holders, on_target first, capped;
// the shared cap covers both search paths (2026-09-02). codeSearchKey:
// the arXiv id wins when a record carries both.
{
	const records = [
		{ arxiv_id: "", group: "on_target" },
		{ arxiv_id: "2401.00001", group: "adjacent" },
		{ arxiv_id: "2401.00002", group: "on_target" },
		{ arxiv_id: "2401.00003" },
		{ arxiv_id: "", doi: "10.1/journal", group: "adjacent" },
	];
	assert.deepEqual(
		codeLookupCandidates(records).map((r) => codeSearchKey(r)),
		["2401.00002", "2401.00001", "2401.00003", "10.1/journal"],
	);
	assert.deepEqual(
		codeLookupCandidates(records, 2).map((r) => codeSearchKey(r)),
		["2401.00002", "2401.00001"],
	);
	assert.equal(codeSearchKey({ arxiv_id: "2401.00001v2", doi: "10.1/x" }), "2401.00001");
	assert.equal(codeSearchKey({ arxiv_id: "", doi: "10.1/x" }), "10.1/x");
	assert.equal(codeSearchKey({ arxiv_id: "" }), "");
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
// kept and dropped records positionally -- this 1:1 mapping is contract);
// duplicate arXiv records share ONE lookup, both carrying the link;
// DOI-only journal records are searched too (2026-09-02) but linked only
// when the repository owner looks like an author -- an abstract hit
// spends no search budget either way.
{
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		return new Response(
			JSON.stringify({ items: [{ name: "sandbar-net", html_url: "https://github.com/acme/sandbar-net", owner: { login: "acme" } }] }),
			{ status: 200 },
		);
	}) as typeof fetch;
	try {
		const records = [
			{ title: "A", doi: "10.1/a", arxiv_id: "", cites: null, venue: "", abstract: "Code at https://github.com/acme/a-repo." },
			{ title: "B", doi: "", arxiv_id: "2401.00007", cites: null, venue: "" },
			{ title: "B dup", doi: "", arxiv_id: "2401.00007v2", cites: null, venue: "" },
			{ title: "C", doi: "10.1/c", arxiv_id: "", cites: null, venue: "", authors: ["Alice Acme"] },
			{ title: "D", doi: "10.1/d", arxiv_id: "", cites: null, venue: "", authors: ["Bob Uninvolved"] },
		];
		const warnings: string[] = [];
		const out = await addCodeLinks(records, (message) => warnings.push(message));
		assert.equal(out.length, records.length);
		assert.deepEqual(out.map((r) => r.title), ["A", "B", "B dup", "C", "D"]);
		assert.equal(out[0].code_url, "https://github.com/acme/a-repo");
		assert.equal(out[0].enriched?.code_url, "abstract");
		assert.equal(calls.length, 3); // duplicates share one search; C and D get one each
		assert.equal(out[1].code_url, "https://github.com/acme/sandbar-net");
		assert.equal(out[1].enriched?.code_url, "github");
		assert.equal(out[2].code_url, "https://github.com/acme/sandbar-net");
		// C's answer owner "acme" matches author "Alice Acme" -> linked.
		assert.equal(out[3].code_url, "https://github.com/acme/sandbar-net");
		assert.equal(out[3].enriched?.code_url, "github");
		// D's answer owner matches no author -> honestly unlinked.
		assert.equal(out[4].code_url, undefined);
		assert.ok(calls.some((url) => url.includes(encodeURIComponent('"10.1/c"'))));
		assert.ok(warnings.some((m) => m.includes("1 from abstract(s), 2/3 from GitHub lookup(s)")));
	} finally {
		globalThis.fetch = realFetch;
	}
}

// addCodeLinks leaves records that already carry a code_url alone: no
// abstract overwrite (pass 1), no GitHub lookup (pass 2), provenance kept.
{
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		return new Response(JSON.stringify({ items: [] }), { status: 200 });
	}) as typeof fetch;
	try {
		const linked = {
			title: "Linked", doi: "", arxiv_id: "2411.01411", cites: null, venue: "", year: "2024", authors: ["A"],
			abstract: "code at https://github.com/other/from-abstract",
			code_url: "https://github.com/microsoft/ai4g-flood", enriched: { code_url: "hf-papers" },
		};
		const out = await addCodeLinks([linked], () => {});
		assert.equal(calls.length, 0);
		assert.equal(out[0].code_url, "https://github.com/microsoft/ai4g-flood");
		assert.deepEqual(out[0].enriched, { code_url: "hf-papers" });
	} finally {
		globalThis.fetch = realFetch;
	}
}

// addCodeLinks without githubLookup (no code sources ticked): the free
// abstract signal still links, but GitHub is never asked.
{
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		return new Response(JSON.stringify({ items: [] }), { status: 200 });
	}) as typeof fetch;
	try {
		const out = await addCodeLinks([
			{ title: "A", doi: "10.1/a", arxiv_id: "", cites: null, venue: "", abstract: "Code at https://github.com/acme/a-repo." },
			{ title: "B", doi: "", arxiv_id: "2401.00007", cites: null, venue: "" },
		], () => {}, undefined, false);
		assert.equal(calls.length, 0);
		assert.equal(out[0].code_url, "https://github.com/acme/a-repo");
		assert.equal(out[1].code_url, undefined);
	} finally {
		globalThis.fetch = realFetch;
	}
}

// addCodeLinks: the first GitHub rate-limit answer ends the lookups of the
// run -- a single attempt, no backoff sleeps; every further request would
// only wait.
{
	let calls = 0;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		calls++;
		return new Response("", { status: 403, headers: { "retry-after": "1" } });
	}) as typeof fetch;
	try {
		const warnings: string[] = [];
		const out = await addCodeLinks([
			{ title: "B", doi: "", arxiv_id: "2401.00007", cites: null, venue: "" },
			{ title: "C", doi: "", arxiv_id: "2401.00008", cites: null, venue: "" },
			{ title: "D", doi: "", arxiv_id: "2401.00009", cites: null, venue: "" },
		], (m) => warnings.push(m));
		assert.equal(out.length, 3);
		assert.equal(calls, 1); // ONE attempt for the first record, then stop
		assert.ok(warnings.some((m) => m.includes("GitHub rate limit reached; the remaining 2 lookup(s) of this run are skipped")));
		assert.ok(warnings.some((m) => m.includes("0/1 from GitHub lookup(s)")));
	} finally {
		globalThis.fetch = realFetch;
	}
}

/* ---------------- addAccessStatus (fake lookup) ---------------- */
{
	const base = { title: "", cites: null, venue: "" };
	const records = [
		{ ...base, doi: "10.3390/W14030309", arxiv_id: "" },
		{ ...base, doi: "", arxiv_id: "2401.16393" },
		{ ...base, doi: "10.1016/closed", arxiv_id: "2402.00001" },
		{ ...base, doi: "10.9/unlisted", arxiv_id: "" },
		{ ...base, doi: "", arxiv_id: "" },
	];
	const asked: string[][] = [];
	const warnings: string[] = [];
	const out = await addAccessStatus(records, (m) => warnings.push(m), async (dois) => {
		asked.push(dois);
		return new Map([
			["10.3390/w14030309", { level: "free" as const, oa_status: "gold", pdf_urls: ["https://www.mdpi.com/x/pdf"] }],
			["10.1016/closed", { level: "restricted" as const, oa_status: "closed" }],
		]);
	});
	assert.equal(out.length, records.length); // 1:1, same order
	assert.deepEqual(asked, [["10.3390/W14030309", "10.1016/closed", "10.9/unlisted"]]); // only DOI records, one call
	assert.deepEqual(out[0].access, { level: "free", oa_status: "gold", pdf_urls: ["https://www.mdpi.com/x/pdf"] });
	assert.equal(out[1].access.level, "free"); // arXiv: always free
	assert.equal(out[2].access.level, "free"); // arXiv copy beats the closed publisher version
	assert.equal(out[2].access.oa_status, "closed"); // the OpenAlex value stays verbatim
	assert.equal(out[3].access.level, "unknown");
	assert.equal(out[4].access.level, "unknown");
	assert.ok(warnings.some((w) => w === "access: 3 full text free, 0 abstract only, 0 restricted, 2 unknown"));

	// A failing lookup degrades to unknown, loudly.
	const failed = await addAccessStatus(records.slice(0, 1), (m) => warnings.push(m), async () => { throw new Error("OpenAlex answered HTTP 503"); });
	assert.equal(failed[0].access.level, "unknown");
	assert.ok(warnings.some((w) => w.includes("access lookup failed: OpenAlex answered HTTP 503")));
}

console.log("enrich.test.ts: all assertions passed");
