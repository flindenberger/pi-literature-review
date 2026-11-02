# Web interface

The two stages as a chat in your browser, served by a small local
server that runs inside Pi (or standalone, see below). The assistant asks
one question at a time, you answer with a click or a few words, and
search, selection and synthesis run through the very same engines as the
terminal commands. Nothing is uploaded anywhere: the server listens on
`127.0.0.1` only.

## Start from Pi

```
/pi-literature-review
```

A server starts inside the Pi process, the browser opens, and the address
(with its access token) is printed in Pi. The writing model is the model
selected in Pi -- `/model` switches it for the next job -- and embeddings
run on the configured local backend as in `/lit-synthesis`. The server
lives until Pi quits, the session changes (`/new`, `/resume`, `/fork`,
`/reload`) or you stop it:

```
/pi-literature-review stop
/pi-literature-review --port 8765      fixed port
/pi-literature-review --no-open        print the address only
```

The terminal wizards keep working unchanged; the web page is a second
front end over the same code.

## Start without Pi

```
node src/cli.ts web [--port N] [--no-open] [--root DIR]
```

The writing model is then `llm.generateModel` of the configuration
(Ollama, llama.cpp or any OpenAI-compatible address); the Settings page
shows and edits it. `--root` sets the data folder (default: the working
directory, `PI_LITERATURE_REVIEW_HOME` overrides).

## The page

Every page load, and a click on the package name in the rail, opens a
new conversation on the start screen (the one before stays in History;
while a job runs the live conversation shows instead): four lines that
build up once per browser session -- "Search the literature. Select the
papers. Summarize and synthesize." slide in, "Streamlined for small
local AI models" is typed in mint green and settles to black -- then two tiles, **search & select** and **summarize &
synthesize**. A tile opens a
conversation at that stage's first question, like the rail's **+ New**
rows (without PDFs in the library the second one leads to a note that
says what to do). The start screen has no input box. Where
the box takes a search request (the first search question) its
button reads **Search**, and a **+** beside it opens the search options
-- the choices the terminal wizard offers, made before the search, each a
row with an icon and a switch or a small control (a tooltip says more):
**Add synonyms** (two wavy lines), **Papers with code** (the same four
code sources as **Add papers with code**, list topics chosen without a
question), **Snowball search** (greyed, not built yet), **Published**
(5, 10 or 20 years or all; 10 by default), **Per source** (30 by
default, up to 50), **Min. citations**, **Journals** and **Authors**.
Journals and authors stay grey until the box holds a request: their
lists are OpenAlex counts over the request's keyword blocks within the
chosen period (the blocks come from `POST /api/search/blocks`, the same
saved blocks the search then uses); the author list also finds a person
by name. Authors ticked in the list and those found by name (tick boxes,
untick to drop) are searched by their OpenAlex ids, all with one choice
"on this topic" or "all their work". Pills under the box
show what is set (the period always); a pill opens the menu, its x
resets that option; the number on the **+** counts the options that
differ from the defaults. A click anywhere on a row switches it or opens
its list; on the synonym row only the switch switches. Switching synonyms
on shows the blocks with the model's synonyms right under the switch (a
click on the row folds them shut and open again, the switch stays on), in
the same editor as the drop-down (one box per term, the terms of a block
linked by a small "≈", **+**, **x**, **+ Add block**) with **Propose
again**; **Search** then searches with exactly these blocks. The first
proposal for a request runs at temperature 0 and is saved; **Propose
again** asks with some variation (temperature 0.8, one retry when the
answer is unusable) and saves the new proposal.

Without synonyms the model only groups the words of your request into
keyword blocks, adds no word of its own, and code drops every term that
is not in the request (a request in another language is translated once
per concept instead). With synonyms the model adds one per block and the
blocks open in a drop-down under the box -- one row per block, one box
per term, **+** adds a synonym, **x** removes a term, **+ Add block** a
row -- and **Search** (or Enter) searches with the edited blocks; a
changed request in the box asks for new blocks. The model's blocks are
saved per request text (`keyword-blocks.json` next to the configuration
file, `PI_LITERATURE_REVIEW_BLOCK_CACHE` overrides), so the same request
always searches with the same blocks; **Propose again** asks the model
afresh, and Settings has **Forget saved keyword blocks**. The sources
still add new papers over time, so a repeated search weeks later can
find more. The **i** button next to the gear says where the data
goes (sources, model, embeddings, citations by code, open-access
downloads). A white Greek pi on a dark disc stands next to the name, the same mark as the browser tab icon. Left, a slim rail: the
two stages -- **SEARCH & SELECT** (magnifier with a download arrow) and
**SUMMARIZE & SYNTHESIZE** (sheet with a pen).
Nothing is selected until you click; a click opens a stage's block and
marks it: its **+** (New search, New paper chat: a new conversation that
starts at that stage; the current one stays in History) and its
**History** (search conversations under stage 1, chats and reports under
stage 2; a search shows its request without a "Search:" prefix, the
tooltip the whole request). Hovering an entry shows its own files next to
its trash: a search
its **HTML report** and **PRISMA diagram** (the run unfiltered; a faint
icon means not written yet, the click writes it), a chat or synthesis its
newest report; a click opens the file as a window. One search, one
report, one diagram, all in one place. The block of the stage a
conversation is in opens by itself. Empty lists show nothing (no dash, no 0). Stage 2
holds the **Library** right under **+ New paper chat**: **+ Add folder**
opens the system's folder window and adds a PDF folder; below, the library
as folders -- each PDF folder with its own subfolders, an older `lit-selection/`,
and last **Uploads** for PDFs dropped onto the page or added with **Upload
PDF** -- with counts and, on
hover, a button per folder that shows it in the file manager and a trash
that takes the folder out of the library (its files stay on the disk; a
folder the library read on its own, such as a `lit-selection/` where pi was
started, is remembered as ignored -- adding it again brings it back),
rescanned when opened. A paper reads "year authors · title" where the metadata has them,
else its file name. A click on a paper opens the PDF in the panel and
continues the paper's last chat (the newest one in History); a paper
without a chat, or the **+** that shows on hover, starts a new chat about
exactly this PDF (the PDF loads anew, without the marks of the last chat), whose question names it from its
metadata ("What would you like to know about “Title” (Smith et al.,
2021)?", "... about this PDF?" without metadata; examples for one paper in
the box). A chat on one PDF reads like a chat: no buttons (no report, no
scope), and an answer is its prose with the [n] links only (no passage
list, no paper list, no provenance line below); when an answer arrives
while the PDF is open on the right, the PDF jumps to the first cited
passage, marked (any [n] link shows another). A short message (at most
eight words) without a question mark, a question or request opening
("what", "explain", "mehr", "weiter", "ja" ...) or a joining word ("und",
"but" ...) first gets one short model check: the model answers the
marker QUESTION for anything that may refer to the paper, or a short
friendly reply for pure small talk ("danke", "find ich gut", "hallo").
Only a reply without a citation, a page or the marker is shown, and no
passage is retrieved for it; anything unclear, a failure or a timeout
(20 s) looks the message up in the paper as usual. Any
other reply without a cited passage is shown as it is, in grey, with a
small "no source cited" tag (the HTML reports keep their UNGROUNDED
warning). Reopening such a chat from
History opens its PDF again; **+ New search** / **+ New paper chat** close
the panel. In History a chat on one PDF is named after the paper ("Lee
and Kim 2021 · Title", from its metadata; without metadata its first
question), other chats by their question, reports "Report: ...". A chat or report over some papers looks up the identity (DOI or
arXiv ID in the PDF) of those papers only, never of the whole library. The
rail's right edge can be dragged (10 to 30 rem, kept per browser; a double
click resets it). Below the stages: the model in use (a local model or embedding
server that is not running shows a red dot: the server probes 127.0.0.1
addresses on every state read), a folder icon that opens the data folder
in the file manager (tooltip: its path), a gear icon for Settings, and at the right the GitHub
and npm marks linking to the package's repository and npm page.
The **+ New search** and **+ New paper chat** rows open a conversation at
that stage's first question, shown alone in the middle of the column with the
input box under it; the box types example requests into its placeholder until
you start writing. The server is stopped from
pi (`/pi-literature-review stop`) or with Ctrl-C. In the middle, the conversation with
one input box; a search turns the column into a results page (see **The
result list** below): the request in full, the search's log (collapsed,
green dot) and the list, no chat under it, the input box away until a new
conversation starts. On the right, the report panel: it opens when
a report was written on click, a synthesis has written an HTML file, or a
card's **Graph** link is opened; **Enlarge** shows it large over the page
(Esc closes), **New tab** opens the file on its own, **Close** hides the
panel (any file card in the chat brings it back).

### The result list

A finished search stands in the chat as a list of cards, loaded from the
run's JSON sidecar (`GET /api/runs/cards`), without row numbers (the
HTML report numbers its rows): title (link),
up to three authors, year, venue and journal score, the access badge
(full text free / abstract only / restricted / unknown), citations, the
links DOI, arXiv, PDF, Code, Data and **Graph** (the citation
neighbourhood page, opened in the panel), the sources and the abstract.
Above the cards: the count line, below it the sort button, the filter
button, **Keywords & synonyms** (its tooltip names the searched blocks; the
blocks themselves stand in the HTML report) and **Add papers with
code**. The filter button opens the filters
as a two-column table (label, choices), all applied instantly to the
loaded list: publication period (5 / 10 / 20 years / all; a period wider than
the searched window carries the sign ↻ and, after a short confirmation
window, runs the search again with that window), full text, citations
(1+ / 10+ / 50+), publication **Type** (journal article, review article,
conference paper, conference abstract, preprint, book or chapter, other,
unknown -- from the OpenAlex work type and the type of its source, which
the access lookup already fetches; an arXiv-only record is a preprint,
nothing else is guessed), **Code / data** (each with its count), **Journal**
and **Author** (a list of the names in the result list with their counts
to tick, exact names, a find box for long lists), source, and **Dropped**
(shows the dropped table's records with their reasons). Type, code / data,
journal and author choices carry their counts.
**Clear filters** resets; **Search again with these filters** sends the
period and citation filters to the sources as a new query (more papers
inside the filter). The sort button opens a small menu: relevance, most
cited, newest. Ticks on the cards select papers; **Download n ticked PDFs**
starts the download. **Add papers with code** runs the same blocks again
with the four code sources on (their awesome-list topics are taken from
the model's suggestion without a question, three at most). **Reports from
this list** are written on click only: the **HTML report** and the
**PRISMA diagram** (SVG) of the list as filtered, with the filters
documented as a screening step (the removed records stand in the dropped
table with their reason, the flow counts them). A report opens as a window
over the list (the citation graph of a card too); closing it (Esc, a click
beside it, or the close icon) leaves the list as it was, and no message is
added below the list; an unfiltered report
takes the run's own name, a filtered one gets `_filtered` added. Reports
open in the panel on the right; the rail lists them under **HTML
reports**. A new search from the list (**Keywords & synonyms**, **Add papers with
code**, a wider period) replaces the list; the earlier runs stay in
`lit-search/` and in History.

Everything after the list runs in a small window over it, not in the
chat: **Download n ticked PDFs** asks for the Unpaywall contact email
when none is configured (type it, optionally saved, or continue without),
confirms the count with the notes on restricted and abstract-only papers
and asks the folder (every time; the last folder preselected, **Change
...** opens the system's folder window, a typed path where none exists),
shows the download's progress and then the result with a button that
shows that folder in the file manager; **Back to the list** returns
to the list, whose cards reload with the library badges and without the
ticks. **Keywords & synonyms** opens the keyword blocks in the same
editor as the **+** menu (one box per term, "≈" between the synonyms of a
block, **+ Add block**, **Propose synonyms** for a fresh model proposal);
**Search** asks "Start a new search?" first, like **Add papers with code**
and a period wider than the searched window. Both buttons carry the
**+** menu's icon (≈, </>) with a small arrow: they run the search again. The chat over
the PDFs is stage 2, reached from the rail (**Summarize & synthesize**),
not from the result list.

### Conversation history

Every conversation with a request or question is saved as one JSON file
(a snapshot of the dialog as the page shows it, some tens of kilobytes)
in the history folder next to the configuration file:
`~/.config/pi-literature-review/history/` on Linux and macOS,
`%APPDATA%\pi-literature-review\history\` on Windows;
`PI_LITERATURE_REVIEW_HISTORY` moves the folder. Bundled with the
configuration on purpose: one place for everything the package keeps
outside the data folders, like pi keeps everything under `~/.pi/agent`.
The file is rewritten after every change (temporary file + rename, so a
crash never leaves a half-written conversation); a conversation with only
chip clicks has no title and is never saved.

The **History** list in the rail shows the saved conversations, newest
computation first (the time its last search or report started; opening or
answering a conversation does not move it), named after the request or
question ("Search: ...", "Report: ...", "Chat: ...") with that time below;
the current one is
marked. All conversations stand in one list; older ones from before the
store (when files lived in the working folder) still open with their
result list and reports, which the server looks up in that folder. A click
continues a conversation;
the trash icon deletes its file (reports and PDFs stay); **Delete all
conversations** in Settings empties the folder. Switching is refused
while a job runs or the model is answering. The server starts with an
empty conversation; pick one from the list to continue it.

### Answers and questions

The one input box serves two channels, and the code decides which.
**Answering**: the open question's parser reads the text (row numbers,
DOIs, years, `all`, `code`, tweaks). **Asking**: the text is a question
about the step; it never moves the wizard. On steps that only take chips
every typed text is a question (unless it names a chip, or is yes/no);
on text steps a question-like input that the parser does not recognise
("is Unpaywall free?", "how do I go back") goes to the question channel
by itself, with the parser's note first. A leading `?` forces the question
channel. One exception is decided in code, never by the model: a typed
wish to change the keyword blocks or the request ("i want to change the
keywords", "Suchbegriffe anpassen") reopens that question with the earlier
answers kept, once blocks exist and outside the explicit question channel;
the search then runs again with the new blocks.

The helper answers from a fixed help text per step (`src/web/help.ts`:
what the question means, accepted inputs, what the chips do, how to go
back) and a summary of what the dialog knows; the model may tailor that
text to the question (three sentences, 30 s), and without a model, or
when it fails, the fixed text itself is shown and labelled so. Navigation
chips under a help answer come from code: Continue, Edit keyword blocks,
Back, Start over. The helper cannot change the search; what it can do is
explain and link.

### The conversation

The order and wording of the questions are fixed in the code
(`src/web/dialog.ts`); the model only proposes content. Every question
offers answer chips; typing works as well and is read by fixed rules (no
guessing). `back` returns to the previous question, `start over` clears
the conversation (the **+** button keeps it in History instead).

The browser searches first and lets you adjust afterwards: a request
starts the search at once with the defaults (last 10 years, 30 records
per source, no code sources, all journals and authors). The pick question
shows the blocks that were searched; **Keywords & synonyms** reopens them and the
search runs again. The question chain of the pi wizard (code sources,
period, journals, authors, summary) is still there behind **More options**
under the blocks.

| Step | The assistant asks | You answer |
|---|---|---|
| Start | What would you like to do today? | **Search literature**, **Chat about one PDF** or **Synthesis report over several papers** (the PDF ways need a non-empty library). Typing a request counts as the request. |
| Request | What are you looking for? | a sentence or keywords: the model groups its own words into keyword blocks (saved per request text) and the search starts; with the synonym button the blocks with synonyms open for editing first; a block expression such as `(river OR stream) AND (bathymetry)` is searched as typed. Without a model (or when it gives no usable proposal) word-by-word blocks are shown for confirmation first. |
| Keyword blocks (on **Keywords & synonyms**, or shown first without a model) | Is it ok if I split your request into these keyword blocks? | edit the lines (one block per line, alternatives with OR or commas) and confirm (searches at once), add two broader variants, ask the model again, or **More options** |
| More options: papers with code | Do you also want papers with code? | all four code sources (Hugging Face Papers, GitHub README search, awesome lists, Google Earth Engine), none, or some; for the awesome lists the model suggests GitHub topics to tick |
| More options: period | Which publication period? | last 5 / 10 / 20 years, all years, or a typed range such as `2015-2024` |
| More options: journals | These journals publish most on your topic. | all, ticked ones, numbers (`1, 3`) or a name; the list comes from OpenAlex for your blocks and period, ten at a time |
| More options: authors | Authors with the most works on this topic. | all, ticked ones, numbers or a name; three letters or more look anyone up in OpenAlex; a picked author is asked whether their works outside the topic count too |
| More options: summary | Ready. Query, code sources, period, journals, authors, defaults. | **Search**, or change one part; `count 40`, `cites 5`, `code on` / `code off` adjust the defaults (30 records per source, no citation floor) |
| Pick (window over the list) | Which papers do you want as PDFs? | tick cards and press **Download n ticked PDFs**; the window asks what is left to ask (contact email, confirmation) and shows the result |
| Contact | Unpaywall needs a contact email. | asked only while none is configured: type it (save it, or this run only) or continue without Unpaywall |
| Download | Download N papers? (with the folder) | choose the folder, **Download**; restricted and abstract-only papers are listed with browser links, not tried |
| Ask | Ask anything. Responses rely solely on passages retrieved from your sources and include exact citations. | any question (answered only from retrieved passages, with page citations); sources and reports are set in the box's **+** menu (below) |
| Report (typed, or from older conversations) | Which papers, which questions, which report? | papers ticked or the whole library; questions one per line or summaries only; bullet summaries, summaries + answers per paper, cross-paper answers, or the review synthesis |

The paper chat's question box carries its own **+** menu, like the
request box of a search; the question and the answers carry no buttons.
**Sources** (one of three): the whole library; **Folders**, a tick tree
of the library's folders (a ticked folder includes its subfolders); or
**Papers**, a tick list with a find box. **Upload PDF** adds PDFs from
the disk to the library's inbox and makes them the sources. **Write a
report** turns Send into **Build report**, with the kind chosen under the
switch (Summaries, Per paper, Cross-paper, Review): the typed text gives
the report's questions (with the chat's earlier ones), a summaries-only
report needs none, a cross-paper report needs one. The report starts at
once over the chosen sources and the switch turns off again. A pill under
the box always names the sources ("87 PDFs", "01_Water_Body_Mapping_HQ ·
30 PDFs"), a second one the report kind; the × resets either. The page
sends the sources as basenames (`chat.scope`, `chat.scopeLabel`,
`chat.report`); the dialog keeps only basenames the library holds and
falls back to the whole library. A chat opened on one PDF (from the
library, or dropped) has no **+** and stays a plain box; one paper picked
in the menu is a library chat narrowed to it.

A **file card** appears in the chat for every file written on request
(search report or PRISMA diagram from the result list, synthesis
report): its name, kind and folder; a click
opens it large, and the folder button shows the folder in your file
manager. The download shows a folder card for the chosen folder instead,
because it writes PDFs, not a page.

**Drag and drop:** PDFs dragged onto the page (any screen) are copied into
the store's `inbox/` (`POST /api/library/upload`: `%PDF` check, 200 MB
cap, safe name; a PDF the library already holds byte for byte, in any
folder, is not copied again and the existing paper is used), and a chat over exactly these
PDFs opens; their identity is read from the PDF like any hand-saved PDF.

On the results page there is one working line above the list: a follow-up
search (**Add papers with code**, a wider period) takes the place of the
line before it, and progress never moves the page (only a new list starts
at its top). While a job runs, one line shows its dot and the newest progress line
(the same `onWarn` messages the terminal shows), with a Stop button; a
click on the line opens the full log as a dark box (remembered per job).
Esc stops the running job of the open conversation when no window is
open. Several jobs run side by side (at most three; a download, an
index run, the setup check and the embedding pull never twice at once):
every job and model call the dialog starts belongs to its conversation.
**+ New search**, **+ New paper chat** or a History entry during a job
leave it running; the conversation is parked in memory, receives its
outcome, is saved, and History marks it with a pulsing dot until then
(the server sends an SSE `history` event on every change). Stop and Esc
reach only the open conversation's job; deleting a conversation stops
its job; Settings' "Delete all conversations" stops all of them. A
stopped follow-up search (add-on,
search again, edited blocks) returns to the list it started from; a
stopped first search offers **Search again** (same request and options)
and **Edit search** (the request box alone again, the request back in
the box and the **+** options as they were). The
answered opening and request questions leave the thread, and questions
carry no grey hint lines; a page
reopened later still sees the conversation and the last lines of the
running server.

The reports are the files in `lit-search/` and `lit-synthesis/`,
unchanged on disk. Synthesis reports and chat reports are served with
their PDF links rewritten to the server (`/pdf/<file>`), because a browser
page from `http://` may not open `file://` links; the file on disk keeps
its `file://` links for use outside the server.

## Protection

The server binds to the loopback address only. Every request needs the
random token the start command printed: the first visit carries it in the
address, the answer sets an `HttpOnly`, `SameSite=Strict` cookie and
redirects to the clean address. The `Host` header must name the loopback
address (DNS rebinding), API answers are `Cache-Control: no-store`, and
files are served only from the stage folders of the store and from the
PDF library (found by scanning, never built from the request). Folders
are shown in the file manager only when they are one of yours (PDF
folders, the download folder, the store). Another computer on the network reaches nothing.

## Settings and keys

The Settings dialog writes `~/.config/pi-literature-review/config.json`
(see [Configuration](configuration.md)): **Thinking** (Off / Low /
Medium / High, default Off; applies to every model call of this tool,
inside pi and standalone; above Off a red note warns that hidden reasoning can
exhaust the output budget before any text; the rail's status line names the level), contact email, awesome-list
topics, the `llm` block (shared address and dialect, embedding and
generation split, review model) and the **PDF folders** (add by folder
window or typed path, show, remove -- removing never touches the files);
the store's path is shown with a button. API keys are deliberately not
editable on a page; the table shows only whether each is set.

## Not on the page

- A model's reasoning is never shown; prose arrives when the engine has
  validated its citations.
- The report option "answer in the chat only" of the terminal wizard has
  no counterpart: the HTML report is the output here.
- The per-run network view is reached from the report's own Network
  column (one graph per paper), as in the terminal path.
- Author position (first / contributing) and the full set of per-source
  record presets stay in the terminal wizard; the chat offers `count N`.
- Two browser tabs share one conversation (the server keeps it).
- Synthesis reports started from the chat follow the language of your
  questions (German or English, prose and page headings alike), as the
  terminal wizard follows the chat language; the chat's own questions
  and buttons stay English.
