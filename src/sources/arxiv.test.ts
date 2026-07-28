/**
 * Tests for the pure arXiv query builder (v18 concept).
 * Run: node src/sources/arxiv.test.ts
 */

import assert from "node:assert/strict";
import { buildSearchQuery } from "./arxiv.ts";

// Standalone single character binds to the PREVIOUS word as a phrase;
// remaining words are AND-linked (the ALOHA 2 fix).
{
	assert.equal(
		buildSearchQuery("Sentinel 2 sandbar detection"),
		'all:"sentinel 2" AND all:sandbar AND all:detection',
	);
}

// Plain multi-word query: every word its own AND unit.
{
	assert.equal(
		buildSearchQuery("river sandbar monitoring"),
		"all:river AND all:sandbar AND all:monitoring",
	);
}

// Hyphenated sensor name has no standalone single character; nothing to bind.
{
	assert.equal(
		buildSearchQuery("Sentinel-2 sandbar detection"),
		"all:sentinel-2 AND all:sandbar AND all:detection",
	);
}

// Leading single character has no previous word; binds to the FOLLOWING word.
{
	assert.equal(buildSearchQuery("2 sandbar detection"), 'all:"2 sandbar" AND all:detection');
}

// Several leading single characters chain onto the first word.
{
	assert.equal(buildSearchQuery("s 2 sandbar"), 'all:"s 2 sandbar"');
}

// Single-word query stays a single unit.
{
	assert.equal(buildSearchQuery("sandbar"), "all:sandbar");
}

// Pass-through: explicit uppercase operators are the user's own syntax.
{
	assert.equal(buildSearchQuery("sandbar OR shoal"), "all:sandbar OR shoal");
	assert.equal(buildSearchQuery("sandbar ANDNOT beach"), "all:sandbar ANDNOT beach");
}

// Pass-through: quoted phrases are the user's own syntax (case preserved).
{
	assert.equal(buildSearchQuery('"river bar" detection'), 'all:"river bar" detection');
}

// Lowercase "or" is no operator (no pass-through) -- and as a function
// word it drops out of the expression entirely (v30.1).
{
	assert.equal(buildSearchQuery("sandbar or shoal"), "all:sandbar AND all:shoal");
}

// Function words never become AND clauses (v30.1 field finding: arXiv's
// backend hung for 60s / answered 429 on `all:using`; the same expression
// without it answered within seconds).
{
	assert.equal(
		buildSearchQuery("Water Mask Extraction Using Sentinel 2"),
		'all:water AND all:mask AND all:extraction AND all:"sentinel 2"',
	);
	assert.equal(
		buildSearchQuery("Erkennung von Sandbänken in Flüssen"),
		"all:erkennung AND all:sandbänken AND all:flüssen",
	);
	// Nothing but function words: legacy pass-through, never an empty query.
	assert.equal(buildSearchQuery("of the"), "all:of the");
}

// Degenerate query of only single characters: nothing to anchor on, legacy form.
{
	assert.equal(buildSearchQuery("s 2"), "all:s 2");
}

// Whitespace runs collapse; surrounding whitespace is trimmed.
{
	assert.equal(buildSearchQuery("  Sentinel   2  "), 'all:"sentinel 2"');
}

console.log("arxiv.test.ts: all assertions passed");
