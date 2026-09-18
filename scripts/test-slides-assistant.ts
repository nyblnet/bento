#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The Assistant drawer's two pure halves (slides/src/editor/assistant/):
//
//   node scripts/test-slides-assistant.ts
//
// WHAT THIS PROVES. material.ts: the deck leaves the page compact, with the
// room's keys and the docId stripped and every embedded asset replaced by a
// token; a reply's JSON (fenced, bare-with-a-note, or none) is found; and
// merging a slide reply keeps every other slide byte-identical, forces the
// slide's id back, restores the tokens, and ignores any collab/docId the
// model invents. transport.ts: driven by a postMessage double standing in
// for the extension's relay — describe, check, a streamed send, a refused
// send, a mid-stream error, an abort (which posts assistant.abort), a silent
// bridge (timeout), frames from another source ignored — and the presence
// test that decides whether the drawer exists at all.
//
// Security review (four conditions, each a case below): (A) describe() bounds
// host and model to a hostname / id SHAPE so a hostile bridge cannot make the
// page hold a key by smuggling it through the one field the drawer displays;
// (B) a deck reply's duplicate slide ids and duplicate element ids within a
// slide are re-minted (link/state/morph targeting and the CRDT key by id — a
// poisoned reply could split replicas); (C) the gate is a shape gate, so
// apply() cleans text/table html with sanitizeHtml, svg markup with
// sanitizeSvgMarkup and drops a `link` that is neither a web URL nor an id —
// measured in headless Chrome on the exact apply chain with the exact
// payloads, because the sanitizers need a DOM; (D) `blobs` and `comments`
// never leave the page; (E) the CALL SITE is pinned: the browser section
// drives the real AssistantPanel.apply with a fake store and the hostile
// reply, and a source assertion holds the cleanDoc line inside apply( —
// removing that one call turns 4 of the 103 checks red (measured: the two
// source pins and the two stored-document assertions — 99/103), where a rig
// that called cleanDoc itself stayed green.
//
// Contract additions (agreed with home-webext): describe `local: true` (an
// on-device model → "on this device · <display name>"), check `code:
// 'consent-pending'` (waiting text, ONE re-check on focus/visibility), error
// `code: 'consent-denied'` (a plain refusal card, deck unchanged). Keyed on
// the codes, never the text.

import { starterDoc } from '../slides/src/starterdeck.ts'
import { compactDoc, expandDoc } from '../slides/src/compact.ts'
import type { BentoDoc } from '../slides/src/model.ts'
import { elideDoc, material, mergeReply, outlineDeck } from '../slides/src/editor/assistant/material.ts'
import { CH, CODE_RE, CONTEXT_MAX, CONTEXT_MIN, ExtensionTransport, extensionPresent, HOST_RE, MODEL_RE, REQ_TIMEOUT } from '../slides/src/editor/assistant/transport.ts'
import { ADD_MAX, applyOps, INSERT_MAX } from '../slides/src/editor/assistant/ops.ts'
import { dedupeIds, cleanDoc, ID_RE } from '../slides/src/editor/assistant/material.ts'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
type Obj = Record<string, unknown>
const applyWordEdits = (compact: Obj, edits: unknown) => { const r = applyOps(compact, { edits }); const strip = (x: string) => x.replace(/^edit /, ''); return { doc: r.doc, applied: r.applied.map(strip), skipped: r.skipped.map(strip) } }
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
;(doc as Obj).blobs = { b1: { key: 'BLOBKEY-must-never-leave', bytes: PIXELS } }
doc.slides[0].notes = 'Open with the number'
doc.slides[0].comments = [{ id: 'c1', author: 'Reviewer Name', at: 1, text: 'private remark', replies: [], resolved: false }] as never

console.log('\nmaterial.ts — what leaves the page')
{
  const e = elideDoc(doc)
  const text = JSON.stringify(e.doc)
  ok(!text.includes(SECRET) && !text.includes(PRIV), 'the room key and the owner private key are not in the elided document')
  ok(!('collab' in e.doc) && !('docId' in e.doc) && !('modified' in e.doc), 'collab, docId and modified are stripped')
  ok(!text.includes(PIXELS) && text.includes('@@bento-asset-0@@'), 'an embedded image is a token, not 600 bytes of base64')
  ok(e.assets.length === 1 && e.assets[0] === PIXELS, 'the same bytes in two places are one token')
  ok(e.doc.compact === true, 'the document goes out in the compact form')
  ok(!('blobs' in e.doc), 'D — the blob store (offloaded asset keys + bytes) is not in the material')
  ok((e.doc.slides as Obj[]).every((s) => !('comments' in s)) && (e.doc.slides as Obj[])[0].notes === doc.slides[0].notes,
    'D — comments (reviewer names) stay out; speaker notes go')

  // the MATERIAL for a turn: every shape at once, the extension picks
  const { material: m, elided } = material(doc, { index: 1, selection: [] })
  const all = JSON.stringify(m)
  ok(!all.includes(SECRET) && !all.includes(PRIV) && !all.includes(PIXELS), 'no key, private key or asset bytes in any shape of the material')
  ok(CONTEXT_MIN === 1000 && CONTEXT_MAX === 10_000_000, 'the window bound the page believes: 1k–10M')
  ok(m.open === 2 && m.size.width === 1280 && m.size.height === 720, 'the open slide (1-based) and the deck size')
  ok(doc.slides.every((s) => m.outline.includes(`(id "${s.id}")`)) && doc.slides.every((s) => m.addressed.includes(`(id "${s.id}")`)), 'both outlines name every slide')
  ok(!/\[\d+\//.test(m.outline) && /^  - \[2\//m.test(m.addressed), 'the plain outline has no addresses; the addressed one has them')
  ok(!!m.focus && m.focus.kind === 'slide' && m.focus.label.startsWith(`slide 2 (id "${doc.slides[1].id}")`) && m.focus.json.includes('"elements":['), 'the focus is the open slide, as compact JSON')
  ok(!m.focus!.json.includes(`"id":"${doc.slides[0].id}"`) && !m.addressed.includes('"elements"'), 'the other slides go as outline only, never as JSON')
  ok(elided.assets.length === 1, 'the elision map stays on the page for the apply')
  ok(!('elided' in m) && !all.includes('"assets":["data:'), 'and is not part of the material')

  // with a selection the focus is the selected elements
  const selId = doc.slides[1].elements[0].id
  const sel = material(doc, { index: 1, selection: [selId, 'no-such-id'] }).material
  ok(!!sel.focus && sel.focus.kind === 'elements' && sel.focus.label.startsWith('the selected element on slide 2') && sel.focus.json.includes(`"id":"${selId}"`), 'a selected element is the focus, addressed 2/<id>; ids that are not on the slide are ignored')
  const sel2 = material(doc, { index: 1, selection: doc.slides[1].elements.slice(0, 2).map((x) => x.id) }).material
  ok(!!sel2.focus && sel2.focus.kind === 'elements' && sel2.focus.label.startsWith('the 2 selected elements on slide 2'), 'two selected elements: both go')
  ok(material({ ...doc, slides: [] } as never, { index: 0, selection: [] }).material.focus === null, 'an empty deck has no focus')

  // G — an embed carries a whole other document: its envelope must not leave, and must come back intact
  {
    const INNERKEY = 'INNERKEY-must-never-leave'; const INNERID = 'INNER-ID-9999'
    const d2 = starterDoc() as BentoDoc & Obj
    const emb = { id: 'emb', type: 'embed', app: 'bento/dash', x: 0, y: 0, w: 300, h: 200, rotation: 0, opacity: 1, view: '<svg viewBox="0 0 10 10"><rect width="9" height="9"/></svg>', doc: { format: 'bento/dash', docId: INNERID, collab: { key: INNERKEY }, cells: [[1, 2]] } }
    d2.slides[0].elements.push(emb as never)
    const whole = material(d2, { index: 0, selection: [] })
    const sel = material(d2, { index: 0, selection: ['emb'] })
    const shapes = JSON.stringify(whole.material) + JSON.stringify(sel.material)
    ok(!shapes.includes(INNERKEY) && !shapes.includes(INNERID) && !shapes.includes('<rect width="9"'), 'G — an embed\'s document and render are in no shape of the material (slide focus, element focus, outlines)')
    ok(sel.material.focus!.json.includes('"type":"embed"') && sel.material.focus!.json.includes('"app":"bento/dash"'), 'G — the embed itself is still there for the model to see (type, app, frame)')
    ok(whole.elided.embeds.size === 1 && (whole.elided.embeds.get(`${d2.slides[0].id}\u001femb`)!.doc as Obj).docId === INNERID, 'G — the page holds them back in the elision map')
    const r = applyOps(whole.elided.doc, { set: [{ id: '1/emb', x: 50, doc: { docId: 'FORGED', collab: { key: 'FORGED' } }, view: '<svg onload="1"/>' }], insert: [{ slide: 1, type: 'embed', app: 'web', x: 0, y: 0, w: 1, h: 1, doc: { collab: { key: 'FORGED2' } }, view: '<svg/>' }] })
    const merged = JSON.parse(mergeReply(d2, r.doc, whole.elided)!) as Obj
    const back = ((merged.slides as Obj[])[0].elements as Obj[]).find((e) => e.id === 'emb')!
    ok(back.x === 50 && (back.doc as Obj).docId === INNERID && ((back.doc as Obj).collab as Obj).key === INNERKEY && String(back.view).includes('<rect width="9"'), 'G — on apply the embed gets its own document and render back, unchanged; the set of x landed')
    const inserted = ((merged.slides as Obj[])[0].elements as Obj[]).find((e) => e.type === 'embed' && e.id !== 'emb')!
    ok(!!inserted && !('doc' in inserted) && !('view' in inserted) && !JSON.stringify(merged).includes('FORGED'), 'G — a set or insert can write neither doc nor view: nothing forged lands anywhere')
  }
  const themed = material({ ...doc, theme: { ...(doc as Obj).theme as Obj, accent: '#123456' } } as never, { index: 0, selection: [] }).material
  ok(typeof themed.theme === 'string' && themed.theme.includes('#123456'), 'the theme rides as JSON when the deck has one (non-default slots only — compact strips the defaults)')
}

// The outlines — measured against the starter deck, the deck a fresh build
// opens with, because a small window is what made this matter.
console.log('\nmaterial.ts — the outlines')
{
  const starter = starterDoc()
  const { material: m } = material(starter, { index: 2, selection: [] })
  const askedText = m.outline
  ok(!askedText.includes('"elements"') && !askedText.includes('"compact"'), 'no JSON in an outline')
  ok(askedText.includes('Slide 1 (id "') && askedText.includes(`Slide ${starter.slides.length} (id "`), 'the outline numbers every slide')
  const firstWords = String((starter.slides[0].elements.find((e) => e.type === 'text') as { html?: string } | undefined)?.html ?? '').replace(/<[^>]*>/g, '').trim().split(/\s+/).slice(0, 3).join(' ')
  ok(firstWords.length > 0 && askedText.includes(firstWords), `the outline carries the words on the slides ("${firstWords}…")`)
  ok(/notes: /.test(askedText), 'and the speaker notes')
  ok(/- chart: /.test(askedText), 'a chart is outlined as its series and numbers')
  ok(!/"x":|"fontSize"|"fill":/.test(askedText), 'geometry and styling stay out of an outline')
  const deckJson = JSON.stringify(compactDoc(starter)).length
  ok(m.outline.length < deckJson / 4 && m.addressed.length < deckJson / 4, `an outline is under a quarter of the deck's JSON (${m.outline.length} / ${m.addressed.length} vs ${deckJson} chars) — the JSON never goes out`)
  ok(outlineDeck({ title: 'T', slides: [{ id: 'a', elements: [{ type: 'text', html: '<p>Hello&nbsp;<b>world</b></p>' }, { type: 'table', rows: [{ cells: [{ html: 'a' }, { html: 'b' }] }] }] }] }).includes('- Hello world') , 'html is reduced to its words')

  // addressed: every text as <slide number>/<id>, the id being the one the
  // loader answers to — and ids REPEAT across slides (the morph idiom),
  // which is why the slide number is part of the address
  const wt = material(starter, { index: 0, selection: [] }).material.addressed
  const idRe = /^  - \[1\/([^\]]+)\] /m
  const mm = idRe.exec(wt)
  ok(!!mm, 'each text carries <slide number>/<id> in brackets')
  const compact = compactDoc(starter)
  const s0 = (compact.slides as Obj[])[0]
  const firstText = (s0.elements as Obj[]).findIndex((e) => e.type === 'text')
  const bareId = String((s0.elements as Obj[])[firstText].id ?? `${s0.id}-text-${firstText}`)
  const expectId = `1/${bareId}`
  ok(mm?.[1] === bareId, `the id is the one the loader answers to (${mm?.[1]}) — own id, or the minted <slide>-text-<index>`)
  ok(starter.slides.filter((s) => s.elements.some((e) => e.id === bareId)).length > 1, 'that id repeats across slides (the morph idiom) — which is why the slide number is part of the address')

  // the wording half of the patch, applied and loaded
  const { elided } = material(starter, { index: 0, selection: [] })
  const patched = applyWordEdits(elided.doc, [{ id: expectId, text: 'A **bolder** title' }, { id: 'no-such-element', text: 'x' }, { id: 12, text: 'y' }, { id: expectId }])
  ok(patched.applied.length === 1 && patched.applied[0] === expectId, 'the real text is applied')
  ok(applyWordEdits(elided.doc, [{ id: bareId, text: 'x' }]).skipped.length === 1, 'a bare id that lives on several slides is refused, not guessed')
  const onlyOnce = (compact.slides as Obj[]).flatMap((s) => (s.elements as Obj[]).filter((e) => e.type === 'text' && typeof e.id === 'string').map((e) => e.id as string)).find((id, _, all) => all.filter((y) => y === id).length === 1)
  ok(!!onlyOnce && applyWordEdits(elided.doc, [{ id: onlyOnce, text: 'x' }]).applied.length === 1, `a bare id that lives on one slide is accepted (${onlyOnce})`)
  ok(patched.skipped.length === 3, 'unknown id, non-string id and missing text are skipped (3)')
  const pel = ((patched.doc.slides as Obj[])[0].elements as Obj[])[firstText]
  ok(pel.md === 'A **bolder** title' && !('html' in pel), 'the element gets md and loses html')
  ok(JSON.stringify(elided.doc) !== JSON.stringify(patched.doc) && ((elided.doc.slides as Obj[])[0].elements as Obj[])[firstText].md === undefined, 'the elided doc itself is untouched (a copy was patched)')
  const merged = mergeReply(starter, patched.doc, elided)
  ok(!!merged, 'the patched deck merges')
  const full = expandDoc(JSON.parse(merged!))
  const fel = full.slides[0].elements.find((e) => e.id === bareId) as { html?: string } | undefined
  ok(!!fel && /<(b|strong)>bolder<\/(b|strong)>/.test(fel.html ?? '') && /A .*title/.test(fel.html ?? ''), `the loader renders the markdown (${fel?.html})`)
  ok(full.slides.length === starter.slides.length && full.slides[1].id === starter.slides[1].id, 'the other slides ride along untouched')
  const none = applyWordEdits(elided.doc, 'not a list')
  ok(none.applied.length === 0 && none.skipped.length === 0, 'a reply without a list applies nothing')
}

// The ops patch (ops.ts): everything a small model can do beyond wording —
// notes, table cells, chart numbers, enum style verbs, a slide from a
// layout, remove, move — applied to the compact doc and loaded through
// expandDoc like any agent file. Built on a fixture with a table, a chart
// and repeated ids so the addressing is exercised.
console.log('\nops.ts — the ops patch')
{
  const fixture = (): Obj => ({
    compact: true, title: 'Ops', slides: [
      { id: 'a', elements: [{ id: 'k', type: 'text', html: 'Kicker' }, { id: 't', type: 'text', html: 'Title A', fontSize: 40 }] },
      { id: 'b', notes: 'old notes', elements: [{ id: 'k', type: 'text', html: 'Kicker' }, { id: 'tbl', type: 'table', header: true, columns: [1, 1], rows: [{ cells: [{ html: 'Q' }, { html: 'Sales' }] }, { cells: [{ html: 'Q1' }, { html: '10' }] }] }] },
      { id: 'c', elements: [{ id: 'ch', type: 'chart', option: { xAxis: { data: ['Q1', 'Q2'] }, series: [{ name: 'Sales', type: 'bar', data: [1, 2] }, { name: 'Cost', type: 'bar', data: [3, 4] }] } }, { id: 'pie', type: 'chart', option: { series: [{ type: 'pie', data: [{ name: 'x', value: 1 }, { name: 'y', value: 2 }] }] } }] },
      { id: 'd', elements: [{ id: 'only', type: 'text', html: 'Unique' }] },
    ],
  })
  const ob = material(expandDoc(fixture()), { index: 1, selection: [] }).material.addressed
  ok(/\[2\/tbl\] table: r1c1: Q \| r1c2: Sales \/ r2c1: Q1 \| r2c2: 10/.test(ob), 'the addressed outline lists a table cell by cell as r<row>c<col>')
  ok(/\[3\/ch\] chart: Sales \[1, 2\]; Cost \[3, 4\] over Q1, Q2/.test(ob), 'and a chart by its series, numbers and categories')

  const r = applyOps(fixture(), {
    edits: [{ id: '1/t', text: 'Title **A2**' }, { id: 'only', text: 'Unique2' }, { id: 'k', text: 'ambiguous' }],
    notes: [{ slide: 2, text: 'new notes' }, { slide: 9, text: 'x' }],
    cells: [{ id: '2/tbl', row: 2, col: 2, text: '12 <b>' }, { id: '2/tbl', row: 5, col: 1, text: 'x' }],
    chart: [{ id: '3/ch', series: [{ name: 'Cost', data: [5, 6, 'z'] }], categories: ['Q3', 'Q4'] }, { id: '3/pie', series: [{ name: 'pie', data: [7, 8] }] }, { id: '1/t', series: [] }],
    style: [{ id: '1/t', size: 'bigger', weight: 'bold', align: 'center' }, { id: '1/k', size: 'smaller' }, { id: '1/k', size: 'huge' }],
  })
  const sl = r.doc.slides as Obj[]
  const el = (si: number, id: string) => (sl[si].elements as Obj[]).find((e) => e.id === id)!
  ok(r.applied.includes('edit 1/t') && el(0, 't').md === 'Title **A2**' && !('html' in el(0, 't')), 'edit: addressed text gets md')
  ok(r.applied.includes('edit only') && el(3, 'only').md === 'Unique2' && r.skipped.includes('edit k'), 'edit: a bare id on one slide works, on two is skipped')
  ok(sl[1].notes === 'new notes' && r.skipped.includes('notes 9'), 'notes: set on slide 2; slide 9 skipped')
  ok(((el(1, 'tbl').rows as Obj[])[1].cells as Obj[])[1].html === '12 &lt;b&gt;' && r.skipped.includes('cell 2/tbl r5c1'), 'cells: r2c2 set with the text escaped; an out-of-range row skipped')
  const ch = el(2, 'ch').option as Obj
  ok(JSON.stringify((ch.series as Obj[])[1].data) === '[5,6,0]' && JSON.stringify((ch.series as Obj[])[0].data) === '[1,2]' && JSON.stringify((ch.xAxis as Obj).data) === '["Q3","Q4"]', 'chart: the named series replaced (non-numbers → 0), the other kept, categories set')
  const pie = el(2, 'pie').option as Obj
  ok(JSON.stringify((pie.series as Obj[])[0].data) === '[{"name":"x","value":7},{"name":"y","value":8}]', 'chart: a pie keeps its slice names, numbers land by position')
  ok(r.skipped.includes('chart 1/t'), 'chart: a text target is skipped')
  ok(el(0, 't').fontSize === 50 && el(0, 't').fontWeight === 700 && el(0, 't').align === 'center', 'style: bigger ×1.25 from 40 → 50, bold, center')
  ok(el(0, 'k').fontSize === 26 && r.skipped.includes('style 1/k'), 'style: smaller from the 32 default → 26; an unknown verb alone is skipped')
  ok(!r.structural && (r.doc.slides as Obj[]).length === 4, 'content ops alone are not structural')
  const full = expandDoc(r.doc)
  ok(/<(b|strong)>A2<\/(b|strong)>/.test((full.slides[0].elements.find((e) => e.id === 't') as { html?: string }).html ?? ''), 'the patched doc loads: markdown rendered')

  const st = applyOps(fixture(), {
    add: [{ after: 1, layout: 'title-content', title: 'New', body: 'Some body', notes: 'n' }, { after: 0, layout: 'section', title: 'Start', kicker: 'PART 1' }, { after: 4, layout: 'two-col', title: 'T', left: 'L', right: 'R' }, { after: 2, layout: 'nope', title: 'x' }, { after: 99, layout: 'title' }],
    remove: [3, 42],
    move: [{ slide: 4, to: 1 }, { slide: 1, to: 1 }],
  })
  const ids = (st.doc.slides as Obj[]).map((x) => String(x.id ?? '?'))
  ok(st.structural, 'add/remove/move are structural')
  ok(r.applied.length > 0 && st.applied.includes('add title-content after 1') && st.applied.includes('add section after 0') && st.applied.includes('remove 3') && st.applied.includes('move 4→1'), 'the ops are named for the card')
  ok(st.skipped.includes('add nope') && st.skipped.includes('add title') && st.skipped.includes('remove 42') && st.skipped.includes('move 1→1'), 'unknown layout, after past the end, removing a slide that is not there, moving onto itself: skipped')
  // original: a b c d. adds attach to their ORIGINAL anchor: section at the
  // start, title-content after a, two-col after d. remove c. move d before a
  // (the move takes only d; the slide added after d stays where d was).
  const newIds = ids.filter((x) => x.startsWith('s-'))
  ok(newIds.length === 3 && new Set(newIds).size === 3 && ids.length === 6, `three new slides with fresh distinct ids (${newIds.join(', ')}), one removed → 6`)
  ok(ids.join(' ') === `${newIds[0]} d a ${newIds[1]} b ${newIds[2]}`, `order: [section] d a [title-content] b [two-col], c gone → ${ids.join(' ')}`)
  const fullSt = expandDoc(st.doc)
  const added = fullSt.slides[3]
  const title = added.elements.find((e) => (e as { role?: string }).role === 'title') as { html?: string; x?: number; w?: number } | undefined
  ok(!!title && /New/.test(title.html ?? '') && typeof title.x === 'number' && (title.w ?? 0) > 100, 'a slide added from a layout loads with its text placed by role (geometry from the layout)')
  ok(fullSt.slides[3].notes === 'n', 'and its notes')
  const twoCol = fullSt.slides[5].elements.filter((e) => /^(L|R)$|<p>(L|R)<\/p>/.test((e as { html?: string }).html ?? ''))
  ok(twoCol.length === 2 && (twoCol[0] as { x: number }).x !== (twoCol[1] as { x: number }).x, 'two-col: left and right land in different columns')
  const many = applyOps(fixture(), { add: Array.from({ length: ADD_MAX + 3 }, () => ({ after: 0, layout: 'blank' })) })
  ok((many.doc.slides as Obj[]).length === 4 + ADD_MAX && many.skipped.length === 3, `at most ${ADD_MAX} slides per reply`)
  const nothing = applyOps(fixture(), { bogus: [1], edits: 'x' })
  ok(nothing.applied.length === 0 && !nothing.structural && JSON.stringify(nothing.doc) === JSON.stringify(fixture()), 'unknown keys and non-list values change nothing')

  // the precise verbs: set / insert / delete / slide, and a designed add
  const pr = applyOps(fixture(), {
    set: [{ id: '1/t', x: 200, fill: '#123456', fontSize: 18, md: 'Set **here**', id2: 'ignored', type: 'image', collab: { key: 'X' }, __proto__: { pwn: 1 }, fontWeight: null }, { id: '2/tbl', columns: [2, 1] }, { id: 'k', x: 1 }, { id: 'nope', x: 1 }, { id: '1/k' }],
    insert: [{ slide: 1, type: 'shape', shape: 'ellipse', x: 100, y: 100, w: 50, h: 50, fill: 'red', id: 'forced', docId: 'z' }, { slide: 1, x: 1 }, { slide: 9, type: 'text' }],
    delete: ['4/only', '1/nope', 'k'],
    slide: [{ slide: 3, background: '#000', transition: 'morph', hidden: true, notes: 'n3', id: 'renamed', elements: [], layout: 7 }, { slide: 42, background: '#fff' }, { slide: 1 }],
    add: [{ after: 4, layout: 'blank', elements: [{ type: 'text', x: 96, y: 96, w: 500, h: 80, html: 'Designed', id: 'keep-me', collab: 1 }, 'junk', { x: 1 }] }],
  })
  const ps = pr.doc.slides as Obj[]
  const pt = (ps[0].elements as Obj[]).find((e) => e.id === 't')!
  ok(pr.applied.includes('set 1/t') && pt.x === 200 && pt.fill === '#123456' && pt.fontSize === 18 && pt.md === 'Set **here**' && !('html' in pt), 'set: fields merge onto the addressed element; md replaces html')
  ok(pt.type === 'text' && pt.id === 't' && !('collab' in pt) && !('id2' in pt) === false && !('pwn' in pt) && !Object.prototype.hasOwnProperty.call(pt, '__proto__'), 'set: id, type, collab and __proto__ never land (an unknown field like id2 does — the gate judges it)')
  ok(!('fontWeight' in pt), 'set: null deletes a field')
  ok(JSON.stringify((ps[1].elements as Obj[]).find((e) => e.id === 'tbl')!.columns) === '[2,1]', 'set: works on any element type (a table\'s columns)')
  ok(pr.skipped.includes('set k') && pr.skipped.includes('set nope') && pr.skipped.includes('set 1/k'), 'set: ambiguous, unknown, and nothing-to-set are skipped')
  const ins = (ps[0].elements as Obj[]).find((e) => e.type === 'shape')!
  ok(pr.applied.includes('insert shape on 1') && ins.shape === 'ellipse' && ins.fill === 'red' && typeof ins.id === 'string' && ins.id !== 'forced' && !('docId' in ins) && !('slide' in ins), 'insert: the element lands on the slide with a fresh id; a supplied id and docId are dropped')
  ok(pr.skipped.includes('insert ?') && pr.skipped.includes('insert text'), 'insert: no type, or a slide that is not there → skipped')
  ok(pr.applied.includes('delete 4/only') && (ps[3].elements as Obj[]).length === 0 && pr.skipped.includes('delete 1/nope') && pr.skipped.includes('delete k'), 'delete: removes the addressed element; unknown and ambiguous skipped')
  ok(pr.applied.includes('slide 3') && ps[2].background === '#000' && ps[2].transition === 'morph' && ps[2].hidden === true && ps[2].notes === 'n3' && ps[2].id === 'c' && Array.isArray(ps[2].elements) && (ps[2].elements as Obj[]).length === 2 && !('layout' in ps[2]), 'slide: whitelisted fields only — id, elements and a non-string layout never land')
  ok(pr.skipped.includes('slide 42') && pr.skipped.includes('slide 1'), 'slide: out of range, or nothing to set → skipped')
  const designed = ps[ps.length - 1]
  ok(pr.applied.includes('add blank after 4') && (designed.elements as Obj[]).length === 1 && (designed.elements as Obj[])[0].html === 'Designed' && (designed.elements as Obj[])[0].id === 'keep-me' && !('collab' in (designed.elements as Obj[])[0]), 'add with elements: a designed slide carries its full elements (junk and typeless dropped, collab stripped, the id kept for the loader to check)')
  const pfull = expandDoc(pr.doc)
  ok(pfull.slides.length === 5 && (pfull.slides[0].elements.find((e) => e.id === 't') as { x: number }).x === 200 && pfull.slides[4].elements.some((e) => (e as Obj).html === 'Designed'), 'the precisely patched deck loads')
  const lim = applyOps(fixture(), { insert: Array.from({ length: INSERT_MAX + 2 }, () => ({ slide: 1, type: 'text', html: 'x' })) })
  ok(lim.applied.length === INSERT_MAX && lim.skipped.length === 2, `at most ${INSERT_MAX} inserts per reply`)
}


console.log('\nmaterial.ts — merging the patched deck')
{
  const base = compactDoc(doc)
  const { elided } = material(doc, { index: 1, selection: [] })
  // a patch that touched slide 2 and added a slide, plus everything a model must not be able to smuggle
  const r = applyOps(elided.doc, { insert: [{ slide: 2, type: 'text', x: 96, y: 600, w: 400, h: 60, html: 'Added' }], add: [{ after: doc.slides.length, layout: 'blank', title: 'x' }] })
  const merged = mergeReply(doc, { ...r.doc, collab: { key: 'FAKE' }, docId: 'nope', blobs: { z: 1 } }, elided)
  ok(!!merged, 'the patched deck merges')
  const m = JSON.parse(merged!) as Obj
  const slides = m.slides as Obj[]
  ok(!('collab' in m) && m.docId === 'doc-1234-5678' && !('blobs' in m), 'collab and blobs the model wrote are dropped; docId is the live document\'s')
  ok(JSON.stringify(slides[1]).includes(PIXELS) && !JSON.stringify(m).includes('@@bento-asset'), 'the asset token is restored to the bytes')
  ok(canon(slides[0]) === canon((base.slides as Obj[])[0]) && canon(slides[2]) === canon((base.slides as Obj[])[2]), 'untouched slides are byte-identical to the live compact form')
  ok((slides[1].elements as Obj[]).length === ((base.slides as Obj[])[1].elements as Obj[]).length + 1, 'the inserted element is there')
  ok(slides.length === doc.slides.length + 1 && m.compact === true, 'the added slide is there; the deck is flagged compact')
  const full = expandDoc(m as never)
  ok(full.slides.length === doc.slides.length + 1 && full.slides[1].elements.some((e) => (e as Obj).html === 'Added'), 'the merged compact doc expands to a full deck with the edit')
  ok(canon(full.slides[0]) === canon(doc.slides[0]), 'and an untouched slide expands to exactly what it was')
  ok(mergeReply(doc, { title: 'x' }, elided) === null, 'a value without slides is refused')
  ok(slides[0].comments !== undefined && JSON.stringify(slides[0].comments).includes('Reviewer Name'),
    'D — on apply the live document\'s comments come back onto the slides that still exist')
  ok(!JSON.stringify(m).includes('BLOBKEY'), 'D — and the merged deck cannot carry blobs')

  // B — duplicate ids in a patched deck (a reply's add could name an existing slide)
  const dup = { compact: true, slides: [
    { id: 'dup', elements: [{ id: 'e', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'a' }, { id: 'e', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'b' }, [{ id: 'e', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1 }]] },
    { id: 'dup', elements: [{ id: 'e', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'c' }] },
    { id: 'dup', elements: [] },
    { id: 's3', elements: [] },
  ] }
  const fixed = dedupeIds(JSON.parse(JSON.stringify(dup)))
  ok(fixed === 4, `B — four repeats re-minted (2 slides + 2 elements), got ${fixed}`)
  const dd = JSON.parse(mergeReply(doc, dup, elided)!) as Obj
  const ids = (dd.slides as Obj[]).map((s) => s.id)
  ok(new Set(ids).size === ids.length && ids[0] === 'dup' && ids[1] === 's2' && ids[2] === 's3-2' && ids[3] === 's3',
    `B — slide ids unique after merge: ${ids.join(' ')} (first keeps its id; repeats mint s<n>, suffixed past a taken one)`)
  const e0 = ((dd.slides as Obj[])[0].elements as unknown[]).flat() as Obj[]
  ok(new Set(e0.map((e) => e.id)).size === 3 && e0[0].id === 'e' && e0[1].id === 'dup-text-1' && e0[2].id === 'dup-shape-2',
    `B — element ids unique within the slide: ${e0.map((e) => e.id).join(' ')}`)
  ok(((dd.slides as Obj[])[1].elements as Obj[])[0].id === 'e', 'B — the same element id on ANOTHER slide stays (the morph idiom)')
  ok(dedupeIds({ slides: [{ id: 'a', elements: [{ id: 'x' }] }, { id: 'b', elements: [{ id: 'x' }] }] }) === 0, 'B — a clean deck is untouched')
}

console.log('\nmaterial.ts — link shapes (C, the pure half)')
{
  ok(ID_RE.test('sd-intro') && ID_RE.test('s1') && ID_RE.test('a.b:c/d-e_f'), 'an id-shaped link is accepted')
  ok(!ID_RE.test('bad id!') && !ID_RE.test('') && !ID_RE.test('x'.repeat(121)) && !ID_RE.test('javascript:alert(1)'), 'spaces, empty, over-long and a scheme are not ids')
  const d = starterDoc()
  const mk = (link: unknown) => ({ id: 'l', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, link }) as never
  d.slides[0].elements = [mk('javascript:alert(1)'), mk('https://bento.page/'), mk('sd-intro'), mk('bad id!'), mk('data:text/html,x'), mk(' https://x/')]
  const n = cleanDoc(d, { html: (h) => h, svg: (m) => m, svgCss: (c) => c })
  const links = d.slides[0].elements.map((e) => (e as Obj).link)
  ok(n === 4 && links[0] === undefined && links[1] === 'https://bento.page/' && links[2] === 'sd-intro' && links[3] === undefined && links[4] === undefined && links[5] === undefined,
    `C — javascript:, data:, a malformed id and a padded URL are dropped; a web URL and an id stay (${JSON.stringify(links)})`)
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

  // A — a hostile bridge smuggling a key through host/model
  const KEY = 'sk-live-0123456789abcdef'
  w.handler = (f) => { if (f.op === 'assistant.describe') w.res(f.id, { ok: true, host: `api.example.test?key=${KEY}`, model: `m ${KEY}`, configured: true }) }
  const hostile = await tr.describe()
  ok(hostile.host === '' && hostile.model === '' && !JSON.stringify(hostile).includes(KEY), 'A — host and model outside their shapes become empty; the key never lands in the page')
  w.handler = (f) => { if (f.op === 'assistant.describe') w.res(f.id, { ok: true, host: 'localhost', model: 'gemini-2.5-flash', configured: true }) }
  const plain = await tr.describe()
  ok(plain.host === 'localhost' && plain.model === 'gemini-2.5-flash', 'A — a bare hostname and a real model id pass')
  ok(HOST_RE.test('generativelanguage.googleapis.com') && HOST_RE.test('api.openai.com') && !HOST_RE.test('localhost:11434') && !HOST_RE.test('x'.repeat(254)) && !HOST_RE.test('a/b'),
    'A — host shape: letters, digits, dots, dashes, ≤253 (a port is not a hostname — describe sends the host)')
  ok(MODEL_RE.test('claude-sonnet-4-5') && MODEL_RE.test('models/gemini-2.5-flash') && MODEL_RE.test('org:ft:gpt-4o-mini:abc') && !MODEL_RE.test('m k') && !MODEL_RE.test('') && !MODEL_RE.test('x'.repeat(121)),
    'A — model shape: [A-Za-z0-9._:/-]{1,120}')

  // contract additions: local, consent codes
  w.handler = (f) => { if (f.op === 'assistant.describe') w.res(f.id, { ok: true, host: '', model: 'gemini-nano', configured: true, local: true }) }
  const loc = await tr.describe()
  ok(loc.local === true && loc.host === '' && loc.model === 'gemini-nano', 'describe: local:true with an empty host and the model id')
  w.handler = (f) => { if (f.op === 'assistant.describe') w.res(f.id, { ok: true, host: 'h.example', model: 'm', configured: true, local: 'yes' }) }
  ok((await tr.describe()).local === undefined, 'describe: local is a boolean or absent — a truthy string is not local')
  for (const [v, want, why] of [[200000, 200000, 'a whole number in range'], [6144, 6144, 'the Prompt API quota'], ['200000', undefined, 'a string'], [999, undefined, 'under 1k'], [10_000_001, undefined, 'over 10M'], [1.5e5 + 0.5, undefined, 'not an integer'], [NaN, undefined, 'NaN']] as const) {
    w.handler = (f) => { if (f.op === 'assistant.describe') w.res(f.id, { ok: true, host: 'h.example', model: 'm', configured: true, contextTokens: v }) }
    ok((await tr.describe()).contextTokens === want, `describe: contextTokens ${why} → ${want === undefined ? 'absent' : want}`)
  }
  w.handler = (f) => { if (f.op === 'assistant.check') w.res(f.id, { ok: false, reason: 'Asking you first', code: 'consent-pending' }) }
  const pend = await tr.check()
  ok(pend.ok === false && pend.code === 'consent-pending' && pend.reason === 'Asking you first', 'check: the consent-pending code rides beside the reason')
  {
    // assistant.models: read by SHAPE — a hostile bridge cannot put a label, a key or a URL in the picker
    w.handler = (f) => { if (f.op === 'assistant.models') w.res(f.id, { ok: true, models: [
      { provider: 'builtin', model: 'gemini-nano', local: true, contextTokens: 6144, current: true },
      { provider: 'gemini', model: 'gemini-3.8-flash', host: 'generativelanguage.googleapis.com', contextTokens: 1_000_000, label: 'sk-SECRET' },
      { provider: 'openai', model: 'gpt-5.6-luna', host: 'https://api.openai.com/v1?key=X' },
      { provider: 'Bad Provider', model: 'm' }, { provider: 'x', model: 'has space' }, 'junk', null, { provider: 'anthropic' },
    ] }) }
    const ms = await tr.models()
    ok(ms.length === 3, `models: 3 well-formed routes of 8 (${ms.length})`)
    ok(ms[0].provider === 'builtin' && ms[0].local === true && ms[0].contextTokens === 6144 && ms[0].current === true && ms[0].host === undefined, 'models: the on-device route with its window and current flag')
    ok(ms[1].host === 'generativelanguage.googleapis.com' && ms[1].contextTokens === 1_000_000 && !('label' in ms[1]), 'models: a hostname and window pass; an extra label does not')
    ok(ms[2].host === undefined && !JSON.stringify(ms).includes('key=X') && !JSON.stringify(ms).includes('SECRET'), 'models: a host that is not a bare hostname is dropped — nothing key-shaped reaches the page')
    w.handler = (f) => { if (f.op === 'assistant.models') w.res(f.id, { ok: false, reason: 'unknown op' }) }
    ok((await tr.models()).length === 0, 'models: an older extension without the op → no routes, no picker')
    w.handler = (f) => { if (f.op === 'assistant.models') w.res(f.id, { ok: true, models: Array.from({ length: 500 }, (_, i) => ({ provider: 'openai', model: `m${i}` })) }) }
    ok((await tr.models()).length === 200, 'models: at most 200 routes are read')
    let picked: Obj | null = null
    w.handler = (f) => { if (f.op === 'assistant.select') { picked = f.payload as Obj; w.res(f.id, { ok: true }) } }
    ok((await tr.select('gemini', 'gemini-3.8-flash')).ok === true && picked?.provider === 'gemini' && picked?.model === 'gemini-3.8-flash', 'select: posts provider + model')
    picked = null
    ok((await tr.select('Bad Provider', 'm')).ok === false && picked === null, 'select: a malformed route never leaves the page')
  }
  w.handler = (f) => { if (f.op === 'assistant.check') w.res(f.id, { ok: false, reason: 'x', code: 'Not A Code!' }) }
  ok((await tr.check() as { code?: string }).code === undefined, 'check: a code outside its shape is dropped (the page keys on codes)')
  ok(CODE_RE.test('consent-pending') && CODE_RE.test('consent-denied') && !CODE_RE.test('') && !CODE_RE.test('x'.repeat(41)), 'code shape: [a-z][a-z0-9-]{0,39}')
  await tr.openSettings()
  ok(w.sent.some((f) => f.op === 'assistant.settings.open'), 'openSettings asks the extension for its options page')

  // a turn: the page sends the request and where the user is; the extension asks for the material after consent; prose streams; done resolves
  const mat = () => ({ outline: 'O', addressed: 'A', open: 1, size: { width: 1280, height: 720 }, focus: null })
  let turnId = ''
  const seenReqs: Obj[] = []
  w.handler = (f) => {
    if (f.op === 'assistant.turn') { turnId = f.id; seenReqs.push(f as Obj); w.res(f.id, { ok: true }) }
    if (f.op === 'assistant.document') { seenReqs.push(f as Obj); w.res(f.id, { ok: true }) }
  }
  const chunks: string[] = []
  const p = tr.turn('Summarise', [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'reply' }], { index: 0, selection: ['a'] }, mat, (t) => chunks.push(t), new AbortController().signal)
  await tick()
  const tq = seenReqs.find((f) => f.op === 'assistant.turn')!
  ok(turnId !== '' && (tq.payload as Obj).request === 'Summarise' && JSON.stringify((tq.payload as Obj).history) === '[{"role":"user","text":"earlier"},{"role":"assistant","text":"reply"}]' && JSON.stringify((tq.payload as Obj).focus) === '{"index":0,"selection":["a"]}', 'turn posts the request, the history (role+text only) and the focus — no document')
  ok(!seenReqs.some((f) => f.op === 'assistant.document'), 'the document is NOT sent until the extension asks (consent first)')
  w.evt(turnId, 'assistant.document', {})
  await tick()
  const dq = seenReqs.find((f) => f.op === 'assistant.document')!
  ok(!!dq && dq.id === turnId && (dq.payload as Obj).addressed === 'A' && (dq.payload as Obj).outline === 'O', 'asked, the page answers assistant.document on the same id with the material')
  w.evt(turnId, 'assistant.chunk', { text: 'Hel' })
  w.evt(turnId, 'assistant.chunk', { text: 'lo' })
  w.evt('some-other-id', 'assistant.chunk', { text: 'NOISE' })
  w.evt(turnId, 'assistant.done', { mode: 'ask', text: 'Hello' })
  const r1 = await p
  ok(r1.mode === 'ask' && 'text' in r1 && r1.text === 'Hello' && chunks.join('') === 'Hello', 'chunks stream in order; done resolves the prose')
  ok(!chunks.includes('NOISE'), 'a frame for another id is ignored')
  {
    const acH = new AbortController()
    let hid = ''
    w.handler = (f) => { if (f.op === 'assistant.turn') { hid = f.id; seenReqs.push(f as Obj); w.res(f.id, { ok: true }) } }
    const ph = tr.turn('x', Array.from({ length: 12 }, (_, i) => ({ role: 'user' as const, text: `t${i}` })), { index: 0, selection: [] }, mat, () => {}, acH.signal)
    await tick()
    const hq = seenReqs.find((f) => f.id === hid)!
    ok(((hq.payload as Obj).history as Obj[]).length === 8 && ((hq.payload as Obj).history as Obj[])[0].text === 't4', 'the history sent is capped at the last 8 turns')
    acH.abort(); await ph.catch(() => {})
  }

  // done with ops = an edit
  w.handler = (f) => { if (f.op === 'assistant.turn') { turnId = f.id; w.res(f.id, { ok: true }) } }
  const p2 = tr.turn('Change it', [], { index: 0, selection: [] }, mat, () => {}, new AbortController().signal)
  await tick()
  w.evt(turnId, 'assistant.done', { mode: 'edit', ops: { edits: [{ id: '1/t', text: 'x' }] }, note: 'only the outline fit', focus: 'none' })
  const r2 = await p2
  ok(r2.mode === 'edit' && 'ops' in r2 && JSON.stringify(r2.ops) === '{"edits":[{"id":"1/t","text":"x"}]}' && r2.note === 'only the outline fit' && r2.focus === 'none', 'done with ops resolves the untrusted patch, the note and what focus went')
  w.handler = (f) => { if (f.op === 'assistant.turn') { turnId = f.id; w.res(f.id, { ok: true }) } }
  const p2b = tr.turn('Change it', [], { index: 0, selection: [] }, mat, () => {}, new AbortController().signal)
  await tick()
  w.evt(turnId, 'assistant.done', { mode: 'edit', ops: [1, 2], focus: 'weird' })
  const r2b = await p2b
  ok(r2b.mode === 'edit' && 'text' in r2b, 'done with ops that is not an object resolves as prose (empty), never as a patch')
  w.handler = (f) => { if (f.op === 'assistant.turn') { turnId = f.id; w.res(f.id, { ok: true }) } }
  const p2c = tr.turn('Change it', [], { index: 0, selection: [] }, mat, () => {}, new AbortController().signal)
  await tick()
  w.evt(turnId, 'assistant.done', { mode: 'edit', text: 'I cannot do that with these operations.' })
  const r2c = await p2c
  ok(r2c.mode === 'edit' && 'text' in r2c && r2c.text.startsWith('I cannot'), 'done with text on an edit = the model declined in prose')

  // refused
  w.handler = (f) => { if (f.op === 'assistant.turn') w.res(f.id, { ok: false, reason: 'not configured', code: 'not-configured' }) }
  const e1 = await tr.turn('x', [], { index: 0, selection: [] }, mat, () => {}, new AbortController().signal).then(() => null, (e: Error & { code?: string }) => e)
  ok(!!e1 && e1.message === 'not configured' && e1.code === 'not-configured', 'a refused turn rejects with the reason and its code')

  // mid-stream error
  w.handler = (f) => { if (f.op === 'assistant.turn') { turnId = f.id; w.res(f.id, { ok: true }) } }
  const p3 = tr.turn('x', [], { index: 0, selection: [] }, mat, () => {}, new AbortController().signal)
  await tick()
  w.evt(turnId, 'assistant.chunk', { text: 'part' })
  w.evt(turnId, 'assistant.error', { reason: 'HTTP 500' })
  ok(await p3.then(() => 'resolved', (e: Error) => e.message) === 'HTTP 500', 'an error event rejects with its reason')

  w.handler = (f) => { if (f.op === 'assistant.turn') { turnId = f.id; w.res(f.id, { ok: true }) } }
  const p5 = tr.turn('x', [], { index: 0, selection: [] }, mat, () => {}, new AbortController().signal)
  await tick()
  w.evt(turnId, 'assistant.error', { reason: 'The user said no', code: 'consent-denied' })
  const e5 = await p5.then(() => null, (e: Error & { code?: string }) => e)
  ok(!!e5 && e5.code === 'consent-denied' && e5.message === 'The user said no', 'an error event carries its code on the rejection')

  // abort
  const ac = new AbortController()
  w.handler = (f) => { if (f.op === 'assistant.turn') { turnId = f.id; w.res(f.id, { ok: true }) } }
  const p4 = tr.turn('x', [], { index: 0, selection: [] }, mat, () => {}, ac.signal)
  await tick()
  ac.abort()
  const r4 = await p4.then(() => 'resolved', (e: Error) => e.name)
  ok(r4 === 'AbortError', 'abort rejects with AbortError')
  const ab = [...w.sent].reverse().find((f) => f.op === 'assistant.abort')
  ok(!!ab && (ab.payload as Obj).req === turnId, 'and posts assistant.abort naming the turn')
  w.evt(turnId, 'assistant.done', { mode: 'ask', text: 'late' })
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

console.log('\npanel.ts — the call site (E, the source half)')
{
  const panel = fs.readFileSync(new URL('../slides/src/editor/assistant/panel.ts', import.meta.url), 'utf8')
  const applyAt = panel.indexOf('  apply(index')
  const applyBody = panel.slice(applyAt, panel.indexOf('\n  }\n', applyAt))
  ok(applyAt > 0 && applyBody.includes('cleanDoc(next, { html: sanitizeHtml, svg: sanitizeSvgMarkup, svgCss: sanitizeSvgCss })'),
    'E — apply( cleans the parsed document with the real sanitizers, that exact line')
  ok(applyBody.indexOf('cleanDoc(next') > 0 && applyBody.indexOf('cleanDoc(next') < applyBody.indexOf('this.store.replaceDoc(next)'), 'E — and cleans BEFORE the document is stored')
  ok(/consent-denied/.test(panel) && /consent-pending/.test(panel) && !/said no|Asking you/.test(panel), 'the panel keys on the codes, never on reason text')
}

// --- C, measured: the apply chain in a browser ----------------------------------
//
// sanitizeHtml and sanitizeSvgMarkup parse with the DOM, so the exact payloads
// from the review run through the exact chain apply() runs — mergeReply →
// parseDocInputReport → cleanDoc — in headless Chrome, and the DOCUMENT that
// would be stored is what is asserted, not the render.
const CHROME = [
  process.env.BENTO_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p): p is string => !!p && fs.existsSync(p))
  ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const probeSource = `
import { sanitizeHtml, sanitizeSvgMarkup, sanitizeSvgCss } from ${JSON.stringify(path.join(repoRoot, 'slides/src/render.ts'))}
import { parseDocInputReport } from ${JSON.stringify(path.join(repoRoot, 'slides/src/compactload.ts'))}
import { starterDoc } from ${JSON.stringify(path.join(repoRoot, 'slides/src/starterdeck.ts'))}
import { applyOps, material, mergeReply, cleanDoc } from ${JSON.stringify(path.join(repoRoot, 'slides/src/editor/assistant/material.ts'))}
import { AssistantPanel } from ${JSON.stringify(path.join(repoRoot, 'slides/src/editor/assistant/panel.ts'))}
const results = []
const check = (name, pass) => results.push([name, pass])
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
;(async () => {
const TAINT = /onerror|onclick|onload|<script|javascript:|evil\\.example/i
const fakeStore = (doc) => ({ doc, currentIndex: 0, selection: [], readOnly: false, replaced: 0, replaceDoc(next) { this.doc = next; this.replaced++ }, goTo() {}, undo() {}, commit() {}, on() { return () => {} } })
const fakeTransport = (over = {}) => ({ name: 'fake', checks: 0, describe: async () => ({ host: 'h.example', model: 'm', configured: true }), check: async function () { this.checks++; return { ok: true } }, models: async () => [], select: async () => ({ ok: true }), turn: async () => ({ mode: 'ask', text: 'ok' }), openSettings: async () => {}, ...over })
try {
  const doc = starterDoc()
  const { elided } = material(doc, { index: 0, selection: [] })
  const IMG = '<p>hi <img src=x onerror="window.__pwn=1"> <b onclick="window.__pwn=2">bold</b> <a href="javascript:window.__pwn=3">l</a></p>'
  // the hostile reply is an OPS patch now — the only shape a reply has: an
  // existing text SET to tainted html, tainted elements inserted, and an
  // asset the model tries to smuggle at the top level
  const firstText = doc.slides[0].elements.find((e) => e.type === 'text').id
  const ops = {
    set: [{ id: '1/' + firstText, html: IMG }],
    insert: [
      { slide: 1, type: 'table', x: 0, y: 50, w: 100, h: 40, columns: [{ w: 1 }, { w: 1 }], rows: [{ cells: [{ html: IMG }, { html: 'ok' }] }] },
      { slide: 1, type: 'svg', x: 0, y: 100, w: 100, h: 100, markup: '<svg viewBox="0 0 10 10"><script>window.__pwn=4</script><rect width="5" height="5" onclick="window.__pwn=5"/><style>.r{fill:red}</style></svg>', css: '@import url(https://evil.example/x.css); .r{fill:blue}' },
      { slide: 1, type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1, link: 'javascript:window.__pwn=6' },
      { slide: 1, type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1, link: 'https://bento.page/' },
      { slide: 1, type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1, link: doc.slides[0].id },
    ],
  }
  const patched = applyOps(elided.doc, ops)
  const reply = { ...patched.doc, assets: { art: '<svg viewBox="0 0 10 10"><rect width="5" height="5" onload="window.__pwn=7"/></svg>' } }
  const json = mergeReply(doc, reply, elided)
  const parsed = parseDocInputReport(json)
  const next = parsed.doc
  const before = JSON.stringify(next)
  check('C — the shape gate let the payloads through (the condition is real)', /onerror|onclick|<script|javascript:/.test(before))
  const n = cleanDoc(next, { html: sanitizeHtml, svg: sanitizeSvgMarkup, svgCss: sanitizeSvgCss })
  const s0e = next.slides[0].elements
  const byType = (t) => s0e.filter((e) => e.type === t)
  const els = { t: s0e.find((e) => e.id === firstText), tb: byType('table').at(-1), sv: byType('svg').at(-1), r1: byType('shape').at(-3), r2: byType('shape').at(-2), r3: byType('shape').at(-1) }
  const after = JSON.stringify(next)
  check('C — cleanDoc changed the six tainted values: text, cell, markup, css, link, asset (' + n + ')', n === 6)
  check('C — text html: no <img onerror>, no on* handler, no javascript: href', !/onerror|onclick|javascript:|<img/i.test(els.t.html) && /bold/.test(els.t.html))
  check('C — table cell html cleaned the same way', !/onerror|onclick|javascript:/i.test(els.tb.rows[0].cells[0].html) && els.tb.rows[0].cells[1].html === 'ok')
  check('C — svg markup: <script> and onclick gone, <rect> and its <style> kept UNSCOPED', !/<script|onclick/i.test(els.sv.markup) && /<rect/.test(els.sv.markup) && /\\.r\\{fill:red\\}/.test(els.sv.markup) && !/data-el-id/.test(els.sv.markup))
  check('C — svg css: @import refused, the rule kept', !/evil\\.example/.test(els.sv.css) && /fill:blue/.test(els.sv.css))
  check('C — an asset smuggled at the top level of a patched deck is walked too', !/onload/i.test(next.assets.art) && /<rect/.test(next.assets.art))
  check('C — link: javascript: dropped, web URL and slide id kept', els.r1.link === undefined && els.r2.link === 'https://bento.page/' && els.r3.link === doc.slides[0].id)
  check('C — nothing executable is left anywhere in the document to be stored', !/onerror|onclick|onload|<script|javascript:|evil\\.example/i.test(after))
  check('C — nothing ran while cleaning', window.__pwn === undefined)

  // E — the REAL apply: the same hostile reply through AssistantPanel.apply with a fake store
  {
    const doc2 = starterDoc()
    const store = fakeStore(doc2)
    const panel = new AssistantPanel({ store, transport: fakeTransport() })
    document.body.appendChild(panel.root)
    const { elided: el2 } = material(doc2, { index: 0, selection: [] })
    panel.apply(0, { ...applyOps(el2.doc, ops).doc, assets: reply.assets }, el2, ['set 1/' + firstText])
    const stored = JSON.stringify(store.doc)
    const s0 = store.doc.slides[0]
    check('E — the real apply() stored ONE document (replaceDoc once)', store.replaced === 1 && store.doc !== doc2)
    check('E — and the stored document is clean: no handler, script, javascript: link or @import anywhere', !TAINT.test(stored))
    const bt = (t) => s0.elements.filter((e) => e.type === t)
    const e2 = { t: s0.elements.find((e) => e.id === firstText), sv: bt('svg').at(-1), r1: bt('shape').at(-3), r2: bt('shape').at(-2) }
    check('E — text, cell, svg markup, css, asset cleaned and the javascript: link dropped through the real path',
      /bold/.test(e2.t.html) && !/onerror/.test(e2.t.html) && /<rect/.test(e2.sv.markup) && /fill:blue/.test(e2.sv.css) && /<rect/.test(store.doc.assets.art) && e2.r1.link === undefined && e2.r2.link === 'https://bento.page/')
    check('E — the result card is there with Undo', !!panel.root.querySelector('.ed-assist-card .ed-assist-undo'))
    check('E — nothing ran', window.__pwn === undefined)
  }

  // F — capabilities are the user's: live never lands; a remote URL a patch introduces is named on the card
  {
    const doc3 = starterDoc()
    const store = fakeStore(doc3)
    const panel = new AssistantPanel({ store, transport: fakeTransport() })
    document.body.appendChild(panel.root)
    const { elided: el3 } = material(doc3, { index: 0, selection: [] })
    const r3 = applyOps(el3.doc, { insert: [{ slide: 1, type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'https://tracker.example/p.gif?u=1' }, { slide: 1, type: 'embed', x: 0, y: 0, w: 10, h: 10, url: 'https://example.org/x', live: true }], set: [{ id: '1/' + doc3.slides[0].elements[0].id, live: true, fill: '#abc' }] })
    check('F — live is a locked field: neither the inserted embed nor the set element carries it', r3.doc.slides[0].elements.every((e) => !('live' in e)) && r3.applied.some((a) => a.startsWith('set ')))
    panel.apply(0, r3.doc, el3, r3.applied)
    const remote = panel.root.querySelector('.ed-assist-card-remote')
    check('F — the card names the hosts the patch made the deck load from: ' + (remote && remote.textContent), !!remote && /tracker\\.example\\/p\\.gif/.test(remote.textContent) && /example\\.org\\/x/.test(remote.textContent) && !/u=1/.test(remote.textContent))
    const r4 = applyOps(el3.doc, { set: [{ id: '1/' + doc3.slides[0].elements[0].id, fill: '#abc' }] })
    panel.apply(0, r4.doc, el3, r4.applied)
    const cards = panel.root.querySelectorAll('.ed-assist-card')
    check('F — a patch that adds no remote URL gets no such line', cards.length === 2 && !cards[1].querySelector('.ed-assist-card-remote'))
  }

  // contract: local model display; consent-pending → waiting + one re-check on focus; consent-denied → refusal card
  {
    const store = fakeStore(starterDoc())
    const tr = fakeTransport({ describe: async () => ({ host: '', model: 'gemini-nano', configured: true, local: true }) })
    const panel = new AssistantPanel({ store, transport: tr })
    document.body.appendChild(panel.root)
    panel.setOpen(true, false); await tick(60)
    const status = panel.root.querySelector('.ed-assist-status').textContent
    check('local: the route line reads "on this device · Gemini Nano" (id → display name), no host: ' + status, /on this device · Gemini Nano/.test(status) && !/h\\.example/.test(status))
    check('one route: no picker', !panel.root.querySelector('.ed-assist-model'))
  }
  {
    // several routes: a picker in the status line; choosing one is select → describe again
    const store = fakeStore(starterDoc())
    let current = { provider: 'builtin', model: 'gemini-nano' }
    const selected = []
    const tr = fakeTransport({
      describe: async () => current.provider === 'builtin' ? { host: '', model: 'gemini-nano', configured: true, local: true, contextTokens: 6144 } : { host: 'generativelanguage.googleapis.com', model: current.model, configured: true, contextTokens: 1000000 },
      models: async () => [
        { provider: 'builtin', model: 'gemini-nano', local: true, contextTokens: 6144, current: current.provider === 'builtin' },
        { provider: 'gemini', model: 'gemini-3.8-flash', host: 'generativelanguage.googleapis.com', contextTokens: 1000000, current: current.provider === 'gemini' },
        { provider: 'gemini', model: 'gemini-3.8-pro', host: 'generativelanguage.googleapis.com', contextTokens: 1000000 },
      ],
      select: async (provider, model) => { selected.push([provider, model]); current = { provider, model }; return { ok: true } },
    })
    const panel = new AssistantPanel({ store, transport: tr })
    document.body.appendChild(panel.root)
    panel.setOpen(true, false); await tick(60)
    const sel = panel.root.querySelector('.ed-assist-model')
    check('several routes: a picker with one optgroup per provider and the window beside each model', !!sel && sel.querySelectorAll('optgroup').length === 2 && sel.options.length === 3 && /Gemini Nano · 6k/.test(sel.options[0].textContent) && /gemini-3\.8-flash · 1M/.test(sel.options[1].textContent))
    check('several routes: the current route is selected', sel.selectedIndex === 0)
    sel.selectedIndex = 1
    sel.dispatchEvent(new Event('change'))
    await tick(60)
    const sel2 = panel.root.querySelector('.ed-assist-model')
    check('choosing: assistant.select with provider + model, then describe again → the picker shows the new route as current', selected.length === 1 && selected[0][0] === 'gemini' && selected[0][1] === 'gemini-3.8-flash' && sel2 && sel2.selectedIndex === 1)
    check('choosing: the check ran again for the new route', tr.checks >= 2)
    const tr2 = fakeTransport({ describe: async () => ({ host: '', model: 'some-new-id', configured: true, local: true }) })
    const panel2 = new AssistantPanel({ store, transport: tr2 }); document.body.appendChild(panel2.root); panel2.setOpen(true, false); await tick(60)
    check('local: an unknown id displays as-is', /on this device · some-new-id/.test(panel2.root.querySelector('.ed-assist-status').textContent))
  }
  {
    const store = fakeStore(starterDoc())
    let pending = true
    const tr = fakeTransport({ check: async function () { this.checks++; return pending ? { ok: false, reason: 'Asking', code: 'consent-pending' } : { ok: true } } })
    const panel = new AssistantPanel({ store, transport: tr })
    document.body.appendChild(panel.root)
    panel.setOpen(true, false); await tick(60)
    const st = () => panel.root.querySelector('.ed-assist-status').textContent
    check('consent-pending: the waiting line is the extension reason (it localizes) and the input is disabled: ' + st(), /Asking/.test(st()) && panel.root.querySelector('.ed-assist-input').disabled && tr.checks === 1)
    check('consent-pending: the behaviour is keyed on the code, the text is only shown', panel.root.querySelector('.ed-assist-waiting') !== null)
    window.dispatchEvent(new Event('focus')); await tick(60)
    check('consent-pending: focus re-ran check once, still pending → still waiting', tr.checks === 2 && /Asking/.test(st()))
    pending = false
    window.dispatchEvent(new Event('focus')); await tick(60)
    check('consent-pending: the next return re-checks once more, ok → the route line, input enabled', tr.checks === 3 && /via fake · h\\.example · m/.test(st()) && !panel.root.querySelector('.ed-assist-input').disabled)
    window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); await tick(60)
    check('consent-pending: once resolved, focus/visibility no longer re-check', tr.checks === 3)
  }
  {
    const store = fakeStore(starterDoc())
    const before = JSON.stringify(store.doc)
    const tr = fakeTransport({ turn: async () => { const e = new Error('Permission was refused on this device — nothing was changed.'); e.code = 'consent-denied'; throw e } })
    const panel = new AssistantPanel({ store, transport: tr })
    document.body.appendChild(panel.root)
    panel.setOpen(true, false); await tick(60)
    panel.root.querySelector('.ed-assist-input').value = 'do it'
    await panel.submit(); await tick(30)
    const card = panel.root.querySelector('.ed-assist-refused')
    check('consent-denied: a plain refusal line in the extension words (it localizes), styled by the CODE not as a failure', !!card && /Permission was refused on this device/.test(card.textContent) && !card.classList.contains('ed-assist-err'))
    check('consent-denied: the deck is unchanged', store.replaced === 0 && JSON.stringify(store.doc) === before)
    check('consent-denied: the drawer is usable again', !panel.root.querySelector('.ed-assist-input').disabled && panel.root.querySelector('.ed-assist-send').textContent === 'Send')
  }
  {
    // the turn through the panel: the extension asks for the material (the page supplies it from the live document), an ops reply is applied, a note is shown
    const store = fakeStore(starterDoc())
    const turns = []
    const firstText = store.doc.slides[0].elements.find((e) => e.type === 'text').id
    const tr = fakeTransport({ describe: async () => ({ host: '', model: 'gemini-nano', configured: true, local: true }), turn: async (request, history, focus, material, onChunk, signal) => {
      const m = material()
      turns.push({ request, history, focus, m })
      return { mode: 'edit', ops: { edits: [{ id: '1/' + firstText, text: 'A **new** title' }] }, note: 'Only the outline fit this model', focus: 'none' }
    } })
    const panel = new AssistantPanel({ store, transport: tr })
    document.body.appendChild(panel.root)
    panel.setOpen(true, false); await tick(60)
    panel.root.querySelector('.ed-assist-input').value = 'update the title to something creative'
    await panel.submit(); await tick(30)
    check('turn: the panel sends the request, the (empty) history and the focus, and supplies the material on demand', turns.length === 1 && turns[0].request === 'update the title to something creative' && turns[0].history.length === 0 && turns[0].focus.index === 0 && typeof turns[0].m.addressed === 'string' && turns[0].m.focus && turns[0].m.focus.kind === 'slide')
    check('turn: the ops reply is applied through the real apply (replaceDoc once) and the note shown', store.replaced === 1 && /Only the outline fit/.test(panel.root.textContent) && /new/.test(store.doc.slides[0].elements.find((e) => e.id === firstText).html))
    check('turn: the card names the op', /Applied: edit 1\\//.test(panel.root.querySelector('.ed-assist-card-h').textContent))
    const store2 = fakeStore(starterDoc())
    const tr1 = fakeTransport({ turn: async () => ({ mode: 'edit', text: 'Still just prose, sorry.' }) })
    const panel1 = new AssistantPanel({ store: store2, transport: tr1 })
    document.body.appendChild(panel1.root)
    panel1.setOpen(true, false); await tick(60)
    panel1.root.querySelector('.ed-assist-input').value = 'make it purple'
    await panel1.submit(); await tick(30)
    check('turn: an edit the model declined in prose is shown as the answer, the deck unchanged', /Still just prose/.test(panel1.root.textContent) && store2.replaced === 0)
    const tr2 = fakeTransport({ describe: async () => ({ host: 'h.example', model: 'm', configured: true }), turn: async () => ({ mode: 'ask', text: 'Your deck has seven slides.' }) })
    const panel2 = new AssistantPanel({ store, transport: tr2 })
    document.body.appendChild(panel2.root)
    panel2.setOpen(true, false); await tick(60)
    panel2.root.querySelector('.ed-assist-input').value = 'How many slides are there?'
    await panel2.submit(); await tick(30)
    // the finished reply is rendered from markdown through the sanitizer; the raw text is what Copy gives and what history carries
    const prose = panel2.root.querySelector('.ed-assist-assistant .ed-assist-prose')
    check('reply: rendered as prose (a <p>), not a pre-wrap blob', !!prose && prose.innerHTML.includes('<p>Your deck has seven slides.') && prose.querySelector('p') !== null)
    check('reply: a copy button sits on the bubble', !!panel2.root.querySelector('.ed-assist-assistant .ed-assist-copy'))
    const sends3 = []
    const tr3 = fakeTransport({ turn: async () => { sends3.push(1); return { mode: 'ask', text: ['**Bold** and a list:', '', '- one <img src=x onerror="window.__pwn3=1">', '- two'].join(String.fromCharCode(10)) } } })
    const panel3 = new AssistantPanel({ store, transport: tr3 })
    document.body.appendChild(panel3.root)
    panel3.setOpen(true, false); await tick(60)
    panel3.root.querySelector('.ed-assist-input').value = 'What is in it?'
    await panel3.submit(); await tick(30)
    const p3 = panel3.root.querySelector('.ed-assist-assistant .ed-assist-prose')
    check('reply: bold and bullets render; markup inside the model prose is sanitized (' + (p3 && p3.innerHTML.slice(0, 80)) + ')', !!p3 && (p3.querySelector('b, strong') || {}).textContent === 'Bold' && p3.querySelectorAll('li').length === 2 && !p3.querySelector('img, [onerror]') && p3.textContent.includes('<img') && window.__pwn3 === undefined)
    check('clear: the Clear button shows once there is a transcript', !panel3.root.querySelector('.ed-assist-clear').hidden)
    panel3.clear()
    check('clear: empties the log and hides itself', panel3.root.querySelector('.ed-assist-log').children.length === 0 && panel3.root.querySelector('.ed-assist-clear').hidden)
  }
  {
    // docked in a sidebar tab: always open, fills the dock; pop out → a floating window over the body, dock back → the same node returns
    const store = fakeStore(starterDoc())
    const dock = document.createElement('div'); dock.className = 'ed-assist-dock'; dock.style.height = '400px'; document.body.appendChild(dock)
    const events = []
    const panel = new AssistantPanel({ store, transport: fakeTransport(), dock })
    panel.onFloatChange = (f) => events.push(f)
    check('docked: the panel is in the dock, open, marked docked', dock.contains(panel.root) && panel.root.classList.contains('open') && panel.root.classList.contains('ed-assist-docked') && !panel.floating)
    panel.popOut()
    const win = document.querySelector('.ed-assist-float')
    check('pop out: a floating window on the body holds the same node; the dock is empty; the editor was told', !!win && win.contains(panel.root) && dock.children.length === 0 && panel.floating && events.join() === 'true' && localStorage.getItem('bento-assist-float') === 'on')
    check('pop out: the window has a size and a position on screen', win.offsetWidth >= 280 && win.offsetHeight >= 240 && win.offsetLeft >= 0 && win.offsetTop >= 0)
    panel.dockBack()
    check('dock back: the node is in the dock again, the window gone, remembered off', dock.contains(panel.root) && !document.querySelector('.ed-assist-float') && !panel.floating && events.join() === 'true,false' && localStorage.getItem('bento-assist-float') === 'off')
  }
} catch (e) { check('probe threw: ' + (e && e.message) + ' ' + (e && e.stack || '').slice(0, 300), false) }
window.__results = 'BENTO-RESULTS:' + btoa(unescape(encodeURIComponent(JSON.stringify(results)))) + ':END'
})()
`

console.log('\nthe apply chain, in a browser (C)')
if (!CHROME) {
  console.log('  ⚠ SKIPPED — no Chrome found. Set BENTO_CHROME to a binary to run this section.')
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-assistant-'))
  try {
    fs.writeFileSync(path.join(tmp, 'probe.ts'), probeSource)
    execFileSync(path.join(repoRoot, 'slides/node_modules/.bin/esbuild'), [path.join(tmp, 'probe.ts'), '--bundle', '--format=iife', '--outfile=' + path.join(tmp, 'probe.js')], { stdio: 'pipe' })
    // a classic script from file:// (a module would be blocked by CORS there); written by concatenation, never a literal script-close
    fs.writeFileSync(path.join(tmp, 'probe.html'), '<!doctype html><meta charset="utf-8"><body><scr' + 'ipt src="probe.js"></scr' + 'ipt></body>')
    // Driven over CDP rather than --dump-dom: the probe awaits (a re-check on
    // focus, a refused send), and the new headless fires dump-dom at load.
    const port = 9700 + Math.floor(Math.random() * 200)
    const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--allow-file-access-from-files', '--user-data-dir=' + path.join(tmp, 'profile'), `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' })
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    let wsUrl = ''
    for (let i = 0; i < 80 && !wsUrl; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('file://' + path.join(tmp, 'probe.html'))}`, { method: 'PUT' }); if (r.ok) wsUrl = (await r.json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl } catch { /* not up yet */ }
      if (!wsUrl) await sleep(250)
    }
    let dom = ''
    if (wsUrl) {
      const ws = new WebSocket(wsUrl)
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      let id = 0
      const pending = new Map<number, (v: { result?: { value?: unknown } }) => void>()
      ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? {}); pending.delete(m.id) } })
      const evaluate = (expression: string) => new Promise<unknown>((resolve) => { const i = ++id; pending.set(i, (r) => resolve(r.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })) })
      for (let i = 0; i < 100; i++) {
        const v = await evaluate('window.__results || ""')
        if (typeof v === 'string' && v) { dom = v; break }
        await sleep(200)
      }
      ws.close()
    }
    child.kill('SIGKILL')
    const blob = /BENTO-RESULTS:([A-Za-z0-9+/=]+):END/.exec(dom)
    if (!blob) ok(false, 'the browser probe reported results (it did not)')
    else for (const [name, pass] of JSON.parse(Buffer.from(blob[1], 'base64').toString('utf8')) as Array<[string, boolean]>) ok(pass, name)
  } finally {
    // Chrome may still be flushing its profile: retry, and never let cleanup fail the run
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* a stray temp dir is not a finding */ }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
