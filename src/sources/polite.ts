/**
 * Politeness towards the free APIs, shared by every source client: a
 * minimum spacing between the requests of one source (module-wide, so
 * query variants in one run AND back-to-back runs in one pi session share
 * it), a per-request timeout, and a retry on rate-limit answers that honors
 * a sane numeric Retry-After header. Anything else fails loudly with the
 * HTTP status; the caller decides what that means for the run.
 */

export const TIMEOUT_MS = 30_000;

/** Fixed backoff per retry when the server names no usable Retry-After. */
const RETRY_DELAYS_MS = [5_000, 15_000];

/**
 * How long to wait before retry number `attempt + 1` after a rate-limit
 * answer, or null when the attempts are used up. A sane numeric Retry-After
 * header wins over the fixed backoff; a huge one (arXiv sometimes says
 * "come back tomorrow") is not worth blocking a run for -- give up then.
 * Pure.
 */
export function retryDelayMs(attempt: number, retryAfter: string | null): number | null {
	if (attempt >= RETRY_DELAYS_MS.length) return null;
	const trimmed = retryAfter?.trim() ?? "";
	if (/^\d+$/.test(trimmed)) {
		const ms = Number(trimmed) * 1000;
		if (ms > 60_000) return null;
		if (ms > 0) return ms;
	}
	return RETRY_DELAYS_MS[attempt];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PacedClientOptions {
	/** Name used in error messages ("arXiv answered HTTP 503"). */
	label: string;
	/** Minimum time between two requests of this client; a function when
	 * it depends on runtime state (e.g. an API token). */
	spacingMs: number | (() => number);
	/** Statuses treated as rate limiting (default 429 and 503). */
	rateLimitStatuses?: number[];
	/** Statuses returned to the caller instead of thrown (e.g. 404 = "not
	 * found" for a lookup). */
	passStatuses?: number[];
	/** Extra sentence appended to a rate-limit failure (e.g. a get-a-key hint). */
	rateLimitHint?: string;
}

export type PacedFetch = (url: string, init?: RequestInit, opts?: { retry?: boolean }) => Promise<Response>;

/**
 * A paced, retrying fetch for ONE source. Every call waits for the spacing,
 * sends the request with the timeout, retries rate-limit answers via
 * retryDelayMs, returns the response on success (or a passed status) and
 * throws on anything else. `retry: false` sends a SINGLE attempt: a caller
 * that already saw this source rate-limit can keep probing cheaply (a 429
 * answer is fast; it is the backoff sleeps that cost the run minutes).
 */
export function pacedClient(options: PacedClientOptions): PacedFetch {
	const rateLimitStatuses = options.rateLimitStatuses ?? [429, 503];
	const passStatuses = options.passStatuses ?? [];
	let nextRequestAt = 0;
	// Each attempt reserves its send slot synchronously before sleeping, so
	// callers running concurrently (parallel sources sharing one server)
	// queue up one spacing apart instead of firing together.
	const reserveSlot = (): number => {
		const spacing = typeof options.spacingMs === "function" ? options.spacingMs() : options.spacingMs;
		const sendAt = Math.max(Date.now(), nextRequestAt);
		nextRequestAt = sendAt + spacing;
		return sendAt - Date.now();
	};
	return async (url, init = {}, opts = {}) => {
		for (let attempt = 0; ; attempt++) {
			const wait = reserveSlot();
			if (wait > 0) await sleep(wait);
			const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
			if (response.ok || passStatuses.includes(response.status)) return response;
			const rateLimited = rateLimitStatuses.includes(response.status);
			const delay = rateLimited && opts.retry !== false
				? retryDelayMs(attempt, response.headers.get("retry-after"))
				: null;
			if (delay === null) {
				throw new Error(
					`${options.label} answered HTTP ${response.status}`
					+ (rateLimited && attempt ? ` (rate limited; ${attempt} retr${attempt === 1 ? "y" : "ies"} did not clear it)` : "")
					+ (rateLimited && options.rateLimitHint ? ` -- ${options.rateLimitHint}` : ""),
				);
			}
			await sleep(delay);
		}
	};
}
