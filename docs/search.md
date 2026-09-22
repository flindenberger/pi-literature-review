# Search (`/lit-search`)

Searches arXiv, CrossRef and OpenAlex directly, plus Semantic Scholar when a
free API key is configured ([Configuration](configuration.md); without one
the results page notes it as "not queried"). The model
can help shape the queries, but it does not generate the search results:
every record shown comes directly from an API response.

## The wizard

/lit-search — or a free-text request to the agent — opens a tabbed dialog
before any search is started. The agent can suggest the search settings, which
can then be reviewed and changed before the search runs. Pressing Escape
cancels without making a network request. When confirmed, exactly the settings
shown in the tabs are used for the search.

The dialog follows the language of the chat (only English or German available).

![Query variants tab](img/search-variants-tab.png)

### Query
There are two options to peform a query:

1) A keyword-block form: one concept per field (Keyword block 1: satellite imagery), with synonyms within a field separated by OR or commas. The
blocks are linked with AND. Five fields are shown by default; an
"Add keyword block" row adds more, up to eight.

2) A free-text field below takes a sentence or a custom query syntax instead.
When filled, it becomes the query, and a warning is shown if both fields
contain content. 

### Query variants

One call to the model selected in Pi suggests three alternative searches,
written as concept-block boolean queries (OR-synonyms within a concept,
AND between concepts) in the base query's concept order. Each row has a
fixed role, shown in grey under it:

| row | rule |
|---|---|
| +1 synonym per block | the base query's own terms plus at most one synonym per block |
| +2 synonyms per block | the base query's own terms plus at most two synonyms per block |
| optimized for arXiv | method words instead of field jargon (arXiv barely indexes domain jargon), at most three terms per block |

The limits are enforced in code, not only asked of the model: longer
blocks are cut, and the base query's own terms (including synonyms you
typed yourself) always stay. If the model leaves out the arXiv row, a
second call asks for that row alone; if it is still missing, the main
query row says so. When the base query is a hand-built block expression,
the first two rows keep its block count and concepts and vary only the
synonyms.

The main query is locked and always runs. Every checked row runs as an
additional search in the same run: arXiv and OpenAlex receive it as a real
boolean query, duplicates across rows are removed, and every record is
labeled against the blocks of ALL confirmed rows (`on_target` = full match
of at least one).

Two rows at the bottom, separated by blank lines: **Add row** takes a
variant you type yourself; **Steering row** takes a direction and, on
Enter, regenerates the three rows with other words -- checked rows survive and
carry a reload sign. With no model selected, the tab offers only the main
query.

### Search period

Last 5, 10 or 20 years, all years, or an explicit range (`2015-2024`).

### Records

Per source: 5, 15, 50 (the politeness cap), or custom. Under the list, an
optional line "Min. citations per paper" (empty = no filter); records below
it land in the dropped table with the reason.

### Journals

The top journals OpenAlex holds for this query, loaded as a checkbox
list with hit counts and the journal's 2-year citedness (an open
impact-factor analog), plus an "Other journals" row for everything
unlisted. An EXCLUSION list: every row arrives checked (all included),
unticking a row excludes it, and all or none checked means no filter.
Removals survive a reload of the list (after a period change) and new
rows arrive checked. An agent venues proposal arrives as a checked
whitelist instead.

### Authors

Two sections in one tab, each under its own heading; the rows carry no
numbers.

**Authors for this query, ranked by citations.** Loads when the tab is
reached: the top authors OpenAlex holds for this query, period and
journals, with hit counts, total citations, h-index and topics, ordered
by the author's total citations, plus an "Other authors" row. It is an
EXCLUSION list: all rows arrive checked, unticking excludes, all or none
checked means no filter, removals survive a reload, and the head row
"All authors included (Enter: deselect all)" toggles the whole list. When
only listed authors remain checked -- the "Other" row unticked -- those
names are pushed into the source queries as well. The list greys out as
soon as an author is picked below: a pick is a filter of its own.

**Limit the search to a specific author.** A picked author is a filter:
only records carrying that author survive, everything else lands in the
dropped table with the reason. The typing row ("Type author name") looks
authors up at OpenAlex from three letters on, 400 ms after the last
keystroke; the matches appear right under it: name, institution, number
of works, total citations, h-index and main topics, so namesakes (and
OpenAlex's occasional duplicate records of one person) can be told
apart. Ticking a match picks the author and clears the row for the next
search; picked authors stay listed across searches, unticking removes
them. Several picked authors are OR-ed. Three boxes follow, greyed out
until an author is picked:

- **as first author (within the search query)** and **as contributing
  author (within the search query)** both start ticked (any position);
  untick one to narrow the run to first-author or to co-author papers.
  The position is a deterministic post-filter over the first name of
  each record's author list; both unticked counts as both ticked.
  Dropped records name the position.
- **all publications of this author, ignoring the search query**
  starts unticked: the run is author AND query. Ticked, the two position
  boxes grey out ("ignored"), OpenAlex returns the authors' works by id
  (citation-sorted), CrossRef and arXiv by name; Semantic Scholar has no
  author field in its bulk search and is skipped for that run, noted
  under "Failed sources". The concept blocks then only label on_target /
  adjacent.

OpenAlex is filtered by the author's id (exact person); CrossRef and
arXiv, which know no ids, get the name in their author field; the
post-filter over the author names is the guarantee everywhere. The
results page carries an "Author scope" row and the JSON `author_scope`.

### Code

Four code-first sources, unticked by default, under a head row "Search and
add papers with Code" that ticks or clears them all:

| Source | Finds |
|---|---|
| Hugging Face Papers | arXiv papers with the repository linked on their Hugging Face page |
| GitHub README search | repositories whose README cites arxiv.org |
| Curated lists | awesome lists found by GitHub topic on awesome.ecosyste.ms; entries matched against the blocks |
| Google Earth Engine | repositories whose README names the GEE code editor and cites a DOI |

These search repositories FIRST and resolve the papers they cite at arXiv
/ OpenAlex. A repository created more than a year after its paper is
usually a project citing it, not its code: the record moves to the dropped
table with that reason, and beyond five years the pair is not listed at
all. When the found repository is an overview page, the linked repository
whose name matches the paper title is taken instead.

A repository can match the query words while the papers it cites are
about something else entirely (a large README that happens to mention
"river" and "camera"). So a paper that ONLY code sources found must fit
the query itself: its title + abstract must hit the concept blocks of at
least one confirmed query -- every block with one or two blocks, all but
one from three blocks on (4 blocks: at least 3). Same whole-word matching
as the labeling. Otherwise it moves to the dropped table, reason naming
the repository and the hit count. Papers a database also found are not
affected.

The four together add roughly 30-90 seconds per run, which is why they are
off by default. No key involved.

## Block search

The concept blocks of every confirmed query have two jobs.

**They are the search.** arXiv, OpenAlex and Semantic Scholar receive them
as boolean queries; CrossRef, which has no boolean syntax, as relevance
keywords. Semantic Scholar's bulk endpoint returns citation-sorted
results, which the results page discloses.

**They are the label.** A record is `on_target` when its title and
abstract fully match the blocks of ANY confirmed query, otherwise
`adjacent`. Each on_target row names the query and the exact term that hit
per block ("via Q2: river channel · water surface · satellite"). Matching
is whole-word with three tolerances -- hyphen/space, plural-s, consonant+y
to ies -- and no stemming or synonyms beyond that.

## The pipeline (fixed code)

1. **Fetch** per source and query, all sources in parallel (queries of one
   source in turn); raw counts are recorded in source order. The code-first
   sources run here too and are counted as "other methods". CrossRef and
   OpenAlex requests carry a record-type filter (scholarly works only:
   articles, proceedings, preprints, books, chapters, reports, theses), so
   peer-review reports and author replies of open review platforms
   (Copernicus "Reply on RC1", typed `peer-review` by both databases),
   datasets and supplementary material never arrive; the "Sent to" rows
   of the results page show the filter.
2. **Junk filter** -- no title or no authors.
3. **Deduplication** by DOI / arXiv ID, across sources and variants.
4. **Late code pairs** -- repository created more than a year after the
   paper -- to the dropped table.
5. **Verification** over HTTP against doi.org (a few requests in
   parallel) / arxiv.org (one at a time).
6. **Enrichment** via batched OpenAlex identifier lookups: missing
   citation counts, journal names, journal 2-year citedness, and
   abstracts filled from OpenAlex or, failing that, from Semantic
   Scholar by DOI and marked `*` (Semantic Scholar only with an API
   key). Plus a code link, taken from the abstract when it names a known
   host (GitHub, GitLab, Bitbucket, Codeberg, Hugging Face, Zenodo,
   OSF); when code sources are ticked, also from one GitHub repository
   search per record by arXiv id or DOI (at most 12, stopped at the
   first GitHub rate limit). Searched matches skip repositories created
   more than a year after the paper, and a DOI match is linked only when
   the repository owner's name matches an author.
7. **Abstract gate** -- no abstract, dropped table.
8. **Topic gate for code-only finds** -- title + abstract miss the
   required query blocks (see Code above), dropped table.
9. **Optional filters**, then **labeling**.
10. **Access status** -- every record of both tables is looked up at
    OpenAlex by DOI, batched (about one request per 50 records): open-access
    level and every open PDF location. Stored as `access` in the JSON
    (`level`, OpenAlex `oa_status` verbatim, `pdf_urls`), counted in
    `access_counts` for the results table.

Nothing disappears silently: every removed record sits in the dropped
table with its reason, and a failed source is shown while the run
continues.

## The results page

`lit-search/<date>_<query>.html` plus a JSON sidecar of the same basename,
self-contained and offline-readable.

![Results page with the search documentation open](img/search-results-page.png)

**Tables.** *Query results* and *Dropped records*, identical columns,
multi-level click sorting, expandable abstracts, folded author lists, and
per row a **BibTeX** button (a deterministic entry from the record's
fields) and a **Graph** button.

**Search documentation**, collapsed: the exact expression each source
received per query, raw hit counts per source and query, the selection
flow (identified -> uncitable removed -> duplicates merged -> screened ->
removed without abstract -> excluded by filters -> included) and the
labeling rule. That is the material of a PRISMA-2020 flow diagram and a
PRISMA-S methods section.

**Code column**, shown only when a record carries a link: the repository,
labeled by host. Provenance sits in the JSON (`enriched.code_url`:
abstract, github, or the code-first source that started from the
repository).

**Access marker**, in the DOI column of every row, from the OpenAlex
open-access status (the exact OpenAlex category in the tooltip):

| Marker | Rule |
|---|---|
| `full text free` | open access (gold, diamond, hybrid, green, bronze); arXiv records always |
| `abstract only` | OpenAlex type `conference-abstract` (e.g. EGU abstracts): no paper PDF exists |
| `restricted` | not open access; a subscription, e.g. a university network, often reaches it in the browser |
| `unknown` | no DOI, or OpenAlex does not list it |

The **PDF** link next to it is the first open PDF location OpenAlex lists,
else the link the source delivered; restricted rows and image files
(graphical abstracts listed as PDF) get none. The *Access* row above the
tables sums the markers of the results table. Every row stays tickable.

**Download steps**: a strip above the results table, sticky while
scrolling, walks through the handover to `/lit-selection` in three steps:
tick rows in either table (ticked rows stay tinted), press "Copy download
request", paste `Download these papers: <id>, ...` into the Pi chat. The
step markers fill as each step is done. When ticked rows are restricted
or abstract only, a note under the steps says how many and what that
means for the download.

The agent receives only a short digest -- counts, HTML path, one reference
line per record -- never the full JSON.

### The citation graph

`network.html`, next to the results page, opens the paper's references and
citing works: the best-connected 35 as circles (area = citations relative
to the most-cited work shown, colour = year), linked by bibliographic
coupling and co-citation.

Works the paper cites settle to its left, works citing it to its right.
Two toggles ("Cited by this paper" / "Citing this paper") draw the direct
citations as arrows towards the cited work. Hover focuses a node; hovering
a line names why it exists. The mouse wheel zooms, dragging pans, a
double-click resets the view.

The data is fetched from OpenAlex only when you open the graph. Only the
DOI or title is sent, and no language model is involved.

![Citation graph of one paper](img/network-graph.png)

## Tool parameters (agent and headless calls)

`query`, `query_variants`, `per_source` (default 5, cap 50), `sources`,
`group_terms` (the base query's blocks; drive fetch and label),
`min_cites`, `min_journal_score`, `year_from` / `year_to`, `venues`,
`authors` (names; in the wizard the first name prefills the author
lookup), `author_ids` (OpenAlex ids alongside the names, headless),
`author_position` (`first` | `contributing` | `any`), `author_scope`
(`query` | `all`), `require_pdf`, `verified_only`, `sort` (`cites` | `year`),
`enrich` (default on), `html_file`, `code_sources` (any of `hf-papers`,
`github-readme`, `awesome-lists`, `gee-github`; default none -- in the
wizard this prefills the Code tab). `code_list_topics`: GitHub topics of
the research field for the curated-lists source (`remote-sensing`,
`bioinformatics`; fields, not query words); in the wizard they arrive as
checked topic rows, headless they replace the configured default.

Where it lives in the code: see [Development -> Module map](development.md#module-map).
