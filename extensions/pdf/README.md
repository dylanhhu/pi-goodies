# pdf

Two ways into a local PDF, both addressed by printed page numbers:

| action   | returns                                                       |
| -------- | ------------------------------------------------------------- |
| `text`   | the text layer of a page range, with `=== page N ===` markers |
| `render` | pages rasterized to images, for tables, diagrams, and scans   |
| `info`   | page count, page size, title, producer                        |

It shells out to poppler (`pdftotext`, `pdftoppm`, `pdfinfo`) rather than parsing in
TypeScript, which keeps layout fidelity. Nothing is cached or indexed: the caller names the
range it wants, so a lookup costs a page rather than a document.

## Examples

```
pdf(path="rules.pdf", action="info")
pdf(path="rules.pdf", action="text", pages="12-14")
pdf(path="rules.pdf", action="text", pages="3, 9-11", layout=false)
pdf(path="rules.pdf", action="render", pages="47", dpi=200)
```

Page specs accept `7`, `7-12`, `3,9-11`, `all`, and typographic or spaced dashes.

## Limits

- 8 pages per `render` call, because images crowd out the rest of the context
- 40,000 characters of text by default (`maxChars`, clamped to 1,000-200,000)
- 50-400 dpi (`dpi`, default 150)

Pages with no text layer come back as a note pointing at `render`, and a range that is
entirely empty says so once, at the end.

## Dependencies

poppler: `brew install poppler`. The tool reports a missing binary rather than failing
silently.

## Tests

`test/pdf/pages.test.ts` covers the range grammar and text shaping; `test/pdf/tool.test.ts`
runs the tool against `test/fixtures/pdf/sample.pdf` and skips when poppler is absent.
