/**
 * Offline tests for the shared politeness helpers: the retry backoff rule
 * and the paced, retrying client (fake fetch, no network, spacing 0).
 */

import assert from "node:assert/strict";
import { pacedClient, retryDelayMs } from "./polite.ts";

// Rate-limit backoff: fixed delays, a sane Retry-After header wins, a huge
// or exhausted one gives up.
{
	assert.equal(retryDelayMs(0, null), 5_000);
	assert.equal(retryDelayMs(1, null), 15_000);
	assert.equal(retryDelayMs(2, null), null); // attempts used up
	assert.equal(retryDelayMs(0, "7"), 7_000); // header wins
	assert.equal(retryDelayMs(0, "0"), 5_000); // zero: fall back to the fixed delay
	assert.equal(retryDelayMs(0, "3600"), null); // "come back in an hour": not worth blocking
	assert.equal(retryDelayMs(0, "soon"), 5_000); // non-numeric header ignored
	assert.equal(retryDelayMs(2, "7"), null); // header never revives used-up attempts
}

// pacedClient: ok passes through, a passed status returns instead of
// throwing, a non-rate-limit error throws with the label and status.
{
	const realFetch = globalThis.fetch;
	const answers: number[] = [];
	globalThis.fetch = (async () => new Response("", { status: answers.shift() ?? 200 })) as typeof fetch;
	try {
		const client = pacedClient({ label: "Test API", spacingMs: 0, passStatuses: [404] });
		answers.push(200);
		assert.equal((await client("https://example.invalid/a")).status, 200);
		answers.push(404);
		assert.equal((await client("https://example.invalid/b")).status, 404);
		answers.push(500);
		await assert.rejects(() => client("https://example.invalid/c"), /Test API answered HTTP 500/);
		// A rate-limit answer with an exhausted budget names the retries and the hint.
		const noRetry = pacedClient({ label: "Test API", spacingMs: 0, rateLimitStatuses: [429], rateLimitHint: "get a key" });
		answers.push(429, 429, 429);
		// Retry-After 1 keeps the test fast (1s + 1s backoff before giving up).
		globalThis.fetch = (async () => new Response("", { status: answers.shift() ?? 200, headers: { "retry-after": "1" } })) as typeof fetch;
		await assert.rejects(() => noRetry("https://example.invalid/d"), /rate limited; 2 retries did not clear it\) -- get a key/);
		// retry:false = ONE attempt: a rate-limit answer throws immediately
		// (no backoff sleeps), for callers probing an already-limited source.
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("", { status: 429, headers: { "retry-after": "1" } });
		}) as typeof fetch;
		await assert.rejects(
			() => noRetry("https://example.invalid/e", {}, { retry: false }),
			/Test API answered HTTP 429 -- get a key/,
		);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = realFetch;
	}
}

console.log("polite.test.ts: all assertions passed");
