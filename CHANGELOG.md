# Changelog

All notable changes to this package are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

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
