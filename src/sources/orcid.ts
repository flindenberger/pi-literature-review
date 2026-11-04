/**
 * ORCID public API (no key, no login): the employments a researcher keeps
 * in their own ORCID record. The author window names the current one
 * (no end date) as the place of work. Self-maintained data, shown as is.
 */

import { userAgent } from "../types.ts";

export interface Employment {
	organization: string;
	role: string;
	since: number | null;
}

/** The current employments (no end date), newest start first. Pure. */
export function currentEmployments(data: unknown): Employment[] {
	const groups = ((data as Record<string, any>)?.["affiliation-group"] ?? []) as Array<Record<string, any>>;
	const out: Employment[] = [];
	for (const group of groups) {
		for (const entry of (group?.summaries ?? []) as Array<Record<string, any>>) {
			const summary = entry?.["employment-summary"];
			if (!summary || summary["end-date"]) continue;
			const organization = summary?.organization?.name;
			if (typeof organization !== "string" || !organization.trim()) continue;
			const year = Number(summary?.["start-date"]?.year?.value);
			out.push({
				organization: organization.trim(),
				role: typeof summary["role-title"] === "string" ? summary["role-title"].trim() : "",
				since: Number.isInteger(year) ? year : null,
			});
		}
	}
	return out.sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
}

/** Fetch the employments of one ORCID iD (0000-0000-0000-0000). */
export async function lookupOrcidEmployments(orcid: string, signal?: AbortSignal): Promise<Employment[]> {
	if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid)) return [];
	const response = await fetch(`https://pub.orcid.org/v3.0/${orcid}/employments`, {
		// No contact address: it is meant for the bibliographic sources only.
		headers: { Accept: "application/json", "User-Agent": userAgent().replace(/; mailto:[^)]*/, "") },
		signal,
	});
	if (response.status === 404) return [];
	if (!response.ok) throw new Error(`pub.orcid.org answered HTTP ${response.status}`);
	return currentEmployments(await response.json());
}

export interface OrcidPerson {
	orcid: string;
	names: string[];
}

/** People in an ORCID expanded-search answer: the iD and every name form
 * they give (given + family, credit name, other names). E-mail fields
 * are ignored. Pure. */
export function orcidPeople(data: unknown): OrcidPerson[] {
	const rows = ((data as Record<string, any>)?.["expanded-result"] ?? []) as Array<Record<string, any>>;
	return rows
		.filter((row) => typeof row?.["orcid-id"] === "string")
		.map((row) => {
			const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
			const full = [text(row["given-names"]), text(row["family-names"])].filter(Boolean).join(" ");
			const others = Array.isArray(row["other-name"]) ? row["other-name"].map(text) : [];
			return { orcid: row["orcid-id"] as string, names: [full, text(row["credit-name"]), ...others].filter(Boolean) };
		});
}

/** The ORCID records that list this DOI among their own works: the way to
 * an author's ORCID iD when OpenAlex has not linked one. */
export async function lookupOrcidByDoi(doi: string, signal?: AbortSignal): Promise<OrcidPerson[]> {
	const query = `doi-self:"${doi.trim().toLowerCase().replace(/"/g, "")}"`;
	const response = await fetch(`https://pub.orcid.org/v3.0/expanded-search/?q=${encodeURIComponent(query)}&rows=50`, {
		headers: { Accept: "application/json", "User-Agent": userAgent().replace(/; mailto:[^)]*/, "") },
		signal,
	});
	if (!response.ok) throw new Error(`pub.orcid.org answered HTTP ${response.status}`);
	return orcidPeople(await response.json());
}
