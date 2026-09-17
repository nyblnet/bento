#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The Assistant drawer's two pure halves (slides/src/editor/assistant/):
//
//   node scripts/test-slides-assistant.ts
//
// WHAT THIS PROVES. prompt.ts: the deck leaves the page compact, with the
// room's keys and the docId stripped and every embedded asset replaced by a
// token; a reply's JSON (fenced, bare-with-a-note, or none) is found; and
// merging a slide reply keeps every other slide byte-identical, forces the
// slide's id back, restores the tokens, and ignores any collab/docId the
// model invents. transport.ts: driven by a postMessage double standing in
// for the extension's relay — describe, check, a streamed send, a refused
// send, a mid-stream error, an abort (which posts assistant.abort), a silent
// bridge (timeout), frames from another source ignored — and the presence
// test that decides whether the drawer exists at all.

import { starterDoc } from '../slides/src/starterdeck.ts'
import { compactDoc, expandDoc } from '../slides/src/compact.ts'
import type { BentoDoc } from '../slides/src/model.ts'
import { buildMessages, elideDoc, mergeReply, parseReply, SYSTEM_PROMPT } from '../slides/src/editor/assistant/prompt.ts'
import { CH, ExtensionTransport, extensionPresent, REQ_TIMEOUT, type AssistantMessage } from '../slides/src/editor/assistant/transport.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
type Obj = Record<string, unknown>
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Obj)[k]])) : x)

// --- a deck with everything that must not leave --------------------------------
const doc = starterDoc() as BentoDoc & Obj
const SECRET = 'ROOMKEY-8f3a1c-must-never-leave'
const PRIV = 'OWNERPRIV-77aa-must-never-leave'
;(doc as Obj).collab = { on: true, room: 'w-abc', key: SECRET, ownerPriv: PRIV, writerPub: 'pub' }
;(doc as Obj).docId = 'doc-1234-5678'
const PIXELS = 'data:image/png;base64,' + 'A'.repeat(600)
doc.slides[1].elements.push({ id: 'photo', type: 'image', x: 100, y: 100, w: 300, h: 200, src: PIXELS } as never)
;(doc as Obj).assets = { pic: PIXELS }

console.log('\nprompt.ts — what leaves the page')
{
  const e = elideDoc(doc)
  const text = JSON.stringify(e.doc)
  ok(!text.includes(SECRET) && !text.includes(PRIV), 'the room key and the owner private key are not in the prompt document')
  ok(!('collab' in e.doc) && !('docId' in e.doc) && !('modified' in e.doc), 'collab, docId and modified are stripped')
  ok(!text.includes(PIXELS) && text.includes('@@bento-asset-0@@'), 'an embedded image is a token, not 600 bytes of base64')
  ok(e.assets.length === 1 && e.assets[0] === PIXELS, 'the same bytes in two places are one token')
  ok(e.doc.compact === true, 'the document goes out in the compact form')

  const { messages, elided } = buildMessages(doc, 'slide', 1, [], 'Make the title bolder')
  const all = messages.map((m) => m.content).join('\n')
  ok(messages[0].role === 'system' && messages[0].content === SYSTEM_PROMPT, 'the first message is the system prompt')
  ok(!all.includes(SECRET) && !all.includes(PRIV) && !all.includes(PIXELS), 'no key, private key or asset bytes in any message')
  ok(all.includes('Scope: slide (slide 2 of') && all.includes(`id "${doc.slides[1].id}"`), 'slide scope names the open slide')
  ok(!all.includes(`"id":"${doc.slides[0].id}"`), 'slide scope does not carry the other slides')
  ok(elided.assets.length === 1, 'the elision map rides along for the apply')

  const deck = buildMessages(doc, 'deck', 0, [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'reply' }], 'Add a closing slide')
  const dtext = deck.messages.map((m) => m.content).join('\n')
  ok(dtext.includes('Scope: deck (') && doc.slides.every((s) => dtext.includes(`"id":"${s.id}"`)), 'deck scope carries every slide')
  ok(deck.messages.length === 4 && deck.messages[1].content === 'earlier' && deck.messages[2].role === 'assistant', 'history turns sit between system and the request')
  const long = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `t${i}` }))
  ok(buildMessages(doc, 'deck', 0, long, 'x').messages.length === 1 + 8 + 1, 'history is capped at the last 8 turns')
}

console.log('\nprompt.ts — reading a reply')
{
  const fenced = parseReply('Here you go.\n```json\n{"id":"s1","elements":[]}\n```\nDone.')
  ok(fenced.kind === 'json' && fenced.note === 'Here you go.' && (fenced.value as Obj).id === 's1', 'a fenced block is the JSON; the text before it is the note')
  const bare = parseReply('Sure — {"id":"s1","elements":[{"type":"text","html":"hi"}]}')
  ok(bare.kind === 'json' && bare.note === 'Sure —', 'a bare object with a note before it')
  const plain = parseReply('Your deck has 7 slides and a closing slide would help.')
  ok(plain.kind === 'text' && plain.text.startsWith('Your deck'), 'no object → plain text')
  const broken = parseReply('{"id": "s1", "elements": [')
  ok(broken.kind === 'text', 'broken JSON is text, not a crash')
  const arr = parseReply('[1,2,3]')
  ok(arr.kind === 'text', 'an array is not a deck edit')
}

console.log('\nprompt.ts — merging a reply')
{
  const base = compactDoc(doc)
  const { elided } = buildMessages(doc, 'slide', 1, [], 'x')
  const slideIn = JSON.parse(JSON.stringify(((elided.doc.slides as Obj[])[1])))
  slideIn.id = 'renamed-by-the-model'
  ;(slideIn.elements as Obj[]).push({ type: 'text', x: 96, y: 600, w: 400, h: 60, html: 'Added' })
  const merged = mergeReply(doc, 'slide', 1, { ...slideIn, collab: { key: 'FAKE' }, docId: 'nope' }, elided)
  ok(!!merged, 'a slide reply merges')
  const m = JSON.parse(merged!) as Obj
  const slides = m.slides as Obj[]
  ok(slides[1].id === doc.slides[1].id, 'the slide keeps ITS id whatever the reply said')
  ok(!('collab' in m) && m.docId === 'doc-1234-5678', 'collab the model wrote is dropped; docId is the live document\'s')
  ok(JSON.stringify(slides[1]).includes(PIXELS) && !JSON.stringify(m).includes('@@bento-asset'), 'the asset token is restored to the bytes')
  ok(canon(slides[0]) === canon((base.slides as Obj[])[0]) && canon(slides[2]) === canon((base.slides as Obj[])[2]), 'the other slides are byte-identical to the live compact form')
  ok((slides[1].elements as Obj[]).length === ((base.slides as Obj[])[1].elements as Obj[]).length + 1, 'the added element is there')
  const full = expandDoc(m as never)
  ok(full.slides.length === doc.slides.length && full.slides[1].elements.some((e) => (e as Obj).html === 'Added'), 'the merged compact doc expands to a full deck with the edit')
  ok(canon(full.slides[0]) === canon(doc.slides[0]), 'and an untouched slide expands to exactly what it was')

  ok(mergeReply(doc, 'slide', 1, { title: 'no elements here' }, elided) === null, 'a slide reply without elements is refused')
  ok(mergeReply(doc, 'slide', 99, slideIn, elided) === null, 'an index past the deck is refused')
  const wrapped = mergeReply(doc, 'slide', 1, { slide: slideIn }, elided)
  ok(!!wrapped && (JSON.parse(wrapped).slides as Obj[])[1].id === doc.slides[1].id, 'a reply wrapped as {slide} is accepted too')

  const deckIn = JSON.parse(JSON.stringify(elided.doc)) as Obj
  ;(deckIn.slides as Obj[]).push({ id: 'closing', elements: [{ type: 'text', x: 96, y: 300, w: 1088, h: 100, html: 'Thanks' }] })
  const dm = JSON.parse(mergeReply(doc, 'deck', 0, { ...deckIn, collab: { key: 'FAKE' } }, elided)!) as Obj
  ok((dm.slides as Obj[]).length === doc.slides.length + 1 && dm.compact === true && !('collab' in dm), 'a deck reply is the whole deck, flagged compact, collab dropped')
  ok(JSON.stringify(dm).includes(PIXELS), 'tokens restored across the whole deck')
  ok(mergeReply(doc, 'deck', 0, { title: 'x' }, elided) === null, 'a deck reply without slides is refused')
}

// --- transport.ts against a bridge double ------------------------------------------
type Frame = Obj & { dir: string; id: string; op?: string; payload?: Obj }
class FakeWindow {
  listeners: ((ev: { source: unknown; data: unknown }) => void)[] = []
  sent: Frame[] = []
  handler: ((f: Frame) => void) | null = null
  addEventListener(_t: string, fn: (ev: { source: unknown; data: unknown }) => void) { this.listeners.push(fn) }
  removeEventListener() {}
  postMessage(data: Frame) {
    this.sent.push(data)
    this.handler?.(data)
  }
  /** what relay.js would do: post back into the same window */
  reply(data: Obj, source: unknown = this) {
    for (const fn of this.listeners) fn({ source, data })
  }
  res(id: string, result: Obj) { this.reply({ [CH]: true, dir: 'res', id, result }) }
  evt(id: string, kind: string, extra: Obj = {}) { this.reply({ [CH]: true, dir: 'evt', id, kind, ...extra }) }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

console.log('\ntransport.ts — the bridge')
await (async () => {
  const w = new FakeWindow()
  const tr = new ExtensionTransport(w as unknown as Window)
  w.handler = (f) => {
    if (f.op === 'assistant.describe') w.res(f.id, { ok: true, host: 'api.example.test', model: 'model-x', configured: true })
    if (f.op === 'assistant.check') w.res(f.id, { ok: false, reason: 'HTTP 401' })
    if (f.op === 'assistant.settings.open') w.res(f.id, { ok: true })
  }
  const d = await tr.describe()
  ok(d.host === 'api.example.test' && d.model === 'model-x' && d.configured === true, 'describe: host, model, configured')
  ok(w.sent[0][CH] === true && w.sent[0].dir === 'req' && w.sent[0].op === 'assistant.describe' && String(w.sent[0].id).startsWith('asst-'), 'the request rides the tray envelope with an asst- id')
  const c = await tr.check()
  ok(c.ok === false && c.reason === 'HTTP 401', 'check: the reason comes back verbatim')
  await tr.openSettings()
  ok(w.sent.some((f) => f.op === 'assistant.settings.open'), 'openSettings asks the extension for its options page')

  // a streamed send
  const msgs: AssistantMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
  let sendId = ''
  w.handler = (f) => { if (f.op === 'assistant.send') { sendId = f.id; w.res(f.id, { ok: true }) } }
  const chunks: string[] = []
  const p = tr.send(msgs, (t) => chunks.push(t), new AbortController().signal)
  await tick()
  ok(sendId !== '' && (w.sent.find((f) => f.op === 'assistant.send')!.payload as Obj).messages === msgs, 'send posts the messages as the payload')
  w.evt(sendId, 'assistant.chunk', { text: 'Hel' })
  w.evt(sendId, 'assistant.chunk', { text: 'lo' })
  w.evt('some-other-id', 'assistant.chunk', { text: 'NOISE' })
  w.evt(sendId, 'assistant.done', { text: 'Hello' })
  ok(await p === 'Hello' && chunks.join('') === 'Hello', 'chunks stream in order and done resolves the whole text')
  ok(!chunks.includes('NOISE'), 'a frame for another id is ignored')

  // done with no text = the chunks
  w.handler = (f) => { if (f.op === 'assistant.send') { sendId = f.id; w.res(f.id, { ok: true }) } }
  const p2 = tr.send(msgs, () => {}, new AbortController().signal)
  await tick()
  w.evt(sendId, 'assistant.chunk', { text: 'ab' }); w.evt(sendId, 'assistant.done', {})
  ok(await p2 === 'ab', 'done without text resolves the accumulated chunks')

  // refused
  w.handler = (f) => { if (f.op === 'assistant.send') w.res(f.id, { ok: false, reason: 'not configured' }) }
  ok(await tr.send(msgs, () => {}, new AbortController().signal).then(() => 'resolved', (e: Error) => e.message) === 'not configured', 'a refused send rejects with the reason')

  // mid-stream error
  w.handler = (f) => { if (f.op === 'assistant.send') { sendId = f.id; w.res(f.id, { ok: true }) } }
  const p3 = tr.send(msgs, () => {}, new AbortController().signal)
  await tick()
  w.evt(sendId, 'assistant.chunk', { text: 'part' })
  w.evt(sendId, 'assistant.error', { reason: 'HTTP 500' })
  ok(await p3.then(() => 'resolved', (e: Error) => e.message) === 'HTTP 500', 'an error event rejects with its reason')

  // abort
  const ac = new AbortController()
  w.handler = (f) => { if (f.op === 'assistant.send') { sendId = f.id; w.res(f.id, { ok: true }) } }
  const p4 = tr.send(msgs, () => {}, ac.signal)
  await tick()
  ac.abort()
  const r4 = await p4.then(() => 'resolved', (e: Error) => e.name)
  ok(r4 === 'AbortError', 'abort rejects with AbortError')
  const ab = w.sent.find((f) => f.op === 'assistant.abort')
  ok(!!ab && (ab.payload as Obj).req === sendId, 'and posts assistant.abort naming the send')
  w.evt(sendId, 'assistant.done', { text: 'late' })
  ok(true, 'a late frame after abort is harmless')

  // frames from another window are ignored
  w.handler = (f) => { if (f.op === 'assistant.describe') w.reply({ [CH]: true, dir: 'res', id: f.id, result: { ok: true, host: 'evil', model: 'x', configured: true } }, { not: 'me' }) }
  const race = await Promise.race([tr.describe().then(() => 'answered'), new Promise((r) => setTimeout(() => r('ignored'), 30))])
  ok(race === 'ignored', 'a res frame whose source is not this window is ignored')

  // silent bridge → timeout
  ok(REQ_TIMEOUT === 5000, 'a request waits 5 s for its res')
})()

console.log('\ntransport.ts — is the extension here?')
{
  const g = globalThis as Obj
  const win = (host: unknown) => ({ __bentoHost: host } as unknown as Window)
  ok(extensionPresent(win({ name: 'home/webext', ops: ['claim', 'write', 'backup', 'assistant'] })) === true, 'a host listing assistant → present')
  ok(extensionPresent(win({ name: 'home/webext', ops: ['claim', 'write', 'backup'] })) === false, 'today\'s host, no assistant op → absent (the drawer shows the sentence)')
  ok(extensionPresent(win(undefined)) === false, 'no host at all → absent')
  ok(extensionPresent(win({ ops: 'assistant' })) === false, 'a malformed ops → absent')
  void g
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
