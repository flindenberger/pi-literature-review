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

## Synthesis and paper chat (pi-literature-synthesize, pi-literature-chat)

Both tools answer from the LOCAL PDF library with a LOCAL generator model
(Ollama or any OpenAI-compatible local server; nothing leaves the machine)
and share one trust architecture: the generator sees only numbered text
excerpts extracted mechanically from the PDFs and may cite ONLY by excerpt
number; fixed code validates every marker, strips fabricated ones (reported,
not hidden), and inserts the reference list from the HTTP-verified search
records. A result without a single valid citation is flagged `grounded:
false` and rendered with an unmissable warning. PDFs are indexed once
(text extraction, chunking, embeddings under `index/`, invalidated by
content hash); scanned PDFs without a text layer are excluded and named.
Loose PDFs that never went through search+fetch are adopted automatically
when their own DOI/arXiv ID can be extracted from the PDF text and verified
by an API lookup.

**pi-literature-synthesize** answers a research question ACROSS the library:
top-k excerpts over all selected papers, one generation pass, and an HTML
review under `reviews/` (prose with citation links, reference table,
evidence excerpts, method notes). The agent model only transports the
question; a terminal dialog lets the user confirm or adjust everything
before anything runs.

**pi-literature-chat** ("Paper Chat") answers questions about ONE paper, for
understanding it -- the conversational counterpart. Differences by design:

- One paper per question. On first contact a terminal picker lists EVERY
  PDF in the folder -- with "whole library (synthesis)" as the first
  option, so the one-paper-vs-library fork is decided by the user in code,
  not by the agent model. PDFs without metadata are listed under their
  original filename; adoption is attempted on selection, and whatever
  stays unverified is still chattable -- its citations then honestly carry
  filename and page only (never invented bibliographic data).
- The selection is sticky: the tool remembers the session's current paper
  (`chats/current-paper.json`), so every further call -- from the agent or
  the CLI -- needs only the question. A weak agent model merely has to
  transport the user's words; `pick: true` (tool) or `--paper` (CLI)
  switches papers.
- The validated answer is returned verbatim in the tool result between
  explicit delimiters (the one deliberate exception to the digest-only
  doctrine -- a chat answer must reach the terminal). References carry the
  cited PDF pages: `[1] 2024 | arXiv:2401.16393v1 | Title (S. 2)`. The
  validated answer ALSO renders as a full, scrollable transcript entry
  (`pi.appendEntry` + a pi-tui renderer; capped-widget fallback when pi-tui
  is unavailable), so it stays visible verbatim even if a small agent model
  paraphrases the digest. The entry does not enter the LLM context.
- In the Pi tool, the generator is the model currently selected in pi
  (called in a separate, excerpts-only completion -- the citation gate is
  unchanged); a `model` parameter or the config slot overrides. The CLI
  uses the configured chat model (`llm.chatModel`, falling back to the
  synthesis generator). Embeddings always stay on the configured local
  embedding server.
- Every validated round is appended to a protocol file
  `chats/<date>_<paper>.json` -- question, validated prose, references,
  cited excerpts. A corrupt or foreign protocol file is never overwritten
  (quarantined with a `_2` suffix instead).
- `report: true` writes a grounded session summary as HTML under `chats/`:
  the session's questions become the retrieval queries; the page contains
  the summary, references, evidence excerpts and the full Q&A protocol.
  The report is built from the protocol on disk, never from the Pi chat
  transcript.
- The report links every citation into the local PDF: page numbers open
  `file://...#page=N` (works in Firefox and Chromium; new tab), and each
  excerpt gets a best-effort highlight link with a short verbatim phrase
  (`#page=N&search=...&phrase=true`) -- Firefox's built-in viewer then
  highlights the passage; Chromium ignores the search part and lands on
  the page. These links are built by code from the scanned library path
  only, never from API or model strings.
- No chat memory in the generator: each call is stateless and separately
  validated; the Pi conversation carries the thread (the agent is told to
  rewrite follow-ups into self-contained questions).
- **Agent-free slash commands.** Every stage has a `pi.registerCommand`
  twin that pi checks BEFORE the agent, so it works regardless of the
  selected model: `/lit-search`, `/lit-fetch`, `/lit-synthesize`, and
  `/lit-chat`. Each runs the SAME engine and code dialogs as its tool, with
  no agent model in the loop -- built after field tests showed weak agents
  (granite4.1:8b) fail to route or relay while a capable one (Qwen3.5-9B)
  works.
- **Persistent chat mode.** `/lit-chat` picks a paper and ENTERS a mode:
  afterwards every plain line you type is a grounded question about that
  paper (agent bypassed), the answer rendered as a transcript entry. A
  persistent widget shows the active paper; typing `exit` (or `quit`) leaves
  the mode. Bare `/lit-chat` switches papers.
- An ambiguous opening ("chat about the papers in this folder") may land in
  either tool -- both dialogs therefore offer the fork in code: the chat
  picker's first entry is the whole-library synthesis, and the synthesize
  dialog has "Chat about ONE paper instead".

Standalone CLI (no Pi):

```
node src/cli.ts synthesize "How are river sandbars detected?" --digest
node src/cli.ts chat "Welche Datenquellen nutzt das Paper?" --paper arxiv_2401.16393.pdf --digest
node src/cli.ts chat --report --paper arxiv_2401.16393.pdf
node src/cli.ts llm-check     # verifies the local backend (embed + generate)
```

## Configuration

- `PI_LITERATURE_REVIEW_MAILTO` -- optional contact email added to the User-Agent and
  polite-pool parameters of API requests (CrossRef/OpenAlex etiquette) and required
  by Unpaywall. Overrides the email stored via the fetch dialog (config.json, see
  Fetching PDFs). Unset by default; no personal data ships in the code.
- `PI_LITERATURE_REVIEW_HOME` -- optional root folder for query results (default:
  `pi-literature-review/` inside the working directory).
- `PI_LITERATURE_REVIEW_LLM_URL` / `_LLM_API` / `_LLM_MODEL` / `_EMBED_MODEL` --
  the local LLM backend for synthesis and paper chat (defaults: Ollama at
  `http://127.0.0.1:11434`, generator `openscholar-8b`, embeddings
  `nomic-embed-text`). The same values can live in config.json under `"llm"`;
  `api: "openai"` plus a base URL switches to any OpenAI-compatible local
  server (e.g. llama.cpp's llama-server).
- `PI_LITERATURE_REVIEW_CHAT_MODEL` (or `"llm": {"chatModel": ...}` in
  config.json) -- generator for the paper chat CLI (and the fallback when
  pi has no model selected). Inside pi, the chat uses the model currently
  selected in pi. Falls back to the synthesis generator.
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
node src/ask.test.ts         # paper chat engine, session protocol, report mode
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
