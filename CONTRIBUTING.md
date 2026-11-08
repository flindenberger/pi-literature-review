# Contributing

Thank you for your interest in pi-literature-review. Bug reports, questions and pull requests are welcome. The project has one maintainer; expect answers within days.

## Questions

- Open a [GitHub issue](https://github.com/flindenberger/pi-literature-review/issues) with the label `question`.
- Check the [documentation](docs/) first: requirements, search, selection, synthesis, web interface, configuration, command line.

## Bug reports

Open an issue with:

- **Versions:** package (`npm ls pi-literature-review` or Pi's `[Extensions]` line), Pi, Node.js, operating system
- **Entry point:** `/lit-search`, `/lit-selection`, `/lit-synthesis`, `/pi-literature-review` (browser from Pi), `npx pi-literature-review web` (browser without Pi) or another CLI subcommand
- **Search problems:** query blocks, sources, and the run's JSON file from `~/.config/pi-literature-review/lit-search/` if not confidential
- **Expected and actual result,** with the console output or error message
- **Browser problems:** browser name and version

Do not attach paper PDFs; their licenses usually forbid it. A DOI or arXiv ID is enough.

## Changes

For anything larger than a typo, open an issue first and describe the problem.

Two rules are not negotiable:

- **No language model in the citation path.** Titles, authors, years, venues, DOIs and abstracts come only from the source APIs and are checked by fixed code. A change that lets a model generate, complete or "tidy" bibliographic data is not merged.
- **Open, login-free sources only.** A new source must work without an account or paid subscription. An optional free API key is fine.

Pull requests:

1. Keep the type check and the offline tests green ([Development](docs/development.md#type-check-and-tests)). CI runs them on every pull request.
2. Add or adjust a test next to the changed module (`src/<name>.test.ts`, standalone, offline).
3. Keep `docs/` and the README in sync with the code.
4. Plain English in comments and docs, no emojis. Comments describe what the code does, not the history of the change.
5. State whether an AI coding tool helped. That is welcome; a human stays responsible for testing.

## Forks

Forks for another research field or another agent are welcome. Keep the license notice, link back to this repository and cite it ([CITATION.cff](CITATION.cff)).

## License

Contributions are licensed under the project's [MIT License](LICENSE).
