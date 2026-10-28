# Changelog

All notable changes to this package are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
