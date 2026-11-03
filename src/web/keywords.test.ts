// Author keywords from the first pages: offline.
import assert from "node:assert/strict";
import { paperKeywords } from "./keywords.ts";

assert.deepEqual(
	paperKeywords("Abstract text here. Keywords: Coastline; remote sensing; image analysis; review; implementation 1. Introduction The coast ..."),
	["coastline", "remote sensing", "image analysis", "review", "implementation"],
);
assert.deepEqual(
	paperKeywords("Index Terms—Convolutional neural networks (CNNs), reference dataset, semantic segmentation, Sentinel-1, Sentinel-2 I. INTRODUCTION"),
	["Convolutional neural networks (CNNs)", "reference dataset", "semantic segmentation", "Sentinel-1", "Sentinel-2"],
);
// Names and acronyms keep their case.
assert.deepEqual(paperKeywords("Keywords: Google Earth Engine; SAR; Flooding."), ["Google Earth Engine", "SAR", "flooding"]);
// Space-only lists (where a term ends cannot be told): nothing.
assert.deepEqual(paperKeywords("Keywords Cloud computing Big data Analysis Platform 1. Introduction"), []);
// No keyword line: nothing; at most six terms, no duplicates.
assert.deepEqual(paperKeywords("A paper without the line."), []);
assert.equal(paperKeywords("Keywords: a1x; bbb; ccc; ddd; eee; fff; ggg; hhh").length, 6);
assert.deepEqual(paperKeywords("Keywords: water; Water; lakes"), ["water", "lakes"]);
// Stops before the received date or the corresponding author.
assert.deepEqual(paperKeywords("Keywords: altimetry, lakes Received 12 May 2020"), ["altimetry", "lakes"]);

console.log("keywords tests ok");
