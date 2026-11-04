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
