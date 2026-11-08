# Selection (`/lit-selection`, tool `pi-literature-selection`)

Downloads the papers you picked as PDFs. Legal open access only; no model in the download path.

The download is the second part of the stage "Search & select": `/lit-search` asks for the papers right after its results ([Search](search.md#download-the-second-part-of-the-stage)). `/lit-selection` is the side entrance: a later download, identifier lists from elsewhere, the agent.

## Ways in

| Way | Input |
|---|---|
| Download question of `/lit-search` | Copied line, row numbers, identifiers, `all`, `code` |
| `/lit-selection` | Identifiers or the copied line `Download these papers: 10.3390/rs13081505, arXiv:2401.16393` |
| Agent (tool) | Plain words ("download the three on_target papers"); the agent only passes DOIs and arXiv IDs |

## Dialogs

Before any network request, in this order:

1. **Identifiers** (`/lit-selection` and the tool, not the `/lit-search` question): editable; passed identifiers are only the prefill. Separated by whitespace, comma or semicolon; the prefix `Download these papers:` is stripped.
2. **Unpaywall email**, only while none is configured (see [Contact email](#contact-email)).
3. **Download folder** (see [Download folder](#download-folder)).
4. **Consent:** every identifier with its title from the saved searches (never from the model), the folder and the sources.

- Esc cancels the run. Esc during a download stops it; saved PDFs stay.
- Headless tool calls skip the dialogs.

## Resolution

Access level first: from the saved search (results and dropped table), else looked up live at OpenAlex. Without an arXiv ID, two levels are reported without a download attempt:

- `restricted` (not open access): DOI link to open in the browser
- `abstract only` (OpenAlex type `conference-abstract`): no paper PDF exists

Every other identifier runs a fixed chain. Each step is asked only when the earlier ones failed; the first real PDF wins.

| Step | Source |
|---|---|
| 1 | The record's own `pdf_url` from the saved search |
| 2 | Every open-access PDF location OpenAlex lists, in OpenAlex's order |
| 3 | Unpaywall (`api.unpaywall.org`); needs a contact email |
| 4 | Article page: the DOI is resolved and the page's `citation_pdf_url` meta tag read, only where `robots.txt` allows it (RFC 9309, product token `pi-literature-review`, else `*`; unreachable robots.txt = no). A 403 is never worked around. |
| 5 | The arXiv PDF endpoint |

- Every download is checked for the `%PDF` magic bytes; an HTML error page is never saved.
- 30 s timeout per request, 300 ms pause between papers.
- No grey sources.

## Report

One line per paper, with the detail below it:

| Status | Meaning |
|---|---|
| `downloaded` | Saved; the detail names the source step |
| `already in library` | Found in the download folder or anywhere in the library; not fetched again |
| `free, open in browser` | Open access, but the publisher refuses automated clients (HTTP 403) or no link returned a PDF. The link opens in a browser. |
| `restricted` | Not open access, not tried; DOI link |
| `abstract only` | Conference abstract, no PDF exists |
| `not freely available` | No free source to try; detail: "obtain via authorized access" with the DOI link |
| `no working free link` | Free links tried, none returned a PDF; detail with the number tried and the DOI link |
| `invalid identifier` | Not a DOI or arXiv ID |

- Below the lines, one list of every paper to open in the browser: free first, then restricted, then the rest with a link.
- A PDF saved by hand into the download folder or any PDF folder is recognised by the DOI or arXiv ID printed in it ([Synthesis -> Adoption](synthesis.md#adoption)).

## Download folder

Asked on every interactive run:

| Choice | Note |
|---|---|
| Last download folder | Listed first; one Enter keeps it |
| A folder the agent passed (`folder`) | Offered, never used without your choice |
| Your other PDF folders | From `pdfFolders` |
| Folder window | zenity or kdialog on Linux, the macOS and Windows dialogs; only with a desktop |
| Typed path | Full path, `~` = home folder; created when missing |

- The chosen folder is remembered (`lastDownloadDir`) and becomes a PDF folder.
- Only the PDF lands there. Its metadata twin goes to the store (`meta/`).
- Without a dialog (headless, CLI): the last download folder, else `lit-selection/` in the store.
- Locations: [Configuration -> Where files live](configuration.md#where-files-live).

## File names

`<year>_<FirstAuthor>[_et_al]_<Title_words>.pdf`

- At most 80 characters, umlauts transliterated, built only from the saved API records.
- Year, author or title unknown: the identifier slug (`10.3390_rs13081505`).

## Contact email

Unpaywall's usage policy requires a contact email. Once set, it goes with the package's API requests:

| Where | Recipients |
|---|---|
| User-Agent header | Scholarly APIs, code sources and download servers, except DataCite and ORCID |
| `mailto` URL parameter | CrossRef, OpenAlex |
| `email` URL parameter | Unpaywall |

- In a browser (live demo) no User-Agent header is sent.
- While none is configured, the dialog offers: enter it for this run only; enter and save it to `config.json` (mode 0600); continue without Unpaywall (asked again next time).
- `PI_LITERATURE_REVIEW_MAILTO` overrides the config; use it for headless runs.
- Without an email, downloads still work via record links, OpenAlex locations, article pages and arXiv.

## Tool parameters

| Parameter | Meaning |
|---|---|
| `identifiers` | DOIs and arXiv IDs, at least one (prefill of the identifier dialog) |
| `folder` | Full path of a folder the user named; only offered in the folder dialog |

Command line: [CLI -> Selection](cli.md#selection). Code: [Development -> Module map](development.md#module-map).
