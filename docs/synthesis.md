# Synthesis (`/lit-synthesis`)

Grounded chat and reports over the local PDF library, with page-exact
citations that open the PDF at the cited passage.

## First call

The first `/lit-synthesis` checks for the local embedding model and, if
missing, offers to fetch it (Ollama, one-time, stays on your machine); if
no backend is reachable it names the options -- see
[Requirements](requirements.md). Nothing to configure for the default
setup.

## Corpus and index

The corpus is the `lit-selection/` library plus loose PDFs in the working
directory (library wins on duplicate filenames, the shadowed file is
reported). Loose PDFs are adopted when their own DOI / arXiv ID can be
extracted and verified; otherwise they are cited by filename and page.
Each PDF is indexed once under `lit-synthesis/index/`: text extraction
(scanned PDFs are excluded and named), reference list cut off, ~1000-
character chunks, embeddings; invalidated by content hash, embedding model
or chunking change.

## Trust architecture

The generator sees only NUMBERED text excerpts and may cite only by
excerpt number; fixed code validates every marker, strips fabricated ones
(reported, not hidden) and inserts references from the verified records.
An answer without a valid citation is flagged `grounded: false` with a
warning. Retrieval = the question + a disclosed English translation
variant + a deterministic lexical layer (salient words, whole-word
matched), top 8 excerpts. The generator has no chat memory; the Pi
conversation carries the thread.

## Scope

One paper, a selection, or the whole library -- picked in the wizard
(checkbox list, select-all = library) or passed by the agent as exact
filenames (unknown names are rejected with the real list). Sticky within
one Pi session; `/resume` keeps it; a new session starts blank. With an
empty library the tool is deactivated.

## Chat mode

One grounded answer per question, page-exact references
(`[1] 2026 | 10.5194/... | Title (p. 4)`) on a card that shows the
question exactly as it ran and carries `file://...pdf#page=N` links. The
agent adds only a brief answer in chat; the card is the ground truth.
Every grounded round arms the **paper-chat mode** (yellow hint line):
plain inputs run directly as questions, no agent in the answer path;
`exit` leaves it. Rounds are appended to a protocol file under
`lit-synthesis/protocols/`.

## Report mode (`/lit-synthesis` only)

Reports cost many model calls, so the wizard is the consent (a
report-flavoured chat request is handed back to `/lit-synthesis`; the
questions tab is prefilled with the session's chat questions). Building
blocks: per-paper structured summaries along a fixed rubric (goal, method,
site, results, discussion, outlook), detail questions per paper or merged
across the scope, an optional review synthesis (several documents only).
The HTML report (`lit-synthesis/<date>_Report_...html`) follows the chat
language; references live with their paper; a collapsed technical block
explains the retrieval in plain language.

![Citation superscript opening the PDF at the highlighted passage](img/synthesis-highlight.png)

Citation superscripts open the PDF at the page and highlight the WHOLE
cited passage: at index time the code measures how much of each chunk the
PDF viewer can actually find (`src/pdfjs-find.ts` reproduces pdf.js's own
text matching) and offers only that -- 90-99 % of excerpts highlight in
full in Firefox; Chromium opens the page.

**HTML-write gate**: while a document scope is active, an agent write of an
`.html` file opens a dialog offering the report wizard instead ("allow"
lets an unrelated file through).

## Models

Answers, summaries and reviews run on the model selected in Pi. Optionally
`llm.generateModel` routes the review genres to a dedicated model (e.g. an
OpenScholar-8B GGUF imported into Ollama); the report names the model that
ran. Embeddings always run on the embedding backend -- see
[Configuration](configuration.md).

## Command line

```
node src/cli.ts synthesis "Which cameras were used?" --paper 2026_Blanch_Water_Level.pdf --digest
node src/cli.ts synthesis --report --papers "a.pdf,b.pdf" --questions "q1;q2" --summary bullets
node src/cli.ts synthesis --report --all --review
```

See [Command line](cli.md).
