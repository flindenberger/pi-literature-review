import assert from "node:assert/strict";
import { dataLinksFromRelated } from "./datacite.ts";

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
console.log("datacite.test.ts: all assertions passed");
