/**
 * Offline tests of the result cards and the list filters applied to a
 * saved run payload. Run: node src/web/results.test.ts
 */

import assert from "node:assert/strict";

import { applyCardFilters, cardFilterReason, cardRows, describeCardFilters, hasCardFilters, paperKind, parseCardFilters } from "./results.ts";

const payload = {
	query: "(river) AND (depth)",
	generated: "2026-10-29T10:00:00Z",
	flow: { identified: 6, junk_removed: 0, duplicates_removed: 1, screened: 5, no_abstract_removed: 1, excluded_by_filters: 1, included: 3 },
	filters: { yearFrom: 2017 },
	results: [
		{ title: "Journal paper", authors: ["Ann Author", "Bo Writer"], year: "2024", venue: "Remote Sensing", doi: "10.1000/a", arxiv_id: "", url: "https://doi.org/10.1000/a", cites: 12, sources: ["crossref", "openalex"], access: { level: "free", pdf_urls: ["https://x/a.pdf"], work_type: "article", source_type: "journal" }, journal_2yr_citedness: 5.1, group: "on_target", abstract: "A" },
		{ title: "Conference paper", authors: ["Cy Coder"], year: "2019", venue: "IGARSS 2019 Proceedings", doi: "", arxiv_id: "1901.00001", url: "", cites: 0, sources: ["arxiv"], access: { level: "restricted" }, code_url: "https://github.com/x/y", group: "adjacent", abstract: "B" },
		{ title: "No id paper", authors: [], year: null, venue: "", doi: "", arxiv_id: "", url: "", cites: null, sources: ["openalex"], data_links: [{ url: "https://zenodo.org/1", archive: "Zenodo" }], abstract: "" },
	],
	dropped: [
		{ record: { title: "Dropped one", authors: ["D"], year: "2020", venue: "", doi: "10.1000/d", arxiv_id: "", cites: 3, sources: ["crossref"] }, reason: "no abstract available" },
	],
};

// Cards: numbering, identifiers, library flag, fields.
const rows = cardRows(payload, new Set(["doi:10.1000/d"]));
assert.equal(rows.length, 4);
assert.deepEqual(rows.map((row) => row.n), [1, 2, 3, 4]);
assert.deepEqual(rows.map((row) => row.id), ["10.1000/a", "arXiv:1901.00001", "", "10.1000/d"]);
assert.equal(rows[0].pdf, "https://x/a.pdf");
assert.equal(rows[0].access, "free");
assert.equal(rows[0].journalScore, 5.1);
assert.equal(rows[1].url, "https://arxiv.org/abs/1901.00001");
assert.equal(rows[1].codeUrl, "https://github.com/x/y");
assert.deepEqual(rows[2].dataLinks, [{ url: "https://zenodo.org/1", archive: "Zenodo" }]);
assert.equal(rows[3].dropped, true);
assert.equal(rows[3].reason, "no abstract available");
assert.equal(rows[3].inLibrary, true);
assert.equal(rows[0].inLibrary, false);

// Paper kind: OpenAlex work type ("article" split by its source type), arXiv-only = preprint, else unknown.
assert.deepEqual(rows.map((row) => row.kind), ["journal", "preprint", "unknown", "unknown"]);
assert.equal(paperKind({ access: { work_type: "article", source_type: "conference" } }), "conference");
assert.equal(paperKind({ access: { work_type: "article", source_type: "repository" } }), "preprint");
assert.equal(paperKind({ access: { work_type: "conference-paper" } }), "conference");
assert.equal(paperKind({ access: { work_type: "conference-abstract" } }), "abstract");
assert.equal(paperKind({ access: { work_type: "review" } }), "review");
assert.equal(paperKind({ access: { work_type: "book-chapter" } }), "book");
assert.equal(paperKind({ access: { work_type: "dataset" } }), "other");
// New list filters: code / data links, kinds, picked journals and authors (exact names).
assert.match(cardFilterReason(rows[0], { links: ["code"] }) ?? "", /no code repository/);
assert.equal(cardFilterReason(rows[1], { links: ["code"] }), null);
assert.equal(cardFilterReason(rows[2], { links: ["code", "data"] }), null);
assert.match(cardFilterReason(rows[1], { links: ["data"] }) ?? "", /no data link/);
assert.equal(cardFilterReason(rows[0], { kinds: ["journal"] }), null);
assert.match(cardFilterReason(rows[1], { kinds: ["journal", "conference"] }) ?? "", /publication type preprint not among the requested \(journal article, conference paper\)/);
assert.equal(cardFilterReason(rows[0], { venues: ["Remote Sensing"] }), null);
assert.match(cardFilterReason(rows[1], { venues: ["Remote Sensing"] }) ?? "", /not among the picked journals/);
assert.match(cardFilterReason(rows[2], { venues: ["Remote Sensing"] }) ?? "", /no venue/);
assert.equal(cardFilterReason(rows[0], { authors: ["Bo Writer"] }), null);
assert.match(cardFilterReason(rows[1], { authors: ["Bo Writer"] }) ?? "", /none of the picked authors/);
assert.deepEqual(parseCardFilters({ links: ["code", "x", "code"], kinds: ["journal", "bogus"], venues: ["Remote Sensing", "", 3], authors: ["Ann Author"] }), { links: ["code"], kinds: ["journal"], venues: ["Remote Sensing"], authors: ["Ann Author"] });
assert.deepEqual(describeCardFilters({ links: ["code", "data"], kinds: ["journal"], venues: ["Remote Sensing"], authors: ["Ann Author"] }, 2026), ["with code or data", "type: journal article", "journal: Remote Sensing", "author: Ann Author"]);

// Filters: each rule, unknowns handled as documented.
assert.equal(cardFilterReason(rows[0], {}), null);
assert.match(cardFilterReason(rows[1], { yearFrom: 2020 }) ?? "", /published 2019, before requested 2020/);
assert.match(cardFilterReason(rows[2], { yearFrom: 2020 }) ?? "", /year unknown/);
assert.equal(cardFilterReason(rows[0], { yearFrom: 2020 }), null);
assert.match(cardFilterReason(rows[1], { access: ["free"] }) ?? "", /access "restricted"/);
assert.match(cardFilterReason(rows[2], { access: ["free"] }) ?? "", /access "unknown"/);
assert.match(cardFilterReason(rows[1], { minCites: 1 }) ?? "", /0 citation\(s\) < requested minimum 1/);
assert.equal(cardFilterReason(rows[2], { minCites: 50 }), null); // unknown count passes
assert.match(cardFilterReason(rows[0], { codeOrData: true }) ?? "", /no code repository or data link/);
assert.equal(cardFilterReason(rows[1], { codeOrData: true }), null);
assert.equal(cardFilterReason(rows[2], { codeOrData: true }), null);
assert.match(cardFilterReason(rows[1], { journalOnly: true }) ?? "", /not a journal/);
assert.match(cardFilterReason(rows[2], { journalOnly: true }) ?? "", /no venue/);
assert.equal(cardFilterReason(rows[0], { journalOnly: true }), null);
assert.equal(cardFilterReason(rows[0], { text: "remote" }), null);
assert.equal(cardFilterReason(rows[0], { text: "writer" }), null);
assert.match(cardFilterReason(rows[1], { text: "remote" }) ?? "", /do not contain "remote"/);
assert.equal(cardFilterReason(rows[1], { sources: ["arxiv"] }), null);
assert.match(cardFilterReason(rows[0], { sources: ["arxiv"] }) ?? "", /not found by arxiv/);

// Description and presence.
assert.deepEqual(describeCardFilters({}, 2026), []);
assert.deepEqual(describeCardFilters({ yearFrom: 2017, access: ["free", "abstract_only"], minCites: 1, codeOrData: true, journalOnly: true, text: " Sens ", sources: ["openalex"] }, 2026), [
	"published 2017 or later (last 10 years)",
	"access: free or abstract only",
	"at least 1 citation",
	"code or data link",
	"journal articles only",
	'venue or author contains "Sens"',
	"source: openalex",
]);
assert.equal(hasCardFilters({}), false);
assert.equal(hasCardFilters({ text: "  " }), false);
assert.equal(hasCardFilters({ minCites: 0 }), true);

// Request bodies: only known keys with sane values survive.
assert.deepEqual(parseCardFilters(null), {});
assert.deepEqual(parseCardFilters({ yearFrom: 2020, access: ["free", "bogus"], minCites: 5, codeOrData: true, journalOnly: "yes", text: "  x ", sources: ["openalex", "../etc"] }), { yearFrom: 2020, access: ["free"], minCites: 5, codeOrData: true, text: "x", sources: ["openalex"] });
assert.deepEqual(parseCardFilters({ yearFrom: "2020", minCites: -1, access: [] }), {});

// Applying: results shrink, dropped grows with reasons, the flow counts them, the original is untouched.
const filtered = applyCardFilters(payload, { yearFrom: 2020, access: ["free"] }, 2026);
assert.deepEqual(filtered.results.map((r) => r.title), ["Journal paper"]);
assert.equal(filtered.dropped.length, 3);
assert.match(filtered.dropped[1].reason, /^filtered: published 2019/);
assert.match(filtered.dropped[2].reason, /^filtered: publication year unknown/);
assert.equal(filtered.flow?.excluded_by_filters, 3);
assert.equal(filtered.flow?.included, 1);
assert.deepEqual(filtered.list_filters, ["published 2020 or later (last 7 years)", "access: free"]);
assert.equal(payload.results.length, 3);
assert.equal(payload.dropped.length, 1);
assert.equal(payload.flow.excluded_by_filters, 1);
const unfiltered = applyCardFilters(payload, {}, 2026);
assert.equal(unfiltered.results.length, 3);
assert.equal(unfiltered.list_filters, null);

// A deposited GitHub link becomes the code link when the record has none;
// a record's own code link wins and the GitHub link stays a data link.
{
	const zenodo = { title: "Zenodo release", authors: [], year: "2026", venue: "Zenodo", doi: "10.5281/zenodo.1", arxiv_id: "", url: "", cites: 0, sources: ["openalex"], abstract: "x",
		data_links: [{ url: "https://github.com/a/b", archive: "GitHub" }, { url: "https://doi.org/10.1594/PANGAEA.1", archive: "PANGAEA" }] };
	const [row] = cardRows({ ...payload, results: [zenodo], dropped: [] } as never, new Set());
	assert.equal(row.codeUrl, "https://github.com/a/b");
	assert.deepEqual(row.dataLinks.map((d) => d.archive), ["PANGAEA"]);
	const [own] = cardRows({ ...payload, results: [{ ...zenodo, code_url: "https://gitlab.com/c/d" }], dropped: [] } as never, new Set());
	assert.equal(own.codeUrl, "https://gitlab.com/c/d");
	assert.deepEqual(own.dataLinks.map((d) => d.archive), ["GitHub", "PANGAEA"]);
}

console.log("results tests passed");
