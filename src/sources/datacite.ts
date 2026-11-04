/**
 * DataCite REST API (no key, no login): the related identifiers of DOIs
 * registered with DataCite -- Zenodo, figshare, Dryad, OSF and other
 * repositories, which CrossRef does not hold. A Zenodo software record
 * made from a GitHub release, for example, carries IsSupplementTo with
 * the repository URL. Only relations to known archives become links
 * (dataLinkFor, the same list as for CrossRef).
 */

import { type DataLink, userAgent } from "../types.ts";
import { dataLinkFor, lookupCrossrefRelations } from "./crossref.ts";
import { pacedClient } from "./polite.ts";

/** Relation types that point from a record to its own material. */
export const DATACITE_RELATION_TYPES = ["IsSupplementTo", "IsSupplementedBy", "References"];

const fetchPaced = pacedClient({ label: "DataCite", spacingMs: 500 });

/** DOIs per request; the query string stays short. */
const BATCH_SIZE = 25;

/** Data and code links of one DataCite record's relatedIdentifiers: the
 * material relation types, known archives only, each link once, never
 * the record itself. Pure. */
export function dataLinksFromRelated(doi: string, related: unknown): DataLink[] {
	if (!Array.isArray(related)) return [];
	const links: DataLink[] = [];
	const seen = new Set<string>([`https://doi.org/${doi.toLowerCase()}`]);
	for (const entry of related as Array<Record<string, unknown>>) {
		if (!DATACITE_RELATION_TYPES.includes(String(entry?.relationType))) continue;
		const link = dataLinkFor(entry?.relatedIdentifierType, entry?.relatedIdentifier);
		if (!link || seen.has(link.url.toLowerCase())) continue;
		seen.add(link.url.toLowerCase());
		links.push(link);
	}
	return links;
}

/** Links per lower-case DOI, for DOIs DataCite holds; absent = none. A
 * non-2xx answer throws; the caller degrades. */
export async function lookupDataciteLinks(dois: string[]): Promise<Map<string, DataLink[]>> {
	const unique = [...new Set(dois.map((doi) => doi.trim().toLowerCase())
		.filter((doi) => doi && !doi.startsWith("10.48550/") && !/["()]/.test(doi)))];
	const links = new Map<string, DataLink[]>();
	for (let i = 0; i < unique.length; i += BATCH_SIZE) {
		const batch = unique.slice(i, i + BATCH_SIZE);
		const params = new URLSearchParams({
			query: `doi:(${batch.map((doi) => `"${doi}"`).join(" OR ")})`,
			"page[size]": String(batch.length),
			"fields[dois]": "doi,relatedIdentifiers",
		});
		// No contact address: it is meant for the bibliographic sources.
		const response = await fetchPaced(`https://api.datacite.org/dois?${params}`, {
			headers: { Accept: "application/vnd.api+json", "User-Agent": userAgent().replace(/; mailto:[^)]*/, "") },
		});
		const data = (await response.json()) as Record<string, any>;
		for (const item of (data?.data ?? []) as Array<Record<string, any>>) {
			const doi = typeof item?.attributes?.doi === "string" ? item.attributes.doi.toLowerCase() : "";
			const found = doi ? dataLinksFromRelated(doi, item.attributes.relatedIdentifiers) : [];
			if (found.length) links.set(doi, found);
		}
	}
	return links;
}

/** Provider of a record's data links: "crossref" or "datacite". */
export const DATA_LINK_PROVIDER = new WeakMap<DataLink[], string>();

/**
 * Data and code links from both DOI registries: CrossRef relations first;
 * the DOIs CrossRef does not hold go to DataCite in one batch. A failed
 * DataCite lookup keeps the CrossRef links (and is reported through
 * `warn`); a failed CrossRef lookup throws as before.
 */
export async function lookupAllDataLinks(dois: string[], warn: (message: string) => void = () => {}): Promise<Map<string, DataLink[]>> {
	const crossref = await lookupCrossrefRelations(dois);
	for (const found of crossref.links.values()) DATA_LINK_PROVIDER.set(found, "crossref");
	const rest = [...new Set(dois.map((doi) => doi.trim().toLowerCase()))].filter((doi) => doi && !crossref.known.has(doi));
	if (!rest.length) return crossref.links;
	try {
		for (const [doi, found] of await lookupDataciteLinks(rest)) {
			DATA_LINK_PROVIDER.set(found, "datacite");
			crossref.links.set(doi, found);
		}
	} catch (error) {
		warn(`DataCite data-link lookup failed: ${error instanceof Error ? error.message : error}; those records ship without DataCite links`);
	}
	return crossref.links;
}
