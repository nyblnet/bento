# Contributing to convert/ — PowerPoint in and out

`convert/` turns PowerPoint decks into Bento decks and back. It is a library
and a command-line tool, not part of any app: nothing here ships inside a
`.bento.html` file. Import came first: you can drop a `.pptx` on
[bento.page/import](https://bento.page/import). Export is a library and a
command-line tool, so every shared file stays small and the app stays
focused.

This guide is for anyone who wants to make the export better. The work is
split into small pieces; see [Open tasks](#open-tasks).

## What is where

```
convert/
  cli.mjs              bento convert: the command-line tool
  src/index.ts         the library's public entry (import + export)
  src/api.ts           import: .pptx → .bento.html (bento.page/import uses this)
  src/export.ts        export: .bento.html → .pptx
  src/pptx.ts …        the importer (theme, text, shapes, media, inheritance)
  src/pptx-write/      the exporter
    index.ts           walks the deck, allocates ids, assembles the package
    contract.ts        the element-writer contract (read this first)
    text.ts shapes.ts media.ts tables.ts charts.ts   one writer per element type
    code.ts embed.ts   writers not written yet (stubs)
    parts.ts           the package skeleton: presentation, masters, layouts, theme, notes
  src/xmlout.ts        builds XML as plain data, escapes everything
  page/                bento.page/import
scripts/test-convert/  the rigs (tests); files starting with _ are helpers
```

## Set up and run

You need Node 23.6 or newer. The rigs are TypeScript run directly by Node; the
CLI and some rigs bundle with the esbuild that slides already installs.

```sh
cd slides && npm install && cd ..        # once: esbuild and tsc come from here
node scripts/test-convert.ts             # every convert rig
node scripts/test-convert/pptx-coverage.ts   # one rig
cd slides && node_modules/.bin/tsc -p ../convert   # typecheck convert/

# the tool itself
node convert/cli.mjs deck.bento.html --to pptx    # → deck.pptx, report on stderr
node convert/cli.mjs deck.pptx                    # → deck.bento.html (needs the network
                                                  #   or --shell slides/dist-single/…)
```

A deck to try: open bento.page/slides, save it, and export the file. Its
starter deck uses nearly every element type.

## How export works

1. `bentoToPptx(html)` (`src/export.ts`) pulls the document out of the file
   and runs it through slides' own `parseDoc`, so the writer only ever sees a
   document the app would open. Encrypted and compact files are refused with
   what to do instead.
2. `exportPptx(doc)` (`pptx-write/index.ts`) walks the slides. Interactive
   state slides are left out (they are click-reached variants, not slides in
   the show). For each element it calls that type's **writer**.
3. A writer turns one element into one PowerPoint shape: a `p:sp` (text,
   shapes), `p:pic` (pictures) or `p:graphicFrame` (tables, charts). XML is
   built with `x()` from `xmlout.ts`, which escapes every value.
4. `index.ts` wires links, records presentation effects once per slide, and
   writes the package with `parts.ts`: presentation, master, layout, theme,
   notes, and the property parts PowerPoint expects.
5. Everything the writers could not carry exactly is in the **fidelity
   report** that comes back with the bytes.

## The writer contract

`pptx-write/contract.ts` is short; read it before writing a writer. In brief:

- **One node or null.** Return one top-level node whose `p:cNvPr` id is
  `ctx.shapeId`, or `null` if you emit nothing.
- **Never throw on content. Report instead.** If the slide will still show
  something close, add `'approximated'`. If it won't, add `'dropped'`. Use a
  stable kebab-case code (`code-colours-flattened`) and a detail that says, in
  plain words, what the person will see in PowerPoint. Returning `null`
  without a `'dropped'` entry is a silent loss, and the coverage rig fails it.
- **Package wiring goes through `ctx.media`.** Images and SVG enter the
  package that way, deduplicated by content. Don't invent relationship ids.
- **No app imports, no DOM.** The writer runs in Node and in browsers. Read
  the element and `ctx`, nothing else. `scripts/test-convert/boundary.ts`
  enforces this.
- **Deterministic.** Same deck, same bytes. Two exports must be identical.
- **No new dependencies.** The whole tool is dependency-free on purpose. If a
  task seems to need one (rasterising SVG, say), open an issue first.

## Testing with the harness

`scripts/test-convert/_export-harness.ts` exports a deck or a single element
and tells you what is wrong with the package:

```ts
import { exportOne } from './_export-harness.ts'

const r = await exportOne({
  type: 'code', fontSize: 18, fontFamily: 'Menlo, monospace', align: 'left',
  valign: 'top', lineHeight: 1.4, color: '#1E2A3A', content: 'let x = 1\nx += 1',
})
r.problems   // [] when the package is wired the way PowerPoint checks it
r.slideXml   // the slide part: assert on what your writer emitted
r.codes      // the report's codes, e.g. r.codes.has('code-colours-flattened')
```

`problems` covers what has bitten this exporter before: broken or dangling
relationships, parts without a content type, XML that doesn't parse,
`[Content_Types].xml` not first, missing property parts, and a notes master
without its own theme. A package can pass the official XML schemas and still
make PowerPoint offer to repair it; those checks are the gap between the two.
They live in `pptx-write/verify.ts`, and every export runs them before
writing the zip: if your writer breaks the package, the export refuses and
says which part is wrong.

Typefaces go through `pptx-write/fonts.ts` (`typefaceOf`). PowerPoint takes
one font name, not a CSS stack. Use it rather than taking the stack's first
family, which may be a CSS generic (`ui-monospace`) or a font only one
operating system has (`SF Mono`).

Copy the rig shape from `pptx-coverage.ts` (an `ok()` helper, `N/N checks
passed`, exit 1 on failure). Name your rig `scripts/test-convert/pptx-<thing>.ts`;
the runner picks it up and CI runs it.

**Prove your checks can fail.** For each important check, break the code on
purpose once (delete the line that does the thing) and watch the rig go red.
A check that never failed hasn't been shown to work.

## Walkthrough: writing the `code` writer

1. Open `pptx-write/code.ts`. `CodeElIn` lists the fields you get. The stub
   reports the element dropped and returns `null`.
2. Look at `textSp` in `text.ts`. It builds a text box (`p:sp` with
   `p:txBody`) from a frame, paragraphs and run properties. `emu()` in
   `shapes.ts` converts px to PowerPoint units.
3. Build a text box at the element's frame: one paragraph per line of
   `content`, in the element's font (fall back to `Consolas`), size, colour
   and alignment. Keep leading spaces: indentation is the point of code.
4. Syntax colours are optional in a first version. If you leave them out,
   report it: `ctx.report.add('approximated', 'code-colours-flattened',
   ctx.where, 'code shows in one colour; syntax highlighting is not exported')`.
5. In `scripts/test-convert/pptx-coverage.ts`, move `code` from `NOT_YET`
   to `SAMPLE`/`MAPPED`. The rig now requires one shape and a clean package.
6. Add `scripts/test-convert/pptx-code.ts` with your own checks: lines become
   paragraphs, leading spaces survive, `<` and `&` in code are escaped, an
   empty `content` doesn't crash.
7. Run `node scripts/test-convert.ts` and the typecheck. Then **open the
   result in PowerPoint**, the one check no rig can do. Say in your PR which
   app and version you opened it in (PowerPoint for Mac or Windows, Keynote,
   LibreOffice, Google Slides).

## Open tasks

Each task is self-contained and has a rig to extend. Tasks marked
**good first issue** don't need deep knowledge of the format.

| task | where | notes |
|---|---|---|
| **Export `code` elements** · good first issue | `pptx-write/code.ts` | the walkthrough above |
| **Export `embed` elements** · good first issue | `pptx-write/embed.ts` | every embed has an SVG `view`; `svgPic` in `media.ts` already places SVG. Report `approximated` (`embed-static`): the picture travels, the live document doesn't |
| **Line tip `bar`** · good first issue | `pptx-write/shapes.ts` | a `bar` line end exports as a diamond today (`line-tip-approximated`); find the closest real PowerPoint end, or draw it |
| **Playable audio and video** | `pptx-write/media.ts` | today only a video's poster exports (`media-dropped`). PowerPoint embeds media as a `p:pic` with a media relationship and timing |
| **Morph transitions** | `pptx-write/index.ts`, `parts.ts` | PowerPoint's Morph is an extension (`p159:morph` inside `mc:AlternateContent`); slides currently cut (`morph-not-exported`). Bento morphs pair elements by id, so the pairing is already in the deck |
| **Picture fallback for SVG** | `pptx-write/media.ts` | PowerPoint 2016 shows SVG as a blank frame without a PNG fallback (`svg-no-raster-fallback`). Rasterising needs a renderer: open an issue to discuss before writing code |
| **Export compact documents** | `src/export.ts` | `bentoToPptx` refuses `compact: true` files; slides' compact loader shows how they expand |
| **One `bento` command** | `bin/` (new) | a small dispatcher so `bento convert …` and `bento check …` are one tool |

## Before you open a pull request

- `node scripts/test-convert.ts` passes, and the typecheck is clean.
- Your writer follows `contract.ts`: no throws on content, every loss
  reported, no app imports, no new dependencies.
- You opened an exported deck in a real presentation app, and the PR says
  which one.
- New files carry the SPDX header used throughout (`MIT`).
