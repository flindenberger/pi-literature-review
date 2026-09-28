# Security policy

## Supported versions

Only the latest release on npm receives fixes. Older versions are not
patched; please update.

## What this package does that matters for security

- It sends search terms and paper identifiers to public APIs (arXiv,
  CrossRef, OpenAlex, optionally Semantic Scholar, Unpaywall, Hugging
  Face, GitHub, ecosyste.ms) and an optional contact email and API key
  from your configuration file.
- It downloads PDFs from publisher and repository URLs into
  `lit-selection/` in your working directory.
- It writes HTML reports that render metadata received from those APIs
  and that you open in your browser.
- It calls a local or configured embedding server and the model selected
  in Pi with text from your PDFs.

Reports about, for example, unsafe file names from downloaded content,
script injection through API metadata rendered into the HTML reports,
requests to unintended hosts through configuration values, or leaks of
configured keys and emails are in scope. Vulnerabilities in the services
listed above or in Pi itself should go to those projects.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
private reporting instead: **Security** tab of this repository, then
**Report a vulnerability**. If that is not possible, write to the
maintainer email listed on the
[npm package page](https://www.npmjs.com/package/pi-literature-review).

Include the version, the steps to reproduce and, if you have one, a
suggested fix. You will get an acknowledgement within 14 days. Confirmed
problems are fixed in the next release and noted in the changelog; the
reporter is credited there unless they prefer not to be. There is no bug
bounty.
