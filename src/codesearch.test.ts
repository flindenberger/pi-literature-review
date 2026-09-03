/**
 * Offline tests for the code-first search: identifier extraction, list
 * matching, the shared resolution with the date gate, and the four
 * searchers on injected stubs (no network, no pacer waits). Fixtures are
 * field cases measured on 2026-09-03.
 * Run: node src/codesearch.test.ts
 */

import assert from "node:assert/strict";
import {
	betterRepoFromReadme, blockQuery, clearListCache, CODE_SEARCHERS, type CodeSearchDeps, entryMatchesBlocks, LATE_DISCARD_YEARS,
	MAX_IDS_PER_README, paperIdKey, paperIdsFromText, repoUrlsFromText, resolvePairs, searchWords, usableRepoItems,
} from "./codesearch.ts";
import type { SourceRecord } from "./types.ts";

// paperIdsFromText: URLs and mentions, order kept, dedupe, DataCite arXiv
// DOIs converted, Zenodo self-DOIs and the model-card template skipped,
// Markdown punctuation stripped.
{
	const text = `
	Paper: https://arxiv.org/abs/2411.01411v2 and again http://arxiv.org/pdf/2411.01411
	Cite: arXiv:2107.08369 ; DOI: https://doi.org/10.1016/j.jag.2023.103197},
	also [doi](https://doi.org/10.1038/s41561-022-00966-7*) doi: 10.3390/rs12152469.
	Archive https://doi.org/10.5281/zenodo.2779293 -- template arxiv.org/abs/1910.09700
	DataCite https://doi.org/10.48550/arXiv.2304.02643},`;
	const ids = paperIdsFromText(text);
	assert.deepEqual(ids, [
		{ kind: "arxiv", value: "2411.01411" },
		{ kind: "arxiv", value: "2107.08369" },
		{ kind: "doi", value: "10.1016/j.jag.2023.103197" },
		{ kind: "doi", value: "10.1038/s41561-022-00966-7" },
		{ kind: "doi", value: "10.3390/rs12152469" },
		{ kind: "arxiv", value: "2304.02643" },
	]);
	assert.deepEqual(paperIdsFromText("no ids here"), []);
	assert.equal(paperIdKey({ kind: "arxiv", value: "2411.01411v3" }), "arxiv:2411.01411");
	assert.equal(paperIdKey({ kind: "doi", value: "10.3390/RS1" }), "doi:10.3390/rs1");
}

// blockQuery: GitHub's OR groups; single terms bare; no blocks = the query.
{
	assert.equal(blockQuery("q", [["water", "river"], ["segmentation"], ['"sentinel 2"']]), "(water OR river) segmentation sentinel 2");
	assert.equal(blockQuery(" plain query ", []), "plain query");
	assert.equal(blockQuery("plain", undefined), "plain");
}

// searchWords + entryMatchesBlocks: flattened block words; an entry must
// hit every block (whole-word, plural tolerant), category counts.
{
	assert.equal(searchWords("ignored", [["water", "river"], ["segmentation"]]), "water river segmentation");
	assert.equal(searchWords("flood mapping", []), "flood mapping");
	const blocks = [["water", "river", "flood"], ["segmentation", "extraction", "mapping"]];
	assert.ok(entryMatchesBlocks({ name: "floodmaps", description: "flood-water detection pipeline and segmentation models", category: "Segmentation", repoUrl: null }, blocks));
	assert.ok(entryMatchesBlocks({ name: "rivamap", description: "an automated river analysis engine", category: "Water mapping", repoUrl: null }, blocks));
	assert.ok(!entryMatchesBlocks({ name: "deepwatermap", description: "segments water bodies", category: "", repoUrl: null }, [["river"], ["segmentation"]]));
	// Three or more blocks: all but one must hit.
	const three = [["satellite"], ["water body"], ["mapping"]];
	assert.ok(entryMatchesBlocks({ name: "x", description: "water body extraction from satellite images", category: "", repoUrl: null }, three));
	assert.ok(!entryMatchesBlocks({ name: "x", description: "satellite images of roads", category: "", repoUrl: null }, three));
	assert.ok(!entryMatchesBlocks({ name: "x", description: "watershed", category: "", repoUrl: null }, [["water"]]));
	assert.ok(!entryMatchesBlocks({ name: "x", description: "water", category: "", repoUrl: null }, []));
}

// repoUrlsFromText + betterRepoFromReadme: the FUSU case -- a paper-list
// README links the real repository next to the paper; a title word in the
// linked repo's name wins over the list page. A host repo that already
// fits keeps its link.
{
	const readme = "## FUSU dataset\nPaper: https://arxiv.org/abs/2405.19055 Code: [FUSU](https://github.com/yjy0115/FUSU) see also https://github.com/rstanjieyi/GeoAI-in-NeurIPS-2024#top and https://github.com/other/thing.git, https://github.com/third/repo";
	const links = repoUrlsFromText(readme, "https://github.com/rstanjieyi/GeoAI-in-NeurIPS-2024");
	assert.deepEqual(links, ["https://github.com/yjy0115/FUSU", "https://github.com/other/thing", "https://github.com/third/repo"]);
	assert.equal(betterRepoFromReadme("https://github.com/rstanjieyi/GeoAI-in-NeurIPS-2024", links, "FUSU: A Multi-temporal-source Land Use Change Segmentation Dataset"), "https://github.com/yjy0115/FUSU");
	// A project's own README (few links) never loses its repository to a look-alike.
	assert.equal(betterRepoFromReadme("https://github.com/davdma/floodmaps", ["https://github.com/x/FloodMaps-Copy"], "High-Resolution Flood Mapping"), null);
	// Host already fits -> keep it, even on an overview-sized README.
	assert.equal(betterRepoFromReadme("https://github.com/x/flood-mapping", ["https://github.com/a/1", "https://github.com/b/2", "https://github.com/c/FloodMapping"], "Flood mapping with SAR"), null);
	assert.equal(betterRepoFromReadme("https://github.com/a/list", ["https://github.com/b/unrelated", "https://github.com/c/other", "https://github.com/d/more"], "FUSU dataset"), null);
	// An aggregator link never wins, even with a title word in its name.
	assert.equal(betterRepoFromReadme("https://github.com/a/host", ["https://github.com/chrieke/awesome-satellite-imagery-datasets", "https://github.com/b/2", "https://github.com/c/3"], "Sentinel-2 Satellite Imagery Processing"), null);
}

// usableRepoItems: aggregator names, forks and non-repo URLs drop; created_at kept.
{
	const items = usableRepoItems([
		{ html_url: "https://github.com/davdma/floodmaps", name: "floodmaps", created_at: "2024-01-01T00:00:00Z" },
		{ html_url: "https://github.com/arbal/awesome-stars", name: "awesome-stars", created_at: "2021-02-24T00:00:00Z" },
		{ html_url: "https://github.com/x/fork-of-floodmaps", name: "fork-of-floodmaps", fork: true, created_at: "2025-01-01T00:00:00Z" },
		{ html_url: "ftp://github.com/x/y", name: "y" },
		{ html_url: "https://github.com/kvos/CoastSat", name: "CoastSat" },
	]);
	assert.deepEqual(items, [
		{ owner: "davdma", repo: "floodmaps", createdAt: "2024-01-01T00:00:00Z" },
		{ owner: "kvos", repo: "CoastSat", createdAt: null },
	]);
}

// Stub world shared by the searcher tests.
const record = (over: Partial<SourceRecord>): SourceRecord => ({
	title: "", authors: [], year: null, venue: "", doi: "", arxiv_id: "", pdf_url: "", url: "", cites: null, source: "stub", abstract: "abstract text", ...over,
});
const papers: Record<string, SourceRecord> = {
	"2411.01411": record({ title: "AI4G flood", arxiv_id: "2411.01411", year: "2024", source: "arxiv" }),
	"1703.06870": record({ title: "Mask R-CNN", arxiv_id: "1703.06870", year: "2017", source: "arxiv" }),
	"2107.08369": record({ title: "ETCI flood", arxiv_id: "2107.08369", year: "2021", source: "arxiv" }),
	"10.3390/rs12152469": record({ title: "Sentinel-1 water mapping", doi: "10.3390/rs12152469", year: "2020", source: "openalex" }),
	"10.1038/nature20584": record({ title: "Global surface water", doi: "10.1038/nature20584", year: "2016", source: "openalex" }),
	"10.1080/01431169608948714": record({ title: "The use of the NDWI", doi: "10.1080/01431169608948714", year: "1996", source: "openalex" }),
};
const calls: string[] = [];
const stubDeps: CodeSearchDeps = {
	hfSearch: async (text, limit) => {
		calls.push(`hf:${text}:${limit}`);
		return [
			{ arxivId: "2411.01411", title: "AI4G flood", repoUrl: "https://github.com/microsoft/ai4g-flood", stars: 67 },
			{ arxivId: "2107.08369", title: "ETCI flood", repoUrl: null, stars: null },
			{ arxivId: "1703.06870", title: "Mask R-CNN", repoUrl: "https://github.com/ecohydro/CropMask_RCNN", stars: 32 },
		];
	},
	githubSearch: async (query, perPage) => {
		calls.push(`gh:${query}:${perPage}`);
		return [
			{ html_url: "https://github.com/davdma/floodmaps", name: "floodmaps", created_at: "2024-01-01T00:00:00Z" },
			{ html_url: "https://github.com/arbal/awesome-stars", name: "awesome-stars", created_at: "2021-01-01T00:00:00Z" },
			{ html_url: "https://github.com/cordmaur/Sentinel1-Flood-Finder", name: "Sentinel1-Flood-Finder", created_at: "2024-01-30T00:00:00Z" },
			{ html_url: "https://github.com/none/readme-less", name: "readme-less", created_at: "2024-01-30T00:00:00Z" },
		];
	},
	readme: async (owner, repo) => {
		calls.push(`readme:${owner}/${repo}`);
		if (repo === "floodmaps") return "Paper: https://arxiv.org/abs/2411.01411";
		if (repo === "Sentinel1-Flood-Finder") return "Based on https://doi.org/10.1038/nature20584 and NDWI https://doi.org/10.1080/01431169608948714";
		if (repo === "hydra-floods") return "Cite https://doi.org/10.3390/rs12152469";
		if (repo === "CropMask_RCNN") return "arXiv:1703.06870";
		return null;
	},
	repoMeta: async (owner, repo) => {
		calls.push(`meta:${owner}/${repo}`);
		if (repo === "ai4g-flood") return { createdAt: "2024-09-04T00:00:00Z", stars: 67, archived: false };
		if (repo === "CropMask_RCNN") return { createdAt: "2019-01-29T00:00:00Z", stars: 32, archived: false };
		if (repo === "hydra-floods") return { createdAt: "2018-06-10T00:00:00Z", stars: 187, archived: false };
		return null;
	},
	listsForTopic: async (topic) => {
		calls.push(`lists:${topic}`);
		return topic === "remote-sensing" ? [{ slug: "sidl/techniques", projectsCount: 1690 }, { slug: "opengeos/Awesome-GEE", projectsCount: 207 }] : [];
	},
	listEntries: async (slug) => {
		calls.push(`entries:${slug}`);
		if (slug === "sidl/techniques") {
			return [
				{ name: "hydra-floods", description: "surface water maps from remote sensing data", category: "Segmentation", repoUrl: "https://github.com/Servir-Mekong/hydra-floods" },
				{ name: "CropMask_RCNN", description: "flood mapping with Mask R-CNN", category: "Segmentation", repoUrl: "https://github.com/ecohydro/CropMask_RCNN" },
				{ name: "Global Surface Water Explorer", description: "water mapping website", category: "Websites", repoUrl: null },
				{ name: "LO-Det", description: "object detection in aerial images", category: "Detection", repoUrl: "https://github.com/x/LO-Det" },
			];
		}
		return [];
	},
	lookupArxiv: async (ids) => {
		calls.push(`arxiv:${ids.join(",")}`);
		return ids.map((id) => papers[id]).filter(Boolean);
	},
	lookupDois: async (dois) => {
		calls.push(`openalex:${dois.join(",")}`);
		return dois.map((d) => papers[d]).filter(Boolean);
	},
};
const scope = { blocks: [["water", "flood"], ["mapping", "segmentation"]] };

// resolvePairs: dedupe by id (first repo wins), arXiv batch + OpenAlex
// batch, date gate with metadata lookup, unchecked when no metadata,
// survivors capped, late pairs appended with the reason.
{
	calls.length = 0;
	const failures: CodeSearchDeps extends never ? never : Array<{ step: string; error: string }> = [];
	const records = await resolvePairs([
		{ repoUrl: "https://github.com/microsoft/ai4g-flood", id: { kind: "arxiv", value: "2411.01411" } },
		{ repoUrl: "https://github.com/other/dup", id: { kind: "arxiv", value: "2411.01411v2" } },
		{ repoUrl: "https://github.com/ecohydro/CropMask_RCNN", id: { kind: "arxiv", value: "1703.06870" } },
		{ repoUrl: "https://github.com/unknown/meta", id: { kind: "doi", value: "10.3390/rs12152469" } },
		{ repoUrl: null, id: { kind: "arxiv", value: "2107.08369" } },
		{ repoUrl: "https://github.com/x/missing", id: { kind: "doi", value: "10.1/missing" } },
	], "test-source", 10, { deps: stubDeps }, failures);
	assert.equal(calls.filter((c) => c.startsWith("arxiv:")).length, 1);
	assert.equal(calls.filter((c) => c.startsWith("openalex:")).length, 1);
	assert.deepEqual(failures, []);
	const byId = Object.fromEntries(records.map((r) => [r.arxiv_id || r.doi, r]));
	assert.equal(byId["2411.01411"].code_url, "https://github.com/microsoft/ai4g-flood");
	assert.equal(byId["2411.01411"].source, "test-source");
	assert.equal(byId["2411.01411"].resolved_via, "arxiv");
	assert.deepEqual(byId["2411.01411"].enriched, { code_url: "test-source" });
	assert.equal(byId["2411.01411"].code_gate, undefined);
	assert.equal(byId["1703.06870"].code_gate, "late");
	assert.match(byId["1703.06870"].code_gate_note ?? "", /CropMask_RCNN, created 2 years after the paper/);
	assert.equal(byId["10.3390/rs12152469"].code_gate, "unchecked");
	assert.equal(byId["10.3390/rs12152469"].resolved_via, "openalex");
	assert.equal(byId["2107.08369"].code_url, undefined);
	assert.equal(byId["2107.08369"].code_gate, undefined);
	assert.equal(byId["10.1/missing"], undefined);
	// Late pairs sit AFTER the survivors; the cap applies to survivors only.
	assert.equal(records[records.length - 1].code_gate, "late");
	const capped = await resolvePairs([
		{ repoUrl: null, id: { kind: "arxiv", value: "2411.01411" } },
		{ repoUrl: null, id: { kind: "arxiv", value: "2107.08369" } },
	], "s", 1, { deps: stubDeps }, []);
	assert.equal(capped.length, 1);
	// Resolution failure is recorded, the rest continues.
	const failing = { ...stubDeps, lookupArxiv: async () => { throw new Error("arXiv answered HTTP 429"); } };
	const fails: Array<{ step: string; error: string }> = [];
	const partial = await resolvePairs([
		{ repoUrl: null, id: { kind: "arxiv", value: "2411.01411" } },
		{ repoUrl: null, id: { kind: "doi", value: "10.3390/rs12152469" } },
	], "s", 5, { deps: failing }, fails);
	assert.equal(partial.length, 1);
	assert.deepEqual(fails, [{ step: "resolve at arXiv", error: "arXiv answered HTTP 429" }]);
	// Abort between steps throws.
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(resolvePairs([{ repoUrl: null, id: { kind: "arxiv", value: "2411.01411" } }], "s", 5, { deps: stubDeps, signal: controller.signal }, []), /aborted/);
}

// hf-papers: repo-bearing papers first, candidates = all papers, gate via metadata.
{
	calls.length = 0;
	const result = await CODE_SEARCHERS["hf-papers"]("ignored", 5, scope, { deps: stubDeps });
	assert.equal(calls[0], "hf:water flood mapping segmentation:15");
	assert.equal(result.candidates, 3);
	assert.deepEqual(result.failures, []);
	assert.deepEqual(result.records.map((r) => [r.arxiv_id, r.code_url ?? null, r.code_gate ?? "pass"]), [
		["2411.01411", "https://github.com/microsoft/ai4g-flood", "pass"],
		["2107.08369", null, "pass"],
		["1703.06870", "https://github.com/ecohydro/CropMask_RCNN", "late"],
	]);
	assert.ok(result.records.every((r) => r.source === "hf-papers"));
	// A failing search throws (the engine records it as a source failure).
	await assert.rejects(CODE_SEARCHERS["hf-papers"]("q", 5, scope, { deps: { ...stubDeps, hfSearch: async () => { throw new Error("HTTP 429"); } } }), /Hugging Face papers search failed: HTTP 429/);
}

// github-readme: qualifier on the query, aggregator skipped, README ids,
// created_at from the search item (no metadata call), late pair flagged.
{
	calls.length = 0;
	const result = await CODE_SEARCHERS["github-readme"]("ignored", 5, scope, { deps: stubDeps });
	assert.equal(calls[0], 'gh:water flood mapping segmentation "arxiv.org" in:readme:15');
	assert.ok(!calls.some((c) => c === "readme:arbal/awesome-stars"));
	assert.ok(!calls.some((c) => c.startsWith("meta:")));
	assert.equal(result.candidates, 3);
	const flood = result.records.find((r) => r.arxiv_id === "2411.01411")!;
	assert.equal(flood.code_url, "https://github.com/davdma/floodmaps");
	assert.equal(flood.source, "github-readme");
	// Pekel 2016 cited by a 2024 repository (gap 8) and the 1996 NDWI paper
	// (gap 28): both beyond LATE_DISCARD_YEARS -> not listed at all, one
	// warn line counts them.
	assert.ok(LATE_DISCARD_YEARS < 8);
	assert.equal(result.records.find((r) => r.doi === "10.1038/nature20584"), undefined);
	assert.equal(result.records.find((r) => r.doi === "10.1080/01431169608948714"), undefined);
	assert.deepEqual(result.records.map((r) => r.arxiv_id), ["2411.01411"]);
	const warned: string[] = [];
	await CODE_SEARCHERS["github-readme"]("ignored", 5, scope, { deps: stubDeps, warn: (m) => warned.push(m) });
	assert.match(warned.join("\n"), /github-readme: 2 pair\(s\) discarded -- repository created more than 5 years after the paper/);
}

// gee-github: the GEE qualifiers, otherwise the same path.
{
	calls.length = 0;
	await CODE_SEARCHERS["gee-github"]("ignored", 5, scope, { deps: stubDeps });
	assert.equal(calls[0], 'gh:(water OR flood) (mapping OR segmentation) "code.earthengine.google.com" in:readme "doi.org" in:readme:15');
}

// awesome-lists: lists by topic (largest first, deduped), entries matched
// against the blocks, READMEs read, metadata looked up for the gate,
// per-process cache, no blocks = honest skip.
{
	clearListCache();
	calls.length = 0;
	const result = await CODE_SEARCHERS["awesome-lists"]("ignored", 5, scope, { deps: stubDeps, listTopics: ["remote-sensing", "empty-topic"] });
	assert.deepEqual(calls.filter((c) => c.startsWith("lists:")), ["lists:remote-sensing", "lists:empty-topic"]);
	assert.deepEqual(calls.filter((c) => c.startsWith("entries:")), ["entries:sidl/techniques", "entries:opengeos/Awesome-GEE"]);
	assert.deepEqual(calls.filter((c) => c.startsWith("readme:")), ["readme:Servir-Mekong/hydra-floods", "readme:ecohydro/CropMask_RCNN"]);
	assert.equal(result.candidates, 2);
	const hydra = result.records.find((r) => r.doi === "10.3390/rs12152469")!;
	assert.equal(hydra.code_url, "https://github.com/Servir-Mekong/hydra-floods");
	assert.equal(hydra.code_gate, undefined);
	assert.equal(hydra.source, "awesome-lists");
	assert.equal(result.records.find((r) => r.arxiv_id === "1703.06870")!.code_gate, "late");
	// Second run: lists are cached per process.
	calls.length = 0;
	await CODE_SEARCHERS["awesome-lists"]("ignored", 5, scope, { deps: stubDeps, listTopics: ["remote-sensing"] });
	assert.equal(calls.filter((c) => c.startsWith("entries:")).length, 0);
	// Quoted query without blocks: skipped honestly.
	const warnings: string[] = [];
	const skipped = await CODE_SEARCHERS["awesome-lists"]('"exact phrase"', 5, undefined, { deps: stubDeps, warn: (m) => warnings.push(m) });
	assert.equal(skipped.candidates, 0);
	assert.match(warnings[0], /no concept blocks/);
	clearListCache();
}

// MAX_IDS_PER_README caps a long reference list at the first two ids.
{
	const many = Array.from({ length: 12 }, (_, i) => `https://arxiv.org/abs/2401.${String(10000 + i).slice(1)}`).join(" ");
	assert.ok(paperIdsFromText(many).length > MAX_IDS_PER_README);
	assert.equal(MAX_IDS_PER_README, 2);
}

console.log("codesearch.test.ts: all assertions passed");
