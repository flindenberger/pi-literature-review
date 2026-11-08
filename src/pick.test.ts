/** Offline tests for src/pick.ts (paper pick after a search). */
import assert from "node:assert/strict";
import { candidatesFromRecords, parsePickAnswer, pickedIds } from "./pick.ts";

const record = (doi: string, arxiv: string, group: string, extra: Record<string, unknown> = {}) => ({
	doi, arxiv_id: arxiv, title: `T ${doi || arxiv}`, year: "2024", group, ...extra,
});
const candidates = candidatesFromRecords(
	[
		record("10.1/a", "", "on_target"),
		record("", "2401.00001v2", "on_target", { code_url: "https://github.com/x/y" }),
		record("10.1/c", "", "partial"),
		record("", "", "on_target"), // no identifier: no candidate
	],
	[{ record: record("10.1/d", "", "on_target", { data_links: [{}] }) }],
	new Set(["doi:10.1/a"]),
);

// Results first, dropped after; arXiv ids carry the prefix; library flagged.
assert.deepEqual(candidates.map((c) => c.id), ["10.1/a", "arXiv:2401.00001v2", "10.1/c", "10.1/d"]);
assert.deepEqual(candidates.map((c) => c.dropped), [false, false, false, true]);
assert.equal(candidates[0].inLibrary, true);
assert.equal(candidates[1].inLibrary, false);

// Library keys follow identityKey: an arXiv version suffix and DOI case do not matter,
// and "all" / "code" skip papers already in the library.
{
	const inLib = candidatesFromRecords(
		[record("10.1/A", "", "on_target"), record("", "2401.00001v2", "on_target", { code_url: "https://github.com/x/y" })],
		[],
		new Set(["doi:10.1/a", "arxiv:2401.00001"]),
	);
	assert.deepEqual(inLib.map((c) => c.inLibrary), [true, true]);
	assert.deepEqual(pickedIds(parsePickAnswer("all", inLib), inLib), []);
	assert.deepEqual(pickedIds(parsePickAnswer("code", inLib), inLib), []);
}

// "all" = on-target, not in the library (dropped ones count too).
assert.deepEqual(pickedIds(parsePickAnswer("all", candidates), candidates), ["arXiv:2401.00001v2", "10.1/d"]);
// "code" = code or data link.
assert.deepEqual(pickedIds(parsePickAnswer("code", candidates), candidates), ["arXiv:2401.00001v2", "10.1/d"]);
// Row numbers count the results table only (1-based); out of range ignored.
assert.deepEqual(pickedIds(parsePickAnswer("1, 3 9", candidates), candidates), ["10.1/a", "10.1/c"]);
// The copied report line and plain identifiers.
assert.deepEqual(pickedIds(parsePickAnswer("Download these papers: 10.3390/rs13081505, arXiv:2401.16393", candidates), candidates),
	["10.3390/rs13081505", "arXiv:2401.16393"]);
// Nothing usable.
assert.equal(parsePickAnswer("the good ones", candidates).kind, "none");
assert.equal(parsePickAnswer("", candidates).kind, "none");

console.log("pick.test.ts: all assertions passed");
