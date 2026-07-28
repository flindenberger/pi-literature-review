/**
 * Tests for the plain-text digest handed to the agent model.
 * Run: node src/digest.test.ts
 */

import assert from "node:assert/strict";
import type { ChatAnswer, ChatReport } from "./synthesize.ts";
import { MAX_DIGEST_RECORDS, renderChatDigest, renderChatReportDigest, renderDigest, renderSynthesisDigest } from "./digest.ts";
import type { RenderPayload } from "./render.ts";
import type { SynthesisResult } from "./synthesize.ts";

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

/* ---------------- renderSynthesisDigest ---------------- */

const synthesis: SynthesisResult = {
	question: "How are sandbars detected?",
	generated: "2026-07-15T12:00:00Z",
	model: "openscholar-8b",
	embedding_model: "nomic-embed-text",
	backend: "ollama at http://127.0.0.1:11434",
	top_k: 8,
	grounded: true,
	prose: "Detected [1]. Contracted [2].",
	references: [
		{ n: 1, key: "doi:10.1/x", title: "Paper One", authors: ["A B"], year: "2021",
			doi: "10.1/x", arxiv_id: "", pages: [2], chunk_ids: [1] },
		{ n: 2, key: "arxiv:2401.16393", title: "Paper Two", authors: [], year: null,
			doi: "", arxiv_id: "2401.16393", pages: [1], chunk_ids: [2] },
	],
	chunks: [
		{ id: 1, paper_key: "doi:10.1/x", title: "Paper One", page: 2, score: 0.9, text: "e1" },
		{ id: 2, paper_key: "arxiv:2401.16393", title: "Paper Two", page: 1, score: 0.5, text: "e2" },
	],
	invalid_markers: ["[9]"],
	unmarked_sentences: 0,
	stripped_reference_section: false,
	trimmed_chunks: 0,
	papers_matched: 2,
	papers_cited: 2,
	papers_uncited: [],
	adopted_pdfs: ["2020_Found_A_paper.pdf"],
	adoption_failures: [{ file: "alien_scan.pdf", reason: "no DOI or arXiv ID found on the first 2 pages" }],
	unmatched_pdfs: ["alien_scan.pdf"],
	extraction_failures: [],
	raw_output: "raw",
};

{
	const digest = renderSynthesisDigest(synthesis, "/root/reviews/2026-07-15_q.html");
	const lines = digest.split("\n");
	assert.equal(lines[0], "Synthesis complete: 2 reference(s) from 2 of 2 paper(s); 2 excerpt(s) retrieved.");
	assert.ok(digest.includes("Question: How are sandbars detected?"));
	assert.ok(digest.includes("/root/reviews/2026-07-15_q.html"));
	assert.ok(digest.includes("Tell the user to open the HTML file"));
	// The prose itself NEVER enters the digest -- structural anti-fabrication.
	assert.ok(!digest.includes("Detected [1]"));
	// Copyable reference lines, values verbatim.
	assert.ok(digest.includes("[1] 2021 | 10.1/x | Paper One"));
	assert.ok(digest.includes("[2] n.d. | arXiv:2401.16393 | Paper Two"));
	assert.ok(digest.includes("copy its line below EXACTLY"));
	// Honesty lines: adoption outcome and the per-file exclusion reason.
	assert.ok(digest.includes("1 invalid citation marker(s) were stripped"));
	assert.ok(digest.includes("Adopted 1 loose PDF(s)"));
	assert.ok(digest.includes("2020_Found_A_paper.pdf"));
	assert.ok(digest.includes("Excluded (no DOI or arXiv ID found on the first 2 pages): alien_scan.pdf"));
}

{
	// Ungrounded run leads with the failure; missing output path warns.
	const digest = renderSynthesisDigest(
		{ ...synthesis, grounded: false, references: [], papers_cited: 0 },
		null,
	);
	assert.ok(digest.startsWith("Synthesis FAILED to ground"));
	assert.ok(digest.includes("must NOT be presented as a literature review"));
	assert.ok(digest.includes("WARNING: the output files could not be written"));
	assert.ok(!digest.includes("[1]")); // no reference lines to copy
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
	invalid_markers: ["[9]"],
	unmarked_sentences: 0,
	stripped_reference_section: false,
	trimmed_chunks: 0,
	paper: {
		base: "a", key: "doi:10.1234/abc", title: "River sandbar dynamics", authors: ["A. Author"],
		year: "2021", doi: "10.1234/abc", arxiv_id: "", pdf_path: "/papers/a.pdf", verified: true,
	},
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
	assert.ok(digest.includes("[1] 2021 | 10.1234/abc | River sandbar dynamics (S. 2, 5)"));
	// Integrity + protocol note; no HTML path in question mode.
	assert.ok(digest.includes("1 invalid citation marker(s) were stripped"));
	// v29: export wishes route to the /lit-synth command, never tool report mode.
	assert.ok(digest.includes("tell them to run the /lit-synth command"));
	assert.ok(!digest.includes("report: true"));
	assert.ok(!digest.includes(".html"));
	assert.ok(!digest.includes("FAILED"));
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
	assert.ok(digest.includes("[1] report_x.pdf -- UNVERIFIED, cited by filename (S. 3)"));
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
	chunks: chatAnswer.chunks,
	invalid_markers: [],
	unmarked_sentences: 1,
	stripped_reference_section: false,
	trimmed_chunks: 0,
	paper: chatAnswer.paper,
	rounds: [{
		asked: "2026-07-16T09:00:00.000Z", question: "Frage eins?", language: null, model: "chat-model",
		top_k: 8, grounded: true, prose: "Antwort [1].", references: chatAnswer.references,
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
	assert.ok(digest.includes("[1] 2021 | 10.1234/abc | River sandbar dynamics (S. 2, 5)"));
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

console.log("digest.test.ts: all assertions passed");
