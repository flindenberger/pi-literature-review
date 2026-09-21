# Development and tests

## Layout

```
index.ts            single extension entry: registers the three tools in pipeline order
extensions/         Pi adapters -- search.ts, selection.ts, synthesis.ts (one tool + command each),
                    dialogs.ts (the tabbed wizard overlay + RPC fallback), pi-model.ts (one call on the Pi model)
src/                the engines, Pi-free: search pipeline, render, network graph, selection,
                    synthesis (extract, retrieve, protocol, citation gate), dialog reducer, config, CLI
src/sources/        the source clients (arxiv, crossref, openalex, semanticscholar), the
                    code-side clients (github, huggingface, ecosystems) and polite.ts, the
                    shared paced/retrying request helper
docs/               this documentation, screenshots under docs/img/
tsconfig.json       type-check settings (strict, NodeNext, .ts imports) for the editor and `tsc`
```

Adapters (`extensions/`) hold everything that touches Pi: tool schemas,
dialogs, widgets, message rendering. Engines (`src/`) are pure and
testable without Pi; the CLI drives them directly. Tests sit next to their
modules (`src/<name>.test.ts`, `src/sources/<name>.test.ts`) and use only
Node's built-in `assert`.

## Running from a checkout

```
npm install            # add --no-bin-links on filesystems without symlinks (exFAT)
pi install /absolute/path/to/pi-literature-review
```

At runtime Pi's extension loader provides `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, `@earendil-works/pi-ai/compat` and `typebox`.
They are declared as optional peer dependencies, so a user install pulls
only this package's own dependencies; for development they are
devDependencies, so `npm install` in a checkout brings them in for the
editor, the type check and the offline smoke test.

Restart Pi after code changes -- `/reload` is not guaranteed for package
extensions.

## Type check and tests

```
node node_modules/typescript/bin/tsc -p tsconfig.json

for f in src/*.test.ts src/sources/*.test.ts; do node "$f" || echo "FAIL $f"; done
node -e "import('./index.ts').then(() => console.log('index loads'))"
```

The type check runs strict TypeScript over `index.ts`, `src/` and
`extensions/`, tests included, and emits no output (Node runs the `.ts`
files directly). It is clean and part of the release gate.

Every test file is standalone and offline; network clients are exercised
against captured fixtures and a stubbed `fetch`. The last line is the
smoke check that the extension entry loads with the peers present.

## Release acceptance gate

Before any release the ground-truth query must pass end to end:

```
node src/cli.ts "sandbar detection rivers Sentinel-1 Sentinel-2" -n 5 -s arxiv,crossref,openalex
```

DOIs `10.3390/rs13081505` and `10.3390/rs18010132` must appear with
`verified: true`, known junk records (empty titles, off-topic keyword
matches) must be dropped with reasons, and a fabricated DOI must come out
`verified: false`.

## Dependencies

A user install pulls nine small packages and runs no install scripts:

| Package | Role |
|---|---|
| `fast-xml-parser` | parses the arXiv Atom responses |
| `unpdf` | extracts text from PDFs (pdf.js bundled inside, no further dependencies); loaded only through `loadUnpdf()` in `src/pdfjs-find.ts`, which first installs a `Math.sumPrecise` polyfill on Node versions without it -- pdf.js needs it while parsing fonts, and without it ligatures such as "fi" vanish from the extracted text |
| `fast-xml-builder`, `strnum`, `anynum`, `is-unsafe`, `xml-naming`, `path-expression-matcher`, `@nodable/entities` | internal helpers of `fast-xml-parser` |

The Pi packages the extension builds on are not among them; see [Running
from a checkout](#running-from-a-checkout).

## Web / RPC clients

Pi web frontends drive Pi in RPC mode. There every wizard runs as a chain
of modal dialogs -- one select or editor per step, form tabs as a field
menu. Result cards are a terminal feature, so a finished command run hands
its text to the agent for one verbatim chat answer, and progress widgets
are invisible in clients that do not render them. Some clients report an
empty editor save as cancelled, so the dialog chain never treats an editor
cancel as a run abort; cancelling is the Cancel row of a select step.

## Conventions

- No language model in the citation path -- ever. A model may shape a
  query or write prose over numbered excerpts; fixed code inserts and
  validates every citation.
- Gates, validation and state live in code, not in instructions to the
  agent; every stage also has an agent-free slash command.
- Third-party behaviour (Pi's TUI, pdf.js, the source APIs) is proven
  against the code or service that actually runs, never assumed.
- Plain, emoji-free output everywhere.

## Module map

Where each stage lives; the adapter/engine pair shares its basename.

<details>
<summary>Search</summary>

| File | Holds |
|---|---|
| `extensions/search.ts` | the `pi-literature-search` tool + `/lit-search` command: intake wizard (tabs, variant suggestions via the Pi model, journal/author loaders), digest card |
| `src/search.ts` | run orchestration: per source and query fetch, pipeline steps in order, payload assembly, source failures |
| `src/sources/arxiv.ts`, `crossref.ts`, `openalex.ts`, `semanticscholar.ts` | one client per source: query building (booleans, author scope), record normalization; OpenAlex also holds the facet queries and the abstract reconstruction |
| `src/sources/polite.ts` | the shared politeness: per-source request spacing, timeout, retry on rate-limit answers (used by every client) |
| `src/sources/github.ts` | GitHub: the one search pacer both code directions share, aggregator-name filter, repository search, raw README fetch |
| `src/sources/huggingface.ts` | Hugging Face Papers search (arXiv id + linked repository per hit; undocumented site API, shape pinned) |
| `src/sources/ecosystems.ts` | repos.ecosyste.ms (repository created date for the pair gate) and awesome.ecosyste.ms (lists by topic, structured list entries; slug URLs only) |
| `src/codesearch.ts` | the code-first searchers (hf-papers, github-readme, awesome-lists, gee-github): repositories first, identifiers out of READMEs, resolution at arXiv / OpenAlex, the date gate; injectable clients for offline tests |
| `src/pipeline.ts` | junk filter, deduplication, term matching, block labeling with evidence, the metadata filters, abstract gate |
| `src/verify.ts` | the trust gate: DOI / arXiv ID resolution over HTTP |
| `src/enrich.ts` | OpenAlex identifier lookup (cites, venue, abstract), journal 2-year citedness, author metrics, code links (abstract URL on any known host, else a GitHub search per arXiv id or DOI with date/owner guards; records already linked by a code-first source are left alone) |
| `src/intake.ts` | query parsing: block expressions, derived blocks, stopwords, prose detection, variant-line parsing and ordering, year ranges |
| `src/render.ts` | the results page: tables, sorting, BibTeX, download steps, search documentation block, footnotes |
| `src/network.ts` | the static citation-graph page (`network.html`) with its embedded fetch + layout script |
| `src/digest.ts` | the agent-facing digest and the transcript card text |
| `src/output.ts` | output folders and collision-safe file names |

</details>

<details>
<summary>Selection</summary>

| File | Holds |
|---|---|
| `extensions/selection.ts` | the `pi-literature-selection` tool + `/lit-selection` command: identifier dialog, Unpaywall-email dialog, consent dialog, per-paper report widget |
| `src/selection.ts` | identifier parsing, resolver chain (record link -> Unpaywall -> arXiv), `%PDF` check, library naming, the report |

</details>

<details>
<summary>Synthesis</summary>

| File | Holds |
|---|---|
| `extensions/synthesis.ts` | the `pi-literature-synthesis` tool + `/lit-synthesis` command: the wizard, answer/report cards, paper-chat mode, HTML-write gate, embedding-model doctor dialog |
| `extensions/pi-model.ts` | one completion call on the model selected in Pi (used for the search wizard's variant suggestions) |
| `src/synthesis.ts` | the engine: chat rounds, composable reports, prompts, the citation gate (marker validation, reference insertion), report assembly |
| `src/retrieve.ts` | shared retrieval: query variants, lexical layer, embedding ranking, union |
| `src/extract.ts` | PDF text extraction, cleanup, bibliography cut, chunking, highlight-phrase measurement |
| `src/pdfjs-find.ts` | faithful port of the PDF viewer's find normalization (guarantees highlights) |
| `src/corpus.ts` | which PDFs form the corpus, library matching against saved searches, the embedding-index cache |
| `src/adopt.ts` | adoption of loose PDFs: identifier from the PDF text, verified by lookup |
| `src/protocol.ts` | protocol files of validated rounds, sticky scope per session |
| `src/doctor.ts` | embedding-model probe and Ollama fetch (zero-config path) |
| `src/llm.ts` | the HTTP client for the embedding/generation backends (Ollama and OpenAI dialects, per-role split, role-clear errors) |
| `src/pisession.ts` | current Pi session id for the CLI |

</details>

<details>
<summary>Shared</summary>

| File | Holds |
|---|---|
| `src/dialog-state.ts` + `extensions/dialogs.ts` | the tabbed wizard: pure reducer (steps, checkbox lists, forms, review page) and its Pi adapter (overlay drawing, keys, paste, RPC fallback) |
| `src/config.ts` | the config file and environment overrides |
| `src/cli.ts` | the standalone command line over all three engines |
| `src/types.ts` | shared record shapes and small helpers (user agent, contact email, warnings) |
| `src/cardtext.ts` | bold/bullet formatting for transcript cards |
| `index.ts` | registers the three tools |

</details>
