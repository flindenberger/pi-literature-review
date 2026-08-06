/**
 * Offline tests for the pure CrossRef helpers (2026-08-06 block search).
 * Run: node src/sources/crossref.test.ts
 */

import assert from "node:assert/strict";
import { flattenBlockTerms } from "./crossref.ts";

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

console.log("crossref.test.ts: all assertions passed");
