# Browser interface

Both stages in the browser, on a local server: search and select with a results page, summarize and synthesize as a chat over your PDFs. The same engines as the terminal commands. The server listens on `127.0.0.1` only.

## Start from Pi

```
/pi-literature-review                  start, or show the address again
/pi-literature-review stop             stop the server
/pi-literature-review --port 8765      fixed port
/pi-literature-review --no-open        print the address only
```

- The server runs inside the Pi process. Pi prints the address with its access token.
- It stops when Pi quits, on a session change (`/new`, `/resume`, `/fork`, `/reload`) or with `stop`.
- LLM: the model selected in Pi, or the browser's own choice among Pi's models (Settings, `browserModel`). Pi's model is never changed.
- The terminal wizards keep working; the browser is a second front end.

## Start without Pi

```
npx pi-literature-review web [--port N] [--no-open] [--root DIR]
```

- Needs Node.js 22.19 or newer. `npm install -g pi-literature-review` installs the command for good; from a checkout: `node src/cli.ts web`.
- LLM: `llm.chatModel` with its address; empty = the generation model (`llm.generateModel`). Both are set under Settings.
- `--root` sets the store (same as `PI_LITERATURE_REVIEW_HOME`).
- Ctrl+C stops the server.

Models in detail: [Requirements](requirements.md). How the installed command runs TypeScript: [Development](development.md#installed-command).

## Page layout

| Area | Content |
|---|---|
| Rail (left) | Two stage blocks, library, History, status line, info, Settings, GitHub and npm links. Width draggable (10-30 rem, kept per browser; double click resets). |
| Center | Start screen, results page (stage 1) or chat (stage 2) |
| Panel (right) | Reports, citation graphs, PDFs |

- Every page load opens a new conversation on the start screen. The previous one stays in History; a running job keeps running in it.
- The package name in the rail also returns to the start screen.
- Status line: model, embeddings and thinking levels. A local model or embedding server that does not answer shows a red dot (probed on every state read).

## Start screen

- Four lines build up once per browser session: "Search the literature. / Select the papers. / Summarize and synthesize." slide in, "Streamlined for local AI models" is typed. No animation with reduced motion.
- Two tiles: **search & select** and **summarize & synthesize**. Each opens a new conversation at that stage's first question, like the rail's **+ New search** / **+ New paper chat**.
- No input box on the start screen.
- A stage's first question stands alone in the middle with the input box below; the placeholder types example requests until you click or type.
- Stage 2 with an empty library says how to add PDFs.

## Search

### Request and keyword blocks

- The request box button reads **Search**. Enter or the button starts the search at once.
- The model groups the request's own words into keyword blocks (temperature 0) and adds no word. Code drops every term not in the request. A request in another language is translated once per concept.
- A typed block expression, e.g. `(river OR stream) AND (bathymetry)`, is searched as typed.
- Without a model, or without a usable proposal, word-by-word blocks are shown for confirmation first (with **More options**: the question chain for code sources, period, journals, authors and a summary).
- Blocks are saved per request text in `keyword-blocks.json` next to the config file (`PI_LITERATURE_REVIEW_BLOCK_CACHE`). The same request searches with the same blocks.
- Defaults: last 10 years, 30 records per source, no code sources, all journals and authors.

### Search options ("+" menu)

The **+** left of **Search** opens the options. A badge counts options that differ from the defaults. Pills under the box show what is set (the period always); a pill opens the menu, its × resets the option.

| Row | Control |
|---|---|
| Add synonyms | Switch. The model adds one synonym per block; the blocks open as an editor under the switch (one box per term, **+**, ×, **+ Add block**, **Propose again**). Search uses exactly these blocks. First proposal at temperature 0 and saved; **Propose again** at 0.8 with one retry. |
| Papers with code | Switch. Adds the four code sources (Hugging Face Papers, GitHub README search, awesome lists, Google Earth Engine). Awesome-list topics are chosen without a question. |
| Published | 5 / 10 / 20 years / all |
| Per source | Stepper, 30 by default, up to 50 |
| Min. citations | Number, empty = no limit |
| Journals | OpenAlex facet list for the request's blocks and period; exact names. Needs a request. |
| Authors | OpenAlex facet list with institutions, plus name lookup. Ticked authors are searched by OpenAlex id. Scope "on this topic" / "all their work"; position "any position" / "first author". |

- A name click in the author list opens the author window (see [Results](#results)); the box still ticks.
- **`@name`** in the request box opens an author list (arrow keys, Enter or Tab picks, Esc closes). A pick removes the text and ticks the author. An unpicked name is resolved on Search: one match is taken, otherwise the list opens.

### Author-only search

Empty box plus ticked authors lists all their work ("Works by A and B"):

- All years, up to 200 records per source, no keyword blocks, no model call, no code sources.
- OpenAlex by author id; CrossRef and arXiv by name; Semantic Scholar skipped.
- Works without an abstract stay in the list.
- Names match by surname and first initial ("Carl Legleiter" = "Carl J. Legleiter"), so namesakes are filtered out.

## Results

A search turns the center into a results page: the request, one working line (log on click) and the list. No chat below, no input box. A follow-up search replaces the list; earlier runs stay in `lit-search/` and History.

### Cards

Loaded from the run's JSON (`GET /api/runs/cards`). Per card:

- Title (link), up to three authors ("and n more" expands), year, venue, journal score
- Access badge: full text free / abstract only / restricted / unknown; citations
- Flags: **in library**, **on target**, **dropped: \<reason\>**
- Links: DOI (publisher page), arXiv, PDF (open-access file from OpenAlex), Code, Data, **Graph**; the sources; the abstract (collapsed)
- **Graph** opens the paper's citation neighborhood (`network.html`, light view) as a window. Hidden when OpenAlex lists neither references nor citing works.
- A GitHub or GitLab link deposited at CrossRef or DataCite counts as Code when the record has none.
- A tick box for download; records without DOI or arXiv id cannot be ticked.

### Filters and sort

The filter button opens a table. Filters apply instantly to the loaded list.

| Filter | Choices |
|---|---|
| Published | Last 5 / 10 / 20 years, All. A period wider than the searched window carries ↻ and, after "Start a new search?", searches again. |
| Full text | free, abstract only, restricted |
| Citations | 1+, 10+, 50+ |
| Type | Journal article, review, conference paper, conference abstract, preprint, book or chapter, other, unknown (from the OpenAlex work and source type; arXiv-only = preprint) |
| Code / data | Code, Data |
| Journal, Author | Tick lists of the names in the list, exact match, find box for long lists |
| Source | One chip per source |
| Dropped | Shows the dropped records with their reasons |

- Type, code / data, journal and author choices carry counts.
- **Clear filters** resets. **Search again with these filters** sends period and citations to the sources as a new query.
- Sort: Relevance, Most cited, Newest.

### Toolbar

| Button | Action |
|---|---|
| **Keywords & synonyms** | Block editor in a window (term boxes, **Propose synonyms**); tooltip names the searched blocks |
| **Add papers with code** | Same blocks again with the four code sources on; up to three awesome-list topics from the model |

Both ask "Start a new search?" first. Both are hidden for author-only searches.

### Download

**Download n ticked PDFs** opens a window over the list:

1. Contact email for Unpaywall, only while none is configured (save it, use it once, or continue without).
2. Confirmation with notes on restricted and abstract-only papers, and the target folder: asked every time, last folder preselected, **Change ...** opens the system folder window (a typed path where none exists). The folder becomes a PDF folder.
3. Progress, then the result with **Show in the file manager** and **Back to the list**. The cards reload with library flags; ticks are cleared.

Restricted and abstract-only papers are listed with browser links, not tried. Details: [Selection](selection.md).

### Reports from the list

Written on click only:

| Report | File |
|---|---|
| **Search report** | `<run>.html`, filtered: `<run>_filtered[_n].html` |
| **PRISMA diagram** | `<run>.prisma.svg` |

- The active filters are documented as a screening step: removed records go to the dropped table with their reason, the flow counts them.
- Reports open as a window over the list and add nothing to the page. Esc, a click beside it or the close icon returns to the list.
- In the browser, a search report hides the tick column and the "paste into Pi" steps (style added when served; the file on disk keeps them).
- The PRISMA viewer (`static/prisma.html`): PRISMA 2020 phase bands, **SVG** and **PNG** download, **Details** (request, date, raw hits per source, cap, failed or skipped sources, filters; `GET /api/runs/facts`).

### Author window

A click on an author name (`GET /api/author`):

- The author is found through the card's work (DOI, or an arXiv id's DataCite DOI) and its OpenAlex authorships, matched by surname and first initial.
- Place of work: current employment from the public ORCID record (pub.orcid.org, no key, no contact address sent). Without an ORCID at OpenAlex, an ORCID record with the same name that lists the card's DOI is used. Else OpenAlex's last known institution.
- Also: earlier institutions, works, citations, h-index, citations per year, three topics, ORCID and OpenAlex links.
- Answers are cached for six hours.

## Paper chat

### Sources

Sources are chosen in one place: the library in the rail.

- A tick box before every folder and paper. A ticked folder includes its subfolders; its papers show ticked and locked. Every top folder ticked = whole library.
- A pill under the box names the sources ("Whole library · 87 PDFs", "2 folders, 1 paper · 19 PDFs"); × clears; a click opens the library.
- The question above the box follows the ticks.
- Nothing chosen: Send opens a window (last sources, kept per browser / choose in the library / whole library).
- Many PDFs without an index (30 s or more at ~8 s each): a window offers "Index them and ask" or "Ask the n already indexed".
- Changing sources mid-chat adds a divider ("now 3 PDFs"); later answers and the report use the new choice.
- A chat or report looks up the identity (DOI or arXiv ID in the PDF) of its own papers only.

### Library

Under **Summarize & synthesize**, order: tree, **+ Add folder**, find box.

- Tree: each PDF folder with its subfolders, a legacy `lit-selection/`, and last **Added Documents** (`inbox/`). Counts per folder.
- Hover on a folder: show in the file manager, trash (removes it from the library; files stay; a folder read automatically is remembered as ignored).
- A paper reads "year authors · title", else its file name. Hover shows **i** (paper info) and **+** (new chat about this PDF).
- A click on a paper title opens the PDF and continues its newest chat; without one, a new chat starts.
- Find box: keeps papers whose title, authors, year, file name or keywords hold every typed word. Esc restores the tree.
- **+ Add folder** opens the system folder window (zenity, kdialog, osascript or PowerShell).

Paper info window (`GET /api/paper`): authors, year, journal, type, DOI / arXiv link, citations per year, access, keywords, index state, file, abstract. OpenAlex data by DOI, a single-work lookup without credit cost, cached six hours.

### Adding PDFs

| Way | Behavior |
|---|---|
| Upload button left of the box | System "open PDF files" window (`POST /api/library/pick-files`). When the files share a folder the library does not read: **Only this file** (copied into `inbox/`, `POST /api/library/import`) or **Add entire folder** (read in place). Without a desktop window, the browser's file chooser. |
| Drag and drop anywhere | Copied into `inbox/` (`POST /api/library/upload`: `%PDF-` check, 200 MB cap). A chat over these PDFs opens. |

A PDF the library already holds byte for byte is not copied again: the library opens at it and a toast names its folder.

### Background indexing

- Every library PDF without an index is indexed, one after the other: shortly after server start, after **+ Add folder**, an upload or a download.
- Waits between two PDFs while a chat, report, index or download job runs.
- Rail: "indexing n/m" with a bar under **Library**. An unindexed PDF says so in its tooltip only.
- PDFs without text are not retried until the file changes.
- The index lives in `lit-synthesis/index/` of the store; nothing is written into PDF folders. Details: [Synthesis](synthesis.md#index).

### Answers

- Every answer comes from retrieved passages with page citations. An uncited reply is shown grey with a "no source cited" tag.
- Several papers: marks carry the paper's letter (fixed per conversation) and the passage number within that paper (A1, B2). Hover shows paper, page, passage, DOI and **Show in the PDF**.
- The panel shows one tab per cited paper plus the chat's report.
- Answers show prose and marks only; passage lists and provenance stay in the HTML reports.
- A short message (8 words or fewer, no "?", no question opening, no joining word) first gets a model check (20 s cap). Small talk gets a short reply without lookup; anything else, a failure or a timeout is looked up as usual.
- Example questions in the placeholder come from the chosen papers' names and author keywords (`src/web/keywords.ts`), then are reworded once by the model (`POST /api/chat/examples`, no thinking, 6 s cap, code gate in `src/web/examples.ts`). Placeholder only; never part of an answer.

### One-PDF chat

Opened from a library paper or by dropping one PDF.

- The question names the paper from its metadata.
- No buttons under questions or answers; marks are plain [n].
- A fresh answer moves the open PDF to the first cited passage.
- Reopening it from History opens its PDF again.

### Report

One report per chat, from the **Report** button right of the source pill.

| Part | Content |
|---|---|
| Questions | Always included: the chat's questions answered across the papers. Answers given in the chat over the same sources are reused as they stand. |
| Summary · each paper on its own | Aim, methods, study area, results, discussion, outlook |
| Synthesis · all papers together | Agreement, differences, open points. Needs two or more papers. |

- With answers in the chat, the window's button **Write report** starts at once. Without answers, **Select** marks the choice and Send answers the typed question, then writes the report.
- Button state: dashed = none; dark border, dot (green up to date, amber when newer questions are missing) and time once written. A small arrow updates it.
- The report opens as a panel tab; nothing is added to the thread. Answer field: `chat.build {summary, synthesis}`.
- Language follows the questions (German or English); the interface stays English.
- Page layout of the report: [Synthesis](synthesis.md#report-page).

## Conversation

Question order and wording are fixed in `src/web/dialog.ts`; the model only proposes content. Typed answers are read by fixed rules.

| Step | Question | Answer |
|---|---|---|
| Request | What are you looking for? | A sentence, keywords or a block expression |
| Blocks (no model, or on request) | Is it ok if I split your request into these keyword blocks? | Edit and confirm, or **More options** |
| Pick | Which papers do you want as PDFs? | Ticks, row numbers, DOIs, arXiv ids, `all`, `code` |
| Ask | Ask anything. Responses rely solely on passages retrieved from your sources and include exact citations. | Any question about the chosen PDFs |

### Typing and help

- On choice steps, typed text is a question unless it names a chip or is yes / no. On text steps, question-like text the parser does not recognize goes to the helper. A leading `?` forces the helper.
- The helper answers from a fixed help text per step (`src/web/help.ts`), tailored by the model (30 s cap). Without a model, the fixed text is shown and labeled so.
- Help answers carry chips from code: Continue, Edit keyword blocks, Back, Start over. The helper cannot change the search.
- A typed wish to change the keywords or the request ("change the keywords", "Suchbegriffe anpassen") reopens that question with answers kept. Decided in code.

## Jobs

- Up to three jobs run side by side. Download, index and embedding pull never twice at once.
- Each job belongs to its conversation. **+ New ...** or a History entry during a job parks the conversation; it receives the outcome and is saved. History marks it with a pulsing dot.
- The working line shows a dot and the newest progress line; a click opens the full log. Stop button on the line.
- Esc stops the open conversation's job when no window is open. Deleting a conversation stops its job.
- A stopped follow-up search returns to its list. A stopped first search offers **Search again** and **Edit search**.

## History

- One JSON snapshot per titled conversation in the history folder next to the config file (`~/.config/pi-literature-review/history/`, Windows `%APPDATA%\pi-literature-review\history\`; `PI_LITERATURE_REVIEW_HISTORY` overrides). Written atomically after every change.
- Each stage block has its own History: searches under stage 1, chats and reports under stage 2. Newest ten, the rest behind **Show all n**.
- Sorted by the start of the last search or report; opening an entry does not move it.
- Names: the request or question; "Report: ..." for reports; a one-PDF chat by its paper ("Lee and Kim 2021 · Title").
- Hover shows the entry's files next to its trash: a search's **Search report** and **PRISMA diagram** (faint = not written; the click writes the unfiltered run), a chat's **Paper report** (amber dot = newer questions missing). Files open as a window.
- Trash deletes the conversation file; reports and PDFs stay.
- Conversations from older working folders still open with their lists and reports.

## Report panel and PDF viewer

| Control | Action |
|---|---|
| Enlarge | Shows the panel large over the page; Esc shrinks it |
| Layout row | Paper reports over several papers: Column, Contents, Compare |
| **i** | Paper info, for a library PDF |
| Download | The file shown (a diagram as SVG, a PDF under its name) |
| New tab | The file on its own |
| Close | Hides the panel |

- PDFs open in the interface's own viewer (`static/pdfview.html`, pdf.js from `unpdf`): pages and text layer, zoom, fit width, page number. It jumps to the cited page and highlights the passage in every browser.
- Synthesis reports are served with PDF links rewritten to `/pdf/<file>`; the file on disk keeps its `file://` links.

## Protection

- Binds to `127.0.0.1` only. The `Host` header must name the loopback address (DNS rebinding).
- Every request needs the random token. The first visit with `?token=` sets an `HttpOnly`, `SameSite=Strict` cookie and redirects to the clean address.
- The clean address in another browser has no cookie: a page request gets a short page explaining the full address. Info popover → **Copy link** gives it (`GET /api/address`, authorized pages only).
- API answers are `Cache-Control: no-store`.
- Files are served only from the store's stage folders and the PDF library (found by scanning, never built from the request).
- **Show in the file manager** works only for your folders: PDF folders, download folder, store, config, history and keyword-block folders.

Route list: [Development](development.md#browser-server-routes).

## Settings and keys

Settings writes `config.json` ([Configuration](configuration.md)); its path is the title's tooltip. Explanations are tooltips.

| Section | Rows |
|---|---|
| Models | **LLM** + Thinking (in Pi: **Follow pi (/model)** or one of Pi's models, `browserModel`; standalone: `llm.chatModel` + address). **Generation (synthesis)** + Thinking (`llm.generateModel` + address, `generateThinking`). **Embedding (RAG)** + **Fetch** for Ollama. **Advanced**: API dialect, shared address. |
| Sources | Contact email; keys OpenAlex, Semantic Scholar, GitHub, LLM API |
| Folders | **Library** (PDF folders: show, remove, **+ Add folder**); **Config & data** (the store) |
| Saved data | Conversations (Delete all), Indexes with size (Delete all), Keyword blocks (Forget); each with a show-folder button |

- Each model row has a status dot: green = local server answers, red = it does not, grey = remote or not checked.
- Model fields list what the server offers (Ollama `/api/tags`, OpenAI-compatible `/v1/models`), with **Other ...** for free text. An unreachable server leaves a text field.
- Thinking above Off shows a red warning line.
- Keys are write-only (`POST /api/settings/key`): Save key, Remove, Cancel; **Get a free key** for OpenAlex and Semantic Scholar. The page sees only set / not set.
- Delete all indexes (`POST /api/indexes/clear`) is refused while a chat, report or index job runs; the background pass rebuilds them.

## Info popover

The **i** next to the gear:

- Where data goes: sources, LLM, embeddings, citations by code, open-access downloads
- License (MIT, link to `LICENSE`)
- **Another browser**: **Copy link** copies the full address with its token
- **How to cite**: the Zenodo concept DOI, with **Copy**

## Live demo

The unchanged interface with its server running in the visitor's browser, published on GitHub Pages by `.github/workflows/pages.yml`. Build and internals: [Development](development.md#live-demo).

- Status line "Live demo · runs in your browser"; info popover says **Nothing is collected** (no account, no cookies, no tracking, no server).
- Search works: OpenAlex, CrossRef, DataCite, doi.org; code sources via GitHub, Hugging Face, ecosyste.ms. arXiv is not queried (no requests from web pages).
- History persists in the browser (IndexedDB).
- No model. Download, Settings, upload, **+ Add folder** and dropped PDFs open an install window with the two install commands and a "Get Node.js" link.
- Paper chat: the box is locked. **Try it on an example paper (Blanch et al., 2026)** ticks the recorded paper (HESS 30, 797, CC BY 4.0) and shows three question buttons. Answers and report are played back from a real run with Qwen3.5-9B and bge-m3. Any other question opens the install window.

## Limits

- A model's reasoning is never shown.
- The terminal report option "answer in the chat only" has no browser counterpart.
- Snowball search is not available.
