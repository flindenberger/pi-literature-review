/**
 * Citation-network page -- a STATIC, self-contained HTML file written next
 * to every search result page. The "Network" column of the result tables
 * links here with the record's identifiers in the URL hash
 * (network.html#doi=...&title=...); when opened, the page fetches the
 * paper's citation neighbourhood LIVE from api.openalex.org in the browser
 * and renders a similarity graph (the connected-papers idea, built on the
 * decades-old open bibliometric methods: bibliographic coupling, Kessler
 * 1963, plus direct citations).
 *
 * Live-proven against the real API before building (2026-08-12):
 *   - CORS: api.openalex.org answers access-control-allow-origin: * even
 *     for Origin: null -- a file:// page may fetch it.
 *   - Seed lookup: /works?filter=doi:<doi> works; the /works/arxiv:<id>
 *     path form 404s and arXiv DataCite DOIs (10.48550/...) are NOT indexed
 *     -- arXiv-only records resolve via ?search=<title>&per-page=1, which
 *     the page discloses as "resolved by title search".
 *   - Neighbourhood: referenced_works arrives inside every work object
 *     (select=...), citing works via filter=cites:W...; batch metadata via
 *     filter=ids.openalex:W1|W2 (max 50 ids per request).
 *
 * Doctrine notes: the page is data-only JavaScript over OpenAlex responses
 * -- no LLM anywhere (the citation rule holds), no external script/style
 * (works offline up to the honest "could not reach api.openalex.org"
 * message), deterministic layout (seeded PRNG from the resolved work id, so
 * the same paper always draws the same graph). OpenAlex data is CC0; the
 * page credits the source and disclosures what leaves the machine: only
 * the DOI/title lookup and follow-up identifier queries -- never paper
 * content.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Basename of the network page; the result tables link to it relatively,
 * so page and tables must sit in the same folder. */
export const NETWORK_PAGE_NAME = "network.html";

/** Write (or refresh) the static network page next to a search HTML file
 * and return its path. The content carries no run data, so overwriting a
 * previous run's copy is safe and keeps old pages' links working. */
export function writeNetworkPage(htmlPath: string): string {
	const path = join(dirname(htmlPath), NETWORK_PAGE_NAME);
	writeFileSync(path, renderNetworkHtml(), "utf8");
	return path;
}

const STYLE = `
	body { font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
		color: #1c1c1c; background: #fdfdfc; max-width: 110rem; margin: 0.8rem auto;
		padding: 0 1.2rem; line-height: 1.4; }
	h1 { font-size: 1.15rem; margin: 0 0 0.1rem; display: inline; }
	.meta { font-size: 0.88rem; color: #3d3d3d; margin: 0.1rem 0; display: inline; }
	.status { font-size: 0.85rem; color: #44506b; margin: 0.25rem 0; }
	.status.error { color: #8a1f11; font-weight: 600; }
	a { color: #2b4a6f; }
	#canvas { width: 100%; height: 84vh; min-height: 28rem; border: 1px solid #d9d9d4;
		background: #fdfdfc; margin-top: 0.3rem; display: block; }
	#canvas text { pointer-events: none; }
	#canvas circle { cursor: pointer; }
	#canvas line { pointer-events: stroke; cursor: pointer; }
	.legend { font-size: 0.8rem; color: #3d3d3d; margin: 0.4rem 0 0; }
	.legend .swatch { display: inline-block; width: 0.85rem; height: 0.85rem;
		border-radius: 50%; vertical-align: -0.15rem; margin: 0 0.25rem; }
	#tooltip { position: fixed; display: none; max-width: 26rem; background: #ffffff;
		border: 1px solid #b9b9b2; box-shadow: 0 2px 8px rgba(0,0,0,0.18); padding: 0.5rem 0.65rem;
		font-size: 0.8rem; pointer-events: none; z-index: 10; }
	#tooltip .t-title { font-weight: 600; }
	#tooltip .t-line { color: #3d3d3d; }
	footer { font-size: 0.78rem; color: #6b6b6b; margin: 1.2rem 0 2rem; border-top: 1px solid #d9d9d4;
		padding-top: 0.6rem; }
	footer p { margin: 0.3rem 0; }
`;

// The page script is plain browser JavaScript embedded verbatim. It
// deliberately contains no backticks and no "$" + "{" sequences so this
// TypeScript template literal carries it unmangled.
const PAGE_SCRIPT = `
"use strict";
(function () {
	var API = "https://api.openalex.org";
	var SELECT = "id,display_name,publication_year,cited_by_count,referenced_works,doi,authorships";
	var MAX_NODES = 35;      // seed + up to 34 neighbours
	var MAX_REFS = 100;      // reference metadata fetched (2 batch requests)
	var EDGES_PER_NODE = 4;  // strongest edges kept per node (readability)

	var statusLine = document.getElementById("status");
	var seedLine = document.getElementById("seedline");
	var canvas = document.getElementById("canvas");
	var tooltip = document.getElementById("tooltip");

	function setStatus(text, isError) {
		statusLine.textContent = text;
		statusLine.className = isError ? "status error" : "status";
	}

	function hashParams() {
		var raw = window.location.hash.replace(/^#/, "");
		return new URLSearchParams(raw);
	}

	function getJson(url) {
		return fetch(url).then(function (response) {
			if (!response.ok) throw new Error("api.openalex.org answered HTTP " + response.status);
			return response.json();
		});
	}

	function shortId(work) {
		return String(work.id || "").split("/").pop();
	}

	function firstAuthorLastName(work) {
		var ships = work.authorships || [];
		if (!ships.length || !ships[0].author || !ships[0].author.display_name) return "Unknown";
		var parts = ships[0].author.display_name.trim().split(/\\s+/);
		return parts[parts.length - 1];
	}

	function labelOf(work) {
		var year = work.publication_year ? String(work.publication_year) : "n.d.";
		return firstAuthorLastName(work) + ", " + year;
	}

	// Deterministic PRNG (mulberry32) seeded from the resolved work id --
	// the same paper always settles into the same layout.
	function seededRandom(text) {
		var h = 1779033703;
		for (var i = 0; i < text.length; i++) {
			h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
			h = (h << 13) | (h >>> 19);
		}
		return function () {
			h = Math.imul(h ^ (h >>> 16), 2246822507);
			h = Math.imul(h ^ (h >>> 13), 3266489909);
			h = (h ^= h >>> 16) >>> 0;
			return h / 4294967296;
		};
	}

	function chunk(list, size) {
		var out = [];
		for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
		return out;
	}

	function intersectionSize(setA, setB) {
		var n = 0;
		var small = setA.size <= setB.size ? setA : setB;
		var large = small === setA ? setB : setA;
		small.forEach(function (value) { if (large.has(value)) n++; });
		return n;
	}

	// --- seed resolution -------------------------------------------------
	function resolveSeed(params) {
		var doi = (params.get("doi") || "").trim();
		var title = (params.get("title") || "").trim();
		var byDoi = doi
			? getJson(API + "/works?filter=doi:" + encodeURIComponent(doi) + "&per-page=1&select=" + SELECT)
				.then(function (data) { return (data.results && data.results[0]) || null; })
			: Promise.resolve(null);
		return byDoi.then(function (work) {
			if (work) return { work: work, resolvedBy: "doi" };
			if (!title) return null;
			return getJson(API + "/works?search=" + encodeURIComponent(title) + "&per-page=1&select=" + SELECT)
				.then(function (data) {
					var hit = (data.results && data.results[0]) || null;
					return hit ? { work: hit, resolvedBy: "title search" } : null;
				});
		});
	}

	// --- neighbourhood + similarity --------------------------------------
	function loadNeighbourhood(seed) {
		var refIds = (seed.referenced_works || []).slice(0, MAX_REFS).map(function (id) {
			return String(id).split("/").pop();
		});
		var refBatches = chunk(refIds, 50).map(function (ids) {
			return getJson(API + "/works?filter=ids.openalex:" + ids.join("|") + "&per-page=50&select=" + SELECT)
				.then(function (data) { return data.results || []; });
		});
		var citing = getJson(API + "/works?filter=cites:" + shortId(seed)
			+ "&per-page=50&sort=cited_by_count:desc&select=" + SELECT)
			.then(function (data) { return data.results || []; });
		return Promise.all([citing, Promise.all(refBatches)]).then(function (parts) {
			var citers = parts[0];
			var refs = [];
			parts[1].forEach(function (batch) { refs.push.apply(refs, batch); });
			return { citers: citers, refs: refs };
		});
	}

	function refSetOf(work) {
		var set = new Set();
		(work.referenced_works || []).forEach(function (id) { set.add(String(id).split("/").pop()); });
		return set;
	}

	function buildGraph(seed, neighbourhood) {
		var seedId = shortId(seed);
		var candidates = new Map();
		neighbourhood.refs.concat(neighbourhood.citers).forEach(function (work) {
			var id = shortId(work);
			if (id && id !== seedId && !candidates.has(id)) candidates.set(id, work);
		});

		var refSets = new Map();
		refSets.set(seedId, refSetOf(seed));
		candidates.forEach(function (work, id) { refSets.set(id, refSetOf(work)); });

		// Co-citation signal: how many of the seed's citers also reference
		// the candidate.
		var cocited = new Map();
		neighbourhood.citers.forEach(function (citer) {
			(citer.referenced_works || []).forEach(function (raw) {
				var id = String(raw).split("/").pop();
				cocited.set(id, (cocited.get(id) || 0) + 1);
			});
		});

		var seedRefs = refSets.get(seedId);
		var ranked = Array.from(candidates.values()).map(function (work) {
			var id = shortId(work);
			var coupling = intersectionSize(refSets.get(id), seedRefs);
			var score = coupling + 2 * (cocited.get(id) || 0);
			return { work: work, score: score };
		});
		ranked.sort(function (a, b) {
			return (b.score - a.score) || ((b.work.cited_by_count || 0) - (a.work.cited_by_count || 0));
		});

		var nodes = [seed].concat(ranked.slice(0, MAX_NODES - 1).map(function (entry) { return entry.work; }));
		var ids = nodes.map(shortId);

		// Pairwise similarity: shared references, plus a direct-citation
		// bonus. Then keep only each node's strongest edges -- a full
		// similarity matrix renders as an unreadable hairball.
		var edges = [];
		for (var i = 0; i < nodes.length; i++) {
			for (var j = i + 1; j < nodes.length; j++) {
				var a = ids[i];
				var b = ids[j];
				var shared = intersectionSize(refSets.get(a), refSets.get(b));
				var direct = refSets.get(a).has(b) || refSets.get(b).has(a);
				var weight = shared + (direct ? 3 : 0);
				if (weight >= 2) edges.push({ source: i, target: j, weight: weight, shared: shared, direct: direct });
			}
		}
		var keep = new Set();
		for (var n = 0; n < nodes.length; n++) {
			var mine = [];
			for (var e = 0; e < edges.length; e++) {
				if (edges[e].source === n || edges[e].target === n) mine.push(e);
			}
			mine.sort(function (x, y) { return edges[y].weight - edges[x].weight; });
			mine.slice(0, EDGES_PER_NODE).forEach(function (index) { keep.add(index); });
		}
		return { nodes: nodes, edges: edges.filter(function (_, index) { return keep.has(index); }) };
	}

	// --- layout + drawing --------------------------------------------------
	function yearColor(year, minYear, maxYear) {
		var t = maxYear > minYear ? (year - minYear) / (maxYear - minYear) : 1;
		if (!year) t = 0;
		// Earth tones matching the result pages' warm palette (2026-08-12
		// user wish): light sand #e3dcc9 -> dark umber #55432a, older =
		// lighter, like a fading trail.
		var from = [227, 220, 201];
		var to = [85, 67, 42];
		var rgb = from.map(function (start, index) {
			return Math.round(start + (to[index] - start) * t);
		});
		return "rgb(" + rgb.join(",") + ")";
	}

	// Circle AREA grows with the citation count, scaled to the most-cited
	// work of THIS graph (radius = sqrt of the share). The earlier
	// log10 scale drew 10 vs 217 citations as 10 vs 15 px -- visually
	// almost equal, which defeated the encoding. Pool-relative sqrt keeps
	// the extremes apart (5 px for zero, 24 px for the top work) without a
	// runaway outlier: the largest circle is always exactly 24 px.
	var RADIUS_MIN = 5;
	var RADIUS_MAX = 24;
	function radiusOf(work, maxCites) {
		var share = (work.cited_by_count || 0) / Math.max(1, maxCites || 0);
		return RADIUS_MIN + (RADIUS_MAX - RADIUS_MIN) * Math.sqrt(Math.min(1, share));
	}

	function drawGraph(graph, resolvedBy) {
		var nodes = graph.nodes;
		var seed = nodes[0];
		var maxCites = nodes.reduce(function (acc, work) {
			return Math.max(acc, work.cited_by_count || 0);
		}, 0);
		var random = seededRandom(shortId(seed));
		// Fixed stage, set once: the graph settles centred inside it (an
		// auto-fit viewBox was tried 2026-08-12 and reverted on user
		// feedback -- the floating, not-fully-zoomed look is the elegant one).
		var width = 1400;
		var height = 900;
		canvas.setAttribute("viewBox", "0 0 " + width + " " + height);

		var years = nodes.map(function (w) { return w.publication_year || 0; }).filter(Boolean);
		var minYear = Math.min.apply(null, years.length ? years : [0]);
		var maxYear = Math.max.apply(null, years.length ? years : [0]);
		document.getElementById("legend-old").textContent = String(minYear || "?");
		document.getElementById("legend-new").textContent = String(maxYear || "?");
		document.getElementById("legend-old-swatch").style.background = yearColor(minYear, minYear, maxYear);
		document.getElementById("legend-new-swatch").style.background = yearColor(maxYear, minYear, maxYear);

		var points = nodes.map(function (_, index) {
			if (index === 0) return { x: width / 2, y: height / 2, vx: 0, vy: 0 };
			return {
				x: width / 2 + (random() - 0.5) * width * 0.7,
				y: height / 2 + (random() - 0.5) * height * 0.7,
				vx: 0, vy: 0,
			};
		});

		// Adjacency for the hover focus: a hovered node keeps itself, its
		// neighbours and its incident edges at full strength, the rest fades.
		var neighbours = nodes.map(function () { return new Set(); });
		graph.edges.forEach(function (edge) {
			neighbours[edge.source].add(edge.target);
			neighbours[edge.target].add(edge.source);
		});
		var hoverNode = null;
		var hoverEdge = null;

		function tick() {
			var i, j;
			for (i = 0; i < points.length; i++) {
				for (j = i + 1; j < points.length; j++) {
					var dx = points[j].x - points[i].x;
					var dy = points[j].y - points[i].y;
					var d2 = dx * dx + dy * dy + 40;
					var force = 2600 / d2;
					var dist = Math.sqrt(d2);
					var fx = (dx / dist) * force;
					var fy = (dy / dist) * force;
					points[i].vx -= fx; points[i].vy -= fy;
					points[j].vx += fx; points[j].vy += fy;
				}
			}
			graph.edges.forEach(function (edge) {
				var a = points[edge.source];
				var b = points[edge.target];
				var dx = b.x - a.x;
				var dy = b.y - a.y;
				var dist = Math.sqrt(dx * dx + dy * dy) || 1;
				var rest = Math.max(70, 170 - 12 * Math.min(edge.weight, 8));
				var pull = 0.012 * (dist - rest);
				var fx = (dx / dist) * pull;
				var fy = (dy / dist) * pull;
				a.vx += fx; a.vy += fy;
				b.vx -= fx; b.vy -= fy;
			});
			points.forEach(function (p) {
				p.vx += (width / 2 - p.x) * 0.004;
				p.vy += (height / 2 - p.y) * 0.004;
				p.vx *= 0.85; p.vy *= 0.85;
				p.x += p.vx; p.y += p.vy;
				p.x = Math.max(70, Math.min(width - 70, p.x));
				p.y = Math.max(50, Math.min(height - 50, p.y));
			});
		}

		function render() {
			var focus = hoverNode !== null;
			var parts = [];
			graph.edges.forEach(function (edge, index) {
				var a = points[edge.source];
				var b = points[edge.target];
				var active = (focus && (edge.source === hoverNode || edge.target === hoverNode))
					|| index === hoverEdge;
				var faded = (focus || hoverEdge !== null) && !active;
				var lineWidth = Math.min(0.6 + edge.weight * 0.25, 3) * (active ? 1.9 : 1);
				parts.push('<line data-edge="' + index + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1)
					+ '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1)
					+ '" stroke="' + (active ? "#7a5230" : "#a8a094")
					+ '" stroke-opacity="' + (active ? 0.95 : (faded ? 0.15 : 0.55))
					+ '" stroke-width="' + lineWidth.toFixed(2) + '"/>');
			});
			nodes.forEach(function (work, index) {
				var p = points[index];
				var r = radiusOf(work, maxCites);
				var isSeed = index === 0;
				var inEdge = hoverEdge !== null
					&& (graph.edges[hoverEdge].source === index || graph.edges[hoverEdge].target === index);
				var related = index === hoverNode || inEdge
					|| (focus && neighbours[hoverNode].has(index))
					|| (!focus && hoverEdge === null);
				var stroke = index === hoverNode || inEdge ? "#7a5230" : (isSeed ? "#8a1f11" : "#fdfdfc");
				var strokeWidth = index === hoverNode || inEdge ? 2.5 : (isSeed ? 3 : 1);
				parts.push('<circle data-node="' + index + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1)
					+ '" r="' + r.toFixed(1) + '" fill="' + yearColor(work.publication_year || 0, minYear, maxYear)
					+ '" opacity="' + (related ? 1 : 0.3) + '" stroke="' + stroke
					+ '" stroke-width="' + strokeWidth + '"/>');
				parts.push('<text x="' + p.x.toFixed(1) + '" y="' + (p.y + r + 13).toFixed(1)
					+ '" text-anchor="middle" font-size="11" opacity="' + (related ? 1 : 0.25) + '"'
					+ (isSeed ? ' font-weight="700" fill="#8a1f11"' : ' fill="#2c2c2c"')
					+ '>' + escapeHtml(labelOf(work)) + '</text>');
			});
			canvas.innerHTML = parts.join("");
		}

		var ticks = 0;
		function frame() {
			for (var step = 0; step < 4 && ticks < 320; step++, ticks++) tick();
			render();
			if (ticks < 320) window.requestAnimationFrame(frame);
		}
		window.requestAnimationFrame(frame);

		// Hover focus + tooltip + click-through (delegated: render() rebuilds
		// the SVG content, so listeners must sit on the canvas). Hovering a
		// node highlights it, its incident edges and its neighbours; hovering
		// an edge highlights it and both endpoints, and the tooltip states
		// WHY the link exists (shared references / direct citation).
		function hoverTargets(event) {
			var target = event.target;
			var node = target && target.getAttribute ? target.getAttribute("data-node") : null;
			var edge = target && target.getAttribute ? target.getAttribute("data-edge") : null;
			return {
				node: node === null ? null : Number(node),
				edge: edge === null ? null : Number(edge),
			};
		}
		canvas.addEventListener("mousemove", function (event) {
			var hit = hoverTargets(event);
			if (hit.node !== hoverNode || hit.edge !== hoverEdge) {
				hoverNode = hit.node;
				hoverEdge = hit.edge;
				render();
			}
			if (hit.node !== null) {
				var work = nodes[hit.node];
				tooltip.innerHTML = '<div class="t-title">' + escapeHtml(work.display_name || "(untitled)") + '</div>'
					+ '<div class="t-line">' + escapeHtml(labelOf(work))
					+ ' -- citations: ' + (work.cited_by_count || 0) + '</div>'
					+ '<div class="t-line">click opens ' + (work.doi ? "doi.org" : "openalex.org") + '</div>';
			} else if (hit.edge !== null) {
				var link = graph.edges[hit.edge];
				tooltip.innerHTML = '<div class="t-title">' + escapeHtml(labelOf(nodes[link.source]))
					+ ' &harr; ' + escapeHtml(labelOf(nodes[link.target])) + '</div>'
					+ '<div class="t-line">' + link.shared + ' shared reference(s)'
					+ (link.direct ? ' + direct citation' : '') + '</div>';
			} else {
				tooltip.style.display = "none";
				return;
			}
			tooltip.style.display = "block";
			tooltip.style.left = Math.min(event.clientX + 14, window.innerWidth - 320) + "px";
			tooltip.style.top = (event.clientY + 14) + "px";
		});
		canvas.addEventListener("mouseleave", function () {
			tooltip.style.display = "none";
			if (hoverNode !== null || hoverEdge !== null) {
				hoverNode = null;
				hoverEdge = null;
				render();
			}
		});
		canvas.addEventListener("click", function (event) {
			var hit = hoverTargets(event);
			if (hit.node === null) return;
			var work = nodes[hit.node];
			var href = work.doi && /^https?:/.test(work.doi) ? work.doi : work.id;
			if (href) window.open(href, "_blank", "noopener");
		});

		var suffix = resolvedBy === "doi" ? "" : " (resolved by title search)";
		seedLine.textContent = " -- " + (seed.display_name || "(untitled)") + suffix;
		setStatus(nodes.length + " papers, " + graph.edges.length + " similarity links. "
			+ "Hover a circle or a line for details; click a circle to open the paper.", false);
	}

	function escapeHtml(text) {
		return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	// --- entry point -------------------------------------------------------
	var params = hashParams();
	if (!params.get("doi") && !params.get("title")) {
		setStatus("No paper given. Open this page through the Network column of a literature-search results page.", true);
		return;
	}
	setStatus("Contacting api.openalex.org ...", false);
	resolveSeed(params).then(function (resolved) {
		if (!resolved) {
			setStatus("This paper was not found in OpenAlex -- no citation network available.", true);
			return null;
		}
		setStatus("Loading references and citing works ...", false);
		return loadNeighbourhood(resolved.work).then(function (neighbourhood) {
			var graph = buildGraph(resolved.work, neighbourhood);
			if (graph.nodes.length < 2) {
				setStatus("OpenAlex lists no open references or citing works for this paper -- nothing to draw. "
					+ "That often reflects missing open citation data, not a paper without context.", true);
				seedLine.textContent = " -- " + (resolved.work.display_name || "");
				return;
			}
			drawGraph(graph, resolved.resolvedBy);
		});
	}).catch(function (error) {
		var offline = error instanceof TypeError;
		setStatus(offline
			? "Could not reach api.openalex.org -- this page needs internet access when opened. The search results page itself stays fully offline-readable."
			: "Loading failed: " + (error && error.message ? error.message : error), true);
	});
})();
`;

/** The full static network page. No run data is embedded -- the paper to
 * draw arrives in the URL hash, everything else is fetched live. */
export function renderNetworkHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Citation Network</title>
<style>${STYLE}</style>
</head>
<body>
<div><h1>Citation Network</h1><span class="meta" id="seedline"></span></div>
<p class="status" id="status">Loading ...</p>
<svg id="canvas" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Citation network graph"></svg>
<p class="legend">Circle size = citation count (area proportional, scaled to the most-cited work shown) &middot; colour = publication year
(<span class="swatch" id="legend-old-swatch"></span><span id="legend-old"></span> to
<span class="swatch" id="legend-new-swatch"></span><span id="legend-new"></span>)
&middot; line thickness = shared references &middot; the red-ringed circle is the selected paper.</p>
<div id="tooltip"></div>
<footer>
<p>Data: <a href="https://openalex.org" target="_blank" rel="noopener">OpenAlex</a> (CC0 open scholarly
catalog). This page contacts api.openalex.org only when opened, sending the paper's DOI or title plus
follow-up identifier queries -- never any paper content. Citation coverage is incomplete for some
publishers, so a sparse graph can reflect missing open citation data rather than an unconnected paper.</p>
<p>Method: the graph combines the two classic bibliometric similarity measures. Candidates (the paper's own
references and the works citing it) are ranked by <em>bibliographic coupling</em> (Kessler 1963: two papers
are similar when they cite the same references) plus <em>co-citation</em> (Small 1973: two papers are
similar when later works cite them together -- counted here across the works citing the selected paper).
The drawn links weight the two papers' shared references, a direct citation between them weighs extra, and
only each paper's strongest links are kept. Node size is the citation count, colour the publication year.
Everything is computed deterministically in this page from OpenAlex API responses --
no language model is involved.</p>
</footer>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}
