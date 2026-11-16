/**
 * Snowball search (citation searching): from chosen seed papers, follow
 * their citation links at OpenAlex -- backward to the works they cite
 * (their reference lists), forward to the works that cite them. One round
 * per call; the caller picks the seeds.
 *
 * Every request is an exact OpenAlex filter (doi:, ids.openalex:, cites:),
 * one credit each (measured 2026-11-15: 3 seeds -> 217 candidates, 7
 * requests, 4.5 s). Each found record carries its provenance in
 * `snowball` ("references of: Lee 2021", "cites: Lee 2021"); the search
 * engine then runs it through the same gates as every other record
 * (dedupe, abstract gate, topic gate, filters). No language model.
 */

import { arxivIdOfWork, toSourceRecord, worksPage } from "./sources/openalex.ts";
import type { SourceRecord } from "./types.ts";

export type SnowballDirection = "both" | "back" | "forward";

/** Citing works fetched per seed at most, the most cited first: a classic
 * with thousands of citations would otherwise take dozens of requests and
 * flood the list. */
export const MAX_CITING_PER_SEED = 200;
/** Ids per OpenAlex OR filter (and per page). */
const ID_BATCH = 50;
/** Seeds per run (one cites: request each). */
export const MAX_SEEDS = 25;

/** Fields every work request asks for: what toSourceRecord maps, the
 * reference list, and the locations (arXiv id). */
const SELECT = "id,doi,title,publication_year,publication_date,cited_by_count,authorships,primary_location,open_access,abstract_inverted_index,referenced_works,locations,type";

export interface SnowballDeps {
	worksPage: typeof worksPage;
}

export interface SnowballResult {
	records: SourceRecord[];
	/** Seeds found at OpenAlex, as "Lee 2021". */
	seeds: string[];
	/** Seed identifiers OpenAlex does not know. */
	missing: string[];
	/** Distinct works per direction before any gate. */
	backward: number;
	forward: number;
	requests: number;
}

const shortId = (id: unknown): string => String(id ?? "").split("/").pop() ?? "";

/** "Lee 2021" from a work: first author's surname and year. Pure. */
export function seedLabel(work: Record<string, any>): string {
	const name = String(work?.authorships?.[0]?.author?.display_name ?? "").trim();
	const surname = name.split(/\s+/).pop() ?? "";
	const year = Number.isInteger(work?.publication_year) ? String(work.publication_year) : "n.d.";
	return surname ? `${surname} ${year}` : `${String(work?.title ?? shortId(work?.id)).slice(0, 40)} (${year})`;
}

/** Seed identifiers -> DOIs to ask OpenAlex: DOIs as given (prefix
 * removed, lower case), arXiv ids as their DataCite DOI. Pure. */
export function seedDois(seeds: string[]): Array<{ seed: string; doi: string; arxiv: string }> {
	const out: Array<{ seed: string; doi: string; arxiv: string }> = [];
	for (const raw of seeds) {
		const seed = raw.trim();
		const doi = seed.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
		if (/^10\.\d{4,9}\/\S+$/.test(doi)) {
			out.push({ seed, doi, arxiv: "" });
			continue;
		}
		const arxiv = /^(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(seed)?.[1];
		if (arxiv) out.push({ seed, doi: `10.48550/arxiv.${arxiv}`, arxiv });
	}
	return out;
}

/** A work -> record with source "snowball", arXiv id from its locations. */
function toRecord(work: Record<string, any>, provenance: string[]): SourceRecord {
	const arxiv = arxivIdOfWork(work);
	return { ...toSourceRecord(work), ...(arxiv ? { arxiv_id: arxiv } : {}), source: "snowball", snowball: provenance };
}

export async function runSnowball(
	seeds: string[],
	direction: SnowballDirection,
	options: { signal?: AbortSignal; warn?: (message: string) => void; deps?: Partial<SnowballDeps> } = {},
): Promise<SnowballResult> {
	const d: SnowballDeps = { worksPage, ...(options.deps ?? {}) };
	const aborted = () => {
		if (options.signal?.aborted) throw new Error("search aborted by the user");
	};
	let requests = 0;
	const page = async (filter: string, perPage: number, sort?: string) => {
		aborted();
		requests++;
		return d.worksPage(filter, SELECT, perPage, "*", sort);
	};

	// 1. The seeds themselves (with their reference lists).
	const wanted = seedDois(seeds).slice(0, MAX_SEEDS);
	const seedWorks: Array<{ work: Record<string, any>; label: string }> = [];
	const found = new Set<string>();
	for (let i = 0; i < wanted.length; i += ID_BATCH) {
		const batch = wanted.slice(i, i + ID_BATCH);
		const { items } = await page(`doi:${batch.map((entry) => entry.doi).join("|")}`, ID_BATCH);
		for (const work of items) {
			const doi = String(work?.doi ?? "").replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
			const arxiv = arxivIdOfWork(work).toLowerCase();
			const match = batch.find((entry) => entry.doi === doi || (entry.arxiv && entry.arxiv.toLowerCase() === arxiv));
			if (!match || found.has(match.seed)) continue;
			found.add(match.seed);
			seedWorks.push({ work, label: seedLabel(work) });
		}
	}
	const missing = wanted.filter((entry) => !found.has(entry.seed)).map((entry) => entry.seed);
	if (missing.length) options.warn?.(`snowball: ${missing.length} seed(s) not found at OpenAlex: ${missing.join(", ")}`);
	const seedIds = new Set(seedWorks.map((entry) => shortId(entry.work.id)));

	// Provenance per found work id, in the order first seen.
	const provenance = new Map<string, string[]>();
	const note = (id: string, label: string) => {
		if (seedIds.has(id)) return;
		const list = provenance.get(id) ?? [];
		if (!list.includes(label)) list.push(label);
		provenance.set(id, list);
	};
	const works = new Map<string, Record<string, any>>();

	// 2. Backward: the reference lists, fetched in batches.
	let backward = 0;
	if (direction !== "forward") {
		const refIds: string[] = [];
		for (const { work, label } of seedWorks) {
			for (const ref of (work.referenced_works ?? []) as unknown[]) {
				const id = shortId(ref);
				if (!id) continue;
				if (!provenance.has(id) && !seedIds.has(id)) refIds.push(id);
				note(id, `references of: ${label}`);
			}
		}
		backward = provenance.size;
		for (let i = 0; i < refIds.length; i += ID_BATCH) {
			const { items } = await page(`ids.openalex:${refIds.slice(i, i + ID_BATCH).join("|")}`, ID_BATCH);
			for (const work of items) works.set(shortId(work.id), work);
		}
	}

	// 3. Forward: the citing works, most cited first, capped per seed.
	let forward = 0;
	if (direction !== "back") {
		const citing = new Set<string>();
		for (const { work, label } of seedWorks) {
			const { items } = await page(`cites:${shortId(work.id)}`, MAX_CITING_PER_SEED, "cited_by_count:desc");
			for (const item of items) {
				const id = shortId(item.id);
				if (seedIds.has(id)) continue;
				citing.add(id);
				note(id, `cites: ${label}`);
				if (!works.has(id)) works.set(id, item);
			}
		}
		forward = citing.size;
	}

	const records: SourceRecord[] = [];
	for (const [id, labels] of provenance) {
		const work = works.get(id);
		if (work) records.push(toRecord(work, labels));
	}
	return { records, seeds: seedWorks.map((entry) => entry.label), missing, backward, forward, requests };
}
