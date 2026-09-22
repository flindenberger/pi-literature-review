/**
 * Offline tests for the fetch engine: identifier parsing, library naming,
 * the %PDF check, the sidecar index and the resolver-chain logic with fake
 * network deps. The real network path is exercised by the live acceptance
 * run (ground-truth DOIs), not here.
 */

import assert from "node:assert/strict";
import {
	buildPaperMeta,
	buildSidecarIndex,
	citationPdfUrl,
	type FetchDeps,
	fetchOne,
	identifierSlug,
	isPdfBytes,
	paperFilename,
	type PaperMeta,
	parseIdentifier,
	renderFetchReport,
	robotsAllows,
} from "./selection.ts";

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
{
	// Dropped rows are tickable in the report: indexed too, with their access level.
	const index = buildSidecarIndex([{
		results: [],
		dropped: [{
			reason: "no abstract",
			record: {
				title: "Dropped but wanted", pdf_url: "", doi: "10.3390/w8050199", arxiv_id: "",
				access: { level: "free", oa_status: "gold", pdf_urls: ["https://repo.example/w8050199.pdf"] },
			},
		}, { reason: "junk", record: null }],
	}]);
	const entry = index.get("doi:10.3390/w8050199");
	assert.ok(entry);
	assert.equal(entry.title, "Dropped but wanted");
	assert.deepEqual(entry.access?.pdf_urls, ["https://repo.example/w8050199.pdf"]);
}

/* ---------------- buildPaperMeta ---------------- */
{
	// Without a saved-search entry the citable identity still comes from the
	// parsed identifier; bibliographic fields stay honestly empty.
	const arxivMeta = buildPaperMeta(parseIdentifier("arXiv:2401.16393"), undefined, "arxiv", "2026-07-15T12:00:00Z");
	assert.equal(arxivMeta.arxiv_id, "2401.16393");
	assert.equal(arxivMeta.doi, "");
	assert.equal(arxivMeta.title, "");
	assert.deepEqual(arxivMeta.authors, []);
	assert.equal(arxivMeta.year, null);
	assert.equal(arxivMeta.via, "arxiv");
	assert.equal(arxivMeta.fetched, "2026-07-15T12:00:00Z");
	const doiMeta = buildPaperMeta(parseIdentifier("10.1234/x"), undefined, "unpaywall", "2026-07-15T12:00:00Z");
	assert.equal(doiMeta.doi, "10.1234/x");
	assert.equal(doiMeta.arxiv_id, "");
	// Entry values (API-sourced) win over the parsed fallback.
	const entryMeta = buildPaperMeta(
		parseIdentifier("10.3390/rs13081505"),
		{ title: "T", pdf_url: "u", doi: "10.3390/RS13081505", arxiv_id: "", authors: ["A B"], year: "2021" },
		"record",
		"2026-07-15T12:00:00Z",
	);
	assert.equal(entryMeta.doi, "10.3390/RS13081505"); // verbatim, not re-cased
	assert.equal(entryMeta.pdf_url, "u");
}

/* ---------------- fetchOne chain logic (fake deps) ---------------- */
const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake");
const htmlBytes = new TextEncoder().encode("<html>paywall</html>");

function makeDeps(overrides: Partial<FetchDeps> = {}): {
	deps: FetchDeps; saved: string[]; urls: string[]; metas: Array<{ path: string; meta: PaperMeta }>;
} {
	const saved: string[] = [];
	const urls: string[] = [];
	const metas: Array<{ path: string; meta: PaperMeta }> = [];
	const deps: FetchDeps = {
		fileExists: () => false,
		saveFile: (path) => saved.push(path),
		saveMeta: (path, meta) => metas.push({ path, meta }),
		downloadPdf: async (url) => {
			urls.push(url);
			return { ok: true, bytes: pdfBytes };
		},
		unpaywallPdfUrl: async () => ({ url: null, note: "Unpaywall: no open copy listed" }),
		openAlexAccess: async () => ({ access: null, note: "OpenAlex does not list this DOI (access unknown)" }),
		landingPdfUrl: async () => ({ url: null, note: "article page names no PDF" }),
		...overrides,
	};
	return { deps, saved, urls, metas };
}

// 1) record pdf_url wins first; the metadata twin lands next to the PDF
{
	const { deps, saved, metas } = makeDeps();
	const target = parseIdentifier("10.3390/rs13081505");
	const entry = {
		title: "Vistula", pdf_url: "https://mdpi.com/x.pdf", doi: "10.3390/rs13081505", arxiv_id: "",
		authors: ["Anna Kryniecka"], year: "2021",
	};
	const result = await fetchOne(target, entry, "/papers", deps);
	assert.equal(result.status, "downloaded");
	assert.equal(result.source, "record");
	assert.equal(result.path, "/papers/2021_Kryniecka_Vistula.pdf");
	assert.equal(saved.length, 1);
	assert.ok(result.known);
	// Twin: same basename, fields verbatim from the entry, honest event data.
	assert.equal(metas.length, 1);
	assert.equal(metas[0].path, "/papers/2021_Kryniecka_Vistula.json");
	assert.equal(metas[0].meta.title, "Vistula");
	assert.deepEqual(metas[0].meta.authors, ["Anna Kryniecka"]);
	assert.equal(metas[0].meta.year, "2021");
	assert.equal(metas[0].meta.doi, "10.3390/rs13081505");
	assert.equal(metas[0].meta.via, "record");
	assert.ok(!Number.isNaN(Date.parse(metas[0].meta.fetched)));
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
	const { deps, metas } = makeDeps({
		fileExists: () => true,
		downloadPdf: async () => {
			networkCalls++;
			return { ok: true, bytes: pdfBytes };
		},
	});
	const result = await fetchOne(parseIdentifier("10.3390/rs13081505"), undefined, "/papers", deps);
	assert.equal(result.status, "already");
	assert.equal(networkCalls, 0);
	assert.equal(metas.length, 0); // twin only accompanies fresh downloads
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

// 5b) publisher answers 403 -> "browser" with the blocked link to open
{
	const { deps } = makeDeps({
		downloadPdf: async () => ({ ok: false, reason: "server answered 403", status: 403 }),
		unpaywallPdfUrl: async () => ({ url: "https://www.mdpi.com/blocked.pdf" }),
	});
	const result = await fetchOne(parseIdentifier("10.3390/rs13081505"), undefined, "/papers", deps);
	assert.equal(result.status, "browser");
	assert.equal(result.browserUrl, "https://www.mdpi.com/blocked.pdf");
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

// 8) restricted (saved access level): nothing tried, browser link to the DOI
{
	const { deps, urls } = makeDeps({
		openAlexAccess: async () => { throw new Error("must not be asked: the entry carries the level"); },
	});
	const entry = {
		title: "Closed", pdf_url: "https://publisher.example/closed.pdf", doi: "10.1016/x", arxiv_id: "",
		access: { level: "restricted" as const, oa_status: "closed" },
	};
	const result = await fetchOne(parseIdentifier("10.1016/x"), entry, "/papers", deps);
	assert.equal(result.status, "restricted");
	assert.equal(result.browserUrl, "https://doi.org/10.1016/x");
	assert.ok(result.detail.includes("university network"));
	assert.equal(urls.length, 0);
}

// 9) conference abstract from the live lookup: reported, nothing tried
{
	const { deps, urls } = makeDeps({
		openAlexAccess: async () => ({ access: { level: "abstract_only", oa_status: "gold" } }),
	});
	const result = await fetchOne(parseIdentifier("10.5194/egusphere-egu23-6745"), undefined, "/papers", deps);
	assert.equal(result.status, "abstract_only");
	assert.ok(result.detail.includes("no PDF to download"));
	assert.equal(urls.length, 0);
}

// 10) OpenAlex locations are tried in order after the record link; the
// later steps are never asked once one of them delivers
{
	let landingAsked = false;
	const { deps, urls } = makeDeps({
		downloadPdf: async (url) => {
			urls.push(url);
			if (url.includes("repo-two")) return { ok: true, bytes: pdfBytes };
			return url.includes("publisher")
				? { ok: false, reason: "server answered 403", status: 403 }
				: { ok: true, bytes: htmlBytes };
		},
		landingPdfUrl: async () => { landingAsked = true; return { url: null }; },
	});
	const entry = {
		title: "Hybrid", pdf_url: "https://publisher.example/a.pdf", doi: "10.1016/y", arxiv_id: "",
		access: { level: "free" as const, pdf_urls: ["https://publisher.example/a.pdf", "https://repo-one.example/a", "https://repo-two.example/a.pdf"] },
	};
	const result = await fetchOne(parseIdentifier("10.1016/y"), entry, "/papers", deps);
	assert.equal(result.status, "downloaded");
	assert.equal(result.source, "openalex");
	// The record link equals the first location: asked once only.
	assert.deepEqual(urls, ["https://publisher.example/a.pdf", "https://repo-one.example/a", "https://repo-two.example/a.pdf"]);
	assert.equal(landingAsked, false);
}

// 11) article page: asked after Unpaywall, before arXiv
{
	const { deps, urls } = makeDeps({
		openAlexAccess: async () => ({ access: { level: "free", oa_status: "gold" } }),
		landingPdfUrl: async (doi) => ({ url: `https://hess.example/${doi.split("/")[1]}.pdf` }),
	});
	const result = await fetchOne(parseIdentifier("10.5194/hess-30-797-2026"), undefined, "/papers", deps);
	assert.equal(result.status, "downloaded");
	assert.equal(result.source, "landing");
	assert.deepEqual(urls, ["https://hess.example/hess-30-797-2026.pdf"]);
}

// 12) free per OpenAlex, but no link answers with a PDF -> browser
{
	const { deps } = makeDeps({
		downloadPdf: async () => ({ ok: true, bytes: htmlBytes }),
		openAlexAccess: async () => ({ access: { level: "free", oa_status: "gold", pdf_urls: ["https://www.mdpi.com/x/pdf"] } }),
	});
	const result = await fetchOne(parseIdentifier("10.3390/w14030309"), undefined, "/papers", deps);
	assert.equal(result.status, "browser");
	assert.equal(result.browserUrl, "https://doi.org/10.3390/w14030309");
	assert.ok(result.detail.includes("no link returned a PDF (1 tried)"));
}

/* ---------------- robotsAllows / citationPdfUrl ---------------- */
{
	const robots = [
		"User-agent: GPTBot",
		"Disallow: /",
		"",
		"User-agent: *",
		"Disallow: /cache/",
		"Disallow: /*.otmi$",
		"Allow: /cache/public/ # comment",
	].join("\n");
	assert.equal(robotsAllows(robots, "pi-literature-review", "/articles/x.pdf"), true);
	assert.equal(robotsAllows(robots, "pi-literature-review", "/cache/x"), false);
	assert.equal(robotsAllows(robots, "pi-literature-review", "/cache/public/x"), true); // longest rule wins
	assert.equal(robotsAllows(robots, "pi-literature-review", "/a/b.otmi"), false);
	assert.equal(robotsAllows(robots, "pi-literature-review", "/a/b.otmi?x"), true); // $ anchors the end
	assert.equal(robotsAllows(robots, "GPTBot", "/articles/x.pdf"), false); // own group, not "*"
	assert.equal(robotsAllows("User-agent: *\nDisallow: /", "pi-literature-review", "/x"), false);
	assert.equal(robotsAllows("User-agent: *\nDisallow:", "pi-literature-review", "/x"), true); // empty rule
	assert.equal(robotsAllows("", "pi-literature-review", "/x"), true);
	// Two agent lines share one group.
	assert.equal(robotsAllows("User-agent: a\nUser-agent: pi-literature-review\nDisallow: /p", "pi-literature-review", "/p1"), false);
}
{
	const page = `<head><meta name="citation_title" content="T">
<meta content="/articles/30/797/2026/hess-30-797-2026.pdf" name="citation_pdf_url"></head>`;
	assert.equal(
		citationPdfUrl(page, "https://hess.copernicus.org/articles/30/797/2026/"),
		"https://hess.copernicus.org/articles/30/797/2026/hess-30-797-2026.pdf",
	);
	assert.equal(
		citationPdfUrl(`<meta name='citation_pdf_url' content='https://x.org/a?b=1&amp;c=2'>`, "https://x.org/"),
		"https://x.org/a?b=1&c=2",
	);
	assert.equal(citationPdfUrl("<meta name=\"citation_title\" content=\"T\">", "https://x.org/"), null);
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
	const restricted = await fetchOne(
		parseIdentifier("10.1016/closed"),
		{ title: "Closed paper", pdf_url: "", doi: "10.1016/closed", arxiv_id: "", access: { level: "restricted" } },
		"/papers",
		deps,
	);
	const report = renderFetchReport([downloaded, notFree, restricted], "/papers");
	assert.ok(report.includes("1 restricted (browser, e.g. in your university network)"));
	assert.ok(report.includes("Open in your browser (2): save each PDF into /papers"));
	assert.ok(report.includes("- [restricted] https://doi.org/10.1016/closed | Closed paper"));
	assert.ok(report.includes("- [not freely available] https://doi.org/10.5555/paywalled"));
	assert.ok(report.includes("Fetch complete: 1 downloaded"));
	assert.ok(report.includes("PDF library: /papers"));
	assert.ok(report.includes("Vistula sandbars"));
	assert.ok(report.includes("[not freely available] 10.5555/paywalled"));
	assert.ok(report.includes("obtain via authorized access"));
	assert.ok(!report.toLowerCase().includes("legal")); // neutral wording, per user decision
}

console.log("selection.test.ts: all assertions passed");
