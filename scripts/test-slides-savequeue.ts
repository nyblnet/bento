// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { Store } = await import('../slides/src/store.ts')
import { newDoc } from '../slides/src/model.ts'
const { SaveQueue } = await import('../slides/src/editor/savequeue.ts')
const s = new Store(newDoc()), q = new SaveQueue(s)
let release!: () => void
const writes: string[] = []
const first = q.run(()=>{},async d=>{writes.push(d.title);await new Promise<void>(r=>release=r);return 'saved'})
await Promise.resolve()
s.commit(()=>s.doc.title='new edit')
const second=q.run(()=>{},async d=>{writes.push(d.title);return 'saved'})
assert.equal(writes.length,1)
release()
const old=await first
assert.equal(old!.isCurrent(),false)
const next=await second
assert.equal(next!.isCurrent(),true)
assert.equal(writes[1],'new edit')
await assert.rejects(q.run(()=>{},async()=>{throw new Error('disk full')}))
assert.equal((await q.run(()=>{},async()=>true))!.value,true)
const stale=q.run(()=>{},async()=>{throw new Error('must not write a replaced document')})
s.replaceDoc(newDoc())
assert.equal(await stale,undefined)
console.log('save queue: revision acknowledgement, immutable bytes, ordering, recovery after failure and document replacement passed')
