// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import assert from 'node:assert/strict'
import { newDoc, emptySlide, defaultText } from '../slides/src/model.ts'
import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { Store } = await import('../slides/src/store.ts')
const fixture = () => { const d = newDoc(); d.slides = [emptySlide({id:'a'}), emptySlide({id:'b'})]; return new Store(d) }
{
 const s=fixture(); const title=s.doc.title
 s.commit(()=>s.doc.title='local')
 s.doc.slides[1].notes='remote'; s.emit('doc')
 s.undo(); assert.equal(s.doc.title,title); assert.equal(s.doc.slides[1].notes,'remote')
 s.redo(); assert.equal(s.doc.title,'local'); assert.equal(s.doc.slides[1].notes,'remote')
}
{
 const s=fixture();s.commit(()=>s.doc.title='local');s.doc.title='remote';s.emit('doc');s.undo();assert.equal(s.doc.title,'remote');s.redo();assert.equal(s.doc.title,'remote')
}
{
 const s=fixture();s.doc.slides[0].elements=[defaultText({id:'text'})]
 s.commit(()=>s.doc.slides[0].elements[0].x=100)
 s.doc.slides.unshift(emptySlide({id:'remote'}));s.doc.slides[1].elements[0].y=250;s.emit('doc')
 s.undo();assert.equal(s.doc.slides[1].elements[0].y,250);assert.notEqual(s.doc.slides[1].elements[0].x,100);assert.equal(s.doc.slides[0].id,'remote')
}
{
 const s=fixture();s.commit(()=>s.doc.slides.reverse(),'slides');s.doc.slides[0].notes='remote';s.emit('doc');s.undo();assert.deepEqual(s.doc.slides.map(x=>x.id),['a','b']);assert.equal(s.doc.slides[1].notes,'remote')
}
{
 const s=fixture();s.commit(()=>s.doc.slides.splice(0,1),'slides');s.undo();assert.deepEqual(s.doc.slides.map(x=>x.id),['a','b']);s.redo();assert.deepEqual(s.doc.slides.map(x=>x.id),['b'])
}
{
 const s=fixture();s.commit(()=>s.doc.slides.push(emptySlide({id:'new'})),'slides');s.doc.slides[2].notes='remote';s.emit('doc');s.undo();assert.equal(s.doc.slides[2].notes,'remote')
}
{
 const s=fixture();s.doc.assets={large:'data:image/png;base64,'+'A'.repeat(2*1024*1024)}
 for(let i=0;i<100;i++)s.commit(()=>s.doc.title='edit '+i)
 assert(s.historyBytes<100_000,`small edits retained ${s.historyBytes} bytes`)
 s.undo();assert.equal(s.doc.assets.large.length,2097174)
}
{
 const s=fixture();s.checkpoint();s.doc.title='one';s.touch();s.doc.slides[0].notes='remote';s.emit('doc');s.doc.title='two';s.touch();s.undo();assert.equal(s.doc.slides[0].notes,'remote');assert.notEqual(s.doc.title,'two')
}
console.log('slides history: local undo, remote preservation, identity, structure, bursts and asset budget passed')
{
 const s=fixture();s.doc.slides.push(emptySlide({id:'c'}),emptySlide({id:'d'}));s.commit(()=>s.doc.slides.splice(0,3),'slides');s.undo();assert.deepEqual(s.doc.slides.map(x=>x.id),['a','b','c','d']);s.redo();assert.deepEqual(s.doc.slides.map(x=>x.id),['d'])
}
{
 const s=fixture();s.commit(()=>s.doc.title='local');s.doc.title='remote';s.emit('doc');const remote=s.recentChanges.find(x=>!x.local)!;assert(remote);s.revertChange(remote.id);assert.equal(s.doc.title,'local');s.undo();assert.equal(s.doc.title,'remote')
}
console.log('multi-delete order and explicit remote revert round-trip passed')

// Mixed structural operations must restore both content and exact order.
const { changes, copy, reverse } = await import('../slides/src/history.ts')
let seed = 92461
const random = (n: number) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed % n
}
for (let i = 0; i < 3000; i++) {
  const before = { slides: Array.from({ length: 8 }, (_, i) => ({ id: String(i), value: i })) }
  const after = copy(before)
  for (let j = 0; j < 10; j++) {
    const op = random(4), at = random(after.slides.length || 1)
    if (op === 0) after.slides.splice(at, 1)
    if (op === 1) after.slides.splice(at, 0, { id: `new-${j}`, value: j })
    if (op === 2) after.slides.reverse()
    if (op === 3 && after.slides[at]) after.slides[at].value = random(100)
  }
  const state = copy(after), redo = reverse(state, changes(before, after))
  assert.deepEqual(state, before, `undo iteration ${i}`)
  reverse(state, redo)
  assert.deepEqual(state, after, `redo iteration ${i}`)
}
{
  const s = fixture(), initial = s.doc.title
  s.commit(() => { s.doc.title = 'changed' })
  s.commit(() => {})
  s.undo()
  assert.equal(s.doc.title, initial, 'empty checkpoints do not consume Undo')
}
console.log('3000 mixed structural round trips and empty checkpoints passed')

{
  const before = JSON.parse('{"extension":{"__proto__":{"reviewHistoryProbe":true}}}')
  const after = { extension: {} }
  const delta = changes(before, after)
  reverse(after, delta, true)
  assert.deepEqual(after, before)
  assert.equal(({} as any).reviewHistoryProbe, undefined, 'extension keys never mutate prototypes')
}
console.log('extension property safety passed')
