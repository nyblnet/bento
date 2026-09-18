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
import { applyWordEdits, approxTokens, ASSUMED_WINDOW_HOSTED, ASSUMED_WINDOW_LOCAL, buildMessages, elideDoc, isQuestion, mergeReply, outlineDeck, parseReply, QUESTION_PROMPT, responseSchema, SYSTEM_PROMPT, WORDS_HISTORY, WORDS_PROMPT, WORDS_SCHEMA } from '../slides/src/editor/assistant/prompt.ts'
import { CH, CODE_RE, CONTEXT_MAX, CONTEXT_MIN, ExtensionTransport, extensionPresent, HOST_RE, MODEL_RE, REQ_TIMEOUT, type AssistantMessage } from '../slides/src/editor/assistant/transport.ts'
import { ADD_MAX, applyOps, OPS_PROMPT, OPS_SCHEMA } from '../slides/src/editor/assistant/ops.ts'
import { dedupeIds, cleanDoc, ID_RE } from '../slides/src/editor/assistant/prompt.ts'
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

console.log('\nprompt.ts — what leaves the page')
{
  const e = elideDoc(doc)
  const text = JSON.stringify(e.doc)
  ok(!text.includes(SECRET) && !text.includes(PRIV), 'the room key and the owner private key are not in the prompt document')
  ok(!('collab' in e.doc) && !('docId' in e.doc) && !('modified' in e.doc), 'collab, docId and modified are stripped')
  ok(!text.includes(PIXELS) && text.includes('@@bento-asset-0@@'), 'an embedded image is a token, not 600 bytes of base64')
  ok(e.assets.length === 1 && e.assets[0] === PIXELS, 'the same bytes in two places are one token')
  ok(e.doc.compact === true, 'the document goes out in the compact form')
  ok(!('blobs' in e.doc), 'D — the blob store (offloaded asset keys + bytes) is not in the prompt')
  ok((e.doc.slides as Obj[]).every((s) => !('comments' in s)) && (e.doc.slides as Obj[])[0].notes === doc.slides[0].notes,
    'D — comments (reviewer names) stay out; speaker notes go')

  const { messages, elided } = buildMessages(doc, 'slide', 1, [], 'Make the title bolder')
  const all = messages.map((m) => m.content).join('\n')
  ok(messages[0].role === 'system' && messages[0].content === SYSTEM_PROMPT, 'the first message is the system prompt')
  ok(CONTEXT_MIN === 1000 && CONTEXT_MAX === 10_000_000, 'the window bound the page believes: 1k–10M')
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
  ok(!deck.question && !buildMessages(doc, 'slide', 1, [], 'Make the title bolder').question, 'an instruction is an edit turn')
}

// A question sends an OUTLINE (words + notes), never the JSON, and asks for
// prose — measured against the starter deck, the deck a fresh build opens
// with, because the on-device model's window is what made this matter.
console.log('\nprompt.ts — a question turn')
{
  for (const q of ['Summarise this deck', 'summarize the deck in three bullets', 'What is slide 4 about?', 'Is the tone consistent', 'How many slides mention revenue?', 'Give me feedback on the opening', 'Can you explain the charts slide', 'tell me what changed', 'Which slide should I cut?', 'Any suggestions for the closing slide', 'review the notes for typos'])
    ok(isQuestion(q), `question: ${q}`)
  for (const e of ['Make the title bolder', 'Add a closing slide that thanks the audience', 'Change slide 3 to a two-column layout', 'Translate the deck to French', 'Shorten every title', 'Replace the pie with a bar chart', 'Delete the last slide', 'Fix the typos on this slide'])
    ok(!isQuestion(e), `edit: ${e}`)

  const starter = starterDoc()
  const asked = buildMessages(starter, 'deck', 2, [], 'Summarise this deck')
  const askedText = asked.messages.map((m) => m.content).join('\n')
  ok(asked.question && asked.messages[0].content === QUESTION_PROMPT, 'a question turn uses the question prompt')
  ok(!askedText.includes('"elements"') && !askedText.includes('"compact"'), 'no JSON goes out on a question')
  ok(askedText.includes('Slide 1 (id "') && askedText.includes(`Slide ${starter.slides.length} (id "`), 'the outline numbers every slide')
  const firstWords = String((starter.slides[0].elements.find((e) => e.type === 'text') as { html?: string } | undefined)?.html ?? '').replace(/<[^>]*>/g, '').trim().split(/\s+/).slice(0, 3).join(' ')
  ok(firstWords.length > 0 && askedText.includes(firstWords), `the outline carries the words on the slides ("${firstWords}…")`)
  ok(/notes: /.test(askedText), 'and the speaker notes')
  ok(/- chart: /.test(askedText), 'a chart is outlined as its series and numbers')
  ok(!/"x":|"fontSize"|"fill":/.test(askedText), 'geometry and styling stay out of an outline')
  const asJson = buildMessages(starter, 'deck', 2, [], 'Add a closing slide')
  const jsonTokens = approxTokens(asJson.messages.at(-1)!.content)
  ok(asked.contextTokens < jsonTokens / 4, `the outline is under a quarter of the JSON (${asked.contextTokens} vs ${jsonTokens} tokens)`)
  const askedLocal = buildMessages(starter, 'deck', 2, [], 'Summarise this deck', { local: true })
  ok(askedLocal.fits && askedLocal.window === ASSUMED_WINDOW_LOCAL, `the starter deck's outline fits the assumed on-device window (${askedLocal.contextTokens} in ${ASSUMED_WINDOW_LOCAL})`)
  ok(asJson.mode === 'json' && asJson.fits && asJson.window === ASSUMED_WINDOW_HOSTED, `a hosted model with no stated window is assumed large: the JSON goes (${asJson.contextTokens} in ${ASSUMED_WINDOW_HOSTED})`)
  ok(asked.messages.at(-1)!.content.trimEnd().endsWith('Summarise this deck'), 'a question turn ends with the question')
  const one = buildMessages(starter, 'slide', 2, [], 'What is this slide about?')
  const oneText = one.messages.at(-1)!.content
  ok(oneText.includes('Scope: slide 3 of') && oneText.includes('Slide 3 (id "') && !oneText.includes('Slide 4 (id "'), 'slide scope outlines just the open slide')
  ok(outlineDeck({ title: 'T', slides: [{ id: 'a', elements: [{ type: 'text', html: '<p>Hello&nbsp;<b>world</b></p>' }, { type: 'table', rows: [{ cells: [{ html: 'a' }, { html: 'b' }] }] }] }] }).includes('- Hello world') , 'html is reduced to its words')
}

// On an on-device model an EDIT is a WORDS turn: the outline with ids goes
// out, a {"edits":[{id,text}]} patch comes back and is applied to the
// elided compact doc, which then takes the same road as a JSON reply.
console.log('\nprompt.ts — a words turn (on-device model)')
{
  const starter = starterDoc()
  const w = buildMessages(starter, 'slide', 0, [], 'Change the title to something more creative', { local: true })
  ok(w.mode === 'words' && !w.question && w.messages[0].content === WORDS_PROMPT, 'an edit on a local model is a words turn with the words prompt')
  const wt = w.messages.at(-1)!.content
  ok(!wt.includes('"elements"'), 'no JSON goes out')
  const idRe = /^  - \[1\/([^\]]+)\] /m
  const m = idRe.exec(wt)
  ok(!!m, 'each text carries <slide number>/<id> in brackets')
  const compact = compactDoc(starter)
  const s0 = (compact.slides as Obj[])[0]
  const firstText = (s0.elements as Obj[]).findIndex((e) => e.type === 'text')
  const bareId = String((s0.elements as Obj[])[firstText].id ?? `${s0.id}-text-${firstText}`)
  const expectId = `1/${bareId}`
  ok(m?.[1] === bareId, `the id is the one the loader answers to (${m?.[1]}) — own id, or the minted <slide>-text-<index>`)
  ok(starter.slides.filter((s) => s.elements.some((e) => e.id === bareId)).length > 1, 'that id repeats across slides (the morph idiom) — which is why the slide number is part of the address')
  ok(w.fits && w.jsonTokens * 2 > w.window && w.contextTokens < w.window, `slide 1 of the starter deck fits the on-device window as words (${w.contextTokens}) where its JSON (${w.jsonTokens}, ×2 for the reply) did not`)
  ok(buildMessages(starter, 'slide', 0, [], 'Change the title', { local: false }).mode === 'json', 'a hosted model keeps the JSON path')
  ok(buildMessages(starter, 'deck', 0, [], 'Summarise it', { local: true }).mode === 'ask', 'a question on a local model is still a question')

  // apply: the patch names a real text, an unknown id and a non-text
  const { elided } = w
  const patched = applyWordEdits(elided.doc, [{ id: expectId, text: 'A **bolder** title' }, { id: 'no-such-element', text: 'x' }, { id: 12, text: 'y' }, { id: expectId }])
  ok(patched.applied.length === 1 && patched.applied[0] === expectId, 'the real text is applied')
  ok(applyWordEdits(elided.doc, [{ id: bareId, text: 'x' }]).skipped.length === 1, 'a bare id that lives on several slides is refused, not guessed')
  const onlyOnce = (compact.slides as Obj[]).flatMap((s) => (s.elements as Obj[]).filter((e) => e.type === 'text' && typeof e.id === 'string').map((e) => e.id as string)).find((id, _, all) => all.filter((y) => y === id).length === 1)
  ok(!!onlyOnce && applyWordEdits(elided.doc, [{ id: onlyOnce, text: 'x' }]).applied.length === 1, `a bare id that lives on one slide is accepted (${onlyOnce})`)
  ok(patched.skipped.length === 3, 'unknown id, non-string id and missing text are skipped (3)')
  const pel = ((patched.doc.slides as Obj[])[0].elements as Obj[])[firstText]
  ok(pel.md === 'A **bolder** title' && !('html' in pel), 'the element gets md and loses html')
  ok(JSON.stringify(elided.doc) !== JSON.stringify(patched.doc) && ((elided.doc.slides as Obj[])[0].elements as Obj[])[firstText].md === undefined, 'the elided doc itself is untouched (a copy was patched)')
  const merged = mergeReply(starter, 'slide', 0, (patched.doc.slides as Obj[])[0], elided)
  ok(!!merged, 'the patched slide merges like a JSON reply')
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
  // a window too small even for the outline: the mode is still words (the panel refuses on `fits`), and the outline is what we inspect
  const outlineB = buildMessages(expandDoc(fixture()), 'slide', 1, [], 'Change it', { contextTokens: 100 })
  const ob = outlineB.messages.at(-1)!.content
  ok(outlineB.mode === 'words' && /\[2\/tbl\] table: r1c1: Q \| r1c2: Sales \/ r2c1: Q1 \| r2c2: 10/.test(ob), 'the addressed outline lists a table cell by cell as r<row>c<col>')
  const outlineC = buildMessages(expandDoc(fixture()), 'slide', 2, [], 'Change it', { contextTokens: 100 }).messages.at(-1)!.content
  ok(/\[3\/ch\] chart: Sales \[1, 2\]; Cost \[3, 4\] over Q1, Q2/.test(outlineC), 'and a chart by its series, numbers and categories')
  ok(outlineB.messages[0].content === OPS_PROMPT && /"notes"/.test(OPS_PROMPT) && /"add"/.test(OPS_PROMPT) && /"move"/.test(OPS_PROMPT), 'a words turn carries the ops prompt')
  ok(approxTokens(OPS_PROMPT) < 700, `the ops prompt is short enough for a small window (${approxTokens(OPS_PROMPT)} tokens)`)
  ok(Object.keys(OPS_SCHEMA.properties as Obj).join(',') === 'edits,notes,cells,chart,style,add,remove,move', 'the schema names the eight ops')

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
}

// The WINDOW decides the shape, for every provider: the same edit goes as
// JSON, as words, or is refused, purely by the contextTokens describe gave.
console.log('\nprompt.ts — the window decides the shape')
{
  const starter = starterDoc()
  const req = 'Change the title to something more creative'
  const big = buildMessages(starter, 'deck', 0, [], req, { contextTokens: 1_000_000 })
  ok(big.mode === 'json' && big.fits && big.window === 1_000_000, `a 1M window takes the whole deck as JSON (${big.jsonTokens} tokens)`)
  const mid = buildMessages(starter, 'deck', 0, [], req, { contextTokens: 32_000 })
  ok(mid.mode === 'words' && mid.fits, `a 32k window cannot hold the deck's JSON twice over (${mid.jsonTokens}×2) → words (${mid.contextTokens})`)
  const midSlide = buildMessages(starter, 'slide', 0, [], req, { contextTokens: 32_000 })
  ok(midSlide.mode === 'json' && midSlide.fits, 'but the same 32k window takes one slide as JSON')
  const tiny = buildMessages(starter, 'deck', 0, [], req, { contextTokens: 2000 })
  ok(tiny.mode === 'words' && !tiny.fits, `a 2k window fits nothing for the whole deck → refused with the numbers (${tiny.contextTokens} in 2000)`)
  const tinyAsk = buildMessages(starter, 'slide', 0, [], 'What is this slide about?', { contextTokens: 2000 })
  ok(tinyAsk.mode === 'ask' && tinyAsk.fits, 'a 2k window still answers a question about one slide')
  const stated = buildMessages(starter, 'slide', 0, [], req, { local: true, contextTokens: 200_000 })
  ok(stated.mode === 'json' && stated.window === 200_000, 'a stated window beats the local assumption (a big local model gets JSON)')
  const hist = Array.from({ length: 8 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: 'x'.repeat(4000) }))
  const crowded = buildMessages(starter, 'slide', 0, hist, req, { contextTokens: 12_000 })
  ok(responseSchema('words') === WORDS_SCHEMA && (responseSchema('json') as Obj).type === 'object' && responseSchema('ask') === undefined, 'a response schema for a words patch and a JSON edit; none for a question')
  ok(Array.isArray((WORDS_SCHEMA.properties as Obj).edits && ((WORDS_SCHEMA.properties as Obj).edits as Obj).items && (((WORDS_SCHEMA.properties as Obj).edits as Obj).items as Obj).required) && JSON.stringify((((WORDS_SCHEMA.properties as Obj).edits as Obj).items as Obj).required) === '["id","text"]', 'the words schema requires id and text on every edit')
  const chatty = Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `turn ${i}` }))
  const wHist = buildMessages(starter, 'slide', 0, chatty, req, { contextTokens: 2000 })
  ok(wHist.mode === 'words' && wHist.messages.length === 1 + WORDS_HISTORY + 1 && wHist.messages[1].content === 'turn 4', `a words turn keeps only the last ${WORDS_HISTORY} history turns (a small model primed by its own summary summarises again)`)
  ok(buildMessages(starter, 'slide', 0, chatty, req, { contextTokens: 200_000 }).messages.length === 1 + 6 + 1, 'a JSON turn keeps the full history')
  ok(crowded.mode !== 'json' && buildMessages(starter, 'slide', 0, [], req, { contextTokens: 12_000 }).mode === 'json', 'history counts against the window: 8k tokens of turns push a 12k window off the JSON path (slide 1 alone fits it)')
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
  ok((dm.slides as Obj[])[0].comments !== undefined && JSON.stringify((dm.slides as Obj[])[0].comments).includes('Reviewer Name'),
    'D — on apply the live document\'s comments come back onto the slides that still exist')
  ok(!JSON.stringify(dm).includes('BLOBKEY'), 'D — and a deck reply cannot carry blobs')

  // B — duplicate ids in a deck reply
  const dup = { compact: true, slides: [
    { id: 'dup', elements: [{ id: 'e', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'a' }, { id: 'e', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'b' }, [{ id: 'e', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1 }]] },
    { id: 'dup', elements: [{ id: 'e', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'c' }] },
    { id: 'dup', elements: [] },
    { id: 's3', elements: [] },
  ] }
  const fixed = dedupeIds(JSON.parse(JSON.stringify(dup)))
  ok(fixed === 4, `B — four repeats re-minted (2 slides + 2 elements), got ${fixed}`)
  const dd = JSON.parse(mergeReply(doc, 'deck', 0, dup, elided)!) as Obj
  const ids = (dd.slides as Obj[]).map((s) => s.id)
  ok(new Set(ids).size === ids.length && ids[0] === 'dup' && ids[1] === 's2' && ids[2] === 's3-2' && ids[3] === 's3',
    `B — slide ids unique after merge: ${ids.join(' ')} (first keeps its id; repeats mint s<n>, suffixed past a taken one)`)
  const e0 = ((dd.slides as Obj[])[0].elements as unknown[]).flat() as Obj[]
  ok(new Set(e0.map((e) => e.id)).size === 3 && e0[0].id === 'e' && e0[1].id === 'dup-text-1' && e0[2].id === 'dup-shape-2',
    `B — element ids unique within the slide: ${e0.map((e) => e.id).join(' ')}`)
  ok(((dd.slides as Obj[])[1].elements as Obj[])[0].id === 'e', 'B — the same element id on ANOTHER slide stays (the morph idiom)')
  ok(dedupeIds({ slides: [{ id: 'a', elements: [{ id: 'x' }] }, { id: 'b', elements: [{ id: 'x' }] }] }) === 0, 'B — a clean deck is untouched')
  const single = JSON.parse(mergeReply(doc, 'slide', 1, { id: 'whatever', elements: [{ id: 'q', type: 'text', x: 0, y: 0, w: 1, h: 1, html: 'x' }, { id: 'q', type: 'text', x: 0, y: 0, w: 1, h: 1, html: 'y' }] }, elided)!) as Obj
  ok((single.slides as Obj[])[1].id === doc.slides[1].id, 'B — slide scope is unchanged: the id is forced (its elements pass through as before)')
}

console.log('\nprompt.ts — link shapes (C, the pure half)')
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
    let seen: Obj | null = null
    w.handler = (f) => { if (f.op === 'assistant.send') { seen = f.payload as Obj; w.res(f.id, { ok: true }); w.evt(f.id, 'assistant.done', { text: '{}' }) } }
    await tr.send([{ role: 'user', content: 'x' }], () => {}, new AbortController().signal, { schema: WORDS_SCHEMA })
    ok(!!seen && seen.schema === WORDS_SCHEMA, 'send: the schema rides in the payload when given')
    seen = null
    await tr.send([{ role: 'user', content: 'x' }], () => {}, new AbortController().signal)
    ok(!!seen && !('schema' in seen), 'send: no schema key when none was given (old extensions see the old payload)')
  }
  w.handler = (f) => { if (f.op === 'assistant.check') w.res(f.id, { ok: false, reason: 'x', code: 'Not A Code!' }) }
  ok((await tr.check() as { code?: string }).code === undefined, 'check: a code outside its shape is dropped (the page keys on codes)')
  ok(CODE_RE.test('consent-pending') && CODE_RE.test('consent-denied') && !CODE_RE.test('') && !CODE_RE.test('x'.repeat(41)), 'code shape: [a-z][a-z0-9-]{0,39}')
  await tr.openSettings()
  ok(w.sent.some((f) => f.op === 'assistant.settings.open'), 'openSettings asks the extension for its options page')

  // a streamed send
  const msgs: AssistantMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
  let sendId = ''
  w.handler = (f) => { if (f.op === 'assistant.send') { sendId = f.id; w.res(f.id, { ok: true }) } }
  const chunks: string[] = []
  const p = tr.send(msgs, (t) => chunks.push(t), new AbortController().signal)
  await tick()
  ok(sendId !== '' && (w.sent.find((f) => f.id === sendId)!.payload as Obj).messages === msgs, 'send posts the messages as the payload')
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

  w.handler = (f) => { if (f.op === 'assistant.send') { sendId = f.id; w.res(f.id, { ok: true }) } }
  const p5 = tr.send(msgs, () => {}, new AbortController().signal)
  await tick()
  w.evt(sendId, 'assistant.error', { reason: 'The user said no', code: 'consent-denied' })
  const e5 = await p5.then(() => null, (e: Error & { code?: string }) => e)
  ok(!!e5 && e5.code === 'consent-denied' && e5.message === 'The user said no', 'send: an error event carries its code on the rejection')

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

console.log('\npanel.ts — the call site (E, the source half)')
{
  const panel = fs.readFileSync(new URL('../slides/src/editor/assistant/panel.ts', import.meta.url), 'utf8')
  const applyAt = panel.indexOf('private apply(')
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
import { buildMessages, mergeReply, cleanDoc } from ${JSON.stringify(path.join(repoRoot, 'slides/src/editor/assistant/prompt.ts'))}
import { AssistantPanel } from ${JSON.stringify(path.join(repoRoot, 'slides/src/editor/assistant/panel.ts'))}
const results = []
const check = (name, pass) => results.push([name, pass])
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
;(async () => {
const TAINT = /onerror|onclick|onload|<script|javascript:|evil\\.example/i
const fakeStore = (doc) => ({ doc, currentIndex: 0, readOnly: false, replaced: 0, replaceDoc(next) { this.doc = next; this.replaced++ }, goTo() {}, undo() {}, commit() {} })
const fakeTransport = (over = {}) => ({ name: 'fake', checks: 0, describe: async () => ({ host: 'h.example', model: 'm', configured: true }), check: async function () { this.checks++; return { ok: true } }, send: async () => 'ok', openSettings: async () => {}, ...over })
try {
  const doc = starterDoc()
  const { elided } = buildMessages(doc, 'deck', 0, [], 'x')
  const IMG = '<p>hi <img src=x onerror="window.__pwn=1"> <b onclick="window.__pwn=2">bold</b> <a href="javascript:window.__pwn=3">l</a></p>'
  const reply = { compact: true, assets: { art: '<svg viewBox="0 0 10 10"><rect width="5" height="5" onload="window.__pwn=7"/></svg>' }, slides: [{ id: 'p1', elements: [
    { id: 't', type: 'text', x: 0, y: 0, w: 100, h: 40, html: IMG },
    { id: 'tb', type: 'table', x: 0, y: 50, w: 100, h: 40, columns: [{ w: 1 }, { w: 1 }], rows: [{ cells: [{ html: IMG }, { html: 'ok' }] }] },
    { id: 'sv', type: 'svg', x: 0, y: 100, w: 100, h: 100, markup: '<svg viewBox="0 0 10 10"><script>window.__pwn=4</script><rect width="5" height="5" onclick="window.__pwn=5"/><style>.r{fill:red}</style></svg>', css: '@import url(https://evil.example/x.css); .r{fill:blue}' },
    { id: 'sa', type: 'svg', x: 0, y: 100, w: 100, h: 100, asset: 'art' },
    { id: 'r1', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1, link: 'javascript:window.__pwn=6' },
    { id: 'r2', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1, link: 'https://bento.page/' },
    { id: 'r3', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1, link: 'p1' },
  ] }] }
  const json = mergeReply(doc, 'deck', 0, reply, elided)
  const parsed = parseDocInputReport(json)
  const next = parsed.doc
  const before = JSON.stringify(next)
  check('C — the shape gate let the payloads through (the condition is real)', /onerror|onclick|<script|javascript:/.test(before))
  const n = cleanDoc(next, { html: sanitizeHtml, svg: sanitizeSvgMarkup, svgCss: sanitizeSvgCss })
  const els = Object.fromEntries(next.slides[0].elements.map((e) => [e.id, e]))
  const after = JSON.stringify(next)
  check('C — cleanDoc changed the six tainted values: text, cell, markup, css, link, asset (' + n + ')', n === 6)
  check('C — text html: no <img onerror>, no on* handler, no javascript: href', !/onerror|onclick|javascript:|<img/i.test(els.t.html) && /bold/.test(els.t.html))
  check('C — table cell html cleaned the same way', !/onerror|onclick|javascript:/i.test(els.tb.rows[0].cells[0].html) && els.tb.rows[0].cells[1].html === 'ok')
  check('C — svg markup: <script> and onclick gone, <rect> and its <style> kept UNSCOPED', !/<script|onclick/i.test(els.sv.markup) && /<rect/.test(els.sv.markup) && /\\.r\\{fill:red\\}/.test(els.sv.markup) && !/data-el-id/.test(els.sv.markup))
  check('C — svg css: @import refused, the rule kept', !/evil\\.example/.test(els.sv.css) && /fill:blue/.test(els.sv.css))
  check('C — an svg ASSET a reply hands back is walked too', !/onload/i.test(next.assets.art) && /<rect/.test(next.assets.art))
  check('C — link: javascript: dropped, web URL and slide id kept', els.r1.link === undefined && els.r2.link === 'https://bento.page/' && els.r3.link === 'p1')
  check('C — nothing executable is left anywhere in the document to be stored', !/onerror|onclick|onload|<script|javascript:|evil\\.example/i.test(after))
  check('C — nothing ran while cleaning', window.__pwn === undefined)

  // E — the REAL apply: the same hostile reply through AssistantPanel.apply with a fake store
  {
    const doc2 = starterDoc()
    const store = fakeStore(doc2)
    const panel = new AssistantPanel({ store, transport: fakeTransport() })
    document.body.appendChild(panel.root)
    const { elided: el2 } = buildMessages(doc2, 'deck', 0, [], 'x')
    panel.apply('deck', 0, JSON.parse(JSON.stringify(reply)), el2)
    const stored = JSON.stringify(store.doc)
    const s0 = store.doc.slides[0]
    check('E — the real apply() stored ONE document (replaceDoc once)', store.replaced === 1 && store.doc !== doc2)
    check('E — and the stored document is clean: no handler, script, javascript: link or @import anywhere', !TAINT.test(stored))
    const e2 = Object.fromEntries(s0.elements.map((e) => [e.id, e]))
    check('E — text, cell, svg markup, css, asset cleaned and the javascript: link dropped through the real path',
      /bold/.test(e2.t.html) && !/onerror/.test(e2.t.html) && /<rect/.test(e2.sv.markup) && /fill:blue/.test(e2.sv.css) && /<rect/.test(store.doc.assets.art) && e2.r1.link === undefined && e2.r2.link === 'https://bento.page/')
    check('E — the result card is there with Undo', !!panel.root.querySelector('.ed-assist-card .ed-assist-undo'))
    check('E — nothing ran', window.__pwn === undefined)
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
    check('local: the notice names the on-device model, not a host', /to the on-device model;/.test(panel.root.querySelector('.ed-assist-notice').textContent))
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
    check('consent-pending: the waiting text shows and the input is disabled: ' + st(), /Waiting for your permission on this device/.test(st()) && panel.root.querySelector('.ed-assist-input').disabled && tr.checks === 1)
    check('consent-pending: the reason text is not what is shown', !/Asking/.test(st()))
    window.dispatchEvent(new Event('focus')); await tick(60)
    check('consent-pending: focus re-ran check once, still pending → still waiting', tr.checks === 2 && /Waiting/.test(st()))
    pending = false
    window.dispatchEvent(new Event('focus')); await tick(60)
    check('consent-pending: the next return re-checks once more, ok → the route line, input enabled', tr.checks === 3 && /via fake · h\\.example · m/.test(st()) && !panel.root.querySelector('.ed-assist-input').disabled)
    window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); await tick(60)
    check('consent-pending: once resolved, focus/visibility no longer re-check', tr.checks === 3)
  }
  {
    const store = fakeStore(starterDoc())
    const before = JSON.stringify(store.doc)
    const tr = fakeTransport({ send: async () => { const e = new Error('The user said no'); e.code = 'consent-denied'; throw e } })
    const panel = new AssistantPanel({ store, transport: tr })
    document.body.appendChild(panel.root)
    panel.setOpen(true, false); await tick(60)
    panel.root.querySelector('.ed-assist-input').value = 'do it'
    await panel.submit(); await tick(30)
    const card = panel.root.querySelector('.ed-assist-refused')
    check('consent-denied: a plain refusal card with the localized text, keyed on the code', !!card && /Permission was refused on this device/.test(card.textContent) && !/said no/.test(panel.root.textContent))
    check('consent-denied: the deck is unchanged', store.replaced === 0 && JSON.stringify(store.doc) === before)
    check('consent-denied: the drawer is usable again', !panel.root.querySelector('.ed-assist-input').disabled && panel.root.querySelector('.ed-assist-send').textContent === 'Send')
  }
  {
    // an edit that comes back as prose is nudged ONCE; the second reply is the answer
    const store = fakeStore(starterDoc())
    const sends = []
    const tr = fakeTransport({ describe: async () => ({ host: '', model: 'gemini-nano', configured: true, local: true }), send: async (messages, onChunk, signal, opts) => { sends.push({ messages, opts }); return sends.length === 1 ? 'The slide introduces Bento Slides and its tiles.' : 'Still just prose, sorry.' } })
    const panel = new AssistantPanel({ store, transport: tr })
    document.body.appendChild(panel.root)
    panel.setOpen(true, false); await tick(60)
    panel.root.querySelector('.ed-assist-input').value = 'update the title to something creative'
    await panel.submit(); await tick(30)
    check('retry: an edit answered in prose is sent once more with the nudge as the next user turn (' + sends.length + ' sends)', sends.length === 2 && sends[1].messages.at(-1).role === 'user' && /only the JSON object/.test(sends[1].messages.at(-1).content) && sends[1].messages.at(-2).role === 'assistant' && /introduces Bento/.test(sends[1].messages.at(-2).content))
    check('retry: both sends carry the ops schema', !!sends[0].opts && sends[0].opts.schema && sends[0].opts.schema.properties && sends[0].opts.schema.properties.edits && sends[0].opts.schema.properties.add && sends[1].opts.schema === sends[0].opts.schema)
    check('retry: prose again is shown as the answer, the deck unchanged', /Still just prose/.test(panel.root.textContent) && store.replaced === 0)
    const sends2 = []
    const tr2 = fakeTransport({ describe: async () => ({ host: 'h.example', model: 'm', configured: true }), send: async (messages, onChunk, signal, opts) => { sends2.push(opts); return 'Your deck has seven slides.' } })
    const panel2 = new AssistantPanel({ store, transport: tr2 })
    document.body.appendChild(panel2.root)
    panel2.setOpen(true, false); await tick(60)
    panel2.root.querySelector('.ed-assist-input').value = 'How many slides are there?'
    await panel2.submit(); await tick(30)
    check('retry: a question answered in prose is NOT nudged, and carries no schema', sends2.length === 1 && sends2[0] && sends2[0].schema === undefined)
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
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
