import assert from "node:assert/strict";
import { dataciteBlockQuery, dataLinksFromRelated, parseSoftwareHits } from "./datacite.ts";

// The Zenodo release of a GitHub repository (relatedIdentifiers as
// api.datacite.org returns them): the repository is code material; version
// relations, other papers and the record itself are not links.
const related = [
	{ relationType: "IsSupplementTo", relatedIdentifier: "https://github.com/flindenberger/pi-literature-review/tree/v0.1.1", relatedIdentifierType: "URL" },
	{ relationType: "IsVersionOf", relatedIdentifier: "10.5281/zenodo.22954995", relatedIdentifierType: "DOI" },
	{ relationType: "IsSupplementTo", relatedIdentifier: "10.1016/j.geomorph.2019.02.014", relatedIdentifierType: "DOI" },
	{ relationType: "References", relatedIdentifier: "10.5281/zenodo.23015407", relatedIdentifierType: "DOI" },
	{ relationType: "IsSupplementedBy", relatedIdentifier: "10.1594/PANGAEA.12345", relatedIdentifierType: "DOI" },
];
assert.deepEqual(dataLinksFromRelated("10.5281/zenodo.23015407", related), [
	{ url: "https://github.com/flindenberger/pi-literature-review/tree/v0.1.1", archive: "GitHub" },
	{ url: "https://doi.org/10.1594/PANGAEA.12345", archive: "PANGAEA" },
]);
assert.deepEqual(dataLinksFromRelated("10.1/x", null), []);

// Software search: block query form (phrases quoted, quotes/brackets in
// terms dropped), plain query without blocks.
assert.equal(dataciteBlockQuery("x", [["shoreline", "coastline"], ["extraction"], ["sand bar", "sandbar"]]), '(shoreline OR coastline) AND extraction AND ("sand bar" OR sandbar)');
assert.equal(dataciteBlockQuery('sandbar "river"', undefined), "sandbar river");

// Software hits: GitHub/GitLab repositories and paper DOIs (paper relation
// types only, archive DOIs and arXiv DataCite DOIs skipped); records with
// neither dropped; field shape as api.datacite.org returns it (2026-11-15).
assert.deepEqual(parseSoftwareHits({
	data: [
		{ attributes: { doi: "10.5281/ZENODO.3560436", publicationYear: 2019, relatedIdentifiers: [
			{ relationType: "IsSupplementTo", relatedIdentifier: "https://github.com/kvos/CoastSat/tree/v1.1", relatedIdentifierType: "URL" },
			{ relationType: "IsDescribedBy", relatedIdentifier: "https://doi.org/10.1016/j.envsoft.2019.104528", relatedIdentifierType: "DOI" },
			{ relationType: "IsVersionOf", relatedIdentifier: "10.5281/zenodo.2779293", relatedIdentifierType: "DOI" },
			{ relationType: "References", relatedIdentifier: "10.5281/zenodo.1", relatedIdentifierType: "DOI" },
			{ relationType: "Cites", relatedIdentifier: "10.48550/arXiv.2101.00001", relatedIdentifierType: "DOI" },
		] } },
		{ attributes: { doi: "10.5281/zenodo.9", relatedIdentifiers: [{ relationType: "IsVersionOf", relatedIdentifier: "10.5281/zenodo.8", relatedIdentifierType: "DOI" }] } },
		{ attributes: {} },
	],
}), [{ doi: "10.5281/zenodo.3560436", year: "2019", repoUrls: ["https://github.com/kvos/CoastSat/tree/v1.1"], paperDois: ["10.1016/j.envsoft.2019.104528"] }]);
assert.deepEqual(parseSoftwareHits(null), []);

console.log("datacite.test.ts: all assertions passed");
