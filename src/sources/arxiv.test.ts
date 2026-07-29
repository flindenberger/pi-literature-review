/**
 * Tests for the pure arXiv query builder (v18 concept).
 * Run: node src/sources/arxiv.test.ts
 */

import assert from "node:assert/strict";
import { buildSearchQuery, retryDelayMs } from "./arxiv.ts";

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

// Author scope (v30.14 user decision): picked authors become an AND-linked
// au: clause so arXiv FETCHES their papers; both sides parenthesized so the
// clause composes with the legacy pass-through forms too. Without authors
// the expression stays byte-identical.
{
	assert.equal(
		buildSearchQuery("water mask", ["Claudia Kuenzer"]),
		'(all:water AND all:mask) AND (au:"Claudia Kuenzer")',
	);
	assert.equal(
		buildSearchQuery("water mask", ["Kuenzer", "Mahdianpari"]),
		'(all:water AND all:mask) AND (au:"Kuenzer" OR au:"Mahdianpari")',
	);
	// Legacy pass-through (user's own operators) still gets the clause.
	assert.equal(
		buildSearchQuery('ti:"water mask" AND cat:eess.IV', ["Kuenzer"]),
		'(all:ti:"water mask" AND cat:eess.IV) AND (au:"Kuenzer")',
	);
	// Quotes/pipes/commas in a name cannot break the expression syntax.
	assert.equal(
		buildSearchQuery("water mask", ['Kuenzer, "C." |']),
		'(all:water AND all:mask) AND (au:"Kuenzer C.")',
	);
	// No usable names -> unchanged expression.
	assert.equal(buildSearchQuery("water mask", []), "all:water AND all:mask");
	assert.equal(buildSearchQuery("water mask", ["  "]), "all:water AND all:mask");
}

// Rate-limit backoff (v30.13, field 2026-07-29: consecutive wizard runs hit
// arXiv 429 on every search): fixed delays, a sane Retry-After header wins,
// a huge or exhausted one gives up.
{
	assert.equal(retryDelayMs(0, null), 5_000);
	assert.equal(retryDelayMs(1, null), 15_000);
	assert.equal(retryDelayMs(2, null), null); // attempts used up
	assert.equal(retryDelayMs(0, "7"), 7_000); // header wins
	assert.equal(retryDelayMs(0, "0"), 5_000); // zero: fall back to the fixed delay
	assert.equal(retryDelayMs(0, "3600"), null); // "come back in an hour": not worth blocking
	assert.equal(retryDelayMs(0, "soon"), 5_000); // non-numeric header ignored
	assert.equal(retryDelayMs(2, "7"), null); // header never revives used-up attempts
}

console.log("arxiv.test.ts: all assertions passed");
