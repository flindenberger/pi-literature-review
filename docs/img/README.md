# Screenshots and animations

**PNG** screenshots: 2400 x 1500 px (16:10, twice the display width so text
stays readable when the image is opened full size), 256 colours, under
~500 KB each (images stay in the git history forever). The teaser is
3200 x 1400.

**GIF** animations (README): real screen recordings, 1100 px wide, rounded
transparent corners, played 1.5x with waits sped up further, at most
~15 frames per second, 96 colours, 0.6-5.2 MB each. Built by
`design/2026-09-24_gif_production2/out/make.py` from the recordings in that
folder (not committed); the browser's link-address overlay is painted over
with the page content from the frame before.

GitHub shows README images at column width; a click opens the full image.
Referenced from README.md and docs/*.md by these names:

| File | Shows | Used in |
|---|---|---|
| `teaser.png` | The three stages side by side (search, select, synthesize), three screenshots each; built from `design/2026-09-22_teaser/quelle/teaser.html` | README up to 0.1.1 (keep: the published npm README still links it) |
| `search-variants-tab.png` | The /lit-search wizard on the Query variants tab: main query, a ticked variant, further suggestions, the rows to add or generate variants | docs/search.md |
| `wizard.gif` | The /lit-search wizard from keyword blocks to the result card: query variants, period, records, journals, authors, code sources, confirm | README up to 0.1.1 (keep: the published npm README still links it) |
| `search-results-page.gif` | The results page: sorting by two columns, an abstract opened, the search documentation with the PRISMA flow diagram | README up to 0.1.1 (keep: the published npm README still links it) |
| `search-results-page.png` | The "Search documentation" section opened: records identified per source and query, exclusions, verification, targeting, the PRISMA flow diagram, then the start of the results table | docs/search.md |
| `network-graph.gif` | A Graph button clicked, the citation graph builds, circles hovered, the cited / citing filters toggled | README up to 0.1.1 (keep: the published npm README still links it) |
| `network-graph.png` | The citation graph of one paper, the paper's circle hovered (focus + tooltip) | docs/search.md |
| `search-code-column.gif` | Result rows with links in the Code / data column; one repository opened on GitHub | README up to 0.1.1 (keep: the published npm README still links it) |
| `search-selection-bar.gif` | A paper ticked on the results page, the download request copied and pasted into Pi, the consent dialog, the PDF downloaded | README up to 0.1.1 (keep: the published npm README still links it) |
| `synthesis-highlight.gif` | A synthesis report in the browser: a citation superscript clicked, the PDF opens at the cited page with the passage highlighted | README up to 0.1.1 (keep: the published npm README still links it) |
| `synthesis-highlight.png` | Composite: a report answer with citation superscript 6 (left) and the PDF opened at the cited page with the passage highlighted in Firefox (right) | docs/synthesis.md |
| `synthesis-report.gif` | The /lit-synthesis wizard, the model run (sped up), the report card with page links, then the HTML report and a cited passage in the PDF | README up to 0.1.1 (keep: the published npm README still links it) |
| `logo.png`, `logo-dark.png` | The logo (white italic pi on a dark disc) with the package name; light and dark theme, 660 x 112 (2x), rendered from SVG so the font does not depend on the reader's system | README (title) |
| `try-it.png`, `try-it-dark.png` | The "Try it in your browser" button for the live demo; light and dark theme, 544 x 96 (2x) | README |
| `readme-hero.gif` | Browser: a search with result cards, an abstract and an author window, then a paper opened, a question asked, the answer with citation marks and the PDF at the highlighted passage; 1000 px, 12 fps, about 34 s | README (under the lead sentence) |
| `gallery.png` | Gallery preview for pi.dev/packages (`pi.image` in package.json): pi mark + package name on pi.dev's light background; 480 x 300, static; built from `design/2026-11-08_galeriebild_entwuerfe/quelle/g1b-marke-pidev-480.html` | package.json (not the README) |
| `synthesis-chat-card.png` (optional, not taken yet) | A grounded chat answer card with reference lines and the yellow paper-chat mode line | -- |
