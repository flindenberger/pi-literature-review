# pi-literature-review

Local, open, login-free literature review tooling for the
[Pi coding agent](https://pi.dev). One package, one shared data folder, one tool
per pipeline stage:

- **`pi-literature-search`** (this release) -- deterministic literature discovery:
  searches arXiv, CrossRef and OpenAlex, then filters, deduplicates, HTTP-verifies,
  enriches and groups the results into clean JSON, and renders them as a sortable,
  self-contained HTML table.
- **`pi-literature-fetch`** -- deterministic PDF retrieval for selected records
  into the shared `papers/` library: resolver chain record link -> Unpaywall ->
  arXiv, legal open access only, %PDF check before anything is saved, honest
  per-paper report (see Fetching PDFs).
- **`pi-literature-synthesize`** (planned) -- synthesis over the retrieved papers;
  citations will be inserted by fixed code from the verified records, never typed
  by a model.

Transparency: the package talks only to the public arXiv, CrossRef and OpenAlex
APIs, doi.org/arxiv.org for verification and api.unpaywall.org for open-access
lookups, and writes its output files under
`<working directory>/pi-literature-review/` (see Output). No accounts, no
scraping, no telemetry; the only personal datum is an optional contact email for
Unpaywall that you enter (and may store) yourself.

## The one inviolable rule

**No LLM is ever in the citation path.** Titles, authors, years, venues, DOIs and
arXiv IDs come only from the search-API responses -- never generated, guessed,
"tidied" or completed by a language model. The agent may shape the search query and
propose grouping word lists; it never produces or modifies a citation. Every DOI is
verified by an HTTP request to doi.org (a real DOI answers with a redirect to the
publisher), every arXiv ID against arxiv.org. Anything that does not resolve is
marked `verified: false` with a plain-language reason -- never silently confirmed.

## Install

```
pi install git:github.com/<owner>/pi-literature-review    # once published
pi install /absolute/path/to/pi-literature-review         # local checkout
```

No prerequisites beyond Pi itself. Pi runs `npm install` for published packages;
for a local checkout run it yourself in this directory. (Development note: on
filesystems without symlink support, e.g. exFAT, use `npm install --no-bin-links`.)

## Use

Ask the agent naturally, for example: "Find papers on drone remote sensing of
floodplains, 10 per source, group by floodplain vs. drone terms."

**Every** tool call opens an intake dialog in your terminal before anything is
searched -- enforced by code, not by an instruction the model could skip (field
tests showed models reliably skip "ask the user first" instructions). The
dialog summarizes the proposed parameters: query (and variants), the grouping
rules as an explicit logic expression (groups are AND-linked, terms within a
group OR-linked -- e.g. `(river OR fluvial) AND (sandbar OR bar)`; grouping
only labels results as on_target/adjacent, it does not narrow the search), the
publication year range, and the search depth. Choose "Run as proposed" to
start, or "Adjust parameters" to edit them in prefilled prompts: the grouping
is edited directly in the displayed expression form (e.g. change
`(river OR fluvial) AND (sandbar OR bar)` in place; the compact `a,b; c,d`
syntax also works, `none` = ungrouped), the year range accepts `2015-2024`,
`2015-` or `all`, and the depth offers keep/quick/thorough/exhaustive plus a
custom results-per-source count of your own (capped at 50 out of politeness
towards the free APIs). Escape or Ctrl+C in ANY dialog cancels the whole run
-- no search fires -- and the agent is told to ask you what to change; to
leave a field unchanged, submit it as-is (or leave the input empty). Headless runs (no interactive UI) skip the dialog. The agent
calls the `pi-literature-search` tool with:

- `query` -- the search string (required)
- `query_variants` -- alternative phrasings of the same question (synonyms,
  domain jargon, broader/narrower wording), searched in the same run. Results
  are deduplicated across all variants by fixed code; each record notes which
  variants found it (`found_by`), and the HTML table labels them Q1, Q2, ...
  Use this for exhaustive sweeps instead of separate calls.
- `per_source` -- results per source (default 5, capped at 50 out of politeness
  towards the free APIs)
- `sources` -- subset of `arxiv`, `crossref`, `openalex` (default: all)
- `group_terms` -- deterministic grouping rules: an array of term groups. A record
  is `on_target` when at least one term from every group appears in its
  title+abstract (case-insensitive); everything else is `adjacent`. Example:
  `[["river","fluvial"],["sandbar","bar"],["sentinel","s-1","s-2"]]`. Omit for
  ungrouped results. The matching is fixed code; only the word lists vary.
- `min_cites` -- keep only records with at least this many citations. Records
  with an unknown count (arXiv preprints; `cites: null`) still pass. Beware:
  citation thresholds penalize very recent papers.
- `year_from` / `year_to` -- publication year range. Records that cannot prove
  they are in range (unknown year) are excluded, with a reason.
- `venues` -- keep only records whose journal name contains one of these strings
  (case-insensitive). Venue-less preprints are excluded, with a reason.
- `require_pdf` / `verified_only` -- keep only records with a direct PDF link /
  a resolving identifier.
- `sort` -- `cites` (citation count, a rough impact proxy) or `year` (newest
  first); unknown values sort last. Note: an official journal impact factor is
  proprietary and not available from open APIs; this tool does not pretend to
  have it.
- `enrich` -- fill missing citation counts / journal names via a deterministic
  OpenAlex identifier lookup (open API, no scraping; arXiv, for example, carries
  neither). Only empty fields are filled, never overwritten; every filled field
  is listed per record under `enriched` and marked with `*` in the HTML table.
  The same switch attaches each journal's OpenAlex 2-year mean citedness as
  `journal_2yr_citedness` (shown as the "Journal score" column) -- the open
  analog of the proprietary impact factor; it rates the journal, not the paper,
  and is fetched in batches (a handful of extra API calls per run). Default: true.
- `html_file` -- override for the HTML output path (see below).

All filters act on metadata the source APIs delivered -- pure deterministic
checks. Whatever a filter removes appears in `dropped` with the exact reason.

## Output

Every run writes a deterministic, self-contained HTML rendering of the result
(sortable table, expandable abstracts, dropped records with reasons) plus the
full JSON payload as a sidecar with the same basename to

```
<working directory>/pi-literature-review/queries/<YYYY-MM-DD>_<query>.html
<working directory>/pi-literature-review/queries/<YYYY-MM-DD>_<query>.json
```

Table columns sort on click, Excel-style: the first clicked column is the
primary key, each further click refines the order within it (click Label, then
Citations: on_target stays on top, most cited first inside each label); a
second click on the same column flips its direction, and headers show arrows
plus the key priority. Reload the page to reset.

A same-day rerun of the same query gets `_2`, `_3`, ... appended instead of
overwriting (the pair always shares one suffix). The root folder is overridable
via `PI_LITERATURE_REVIEW_HOME`, the exact HTML path via `html_file`. The page is
generated from the JSON payload by fixed code -- never by a model -- and states
so in its footer.

The result table has a checkbox per row and a selection bar that floats at the
bottom of the window while you scroll: tick papers (or "Select all on_target"),
click "Copy download request", and paste the copied sentence
(`Download these papers: <id>, <id>, ...`) into the Pi chat -- that sentence is
the handover to the fetch tool. The page itself never downloads anything: a
local file:// page can neither write files nor call other servers; it only
assembles identifiers that are already printed on it.

## Fetching PDFs (pi-literature-fetch)

Two equivalent ways in: paste the copied sentence, or just ask in plain words
("download the three on_target papers"). The model only transports DOIs/arXiv
IDs to the tool; before ANY network request the tool shows a terminal dialog
listing every identifier with its title from the saved searches (titles never
come from the model) -- confirm or cancel there. Escape cancels the whole run.

Resolution per identifier is a fixed chain, first source with real PDF bytes
wins: the record's own `pdf_url` -> Unpaywall (legal open-access index by the
non-profit OurResearch) -> the arXiv PDF endpoint. Every download is checked
for the `%PDF` magic bytes; an HTML error page is never saved as a PDF. No
gray sources, ever. The per-paper report is honest: `downloaded` / `already in
library` / `blocked by publisher` (some publishers, e.g. MDPI, refuse ALL
automated clients with HTTP 403 -- the report then gives the direct link to
open in your browser, which works fine) / `not freely available -- obtain via
authorized access` (with the publisher link) / `invalid identifier`.

Library naming: `papers/<year>_<FirstAuthor>[_et_al]_<Title_words>.pdf`
(capped at 80 characters, umlauts transliterated), built only from saved
API records; if year, author or title is unknown the identifier slug
(`10.3390_rs13081505`) is used instead. A paper already in the library is
never downloaded twice.

Unpaywall requires a contact email (their usage policy; sent only to
api.unpaywall.org). While none is configured, the fetch dialog explains this
and offers three choices: enter it for this run only, enter and save it to the
local config file (`~/.config/pi-literature-review/config.json` on Linux/macOS,
`%APPDATA%\pi-literature-review\config.json` on Windows; file mode 0600), or
continue without Unpaywall (asked again next time). The
`PI_LITERATURE_REVIEW_MAILTO` environment variable overrides everything --
use it for headless and container runs. Without an email, downloads still work
via record links and arXiv.

The agent model itself does NOT receive the full data. The tool result is a
short plain-text digest: counts (records, verified, on_target/adjacent,
dropped), the HTML path, and one reference line per record
(`[group] year | DOI-or-arXiv-ID | title`). A live field test with a small
local model showed that full citation JSON in the model's context gets re-typed
and "completed" -- fabricated tables, invented page numbers, reformatted author
names. Starving the model of everything except copyable reference lines closes
that path structurally; the HTML file is where results are actually reviewed,
and follow-up tooling reads the JSON sidecar. The sidecar's path is not part of
the digest (it concerns tooling, not the user) -- the tool description tells
the agent it sits next to the HTML with the same basename.

The JSON payload is
`{query, generated, sources_used, grouping, filters, sort, results, dropped}`.
Each result carries `verified`, `verify_note`, `sources`, and (when grouping is on)
`group`. Records dropped by the filter (no title or no authors -- uncitable) are
not discarded silently: they ship in `dropped` with the full record and the reason,
so every exclusion can be audited.

Standalone CLI (same pipeline, for testing; prints the full JSON to stdout):

```
node src/cli.ts "sandbar detection rivers Sentinel-1 Sentinel-2" \
  -n 5 -s arxiv,crossref,openalex -g "river,fluvial;sandbar,bar;sentinel,s-1,s-2" \
  --variant "alternate bars rivers Sentinel-2" --html [FILE] --no-enrich --digest
```

`--html` without FILE uses the deterministic default location and also writes
the JSON sidecar; `--digest` prints the agent-facing digest instead of the JSON.
All flags are optional. The downloader runs standalone too (no Pi, no LLM):

```
node src/cli.ts fetch 10.3390/rs13081505 arXiv:2401.16393
```

## Chat, reports and synthesis (pi-literature-synthesize, /lit-synth)

ONE fused stage answers from the LOCAL PDF library with LOCAL generator
models (Ollama or any OpenAI-compatible local server; nothing leaves the
machine). Trust architecture: the generator sees only numbered text
excerpts extracted mechanically from the PDFs and may cite ONLY by excerpt
number; fixed code validates every marker, strips fabricated ones
(reported, not hidden), and inserts references from the HTTP-verified
search records. A result without a single valid citation is flagged
`grounded: false` and rendered with an unmissable warning. PDFs are
indexed once (extraction, chunking, embeddings under `index/`, invalidated
by content hash and embedding model); scanned PDFs are excluded and named.
Loose PDFs are adopted automatically when their own DOI/arXiv ID can be
extracted from the PDF text and verified by an API lookup; whatever stays
unverified is still usable -- cited honestly by filename and page.

**Dialog language.** All code dialogs (question gate, wizard, warnings)
follow the CHAT's language, read from the SESSION itself: the tool walks
the current branch's user messages newest-first and takes the first
DECISIVE German/English detection (umlauts are strong evidence, stopword
scoring otherwise; neutral lines like "ok" are skipped); question texts
are the fallback, German the final default. The agent's `language`
parameter drives only the PROSE, never the dialogs (agents guess it).
Other languages get the international default English. The report page
chrome (`ui_language`) follows the same resolution.

**Scope.** Everything runs over a document SCOPE: one paper, a selection,
or the whole library. The scope is picked in a Claude-Code-style wizard
(checkbox list with a select-all row; selecting everything means the
library) and is sticky WITHIN one pi session (`chats/current-scope.json`,
stamped with the session id) -- follow-up calls need only the question.
A new pi session starts blank; `/resume` keeps the scope.

**Chat mode.** One grounded answer per question, didactic tone, page-exact
references (`[1] 2026 | 10.5194/... | Title (S. 4)`). Every chat call
arriving through the AGENT passes a code-enforced QUESTION GATE first: a
one-line dialog shows the question the agent wants to run (prefilled,
editable, scope in the title; Enter starts, Esc cancels) -- field tests
showed agents systematically rephrase the user's words, which measurably
degrades retrieval, and no instruction stopped it. The confirmed wording
is what the engine runs. When no scope is settled yet, the document
checkboxes join the SAME dialog. The validated answer
travels verbatim in the tool result between explicit delimiters AND renders
as a full transcript card (anti-paraphrase ground truth; capped-widget
fallback without pi-tui). Every validated round is appended to a protocol
file under `chats/` (multi-paper and library rounds under a scope
identity); corrupt or foreign files are quarantined, never overwritten.
No chat memory in the generator: each call is stateless; the pi
conversation carries the thread.

**Report mode** (`report: true`, or the wizard) builds the composable
report from three building blocks, written to `reports/`. With a UI the
report intake ALWAYS runs in the wizard: agent-passed parameters and the
questions already asked in this session's chat merely prefill it ("fasse
das zusammen" opens the wizard with the chat's questions, editable), and
enum-like parameters (`summary`, `detail_mode`) are free strings
normalized in code -- a malformed agent value can no longer dead-end in
schema validation. The finished
report also renders as a full transcript card (answers + reference lines
+ HTML path) -- the durable answer in the chat, with or without the HTML
export. Building blocks:

- structured per-paper summaries along a fixed rubric (Forschungsziel,
  Methodik, Untersuchungsort, Ergebnisse, Diskussion, Zukunftsausblick;
  bullet points or prose), retrieved over six fixed bilingual facet
  queries;
- detail questions in mode A (answered per paper -- covers every document,
  costs papers x questions generation calls; the wizard warns above 15) or
  mode B (one merged answer per question across the scope);
- an optional review synthesis ("Stand der Literatur"), recommended on the
  library scope; the wizard offers it only with several documents (over one
  paper it would just be a weaker summary).

The report page (German chrome by default, `uiLanguage` switches) shows
answers inside per-paper sections, method & transparency right under the
head metadata, and clickable citation superscripts that open the source
PDF at the cited page (Firefox also highlights the passage; Chromium opens
the page). Single-paper reports number the cited PASSAGES (a numbered
Belegstellen list with page links) instead of a one-row reference table;
multi-paper reports keep scholarly paper-level numbering plus a reference
table, table of contents and per-paper sections.

**Retrieval** (all modes): the original question PLUS a disclosed English
translation variant (one small generate() call; the LLM shapes queries,
never citations), one embed call across all variants with a deduplicated
union, and a deterministic lexical layer (salient terms of the user's
words, whole-word matched) with guaranteed excerpt slots. Generic words of
the reading situation ("Paper", "Frage", mid-sentence German
interrogatives) are stop-listed -- German capitalizes every noun, so the
capitalization heuristic alone over-fired on German questions; quoting a
word overrides the list. The digest and the HTML meta show the variants
and lexical terms used. Retrieval is measurably sensitive to phrasing,
so the agent is instructed to pass the user's question VERBATIM.

**Generator models.** In pi, chat answers and summaries run on the model
currently selected in pi (separate excerpts-only calls; hidden reasoning
off); mode B and review synthesis run on the configured local generator
(`openscholar-8b` by default). A `model` parameter overrides everything.
Embeddings always stay on the configured local embedding server.

- **Slash commands.** `/lit-search`, `/lit-fetch` and `/lit-synth` are
  checked by pi BEFORE the agent. Bare `/lit-synth` runs ONE wizard:
  documents, questions (typed inline, separated by semicolons), summary
  format, detail mode (only with several documents and questions), review
  and HTML as tabs of a single dialog, closed by a submit page that also
  shows the expected model-call count. A pure chat wish (no questions, no
  summary, no review) hands the conversation to the agent, which routes
  every question through the grounded tool. `/lit-synth <question>`
  answers once, agent-free. Long engine calls show an elapsed-seconds
  ticker plus per-unit progress ("Einheit 3/9: ...").
- **HTML-export gate.** "Make me an HTML of that" must produce the
  deterministic report, never an agent-written file (observed twice in the
  field). While a document scope is active in the session, any agent
  `write`/`edit` of an `.html` file opens a blocking dialog; default is to
  block and point the agent at report mode. Headless runs block outright.

Standalone CLI (no Pi):

```
node src/cli.ts synth "Welche Kameras werden verwendet?" --paper 2026_Blanch_Water_Level.pdf --digest
node src/cli.ts synth --report --papers "a.pdf,b.pdf" --questions "q1;q2" --summary bullets --detail-mode per-paper
node src/cli.ts synth --report --all --review
node src/cli.ts synth --session-report --paper a.pdf     # the classic session summary
node src/cli.ts llm-check     # verifies the local backend (embed + generate)
```

The CLI shares pi's session scoping: without `--session` it uses the most
recently written pi session of the current folder (from
`~/.pi/agent/sessions/`), so `synth` without a scope picks up that
session's sticky scope. `--session <uuid>` targets an older session; with
no session, pass the scope explicitly.

## Configuration

- `PI_LITERATURE_REVIEW_MAILTO` -- optional contact email added to the User-Agent and
  polite-pool parameters of API requests (CrossRef/OpenAlex etiquette) and required
  by Unpaywall. Overrides the email stored via the fetch dialog (config.json, see
  Fetching PDFs). Unset by default; no personal data ships in the code.
- `PI_LITERATURE_REVIEW_HOME` -- optional root folder for query results (default:
  `pi-literature-review/` inside the working directory).
- `PI_LITERATURE_REVIEW_LLM_URL` / `_LLM_API` / `_LLM_MODEL` / `_EMBED_MODEL` --
  the local LLM backend for synthesis and chat (defaults: Ollama at
  `http://127.0.0.1:11434`, generator `openscholar-8b`, embeddings
  `nomic-embed-text`; RECOMMENDED embedder: `bge-m3` -- multilingual, fixes
  German questions over English papers; `ollama pull bge-m3` and set
  `"llm": {"embedModel": "bge-m3"}`). The same values can live in
  config.json under `"llm"`;
  `api: "openai"` plus a base URL switches to any OpenAI-compatible local
  server (e.g. llama.cpp's llama-server).
- `PI_LITERATURE_REVIEW_CHAT_MODEL` (or `"llm": {"chatModel": ...}` in
  config.json) -- generator for chat answers and summaries in the CLI (and
  the fallback when pi has no model selected). Inside pi, these run on the
  model currently selected in pi. Falls back to the synthesis generator.
- `SEMANTIC_SCHOLAR_API_KEY` -- reserved for future Semantic Scholar support (the
  free tier rate-limits without a key; not implemented yet).

## What this tool does NOT do

- It does not use an LLM anywhere inside the pipeline.
- It does not search paper full texts; discovery matches what the source databases
  index (typically title/abstract/metadata -- coverage differs per source, which is
  why several sources are queried and deduplicated).
- It does not pad results. A niche query legitimately returning two on-target
  papers yields two on-target papers.
- It does not repair source metadata; broken characters in a database's own
  records pass through unmodified.

## Tests

```
node src/pipeline.test.ts    # pure-logic tests (filter, dedupe, grouping)
node src/render.test.ts      # HTML rendering (escaping, links, layout, selection bar)
node src/enrich.test.ts      # enrichment fill rules (gaps only, provenance)
node src/output.test.ts      # output paths (slug, collision policy, JSON sidecar)
node src/digest.test.ts      # agent-facing digest (counts, reference lines, cap)
node src/intake.test.ts      # intake helpers (group syntax, AND/OR display, year ranges)
node src/fetch.test.ts       # fetch engine (identifiers, resolver chain, naming, report)
node src/config.test.ts      # config paths (XDG/APPDATA), email plausibility, LLM/chat model slots
node src/extract.test.ts     # PDF text cleanup, usability gate, chunking
node src/corpus.test.ts      # library matching and the embedding index cache
node src/llm.test.ts         # backend clients (Ollama / OpenAI-compatible)
node src/adopt.test.ts       # adoption of loose PDFs (identifier from PDF text)
node src/synthesize.test.ts  # synthesis engine incl. the citation trust gate
node src/chat.test.ts        # paper chat engine, session-scoped protocol, report mode
node src/pisession.test.ts   # pi session resolver for the CLI (sticky/report scoping)
```

Acceptance gate before any release: the ground-truth query
`"sandbar detection rivers Sentinel-1 Sentinel-2"` must return DOIs
`10.3390/rs13081505` and `10.3390/rs18010132` with `verified: true`, drop the known
junk records with reasons, and a fabricated DOI must come out `verified: false`.

## License and attribution

MIT (see LICENSE). The multi-source search design follows
[paper-search-mcp](https://github.com/openags/paper-search-mcp) (MIT, Copyright
2025 OPENAGS), which served as the engine during prototyping; the sources here are
implemented natively against the public arXiv, CrossRef and OpenAlex APIs.
