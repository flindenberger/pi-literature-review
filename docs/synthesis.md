# Synthesis (`/lit-synthesis`)

Grounded chat and reports over the local PDF library. Every citation names a page and opens the PDF at the cited passage.

## First call

- The first `/lit-synthesis` checks the embedding model. When it is missing, it offers `ollama pull <model>` (local, one-time).
- When no backend is reachable, it names the options. See [Requirements](requirements.md#embedding-model-rag).

## Corpus

Sources, read in this order. On a duplicate file name the earlier source wins; the shadowed files are named in a warning.

| Order | Source | Read |
|---|---|---|
| 1 | Legacy places: `lit-selection/` in the store, in the working directory and in `pi-literature-review/` there; loose PDFs in the working directory | flat |
| 2 | `inbox/` in the store (PDFs dropped onto the browser page) | flat |
| 3 | Your PDF folders (`pdfFolders`) | recursive |

- Locations and limits: [Configuration -> Where files live](configuration.md#where-files-live).
- Legacy places listed in `ignoredFolders` are skipped.

## Adoption

A PDF without metadata (no twin from a download) gets an adoption attempt:

- its own DOI or arXiv ID is read by fixed pattern from the first two pages,
- the ID is looked up at OpenAlex (DOI) or the arXiv API (arXiv ID),
- a successful lookup writes the metadata twin into the store's `meta/`.

Only the PDFs of the current chat or report scope are tried; a whole-library scope tries every unmatched PDF. A PDF that stays unverified is cited by file name and page.

## Index

- One index file per PDF under `lit-synthesis/index/` in the store.
- Steps: text extraction, reference list cut off, chunks of about 1000 characters, embeddings.
- PDFs without extractable text (scans) are excluded and named.
- Rebuilt on a change of content hash, embedding model or chunking.

## Retrieval

| Parameter | Value |
|---|---|
| Queries | The question, plus a disclosed English translation variant, plus a lexical layer (salient words, whole-word match) |
| `top_k` / `--top-k` | Excerpts per unit. Default 8, maximum 20. |
| Per-paper minimum | Over a chosen set of papers (not the whole library) each paper gets its 2 best excerpts; fewer when the set is large, none when papers outnumber excerpts. The rest goes by score. Applies to chat answers and cross-paper report units. |
| Summary units | Six fixed two-language facet queries (aim, methods, study area, results, discussion, outlook), 3 excerpts each, capped by `top_k` |

## Citation gate

- The model sees only numbered excerpts and cites by number.
- Fixed code checks every marker, strips invalid ones (reported in a warning) and inserts the references from the verified records.
- A self-written reference section is cut.
- An answer without any valid marker is asked for once more, with the citation rule repeated. If it stays unmarked, it is flagged `grounded: false`.
- The model has no chat memory; the Pi conversation carries the thread.

## Scope

- One paper, a selection, or the whole library.
- Chosen in the wizard (checkbox list, select all = library), or passed by the agent as exact file names. Unknown names are rejected with the real list.
- The scope is kept per Pi session (also after `/resume`); a new session starts empty.
- With an empty library the tool is deactivated.

## Chat

- One grounded answer per question, on a card with the question as it ran and page-exact `file://...pdf#page=N` links.
- The agent adds only a brief answer; the card is the reference.
- Each grounded round turns on paper-chat mode: plain inputs run directly as questions, no agent in between. `exit` leaves it.
- Rounds are appended to a protocol under `lit-synthesis/protocols/`.

## Report

Reports run only through the `/lit-synthesis` wizard (many model calls; the wizard is the consent). A report request by the agent is handed back with a pointer to the command; the questions tab is prefilled from the session's chat questions.

| Wizard tab | Choice |
|---|---|
| Documents | Scope |
| Questions | One per line; each answered across the chosen papers |
| Summary | No / bullet points / prose. Summary · each paper on its own, along a fixed rubric. |
| Synthesis | Synthesis · all papers together: agreement, differences, open points. Two or more papers. |
| HTML | Write the HTML report, or answer in the chat only |

- The browser builds the same report from a paper chat and reuses the chat's answers. See [Browser interface](web.md).
- A named paper no longer in the library is skipped with a warning.
- The CLI `--detail-mode` takes `per-paper` or `cross-paper` (engine default `per-paper`). `both` comes only from the browser.

### Report page

- File: `lit-synthesis/<date>_synthesis_report_<first authors>.html`, e.g. `2026-09-18_synthesis_report_Li_Moortgat_Chen.html`. Up to three first-author surnames in scope order, `_et_al` when more papers follow; without author data, the question slug.
- Order: paper table (A, B, C), question cards, synthesis, papers in letter order (summary in label rows, cited passages collapsed), "About this report" (metadata, technical notes) collapsed.
- Prose language: the language of the questions unless set (`--language`). Page labels: the wizard language.

| Layout (several papers, kept per browser) | View |
|---|---|
| Column | Default, one column |
| Contents | Table of contents on the left (a bar on top in a narrow window), papers as cards, summary in two columns |
| Compare | Summaries side by side: one column per paper, one row per heading, two points per cell and "+ n more" |

In the browser panel the layout buttons sit in a row under the panel head (`window.plrLayouts`).

### Citation labels

- One label = one passage on one page, never a whole paper.
- Several papers: paper letter + passage number within that paper (`A1`, `B2`). Letters come from the chat when the report is written from one; other papers follow in order of first citation, uncited last. Numbers count in reading order, questions first.
- One paper: plain numbers.
- Labels at the same spot stand side by side, sorted, each with its own page link. Hover shows paper, page and passage text.
- Each paper block lists its cited passages with page link, excerpt and retrieval rank per question. Cross-paper sections add a reference table (letter, title, pages).

### Highlighted passages

![Citation superscript opening the PDF at the highlighted passage](img/synthesis-highlight.png)

- A citation opens the PDF at the page and highlights the whole cited passage.
- At index time `src/pdfjs-find.ts` reproduces pdf.js's text matching; each excerpt carries only the part the viewer can find.
- Report opened as a local file: highlights in Firefox; Chromium-based browsers open the page without the highlight.
- Browser interface: every PDF opens in its own viewer (`src/web/static/pdfview.html`, served at `/static/pdfview.html`, pdf.js from unpdf), with the same matching rules in every browser (`pdfjsNormalizeMapped`).

### HTML-write gate

While a scope is active, an agent write or edit of an `.html` file opens a dialog: report wizard (default), "Allow" for an unrelated file, or cancel. Without a UI the write is blocked.

## Models

| Unit | Role | Inside Pi | Standalone |
|---|---|---|---|
| Chat answers, summaries, per-paper question units, English retrieval variant | LLM | The Pi model (browser: `browserModel` when set) | `llm.chatModel`, else `llm.generateModel` |
| Cross-paper question units, synthesis | Generation | `llm.generateModel` when set, else the Pi model | `llm.generateModel` |
| Embeddings | Embedding | `llm.embedModel` | `llm.embedModel` |

- The report names the model that ran.
- Example generation model: [OpenScholar-8B](https://github.com/akariasai/openscholar) (Asai et al., 2024, [arXiv:2411.14199](https://arxiv.org/abs/2411.14199)) as a GGUF imported into Ollama.
- Keys, addresses and per-role servers: [Configuration -> Models and backends](configuration.md#models-and-backends). Tested models: [Requirements](requirements.md).

### Thinking

The package's own setting, independent of Pi's thinking level, read for every call, the same inside Pi and standalone.

| Key | Role | Default |
|---|---|---|
| `thinking` | LLM role: every call except the generation units | `off` |
| `generateThinking` | Generation role: cross-paper question units and synthesis | unset = `thinking` |

- Levels: `off`, `low`, `medium`, `high`. When on, each call gets 2k / 4k / 8k extra output tokens for the reasoning.
- Thinking slows every call. On a small local model it rarely helps: the calls are excerpt-bound, and citations are code-checked either way.
- A call may spend its whole budget on reasoning; the error then says "it produced only hidden reasoning". Turn thinking off or lower, or ask again.
- Short checks with a time limit (small talk, help) fall back to their no-model behaviour.
- Wire format and the llama.cpp prerequisite: [Configuration -> Thinking](configuration.md#thinking).

## Command line

```
node src/cli.ts synthesis "Which cameras were used?" --paper 2026_Blanch_Water_Level.pdf --digest
node src/cli.ts synthesis --report --papers "a.pdf,b.pdf" --questions "q1;q2" --summary bullets
node src/cli.ts synthesis --report --all --review --top-k 12
```

All flags: [Command line](cli.md). Module map: [Development](development.md#module-map).
