# Contributing

Thank you for your interest in pi-literature-review. The project has a
single maintainer with limited time, so please expect answers within
days rather than hours. Bug reports, questions and pull requests are
welcome; this page says how to make them useful.

## Asking for help

Open a [GitHub issue](https://github.com/flindenberger/pi-literature-review/issues)
and label it `question`. Before you ask, check the [documentation](docs/) about
requirements, search, selection, synthesis, configuration and the CLI.

## Reporting a bug

Open an issue with:

- the package version (`pi-literature-review` in Pi's `[Extensions]` line
  or `npm ls pi-literature-review`), the Pi version and your operating system;
- the command you ran (`/lit-search`, `/lit-selection`, `/lit-synthesis`
  or the CLI) and, for a search, the query blocks and sources;
- what you expected and what happened, with the console output or the
  error message;
- for search problems, the `lit-search/*.json` file of the run if it is
  not confidential.

Please do not attach paper PDFs: their licenses usually do not allow it.
A DOI or arXiv ID is enough.

## Proposing a change

For anything larger than a typo, open an issue first and describe the
problem you want to solve. This avoids work on changes that cannot be
merged. Two rules are not negotiable:

- **No language model in the citation path.** Titles, authors, years,
  venues, DOIs and abstracts come only from the source APIs and are
  verified by fixed code. A change that lets a model generate, complete
  or "tidy" bibliographic data will not be merged.
- **Open, login-free sources only.** New sources must be usable without
  an account or a paid subscription; an optional free API key is fine.

Pull requests should:

1. Keep the type check and the offline tests green
   (see [docs/development.md](docs/development.md)); the CI runs them on
   every pull request.
2. Add or adjust a test next to the module you change
   (`src/<name>.test.ts`), standalone and offline.
3. Keep the documentation in `docs/` and the README in sync with the code.
4. Use plain English in code comments and docs, without emojis. Comments
   describe what the code does, not the history of the change.
5. Say in the pull request whether an AI coding tool helped write the
   change. That is welcome but a human remains responsible for testing it.

## Forks

Forks for another research field or another agent are welcome. Please
keep the license notice, link back to this repository and cite it
(see [CITATION.cff](CITATION.cff)).

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE) of this project.
