/**
 * Deterministic plain-text digests -- what the agent model receives as a
 * tool result, and what the terminal card shows, after a search, a paper
 * chat round or a report.
 *
 * Handing a full JSON payload to a small model invites it to re-type and
 * "complete" citation data (fabricated tables, invented page numbers). The
 * fix is structural: the model never sees abstracts, authors or venues. It
 * gets counts, the HTML path and one copyable reference line per record;
 * the full data lives in the HTML/JSON files on disk. The JSON sidecar path
 * stays out of the digest (small models echo it at the user). The one
 * exception is the paper-chat answer, whose validated prose must reach the
 * terminal and therefore travels between explicit delimiters.
 */

import { pathToFileURL } from "node:url";
import { describeFilters, describeGrouping, type RenderPayload } from "./render.ts";
import type { ChatAnswer, ChatReport, ReferenceEntry, SynthReport } from "./synthesis.ts";

/** Safety cap (Pi docs: tools must bound their own output). An exhaustive
 * multi-variant sweep can yield hundreds of records; the digest lists at
 * most this many reference lines and says honestly how many more exist --
 * the complete list is always in the HTML/JSON files anyway. */
export const MAX_DIGEST_RECORDS = 100;

/** "10.3390/rs13081505" | "arXiv:2403.19646v3" | "no identifier". */
function recordId(record: { doi: string; arxiv_id: string }): string {
	if (record.doi) return record.doi;
	if (record.arxiv_id) return `arXiv:${record.arxiv_id}`;
	return "no identifier";
}

/**
 * The search digest speaks to two audiences: "agent" (default) is the tool
 * result and carries the handling instructions for the model; "user" is the
 * /lit-search transcript card -- same facts, but instructions TO an LLM
 * have no business in front of the user.
 */
export function renderDigest(
	payload: RenderPayload,
	htmlPath: string | null,
	audience: "agent" | "user" = "agent",
): string {
	const results = payload.results;
	const grouped = payload.grouping !== null && payload.grouping !== undefined;
	const verified = results.filter((r) => r.verified).length;
	const onTarget = results.filter((r) => r.group === "on_target").length;

	const groupPart = grouped ? `; ${onTarget} on_target, ${results.length - onTarget} adjacent` : "";
	const droppedPart = payload.dropped.length
		? `, ${payload.dropped.length} dropped (reasons listed in the HTML file)`
		: ", 0 dropped";

	const lines: string[] = [];
	lines.push(
		`Discovery complete: ${results.length} records (${verified} verified${groupPart})${droppedPart}.`,
	);
	const variants = payload.query_variants ?? [];
	if (variants.length) {
		lines.push(`Query Q1: ${payload.query}`);
		variants.forEach((variant, index) => lines.push(`Query Q${index + 2}: ${variant}`));
	} else {
		lines.push(`Query: ${payload.query}`);
	}
	lines.push(`Sources: ${payload.sources_used.join(", ") || "none"}`);
	// A failed source is a fact about this run, not transient chrome: the
	// agent and the user must both see that results may be incomplete and
	// which source to blame.
	for (const failure of payload.source_failures ?? []) {
		lines.push(`SOURCE FAILED: ${failure.source} -- ${failure.error} (results may be incomplete)`);
	}
	// A failed abstract lookup is equally a fact about the run: its records
	// sit in the dropped table although their abstracts may exist.
	for (const failure of payload.abstract_lookup_failures ?? []) {
		lines.push(`ABSTRACT LOOKUP FAILED: ${failure.source} -- ${failure.error} (${failure.records} record(s) dropped without abstract; their abstracts may exist -- rerun later or configure an API key)`);
	}
	// What was actually asked for -- same wording as the HTML meta block,
	// from the same functions. Multi-query runs label per query.
	const groupingByQuery = payload.grouping_by_query ?? [];
	if (groupingByQuery.length) {
		groupingByQuery.forEach((entry, index) => lines.push(`Targeting Q${index + 1}: ${entry.groups?.length
			? describeGrouping(entry.groups)
			: "(no blocks -- query passed through unchanged)"}`));
	} else {
		lines.push(`Targeting: ${describeGrouping(payload.grouping)}`);
	}
	lines.push(`User filters: ${describeFilters(payload.filters)}`);
	if (payload.per_source) lines.push(`Records per source: ${payload.per_source}`);
	// The HTML pointer: on the user card it sits BELOW the record list (on
	// a long run a mid-card link drowns) and becomes a file:// URL, which
	// terminals linkify for right-click -> open. The agent keeps the plain
	// path up front, next to its handling instructions.
	const htmlBlock: string[] = [];
	if (htmlPath) {
		htmlBlock.push("Full sortable table (abstracts, links, dropped list):");
		htmlBlock.push(`  ${audience === "user" ? pathToFileURL(htmlPath).href : htmlPath}`);
		htmlBlock.push(audience === "agent"
			? "Tell the user to open the HTML file to review and select papers."
			: "Open it in a browser to review and select papers.");
	} else {
		htmlBlock.push("WARNING: the output files could not be written (see diagnostics).");
	}
	if (audience === "agent") {
		lines.push(...htmlBlock);
		lines.push(
			"When referring to a record, copy its line below EXACTLY; never re-type titles,",
			"authors or identifiers from memory. Do not build your own table and do not add",
			"key findings, methodology advice, next steps or deliverables.",
		);
	}
	lines.push("");

	if (!results.length) {
		lines.push("No records survived filtering and verification.");
	}
	results.slice(0, MAX_DIGEST_RECORDS).forEach((record, index) => {
		const flags: string[] = [];
		if (grouped) flags.push(record.group ?? "-");
		if (!record.verified) flags.push("UNVERIFIED");
		const bracket = flags.length ? `[${flags.join(", ")}] ` : "";
		const year = record.year || "n.d.";
		lines.push(`${index + 1}. ${bracket}${year} | ${recordId(record)} | ${record.title}`);
	});
	if (results.length > MAX_DIGEST_RECORDS) {
		lines.push(
			`... and ${results.length - MAX_DIGEST_RECORDS} more record(s) not listed here -- `
			+ "the complete list is in the HTML and JSON files.",
		);
	}
	if (audience === "user") {
		lines.push("");
		lines.push(...htmlBlock);
	}

	return lines.join("\n");
}

/**
 * Retrieval transparency: the disclosed English query variant(s) and the
 * lexical exact-match layer. The variant is the ONE place an LLM shapes
 * retrieval -- shown wherever the result is shown; citations are unaffected.
 */
function pushRetrievalLines(
	lines: string[],
	result: { query_variants?: Array<{ query: string; kind: string }>; lexical_terms?: string[]; lexical_added?: number },
): void {
	const english = (result.query_variants ?? []).filter((variant) => variant.kind === "english");
	if (english.length) {
		lines.push(`Retrieval also used the English query variant(s): ${english.map((v) => v.query).join("; ")}`);
	}
	if (result.lexical_terms?.length) {
		lines.push(`Lexical layer exact-matched: ${result.lexical_terms.join(", ")}`
			+ (result.lexical_added
				? ` -- ${result.lexical_added} excerpt(s) guaranteed in the prompt`
				: " -- no additional excerpts"));
	}
}

/* ---------------- paper chat (pi-literature-synthesis chat mode) ---------------- */

/** Reference line with the cited PDF pages: "[1] 2021 | 10.x/y | Title
 * (p. 2, 5)"; the pages refer to the local PDF. A paper without a verified
 * record (key "file:...") is cited by filename only -- honestly, with no
 * bibliographic fields to fabricate. */
function referenceLine(reference: ReferenceEntry): string {
	const pages = reference.pages.length ? ` (p. ${reference.pages.join(", ")})` : "";
	if (reference.key.startsWith("file:")) {
		return `[${reference.n}] ${reference.key.slice(5)}.pdf -- UNVERIFIED, cited by filename${pages}`;
	}
	const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
	const year = reference.year || "n.d.";
	return `[${reference.n}] ${year} | ${id} | ${reference.title}${pages}`;
}

function paperLine(paper: ChatAnswer["paper"]): string {
	if (!paper.verified) {
		return `Paper: ${paper.base}.pdf -- UNVERIFIED (no bibliographic record; cited by filename and page)`;
	}
	const id = paper.doi || (paper.arxiv_id ? `arXiv:${paper.arxiv_id}` : paper.key);
	return `Paper: ${paper.base}.pdf -- ${paper.year || "n.d."} | ${id} | ${paper.title}`;
}

/**
 * Digest of one paper-chat answer -- the ONE digest that carries prose: a
 * chat answer must reach the user in the terminal, so the code-validated
 * prose travels between explicit delimiters with the instruction to relay
 * it unchanged. The protocol file on disk always keeps the validated ground
 * truth, so even a paraphrasing agent cannot corrupt the record the report
 * is built from.
 *
 * audience "card": the answer is ALREADY on screen as a transcript card --
 * the instruction flips from relay-verbatim to a BRIEF direct answer (the
 * card stays the ground truth; a full repeat would double the text).
 */
export function renderChatDigest(answer: ChatAnswer, audience: "relay" | "card" = "relay"): string {
	const lines: string[] = [];
	if (answer.grounded) {
		lines.push(
			`Paper chat answer: ${answer.references.length} reference(s), `
			+ `${answer.chunks.length} excerpt(s) retrieved from one paper.`,
		);
	} else {
		lines.push(
			"Paper chat answer FAILED to ground: the model produced no valid citations. The draft below "
			+ "must NOT be presented as an answer. Relay this warning and the draft verbatim and ask the "
			+ "user how to proceed (rephrase the question, try another model).",
		);
	}
	const scopePapers = answer.papers ?? [answer.paper];
	if (scopePapers.length > 1 || answer.scope === "library") {
		lines.push(`Scope: ${answer.scope === "library" ? "whole library" : `${scopePapers.length} documents`}`
			+ ` (${scopePapers.map((paper) => `${paper.base}.pdf`).join(", ")})`);
		lines.push("The scope is remembered for this session -- pass only the question on follow-up calls.");
	} else {
		lines.push(paperLine(answer.paper));
		lines.push(`Pass paper: "${answer.paper.base}.pdf" on every follow-up call about this paper.`);
	}
	pushRetrievalLines(lines, answer);
	const label = !answer.grounded
		? "ungrounded draft (present ONLY together with the warning above)"
		: audience === "card"
			? "validated answer -- the user ALREADY SEES it in full as a card. Reply with a BRIEF direct "
				+ "answer (2-4 sentences) drawn ONLY from this answer; do NOT repeat it in full; do NOT "
				+ "mention file paths; copy a reference line verbatim if you cite"
			: "answer (relay to the user EXACTLY as written, including [n] markers)";
	lines.push(`--- ${label} ---`);
	lines.push(answer.prose);
	lines.push("--- end answer ---");
	for (const reference of answer.references) {
		lines.push(referenceLine(reference));
	}
	if (answer.references.length) {
		lines.push("When referring to the paper, copy a reference line above EXACTLY; never re-type titles or identifiers.");
	}
	if (answer.invalid_markers.length) {
		lines.push(`Integrity: ${answer.invalid_markers.length} invalid citation marker(s) were stripped from the answer.`);
	}
	if (answer.stripped_reference_section) {
		lines.push("Integrity: a model-written reference section was cut; references come from verified records only.");
	}
	if (answer.protocol_path) {
		lines.push(
			"The validated Q&A round was recorded in the session protocol on disk. "
			+ "When the user wants a summary report OR any HTML/file/export of this chat "
			+ "('mach mir eine html', 'save this', 'export'): tell them to run the /lit-synthesis command -- "
			+ "NEVER write an HTML or any other file about this paper yourself.",
		);
	} else {
		lines.push("WARNING: the session protocol could not be written (see diagnostics); a report will not include this round.");
	}
	return lines.join("\n");
}

/**
 * Digest of a paper-chat report -- back to the synthesis philosophy: NO
 * prose (the report lives in the HTML file), counts, the HTML path and
 * copyable reference lines only.
 */
export function renderChatReportDigest(report: ChatReport, htmlPath: string | null): string {
	const lines: string[] = [];
	if (report.grounded) {
		lines.push(
			`Paper chat report complete: ${report.references.length} reference(s), ${report.chunks.length} excerpt(s), `
			+ (report.session_questions.length
				? `built from ${report.rounds.length} chat round(s).`
				: "built from the default question (no chat rounds recorded)."),
		);
	} else {
		lines.push(
			"Paper chat report FAILED to ground: the model produced no valid citations. The draft was saved "
			+ "for inspection but must NOT be presented as a summary. Relay this to the user and ask how to "
			+ "proceed (chat about the paper first, or try another model).",
		);
	}
	lines.push(paperLine(report.paper));
	if (report.focus) lines.push(`Focus: ${report.focus}`);
	pushRetrievalLines(lines, report);
	if (htmlPath) {
		lines.push("Full report (summary, references, excerpts, chat protocol):");
		lines.push(`  ${htmlPath}`);
		lines.push("Tell the user to open the HTML file to read the report.");
	} else {
		lines.push("WARNING: the output files could not be written (see diagnostics).");
	}
	if (report.invalid_markers.length) {
		lines.push(`Integrity: ${report.invalid_markers.length} invalid citation marker(s) were stripped from the summary.`);
	}
	if (report.stripped_reference_section) {
		lines.push("Integrity: a model-written reference section was cut; references come from verified records only.");
	}
	if (report.references.length) {
		lines.push(
			"When referring to a reference, copy its line below EXACTLY; never re-type titles,",
			"authors or identifiers from memory. Do not quote or summarize the report prose;",
			"point the user at the HTML file instead.",
		);
		lines.push("");
		for (const reference of report.references) {
			lines.push(referenceLine(reference));
		}
	}
	return lines.join("\n");
}

/**
 * Digest of a composable report -- counts, the HTML path and copyable
 * reference lines; the prose lives in the HTML.
 */
export function renderReportDigest(
	report: SynthReport,
	htmlPath: string | null,
	htmlSkipped = false,
): string {
	const lines: string[] = [];
	const counts: string[] = [];
	const summaries = report.units.filter((unit) => unit.kind === "summary").length;
	const details = report.units.filter((unit) => unit.kind.startsWith("detail")).length;
	if (summaries) counts.push(`${summaries} summar${summaries === 1 ? "y" : "ies"}`);
	if (details) counts.push(`${details} question answer(s), mode ${report.detail_mode === "cross-paper" ? "B (cross-paper)" : "A (per paper)"}`);
	if (report.include_review) counts.push("1 review synthesis");
	if (report.grounded) {
		lines.push(`Report complete over ${report.papers.length} document(s): ${counts.join(", ")}; `
			+ `${report.references.length} reference(s).`);
	} else {
		lines.push(
			"Report FAILED to ground in at least one unit: the model produced no valid citations there. "
			+ "The report was saved for inspection but the affected sections must NOT be presented as "
			+ "evidenced statements. Relay this to the user.",
		);
	}
	lines.push(`Scope: ${report.scope.library ? "whole library" : report.scope.papers.map((base) => `${base}.pdf`).join(", ")}`);
	for (const question of report.questions) lines.push(`Question: ${question}`);
	const english = [...new Set(report.units.flatMap((unit) =>
		unit.query_variants.filter((variant) => variant.kind === "english").map((variant) => variant.query)))];
	if (english.length) lines.push(`Retrieval also used the English query variant(s): ${english.join("; ")}`);
	if (htmlPath) {
		lines.push("Full report (summaries, answers, cited passages, method notes):");
		lines.push(`  ${htmlPath}`);
		lines.push("Tell the user to open the HTML file to read the report.");
	} else if (htmlSkipped) {
		lines.push("No HTML written (the user chose not to save one).");
	} else {
		lines.push("WARNING: the output files could not be written (see diagnostics).");
	}
	if (report.references.length) {
		lines.push(
			"When referring to a reference, copy its line below EXACTLY; never re-type titles,",
			"authors or identifiers from memory. Do not quote or summarize the report prose;",
			"point the user at the HTML file instead.",
		);
		lines.push("");
		for (const reference of report.references) {
			lines.push(referenceLine(reference));
		}
	}
	return lines.join("\n");
}
