/** Offline tests for snowmerge.ts: a snowball round extends a list. */

import assert from "node:assert/strict";
import { mergeSnowball, payloadKeys, seedKey } from "./snowmerge.ts";
import type { SearchPayload } from "./search.ts";

const rec = (doi: string, extra: Record<string, unknown> = {}) => ({ title: doi, authors: [], year: "2020", venue: "", doi, arxiv_id: "", pdf_url: "", url: "", cites: 1, abstract: "a", sources: ["openalex"], verified: true, verify_note: "", ...extra });
const payload = (results: unknown[], dropped: unknown[], extra: Record<string, unknown> = {}) => ({
	query: "(river)", generated: "2026-11-16T10:00:00Z", sort: null, source_failures: null, source_counts: [{ source: "openalex", query: "(river)", count: 2 }],
	snowball: null, snowball_known: null, access_counts: null,
	flow: { identified: 2, junk_removed: 0, duplicates_removed: 0, screened: 2, no_abstract_removed: 0, excluded_by_filters: 0, included: results.length },
	results, dropped, ...extra,
}) as unknown as SearchPayload;

assert.equal(seedKey("https://doi.org/10.1/ABC"), "doi:10.1/abc");
assert.equal(seedKey("arXiv:2405.11494v2"), "arxiv:2405.11494");

const prior = payload([rec("10.1/a"), rec("10.1/b")], [{ reason: "no abstract", record: rec("10.1/c") }]);
assert.deepEqual([...payloadKeys(prior)].sort(), ["doi:10.1/a", "doi:10.1/b", "doi:10.1/c"]);

const extra = payload(
	[rec("10.1/new", { sources: ["snowball"], snowball: ["cites: A 2020"] })],
	[{ reason: "found only via citation search", record: rec("10.1/off", { sources: ["snowball"], snowball: ["references of: A 2020"] }) }],
	{
		snowball: { seeds: ["A 2020"], missing: [], backward: 3, forward: 2, requests: 3, direction: "both" },
		snowball_known: [{ key: "doi:10.1/b", snowball: ["references of: A 2020"] }, { key: "doi:10.1/c", snowball: ["cites: A 2020"] }],
		source_counts: [{ source: "snowball", query: "references of and works citing A 2020", count: 4 }],
		flow: { identified: 4, junk_removed: 0, duplicates_removed: 2, screened: 2, no_abstract_removed: 0, identified_citation: 4, off_topic_snowball_removed: 1, excluded_by_filters: 0, included: 1 },
	},
);
const merged = mergeSnowball(prior, extra, ["10.1/A"]);
// The earlier list keeps its order; the new find is added.
assert.deepEqual(merged.results.map((r) => r.doi), ["10.1/a", "10.1/b", "10.1/new"]);
assert.equal(merged.results[0].snowball_seed, true);
assert.deepEqual(merged.results[1].snowball, ["references of: A 2020"]);
assert.deepEqual(merged.results[1].sources, ["openalex", "snowball"]);
assert.deepEqual(merged.dropped.map((entry) => entry.record.doi), ["10.1/c", "10.1/off"]);
assert.deepEqual(merged.dropped[0].record.snowball, ["cites: A 2020"]);
// Flow numbers add up; included = the list.
assert.equal(merged.flow.identified, 6);
assert.equal(merged.flow.duplicates_removed, 2);
assert.equal(merged.flow.screened, 4);
assert.equal(merged.flow.included, 3);
assert.equal((merged.flow as Record<string, number>).identified_citation, 4);
assert.equal(merged.source_counts?.length, 2);
assert.equal(merged.snowball?.backward, 3);
assert.equal(merged.snowball_known, null);
// A second round adds its seeds and counts.
const twice = mergeSnowball(merged, payload([], [], { snowball: { seeds: ["B 2021"], missing: [], backward: 1, forward: 0, requests: 2, direction: "back" }, flow: { identified: 1, junk_removed: 0, duplicates_removed: 1, screened: 0, no_abstract_removed: 0, excluded_by_filters: 0, included: 0 } }), []);
assert.deepEqual(twice.snowball?.seeds, ["A 2020", "B 2021"]);
assert.equal(twice.snowball?.direction, "both");
assert.equal(twice.flow.identified, 7);

console.log("snowmerge tests passed");
