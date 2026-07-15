# Bento

**Documents that carry their own app.** Bento packages a document *and* its full
display + editing functionality into a single HTML file any web browser can open —
no install, no server, no cloud. Like a bento box: everything you need, in one container.

The inspiration is the single-file build of the commercial-architecture webapp
(Vite + `vite-plugin-singlefile` → one self-contained HTML that runs from `file://`),
combined with the TiddlyWiki idea of a file that can edit and re-save itself.

## The format

A Bento document (`*.bento.html`) is an ordinary HTML file with three parts:

1. **Data block** — `<script type="application/bento+json" id="bento-doc">` holding the
   document model as JSON (all assets such as images embedded as data URIs).
2. **Runtime** — one inlined JS/CSS bundle: the viewer, the presenter, and the editor.
3. **Self-save** — at boot the runtime captures its own pristine HTML; on save it swaps
   in the updated data block and writes the file back via the File System Access API
   (Chrome/Edge) or a download fallback (Firefox/Safari). The saved file is again a
   complete, editable Bento document.

## Apps

| App | Status | Libraries |
|---|---|---|
| `slides/` — Bento Slides (PowerPoint replacement) | in development | Reveal.js (present), GSAP Flip (morph/animation), Moveable + Selecto (editing) |
| docs (Word replacement) | planned | TBD (e.g. ProseMirror/Tiptap) |
| sheets (Excel replacement) | planned | TBD (e.g. HyperFormula + a grid) |

## Bento Slides

```bash
cd slides
npm install
npm run dev            # editor on http://localhost:5173
npm run build:single   # → dist-single/Bento_Slides.bento.html (the shippable format)
```

The built file opens from disk, boots into the editor with a starter deck, presents
with Reveal.js (morph transitions via GSAP Flip for elements whose IDs match across
slides — PowerPoint "Morph" style), and saves itself with your edits embedded.
