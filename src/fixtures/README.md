# Test fixtures

## ligatures.pdf

A one-page PDF (9 KB) that embeds a raw Type 1 font (a 30-glyph subset of
URW Nimbus Roman, URW base35, distributed under the GNU AGPL v3 with the
font-embedding exception) whose built-in encoding places the "fi" and "fl"
ligatures on codes 12 and 13, the way LaTeX's Computer Modern fonts do.
There is no ToUnicode map, so a text extractor must read the glyph names
out of the font program itself.

That is the shape of paper PDFs that lost every "fi" in extraction when
the pdf.js build inside unpdf started calling `Math.sumPrecise` (missing
in Node 24 and older): the font parser failed, the fallback encoding has
nothing on code 12, and "classification" came out as "classi cation".
`src/extract-pdf.test.ts` extracts this file through the real modules and
fails when a ligature is lost or pdf.js prints a warning.

Regenerate with `python3 src/fixtures/ligatures-fixture.py <out.pdf>` (needs
the URW base35 Type 1 fonts, package fonts-urw-base35 on Debian/Ubuntu).
