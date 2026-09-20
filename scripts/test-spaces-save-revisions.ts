// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { Store: SpacesStore } = await import('../spaces/src/store.ts')
const { parseDoc: parseSpace } = await import('../spaces/src/model.ts')
import { SaveQueue } from '../kernel/src/savequeue.ts'
const space = parseSpace(JSON.stringify({ format: 'bento/spaces', version: 1, docId: 's', title: 'Space', pages: [{ id: 'p', title: 'Page', blocks: [{ id: 'b', type: 'p', html: 'before' }] }] }))
assert(space.ok)
const s = new SpacesStore(space.doc)
const q = new SaveQueue({ getDocument: () => s.doc, getRevision: () => s.revision })
s.runEdit('b', () => { s.doc.pages[0].blocks[0].html = 'first' })
let release!: () => void
const first = q.run(() => s.endRun(), async doc => { await new Promise<void>(r => { release = r }); return doc.pages[0].blocks[0].html })
await Promise.resolve()
// Two inputs while already dirty; the second does not emit a doc notification.
s.runEdit('b', () => { s.doc.pages[0].blocks[0].html = 'second' })
const revision = s.revision
s.runEdit('b', () => { s.doc.pages[0].blocks[0].html = 'third' })
assert(s.revision > revision)
release()
const saved = await first
assert.equal(saved!.value, 'first')
assert.equal(saved!.isCurrent(), false)
s.endRun()
const remote = await q.run(() => {}, async () => true)
s.doc.pages[0].blocks[0].html = 'remote'
s.setDirty(true)
assert.equal(remote!.isCurrent(), false, 'remote change invalidates a save even while already dirty')

console.log('spaces save revisions: grouped typing and already-dirty remote changes passed')
