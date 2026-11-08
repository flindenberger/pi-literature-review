# Command line (no Pi)

The stage engines run standalone with Node.js 22.19 or newer. No Pi, no agent model in the loop.

## Invocation

| Way | Command |
|---|---|
| npm, no install | `npx pi-literature-review <subcommand> [flags]` |
| npm, global install | `npm install -g pi-literature-review`, then `pi-literature-review <subcommand> [flags]` |
| Checkout (package folder) | `node src/cli.ts <subcommand> [flags]` |

- All three forms take the same arguments. The examples below use `node src/cli.ts`.
- Results go to stdout, warnings and progress to stderr.
- Invalid arguments print the usage and exit with code 2.

## Subcommands

| Subcommand | Purpose |
|---|---|
| *(none)* `"<query>"` | Search |
| `web` | Browser interface without Pi |
| `selection` (alias `fetch`) | Download open-access PDFs |
| `synthesis` | Grounded answer, report or session report |
| `index` | Match the library, build the embedding index |
| `extract` | Show what the PDF-to-text step sees for one PDF |
| `llm-check` | Print the config path, round-trip both models |

## Where files go

- **Store:** the config folder, `~/.config/pi-literature-review/` (Windows: `%APPDATA%\pi-literature-review\`), see [Configuration](configuration.md#where-files-live)
- **`PI_LITERATURE_REVIEW_HOME`:** moves the store; `.` = the working directory
- **Search runs:** `<store>/lit-search/`
- **Reports, protocols, index:** `<store>/lit-synthesis/`
- **PDFs:** read from your PDF folders; downloads go to the last download folder, else `<store>/lit-selection/`

## Search

```
node src/cli.ts "<query>" [-n PER_SOURCE] [-s SOURCES] [-g "a,b;c,d"]
       [--min-cites N] [--year-from YYYY] [--year-to YYYY] [--venues "a,b"]
       [--require-pdf] [--verified-only] [--sort cites|year] [--html [FILE]] [--no-enrich]
       [--variant "..." (repeatable)] [--digest] [--code SOURCES]
       [--author "Name" (repeatable)] [--author-id A... (repeatable)]
       [--author-position first|contributing|any] [--author-scope query|all]
```

| Flag | Meaning |
|---|---|
| `-n`, `--per-source N` | Results per source. Default 5, maximum 50. |
| `-s`, `--sources LIST` | Comma list of `arxiv`, `crossref`, `openalex`, `semanticscholar`. Default all. `semanticscholar` only with an API key. |
| `-g`, `--group-terms SPEC` | Concept blocks: blocks separated by `;`, terms by `,` (`"river,fluvial;sandbar,bar"`), or an AND/OR expression |
| `--variant "..."` | Additional query for the same need. Results are deduplicated across variants and labelled Q1, Q2, ... |
| `--min-cites N` | Minimum citation count |
| `--year-from`, `--year-to` | Publication year range |
| `--venues "a,b"` | Keep records whose venue contains one of the names |
| `--require-pdf` | Keep records with a PDF link only |
| `--verified-only` | Keep records with a verified DOI or arXiv ID only |
| `--sort cites\|year` | Sort order of the results |
| `--no-enrich` | Skip the enrichment step (abstracts, citations, access, code/data links) |
| `--html [FILE]` | Write the HTML report, its JSON copy and `network.html`. Without FILE: `<store>/lit-search/<date>_<query>.html`. |
| `--digest` | Print the agent-facing digest instead of the JSON payload |
| `--code LIST` | Code-first sources: `hf-papers`, `github-readme`, `awesome-lists`, `gee-github`. Repositories are searched first, the papers they cite resolved at arXiv and OpenAlex. Adds up to ~40 s. `awesome-lists` reads the topics of [`codeListTopics`](configuration.md#keys-and-contact-data). |
| `--author "Name"` | Papers by this author (repeatable). Goes into each source's author field; a post-filter keeps records naming the author. |
| `--author-id A...` | OpenAlex author ID for the `--author` in the same position (repeatable). OpenAlex then filters by the exact person. |
| `--author-position first\|contributing\|any` | Required position of the picked author. Default `any`. |
| `--author-scope query\|all` | `query` (default) = author AND query. `all` = every work of the picked authors; Semantic Scholar is skipped. |

- Without `--html` the JSON payload goes to stdout.
- `--author-id`, `--author-position` and `--author-scope` need `--author`.

Example:

```
node src/cli.ts "Satellite and Field Data Fusion for Rivers" -n 5 \
  -s arxiv,crossref,openalex -g "river,fluvial;sandbar,bar;sentinel,s-1,s-2" --html --digest
```

## Web interface

```
npx pi-literature-review web [--port N] [--no-open] [--root DIR]
```

| Flag | Meaning |
|---|---|
| `--port N` | Port on 127.0.0.1. Default: a free port. |
| `--no-open` | Do not open the browser; the address is printed to stderr |
| `--root DIR` | Store folder for this run (sets `PI_LITERATURE_REVIEW_HOME`) |

- The address carries an access token (`?token=...`); see [Web interface](web.md#protection).
- **LLM:** `llm.chatModel` on its own `llm.chatBaseUrl` / `llm.chatApi`; without `chatModel`, `llm.generateModel`
- **Generation (synthesis sections):** `llm.generateModel`
- **Embeddings:** `llm.embedModel`
- PDFs are indexed in the background.
- Ctrl+C stops the server.

Details: [Web interface](web.md#start-without-pi), [Configuration](configuration.md#models-and-backends).

## Selection

```
node src/cli.ts selection <DOI-or-arXiv-ID> [more ...]
```

- Identifiers as separate arguments or comma-separated
- Downloads legal open-access PDFs into the last download folder, else `<store>/lit-selection/`
- Papers already in the library are not downloaded again.
- Unpaywall needs a contact email: `PI_LITERATURE_REVIEW_MAILTO` or the configured one

## Synthesis

```
node src/cli.ts synthesis "<question>" [--paper <file.pdf>] [--session ID] [--model M]
       [--embed-model E] [--top-k N] [--language L] [--reindex] [--digest]
node src/cli.ts synthesis --report [--papers "a.pdf,b.pdf" | --all | --paper X]
       [--questions "q1;q2"] [--summary bullets|prose] [--detail-mode per-paper|cross-paper]
       [--review] [--session ID] [--model M] [--embed-model E] [--top-k N] [--language L]
       [--ui-language de|en] [--reindex] [--html [FILE]] [--digest]
node src/cli.ts synthesis --session-report [--paper <file.pdf>] ["<focus>"] [--session ID]
       [--html [FILE]] [--digest]
```

| Mode | Output |
|---|---|
| `"<question>"` | One grounded answer about one paper, printed to stdout. Recorded in `<store>/lit-synthesis/protocols/`. |
| `--report` | Composable report: summaries, detail questions, optional review. Writes `<store>/lit-synthesis/<date>_synthesis_report_<authors>.html` and its JSON copy. |
| `--session-report` | Grounded summary of one Pi session's chat rounds |

| Flag | Meaning |
|---|---|
| `--paper X` | One paper (file name in the library) |
| `--papers "a.pdf,b.pdf"` | Report scope: these papers |
| `--all` | Report scope: the whole library |
| `--questions "q1;q2"` | Report questions, separated by `;` |
| `--summary bullets\|prose` | Add per-paper summaries in this form |
| `--detail-mode per-paper\|cross-paper` | Answer each question per paper (default) or once over all papers |
| `--review` | Add the review synthesis |
| `--session ID` | Pi session to scope to |
| `--model M` | LLM for this run |
| `--embed-model E` | Embedding model for this run |
| `--top-k N` | Retrieved passages. Default 8, maximum 20. |
| `--language L` | Language of the generated text |
| `--ui-language de\|en` | Language of the report's fixed labels |
| `--reindex` | Rebuild the embedding index first |
| `--html [FILE]` | Report path. Without FILE: the default name in `<store>/lit-synthesis/`. |
| `--digest` | Print the agent-facing digest |

- **Report scope order:** `--all`, `--papers`, `--paper`, then the session's sticky scope. No scope = exit with usage.
- **Sessions:** without `--session`, the most recently written Pi session of the working directory (`~/.pi/agent/sessions/`) is used, including its sticky scope.
- **Models:** `--model`, else `llm.chatModel`, else `llm.generateModel`. Cross-paper and review sections use `llm.generateModel`.

## Maintenance

```
node src/cli.ts llm-check              # config path, embed + generate round trip
node src/cli.ts extract <file.pdf>     # pages, usability gate and chunking of one PDF
node src/cli.ts index [--reindex]      # match the library, update the embedding index
```

- **`llm-check`:** exits 1 with the server's message when a model is unreachable
- **`extract`:** exits 1 when the PDF has no usable text layer (likely scanned)
- **`index`:** reads the whole library (PDF folders, inbox, legacy places). Unmatched PDFs get an adoption attempt first (identifier from the PDF text, verified lookup). The index lands in `<store>/lit-synthesis/index/`.
