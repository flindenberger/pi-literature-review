/**
 * Tests for the plain-text digest handed to the agent model.
 * Run: node src/digest.test.ts
 */

import assert from "node:assert/strict";
import type { ChatAnswer, ChatReport } from "./synthesis.ts";
import { MAX_DIGEST_RECORDS, renderChatDigest, renderChatReportDigest, renderDigest } from "./digest.ts";
import type { RenderPayload } from "./render.ts";

function record(overrides: Record<string, unknown>) {
	return {
		title: "A Paper",
		authors: ["A. Author"],
		year: "2021",
		venue: "Remote Sensing",
		doi: "10.1234/example",
		arxiv_id: "",
		pdf_url: "",
		url: "",
		cites: 3,
		abstract: "Not for the model's eyes.",
		sources: ["crossref"],
		verified: true,
		verify_note: "",
		...overrides,
	};
}

function payload(overrides: Partial<RenderPayload>): RenderPayload {
	return {
		query: "sandbar detection rivers Sentinel-1 Sentinel-2",
		generated: "2026-07-10T00:00:00Z",
		sources_used: ["arxiv", "crossref", "openalex"],
		grouping: null,
		filters: null,
		sort: null,
		results: [],
		dropped: [],
		...overrides,
	};
}

// Grouped run: counts, group labels, exact reference lines
{
	const digest = renderDigest(
		payload({
			grouping: [["river"], ["sandbar"]],
			results: [
				record({ doi: "10.3390/rs13081505", title: "Vistula Sandbars", group: "on_target" }),
				record({ doi: "10.1109/other", title: "Something Else", group: "adjacent", year: "2019" }),
			],
		}),
		"/data/queries/2026-07-10_q.html",
	);
	assert.ok(digest.startsWith("Discovery complete: 2 records (2 verified; 1 on_target, 1 adjacent), 0 dropped."));
	assert.ok(digest.includes("Query: sandbar detection rivers Sentinel-1 Sentinel-2"));
	assert.ok(digest.includes("Sources: arxiv, crossref, openalex"));
	assert.ok(!digest.includes("SOURCE FAILED")); // nothing failed here
	assert.ok(digest.includes("  /data/queries/2026-07-10_q.html"));
	// the JSON sidecar is agent infrastructure; its path stays out of the digest
	assert.ok(!digest.includes(".json"));
	assert.ok(!digest.toLowerCase().includes("payload"));
	assert.ok(digest.includes("open the HTML file to review and select papers"));
	assert.ok(digest.includes("1. [on_target] 2021 | 10.3390/rs13081505 | Vistula Sandbars"));
	assert.ok(digest.includes("2. [adjacent] 2019 | 10.1109/other | Something Else"));
	// no citation data beyond title/year/id leaks into the digest
	assert.ok(!digest.includes("A. Author"));
	assert.ok(!digest.includes("Not for the model's eyes"));
	assert.ok(!digest.includes("Remote Sensing"));
}

// Settings logging: grouping expression, filters and depth appear;
// the "user" audience card carries NO instructions aimed at the LLM
{
	const p = payload({
		grouping: [["water"], ["mask", "extraction"]],
		filters: { minCites: 5, yearFrom: 2022, authors: ["Kuenzer"] },
		per_source: 15,
		results: [record({ group: "adjacent" })],
	});
	const agent = renderDigest(p, "/x.html");
	assert.ok(agent.includes("Targeting: (water) AND (mask OR extraction)"));
	assert.ok(agent.includes("min. citations: 5"));
	assert.ok(agent.includes("year from: 2022"));
	assert.ok(agent.includes("authors: Kuenzer"));
	assert.ok(agent.includes("Records per source: 15"));
	assert.ok(agent.includes("Tell the user to open the HTML file"));
	assert.ok(agent.includes("Do not build your own table"));

	const user = renderDigest(p, "/x.html", "user");
	assert.ok(user.includes("Targeting: (water) AND (mask OR extraction)"));
	assert.ok(user.includes("Records per source: 15"));
	assert.ok(user.includes("Open it in a browser to review and select papers."));
	assert.ok(!user.includes("Tell the user"));
	assert.ok(!user.includes("Do not build your own table"));
	assert.ok(!user.includes("never re-type titles"));
	// the record lines themselves stay identical for both audiences
	assert.ok(user.includes("1. [adjacent] 2021 | 10.1234/example | A Paper"));

	// Per-query grouping lines on multi-query runs.
	const perQuery = renderDigest(payload({
		query_variants: ["(cnn OR deep learning) AND (river)"],
		grouping: [["water"], ["mask"]],
		grouping_by_query: [
			{ query: "water mask", groups: [["water"], ["mask"]] },
			{ query: "(cnn OR deep learning) AND (river)", groups: [["cnn", "deep learning"], ["river"]] },
		],
	}), "/x.html");
	assert.ok(perQuery.includes("Targeting Q1: (water) AND (mask)"));
	assert.ok(perQuery.includes("Targeting Q2: (cnn OR deep learning) AND (river)"));
	assert.ok(!perQuery.includes("labeled against Q1")); // any set labels
	assert.ok(!perQuery.includes("\nTargeting: ")); // the single line yields to the per-query form
	// v30.15: on the user card the HTML pointer sits BELOW the record list
	// (a 40-record run drowned it in the middle) and is a clickable file://
	// URL; the agent keeps the plain path ABOVE its record lines.
	assert.ok(user.includes("  file:///x.html"));
	assert.ok(user.indexOf("Full sortable table") > user.indexOf("1. [adjacent]"));
	assert.ok(!user.includes("  /x.html"));
	assert.ok(agent.includes("  /x.html"));
	assert.ok(!agent.includes("file:///x.html"));
	assert.ok(agent.indexOf("Full sortable table") < agent.indexOf("1. [adjacent]"));

	// write failure: the warning ends the user card too
	const failed = renderDigest(p, null, "user");
	assert.ok(failed.indexOf("WARNING: the output files could not be written")
		> failed.indexOf("1. [adjacent]"));
}

// Ungrouped run: no group bracket; UNVERIFIED flag; arXiv-ID fallback; n.d. year
{
	const digest = renderDigest(
		payload({
			results: [
				record({ doi: "", arxiv_id: "2403.19646v3", title: "Preprint" }),
				record({ verified: false, title: "Shaky", year: null }),
			],
		}),
		"/x.html",
	);
	assert.ok(digest.includes("Discovery complete: 2 records (1 verified), 0 dropped."));
	assert.ok(digest.includes("1. 2021 | arXiv:2403.19646v3 | Preprint"));
	assert.ok(digest.includes("2. [UNVERIFIED] n.d. | 10.1234/example | Shaky"));
}

// Dropped records: count plus pointer, no per-record dropped lines
{
	const digest = renderDigest(
		payload({
			results: [record({})],
			dropped: [
				{ reason: "empty title", record: record({ title: "" }) },
				{ reason: "keyword noise", record: record({ title: "Lymph Node" }) },
			],
		}),
		"/x.html",
	);
	assert.ok(digest.includes("2 dropped (reasons listed in the HTML file)"));
	assert.ok(!digest.includes("Lymph Node"));
}

// Query variants: Q1/Q2 labels
{
	const digest = renderDigest(
		payload({ query_variants: ["fluvial bar mapping Sentinel"], results: [record({})] }),
		"/x.html",
	);
	assert.ok(digest.includes("Query Q1: sandbar detection rivers Sentinel-1 Sentinel-2"));
	assert.ok(digest.includes("Query Q2: fluvial bar mapping Sentinel"));
}

// Empty result set stays honest; write failures are named
{
	const digest = renderDigest(payload({}), null);
	assert.ok(digest.includes("Discovery complete: 0 records (0 verified), 0 dropped."));
	assert.ok(digest.includes("No records survived filtering and verification."));
	assert.ok(digest.includes("WARNING: the output files could not be written"));
	assert.ok(!digest.includes("open the HTML file"));
}

// Safety cap: huge sweeps list at most MAX_DIGEST_RECORDS reference lines,
// with an honest note about the rest (Pi docs: tools must bound their output)
{
	const many = Array.from({ length: MAX_DIGEST_RECORDS + 23 }, (_, i) =>
		record({ doi: `10.1234/paper${i}`, title: `Paper ${i}` }));
	const digest = renderDigest(payload({ results: many }), "/tmp/x.html");
	assert.ok(digest.includes(`${MAX_DIGEST_RECORDS}. `));
	assert.ok(!digest.includes(`${MAX_DIGEST_RECORDS + 1}. `));
	assert.ok(digest.includes("and 23 more record(s) not listed here"));
	assert.ok(digest.includes(`Discovery complete: ${MAX_DIGEST_RECORDS + 23} records`)); // counts stay honest

	// small runs stay untouched
	const small = renderDigest(payload({ results: [record({})] }), "/tmp/x.html");
	assert.ok(!small.includes("more record(s) not listed here"));
}

/* ---------------- renderChatDigest ---------------- */

const chatAnswer: ChatAnswer = {
	question: "Wie funktioniert die Methode?",
	generated: "2026-07-16T10:00:00.000Z",
	model: "chat-model",
	embedding_model: "embed-model",
	backend: "ollama at http://127.0.0.1:11434",
	top_k: 8,
	grounded: true,
	prose: "Die Methode nutzt einen adaptiven Schwellwert [1].",
	references: [{
		n: 1, key: "doi:10.1234/abc", title: "River sandbar dynamics", authors: ["A. Author"],
		year: "2021", doi: "10.1234/abc", arxiv_id: "", pages: [2, 5], chunk_ids: [1, 2],
	}],
	chunks: [
		{ id: 1, page: 2, score: 0.91, text: "chunk one" },
		{ id: 2, page: 5, score: 0.83, text: "chunk two" },
	],
	sites: [],
	query_variants: [],
	lexical_terms: [],
	lexical_added: 0,
	invalid_markers: ["[9]"],
	unmarked_sentences: 0,
	stripped_reference_section: false,
	trimmed_chunks: 0,
	paper: {
		base: "a", key: "doi:10.1234/abc", title: "River sandbar dynamics", authors: ["A. Author"],
		year: "2021", doi: "10.1234/abc", arxiv_id: "", pdf_path: "/papers/a.pdf", verified: true,
	},
	papers: [{
		base: "a", key: "doi:10.1234/abc", title: "River sandbar dynamics", authors: ["A. Author"],
		year: "2021", doi: "10.1234/abc", arxiv_id: "", pdf_path: "/papers/a.pdf", verified: true,
	}],
	scope: ["a"],
	adopted_pdfs: [],
	adoption_failures: [],
	extraction_failures: [],
	raw_output: "raw",
	protocol_path: "/chats/2026-07-16_a.json",
	round: 1,
};

{
	const digest = renderChatDigest(chatAnswer);
	// The validated prose travels verbatim between explicit delimiters.
	assert.ok(digest.includes("--- answer (relay to the user EXACTLY as written, including [n] markers) ---"));
	assert.ok(digest.includes("Die Methode nutzt einen adaptiven Schwellwert [1]."));
	assert.ok(digest.includes("--- end answer ---"));
	// Paper line and the follow-up instruction.
	assert.ok(digest.includes("Paper: a.pdf -- 2021 | 10.1234/abc | River sandbar dynamics"));
	assert.ok(digest.includes('Pass paper: "a.pdf" on every follow-up call'));
	// Reference line carries the cited PDF pages.
	assert.ok(digest.includes("[1] 2021 | 10.1234/abc | River sandbar dynamics (p. 2, 5)"));
	// Integrity + protocol note; no HTML path in question mode.
	assert.ok(digest.includes("1 invalid citation marker(s) were stripped"));
	// v29: export wishes route to the /lit-synthesis command, never tool report mode.
	assert.ok(digest.includes("tell them to run the /lit-synthesis command"));
	assert.ok(!digest.includes("report: true"));
	assert.ok(!digest.includes(".html"));
	assert.ok(!digest.includes("FAILED"));
}

{
	// Card audience: the answer is already on screen as a
	// transcript card -- the instruction flips to a BRIEF direct answer.
	const digest = renderChatDigest(chatAnswer, "card");
	assert.ok(digest.includes("the user ALREADY SEES it in full as a card"));
	assert.ok(digest.includes("BRIEF direct answer"));
	assert.ok(digest.includes("do NOT repeat it in full"));
	assert.ok(!digest.includes("relay to the user EXACTLY"));
	// The verbatim prose and references still travel (context ground truth).
	assert.ok(digest.includes("Die Methode nutzt einen adaptiven Schwellwert [1]."));
	assert.ok(digest.includes("[1] 2021 | 10.1234/abc | River sandbar dynamics (p. 2, 5)"));
	// Ungrounded drafts never get the card instruction, whatever the audience.
	const draft = renderChatDigest({ ...chatAnswer, grounded: false, references: [], protocol_path: null, round: 0 }, "card");
	assert.ok(draft.includes("--- ungrounded draft (present ONLY together with the warning above) ---"));
}

{
	const digest = renderChatDigest({ ...chatAnswer, grounded: false, references: [], protocol_path: null, round: 0 });
	assert.ok(digest.startsWith("Paper chat answer FAILED to ground"));
	assert.ok(digest.includes("must NOT be presented as an answer"));
	// The draft is still inspectable, but unmistakably labeled.
	assert.ok(digest.includes("--- ungrounded draft (present ONLY together with the warning above) ---"));
	assert.ok(digest.includes("Die Methode nutzt einen adaptiven Schwellwert"));
	assert.ok(digest.includes("WARNING: the session protocol could not be written"));
}

{
	// Unverified paper: cited by filename, nothing bibliographic invented.
	const digest = renderChatDigest({
		...chatAnswer,
		paper: { ...chatAnswer.paper, verified: false, key: "file:report_x", base: "report_x", doi: "", title: "" },
		references: [{
			n: 1, key: "file:report_x", title: "", authors: [], year: null,
			doi: "", arxiv_id: "", pages: [3], chunk_ids: [1],
		}],
	});
	assert.ok(digest.includes("Paper: report_x.pdf -- UNVERIFIED (no bibliographic record; cited by filename and page)"));
	assert.ok(digest.includes("[1] report_x.pdf -- UNVERIFIED, cited by filename (p. 3)"));
	assert.ok(!digest.includes("n.d. |")); // no pseudo-bibliographic line
}

/* ---------------- renderChatReportDigest ---------------- */

const chatReport: ChatReport = {
	question: "Paper chat report: a.pdf",
	focus: "Validierung",
	session_questions: ["Frage eins?", "Frage zwei?"],
	generated: "2026-07-16T10:00:00.000Z",
	model: "chat-model",
	embedding_model: "embed-model",
	backend: "ollama at http://127.0.0.1:11434",
	grounded: true,
	prose: "Zusammenfassung [1].",
	references: chatAnswer.references,
	sites: [],
	chunks: chatAnswer.chunks,
	query_variants: [],
	lexical_terms: [],
	lexical_added: 0,
	invalid_markers: [],
	unmarked_sentences: 1,
	stripped_reference_section: false,
	trimmed_chunks: 0,
	paper: chatAnswer.paper,
	rounds: [{
		asked: "2026-07-16T09:00:00.000Z", question: "Frage eins?", language: null, model: "chat-model",
		session: null, top_k: 8, grounded: true, prose: "Antwort [1].", references: chatAnswer.references,
		cited_chunks: [], invalid_markers: [], unmarked_sentences: 0, stripped_reference_section: false,
	}],
	protocol_files: ["/chats/2026-07-16_a.json"],
	adopted_pdfs: [],
	adoption_failures: [],
	extraction_failures: [],
	raw_output: "raw",
};

{
	const digest = renderChatReportDigest(chatReport, "/chats/2026-07-16_Paper_chat_report_a.html");
	assert.ok(digest.startsWith("Paper chat report complete: 1 reference(s), 2 excerpt(s), built from 1 chat round(s)."));
	assert.ok(digest.includes("Paper: a.pdf -- 2021 | 10.1234/abc | River sandbar dynamics"));
	assert.ok(digest.includes("Focus: Validierung"));
	assert.ok(digest.includes("/chats/2026-07-16_Paper_chat_report_a.html"));
	assert.ok(digest.includes("open the HTML file"));
	assert.ok(digest.includes("[1] 2021 | 10.1234/abc | River sandbar dynamics (p. 2, 5)"));
	// The report digest never carries the prose.
	assert.ok(!digest.includes("Zusammenfassung [1]."));
}

{
	const digest = renderChatReportDigest({ ...chatReport, session_questions: [], rounds: [] }, null);
	assert.ok(digest.includes("built from the default question"));
	assert.ok(digest.includes("WARNING: the output files could not be written"));
}

{
	const digest = renderChatReportDigest({ ...chatReport, grounded: false, references: [] }, "/x.html");
	assert.ok(digest.startsWith("Paper chat report FAILED to ground"));
	assert.ok(digest.includes("must NOT be presented as a summary"));
}

// Source failures stay visible in the digest (v30.1: an arXiv timeout was
// invisible after the run -- the user could not tell a failed source from
// one that honestly found nothing).
{
	const digest = renderDigest(
		payload({
			sources_used: ["crossref", "openalex"],
			source_failures: [{ source: "arxiv", error: "The operation was aborted due to timeout" }],
			results: [record({})],
		}),
		"/data/queries/x.html",
	);
	assert.ok(digest.includes("Sources: crossref, openalex"));
	assert.ok(digest.includes(
		"SOURCE FAILED: arxiv -- The operation was aborted due to timeout (results may be incomplete)",
	));
	// Every source failed: the sources line stays honest instead of empty.
	const allFailed = renderDigest(
		payload({ sources_used: [], source_failures: [{ source: "arxiv", error: "boom" }] }),
		"/data/queries/x.html",
	);
	assert.ok(allFailed.includes("Sources: none"));
}

// Failed abstract lookups stay visible too (2026-08-20: a rate-limited
// Semantic Scholar pool was invisible after the run and its drops read as
// "the source has no abstract").
{
	const digest = renderDigest(
		payload({ abstract_lookup_failures: [{ source: "semanticscholar", error: "HTTP 429", records: 11 }] }),
		"/data/queries/x.html",
	);
	assert.ok(digest.includes(
		"ABSTRACT LOOKUP FAILED: semanticscholar -- HTTP 429 (11 record(s) dropped without abstract; their abstracts may exist -- rerun later or configure an API key)",
	));
	assert.ok(!renderDigest(payload({}), "/data/queries/x.html").includes("ABSTRACT LOOKUP FAILED"));
}

console.log("digest.test.ts: all assertions passed");
