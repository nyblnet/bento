// Boot sequence. Order matters: capture the pristine document BEFORE any DOM
// mutation — the captured copy is what gets re-serialized on save.

import './styles.css'
import { capturePristine, readEmbeddedDoc, serializeFile } from './save'
import { parseDoc, starterDoc } from './model'
import { Store } from './store'
import { Editor } from './editor/editor'

capturePristine()

const embedded = readEmbeddedDoc()
const doc = (embedded && parseDoc(embedded)) || starterDoc()

document.title = `${doc.title} — Bento Slides`

// Embedded fonts: register @font-face rules from the asset table so text
// elements can use bundled families in the editor, presenter and thumbnails.
if (doc.fonts?.length) {
  const css = doc.fonts
    .map((f) => {
      const src = doc.assets?.[f.asset]
      if (!src) return ''
      return `@font-face{font-family:${JSON.stringify(f.family)};src:url(${JSON.stringify(src)});` +
        `font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'};font-display:swap}`
    })
    .join('\n')
  const style = document.createElement('style')
  style.id = 'bento-fonts'
  style.textContent = css
  document.head.appendChild(style)
}

const store = new Store(doc)
const editor = new Editor(document.getElementById('app')!, store)

// Opening a link ending in #present starts the show immediately (player mode).
if (location.hash === '#present') {
  editor.present(true)
}

// Dismiss the boot splash (inline in index.html so it paints before this
// bundle parses). Hold it briefly so the assemble animation reads as a
// brand moment instead of a flicker; the pristine capture ran before this,
// so saved files keep the splash for their own next boot.
{
  const splash = document.getElementById('bento-splash')
  if (splash) {
    const wait = Math.max(0, 1250 - performance.now())
    setTimeout(() => {
      splash.classList.add('done')
      setTimeout(() => splash.remove(), 550)
    }, wait)
  }
}

// Small scripting surface for tooling and automation: read/replace the
// document model and serialize the full .bento.html file.
;(window as any).bento = {
  format: doc.format,
  get doc() {
    return store.doc
  },
  serialize: () => serializeFile(store.doc),
  undo: () => store.undo(),
  redo: () => store.redo(),
}
