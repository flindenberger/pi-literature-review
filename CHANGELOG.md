# Changelog

All notable changes to this package are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Web interface: a question channel beside the wizard answers, decided
  by code behind one plain input box: typed text on a chip-only step, a
  question-like text the step's parser does not recognise, or a leading
  `?` goes to a helper that answers from a fixed per-step help text, tailored by the model when one is available, with navigation
  chips from code (Continue, Edit keyword blocks, Back, Start over). A
  question-like input that a step's parser does not recognise goes to the
  helper instead of a bare "I did not recognise".
- Web interface start screen: four lines that build up once per browser
  session (the last one typed in two colours), two tiles with what each
  stage does, an info button for sources and data flow; every page load
  and the package name return to it. The chat's accent colour is now a
  near-black instead of blue (hover, selection, primary buttons). Rail: two stages -- SEARCH & SELECT,
  SUMMARIZE & SYNTHESIZE -- each with its own **+** (New search, New paper chat) that
  starts a new conversation at that stage and keeps the current one in a
  collapsible **History** list. Conversations are
  saved as one JSON file each next to the configuration file
  (`~/.config/pi-literature-review/history/`, `PI_LITERATURE_REVIEW_HISTORY`
  overrides), survive server and pi restarts, are named after the request
  or question with the start time below, grouped by data folder, the
  current one marked; a click continues one, the trash icon deletes one,
  Settings can delete all. A local model
  or embedding server that is not running shows a red dot with a hint
  (the server probes 127.0.0.1 addresses). The folder path became a
  folder icon that opens the data folder in the file manager, Settings a
  gear icon; the Start
  over and Stop buttons are gone (typed `start over` still works; the
  server stops from pi or with Ctrl-C).

- Web interface: `/pi-literature-review` starts a local server inside Pi
  (127.0.0.1, token cookie) and opens a chat in the browser that walks
  through the three stages -- the request split into keyword blocks
  (proposed by the model, confirmed or edited by you), papers with code,
  period, journals and authors from OpenAlex, then the search; papers
  ticked in the report or named by row number, the legal PDF download;
  questions over the PDFs with page citations and the synthesis report.
  The question order and wording are fixed in code; the model only
  proposes content. Reports open in a panel beside the chat (enlarge,
  new tab, close), file cards name every written HTML file with a button
  that shows the folder in the file manager, and the rail lists all
  HTML reports and the PDF library. Progress streams over Server-Sent
  Events; the model is the one selected in Pi. `node src/cli.ts web`
  runs the same interface without Pi on the configured backend.
  Documentation in `docs/web.md`.
- `renderSynthReportHtml` and `renderPaperChatReportHtml` accept a
  `pdfHref` link builder; `webPdfHref` builds server links.

### Changed

- Two stages instead of three: "Search and selection" and "Summary and
  synthesis". `/lit-search` asks after its results which papers to
  download (the copied report line, row numbers, identifiers, `all`,
  `code`; empty or Esc = later) and runs the download in the same dialog;
  the per-paper report lists the papers to open in the browser first, and
  says that a PDF saved by hand into a PDF folder is recognised by its
  DOI. `/lit-selection` stays as the side entrance. The report's step 3
  reads "Paste it into Pi".
- Model calls on the Pi model go through Pi's model registry
  (`streamSimple`) instead of the deprecated `pi-ai/compat` entry, so
  request-time credentials, base URL and provider environment apply.

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

[0.1.1]: https://github.com/flindenberger/pi-literature-review/releases/tag/v0.1.1
[0.1.0]: https://github.com/flindenberger/pi-literature-review/releases/tag/v0.1.0
