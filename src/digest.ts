/**
 * Deterministic plain-text digest of a discovery payload -- the ONLY thing
 * the agent model receives as tool result.
 *
 * A live field test (2026-07-10, IBM Granite) showed that handing the full
 * JSON payload to a small model invites it to re-type and "complete" citation
 * data: fabricated tables, invented page numbers, reformatted author names.
 * The fix is structural, not instructional: the model never sees abstracts,
 * authors or venues at all. It gets counts, the HTML path and one copyable
 * reference line per record; the full data lives in the HTML/JSON files on
 * disk. The JSON sidecar path deliberately stays out of the digest (second
 * field test: a small model echoes it at the user, whom it does not concern);
 * the tool description tells the agent the sidecar sits next to the HTML.
 */

import type { ChatAnswer, ChatReport } from "./chat.ts";
import type { RenderPayload } from "./render.ts";
import type { ReferenceEntry, SynthesisResult } from "./synthesize.ts";

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

export function renderDigest(payload: RenderPayload, htmlPath: string | null): string {
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
	lines.push(`Sources: ${payload.sources_used.join(", ")}`);
	if (htmlPath) {
		lines.push("Full sortable table (abstracts, links, dropped list):");
		lines.push(`  ${htmlPath}`);
		lines.push("Tell the user to open the HTML file to review and select papers.");
	} else {
		lines.push("WARNING: the output files could not be written (see diagnostics).");
	}
	lines.push(
		"When referring to a record, copy its line below EXACTLY; never re-type titles,",
		"authors or identifiers from memory. Do not build your own table and do not add",
		"key findings, methodology advice, next steps or deliverables.",
	);
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

	return lines.join("\n");
}

/**
 * Digest of a synthesis run -- same philosophy as the discovery digest: the
 * agent model gets counts, the HTML path and copyable reference lines, but
 * NEVER the synthesized prose itself (it would re-type or "improve" it; the
 * review lives in the HTML file). An ungrounded run leads with the failure
 * so no model can present the draft as a finished review.
 */
export function renderSynthesisDigest(result: SynthesisResult, htmlPath: string | null): string {
	const lines: string[] = [];
	if (result.grounded) {
		lines.push(
			`Synthesis complete: ${result.references.length} reference(s) from ${result.papers_cited} `
			+ `of ${result.papers_matched} paper(s); ${result.chunks.length} excerpt(s) retrieved.`,
		);
	} else {
		lines.push(
			"Synthesis FAILED to ground: the model produced no valid citations. The draft was saved "
			+ "for inspection but must NOT be presented as a literature review. Relay this to the user "
			+ "and ask how to proceed (rephrase the question, change the paper selection or model).",
		);
	}
	lines.push(`Question: ${result.question}`);
	if (htmlPath) {
		lines.push("Full review (prose, references, excerpts, method notes):");
		lines.push(`  ${htmlPath}`);
		lines.push("Tell the user to open the HTML file to read the review.");
	} else {
		lines.push("WARNING: the output files could not be written (see diagnostics).");
	}
	if (result.invalid_markers.length) {
		lines.push(`Integrity: ${result.invalid_markers.length} invalid citation marker(s) were stripped from the prose.`);
	}
	if (result.stripped_reference_section) {
		lines.push("Integrity: a model-written reference section was cut; references come from verified records only.");
	}
	if (result.adopted_pdfs.length) {
		lines.push(
			`Adopted ${result.adopted_pdfs.length} loose PDF(s) into the corpus (identifier found in the `
			+ `PDF text, metadata from a verified API lookup): ${result.adopted_pdfs.join(", ")}`,
		);
	}
	const adoptionReasons = new Map(result.adoption_failures.map((failure) => [failure.file, failure.reason]));
	for (const file of result.unmatched_pdfs) {
		lines.push(`Excluded (${adoptionReasons.get(file) ?? "no verified record"}): ${file}`);
	}
	for (const failure of result.extraction_failures) {
		lines.push(`Excluded (${failure.reason}): ${failure.file}`);
	}
	if (result.references.length) {
		lines.push(
			"When referring to a reference, copy its line below EXACTLY; never re-type titles,",
			"authors or identifiers from memory. Do not quote or summarize the review prose;",
			"point the user at the HTML file instead.",
		);
		lines.push("");
		for (const reference of result.references) {
			const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
			const year = reference.year || "n.d.";
			lines.push(`[${reference.n}] ${year} | ${id} | ${reference.title}`);
		}
	}
	return lines.join("\n");
}

/* ---------------- paper chat (pi-literature-chat) ---------------- */

/** Reference line with the cited PDF pages: "[1] 2021 | 10.x/y | Title
 * (S. 2, 5)". "S." (Seite) by user decision -- the chat's audience reads
 * German; the pages refer to the local PDF. A paper without a verified
 * record (key "file:...") is cited by filename only -- honestly, with no
 * bibliographic fields to fabricate. */
function referenceLine(reference: ReferenceEntry): string {
	const pages = reference.pages.length ? ` (S. ${reference.pages.join(", ")})` : "";
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
 * Digest of one paper-chat answer -- the ONE digest that carries prose,
 * a deliberate exception to the doctrine above: a chat answer must reach
 * the user in the terminal, so the code-validated prose travels between
 * explicit delimiters with the instruction to relay it unchanged. The
 * protocol file on disk always keeps the validated ground truth, so even
 * a paraphrasing agent cannot corrupt the record the report is built from.
 */
export function renderChatDigest(answer: ChatAnswer): string {
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
	lines.push(paperLine(answer.paper));
	lines.push(`Pass paper: "${answer.paper.base}.pdf" on every follow-up call about this paper.`);
	const label = answer.grounded
		? "answer (relay to the user EXACTLY as written, including [n] markers)"
		: "ungrounded draft (present ONLY together with the warning above)";
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
			"The validated Q&A round was recorded in the session protocol on disk; "
			+ "call with report: true when the user wants a summary report of the session.",
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
