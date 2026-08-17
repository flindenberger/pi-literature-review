# Development and tests

## Layout

```
index.ts            single extension entry: registers the three tools in pipeline order
extensions/         Pi adapters -- search.ts, selection.ts, synthesis.ts (one tool + command each),
                    dialogs.ts (the tabbed wizard overlay + RPC fallback), pi-model.ts (one call on the Pi model)
src/                the engines, Pi-free: search pipeline, render, network graph, selection,
                    synthesis (extract, retrieve, protocol, citation gate), dialog reducer, config, CLI
src/sources/        the four source clients (arxiv, crossref, openalex, semanticscholar)
docs/               this documentation, screenshots under docs/img/
```

Adapters (`extensions/`) hold everything that touches Pi: tool schemas,
dialogs, widgets, message rendering. Engines (`src/`) are pure and testable
without Pi; the CLI drives them directly. Tests sit next to their modules
(`src/<name>.test.ts`, `src/sources/<name>.test.ts`) and use only Node's
built-in `assert`.

## Running from a checkout

```
npm install            # add --no-bin-links on filesystems without symlinks (exFAT)
pi install /absolute/path/to/pi-literature-review
```

Pi's extension loader provides `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui` and `typebox` at runtime (they are declared as
optional peer dependencies and not installed by npm). Restart Pi after
code changes -- `/reload` is not guaranteed for package extensions.

## Tests

```
for f in src/*.test.ts src/sources/*.test.ts; do node "$f" || echo "FAIL $f"; done
node -e "import('./index.ts').then(() => console.log('index loads'))"
```

Every test file is standalone and offline (network clients are exercised
against captured fixtures and stubbed `fetch`). The second line is the
smoke check that the extension entry loads with the peers present.

## Release acceptance gate

Before any release the ground-truth query must pass end to end:

```
node src/cli.ts "sandbar detection rivers Sentinel-1 Sentinel-2" -n 5 -s arxiv,crossref,openalex
```

DOIs `10.3390/rs13081505` and `10.3390/rs18010132` must appear with
`verified: true`, known junk records (empty titles, off-topic keyword
matches) must be dropped with reasons, and a fabricated DOI must come out
`verified: false`.

## Conventions

- No language model in the citation path -- ever. A model may shape a
  query or write prose over numbered excerpts; fixed code inserts and
  validates every citation.
- Gates, validation and state live in code, not in instructions to the
  agent; every stage also has an agent-free slash command.
- Third-party behaviour (Pi's TUI, pdf.js, the source APIs) is proven
  against the code or service that actually runs, never assumed.
- Plain, emoji-free output everywhere.
