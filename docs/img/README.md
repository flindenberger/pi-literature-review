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
| `teaser.png` | The three stages side by side (search, select, synthesize), three screenshots each; built from `design/2026-09-22_teaser/quelle/teaser.html` | README (hero image) |
| `search-variants-tab.png` | The /lit-search wizard on the Query variants tab: main query, a ticked variant, further suggestions, the rows to add or generate variants | docs/search.md |
| `wizard.gif` | The /lit-search wizard from keyword blocks to the result card: query variants, period, records, journals, authors, code sources, confirm | README |
| `search-results-page.gif` | The results page: sorting by two columns, an abstract opened, the search documentation with the PRISMA flow diagram | README |
| `search-results-page.png` | The "Search documentation" section opened: records identified per source and query, exclusions, verification, targeting, the PRISMA flow diagram, then the start of the results table | docs/search.md |
| `network-graph.gif` | A Graph button clicked, the citation graph builds, circles hovered, the cited / citing filters toggled | README |
| `network-graph.png` | The citation graph of one paper, the paper's circle hovered (focus + tooltip) | docs/search.md |
| `search-code-column.gif` | Result rows with links in the Code / data column; one repository opened on GitHub | README |
| `search-selection-bar.png` | The download steps above the results table with two ticked rows, access markers in the DOI column | README |
| `synthesis-highlight.gif` | A synthesis report in the browser: a citation superscript clicked, the PDF opens at the cited page with the passage highlighted | README |
| `synthesis-highlight.png` | Composite: a report answer with citation superscript 6 (left) and the PDF opened at the cited page with the passage highlighted in Firefox (right) | docs/synthesis.md |
| `synthesis-report.gif` | The /lit-synthesis wizard, the model run (sped up), the report card with page links, then the HTML report and a cited passage in the PDF | README |
| `synthesis-chat-card.png` (optional, not taken yet) | A grounded chat answer card with reference lines and the yellow paper-chat mode line | -- |
