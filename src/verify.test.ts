/**
 * Offline tests for the verification gate: the decision logic over HEAD
 * results, with a fake HEAD function. No network.
 */

import assert from "node:assert/strict";
import { verifyAll, verifyRecord } from "./verify.ts";

const answer = (status: number | null, note = "") => async () => ({ status, note });

// DOI: only a 3xx redirect verifies; everything else carries a plain note.
{
	assert.deepEqual(await verifyRecord({ doi: "10.1/x", arxiv_id: "" }, answer(302)), { verified: true, note: "" });
	const missing = await verifyRecord({ doi: "10.1/x", arxiv_id: "" }, answer(404));
	assert.equal(missing.verified, false);
	assert.ok(missing.note.includes("HTTP 404") && missing.note.includes("not found"));
	const ok200 = await verifyRecord({ doi: "10.1/x", arxiv_id: "" }, answer(200));
	assert.equal(ok200.verified, false); // doi.org must redirect, a 200 is not proof
	const down = await verifyRecord({ doi: "10.1/x", arxiv_id: "" }, answer(null, "network error: TimeoutError"));
	assert.equal(down.verified, false);
	assert.equal(down.note, "network error: TimeoutError");
}

// arXiv: 200 or a redirect verifies; the DOI wins when both exist.
{
	assert.equal((await verifyRecord({ doi: "", arxiv_id: "2401.16393" }, answer(200))).verified, true);
	assert.equal((await verifyRecord({ doi: "", arxiv_id: "2401.16393" }, answer(301))).verified, true);
	assert.equal((await verifyRecord({ doi: "", arxiv_id: "2401.16393" }, answer(404))).verified, false);
	const urls: string[] = [];
	await verifyRecord({ doi: "10.1/x", arxiv_id: "2401.16393" }, async (url) => { urls.push(url); return { status: 302, note: "" }; });
	assert.deepEqual(urls, ["https://doi.org/10.1/x"]);
}

// No identifier at all: unverified, with a reason.
{
	const none = await verifyRecord({ doi: "", arxiv_id: "" }, answer(302));
	assert.deepEqual(none, { verified: false, note: "no DOI or arXiv ID to verify" });
}

// verifyAll stamps every record, warns about unverified ones, and an
// aborted signal throws instead of returning a partial list.
{
	const base = { title: "t", authors: ["a"], year: "2021", venue: "", arxiv_id: "", url: "", pdf_url: "", cites: null, abstract: "", sources: ["x"] };
	const warnings: string[] = [];
	const out = await verifyAll(
		[{ ...base, doi: "10.1/good" }, { ...base, doi: "10.1/bad" }],
		(m) => warnings.push(m),
		undefined,
		async (url) => ({ status: url.endsWith("good") ? 302 : 404, note: "" }),
	);
	assert.deepEqual(out.map((r) => r.verified), [true, false]);
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].startsWith('unverified "10.1/bad"'));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => verifyAll([{ ...base, doi: "10.1/x" }], () => {}, controller.signal, answer(302)), /aborted/);
}

console.log("verify.test.ts: all assertions passed");
