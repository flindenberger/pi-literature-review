# Selection (`/lit-selection`, tool `pi-literature-selection`)

Deterministic PDF retrieval for the records you selected on a search
page. Legal open access only; no model anywhere in the download path.

## Two ways in

- Paste the sentence the results page copied for you
  (`Download these papers: 10.3390/rs13081505, arXiv:2401.16393`).
- Or ask in plain words ("download the three on_target papers"). The agent
  only transports DOIs / arXiv IDs to the tool.

Either way the tool shows two dialogs before anything is fetched. First
the identifiers in an editable one-step dialog: passed identifiers are
only the prefill, whitespace, comma and semicolon separate them, and the
"Download these papers:" prefix is stripped. Then, BEFORE any network
request, a consent dialog listing every identifier with its title from the
saved searches -- titles never come from the model.

Escape cancels the whole run; Escape during a running download aborts it.

## Resolution

First the access level: taken from the saved search (the search stamps
every record with its OpenAlex open-access status), else asked live from
OpenAlex for identifiers outside every saved search. Records from the
dropped table count as saved too. Two levels are reported without trying
anything:

- `restricted` (not open access) -- listed with the DOI link to open in the
  browser, e.g. in a university network whose subscription covers it
- `abstract only` (OpenAlex type `conference-abstract`) -- no paper PDF
  exists

Every other identifier runs a fixed chain; the first source with real PDF
bytes wins, and a later step is only asked when the earlier ones failed:

1. the record's own `pdf_url` from the saved search
2. every open-access PDF location OpenAlex lists (publisher, university
   repositories, preprint servers), in OpenAlex's order
3. Unpaywall (`api.unpaywall.org`, the legal open-access index by the
   non-profit OurResearch; needs a contact email)
4. the article page: the DOI is resolved hop by hop and the page's
   `citation_pdf_url` meta tag (the tag publishers set for Google Scholar)
   is read -- only where the site's `robots.txt` allows this tool
   (RFC 9309: product token `pi-literature-review`, else the `*` rules;
   an unreachable robots.txt counts as "no"). A 403 is never worked around.
5. the arXiv PDF endpoint

Every download is checked for the `%PDF` magic bytes, so an HTML error
page is never saved as a PDF. No gray sources, ever.

## The report

Honest per paper:

| Status | Meaning |
|---|---|
| `downloaded` | in the library |
| `already in library` | never fetched twice |
| `free, open in browser` | open access, but no automatic download worked: the publisher refuses automated clients (HTTP 403; MDPI, Elsevier, Wiley, for example) or no link answered with a PDF. The link opens fine in a browser |
| `restricted` | not open access, not tried; DOI link to open in the browser |
| `abstract only` | a conference abstract, no PDF exists |
| `not freely available -- obtain via authorized access` | access unknown and no free copy found; with the publisher link |
| `invalid identifier` | -- |

Below the per-paper lines, one list collects every paper to open in the
browser (free ones first, then restricted, then the rest). Save such a PDF
into `lit-selection/`: `/lit-synthesis` adopts it by the DOI or arXiv ID
printed in the PDF (see [synthesis.md](synthesis.md)).

## Library naming

`lit-selection/<year>_<FirstAuthor>[_et_al]_<Title_words>.pdf`, capped at
80 characters, umlauts transliterated, built only from the saved API
records. When year, author or title is unknown, the identifier slug
(`10.3390_rs13081505`) is used instead.

## The Unpaywall email

Unpaywall's usage policy requires a contact email, sent only to
api.unpaywall.org. While none is configured, the dialog explains this and
offers three ways on:

- enter it for this run only
- enter and save it to the config file
  (`~/.config/pi-literature-review/config.json`, mode 0600)
- continue without Unpaywall -- asked again next time, because "skip" is
  deliberately not remembered

`PI_LITERATURE_REVIEW_MAILTO` overrides everything; use it for headless
runs. Without an email, downloads still work via record links and arXiv.

## Command line

```
node src/cli.ts selection 10.3390/rs13081505 arXiv:2401.16393
```

Where it lives in the code: see [Development -> Module map](development.md#module-map).
