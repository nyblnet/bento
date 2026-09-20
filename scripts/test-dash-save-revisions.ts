// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { Store: DashStore } = await import('../dash/src/store.ts')
const { parseDoc: parseWorkbook } = await import('../dash/src/model.ts')
const { saveQueue } = await import('../dash/src/savequeue.ts')
const book = parseWorkbook(JSON.stringify({ format: 'bento/dash', version: 1, docId: 'd', title: 'Book', sheets: [{ id: 'sh', kind: 'table', name: 'Data', rids: [[1,1]], columns: [{ id: 'value', name: 'Value', type: 'number' }], data: { value: { enc: 'raw', v: [1] } }, steps: [] }] }))
assert(book.ok)
const d = new DashStore(book.doc), dq = saveQueue(d)
assert.equal(saveQueue(d), dq, 'save menu and main share one queue')
const snapshot = await dq.run(() => {}, async () => true)
d.touch()
assert.equal(snapshot!.isCurrent(), false)
const remoteDash = await dq.run(() => {}, async () => true)
d.changedRemotely()
assert.equal(remoteDash!.isCurrent(), false)
const replaced = dq.run(() => {}, async () => { throw Error('old workbook request must be discarded') })
d.replaceDoc({ ...d.doc, docId: 'other-book' })
assert.equal(await replaced, undefined)
console.log('dash save revisions: local/remote changes, shared queue and identity replacement passed')
