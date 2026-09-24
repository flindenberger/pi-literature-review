/**
 * Offline tests for the pure CrossRef helpers.
 * Run: node src/sources/crossref.test.ts
 */

import assert from "node:assert/strict";
import { buildCrossrefParams, dataLinkFor, dataLinksFromRelation, flattenBlockTerms } from "./crossref.ts";

// flattenBlockTerms: CrossRef has no boolean search -- blocks arrive as
// flat, deduplicated relevance keywords, order kept, quotes stripped.
{
	assert.equal(
		flattenBlockTerms([["river", "stream"], ["water extraction"], ["river"]]),
		"river stream water extraction",
	);
	assert.equal(flattenBlockTerms([['"Sentinel 2"'], ["Sentinel 2"]]), "Sentinel 2");
	assert.equal(flattenBlockTerms([]), "");
	assert.equal(flattenBlockTerms(undefined), "");
	assert.equal(flattenBlockTerms([["  ", ""]]), "");
}

// buildCrossrefParams: author scope "all" drops the text query and sends
// the author field alone, citation-sorted; otherwise text plus author.
{
	const byQuery = buildCrossrefParams("water flood", 5, { authors: ["Claudia Kuenzer"], blocks: [["water"], ["flood"]] });
	assert.equal(byQuery.get("query"), "water flood");
	assert.equal(byQuery.get("query.author"), "Claudia Kuenzer");
	assert.equal(byQuery.get("sort"), "relevance");
	const all = buildCrossrefParams("water flood", 5, { authors: ["Claudia Kuenzer"], authorScope: "all" });
	assert.equal(all.get("query"), null);
	assert.equal(all.get("query.author"), "Claudia Kuenzer");
	assert.equal(all.get("sort"), "relevance");
	assert.equal(buildCrossrefParams("water", 5, { authorScope: "all" }).get("query"), "water");
	// Positive type list on EVERY request (CrossRef has no negative filter):
	// scholarly works only, so peer-review reports and author replies
	// ("Reply on RC2", typed peer-review; 7 of the first 10 hits of a plain
	// query.author request, measured 2026-09-15) never arrive.
	const filter = buildCrossrefParams("water", 5).get("filter")!;
	assert.ok(filter.startsWith("type:journal-article,type:proceedings-article,type:posted-content"));
	assert.ok(!filter.includes("peer-review"));
	assert.equal(all.get("filter"), filter);
}

// dataLinksFromRelation: shapes measured live on 2026-09-24 (446 DOIs of
// the user's searches). Copernicus deposits its data and code assets as
// is-part-of; preprint, review and comment relations are never material;
// targets outside the known archives (other papers) are not shown; each
// link once, whatever its case.
{
	const relation = {
		"has-preprint": [{ "id-type": "doi", id: "10.5194/essd-2021-82", "asserted-by": "subject" }],
		"has-review": [{ "id-type": "doi", id: "10.5194/essd-2021-82-RC1", "asserted-by": "object" }],
		"is-part-of": [
			{ "id-type": "doi", id: "10.1594/PANGAEA.897575", "asserted-by": "subject" },
			{ "id-type": "doi", id: "10.5281/ZENODO.10838614", "asserted-by": "subject" },
			{ "id-type": "doi", id: "10.5281/zenodo.10838614", "asserted-by": "subject" },
			{ "id-type": "doi", id: "10.5194/essd-15-5617-2023", "asserted-by": "subject" },
		],
		"is-supplemented-by": [{ "id-type": "uri", id: "https://github.com/acme/river-depth", "asserted-by": "subject" }],
		references: [{ "id-type": "doi", id: "10.17632/769cyvdznp.1", "asserted-by": "subject" }],
	};
	assert.deepEqual(dataLinksFromRelation(relation), [
		{ url: "https://github.com/acme/river-depth", archive: "GitHub" },
		{ url: "https://doi.org/10.1594/PANGAEA.897575", archive: "PANGAEA" },
		{ url: "https://doi.org/10.5281/ZENODO.10838614", archive: "Zenodo" },
		{ url: "https://doi.org/10.17632/769cyvdznp.1", archive: "Mendeley Data" },
	]);
	assert.deepEqual(dataLinksFromRelation(null), []);
	assert.deepEqual(dataLinksFromRelation({ "has-preprint": [{ "id-type": "doi", id: "10.5281/zenodo.1" }] }), []);
	// OSF preprints (10.31223/osf.io/...) are papers, not OSF projects.
	assert.equal(dataLinkFor("doi", "10.31223/osf.io/8eq6s"), null);
	assert.deepEqual(dataLinkFor("doi", "10.17605/OSF.IO/ABCDE"), { url: "https://doi.org/10.17605/OSF.IO/ABCDE", archive: "OSF" });
	// A doi.org URL is read as its DOI.
	assert.deepEqual(dataLinkFor("uri", "https://doi.org/10.5281/zenodo.42"), { url: "https://doi.org/10.5281/zenodo.42", archive: "Zenodo" });
	assert.equal(dataLinkFor("uri", "https://example.org/data"), null);
	assert.equal(dataLinkFor("doi", ""), null);
}

console.log("crossref.test.ts: all assertions passed");
