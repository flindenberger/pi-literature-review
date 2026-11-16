/**
 * Snowball as an extension of a finished search: the earlier list stays as
 * it was, the round's new finds are added, finds the list already holds
 * gain their provenance ("cites: Lee 2021"), and the seeds are marked.
 * The new finds went through every gate of runSearch (abstract, topic,
 * filters); the flow numbers of both runs add up.
 */

import { identityKey, sortRecords } from "./pipeline.ts";
import { countAccess, type SearchPayload } from "./search.ts";
import type { SnowballDirection, SnowballResult } from "./snowball.ts";

/** The identity key of a seed as the list gives it (DOI or arXiv id). */
export function seedKey(id: string): string | null {
	const bare = id.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").replace(/^arxiv:/i, "");
	if (!bare) return null;
	return /^10\./.test(bare) ? identityKey({ doi: bare, arxiv_id: "" }) : identityKey({ doi: "", arxiv_id: bare });
}

/** Identity keys of every record (kept and dropped) of a run. */
export function payloadKeys(payload: SearchPayload): Set<string> {
	const keys = new Set<string>();
	for (const record of [...payload.results, ...payload.dropped.map((entry) => entry.record)]) {
		const key = identityKey(record);
		if (key) keys.add(key);
	}
	return keys;
}

type Snow = Omit<SnowballResult, "records"> & { direction: SnowballDirection };

function mergeInfo(a: Snow | null, b: Snow | null): Snow | null {
	if (!a || !b) return a ?? b;
	const union = (x: string[], y: string[]) => [...x, ...y.filter((item) => !x.includes(item))];
	return {
		seeds: union(a.seeds, b.seeds),
		missing: union(a.missing, b.missing),
		backward: a.backward + b.backward,
		forward: a.forward + b.forward,
		requests: a.requests + b.requests,
		direction: a.direction === b.direction ? a.direction : "both",
	};
}

/** `prior` extended by the snowball-only run `extra` (runSearch with
 * snowballOnly + knownKeys = payloadKeys(prior)) from the seeds `seedIds`. */
export function mergeSnowball(prior: SearchPayload, extra: SearchPayload, seedIds: string[]): SearchPayload {
	const known = new Map<string, string[]>();
	for (const find of extra.snowball_known ?? []) {
		known.set(find.key, [...(known.get(find.key) ?? []), ...find.snowball.filter((label) => !(known.get(find.key) ?? []).includes(label))]);
	}
	const seeds = new Set(seedIds.map(seedKey).filter((key): key is string => Boolean(key)));
	type Touchable = { doi: string; arxiv_id: string; snowball?: string[]; snowball_seed?: boolean; sources?: string[] };
	const touch = <T extends Touchable>(record: T): T => {
		const key = identityKey(record);
		if (!key) return record;
		const via = known.get(key);
		const seed = seeds.has(key);
		if (!via && !seed) return record;
		const out = { ...record };
		if (via) {
			const before = record.snowball ?? [];
			out.snowball = [...before, ...via.filter((label) => !before.includes(label))];
			if (record.sources && !record.sources.includes("snowball")) out.sources = [...record.sources, "snowball"];
		}
		if (seed) out.snowball_seed = true;
		return out;
	};
	const joined = [...prior.results.map(touch), ...extra.results];
	const results = prior.sort ? sortRecords(joined, prior.sort) : joined;
	const dropped = [...prior.dropped.map((entry) => ({ ...entry, record: touch(entry.record) })), ...extra.dropped] as SearchPayload["dropped"];
	const flow: Record<string, number> = { ...prior.flow };
	for (const [name, value] of Object.entries(extra.flow)) {
		if (typeof value === "number") flow[name] = (flow[name] ?? 0) + value;
	}
	flow.included = results.length;
	const failures = [...(prior.source_failures ?? []), ...(extra.source_failures ?? [])];
	const counts = [...(prior.source_counts ?? []), ...(extra.source_counts ?? [])];
	return {
		...prior,
		generated: extra.generated,
		source_failures: failures.length ? failures : null,
		source_counts: counts.length ? counts : null,
		snowball: mergeInfo(prior.snowball, extra.snowball),
		snowball_known: null,
		flow: flow as SearchPayload["flow"],
		access_counts: prior.access_counts ? countAccess(results) : prior.access_counts,
		results,
		dropped,
	};
}
