# pi-literature-review

Local, open, login-free literature review extension for the
[Pi coding agent](https://pi.dev). One package, three tools: `/lit-search`
for searching, `/lit-selection` for downloading, `/lit-synthesis` for
understanding academic literature.

Uses the public APIs of arXiv, CrossRef, OpenAlex and Semantic Scholar — no
account, no key, no paid service required. No subscription to a frontier
model needed either: the LLM side can run entirely locally on a small model
([requirements and tested setups](docs/requirements.md)).

![The /lit-search wizard on the query variants tab](docs/img/search-variants-tab.png)

Every stage writes into the directory you started Pi in:

| Stage | Command | What it does | Creates |
|---|---|---|---|
| Literature search | `/lit-search` | Searches arXiv, CrossRef, OpenAlex and Semantic Scholar; filters, deduplicates, verifies, enriches and labels the records | one HTML page + JSON file per run in `lit-search/` |
| Literature selection | `/lit-selection` | Downloads the papers you ticked on the results page (legal open access only) | the PDF library in `lit-selection/` |
| Literature synthesis | `/lit-synthesis` | Chats about one paper or builds a report over the PDF library, with page-exact citations | HTML reports and chat protocols in `lit-synthesis/` |

**The one inviolable rule: no LLM is ever in the citation path.** Titles,
authors, years, venues, DOIs and arXiv IDs come only from the search-API
responses; every DOI is verified against doi.org, every arXiv ID against
arxiv.org, and whatever does not resolve is marked `verified: false`. The
model shapes search queries, suggests variants, and writes answers and
summaries over numbered text excerpts — fixed code inserts every citation,
validates every marker and highlights the cited passage in the PDF.

## Install

```bash
pi install npm:pi-literature-review                        # once published
pi install git:github.com/<owner>/pi-literature-review    # from the repository
```

Two direct dependencies (`fast-xml-parser`, `unpdf`), nine packages in total,
no install scripts. The Pi packages listed as optional peer dependencies are
provided by Pi itself at runtime.

Search and selection work out of the box — even with no model selected in
Pi. Synthesis needs one small local embedding model: the first
`/lit-synthesis` checks for it and offers to fetch it (Ollama, ~1.2 GB,
one-time, stays on your machine). Generation runs on the model you selected
in Pi — see [Requirements](docs/requirements.md) for tested model and
hardware combinations.

## Usage

Three slash commands, checked by Pi before the agent — each opens its own
terminal dialog directly:

- `/lit-search` — literature search (tabbed wizard: query, query variants,
  period, records per source, journals, authors, filters)
- `/lit-selection` — download papers by DOI / arXiv ID
- `/lit-synthesis` — chat about a paper, summarize, synthesize

Or just ask in the chat; the agent calls the same tools and the same
dialogs open:

- `I want to conduct a literature review on satellite remote sensing for water classification in rivers`
- `Which cameras do Blanch et al. (2026) use in their paper "Image-based method for real-time water level monitoring"?`

How it fits together: `/lit-search` queries the four sources, then filters,
drops duplicates, HTTP-verifies, enriches and labels the records and renders
a sortable HTML page (with a citation graph one click away per paper).
Tick rows on that page, hit "Copy download request", and paste the sentence
into the chat — that is the handover to `/lit-selection`, which downloads
the PDFs into the library. `/lit-synthesis` then answers questions and
builds reports over those PDFs with page-exact citations.

## Three things worth seeing

**Citations that land on the highlighted sentence.** Every reference in a
synthesis answer or report carries the page it came from. Click it and the
PDF opens at that page with the cited passage highlighted — not the page,
the passage. The code reproduces the PDF viewer's own text matching to
guarantee the highlight actually lands. You never have to take a summary's
word for it; checking a claim is one click.

![Report citation next to the PDF with the highlighted passage](docs/img/synthesis-highlight.png)

**A citation graph per paper.** Every row on the results page has a Graph
button. It opens the paper's citation context: its references and the works
citing it, linked by bibliographic coupling and co-citation, so clusters of
related literature become visible. Useful for spotting the paper everyone in
a field cites but your query missed. The graph is fetched live from OpenAlex
only when you open it, and only the DOI or title leaves your machine.

![Citation graph of one paper](docs/img/network-graph.png)

**The search documented the way a methods section needs it.** Each results
page carries a collapsed "Search documentation" block: the exact query each
database received, the raw hit counts per source and query, and the
selection flow from identified to included — the material a PRISMA-2020
flow diagram and a PRISMA-S methods section ask for, produced by the run
itself.

![Results page with the search documentation opened](docs/img/search-results-page.png)

## Privacy

The package talks only to the public arXiv, CrossRef, OpenAlex, Semantic
Scholar, doi.org, arxiv.org, api.unpaywall.org and (for code links)
api.github.com endpoints, plus your own local embedding server. No accounts,
no scraping, no telemetry. The only personal datum is an optional contact
email for Unpaywall that you enter yourself. Paper content leaves your
machine only if you deliberately configure a remote LLM backend via API
(see [Configuration](docs/configuration.md)).

## Documentation

| Document | Contents |
|---|---|
| [Requirements](docs/requirements.md) | What each stage needs, tested hardware and model setups |
| [Search](docs/search.md) | The wizard tabs, block search, the pipeline, the results page, tool parameters |
| [Selection](docs/selection.md) | Consent dialogs, resolution order, file naming, the honest per-paper report |
| [Synthesis](docs/synthesis.md) | Indexing, trust architecture, chat mode, report mode, the HTML-write gate |
| [Configuration](docs/configuration.md) | Optional: llama.cpp, remote APIs, a dedicated review model, keys -- every key and environment override |
| [Command line](docs/cli.md) | Using the package without the Pi agent |
| [Development and tests](docs/development.md) | Layout, running from a checkout, the test suite, web/RPC clients, the release acceptance gate |

## What this tool does not do

- No LLM inside the search pipeline; no full-text search of papers
  (sources index title/abstract/metadata).
- No padding: a niche query returning two on-target papers yields two.
- No repair of source metadata; broken characters in a database's own
  records pass through unmodified.
- No Scopus / Web of Science / Sci-Hub: open, login-free sources only.

## Status

Version 0.1.0. Developed and field-tested on Linux (see
[Requirements](docs/requirements.md)); Windows and macOS paths are
implemented but untested.

## License, attribution and citation

MIT (see LICENSE). The multi-source search design was inspired by
[paper-search-mcp](https://github.com/openags/paper-search-mcp) (MIT,
Copyright 2025 OPENAGS), which served as the engine during prototyping; the
sources here are implemented natively against the public APIs.
To cite this software, use the metadata in `CITATION.cff` (GitHub offers it
under "Cite this repository").
