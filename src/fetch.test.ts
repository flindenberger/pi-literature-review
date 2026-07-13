/**
 * Offline tests for the fetch engine: identifier parsing, library naming,
 * the %PDF check, the sidecar index and the resolver-chain logic with fake
 * network deps. The real network path is exercised by the live acceptance
 * run (ground-truth DOIs), not here.
 */

import assert from "node:assert/strict";
import {
	buildSidecarIndex,
	type FetchDeps,
	fetchOne,
	identifierSlug,
	isPdfBytes,
	paperFilename,
	parseIdentifier,
	renderFetchReport,
} from "./fetch.ts";

/* ---------------- parseIdentifier ---------------- */
{
	assert.equal(parseIdentifier("10.3390/rs13081505").kind, "doi");
	assert.equal(parseIdentifier("https://doi.org/10.3390/rs13081505").id, "10.3390/rs13081505");
	assert.equal(parseIdentifier("doi:10.3390/RS13081505,").id, "10.3390/RS13081505");
	assert.equal(parseIdentifier("arXiv:2401.16393v1").kind, "arxiv");
	assert.equal(parseIdentifier("2401.16393").kind, "arxiv");
	assert.equal(parseIdentifier("https://arxiv.org/pdf/2401.16393.pdf").id, "2401.16393");
	assert.equal(parseIdentifier("cs/0112017").kind, "arxiv"); // old-style arXiv
	assert.equal(parseIdentifier("banana").kind, "unknown");
	assert.equal(parseIdentifier("10.").kind, "unknown");
	// version-tolerant identity: v1 and v2 share the library slot
	assert.equal(parseIdentifier("arxiv:2401.16393v1").key, parseIdentifier("2401.16393v2").key);
	assert.equal(
		parseIdentifier("10.31227/osf.io/pz6jv_v1").key,
		parseIdentifier("10.31227/osf.io/pz6jv").key,
	);
}

/* ---------------- identifierSlug ---------------- */
{
	assert.equal(identifierSlug(parseIdentifier("10.3390/rs13081505")), "10.3390_rs13081505");
	assert.equal(identifierSlug(parseIdentifier("arXiv:2401.16393")), "arxiv_2401.16393");
	assert.equal(identifierSlug(parseIdentifier("cs/0112017")), "arxiv_cs_0112017");
	// no character outside [a-z0-9._-] survives
	assert.match(identifierSlug(parseIdentifier('10.1234/a<b>"c|d')), /^[a-z0-9._-]+$/);
}

/* ---------------- paperFilename ---------------- */
{
	const target = parseIdentifier("10.3390/rs13081505");
	const entry = {
		title: "Application of Satellite Sentinel-2 Images to Study Alternate Sandbars Movement at Lower Vistula River (Poland)",
		pdf_url: "",
		doi: "10.3390/rs13081505",
		arxiv_id: "",
		authors: ["Kryniecka, A.", "Magnuszewski, A."],
		year: "2021",
	};
	const name = paperFilename(target, entry);
	assert.ok(name.startsWith("2021_Kryniecka_et_al_Application_of_Satellite_Sentinel_2_Images"));
	assert.ok(name.length <= 80);
	assert.match(name, /^[A-Za-z0-9_]+$/);

	// single author: no et_al
	const solo = paperFilename(target, { ...entry, authors: ["Anna Kryniecka"] });
	assert.ok(solo.startsWith("2021_Kryniecka_Application"));
	assert.ok(!solo.includes("et_al"));

	// umlauts transliterated, diacritics stripped
	const umlaut = paperFilename(target, {
		...entry,
		authors: ["Jörg Müßig"],
		title: "Gewässergüte an der Müritz — étude",
	});
	assert.ok(umlaut.startsWith("2021_Muessig_Gewaesserguete_an_der_Mueritz_etude"));

	// missing metadata -> deterministic identifier slug (never invented)
	assert.equal(paperFilename(target, { ...entry, year: null }), "10.3390_rs13081505");
	assert.equal(paperFilename(target, { ...entry, authors: [] }), "10.3390_rs13081505");
	assert.equal(paperFilename(target, undefined), "10.3390_rs13081505");

	// very long single-word title still respects the cap
	const long = paperFilename(target, { ...entry, title: "X".repeat(300) });
	assert.ok(long.length <= 80);
}

/* ---------------- isPdfBytes ---------------- */
{
	assert.ok(isPdfBytes(new TextEncoder().encode("%PDF-1.7 rest of file")));
	assert.ok(!isPdfBytes(new TextEncoder().encode("<html><body>Sign in</body></html>")));
	assert.ok(!isPdfBytes(new Uint8Array([0x25, 0x50])));
	assert.ok(!isPdfBytes(new Uint8Array(0)));
}

/* ---------------- buildSidecarIndex ---------------- */
const payloadA = {
	results: [
		{ title: "Vistula sandbars", pdf_url: "", doi: "10.3390/rs13081505", arxiv_id: "" },
		{ title: "Rio Negro", pdf_url: "https://arxiv.org/pdf/2401.16393v1", doi: "", arxiv_id: "2401.16393v1" },
	],
};
const payloadB = {
	results: [
		// same paper, later run, richer: fills the missing pdf_url, keeps the first title
		{ title: "Vistula sandbars (rerun)", pdf_url: "https://www.mdpi.com/rs13081505.pdf", doi: "10.3390/RS13081505", arxiv_id: "" },
	],
};
{
	const index = buildSidecarIndex([payloadA, payloadB, { junk: true }, null]);
	const vistula = index.get("doi:10.3390/rs13081505");
	assert.ok(vistula);
	assert.equal(vistula.title, "Vistula sandbars"); // first title wins
	assert.equal(vistula.pdf_url, "https://www.mdpi.com/rs13081505.pdf"); // gap filled
	// version-tolerant key: v1 record is found via the versionless ID
	assert.ok(index.get(parseIdentifier("2401.16393").key as string));
}

/* ---------------- fetchOne chain logic (fake deps) ---------------- */
const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake");
const htmlBytes = new TextEncoder().encode("<html>paywall</html>");

function makeDeps(overrides: Partial<FetchDeps> = {}): { deps: FetchDeps; saved: string[]; urls: string[] } {
	const saved: string[] = [];
	const urls: string[] = [];
	const deps: FetchDeps = {
		fileExists: () => false,
		saveFile: (path) => saved.push(path),
		downloadPdf: async (url) => {
			urls.push(url);
			return { ok: true, bytes: pdfBytes };
		},
		unpaywallPdfUrl: async () => ({ url: null, note: "Unpaywall: no open copy listed" }),
		...overrides,
	};
	return { deps, saved, urls };
}

// 1) record pdf_url wins first
{
	const { deps, saved } = makeDeps();
	const target = parseIdentifier("10.3390/rs13081505");
	const entry = { title: "Vistula", pdf_url: "https://mdpi.com/x.pdf", doi: "10.3390/rs13081505", arxiv_id: "" };
	const result = await fetchOne(target, entry, "/papers", deps);
	assert.equal(result.status, "downloaded");
	assert.equal(result.source, "record");
	assert.equal(result.path, "/papers/10.3390_rs13081505.pdf");
	assert.equal(saved.length, 1);
	assert.ok(result.known);
}

// 2) record link answers HTML -> falls through to Unpaywall
{
	const { deps, urls } = makeDeps({
		downloadPdf: async (url) => {
			urls.push(url);
			return url.includes("unpaywall-copy")
				? { ok: true, bytes: pdfBytes }
				: { ok: true, bytes: htmlBytes };
		},
		unpaywallPdfUrl: async () => ({ url: "https://repo.example/unpaywall-copy.pdf" }),
	});
	const target = parseIdentifier("10.1234/x");
	const entry = { title: "X", pdf_url: "https://publisher.example/x", doi: "10.1234/x", arxiv_id: "" };
	const result = await fetchOne(target, entry, "/papers", deps);
	assert.equal(result.status, "downloaded");
	assert.equal(result.source, "unpaywall");
	assert.ok(result.notes.some((n) => n.includes("did not return a PDF")));
}

// 3) already in the library -> no network call at all
{
	let networkCalls = 0;
	const { deps } = makeDeps({
		fileExists: () => true,
		downloadPdf: async () => {
			networkCalls++;
			return { ok: true, bytes: pdfBytes };
		},
	});
	const result = await fetchOne(parseIdentifier("10.3390/rs13081505"), undefined, "/papers", deps);
	assert.equal(result.status, "already");
	assert.equal(networkCalls, 0);
}

// 4) DOI without any source: honest not_free with the publisher link
{
	const { deps, urls } = makeDeps({
		unpaywallPdfUrl: async () => ({ url: null, note: "Unpaywall skipped: set PI_LITERATURE_REVIEW_MAILTO to enable it" }),
	});
	const result = await fetchOne(parseIdentifier("10.5555/paywalled"), undefined, "/papers", deps);
	assert.equal(result.status, "not_free");
	assert.ok(result.detail.includes("obtain via authorized access"));
	assert.ok(result.detail.includes("https://doi.org/10.5555/paywalled"));
	assert.ok(result.notes.some((n) => n.includes("Unpaywall skipped")));
	assert.ok(result.notes.some((n) => n.includes("not part of any saved search")));
	assert.equal(urls.length, 0);
}

// 5) all candidate links dead -> dead_link, still with the authorized-access pointer
{
	const { deps } = makeDeps({
		downloadPdf: async () => ({ ok: false, reason: "server answered 404" }),
		unpaywallPdfUrl: async () => ({ url: "https://gone.example/x.pdf" }),
	});
	const result = await fetchOne(parseIdentifier("10.1234/dead"), undefined, "/papers", deps);
	assert.equal(result.status, "dead_link");
	assert.ok(result.detail.includes("obtain via authorized access"));
}

// 5b) publisher answers 403 -> honest "blocked" with a browser link
{
	const { deps } = makeDeps({
		downloadPdf: async () => ({ ok: false, reason: "server answered 403", status: 403 }),
		unpaywallPdfUrl: async () => ({ url: "https://www.mdpi.com/blocked.pdf" }),
	});
	const result = await fetchOne(parseIdentifier("10.3390/rs13081505"), undefined, "/papers", deps);
	assert.equal(result.status, "blocked");
	assert.ok(result.detail.includes("publisher blocks automated downloads"));
	assert.ok(result.detail.includes("open in your browser: https://www.mdpi.com/blocked.pdf"));
}

// 6) arXiv ID resolves via the arXiv endpoint without Unpaywall
{
	const { deps, urls } = makeDeps();
	const result = await fetchOne(parseIdentifier("arXiv:2401.16393"), undefined, "/papers", deps);
	assert.equal(result.status, "downloaded");
	assert.equal(result.source, "arxiv");
	assert.deepEqual(urls, ["https://arxiv.org/pdf/2401.16393"]);
}

// 7) invalid identifier: refused, nothing tried
{
	const { deps, urls } = makeDeps();
	const result = await fetchOne(parseIdentifier("banana"), undefined, "/papers", deps);
	assert.equal(result.status, "invalid");
	assert.equal(urls.length, 0);
}

/* ---------------- renderFetchReport ---------------- */
{
	const { deps } = makeDeps();
	const downloaded = await fetchOne(
		parseIdentifier("10.3390/rs13081505"),
		{ title: "Vistula sandbars", pdf_url: "https://mdpi.com/x.pdf", doi: "10.3390/rs13081505", arxiv_id: "" },
		"/papers",
		deps,
	);
	const notFree = await fetchOne(parseIdentifier("10.5555/paywalled"), undefined, "/papers", makeDeps({
		unpaywallPdfUrl: async () => ({ url: null, note: "Unpaywall: no open copy listed" }),
	}).deps);
	const report = renderFetchReport([downloaded, notFree], "/papers");
	assert.ok(report.includes("Fetch complete: 1 downloaded"));
	assert.ok(report.includes("PDF library: /papers"));
	assert.ok(report.includes("Vistula sandbars"));
	assert.ok(report.includes("[not freely available] 10.5555/paywalled"));
	assert.ok(report.includes("obtain via authorized access"));
	assert.ok(!report.toLowerCase().includes("legal")); // neutral wording, per user decision
}

console.log("fetch.test.ts: all assertions passed");
