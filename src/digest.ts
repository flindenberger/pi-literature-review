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

import type { RenderPayload } from "./render.ts";

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
	results.forEach((record, index) => {
		const flags: string[] = [];
		if (grouped) flags.push(record.group ?? "-");
		if (!record.verified) flags.push("UNVERIFIED");
		const bracket = flags.length ? `[${flags.join(", ")}] ` : "";
		const year = record.year || "n.d.";
		lines.push(`${index + 1}. ${bracket}${year} | ${recordId(record)} | ${record.title}`);
	});

	return lines.join("\n");
}
