# Selection (`/lit-selection`, tool `pi-literature-selection`)

Deterministic PDF retrieval for the records you selected on a search
page. Legal open access only; no model anywhere in the download path.

## Two ways in

- Paste the sentence the results page copied for you
  (`Download these papers: 10.3390/rs13081505, arXiv:2401.16393`).
- Or ask in plain words ("download the three on_target papers"). The
  agent only transports DOIs / arXiv IDs to the tool.

Either way the tool first shows the identifiers in an editable one-step
dialog (passed identifiers are only the prefill; whitespace, comma and
semicolon separate; the "Download these papers:" prefix is stripped) and
then, BEFORE any network request, a consent dialog listing every
identifier with its title from the saved searches -- titles never come
from the model. Escape cancels the whole run; Escape during a running
download aborts it.

## Resolution

Per identifier a fixed chain, first source with real PDF bytes wins:

1. the record's own `pdf_url` from the saved search;
2. Unpaywall (`api.unpaywall.org`, the legal open-access index by the
   non-profit OurResearch);
3. the arXiv PDF endpoint.

Every download is checked for the `%PDF` magic bytes -- an HTML error page
is never saved as a PDF. No gray sources, ever.

## The report

Honest per paper:

- `downloaded`
- `already in library` (never fetched twice)
- `blocked by publisher` -- some publishers (MDPI, for example) refuse ALL
  automated clients with HTTP 403; the report gives the direct link, which
  opens fine in a browser
- `not freely available -- obtain via authorized access` (with the
  publisher link)
- `invalid identifier`

## Library naming

`lit-selection/<year>_<FirstAuthor>[_et_al]_<Title_words>.pdf`, capped at
80 characters, umlauts transliterated, built only from the saved API
records; when year, author or title is unknown the identifier slug
(`10.3390_rs13081505`) is used instead.

## The Unpaywall email

Unpaywall's usage policy requires a contact email (sent only to
api.unpaywall.org). While none is configured, the dialog explains this and
offers: enter it for this run only, enter and save it to the config file
(`~/.config/pi-literature-review/config.json`, mode 0600), or continue
without Unpaywall (asked again next time -- "skip" is deliberately not
remembered). `PI_LITERATURE_REVIEW_MAILTO` overrides everything; use it for
headless runs. Without an email, downloads still work via record links and
arXiv.

## Command line

```
node src/cli.ts selection 10.3390/rs13081505 arXiv:2401.16393
```
