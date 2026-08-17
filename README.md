# pi-literature-review

Local, open, login-free literature review tooling for the
[Pi coding agent](https://pi.dev): one package, one tool per pipeline
stage, one shared data folder.

| Stage | Tool | Command | Writes to |
|---|---|---|---|
| Search | `pi-literature-search` | `/lit-search` | `lit-search/` (HTML + JSON per run) |
| Selection | `pi-literature-selection` | `/lit-selection` | `lit-selection/` (the PDF library) |
| Synthesis | `pi-literature-synthesis` | `/lit-synthesis` | `lit-synthesis/` (reports, protocols, index) |

The folders land directly in the directory pi was started in and sort in
pipeline order. Search queries arXiv, CrossRef, OpenAlex and Semantic
Scholar, then filters, deduplicates, HTTP-verifies, enriches and labels the
records and renders a sortable HTML page. Selection downloads the PDFs you
ticked on that page -- legal open access only. Synthesis answers questions
and builds reports over the local PDFs with page-exact citations.

**The one inviolable rule: no language model is ever in the citation
path.** Titles, authors, years, venues, DOIs and arXiv IDs come only from
the search-API responses; every DOI is verified against doi.org, every arXiv
ID against arxiv.org, and anything that does not resolve is marked
`verified: false` with a reason. A model may shape a search query, suggest
query variants or write prose over numbered text excerpts; fixed code
inserts the citations and validates every marker.

Privacy: the package talks only to the public arXiv, CrossRef, OpenAlex,
Semantic Scholar, doi.org, arxiv.org, api.unpaywall.org and (for code
links) api.github.com endpoints, plus your own local embedding server. No
accounts, no scraping, no telemetry. The only personal datum is an optional
contact email for Unpaywall that you enter yourself. Paper content leaves
your machine only if you deliberately configure a remote LLM backend (see
Configuration).

## Install

```
pi install git:github.com/<owner>/pi-literature-review    # once published
pi install /absolute/path/to/pi-literature-review         # local checkout
```

pi runs `npm install` for published packages; for a local checkout run it
yourself in this directory (on filesystems without symlinks, e.g. exFAT:
`npm install --no-bin-links`). Two direct dependencies (`fast-xml-parser`,
`unpdf`), nine packages in total, no install scripts. The pi packages listed
as optional peer dependencies are provided by pi itself at runtime.

Search and selection need nothing else. Synthesis needs a local embedding
model: install [Ollama](https://ollama.com), run `ollama pull bge-m3`, and
set `"llm": {"embedModel": "bge-m3"}` in the config file (see below).
Generation runs on the model you selected in pi.

## Search (`/lit-search`)

Type `/lit-search` or ask the agent in plain words ("find papers on drone
remote sensing of floodplains"). Either way a tabbed terminal wizard opens
before anything is searched -- enforced by code, not by an instruction the
model could skip. Escape cancels the whole run. Tabs:

- **Query** -- your search text; an agent proposal is only the prefill.
- **Query variants** -- one call to the model selected in pi suggests up to
  six alternative searches as concept-block boolean queries (OR-synonyms
  within a concept, AND between concepts: `(river OR stream) AND (water
  extraction OR water mapping) AND (satellite OR remote sensing)`), staggered
  narrow to broad and in the base query's concept order. One row is a
  computer-science phrasing tagged "arXiv/CS phrasing" (arXiv is a
  physics/CS preprint server; domain jargon has almost no coverage there).
  The main query is locked and always runs; every checked row runs as an
  additional search in the same run. Type your own variant in the add row,
  or a direction in the steering row and Enter regenerates. A query typed
  as a prose sentence gets a distilled block query prechecked.
- **Search period** -- last 5/10/20 years, all years, or a custom range.
- **Records** -- results per source (5 default, 50 maximum out of politeness
  towards the free APIs).
- **Journals / Authors** -- the top journals and authors OpenAlex holds for
  this query, loaded into the tab as checkbox lists with hit counts, the
  journal's open 2-year citedness and the author's citations/h-index; an
  "Other ..." row keeps everything unlisted. Empty selection = no filter.
  Picked authors are pushed into the source queries themselves.
- **Filters** -- optional minimum citations and an author-name substring.

**Block search.** The concept blocks of every confirmed query are one
structure with two jobs: they ARE the search (arXiv, OpenAlex and Semantic
Scholar receive them as real boolean queries, CrossRef -- which has no
boolean syntax -- as relevance keywords) and they ARE the label: a record
is `on_target` when it fully matches the blocks of ANY confirmed query, else
`adjacent`; each on_target row shows the exact terms that hit ("via Q2:
river channel · water surface · satellite"). Term matching tolerates
hyphen/space, plural-s and consonant+y -> ies, nothing else.

**Pipeline** (all fixed code): per source and query fetch -> junk filter (no
title or no authors) -> deduplication across sources and variants (DOI /
arXiv ID, version suffixes ignored) -> HTTP verification -> enrichment
(missing citation counts, journal names and abstracts filled by an OpenAlex
identifier lookup, each filled field marked `*`; the journal's 2-year
citedness as an open impact-factor analog; a GitHub code link from the
paper's own abstract or one repository search per arXiv id) -> abstract gate
(records still without an abstract move to the dropped table) -> the
optional filters -> labeling. Nothing disappears silently: every removed
record sits in the dropped table with its reason.

**The results page** (`lit-search/<date>_<query>.html`, JSON sidecar with
the same basename) is self-contained and offline-readable: skim metadata on
top, a collapsed "Search documentation" section with the exact expression
each source received per query, raw hit counts per source and query, and the
selection flow -- the numbers a PRISMA-2020 / PRISMA-S methods section
documents; then the results table and the dropped table with identical
columns (multi-level click sorting, expandable abstracts, long author lists
folded, a BibTeX button per row copying a deterministically generated
entry, and a Graph button opening a citation-context graph -- references and
citing works linked by bibliographic coupling and co-citation, fetched live
from OpenAlex only when opened, only the DOI/title leaves the machine).
Tick rows in either table, "Copy download request", and paste the sentence
into the chat: that is the handover to the selection stage.

The agent never receives the full data -- its tool result is a short
digest (counts, HTML path, one reference line per record); field tests
showed that full citation JSON in a small model's context gets re-typed and
"completed". Tool parameters for agent and headless calls: `query`,
`query_variants`, `per_source`, `sources`, `group_terms`, `min_cites`,
`min_journal_score`, `year_from`/`year_to`, `venues`, `authors`,
`require_pdf`, `verified_only`, `sort`, `enrich`, `html_file`.

Semantic Scholar's anonymous pool is often saturated; the client paces,
retries, then fails loudly and the run continues with the other sources. A
free key from semanticscholar.org/product/api (`s2ApiKey` in the config)
gives a dedicated quota; nothing ever asks for it in a dialog.

## Selection (`/lit-selection`)

Paste the copied "Download these papers: ..." sentence or ask in plain
words. The identifiers appear in an editable dialog, then a consent dialog
lists every identifier with its title from the saved searches; only then
does the network get touched. Resolution per identifier: the record's own
PDF link -> Unpaywall (the non-profit open-access index) -> the arXiv PDF
endpoint. Every download is checked for `%PDF` bytes; no gray sources,
ever. The report is honest per paper: downloaded / already in library /
blocked by publisher (some publishers refuse all automated clients; the
report gives the browser link) / not freely available / invalid identifier.
Files are named `<year>_<FirstAuthor>[_et_al]_<Title_words>.pdf` from the
saved records. Unpaywall needs a contact email: the dialog offers run-only,
save to the config file, or continue without.

## Synthesis (`/lit-synthesis`)

Answers and reports over the local PDF library (the `lit-selection/`
library plus loose PDFs in the working directory; loose PDFs are adopted
when their own DOI/arXiv ID can be extracted and verified, otherwise cited
honestly by filename). PDFs are indexed once (text extraction, reference
list cut off, ~1000-character chunks, embeddings; invalidated by content
hash, embedding model or chunking change).

Trust architecture: the generator sees only numbered text excerpts and may
cite only by excerpt number; fixed code validates every marker, strips
fabricated ones (reported, not hidden) and inserts references from the
verified records. An answer without a single valid citation is flagged
`grounded: false` with an unmissable warning. Retrieval combines the
question, a disclosed English translation variant and a deterministic
lexical layer (salient words of your question, whole-word matched); it is
sensitive to phrasing, so the agent is told to pass your question verbatim
and the answer card shows the question exactly as it ran.

- **Chat mode.** One grounded answer per question, page-exact references
  (`[1] 2026 | 10.5194/... | Title (p. 4)`), rendered as a card with
  `file://...pdf#page=N` links. Every grounded round arms a paper-chat mode
  (yellow hint line): plain inputs run directly as questions, no agent in
  the answer path; `exit` leaves it. Every validated round is appended to a
  protocol file under `lit-synthesis/protocols/`.
- **Report mode** (`/lit-synthesis` only -- reports cost many model calls,
  so the wizard is the consent): per-paper structured summaries along a
  fixed rubric, detail questions per paper or merged across the scope, and
  an optional review synthesis. The HTML report follows the chat language,
  keeps references with their paper, and its citation superscripts open
  the PDF at the page and highlight the whole cited passage (the code
  reproduces the PDF viewer's own text matching to guarantee that).
- **HTML-write gate.** "Make me an HTML of that" must yield the
  deterministic report, never an agent-written file: any agent write of an
  `.html` file while a document scope is active opens a dialog offering the
  report wizard.

The document scope (one paper, a selection, the library) is picked in the
wizard and stays sticky within one pi session. All dialogs follow the chat's
language (German/English, English default).

Models: chat answers, summaries and reviews run on the model selected in pi.
Optionally a dedicated model can take over the review genres
(`"llm": {"generateModel": "<name>"}`, e.g. a hand-imported OpenScholar-8B).
Embeddings always run on the configured backend -- pi's model API has no
embedding call.

## Configuration

One optional file at the OS-standard location (`node src/cli.ts llm-check`
prints the resolved path):

- Linux/macOS: `~/.config/pi-literature-review/config.json` (respects `$XDG_CONFIG_HOME`)
- Windows: `%APPDATA%\pi-literature-review\config.json`

It sits outside the package folder on purpose: pi resets its managed
package folders on update. Every field has an environment-variable override
(`PI_LITERATURE_REVIEW_*`), listed with each key:

| Key | Env | Meaning |
|---|---|---|
| `mailto` | `_MAILTO` | contact email for Unpaywall and API polite pools |
| `s2ApiKey` | `_S2_API_KEY` | free Semantic Scholar key |
| `githubToken` | `_GITHUB_TOKEN` | raises the code-link search limit 10 -> 30/min |
| `llm.baseUrl`, `llm.api` | `_LLM_URL`, `_LLM_API` | backend, default Ollama at `http://127.0.0.1:11434`; `api: "openai"` for any OpenAI-compatible server (llama.cpp's llama-server, ...) |
| `llm.embedModel` | `_EMBED_MODEL` | embedding model (default `nomic-embed-text`; recommended `bge-m3`) |
| `llm.generateModel` | `_LLM_MODEL` | optional dedicated review model; CLI default `openscholar-8b` |
| `llm.chatModel` | `_CHAT_MODEL` | CLI generator for chat answers and summaries |
| `llm.embedBaseUrl/embedApi`, `llm.generateBaseUrl/generateApi` | `_EMBED_URL/_EMBED_API`, `_GENERATE_URL/_GENERATE_API` | per-role backend split, e.g. two llama-server instances |
| `llm.apiKey` | `_LLM_API_KEY` | bearer token for a remote OpenAI-compatible API. DISCLOSURE: then your PDF text (chunks and questions) is sent to that provider -- local and key-free stays the default |
| -- | `_HOME` | root for the `lit-*` folders (default: working directory) |

Example:

```json
{ "llm": { "embedModel": "bge-m3", "generateModel": "openscholar-8b" } }
```

## Command line (no pi)

```
node src/cli.ts "sandbar detection rivers Sentinel-1 Sentinel-2" -n 5 -s arxiv,crossref,openalex \
  -g "river,fluvial;sandbar,bar;sentinel,s-1,s-2" --variant "alternate bars rivers Sentinel-2" --html --digest
node src/cli.ts selection 10.3390/rs13081505 arXiv:2401.16393
node src/cli.ts synthesis "Which cameras were used?" --paper 2026_Blanch_Water_Level.pdf --digest
node src/cli.ts synthesis --report --papers "a.pdf,b.pdf" --questions "q1;q2" --summary bullets
node src/cli.ts llm-check
```

## Web / RPC clients

In pi's RPC mode (web frontends) the wizards run as a chain of modal
dialogs; result cards are a TUI feature, so a finished command run hands
its text to the agent for one verbatim chat answer. Progress widgets are
invisible in clients that do not render them. Some clients report an empty
editor save as cancelled -- the dialog chain therefore never treats an
editor cancel as a run abort.

## What this tool does not do

- No LLM inside the search pipeline; no full-text search of papers
  (sources index title/abstract/metadata).
- No padding: a niche query returning two on-target papers yields two.
- No repair of source metadata; broken characters in a database's own
  records pass through unmodified.
- No Scopus / Web of Science / Sci-Hub: open, login-free sources only.

## Tests

Tests sit next to their modules (`src/<name>.test.ts`, `src/sources/*.test.ts`)
and run with plain Node: `for f in src/*.test.ts src/sources/*.test.ts; do node "$f"; done`.
Acceptance gate before any release: the ground-truth query `"sandbar
detection rivers Sentinel-1 Sentinel-2"` must return DOIs `10.3390/rs13081505`
and `10.3390/rs18010132` with `verified: true`, and a fabricated DOI must
come out `verified: false`.

## License and attribution

MIT (see LICENSE). The multi-source search design follows
[paper-search-mcp](https://github.com/openags/paper-search-mcp) (MIT,
Copyright 2025 OPENAGS), which served as the engine during prototyping; the
sources here are implemented natively against the public APIs.
