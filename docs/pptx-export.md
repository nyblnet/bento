# Editable PowerPoint export

`bento/slides` exports the in-memory `BentoDoc` directly to OOXML with
PptxGenJS. The exporter does not scrape the editor DOM, does not contact a
server, and remains bundled inside the self-contained `.bento.html` runtime.

## Object mapping

| Bento element | PowerPoint output |
| --- | --- |
| Rich text | Editable text box and rich-text runs |
| Rect/ellipse/triangle/arrow/line | Editable PowerPoint shape |
| Image | Native image with contain/cover sizing |
| Table | Editable native table |
| Bar/line/pie chart | Editable native chart |
| Other chart | Static vector SVG chart |
| SVG or formula | One vector SVG object |
| Complex path/gradient/effects | One vector SVG object |
| Referenced audio/video | PowerPoint media object |
| Embedded data-URI media | Poster placeholder |
| Speaker notes | PowerPoint speaker notes |

The export uses a custom PowerPoint page size matching `doc.size`. Element
array order is retained as paint order. Dynamic fields are resolved at export
time, and Bento slide links become internal PowerPoint hyperlinks.

Interactive states are skipped by default, matching PDF export. The API accepts
`includeStates: true`; included states are hidden PowerPoint slides. Runtime
effects such as Bento morph, hover reveal, count-up, Ken Burns, and motion-path
loops are exported at their final static frame. Object names retain each
element's `morphId`/`id` (`bento:<id>`) for future OOXML Morph post-processing.

The exporter returns a compatibility report containing every intentional
degradation. The editor logs this report when notes exist.

## Programmatic API

```ts
import { buildPptx } from './export/pptx'

const { blob, fileName, report } = await buildPptx(doc, {
  download: false,
  includeStates: false,
})
```

## Verification

Run `npm run build:single`, export the starter deck, and verify the result by:

1. unzipping the PPTX and checking slide, chart, media, notes, and relationship XML;
2. extracting its text with MarkItDown;
3. rendering it through LibreOffice and comparing slide images with Bento;
4. opening it in PowerPoint to verify text, shapes, tables, and charts remain editable.
