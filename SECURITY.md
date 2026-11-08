# Security policy

Thank you for helping keep pi-literature-review safe. Please report vulnerabilities privately, as described below.

## Supported versions

Only the latest release on npm receives fixes. Older versions are not patched.

## Hosts contacted

| Host | Purpose | Sent |
|---|---|---|
| `export.arxiv.org`, `arxiv.org` | arXiv search, ID check, PDF download | Search terms, arXiv IDs |
| `api.crossref.org` | Search, code/data relations | Search terms, DOIs |
| `api.openalex.org` | Search, enrichment, access status, author and journal lists | Search terms, DOIs, author IDs |
| `api.semanticscholar.org` | Search and abstracts, only with an API key | Search terms, DOIs |
| `api.datacite.org` | Code/data relations of DataCite DOIs | DOIs |
| `doi.org` | DOI check (handle API in the live demo), redirect to the publisher's article page | DOIs |
| `api.unpaywall.org` | Open-access PDF location | DOIs, contact email |
| Publishers' and repositories' pages | Article page (`robots.txt` respected), PDF download | Request for the page or PDF |
| `pub.orcid.org` | Author window in the browser: current employment | ORCID iD or DOI |
| `huggingface.co` | Code search: Hugging Face Papers | Search terms |
| `api.github.com`, `raw.githubusercontent.com` | Code search: repositories, READMEs | Search terms, repository names |
| `awesome.ecosyste.ms`, `repos.ecosyste.ms` | Code search: awesome lists, repository dates | Topics, repository names |

- **Contact email** (optional): in the User-Agent header and as the `mailto` parameter of CrossRef and OpenAlex; required by Unpaywall. Not sent to ORCID or DataCite.
- **Keys** (optional): Semantic Scholar key to Semantic Scholar, OpenAlex key as an `Authorization` header to OpenAlex, GitHub token to GitHub.
- **Citation graph page:** fetches from `api.openalex.org` in your browser when opened.

## Models

- PDF text (passages, questions) goes to the configured model endpoints only.
- **In Pi:** the model selected in Pi, or the browser's own choice among Pi's models.
- **Standalone:** the `llm.*` endpoints of the configuration (LLM, generation model, embedding model).
- Endpoints can be remote; then PDF text leaves the machine. The LLM API key goes to the configured endpoint.

## Local files

- **Store:** `~/.config/pi-literature-review/` (Windows: `%APPDATA%\pi-literature-review\`): configuration with keys and contact email, search runs, reports, index, conversation history
- **PDFs:** downloaded into a folder chosen per run; read from your PDF folders, never written there
- **HTML reports:** render metadata received from the APIs; opened in your browser

## Local web server

Started by `/pi-literature-review` in Pi or `npx pi-literature-review web`.

- Binds to `127.0.0.1` only
- Every request needs a random token: `?token=` on the first visit, then an `HttpOnly`, `SameSite=Strict` cookie, or a bearer header
- The `Host` header must name the loopback address (DNS rebinding)
- API answers carry `Cache-Control: no-store`
- Keys are write-only: `POST /api/settings/key` stores them; the page reads back only "set" or "not set"
- The folder buttons open only folders the tool knows: the store, the PDF folders, the last download folder

## Live demo

The demo on GitHub Pages runs entirely in the visitor's browser.

- Requests go from the visitor's browser to the hosts above, except arXiv, Semantic Scholar and Unpaywall.
- No model; the paper chat replays a recorded example.
- Conversations stay in the browser's IndexedDB.
- No analytics, no cookies, no external scripts, styles or fonts. A build test fails on any host outside a fixed list.

## In scope

- Unsafe file names from downloaded content
- Script injection through API metadata rendered into HTML reports or the browser interface
- Requests to unintended hosts through configuration values
- Leaks of configured keys or the contact email
- Access to the local web server without the token

Vulnerabilities in the services above or in Pi itself belong to those projects.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: **Security** tab of this repository, then **Report a vulnerability**. If that is not possible, write to the maintainer email listed on the [npm package page](https://www.npmjs.com/package/pi-literature-review).

Include the version, the steps to reproduce and, if you have one, a suggested fix. You will get an acknowledgement within 14 days. Confirmed problems are fixed in the next release and noted in the changelog; the reporter is credited there unless they prefer not to be. There is no bug bounty.
