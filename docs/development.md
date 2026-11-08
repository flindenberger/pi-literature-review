# Development and tests

## Layout

| Path | Holds |
|---|---|
| `index.ts` | Pi extension entry: registers the three tools in pipeline order, then the `/pi-literature-review` command |
| `extensions/` | Pi adapters: `search.ts`, `selection.ts`, `synthesis.ts` (one tool + command each), `web.ts` (browser command), `dialogs.ts` (wizard overlay + RPC fallback), `pi-model.ts` (calls on the Pi model) |
| `bin/pi-literature-review.mjs` | the installed command (`npx pi-literature-review`) |
| `src/` | the engines, Pi-free: search pipeline, render, network graph, selection, synthesis, wizard reducer, config, CLI |
| `src/sources/` | source clients (arXiv, CrossRef, OpenAlex, Semantic Scholar), link and person lookups (DataCite, ORCID), code-side clients (GitHub, Hugging Face, ecosyste.ms), `polite.ts` |
| `src/web/` | the browser interface: server, chat dialog, jobs, history, background indexer, `static/` (the page) |
| `src/web/demo/`, `src/web/demo-build.ts` | the live demo (GitHub Pages); not shipped in the npm package |
| `src/fixtures/` | test fixtures (not shipped) |
| `docs/` | this documentation; images under `docs/img/` |
| `.github/workflows/` | CI: `test.yml`, `pages.yml` |
| `tsconfig.json` | type-check settings (strict, NodeNext, `.ts` imports, no emit) |

- Adapters (`extensions/`) hold everything that touches Pi: tool schemas, dialogs, widgets, message rendering.
- Engines (`src/`) run without Pi; the CLI and the browser server drive them directly.
- Tests sit next to their modules (`src/`, `src/sources/`, `src/web/`) and use only Node's built-in `assert`.
- Node.js 22.19 or newer (`engines` in `package.json`). Node runs the `.ts` files directly.

## Running from a checkout

```
npm install            # add --no-bin-links on filesystems without symlinks (exFAT)
pi install /absolute/path/to/pi-literature-review
```

- Peer dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `typebox`. Pi's extension loader provides them at runtime.
- They are optional peers, so a user install pulls only this package's own dependencies.
- They are also devDependencies, so `npm install` in a checkout brings them in for the editor, the type check and the index load check.
- Restart Pi after code changes. `/reload` is not guaranteed for package extensions.

Without Pi:

```
node src/cli.ts web [--port N] [--no-open] [--root DIR]
```

Other CLI modes: [CLI](cli.md).

## Installed command

- `bin/pi-literature-review.mjs` is plain JavaScript.
- Node refuses to strip TypeScript types under `node_modules`. The script registers a load hook (`registerHooks`) that strips types from this package's own `.ts` files with `stripTypeScriptTypes`, then imports `src/cli.ts`.
- The one-time experimental warning of `stripTypeScriptTypes` is muted.

## Type check and tests

```
node node_modules/typescript/bin/tsc -p tsconfig.json
for f in src/*.test.ts src/sources/*.test.ts src/web/*.test.ts; do node "$f" >/dev/null || echo "FAIL $f"; done
node -e "import('./index.ts').then(() => console.log('index loads'))"
```

- Type check: strict TypeScript over `index.ts`, `src/` and `extensions/`, tests included; no output files.
- Tests: standalone and offline; network clients run against captured fixtures and a stubbed `fetch`.
- Last line: the extension entry loads with the peers present.
- `static/pdfjs-find.mjs` is generated from `src/pdfjs-find.ts`. `src/web.test.ts` fails when the copy is stale; regenerate with `node src/web/static-gen.ts`.

## Release acceptance gate

```
node src/cli.ts "sandbar detection rivers Sentinel-1 Sentinel-2" -n 5 -s arxiv,crossref,openalex
```

Pass criteria:

- DOIs `10.3390/rs13081505` and `10.3390/rs18010132` appear with `verified: true`
- Known junk records (empty titles, off-topic keyword matches) are dropped with reasons
- A fabricated DOI comes out `verified: false`

## Continuous integration

### `test.yml`

| Item | Value |
|---|---|
| Trigger | every push and pull request |
| Permissions | `contents: read` |
| Node | 24 |
| Steps | `npm ci`, type check, all tests in `src/`, `src/sources/`, `src/web/`, extension entry load |

### `pages.yml` (live demo)

| Item | Value |
|---|---|
| Trigger | push to `main`, manual run |
| Permissions | build job `contents: read`; deploy job `pages: write`, `id-token: write` |
| Node | 24 |
| Build | `npm ci`, `node src/web/demo-hosts.test.ts`, `node src/web/demo-replay.test.ts`, example PDF cache, `node src/web/demo-build.ts _site --pdf-cache .demo-pdf-cache`, upload of `_site` |
| Deploy | `actions/deploy-pages` |

- The build output is never committed.
- Example PDF cache: `actions/cache`, key from the hash of `src/web/demo/example/*.json`. The build fetches the PDF from the recorded publisher address and stops on a SHA-256 mismatch.
- GitHub setting needed once: Pages → Source "GitHub Actions".

## Live demo

The unchanged browser interface with its server running in the visitor's browser. No bundler.

| Part | Role |
|---|---|
| `src/web/demo-build.ts` | `node src/web/demo-build.ts <out-dir> [--pdf-cache <dir>]`: copies every module reachable from `demo/worker.ts` with types stripped, `.ts` imports rewritten to `.js`, Node modules mapped to shims |
| `src/web/demo/worker.ts` | starts `server.ts` in a Web Worker; plays back the recorded paper chat; no model |
| `src/web/demo/capture.ts` | turns one real paper chat (conversation + report JSON) into `example/<name>.json`; machine paths replaced by `{PDF}` |
| `src/web/demo/example/blanch-2026.json` | the recorded example (Blanch et al. 2026, CC BY 4.0), with PDF address and SHA-256 |
| `src/web/demo/runtime/boot.js` | page start: registers the Service Worker, starts the server in a SharedWorker (dedicated Worker as fallback), loads `static/app.js` |
| `src/web/demo/runtime/worker-boot.js` | worker entry: Node globals, persisted files, server start |
| `src/web/demo/runtime/sw.js` | Service Worker: hands `api/`, `files/`, `pdf/` requests to the worker |
| `src/web/demo/runtime/shims/` | stand-ins for `node:fs` (in memory, mirrored to IndexedDB), `node:http`, `node:path`, `node:crypto`, buffer, globals, small modules |
| `src/web/demo-hosts.test.ts` | privacy guard: every URL host in the shipped demo code must be on a fixed list; no external script, stylesheet or font |
| `src/web/demo-replay.test.ts` | playback over the committed example; no machine path or contact address in it |

Build output:

| Path | Content |
|---|---|
| `index.html` | the interface page, started by `v/<hash>/runtime/boot.js` |
| `sw.js` | the Service Worker (at the root, so its scope is the whole demo) |
| `static/` | the interface files and `pdfjs.mjs` |
| `v/<hash>/runtime/`, `v/<hash>/app/src/` | runtime and converted modules |
| `examples/` | the example JSON and its PDF |

- `<hash>` is a content hash of the code. Interface files carry `?v=<hash>`, so a new build never mixes with a cached old one.
- `package.json` `files` excludes `src/web/demo/`, `src/web/demo-build.ts`, `src/**/*.test.ts` and `src/fixtures/`.

## Dependencies

A user install pulls nine small packages and runs no install scripts:

| Package | Role |
|---|---|
| `fast-xml-parser` | parses arXiv Atom responses |
| `unpdf` | PDF text extraction (pdf.js bundled, no further dependencies); also serves pdf.js to the browser PDF viewer |
| `fast-xml-builder`, `strnum`, `anynum`, `is-unsafe`, `xml-naming`, `path-expression-matcher`, `@nodable/entities` | internal helpers of `fast-xml-parser` |

- `unpdf` is loaded only through `loadUnpdf()` in `src/pdfjs-find.ts`. It first installs a `Math.sumPrecise` polyfill on Node versions without it; pdf.js needs it while parsing fonts, else ligatures such as "fi" vanish from the extracted text.

## Browser server routes

All in `src/web/server.ts`.

Access:

- Host header must be `127.0.0.1`, `localhost` or `[::1]` with the server's port.
- `?token=` sets the `plr_token` cookie (HttpOnly, SameSite=Strict) and redirects to the clean address. Afterwards the cookie or a `Bearer` header counts.
- A `GET` without the key that accepts `text/html` gets an HTML page explaining how to open the full address. Other requests get a JSON 401.

Pages and files:

| Method | Path | Purpose |
|---|---|---|
| GET | `/`, `/index.html` | the interface page |
| GET | `/static/pdfjs.mjs` | pdf.js from `unpdf` |
| GET | `/static/*` | interface files |
| GET | `/files/<stage>/<name>` | output files; synthesis pages re-rendered with `/pdf/` links; search reports without tick column and paste steps; `network.html` rendered from code |
| GET | `/pdf/<name>` | a library PDF |

API:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | server, model and source state |
| GET | `/api/address` | full address with token (for another browser) |
| GET | `/api/events` | SSE stream: `snapshot`, `line`, `job`, `dialog`, `history`, `index` |
| GET | `/api/jobs` | job snapshot |
| POST | `/api/jobs/<id>/cancel`, `/api/jobs/cancel` | stop one job / the running jobs |
| GET | `/api/runs` | search runs, reports, chat sessions |
| GET | `/api/runs/cards` | result cards of one run |
| GET | `/api/runs/facts` | provenance behind a flow diagram |
| POST | `/api/runs/report` | search report or PRISMA diagram from the filtered list |
| GET | `/api/author` | author window (OpenAlex via the card's work, ORCID) |
| GET | `/api/paper` | paper info window (library record + OpenAlex) |
| GET | `/api/library` | library papers, folders, indexing state |
| POST | `/api/search/variants` | model query variants |
| POST | `/api/search/blocks` | keyword blocks of a request (own words or `mode: "synonyms"`, `fresh`) |
| POST | `/api/search/journals` | journal facets |
| POST | `/api/search/authors` | author facets |
| POST | `/api/search/author-lookup` | author name autocomplete |
| POST | `/api/search/code-topics` | awesome-list topics |
| POST | `/api/search/run` | start a search job |
| GET | `/api/selection/candidates` | download candidates of a run |
| POST | `/api/selection/run` | start a download job |
| POST | `/api/index` | index the library |
| POST | `/api/report` | start a synthesis report job |
| GET | `/api/chat/sessions` | chat sessions with PDF links |
| POST | `/api/chat/session` | switch or start a chat session |
| POST | `/api/chat` | one chat round |
| POST | `/api/chat/report` | one-paper session report |
| POST | `/api/chat/examples` | model-worded example questions |
| GET | `/api/dialog` | dialog view |
| POST | `/api/dialog/answer`, `/api/dialog/restart`, `/api/dialog/new` | drive the dialog state machine |
| GET | `/api/history` | conversation list |
| POST | `/api/history/open`, `/api/history/delete`, `/api/history/clear` | open, delete, clear conversations |
| POST | `/api/blocks/clear` | forget saved keyword blocks |
| POST | `/api/indexes/clear` | delete all indexes |
| POST | `/api/reveal` | show a known folder in the file manager |
| POST | `/api/library/upload` | dropped PDFs into `inbox/` |
| POST | `/api/library/pick-files`, `/api/library/import` | upload button: system file window, copy of chosen files |
| GET | `/api/folders` | PDF folders |
| POST | `/api/folders/pick`, `/api/folders/add`, `/api/folders/remove` | folder window, add, remove |
| GET | `/api/settings` | settings view |
| POST | `/api/settings` | save settings |
| POST | `/api/settings/key` | save or remove one API key (write-only) |
| POST | `/api/settings/pull-embed` | fetch the embedding model |
| GET | `/api/models` | models offered by a server address |
| POST | `/api/stop` | stop the server |

- Every engine call is injectable (`WebDeps`) for offline tests.
- Server options: `backgroundIndex` (CLI and Pi command), `basePath`, `demo`, `chatReplay` (live demo).

## Web / RPC clients

- Pi web frontends drive Pi in RPC mode. There every wizard runs as a chain of modal dialogs: one select or editor per step, form tabs as a field menu.
- Result cards are a terminal feature. A finished command run hands its text to the agent for one verbatim chat answer.
- Progress widgets are invisible in clients that do not render them.
- Some clients report an empty editor save as cancelled. The dialog chain never treats an editor cancel as a run abort; cancelling is the Cancel row of a select step.

## Conventions

- No language model in the citation path. A model may shape a query or write prose over numbered excerpts; fixed code inserts and validates every citation.
- Gates, validation and state live in code, not in instructions to the agent. Every stage has an agent-free slash command.
- Third-party behaviour (Pi's TUI, pdf.js, the source APIs) is proven against the code or service that actually runs.
- Plain, emoji-free output.

## Module map

Adapter and engine of a stage share their basename.

<details>
<summary>Search</summary>

| File | Holds |
|---|---|
| `extensions/search.ts` | `pi-literature-search` tool + `/lit-search`: intake wizard (tabs, variant suggestions via the Pi model, journal/author loaders), digest card, download question |
| `src/search.ts` | run orchestration: per source and query fetch, pipeline steps, payload, source failures |
| `src/sources/arxiv.ts`, `crossref.ts`, `openalex.ts`, `semanticscholar.ts` | one client per source: query building (booleans, author scope), record normalization. OpenAlex also: facets, abstract reconstruction, access classification (`accessFromWork`, `lookupAccessByDoi`), author window lookups (`lookupWorkAuthors`, `lookupAuthorFacts`). CrossRef also: data links (`lookupDataLinksByDoi`, `DATA_ARCHIVES`) |
| `src/sources/datacite.ts` | DataCite related identifiers (`lookupDataciteLinks`, `dataLinksFromRelated`); combined CrossRef + DataCite lookup (`lookupAllDataLinks`) |
| `src/sources/orcid.ts` | current employments from the public ORCID record (`lookupOrcidEmployments`, `currentEmployments`) |
| `src/sources/polite.ts` | shared request spacing, timeout, retry on rate-limit answers |
| `src/sources/github.ts` | GitHub: code-source pacer, aggregator-name filter, repository search, raw README fetch |
| `src/sources/huggingface.ts` | Hugging Face Papers search (arXiv id + linked repository; undocumented API, shape pinned) |
| `src/sources/ecosystems.ts` | repos.ecosyste.ms (repository created date) and awesome.ecosyste.ms (lists by topic) |
| `src/codesearch.ts` | code-first searchers (hf-papers, github-readme, awesome-lists, gee-github): repositories first, identifiers from READMEs, resolution at arXiv / OpenAlex, date gate |
| `src/pipeline.ts` | junk filter, deduplication, term matching, block labels with evidence, metadata filters, abstract gate |
| `src/verify.ts` | trust gate: DOI / arXiv ID resolution over HTTP |
| `src/enrich.ts` | OpenAlex lookup (cites, venue, abstract), journal citedness, author metrics, code links from abstracts, data links, access status (batched) |
| `src/intake.ts` | query parsing: block expressions, derived blocks, stopwords, prose detection, variant prompts and parsing, synonym caps, year ranges |
| `src/render.ts` | results page: tables, sorting, BibTeX, access markers, download steps, search documentation, PRISMA diagram, footnotes |
| `src/network.ts` | the citation-graph page (`network.html`) |
| `src/digest.ts` | agent-facing digest and transcript card text |
| `src/output.ts` | output folders and collision-safe file names |

</details>

<details>
<summary>Selection</summary>

| File | Holds |
|---|---|
| `extensions/selection.ts` | `pi-literature-selection` tool + `/lit-selection`: identifier, email, folder and consent dialogs, report widget (`gatedSelection`, `showSelectionReport` also serve `/lit-search`) |
| `src/pick.ts` | paper pick after a search (terminal and browser): candidates from a payload, the typed answer (report line, row numbers, identifiers, `all`, `code`) |
| `src/selection.ts` | identifier parsing, access gate, resolver chain (record link → OpenAlex locations → Unpaywall → `citation_pdf_url` behind robots.txt → arXiv), `%PDF` check, file naming, report |

</details>

<details>
<summary>Synthesis</summary>

| File | Holds |
|---|---|
| `extensions/synthesis.ts` | `pi-literature-synthesis` tool + `/lit-synthesis`: wizard, answer/report cards, paper chat, HTML-write gate, embedding-model dialog |
| `extensions/pi-model.ts` | the Pi model through Pi's model registry: completion calls, the synthesis backend's generate half, the browser's session provider (own model choice, never `setModel`) |
| `src/synthesis.ts` | engine: chat rounds, reports, prompts, citation gate (marker validation, reference insertion), report assembly |
| `src/retrieve.ts` | retrieval: query variants, lexical layer, embedding ranking, union, per-paper minimum |
| `src/extract.ts` | PDF text extraction, cleanup, bibliography cut, chunking, highlight-phrase check |
| `src/pdfjs-find.ts` | port of the PDF viewer's find normalization (guarantees highlights) |
| `src/corpus.ts` | corpus PDFs (`libraryFiles`), library matching, embedding-index cache |
| `src/library.ts` | recursive capped walk of PDF folders, `inbox/`, `meta/` twins by path hash |
| `src/folderpick.ts` | system folder and file windows (zenity/kdialog, osascript, PowerShell), no shell |
| `src/adopt.ts` | adoption of loose PDFs: identifier from the PDF text, verified by lookup |
| `src/protocol.ts` | protocol files of validated rounds, sticky scope per session |
| `src/doctor.ts` | embedding-model probe and Ollama fetch |
| `src/llm.ts` | HTTP client for model backends (Ollama and OpenAI dialects, roles, thinking, model lists) |
| `src/pisession.ts` | current Pi session id for the CLI |

</details>

<details>
<summary>Web interface</summary>

| File | Holds |
|---|---|
| `extensions/web.ts` | `/pi-literature-review` command (`stop`, `--port`, `--no-open`), browser launch, close on `session_shutdown` |
| `src/web/server.ts` | node:http server: access checks, static page, `/files` and `/pdf`, all API routes, SSE, dialog effects |
| `src/web/dialog.ts` | chat dialog as a pure state machine: fixed question order and wording, chips, free-text parsers, `reduce(state, event, ctx)` returning state and effects |
| `src/web/help.ts` | question channel: fixed help text per step, navigation intents and chips, small-talk check |
| `src/web/examples.ts` | model-worded example questions for the paper chat, checked by fixed rules |
| `src/web/keywords.ts` | author keywords from a paper's first pages, for the example questions |
| `src/web/results.ts` | result cards of a run and the list filters applied for a report; no model |
| `src/web/indexer.ts` | background indexing of the library, one PDF at a time, paused while a chat or report runs |
| `src/web/jobs.ts` | concurrent jobs (`MAX_RUNNING` 3; selection, index, pull, check run alone), abort, progress buffer |
| `src/web/history.ts` | conversation history: one JSON snapshot per conversation next to the config (`PI_LITERATURE_REVIEW_HISTORY`) |
| `src/web/blockcache.ts` | saved keyword blocks per request text and mode (`PI_LITERATURE_REVIEW_BLOCK_CACHE`) |
| `src/web/sse.ts` | Server-Sent Events framing and keepalive |
| `src/web/files.ts` | listings of runs, library, index state, reports, chat sessions; safe file names |
| `src/web/intake.ts` | posted search form as `SearchOptions` + filters |
| `src/web/open.ts` | open the browser or a folder without a shell |
| `src/web/static-gen.ts` | writes `static/pdfjs-find.mjs` from `src/pdfjs-find.ts` |
| `src/web/static/` | `index.html`, `app.js`, `style.css`; `pdfview.html` + `pdfview.js` (PDF viewer with passage highlight); `prisma.html` (diagram viewer); `pdfjs-find.mjs` (generated) |
| `src/provider.ts` | model provider interface and the endpoint provider for standalone use |

</details>

<details>
<summary>Shared</summary>

| File | Holds |
|---|---|
| `src/dialog-state.ts` + `extensions/dialogs.ts` | tabbed wizard: pure reducer and its Pi adapter (overlay, keys, paste, RPC fallback) |
| `src/config.ts` | config file and environment overrides, PDF folders, keys, model roles |
| `src/cli.ts` | standalone command line over all engines and the browser server |
| `bin/pi-literature-review.mjs` | installed command, see [Installed command](#installed-command) |
| `src/types.ts` | shared record shapes and helpers (user agent, contact email, warnings) |
| `src/cardtext.ts` | transcript cards: formatting, file links as OSC 8 terminal links where supported |
| `index.ts` | registers the three tools and the browser command |

</details>
