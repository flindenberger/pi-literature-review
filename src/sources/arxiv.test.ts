/**
 * Tests for the pure arXiv query builder.
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
// word it drops out of the expression entirely.
{
	assert.equal(buildSearchQuery("sandbar or shoal"), "all:sandbar AND all:shoal");
}

// Function words never become AND clauses (arXiv's
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

// Author scope: picked authors become an AND-linked
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

// Concept blocks: OR clauses per block, AND
// between blocks, phrases quoted; authors compose; blocks win over the
// token derivation.
{
	assert.equal(
		buildSearchQuery("ignored text", undefined, [["river", "stream"], ["water extraction"], ["satellite"]]),
		'(all:river OR all:stream) AND all:"water extraction" AND all:satellite',
	);
	// Author clause composes around the block expression .
	assert.equal(
		buildSearchQuery("x", ["Kuenzer"], [["river"], ["mask"]]),
		'(all:river AND all:mask) AND (au:"Kuenzer")',
	);
	// Embedded quotes are stripped, terms lowercased; empty groups drop.
	assert.equal(
		buildSearchQuery("x", undefined, [['"Water Mask"'], [], ["  "]]),
		'all:"water mask"',
	);
	// No blocks -> the old paths are untouched.
	assert.equal(
		buildSearchQuery("sentinel 2 sandbar", undefined, []),
		'all:"sentinel 2" AND all:sandbar',
	);
}

console.log("arxiv.test.ts: all assertions passed");
