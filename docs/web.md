# Web interface

The three stages as a chat in your browser, served by a small local
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

Left, a slim rail: a **+** button (new conversation; the current one moves
to History), the three stages as a progress indicator, three collapsed
lists (**History** with the saved conversations, see below; **HTML reports** from
`lit-search/` and `lit-synthesis/`; **PDF library** with every PDF in
`lit-selection/` and the working folder, rescanned when opened; a click
opens the file in the panel), the model in use (a local model or embedding
server that is not running shows a red dot: the server probes 127.0.0.1
addresses on every state read), a folder icon that opens the data folder
in the file manager (tooltip: its path), and a gear icon for Settings. The server is stopped from
pi (`/pi-literature-review stop`) or with Ctrl-C. In the middle, the conversation with
one input box. On the right, the report panel: it opens when a search or a
synthesis has written an HTML file, **Enlarge** shows it large over the
page (Esc closes), **New tab** opens the file on its own, **Close** hides
the panel (any file card in the chat brings it back).

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
change first, named after the request or question ("Search: ...",
"Report: ...", "Chat: ...") with the start time below; the current one is
marked. Conversations of this data folder come first, those of other data
folders sit under "other data folders" (their reports and PDFs are there,
the page says so when you open one). A click continues a conversation;
the trash icon deletes its file (reports and PDFs stay); **Delete all
conversations** in Settings empties the folder. Switching is refused
while a job runs or the model is answering. The server starts with an
empty conversation; pick one from the list to continue it.

### The conversation

The order and wording of the questions are fixed in the code
(`src/web/dialog.ts`); the model only proposes content. Every question
offers answer chips; typing works as well and is read by fixed rules (no
guessing). `back` returns to the previous question, `start over` clears
the conversation (the **+** button keeps it in History instead).

| Step | The assistant asks | You answer |
|---|---|---|
| Start | What would you like to do today? | **Search literature**, **Chat about one PDF** or **Synthesis report over several papers** (the PDF ways need a non-empty library). Typing a request counts as "search". |
| Request | What are you looking for? | a sentence or keywords; a block expression such as `(river OR stream) AND (bathymetry)` is taken as is |
| Keyword blocks | Is it ok if I split your request into these keyword blocks? | edit the lines (one block per line, alternatives with OR or commas), confirm, add two broader variants, or ask the model again. Without a model the blocks are derived word by word and the chat says so. |
| Papers with code | Do you also want papers with code? | all four code sources (Hugging Face Papers, GitHub README search, awesome lists, Google Earth Engine), none, or some; for the awesome lists the GitHub topics follow (suggested by the model plus the stored ones, with list counts; type a word to add one) |
| Period | Which publication period? | last 5 / 10 / 20 years, all years, or a typed range such as `2015-2024` |
| Journals | These journals publish most on your topic. | all, ticked ones, numbers (`1, 3`) or a name; the list comes from OpenAlex for your blocks and period, ten at a time |
| Authors | Authors with the most works on this topic. | all, ticked ones, numbers or a name; three letters or more look anyone up in OpenAlex; a picked author is asked whether their works outside the topic count too |
| Summary | Ready. Query, code sources, period, journals, authors, defaults. | **Search**, or change one part; `count 30`, `cites 5`, `code on` / `code off` adjust the defaults (15 records per source and query, all key-free sources) |
| Pick | Which papers do you want as PDFs? | tick them in the report on the right, type row numbers of the results table, DOIs or arXiv ids; `all` = every on-target paper, `code` = every paper with a code or data link; or skip to the library chat |
| Contact | Unpaywall needs a contact email. | asked only while none is configured: type it (save it, or this run only) or continue without Unpaywall |
| Download | Download N papers into `lit-selection/`? | **Download**; restricted and abstract-only papers are listed with browser links, not tried |
| Ask | Ask your question about the PDFs. | any question (answered only from retrieved passages, with page citations), **Build a report**, or change the scope (one paper / whole library) |
| Report | Which papers, which questions, which report? | papers ticked or the whole library; questions one per line or summaries only; bullet summaries, summaries + answers per paper, cross-paper answers, or the review synthesis |

A **file card** appears in the chat for every HTML file a stage wrote
(search report, synthesis report): its name, kind and folder; a click
opens it large, and the folder button shows the folder in your file
manager. The download shows a folder card for `lit-selection/` instead,
because it writes PDFs and metadata twins, not a page.

While a job runs, its progress lines (the same `onWarn` messages the
terminal shows) appear in a dark box in the chat with a Stop button; the
box collapses when the job is done. One job runs at a time; a page
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
files are served only from the three stage folders and the PDF library
by checked basename. Another computer on the network reaches nothing.

## Settings and keys

The Settings dialog writes `~/.config/pi-literature-review/config.json`
(see [Configuration](configuration.md)): contact email, awesome-list
topics and the `llm` block (shared address and dialect, embedding and
generation split, review model). API keys are deliberately not editable
on a page; the table shows only whether each is set.

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
