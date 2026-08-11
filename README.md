# pi-literature-review

Local, open, login-free literature review tooling for the
[Pi coding agent](https://pi.dev). One package, one shared data folder, one tool
per pipeline stage:

- **`pi-literature-search`** (`/lit-search`, folder `lit-search/`) --
  deterministic literature discovery: searches arXiv, CrossRef, OpenAlex and
  Semantic Scholar,
  then filters, deduplicates, HTTP-verifies, enriches and groups the results
  into clean JSON, and renders them as a sortable, self-contained HTML table.
- **`pi-literature-selection`** (`/lit-selection`, folder `lit-selection/`) --
  deterministic PDF retrieval for the records you selected on the search page:
  resolver chain record link -> Unpaywall -> arXiv, legal open access only,
  %PDF check before anything is saved, honest per-paper report (see Fetching
  PDFs).
- **`pi-literature-synthesis`** (`/lit-synthesis`, folder `lit-synthesis/`) --
  grounded chat and composable reports over the local PDF library with
  page-exact citations; citations are inserted by fixed code from the verified
  records, never typed by a model.

Each stage owns the folder named after its command, so the data directory
sorts in pipeline order: `lit-search/` (result pages), `lit-selection/`
(the PDF library), `lit-synthesis/` (reports, with the machine-readable chat
protocols under `lit-synthesis/protocols/` and the derived embedding index
under `lit-synthesis/index/`). The synthesis corpus is the UNION of the
`lit-selection/` library and loose PDFs in the folder pi was started in --
an existing library never hides other PDFs; on a duplicate filename the
library wins and the shadowed file is reported.

Transparency: the package talks only to the public arXiv, CrossRef, OpenAlex and
Semantic Scholar APIs, doi.org/arxiv.org for verification and api.unpaywall.org for open-access
lookups, and writes its output files into the `lit-search/`, `lit-selection/`
and `lit-synthesis/` folders of the working directory (see Output; before
2026-08-10 they were bundled under `pi-literature-review/` -- old folders stay
in place, an old `pi-literature-review/lit-selection/` library remains
readable). No accounts, no
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
for a local checkout run it yourself in this directory. The install is small
by design: two direct dependencies (`fast-xml-parser`, `unpdf`), nine packages
in total, no install scripts. The pi packages listed as peer dependencies are
marked optional and are NOT installed -- pi's extension loader provides them
at runtime from its own bundle. (Development note: on filesystems without
symlink support, e.g. exFAT, use `npm install --no-bin-links`.)

## Use

Ask the agent naturally, for example: "Find papers on drone remote sensing of
floodplains, 10 per source, group by floodplain vs. drone terms."

**Every** tool call opens an intake wizard in your terminal before anything is
searched -- enforced by code, not by an instruction the model could skip (field
tests showed models reliably skip "ask the user first" instructions). Since
v29.1 it is the same one-overlay, tabbed wizard the synthesis stage uses. It
always starts on the query tab: the agent's proposal arrives as prefill (your
edits win), you walk the tabs to the review page and submit there; Escape (or
Ctrl+C) cancels the whole run -- no
search fires -- and the agent is told to ask you what to change. The tabs:
the QUERY itself (editable -- your wording wins over the agent's), a
QUERY VARIANTS tab (2026-08-06, replacing the earlier grouping tab):
reaching it fires ONE call to the model currently selected in pi, which
suggests up to 6 alternative searches as CONCEPT-BLOCK boolean queries
-- the building-blocks method of systematic reviews: OR-linked synonyms
within each concept, AND between concepts, e.g.
`(river OR stream) AND (water extraction OR water mapping) AND
(satellite OR remote sensing)`. The top row is your main query --
locked, it always runs -- with its own derived block chain shown dimly
below it. Checked rows run as ADDITIONAL searches in the same run;
results are deduplicated across all variants by fixed code and the HTML
table labels each record with the variant that found it (Q1, Q2, ...).
Agent-proposed `query_variants` appear as prechecked rows; the list you
confirm is what runs. Above the steering line sits an add row (2026-08-10):
type your own query variant and Enter joins it as a checked row that
survives regenerations like any pick. The bottom row is a steering line --
type a direction ("more deep learning", "auf Deutsch", ...) and Enter
regenerates the suggestions; rows you checked survive the regeneration.
Suggestions keep the BASE query's concept order (2026-08-07): for
"Sentinel Water Detection in Rivers" every row starts with the sensor
block, then the water/river block, then the task block -- the prompt asks
for that order and fixed code re-sorts any block that shares a word with
a base concept (AND blocks are commutative, so only the display order
changes), which makes the rows comparable at a glance.
The list is also staggered narrow-to-broad (2026-08-10): the first rows
stay close to the base query's own words with few synonyms, later rows
grow freer (wider synonym sets, subtopics, method names) -- the prompt
asks for the staggering and fixed code guarantees the order by sorting
on term count, then on how many terms share no word with the base query.
A base query that reads like a PROSE SENTENCE (2026-08-10; deterministic
detection: six or more derived word blocks, the user's own boolean/quote
syntax is never touched) gets special handling: word-per-block derivation
would turn the sentence into an unsatisfiably strict AND chain, so the
base row carries a warning note instead of its chain, the suggestion
prompt demands a faithful DISTILLATION of the sentence into concept
blocks as its first line, and that distillation arrives prechecked --
the default Enter-through run then carries a proper block query next to
the sentence.
No model selected or the call fails? The tab degrades honestly to the
locked main query plus a note, and the run works as before. The LLM
here only SHAPES queries -- the citation-path rule is untouched.

**Block search (2026-08-06).** The concept blocks of each query are ONE
structure with two jobs. They ARE the search: arXiv and OpenAlex support
real boolean queries and receive the blocks as such (`(all:river OR
all:stream) AND ...` / `(river OR stream) AND ...`); CrossRef has no
boolean syntax and receives the block terms as flat relevance keywords.
And they ARE the label: a record is marked on_target when it fully
matches the blocks of ANY confirmed query -- regardless of which query
happened to surface it (`found_by` stays pure provenance) -- so the
search and the label can never disagree, and chance no longer decides
a label. Every on_target row carries an EVIDENCE line ("via Q2:
multispectral · stream · feature extraction") naming the winning query
and the exact term that hit per block -- a mislabeling homonym is
readable at a glance instead of reconstructed by hand. Term matching
carries exactly three tolerances (all user decisions): hyphen/space
interchange, plural-s, and the consonant+y ->
ies plural ("body" finds "bodies"). Plain keyword queries
derive one block per content word (the former "strict" rule); an agent
`group_terms` proposal overrides the base query's blocks; queries
carrying quotes or arXiv field syntax are passed through untouched. The
HTML meta documents the exact expression each source received, per
query ("Sent to arXiv / OpenAlex / CrossRef / Semantic Scholar").
Since 2026-08-10 these rows live in a COLLAPSED "Search documentation"
section at the end of the metadata block, together with the
raw per-source-and-query hit counts (`source_counts`, recorded before
deduplication) and the selection flow (`flow`: identified -> removed as
uncitable -> duplicates merged -> screened -> removed without abstract ->
excluded by filters (each with its reason in the dropped table) ->
included to the final literature list, awaiting manual selection) --
exactly the numbers
a PRISMA-2020 flow diagram and a PRISMA-S methods section need, one
click away instead of in the skim path. Then the SEARCH
PERIOD as a menu (last 5 / 10 / 20 years with the resolved range shown
-- computed from today's date, so the ranges roll over with the calendar
year -- all years, or a custom range `2015-2024`,
`2015-` or `2024`; a bare call recommends the last 5 years), the RECORDS
per source (5 default / 15 / 50 -- our politeness limit towards the free
APIs -- plus an inline custom count), a JOURNALS tab (v30.7/.8: reaching
the tab fires one OpenAlex facet query plus one batched score lookup,
and the top journals carrying results for this query load INTO the tab
as a checkbox list -- each entry shows its hit count and its OpenAlex
2-yr citedness, the open analog of the proprietary impact factor, e.g.
"Remote Sensing (1739 hits · 2-yr rate 4.6)"; below the listed journals
sits a catch-all row "Other journals/sources (not listed here)" carrying
the hits outside the list, so checking EVERY row -- or the select-all row
-- means no filter at all rather than a hidden top-12 whitelist (v30.11);
the selection feeds the venues filter, an empty selection means no
filter, Enter passes straight
through while the list is still loading, and an agent venues proposal
arrives as prechecked rows), an AUTHORS tab with the same mechanics
(v30.11: the top authors for this query, each row showing its hits plus
the author's open OpenAlex metrics -- total citations and h-index over
the author's entire work, not these records -- again with an "Other
authors" catch-all row), and OPTIONAL filters, all off by default
(minimum citations and an author-name substring filter that merges with
the picked authors; the journal
score filter remains available as the `min_journal_score` tool parameter
for agent/headless calls). What a tab shows at submit time is what runs;
submitting with an empty query cancels honestly. The dialog follows the
chat's language (German/English; English when no chat has been observed
yet). Headless runs (no interactive UI) skip the dialog. On the
`/lit-search` command path the digest renders as a full card in the chat
AND the agent adds a brief summary underneath (2026-08-10, the synthesis
message pattern: one custom message is display, LLM context and /resume
persistence at once; the brief reply costs one LLM call and never
re-types identifiers or paths -- the card carries the reference lines
and the clickable HTML link). The agent calls the `pi-literature-search`
tool with:

- `query` -- the search string (required)
- `query_variants` -- alternative searches for the same information need,
  searched in the same run. Each variant may be a concept-block boolean
  expression like `(river OR stream) AND (water extraction)` -- capable
  sources receive it as a real boolean query and its finds are labeled
  against its own blocks. Results are deduplicated across all variants by
  fixed code; each record notes which variants found it (`found_by`), and
  the HTML table labels them Q1, Q2, ... On interactive calls they arrive
  as prechecked rows in the wizard's query variants tab (the confirmed
  list runs); headless calls use them directly.
- `per_source` -- results per source (default 5, capped at 50 out of politeness
  towards the free APIs)
- `sources` -- subset of `arxiv`, `crossref`, `openalex` (default: all)
- `group_terms` -- the BASE query's concept blocks: an array of term groups.
  A record is `on_target` when at least one term from every group appears in
  its title+abstract (case-insensitive); everything else is `adjacent`.
  Example: `[["river","fluvial"],["sandbar","bar"],["sentinel","s-1","s-2"]]`.
  Since the block search (2026-08-06) they also DRIVE the boolean fetch at
  arXiv/OpenAlex. Omitted, the blocks derive automatically from the confirmed
  query (there is no grouping dialog step). The matching is fixed code; only
  the word lists vary.
- `min_cites` -- keep only records with at least this many citations. Records
  with an unknown count (arXiv preprints; `cites: null`) still pass. Beware:
  citation thresholds penalize very recent papers.
- `min_journal_score` -- keep only records whose `journal_2yr_citedness` (see
  `enrich` below) is at least this. Records WITHOUT a score (preprints,
  unmatched venues) always pass -- absence of the open JIF analog is not
  evidence against the paper. Needs `enrich` (default on).
- `year_from` / `year_to` -- publication year range. Records that cannot prove
  they are in range (unknown year) are excluded, with a reason.
- `venues` -- keep only records whose journal name contains one of these strings
  (case-insensitive). Venue-less preprints are excluded, with a reason.
- `authors` -- keep only records where at least one author name contains one of
  these strings (case-insensitive). Non-matching records are excluded, with a
  reason.
- `require_pdf` / `verified_only` -- keep only records with a direct PDF link /
  a resolving identifier.
- `sort` -- `cites` (citation count, a rough impact proxy) or `year` (newest
  first); unknown values sort last. Note: an official journal impact factor is
  proprietary and not available from open APIs; this tool does not pretend to
  have it.
- `enrich` -- fill missing citation counts / journal names / ABSTRACTS via a
  deterministic OpenAlex identifier lookup (open API, no scraping; arXiv, for
  example, carries no cites or venue, and CrossRef/Semantic Scholar ship many
  records without abstracts -- measured 2026-08-10: 65% of CrossRef records
  lacked one). Only empty fields are filled, never overwritten; every filled
  field is listed per record under `enriched` and marked with `*` in the HTML
  table (a looked-up abstract stars its "Abstract*" summary). A filled
  abstract also feeds the on_target labeling, which matches title+abstract.
  Records STILL without an abstract after the lookup move to the dropped
  table ("no abstract (sources and the OpenAlex lookup delivered none)" --
  user decision 2026-08-10: title-only records cannot be judged fairly by
  the block labeling; they stay visible and selectable there).
  The same switch attaches each journal's OpenAlex 2-year mean citedness as
  `journal_2yr_citedness` (shown as the "Journal score" column) -- the open
  analog of the proprietary impact factor; it rates the journal, not the paper,
  and is fetched in batches (a handful of extra API calls per run). Default: true.
  It also drives the CODE column (2026-08-07): each record gets a GitHub
  repository link (`code_url`) from two deterministic signals, in order of
  precision -- a repository URL the paper's own abstract names (any record,
  zero extra requests), else one GitHub repository search per arXiv id
  (aggregator/reading-list repos are skipped; paced to GitHub's 10 searches/min,
  capped per run with on_target records first, then kept, then DROPPED
  records (included since 2026-08-10 -- interesting papers keep landing in
  the dropped table, their code links matter there too); an optional token in
  `config.json` `githubToken` or `PI_LITERATURE_REVIEW_GITHUB_TOKEN` raises
  the limit to 30/min). The search path is a disclosed heuristic -- the HTML
  footnote says so -- and replaces the dead Papers-with-Code API for now;
  provenance per record in `enriched` (`abstract` | `github`). Journal papers
  whose abstract names no repository are not looked up (no comparably precise
  search key; guessing by title is against the rules). The Code column only
  renders when at least one record on the page carries a link.
- `html_file` -- override for the HTML output path (see below).

All filters act on metadata the source APIs delivered -- pure deterministic
checks. Whatever a filter removes appears in `dropped` with the exact reason.

## Semantic Scholar (4th source, 2026-08-10)

Semantic Scholar is queried through its bulk endpoint -- the only one with
boolean syntax -- so the concept blocks run as a real boolean query there
too (`+(river | stream) +"water extraction"`; `+` = required block, `|` =
OR). The bulk endpoint has no relevance ranking; results arrive sorted by
citation count, disclosed in the HTML meta ("Sent to Semantic Scholar").
Picked authors are NOT pushed into this source's query (the endpoint has no
author field); the deterministic post-filter still guarantees the scope.
Rate limits: the anonymous shared pool is often saturated (the client
paces, retries, then fails loudly and the run continues with the other
sources). A FREE API key from semanticscholar.org/product/api gives a
dedicated 1 request/second -- store it as `s2ApiKey` in `config.json` or
via `PI_LITERATURE_REVIEW_S2_API_KEY`; no dialog will ever ask for it.

## Output

Every run writes a deterministic, self-contained HTML rendering of the result
(sortable table, expandable abstracts, and a dropped-records table with
EXACTLY the results table's columns -- its Label column reads "dropped"
with the exclusion reason as the dim note, and its rows are selectable
for download like any result: interesting papers keep landing there;
both tables share one fixed column layout, so they sit perfectly aligned
under each other)
plus the
full JSON payload as a sidecar with the same basename to

```
<working directory>/lit-search/<YYYY-MM-DD>_<query>.html
<working directory>/lit-search/<YYYY-MM-DD>_<query>.json
```

Table columns sort on click, Excel-style: the first clicked column is the
primary key, each further click refines the order within it (click Label, then
Citations: on_target stays on top, most cited first inside each label); a
second click on the same column flips its direction, and headers show arrows
plus the key priority. Reload the page to reset.

Long author lists stay compact (2026-08-10): from five authors on, the cell
shows the first three and the last name with a "(+N more)" toggle for the
middle -- sorting still keys on the first author. Each row also carries a
BIBTEX button (2026-08-10): one click copies a deterministically generated
entry (`@article` with a venue, else `@misc` with arXiv eprint fields;
LaTeX special characters escaped, identifiers verbatim) for pasting into a
`.bib` file -- generated by fixed code from the record's API fields, like
everything else on the page.

A same-day rerun of the same query gets `_2`, `_3`, ... appended instead of
overwriting (the pair always shares one suffix). The root folder is overridable
via `PI_LITERATURE_REVIEW_HOME`, the exact HTML path via `html_file`. The page is
generated from the JSON payload by fixed code -- never by a model -- and states
so in its footer.

Both tables (results AND dropped) have a checkbox per row; the selection bar
sits below them and floats at the bottom of the window while you scroll: tick
papers (or "Select all"), click "Copy download request", and paste the copied sentence
(`Download these papers: <id>, <id>, ...`) into the Pi chat -- that sentence is
the handover to the selection tool. The page itself never downloads anything: a
local file:// page can neither write files nor call other servers; it only
assembles identifiers that are already printed on it.

## Fetching PDFs (pi-literature-selection)

Two equivalent ways in: paste the copied sentence, or just ask in plain words
("download the three on_target papers"). The model only transports DOIs/arXiv
IDs to the tool; the tool first shows the identifiers in an editable dialog
(passed identifiers are only the prefill -- your edits win), then, before ANY
network request, a terminal dialog listing every identifier with its title
from the saved searches (titles never come from the model) -- confirm or
cancel there. Escape cancels the whole run.

Resolution per identifier is a fixed chain, first source with real PDF bytes
wins: the record's own `pdf_url` -> Unpaywall (legal open-access index by the
non-profit OurResearch) -> the arXiv PDF endpoint. Every download is checked
for the `%PDF` magic bytes; an HTML error page is never saved as a PDF. No
gray sources, ever. The per-paper report is honest: `downloaded` / `already in
library` / `blocked by publisher` (some publishers, e.g. MDPI, refuse ALL
automated clients with HTTP 403 -- the report then gives the direct link to
open in your browser, which works fine) / `not freely available -- obtain via
authorized access` (with the publisher link) / `invalid identifier`.

Library naming: `lit-selection/<year>_<FirstAuthor>[_et_al]_<Title_words>.pdf`
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
node src/cli.ts selection 10.3390/rs13081505 arXiv:2401.16393
```

## Chat, reports and synthesis (pi-literature-synthesis, /lit-synthesis)

ONE fused stage answers from the LOCAL PDF library with LOCAL generator
models (Ollama or any OpenAI-compatible local server; nothing leaves the
machine). Trust architecture: the generator sees only numbered text
excerpts extracted mechanically from the PDFs and may cite ONLY by excerpt
number; fixed code validates every marker, strips fabricated ones
(reported, not hidden), and inserts references from the HTTP-verified
search records. A result without a single valid citation is flagged
`grounded: false` and rendered with an unmissable warning. PDFs are
indexed once (extraction, chunking, embeddings under `index/`, invalidated
by content hash, embedding model and chunking signature); scanned PDFs are
excluded and named. A paper's REFERENCE LIST is cut before chunking: its
entries are titles of other work, they answer nothing about this paper,
and they cost a fifth of the index -- in one measured case four of the
eight excerpts handed to the model were bibliography. Detection is
conservative (heading on a line of its own, in the back half of the text,
appendices behind the list survive, an implausibly large cut is skipped)
and disclosed in the report's technical details. Chunks target ~1000 characters: measured against the
previous 1600 on human-verified passages, no case retrieved worse, four
retrieved better, and the text one citation marker covers dropped by some
40 % (`experiments/chunk-eval.ts` reproduces the measurement).
Loose PDFs are adopted automatically when their own DOI/arXiv ID can be
extracted from the PDF text and verified by an API lookup; whatever stays
unverified is still usable -- cited honestly by filename and page.

**Dialog policy (v29).** The wizard belongs to the `/lit-synthesis` COMMAND;
the agent-called TOOL runs dialog-free. The rule fits in one sentence:
chat freely, build reports with `/lit-synthesis`. The one dialog that can
still open from an agent turn is the HTML-write gate (below), which asks
before the agent hand-writes a file.

**Dialog language.** All code dialogs (wizard, gate, warnings) follow the
CHAT's language: a deterministic German/English detection over the
question texts, else the language OBSERVED in the user's recent plain
chat input (a passive `pi.on("input")` listener -- opening moves carry no
question text); ENGLISH is the final default (v30 -- a bare command in a
fresh session speaks English until the first German chat input flips
it). The report page chrome (`ui_language`) follows the same resolution.

**Scope.** Everything runs over a document SCOPE: one paper, a selection,
or the whole library. The scope is picked in the `/lit-synthesis` wizard
(checkbox list with a select-all row; selecting everything means the
library) or passed by the agent as EXACT filenames, and is sticky WITHIN
one pi session (`lit-synthesis/protocols/current-scope.json`, stamped with the session id)
-- follow-up calls need only the question. A new pi session starts blank;
`/resume` keeps the scope. With an EMPTY library the tool is deactivated
entirely (`setActiveTools`), so it cannot interfere with unrelated chats.

**Chat mode (the tool).** One grounded answer per question, didactic tone,
page-exact references (`[1] 2026 | 10.5194/... | Title (S. 4)`), no
dialogs: a call with a settled scope runs immediately. When no scope is
set, the tool returns the REAL file list for the user to choose from
(unknown filenames are rejected with that list -- an agent cannot invent
documents); a single-PDF library resolves itself. The validated answer
renders as a full transcript card whose first line shows the VERBATIM
question the engine ran ("Frage, so ausgeführt: ...") -- field tests
showed agents systematically rephrase the user's words, which measurably
degrades retrieval; without a gate the rephrasing is at least VISIBLE,
and `/lit-synthesis <question>` is the verbatim fallback. With the card on
screen the tool result tells the agent the answer is ALREADY displayed
and demands a BRIEF direct answer in chat (2-4 sentences, no full
repeat, no file paths) -- the card stays the ground truth and any
repeat is checkable against it (headless and RPC runs keep the verbatim
digest relay between explicit delimiters). Under its reference lines the
card lists page-precise `file://...pdf#page=N` links (right-click opens
the PDF on the cited page; links are card-display only -- passage
HIGHLIGHTING needs the long v28 links that break in terminals and stays
the HTML report's feature).

**Paper-chat mode.** Every grounded round arms an interception mode: a
persistent yellow hint line names the scope, and from then on every
plain input runs DIRECTLY as a lit-synthesis question -- engine plus
citation gate, no agent in the answer path (commands, `!bash` and Esc
work as usual). Typing `exit` (or `quit`) returns to the normal chat.
This guarantees that follow-up questions get validated answers instead
of the agent improvising from context; the next grounded round (however
routed) re-arms the mode. On the `/lit-synthesis`
COMMAND path (TUI) the answer travels as a custom message instead: the
same card look, but the verbatim text also enters the LLM context and
persists across `/resume`, and the message prompts ONE agent turn that
answers the question BRIEFLY in chat (2-4 sentences drawn only from the
validated answer; the note forbids repeating it -- the card stays the
ground truth, follow-up chat is informed without any model having
touched the card's wording). Every validated round is
appended to a protocol file under `lit-synthesis/protocols/` (multi-paper and library
rounds under a scope identity); corrupt or foreign files are quarantined,
never overwritten. No chat memory in the generator: each call is
stateless; the pi conversation carries the thread.

**Report mode (`/lit-synthesis` only, v29)** builds the composable report
from three building blocks, written to `lit-synthesis/`. Reports cost many
model calls, so they never start from a dialog-free tool call: a
report-flavoured tool call (or a summary/export wish in chat) is handed
back with the instruction to run `/lit-synthesis`; the wizard is the consent,
its questions tab prefilled with this session's chat questions ("fasse
das zusammen" needs no invented questions). The finished
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

The report page follows the CHAT's language in chrome AND prose (one
language for the whole report; an explicit `language` parameter wins).
Layout (v27, second iteration): no table of contents, no section numbers
-- Query metadata first, then one block per document (title + metadata
open; Summary, Questions, References/Cited passages and Source excerpts
each COLLAPSED), then cross-paper questions and the State of the
literature, all separated by rules. References live WITH their paper (a
collapsed table listing only that paper's cited entries, global numbers
kept), not at the page bottom. Technical transparency (passage search,
query variants, word search, quality check) sits in a collapsed block
explained in plain language. Citation superscripts open the source PDF at
the cited page and highlight the WHOLE cited passage, not a five-word
snippet: at index time the code measures per chunk how many leading words
the viewer can actually find and stores that length, so a phrase is only
offered when it demonstrably matches (Firefox highlights it; Chromium
opens the page and ignores the search). "Actually" is meant literally --
`src/pdfjs-find.ts` reproduces pdf.js's own text normalization and query
handling, read out of the installed browser, because approximating it
silently loses highlights (a ligature in front of a hyphenated line break
defeats the viewer's word repair, which our extraction cannot see). Where
the two genuinely diverge the phrase is cut short, and where even the
first words diverge no phrase is offered at all -- the page link stays.
On the test corpus 90-99 % of excerpts highlight in full. A tiny inline
script opens collapsed blocks when an in-page anchor is navigated. Single-paper reports number the cited PASSAGES instead of a
one-row reference table; multi-paper reports keep scholarly paper-level
numbering.

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

**Generator models.** In pi, EVERYTHING -- chat answers, summaries, mode B
and review synthesis -- runs on the model currently selected in pi
(separate excerpts-only calls; hidden reasoning off). No extra generator
model is ever a prerequisite. Optionally, an explicitly configured
`"llm": {"generateModel": ...}` (e.g. a hand-imported `openscholar-8b`,
a model tuned for terse synthesis prose) takes over the review genres;
a `model` parameter overrides everything. Embeddings always run on the
configured embedding backend (see Configuration) -- pi's model API has no
embedding call, so this is the one extra piece synthesis needs.

- **Slash commands.** `/lit-search`, `/lit-selection` and `/lit-synthesis` are
  checked by pi BEFORE the agent, and every BARE command opens its own
  dialog directly (v29.1 -- no agent handoff asking in chat first):
  `/lit-search` starts the intake wizard on the query tab, `/lit-selection`
  asks for the DOIs/arXiv IDs in a one-step dialog (the pasted "Download
  these papers: ..." line works there too), and `/lit-synthesis` runs the ONE
  wizard (documents preselected with the sticky scope, questions typed
  inline and separated by semicolons, summary/mode/review/HTML tabs --
  tabs that do not apply stay VISIBLE but greyed out with a one-line
  reason, so the dialog never changes shape while navigating -- and a
  submit page showing the expected model-call count); the submitted
  answers decide between chat round, report and agent handoff.
  `/lit-synthesis <question>` with a remembered scope answers once,
  agent-free and dialog-free. Long engine calls show an elapsed-seconds
  ticker plus per-unit progress ("Unit 3/9: ...").
- **HTML-write gate.** "Make me an HTML of that" must produce the
  deterministic report, never an agent-written file (observed twice in
  the field). While a document scope is active in the session, any agent
  `write`/`edit` of an `.html` file opens a question dialog (v29): the
  default choice opens the report wizard right there -- the dialog choice
  IS the consent -- "allow" lets an unrelated HTML write through, and
  cancel blocks. Headless runs block outright.

Standalone CLI (no Pi):

```
node src/cli.ts synthesis "Welche Kameras werden verwendet?" --paper 2026_Blanch_Water_Level.pdf --digest
node src/cli.ts synthesis --report --papers "a.pdf,b.pdf" --questions "q1;q2" --summary bullets --detail-mode per-paper
node src/cli.ts synthesis --report --all --review
node src/cli.ts synthesis --session-report --paper a.pdf     # the classic session summary
node src/cli.ts llm-check     # verifies the local backend (embed + generate)
```

The CLI shares pi's session scoping: without `--session` it uses the most
recently written pi session of the current folder (from
`~/.pi/agent/sessions/`), so `synth` without a scope picks up that
session's sticky scope. `--session <uuid>` targets an older session; with
no session, pass the scope explicitly.

## Configuration

All settings live in ONE file at the OS-standard user-config location:

- Linux/macOS: `~/.config/pi-literature-review/config.json` (respects `$XDG_CONFIG_HOME`)
- Windows: `%APPDATA%\pi-literature-review\config.json`

`node src/cli.ts llm-check` prints the resolved path. The file sits
deliberately OUTSIDE the extension folder and outside `~/.pi`: pi resets and
cleans its managed package folders on every update, and keys must never live
next to code that goes into version control. Every setting below can also be
passed as an environment variable, which overrides the file per field.
Everything is optional -- without the file the package runs with its
defaults.

- `PI_LITERATURE_REVIEW_MAILTO` -- optional contact email added to the User-Agent and
  polite-pool parameters of API requests (CrossRef/OpenAlex etiquette) and required
  by Unpaywall. Overrides the email stored via the fetch dialog (config.json, see
  Fetching PDFs). Unset by default; no personal data ships in the code.
- `PI_LITERATURE_REVIEW_HOME` -- optional root folder for the `lit-*` output
  folders (default: the working directory itself).
- `PI_LITERATURE_REVIEW_S2_API_KEY` -- optional free Semantic Scholar API key
  (see the Semantic Scholar section; also storable as `s2ApiKey` in
  config.json). Without one the source degrades loudly when the anonymous
  pool is saturated.
- `PI_LITERATURE_REVIEW_LLM_URL` / `_LLM_API` / `_LLM_MODEL` / `_EMBED_MODEL` --
  the LLM backend for the synthesis stage (defaults: Ollama at
  `http://127.0.0.1:11434`, embeddings `nomic-embed-text`; RECOMMENDED
  embedder: `bge-m3` -- multilingual, fixes German questions over English
  papers; `ollama pull bge-m3` and set `"llm": {"embedModel": "bge-m3"}`).
  Inside pi, generation runs on the model selected in pi; setting
  `_LLM_MODEL` / `"llm": {"generateModel": ...}` EXPLICITLY routes the
  review genres to that local model instead (opt-in, e.g. a hand-imported
  `openscholar-8b`). Headless/CLI runs, which have no pi model, use it for
  everything (default `openscholar-8b`). The same values can live in
  config.json under `"llm"`; `api: "openai"` plus a base URL switches to
  any OpenAI-compatible server (e.g. llama.cpp's llama-server).
- `PI_LITERATURE_REVIEW_LLM_API_KEY` (or `"llm": {"apiKey": ...}` in
  config.json) -- optional bearer token sent as `Authorization: Bearer` on
  every LLM-backend request. Opens the `api: "openai"` dialect to REMOTE
  OpenAI-compatible APIs, so synthesis can run without any local Ollama,
  e.g. `{"llm": {"api": "openai", "baseUrl": "https://api.openai.com",
  "embedModel": "text-embedding-3-small", "apiKey": "sk-..."}}`.
  DISCLOSURE: with a remote backend the text of your PDFs (chunks and
  questions) is sent to that provider -- the local, key-free setup stays
  the default and the first choice of this package.
- `PI_LITERATURE_REVIEW_CHAT_MODEL` (or `"llm": {"chatModel": ...}` in
  config.json) -- generator for chat answers and summaries in the CLI (and
  the fallback when pi has no model selected). Inside pi, these run on the
  model currently selected in pi. Falls back to the synthesis generator.

## Web / RPC clients (e.g. pi-tau-web-server)

pi web frontends drive pi in RPC mode; there the wizards run as a chain of
modal dialogs (one select or editor per step) instead of the TUI overlay.
Notes for that mode:

- An editor/input "Save" with EMPTY content is reported as *cancelled* by
  some clients (pi-tau-web-server does) -- the protocol cannot distinguish
  the two. The dialog chain therefore never treats an editor cancel as a
  run abort: empty stays a legal answer, and cancelling the run is the
  Cancel button of any select step or the review page's Cancel row.
- Result cards (transcript entries) are a TUI feature. In RPC mode a
  finished /lit-search or /lit-synthesis command run hands its result to
  the AGENT for one visible chat answer (web clients only render agent
  messages persistently; the run itself stays agent-free -- the model
  only presents the finished text, instructed to copy it verbatim
  including reference lines). Either way the verbatim result also lands
  in the LLM context, so follow-up chat is informed. The HTML/JSON files
  land on disk (open the HTML from the file browser); a "Search
  finished" notification carries the full path.
- Progress ("working -- Ns elapsed") uses widgets and is invisible in
  clients that do not render `setWidget` requests.
- pi-tau-web-server additionally removes every notification after 5
  seconds and reports an EMPTY editor/input Save as cancelled. The
  package stays usable regardless (see above), but
  `design/webserver-patch/dialogs.js` in this repository is a patched
  copy of that client's dialog handler fixing both (notifications stay
  in the transcript, empty save answers ""); copy it over the installed
  `pi-tau-web-server/public/dialogs.js` to apply (an npm update
  overwrites it again).

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
node src/extract.test.ts     # PDF text cleanup, usability gate, chunking, highlight span
node src/pdfjs-find.test.ts  # replica of the PDF viewer's find (highlight verification)
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
implemented natively against the public arXiv, CrossRef, OpenAlex and Semantic Scholar APIs.
