# Changelog

All notable changes to this package are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- PRISMA diagram viewer in the browser loads only diagram files from its
  own server; other addresses in the link are ignored.
- Typed number lists ("1, 3, 7") are parsed without slowing down on very
  long input.
- A library PDF whose first page prints an older Elsevier DOI with
  parentheses (e.g. `10.1016/S0022-1694(03)00129-X`) was matched to the
  wrong paper: the DOI was cut at the first parenthesis. The whole DOI is
  read now, and a looked-up record is accepted only when its title is
  printed on the PDF's first pages.
- The start page no longer shows an empty input box for a moment while
  the page loads.

### Changed

- Browser interface and live demo on phones: one column, the rail is a
  drawer behind a menu button, closed at start; no sideways scrolling.
- Data and code archive lookup at CrossRef asks for 100 DOIs per request
  instead of 40: a search with 200 records spends about 8 s there instead
  of about 19 s.
- Gallery image on pi.dev is a static PNG (`docs/img/gallery.png`).

## [0.2.0] - 2026-11-09

### Added

- Browser interface: `/pi-literature-review` in Pi, or without Pi
  `npx pi-literature-review web` (new `bin` entry, Node.js 22.19 or newer).
  A local server on 127.0.0.1 with an access key; two stages in the rail,
  Search & select and Summarize & synthesize, each with its own history of
  saved conversations (one JSON file each next to the configuration file).
  Documented in `docs/web.md`.
- Search & select in the browser: the request starts the search at once
  (keyword blocks from the request's own words, saved per request so a
  repeated search is the same search); results as cards with instant
  filters (period, access, type, citations, code, data, journal, author,
  source) and sort; a "+" menu for synonyms, papers with code, period,
  records per source, minimum citations, journals and authors; search
  report and PRISMA diagram written on click from the filtered list;
  citation graph per card; an author window (works, citations, h-index,
  topics, current institution from ORCID).
- Author search: narrow a topic to chosen authors, or list all their work
  (empty request), optionally as first author only.
- Summarize & synthesize in the browser: chat over one paper, chosen papers
  or folders, or the whole library; answers cite passages by paper letter
  and number (A1, B2) with a hover card; the browser's own PDF viewer opens
  at the cited page and highlights the passage in every browser. One
  report per chat (summary per paper and/or synthesis across papers) that
  reuses the chat's answers; three report layouts (column, contents,
  compare).
- PDF library from your own folders (read recursively, never written to),
  drag and drop or an upload button for single PDFs, background indexing,
  a paper info window (citations per year, venue, access, abstract).
- Settings in the browser: models per role (chat, report writing,
  embeddings) with their own thinking level, model lists from the running
  server, API keys, PDF folders, saved data. Inside Pi the browser can use
  its own Pi model without changing the terminal's.
- Optional OpenAlex API key (`openAlexApiKey`,
  `PI_LITERATURE_REVIEW_OPENALEX_API_KEY`): OpenAlex now meters requests,
  and without a key every machine behind one IP address shares one small
  daily budget. The key goes as a bearer header, never in a URL.
- Code and data links from DataCite (Zenodo and other DataCite DOIs)
  besides CrossRef.
- Live demo of the browser interface on GitHub Pages: search runs for real
  in the visitor's browser, the paper chat replays one recorded example.

### Changed

- Two stages instead of three: "Search and selection" and "Summary and
  synthesis". `/lit-search` asks after its results which papers to
  download (the copied report line, row numbers, identifiers, `all`,
  `code`; empty or Esc = later) and downloads in the same dialog.
  `/lit-selection` stays as a side entrance.
- Where files live: search results and reports go to one store, the
  folder of the configuration file (`~/.config/pi-literature-review/`;
  `PI_LITERATURE_REVIEW_HOME` moves it, `.` restores the per-project
  layout). Downloads ask for a folder on every run. Older folders in
  working directories are left in place and their PDFs are still read.
- Thinking is off by default and set per role (`thinking`,
  `generateThinking`), independent of Pi's own level.
- Model calls on the Pi model go through Pi's model registry
  (`streamSimple`) instead of the deprecated `pi-ai/compat` entry.
- Reports and the citation graph use one near-black accent; the PRISMA
  diagram follows the PRISMA 2020 phase layout.
- Documentation rewritten in a compact reference style.

### Fixed

- OpenAlex removed the work type "grant" and answered every request that
  excluded it with HTTP 400, so every OpenAlex search failed in 0.1.1.
- Picked authors no longer drop their own papers when OpenAlex writes the
  name with a middle initial.
- The `/lit-search` download question skips papers already in the library
  for `all` and `code`.

## [0.1.1] - 2026-09-28

### Added

- Gallery preview image (`pi.image`) for the Pi package gallery.
- `CONTRIBUTING.md` and `SECURITY.md`; the README's Contributing section
  links to them.

### Fixed

- README images now load on pi.dev: they are referenced by absolute
  repository URLs, since `docs/img/` is not part of the npm package.

### Changed

- Republished so that the npm search index picks the package up; version
  0.1.0 stayed unindexed and therefore missing from the gallery list.

## [0.1.0] - 2026-09-24

First public release: three tools for a local, login-free literature review
in the Pi coding agent.

### Added

- `/lit-search`: block search over arXiv, CrossRef and OpenAlex (Semantic
  Scholar with a free API key), query variants suggested by the model,
  journal and author pickers, optional code-first sources. Every DOI and
  arXiv ID is verified over HTTP. Sortable HTML results page with BibTeX,
  open-access markers, code and data links, citation graph and a
  PRISMA-2020-style flow diagram.
- `/lit-selection`: downloads of the ticked papers through legal
  open-access routes only (record link, OpenAlex, Unpaywall, publisher page
  behind a robots.txt check, arXiv), with an honest per-paper report.
- `/lit-synthesis`: grounded chat and HTML reports over local PDFs with
  page-exact citations that open the PDF at the highlighted passage;
  per-paper summaries, detail questions and an optional review synthesis.
- Command line for all three stages without Pi.

[Unreleased]: https://github.com/flindenberger/pi-literature-review/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/flindenberger/pi-literature-review/releases/tag/v0.2.0
[0.1.1]: https://github.com/flindenberger/pi-literature-review/releases/tag/v0.1.1
[0.1.0]: https://github.com/flindenberger/pi-literature-review/releases/tag/v0.1.0
