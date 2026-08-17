# Synthesis (`/lit-synthesis`, tool `pi-literature-synthesis`)

Grounded chat and composable reports over the LOCAL PDF library, with
page-exact citations that open the PDF at the cited passage.

## The corpus and the index

The corpus is the union of the `lit-selection/` library and loose PDFs in
the directory Pi was started in (an existing library never hides other
PDFs; on a duplicate filename the library wins and the shadowed file is
reported). Loose PDFs are adopted automatically when their own DOI /
arXiv ID can be extracted from the PDF text and verified by an API lookup;
whatever stays unverified is still usable -- cited honestly by filename
and page.

Each PDF is indexed once under `lit-synthesis/index/`: text extraction
(scanned PDFs without a text layer are excluded and named), the reference
list cut off (its entries are titles of other work and answer nothing
about this paper; detection is conservative -- a heading on its own line
in the back half of the text, appendices behind it survive), chunks of
~1000 characters with 150 overlap (measured against hand-located
passages: no case retrieved worse than the previous 1600, four better,
and a citation covers a paragraph instead of half a page), embeddings on
the configured embedding model. The index is invalidated by content hash,
embedding model or chunking change.

## Trust architecture

The generator sees only NUMBERED text excerpts and may cite only by
excerpt number. Fixed code validates every marker, strips fabricated ones
(reported, not hidden) and inserts references from the HTTP-verified
search records. An answer without a single valid citation is flagged
`grounded: false` and rendered with an unmissable warning. There is no
chat memory in the generator: each call is stateless; the Pi conversation
carries the thread.

**Retrieval** combines three signals: the question, a disclosed English
translation variant (one small model call -- the model shapes queries,
never citations), and a deterministic lexical layer (salient words of the
user's question, whole-word matched, with guaranteed excerpt slots;
generic words of the reading situation such as "Paper" or "Frage" are
stop-listed, quoting a word overrides). One embed call across all
variants, deduplicated union, top 8 excerpts. Retrieval is measurably
sensitive to phrasing, so the agent is told to pass your question
VERBATIM -- and the answer card shows the question exactly as it ran.

## Scope

Everything runs over a document scope: one paper, a selection, or the
whole library. The scope is picked in the `/lit-synthesis` wizard
(checkbox list, filename row plus a dim metadata line; select-all = the
library) or passed by the agent as EXACT filenames (unknown names are
rejected with the real list -- an agent cannot invent documents), and it
is sticky WITHIN one Pi session (`lit-synthesis/protocols/current-scope.json`,
stamped with the session id): follow-up calls need only the question. A
new session starts blank; `/resume` keeps the scope. With an EMPTY library
the tool is deactivated entirely, so it cannot interfere with unrelated
chats.

## Chat mode

One grounded answer per question, didactic tone, page-exact references
(`[1] 2026 | 10.5194/... | Title (p. 4)`), rendered as a card whose first
line shows the verbatim question that ran; under the reference lines sit
`file://...pdf#page=N` links (right-click opens the PDF at the page).
With the card on screen the agent is told to add only a BRIEF answer in
chat (2-4 sentences, no repeat, no file paths) -- the card stays the
ground truth and any paraphrase is checkable against it. On the
`/lit-synthesis` command path the same text also enters the LLM context and
persists across `/resume`.

**Paper-chat mode.** Every grounded round arms an interception mode: a
persistent yellow hint line names the scope, and from then on every plain
input runs DIRECTLY as a question -- engine plus citation gate, no agent in
the answer path (commands, `!bash` and Escape work as usual). Typing
`exit` (or `quit`) returns to the normal chat. This guarantees that
follow-up questions get validated answers instead of the agent improvising
from context.

Every validated round is appended to a protocol file under
`lit-synthesis/protocols/` (schema-versioned; corrupt or foreign files are
quarantined, never overwritten).

## Report mode (`/lit-synthesis` only)

Reports cost many model calls, so they never start from a dialog-free
tool call: a report-flavoured request in chat ("summarize this", "make me
an HTML") is handed back with the instruction to run `/lit-synthesis`; the
wizard is the consent, its questions tab prefilled with this session's
chat questions. Building blocks:

- structured per-paper summaries along a fixed rubric (research goal,
  method, study site, results, discussion, outlook; bullets or prose),
  retrieved over six fixed bilingual facet queries;
- detail questions in mode A (answered per paper -- covers every document,
  costs papers x questions calls; the wizard warns above 15) or mode B
  (one merged answer per question across the scope);
- an optional review synthesis ("state of the literature"), offered only
  with several documents.

The HTML report (`lit-synthesis/<date>_Report_...html`) follows the chat's
language in chrome and prose: query metadata first, then one block per
document (title and metadata open; summary, questions, cited passages,
source excerpts collapsed), then cross-paper questions and the state of
the literature. References live with their paper. A collapsed "technical
details" block explains passage search, query variants, word search and
the quality check in plain language.

![Citation superscript opening the PDF at the highlighted passage](img/synthesis-highlight.png)

**Citation superscripts open the PDF at the cited page and highlight the
WHOLE cited passage.** At index time the code measures per chunk how many
leading words the PDF viewer can actually find and stores that length;
`src/pdfjs-find.ts` reproduces pdf.js's own text normalization and query
handling (read from the installed browser), because approximating it
silently loses highlights. Where the two diverge the phrase is cut short;
where even the first words diverge only the page link is offered. On the
test corpus 90-99 % of excerpts highlight in full (Firefox; Chromium opens
the page and ignores the search).

**HTML-write gate.** "Make me an HTML of that" must yield the
deterministic report, never an agent-written file (observed twice in the
field): while a document scope is active, any agent `write`/`edit` of an
`.html` file opens a question dialog whose default choice opens the report
wizard right there; "allow" lets an unrelated HTML write through; cancel
blocks. Headless runs block outright.

## Models

In Pi, chat answers, summaries, mode B and the review synthesis run on the
model currently selected in Pi (separate excerpts-only calls, hidden
reasoning off). Optionally `llm.generateModel` routes the review genres to
a dedicated model (e.g. an OpenScholar-8B GGUF imported into Ollama:
Modelfile `FROM ./<file>.gguf`, `ollama create openscholar-8b -f
Modelfile`, then `"generateModel": "openscholar-8b"`); the report metadata
names the model that actually ran. Embeddings always run on the configured
embedding backend -- see [Requirements](requirements.md) and
[Configuration](configuration.md).

## Command line

```
node src/cli.ts synthesis "Which cameras were used?" --paper 2026_Blanch_Water_Level.pdf --digest
node src/cli.ts synthesis --report --papers "a.pdf,b.pdf" --questions "q1;q2" --summary bullets --detail-mode per-paper
node src/cli.ts synthesis --report --all --review
node src/cli.ts synthesis --session-report --paper a.pdf
```

See [Command line](cli.md) for session scoping and every flag.
