/**
 * Verification -- the trust gate of the search stage.
 *
 * Every record's identifier must actually resolve before it is shown as
 * verified. DOI: HEAD https://doi.org/<doi> without following redirects; a
 * real DOI answers with a 3xx redirect to the publisher. arXiv ID: HEAD the
 * abstract page; 200 (or a redirect) means the preprint exists. Anything
 * else -- wrong status, network failure, no identifier at all -- is the gray
 * zone: verified stays false and verify_note says why. Never silently
 * confirmed. Requests are polite (timeout, pause, User-Agent); the HEAD
 * function is injectable so the decision logic tests offline.
 */

import type { MergedRecord } from "./pipeline.ts";
import { errorName, userAgent, warn } from "./types.ts";

export interface VerifiedRecord extends MergedRecord {
	verified: boolean;
	verify_note: string;
}

const VERIFY_TIMEOUT_MS = 10_000; // per HEAD request
const VERIFY_PAUSE_MS = 200; // between requests; stay polite to doi.org/arxiv.org

/** Plain-language reading of an HTTP status, for verify notes. Fixed strings. */
function explainStatus(status: number | null): string {
	if (status === null) return "no response received";
	if (status === 404) return "not found: no such identifier is registered";
	if (status === 403) return "access refused by the server";
	if (status === 410) return "gone: the identifier was removed";
	if (status === 429) return "too many requests: the server is rate-limiting us";
	if (status >= 500) return "server-side error, try again later";
	if (status >= 400) return "request rejected by the server";
	if (status >= 300) return "redirect";
	if (status === 200) return "page exists";
	return "unexpected status";
}

/** Result of one HEAD request: the status code, or null with an error note. */
export type HeadStatus = { status: number | null; note: string };
export type HeadFn = (url: string, signal?: AbortSignal) => Promise<HeadStatus>;

/** One polite HEAD request (per-request timeout combined with the run's
 * abort signal when given). */
async function headStatus(url: string, signal?: AbortSignal): Promise<HeadStatus> {
	const timeout = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "HEAD",
			redirect: "manual",
			headers: { "User-Agent": userAgent() },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		return { status: response.status, note: "" };
	} catch (error) {
		return { status: null, note: `network error: ${errorName(error)}` };
	}
}

/** Verify ONE record's identifier (DOI first, else arXiv ID). */
export async function verifyRecord(
	record: Pick<MergedRecord, "doi" | "arxiv_id">,
	head: HeadFn = headStatus,
	signal?: AbortSignal,
): Promise<{ verified: boolean; note: string }> {
	if (record.doi) {
		const { status, note } = await head(`https://doi.org/${record.doi}`, signal);
		if (status !== null && status >= 300 && status < 400) {
			return { verified: true, note: "" };
		}
		return {
			verified: false,
			note: note
				|| `doi.org answered HTTP ${status} (${explainStatus(status)}), expected a 3xx redirect to the publisher`,
		};
	}
	if (record.arxiv_id) {
		const { status, note } = await head(`https://arxiv.org/abs/${record.arxiv_id}`, signal);
		if (status !== null && (status === 200 || (status >= 300 && status < 400))) {
			return { verified: true, note: "" };
		}
		return {
			verified: false,
			note: note
				|| `arxiv.org answered HTTP ${status} (${explainStatus(status)}), expected 200 for an existing preprint`,
		};
	}
	return { verified: false, note: "no DOI or arXiv ID to verify" };
}

/** Stamp every record with verified / verify_note. An abort (Esc in the
 * agent) throws between records: an aborted run produces no payload, never
 * a half-verified one. */
export async function verifyAll(
	records: MergedRecord[],
	onWarn: (message: string) => void = warn,
	signal?: AbortSignal,
	head: HeadFn = headStatus,
): Promise<VerifiedRecord[]> {
	const verified: VerifiedRecord[] = [];
	for (const [index, record] of records.entries()) {
		if (signal?.aborted) throw new Error("search aborted during verification");
		if (index && head === headStatus) await new Promise((resolve) => setTimeout(resolve, VERIFY_PAUSE_MS));
		const result = await verifyRecord(record, head, signal);
		if (!result.verified) {
			const label = record.doi || record.arxiv_id || record.title;
			onWarn(`unverified "${label}": ${result.note}`);
		}
		verified.push({ ...record, verified: result.verified, verify_note: result.note });
	}
	return verified;
}
