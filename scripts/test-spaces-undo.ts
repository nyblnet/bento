#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Undo: depth on a real document, and correctness across mixed scopes.
//
//   node scripts/test-spaces.mjs undo        # or just: node scripts/test-spaces.mjs
//
// (Bundled rather than run directly because store.ts imports './model' without
// an extension, which node's ESM resolver cannot follow. Handing this file
// straight to node fails with ERR_MODULE_NOT_FOUND, which reads like a broken
// product rather than a missing build step — the runner above does what CI
// does. Same pattern as the autosave and validate rigs.)
//
// WHY. Every checkpoint used to stringify the WHOLE document. Measured on a
// 200-page, 2.5 MB handbook: fifty edits left an undo depth of NINE, because
// nine snapshots of 2.5 MB exhaust a 24 MB budget. A writer who notices a
// mistake ten edits back cannot reach it, and nothing tells them why.
//
// So a typing run — one block, one page, and by far the most common edit —
// records only that PAGE. The budget then holds hundreds of entries instead of
// nine.
//
// WHAT MAKES THAT DANGEROUS, and what this rig is really for: a page entry
// restores one page and leaves the rest of the document alone. That is only
// correct if the mutation touched nothing else. Scope is therefore opted into,
// `doc` is the default, and the cases below are the ones where a wrong scope
// would silently lose work — mixed scopes, interleaved undo/redo, and edits
// spanning two pages.

import { Store } from '../spaces/src/store.ts'
import { parseDoc, FORMAT, type SpacesDoc } from '../spaces/src/model.ts'
import { planGraft } from '../spaces/src/portable.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

function load(pages: unknown[]): SpacesDoc {
  const r = parseDoc(JSON.stringify({
    format: FORMAT, version: 1, docId: 'u', title: 'U', home: (pages[0] as { id: string }).id,
    theme: { background: '#fff', color: '#1E2A3A', accent: '#F7A600', measure: 720 },
    pages,
  }))
  if (!r.ok) throw new Error('fixture did not parse')
  return r.doc
}
const page = (id: string, text: string) =>
  ({ id, title: id, blocks: [{ id: `${id}b`, type: 'p', html: text }] })
const textOf = (s: Store, pid: string) =>
  String(s.doc.pages.find((p) => p.id === pid)?.blocks[0]?.html ?? '')

console.log('bento/spaces undo\n')

// ---- depth on a document people actually have ------------------------------
{
  const pages = Array.from({ length: 200 }, (_, i) => ({
    id: `p${i}`, title: `Page ${i}`,
    blocks: Array.from({ length: 40 }, (_, j) => ({
      id: `p${i}b${j}`, type: 'p',
      html: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod '
        + 'tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, '
        + 'quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo.',
    })),
  }))
  const doc = load(pages)
  const mb = JSON.stringify(doc).length / 1024 / 1024
  const s = new Store(doc)
  for (let n = 0; n < 150; n++) {
    s.runEdit('p0b0', () => { s.doc.pages[0].blocks[0].html = `typed ${n}` })
    s.endRun()
  }
  let depth = 0
  while (s.canUndo) { s.undo(); depth++ }
  ok(depth >= 150, `${mb.toFixed(1)} MB document keeps 150 typing runs undoable (got ${depth})`)
  ok(s.doc.pages.length === 200 && s.doc.pages[199].blocks.length === 40,
    'and undoing 150 times leaves every other page untouched')
}

// ---- a page entry restores ONE page ----------------------------------------
{
  const s = new Store(load([page('a', 'A0'), page('b', 'B0')]))
  s.goToPage('a')
  s.runEdit('ab', () => { s.doc.pages[0].blocks[0].html = 'A1' })
  s.endRun()
  s.goToPage('b')
  s.runEdit('bb', () => { s.doc.pages[1].blocks[0].html = 'B1' })
  s.endRun()

  s.undo()
  ok(textOf(s, 'b') === 'B0' && textOf(s, 'a') === 'A1',
    'undo takes back the last page edit and leaves the earlier one')
  s.undo()
  ok(textOf(s, 'a') === 'A0' && textOf(s, 'b') === 'B0', 'and then the one before it')
}

// ---- page and doc entries interleave in the right order --------------------
// The order matters most when they mix: a doc entry restores the whole
// document, so a page entry taken AFTER it must not be applied on top of a
// document that no longer contains that page.
{
  const s = new Store(load([page('a', 'A0')]))
  s.goToPage('a')
  s.runEdit('ab', () => { s.doc.pages[0].blocks[0].html = 'A1' })   // page
  s.endRun()
  s.commit(() => { s.doc.pages.push(page('c', 'C0') as never) })    // doc
  s.goToPage('c')
  s.runEdit('cb', () => { s.doc.pages[1].blocks[0].html = 'C1' })   // page
  s.endRun()

  ok(s.doc.pages.length === 2 && textOf(s, 'c') === 'C1', 'set-up: two pages, both edited')
  s.undo()
  ok(textOf(s, 'c') === 'C0', 'undo 1 takes back the page edit on the new page')
  s.undo()
  ok(s.doc.pages.length === 1, 'undo 2 takes back the page creation')
  ok(textOf(s, 'a') === 'A1', '…without disturbing the earlier page edit')
  s.undo()
  ok(textOf(s, 'a') === 'A0', 'undo 3 takes back that too')
  ok(!s.canUndo, 'and the history is exhausted, not looping')
}

// ---- redo returns exactly what undo took -----------------------------------
{
  const s = new Store(load([page('a', 'A0')]))
  s.goToPage('a')
  s.runEdit('ab', () => { s.doc.pages[0].blocks[0].html = 'A1' })
  s.endRun()
  s.commit(() => { s.doc.pages.push(page('z', 'Z0') as never) })

  s.undo(); s.undo()
  ok(textOf(s, 'a') === 'A0' && s.doc.pages.length === 1, 'undone to the start')
  s.redo()
  ok(textOf(s, 'a') === 'A1', 'redo restores the page edit')
  s.redo()
  ok(s.doc.pages.length === 2, 'redo restores the structural change')
  ok(!s.canRedo, 'and there is nothing left to redo')
}

// ---- a new edit clears the redo branch -------------------------------------
{
  const s = new Store(load([page('a', 'A0')]))
  s.goToPage('a')
  s.runEdit('ab', () => { s.doc.pages[0].blocks[0].html = 'A1' })
  s.endRun()
  s.undo()
  ok(s.canRedo, 'after undo there is something to redo')
  s.runEdit('ab', () => { s.doc.pages[0].blocks[0].html = 'A2' })
  s.endRun()
  ok(!s.canRedo, 'a new edit drops the redo branch rather than leaving a stale future')
}

// ---- undo restores the VIEW too --------------------------------------------
{
  const s = new Store(load([page('a', 'A0'), page('b', 'B0')]))
  s.goToPage('a')
  s.runEdit('ab', () => { s.doc.pages[0].blocks[0].html = 'A1' })
  s.endRun()
  s.goToPage('b')
  s.undo()
  ok(s.pageId === 'a', 'undo returns you to the page the change was made on')
}

// ---- a read-only space records nothing -------------------------------------
{
  const s = new Store(load([page('a', 'A0')]))
  s.readOnly = true
  s.commit(() => { s.doc.pages[0].blocks[0].html = 'nope' })
  ok(!s.canUndo && textOf(s, 'a') === 'A0', 'a read-only space neither changes nor records')
}

// ---- importing a whole space is ONE undo step ------------------------------
//
// The Markdown import is one step and says so in its own summary; a subtree
// import moves more — pages, blocks, images and fonts — and a half-applied one
// is not something a single ⌘Z could put back. This is the assertion that the
// commit is genuinely one entry and that undoing it leaves the space exactly as
// it was, ids and all. It lives here rather than in the model rig because it
// needs the real Store, which imports './model' without an extension.
{
  const host = load([page('a', 'A0'), page('b', 'B0')])
  const s = new Store(host)
  const before = JSON.stringify(s.doc.pages)

  const incoming = load([
    // collides with the host on BOTH ids, which is the interesting case
    { id: 'a', title: 'Arriving', blocks: [
      { id: 'ab', type: 'p', html: 'see <a href="#p/a2">the other</a>' },
      { id: 'ac', type: 'image', src: 'asset:k1' },
    ] },
    { id: 'a2', title: 'The other', parent: 'a', blocks: [{ id: 'a2b', type: 'p', html: 'x' }] },
  ])
  incoming.assets = { k1: 'data:image/png;base64,AAAA' }

  const plan = planGraft(s.doc, incoming, { under: 'b' })
  s.commit(() => {
    s.doc.pages.push(...plan.pages)
    Object.assign((s.doc.assets ??= {}), plan.assets)
  })

  ok(s.doc.pages.length === 4, 'the import landed')
  const ids = s.doc.pages.flatMap((p) => [p.id, ...p.blocks.map((b) => b.id)])
  ok(new Set(ids).size === ids.length, 'and every id in the merged space is still unique')
  ok(s.doc.assets?.k1 === 'data:image/png;base64,AAAA', 'the image came with it')

  s.undo()
  ok(s.doc.pages.length === 2, 'ONE ⌘Z removes the whole import — pages, blocks and all')
  ok(JSON.stringify(s.doc.pages) === before, 'and what is left is byte-identical to the space before it')
  ok(!s.canUndo, 'the import took exactly one undo entry, not one per page')
  // Deliberately NOT asserted the other way: undo snapshots exclude `assets`
  // (store.ts), so the image bytes stay behind exactly as they do after undoing
  // a Markdown import. Pruning them would break REDO, which re-inserts blocks
  // pointing at those very keys — the importer's summary says "removes the
  // imported pages" for this reason.
  s.redo()
  ok(s.doc.pages.length === 4 && s.doc.assets?.k1 !== undefined, 'redo brings the import back intact')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
