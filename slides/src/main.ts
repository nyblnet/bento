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

const store = new Store(doc)
const editor = new Editor(document.getElementById('app')!, store)

// Opening a link ending in #present starts the show immediately (player mode).
if (location.hash === '#present') {
  editor.present(true)
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
