# Search (`/lit-search`, tool `pi-literature-search`)

Deterministic literature discovery over arXiv, CrossRef, OpenAlex and
Semantic Scholar. The model shapes queries at most; every record on the
page comes from an API response.

## Starting a search

Type `/lit-search`, or ask the agent in plain words ("find papers on
drone remote sensing of floodplains"). Either way a tabbed terminal wizard
opens BEFORE anything is searched -- enforced by code, not by an
instruction the model could skip (field tests showed models reliably skip
"ask the user first" instructions). An agent proposal is only the prefill;
your edits win. Escape (or Ctrl+C) cancels the whole run without a network
call. The dialog follows the chat's language (German/English; English
until the first German chat input).

![Query variants tab](img/search-variants-tab.png)

### The tabs

- **Query** -- the search text. Plain keywords derive one concept block per
  content word; you may also type a block expression yourself
  (`(river OR fluvial) AND (sandbar) AND (sentinel-2)`), which is used as
  written; quotes and arXiv field syntax pass through untouched.
- **Query variants** -- reaching the tab fires ONE call to the model
  selected in Pi, which suggests up to six alternative searches as
  concept-block boolean queries: OR-linked synonyms within a concept, AND
  between concepts, e.g. `(river OR stream) AND (water extraction OR water
  mapping) AND (satellite OR remote sensing)`. The rows are staggered
  narrow to broad and keep the base query's concept order (fixed code
  re-sorts blocks that share a word with a base concept), so they are
  comparable at a glance. One row is a computer-science phrasing tagged
  "arXiv/CS phrasing" -- arXiv is a physics/CS preprint server where
  domain jargon has almost no coverage, while method words ("water body"
  AND segmentation, sensor names as an OR list) do. The top row is your
  main query, locked, it always runs; every checked row runs as an
  ADDITIONAL search in the same run. Above the steering row sits an add
  row (type your own variant, Enter adds it checked); the steering row
  takes a direction ("more deep learning", "auf Deutsch") and Enter
  regenerates -- checked rows survive regeneration. A query typed as a
  prose sentence gets a distilled block query prechecked instead of an
  unsatisfiable word-per-block chain. No model or a failed call: the tab
  degrades to the locked main query plus a note.
- **Search period** -- last 5 / 10 / 20 years (ranges roll with the
  calendar), all years, or a custom range (`2015-2024`, `2015-`, `2024`).
- **Records** -- results per source: 5 (default), 15, 50 (the politeness
  cap towards the free APIs), or a custom count.
- **Journals** -- one OpenAlex facet query loads the top journals holding
  results for this query into the tab as a checkbox list, each with its
  hit count and its OpenAlex 2-year citedness (the open analog of the
  proprietary impact factor: "Remote Sensing (1739 hits · 2-yr rate
  4.6)"); an "Other journals/sources (not listed here)" row keeps
  everything unlisted, so checking all rows means no filter, not a hidden
  top-12 whitelist. Empty selection = no filter. The list follows the
  chosen period.
- **Authors** -- same mechanics: the top authors for this query with hits
  and the author's open OpenAlex metrics (total citations, h-index over
  the whole oeuvre, top research topics), plus an "Other authors" row.
  Picked authors are pushed into the source queries themselves (arXiv
  `au:`, CrossRef `query.author`, OpenAlex `raw_author_name.search`), so
  their papers actually arrive; without a pick every request is
  unchanged.
- **Filters** -- optional and off by default: minimum citations, author
  name substring.
- **Confirm** -- the review page: what a tab shows is what runs; an empty
  query cancels honestly.

## Block search

The concept blocks of every confirmed query are ONE structure with two
jobs -- the systematic-review "building blocks" method made executable:

- They ARE the search. arXiv, OpenAlex and Semantic Scholar support boolean
  queries and receive the blocks as such (`(all:river OR all:stream) AND
  ...`, `(river OR stream) AND ...`, `+(river | stream) +...`); CrossRef
  has no boolean syntax and receives the block terms as flat relevance
  keywords. Semantic Scholar's bulk endpoint has no relevance ranking --
  results arrive sorted by citation count, disclosed on the page.
- They ARE the label. A record is `on_target` when its title+abstract
  fully matches the blocks of ANY confirmed query (at least one term from
  every block), regardless of which query surfaced it; everything else is
  `adjacent`. Every on_target row carries an evidence line ("via Q2:
  multispectral · stream · feature extraction") naming the winning query
  and the exact term that hit per block, so a mislabeling homonym is
  readable at a glance. Term matching is whole-word with exactly three
  tolerances: hyphen/space interchange, plural-s, consonant+y -> ies. No
  stemming, no synonyms -- those belong in the blocks.

The precision of a run therefore lives in the block quality. Broad homonym
blocks (bare "stream", "channel") both fetch noise and label it on_target;
the suggestion prompt asks for anchored phrases and the evidence line makes
the culprit visible.

## The pipeline (all fixed code)

1. Per source and per query: fetch `per_source` records; raw hit counts are
   recorded before anything else (`source_counts`).
2. Junk filter: records without title or without authors are uncitable and
   go to the dropped table.
3. Deduplication across sources and variants by DOI / arXiv ID (version
   suffixes ignored); merged records keep the richest metadata and list
   every source and every query that found them (`found_by`).
4. HTTP verification: every DOI against doi.org (a real DOI redirects to
   the publisher), every arXiv ID against arxiv.org. `verified: false`
   carries a plain-language reason.
5. Enrichment (`enrich`, default on): a deterministic OpenAlex identifier
   lookup fills MISSING citation counts, journal names and abstracts (never
   overwrites; every filled field is listed under `enriched` and marked `*`
   on the page); the journal's 2-year citedness is attached; a GitHub code
   link is attached from two signals in order of precision -- a repository
   URL named in the paper's own abstract (zero requests), else one GitHub
   repository search per arXiv id (aggregator/reading-list repos skipped,
   paced to GitHub's limits, capped per run with on_target first; an
   optional token raises the limit).
6. Abstract gate: records still without an abstract move to the dropped
   table -- title-only records cannot be judged fairly by the labeling.
7. The optional filters, each removal with its reason.
8. Labeling against the confirmed queries' blocks.

Nothing disappears silently. A failed source is recorded
(`source_failures`) and shown on the page; the run continues with the
others. Semantic Scholar's anonymous pool is often saturated -- the client
paces and retries, then fails loudly; a free key gives a dedicated quota.

## The results page

Written to `lit-search/<YYYY-MM-DD>_<query>.html` with the full JSON
payload as a sidecar of the same basename (a same-day rerun gets `_2`,
`_3`). Self-contained, offline-readable, generated from the JSON by fixed
code -- its footer says so.

![Results page with the search documentation open](img/search-results-page.png)

- **Skim metadata** on top: query and variants, generated, sources and
  failures, records per source, filters, sort, result counts.
- **Search documentation** (collapsed): the exact expression each source
  received per query ("Sent to arXiv / OpenAlex / CrossRef / Semantic
  Scholar"), the raw hit counts per source and query, the selection flow
  (identified -> uncitable removed -> duplicates merged -> screened ->
  removed without abstract -> excluded by filters -> included, awaiting
  manual selection) and the labeling rule -- the material a
  PRISMA-2020 flow diagram and a PRISMA-S methods section document.
- **Query results** and **Dropped records** with identical columns
  (checkbox, #, Article with expandable abstract, Authors, Year, Journal,
  Score, Citations, DOI, BibTeX, Code when any record has a link, Graph,
  Data source, Label). The dropped table's Label reads "dropped" with the
  reason. Multi-level click sorting (first click = primary key, further
  clicks refine); long author lists fold to first three + last with a
  toggle.
- **BibTeX** copies a deterministically generated entry (`@article` with a
  venue, else `@misc` with arXiv fields; LaTeX specials escaped;
  identifiers verbatim).
![Citation graph of one paper](img/network-graph.png)

- **Graph** opens the paper's citation-context graph in a new tab: its
  references (up to 100) and citing works (up to 50), the 35 best-connected
  shown as circles (area = citation count relative to the most-cited work
  shown, colour = year, the seed ringed), linked by bibliographic coupling
  (shared references, Kessler 1963) and co-citation (Small 1973), direct
  citations weighted extra; hovering a circle focuses its neighbourhood,
  hovering a line names why it exists. The static `network.html` written
  next to every results page fetches this LIVE from the open OpenAlex API
  only when opened (internet needed then; only the DOI or title is sent,
  never paper content; no language model). arXiv-only records resolve by
  title search, disclosed on the page; missing citation data is stated,
  not padded.
- **Selection bar** (floats at the bottom): tick rows in either table,
  "Copy download request", paste the sentence `Download these papers:
  <id>, ...` into the chat -- the handover to `/lit-selection`. A file://
  page cannot download; it only assembles identifiers already printed on
  it.

## What the agent sees

The tool result is a short digest -- counts, HTML path, one reference line
per record (`[group] year | DOI-or-arXiv-ID | title`) -- never the full
JSON: full citation data in a small model's context gets re-typed and
"completed" (fabricated tables, invented page numbers). On the command path
the digest renders as a card in the chat and the agent adds a brief
summary underneath (one LLM call; it never re-types identifiers or paths).

## Tool parameters (agent and headless calls)

- `query` (required); `query_variants` -- alternative searches, each may
  be a block expression; interactive calls show them prechecked in the
  variants tab.
- `per_source` (default 5, cap 50); `sources` -- subset of `arxiv`,
  `crossref`, `openalex`, `semanticscholar`.
- `group_terms` -- the base query's concept blocks as an array of term
  groups (`[["river","fluvial"],["sandbar","bar"]]`); they drive the
  boolean fetch AND the label; omitted, blocks derive from the confirmed
  query.
- `min_cites`, `min_journal_score` (records without a value always pass),
  `year_from` / `year_to`, `venues`, `authors`, `require_pdf`,
  `verified_only`, `sort` (`cites` | `year`), `enrich`, `html_file`.

All filters act on metadata the sources delivered; whatever a filter
removes appears in the dropped table with the reason.
