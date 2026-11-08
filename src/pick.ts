/**
 * Picking papers of a finished search for download: the candidates (every
 * record with a DOI or arXiv ID, results first, dropped table after) and
 * the typed answer -- "all" (on-target papers), "code" (papers with a code
 * or data link), row numbers of the results table, or identifiers (the
 * report's copied "Download these papers: ..." line included). Shared by
 * the browser dialog and the /lit-search terminal dialog. Pure.
 */

import { identityKey } from "./pipeline.ts";
import { parseIdentifier } from "./selection.ts";

export interface Candidate {
	id: string;
	title: string;
	year: string | null;
	access: string | null;
	group: string | null;
	dropped: boolean;
	inLibrary: boolean;
	/** The record carries a code repository or a publisher data link. */
	code: boolean;
}

/** The record fields a candidate is read from. */
export interface CandidateRecord {
	doi: string;
	arxiv_id: string;
	title: string;
	year: string;
	access?: { level: string };
	group?: string;
	code_url?: string;
	data_links?: unknown[];
}

/** Candidates of a search payload; `libraryKeys` holds the identity keys
 * ("doi:..." / "arxiv:...") of the PDFs already in the library. */
export function candidatesFromRecords(
	results: CandidateRecord[],
	dropped: Array<{ record: CandidateRecord }>,
	libraryKeys: Set<string> = new Set(),
): Candidate[] {
	const rows = [
		...results.map((record) => ({ record, dropped: false })),
		...dropped.map((entry) => ({ record: entry.record, dropped: true })),
	];
	const out: Candidate[] = [];
	for (const { record, dropped: isDropped } of rows) {
		const id = record.doi || (record.arxiv_id ? `arXiv:${record.arxiv_id}` : "");
		if (!id) continue;
		const key = identityKey({ doi: record.doi, arxiv_id: record.arxiv_id ?? "" });
		out.push({
			id,
			title: record.title,
			year: record.year || null,
			access: record.access?.level ?? null,
			group: record.group ?? null,
			dropped: isDropped,
			inLibrary: key !== null && libraryKeys.has(key),
			code: Boolean(record.code_url || record.data_links?.length),
		});
	}
	return out;
}

export type PickAnswer = { kind: "all" } | { kind: "code" } | { kind: "ids"; ids: string[] } | { kind: "none" };

/** The paper-pick answer: "all" (on-target rows), "code" (rows with a
 * code or data link), row numbers of the results table, or identifiers. */
export function parsePickAnswer(text: string, candidates: Candidate[]): PickAnswer {
	const t = text.trim();
	if (!t) return { kind: "none" };
	const lower = t.toLowerCase();
	if (/^(all|all on-target|everything)$/.test(lower)) return { kind: "all" };
	if (/^(code|with code|papers with code)$/.test(lower)) return { kind: "code" };
	const results = candidates.filter((candidate) => !candidate.dropped);
	if (/^\d+(\s*[,;\s]\s*\d+)*$/.test(t)) {
		const ids = [...new Set(t.split(/[^\d]+/).filter(Boolean).map(Number))]
			.filter((n) => n >= 1 && n <= results.length)
			.map((n) => results[n - 1].id);
		return ids.length ? { kind: "ids", ids } : { kind: "none" };
	}
	const ids = t.replace(/^\s*download\s+these\s+papers\s*:?\s*/i, "").split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean)
		.map((part) => parseIdentifier(part))
		.filter((target) => target.kind !== "unknown")
		.map((target) => (target.kind === "arxiv" ? `arXiv:${target.id}` : target.id));
	return ids.length ? { kind: "ids", ids: [...new Set(ids)] } : { kind: "none" };
}

/** The identifiers an answer stands for: "all" and "code" leave out
 * papers already in the library; typed identifiers stand as given. */
export function pickedIds(answer: PickAnswer, candidates: Candidate[]): string[] {
	if (answer.kind === "all") return candidates.filter((candidate) => candidate.group === "on_target" && !candidate.inLibrary).map((candidate) => candidate.id);
	if (answer.kind === "code") return candidates.filter((candidate) => candidate.code && !candidate.inLibrary).map((candidate) => candidate.id);
	if (answer.kind === "ids") return answer.ids;
	return [];
}
