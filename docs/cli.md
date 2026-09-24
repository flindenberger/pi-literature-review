# Command line (no Pi)

The same engines run standalone with plain Node from the package folder. This is
useful for scripting, testing and for machines without Pi. The output
folders (`lit-search/`, `lit-selection/`, `lit-synthesis/`) land in the
working directory; `PI_LITERATURE_REVIEW_HOME` overrides that.

## Search
Navigate to your extension folder and type:

```
node src/cli.ts "<query>" [-n PER_SOURCE] [-s SOURCES] [-g "a,b;c,d"]
       [--min-cites N] [--year-from YYYY] [--year-to YYYY] [--venues "a,b"]
       [--require-pdf] [--verified-only] [--sort cites|year] [--html [FILE]] [--no-enrich]
       [--variant "..." (repeatable)] [--digest] [--code SOURCES]
       [--author "Name" (repeatable)] [--author-id A... (repeatable)] [--author-position first|contributing|any] [--author-scope query|all]
```

| Flag | Meaning |
|---|---|
| `-n` | number of papers (default 5, maximum 50) |
| `-s` | comma list of `arxiv`, `crossref`, `openalex`, `semanticscholar` (default all; `semanticscholar` only with an API key) |
| `-g` | the concept blocks: groups separated by `;`, terms by `,` (`"river,fluvial;sandbar,bar;sentinel,s-1,s-2"`), or the AND/OR expression form |
| `--variant` | an additional query for the same need; results are deduplicated across variants and labeled Q1, Q2, ... |
| `--html` | without FILE writes `lit-search/<date>_<query>.html` plus the JSON sidecar; with FILE, that path. Without `--html` the JSON payload prints to stdout |
| `--digest` | prints the agent-facing digest instead of the JSON |
| `--code` | comma list of code-first sources (`hf-papers`, `github-readme`, `awesome-lists`, `gee-github`): repositories are searched first and the papers they cite resolved at arXiv / OpenAlex; adds up to ~40 s. `awesome-lists` reads the topics of [`codeListTopics`](configuration.md#keys-and-contact-data) (no model proposal on the command line) |
| `--author "Name"` | papers by this author (repeatable): the name goes into each source's author field and a post-filter keeps only records naming it; paired with `--author-id`, OpenAlex filters by the exact person |
| `--author-id A...` | OpenAlex author id for the `--author` in the same position (repeatable) |
| `--author-position first\|contributing\|any` | required position of the picked author (default any); a post-filter over the first name of each record's author list |
| `--author-scope query\|all` | `all` = every publication of the picked authors regardless of the query (Semantic Scholar is skipped and noted); default `query` = author AND query |

Example -- the release acceptance query:

```
node src/cli.ts "Satellite and Field Data Fusion for Rivers" -n 5 \
  -s arxiv,crossref,openalex -g "river,fluvial;sandbar,bar;sentinel,s-1,s-2" --html --digest
```

## Selection

```
node src/cli.ts selection <DOI-or-arXiv-ID> [more ...]
```

Downloads legal open-access PDFs into `lit-selection/`. Set
`PI_LITERATURE_REVIEW_MAILTO` for Unpaywall.

## Synthesis

```
node src/cli.ts synthesis "<question>" [--paper <file.pdf>] [--session ID] [--model M]
       [--embed-model E] [--top-k N] [--language L] [--reindex] [--digest]
node src/cli.ts synthesis --report [--papers "a.pdf,b.pdf" | --all | --paper X]
       [--questions "q1;q2"] [--summary bullets|prose] [--detail-mode per-paper|cross-paper]
       [--review] [--language L] [--ui-language de|en] [--html [FILE]] [--digest]
node src/cli.ts synthesis --session-report [--paper <file.pdf>] ["<focus>"] [--session ID] [--html [FILE]]
```

**Sessions.** The CLI shares Pi's session scoping. Without `--session` it
uses the most recently WRITTEN Pi session of the current folder (from
`~/.pi/agent/sessions/`), so a `synthesis` call right after a Pi chat
picks up that session's sticky scope. `--session <uuid>` targets an older
one. With no session at all, pass the scope explicitly.

**Models.** Generation in the CLI runs on `llm.chatModel` /
`llm.generateModel` -- there is no Pi model to fall back to.

## Maintenance

```
node src/cli.ts llm-check              # resolved config path, embed + generate round trip
node src/cli.ts extract <file.pdf>     # pages, usability gate and chunking of one PDF
node src/cli.ts index [--reindex]      # match lit-selection/ against saved searches, update the embedding index
```
