// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The OPS patch: what a small model can do to a deck without ever seeing
// its JSON. A words turn (prompt.ts) sends the outline with addresses —
// `<slide number>/<element id>` — and takes back ONE object whose keys are
// operations. Every op is "words and choices": the model writes text, names
// a slide number, picks from an enum. Geometry, colours, pictures and
// markup stay out, because a model with a few thousand tokens of window
// cannot do those reliably and the layouts already do them well.
//
//   edits      [{id, text}]                    the wording of a text element
//   notes      [{slide, text}]                 speaker notes
//   cells      [{id, row, col, text}]          one table cell (1-based)
//   chart      [{id, series:[{name, data}], categories?}]   a chart's numbers
//   style      [{id, size?, weight?, align?}]  enum verbs: bigger/smaller,
//                                              bold/normal, left/center/right
//   add        [{after, layout, title?, subtitle?, kicker?, body?, left?,
//                right?, quote?, attribution?, card1?, card2?, card3?, notes?}]
//              a new slide from a built-in layout — the roles place the text
//   remove     [slide]
//   move       [{slide, to}]                   put slide N where slide M is
//
// Numbers are the outline's numbers (1-based over the compact slide list,
// hidden states included). Content ops are applied first, by those numbers;
// then structure — add, remove, move — on the ORIGINAL slide objects, so
// "add after 3, remove 5, move 7 to 2" in one reply means what it read as.
// The result is a patched COPY of the elided compact doc, which then takes
// the same road as a JSON reply: mergeReply → the gate → cleanDoc → one
// undoable swap. Everything unknown, malformed or out of range is skipped
// and named, never fatal.

import { mintId } from '../../compact.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** The id a compact element answers to: its own, or the one the loader
 *  will mint (compactDoc strips ids that equal the minted form). */
export const elId = (slide: Obj, el: Obj, i: number): string => str(el.id) && el.id ? el.id : mintId(slide, el, i)

export const TEXT_EDIT_MAX = 20000
export const ADD_MAX = 20         // slides one reply may add
export const SERIES_MAX = 500     // numbers per series

export const LAYOUTS = ['title', 'title-content', 'two-col', 'section', 'three-cards', 'quote', 'image-left', 'image-right', 'blank'] as const
/** the add op's text fields → the layout roles that place them */
const ADD_ROLES: Record<string, string> = { title: 'title', subtitle: 'subtitle', kicker: 'kicker', body: 'body', left: 'left', right: 'right', quote: 'quote', attribution: 'attribution', card1: 'card1', card2: 'card2', card3: 'card3' }

const SIZE = ['bigger', 'smaller'] as const
const WEIGHT = ['bold', 'normal'] as const
const ALIGN = ['left', 'center', 'right'] as const
export const DEFAULT_FONT_SIZE = 32   // model.ts defaultText — compact omits it when default
const SIZE_STEP = 1.25

/** The reply's shape, for providers that constrain output. Kept to
 *  type/properties/items/required/enum — the subset every dialect takes. */
export const OPS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    edits: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
    notes: { type: 'array', items: { type: 'object', properties: { slide: { type: 'integer' }, text: { type: 'string' } }, required: ['slide', 'text'] } },
    cells: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, row: { type: 'integer' }, col: { type: 'integer' }, text: { type: 'string' } }, required: ['id', 'row', 'col', 'text'] } },
    chart: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, data: { type: 'array', items: { type: 'number' } } }, required: ['name', 'data'] } }, categories: { type: 'array', items: { type: 'string' } } }, required: ['id'] } },
    style: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, size: { type: 'string', enum: [...SIZE] }, weight: { type: 'string', enum: [...WEIGHT] }, align: { type: 'string', enum: [...ALIGN] } }, required: ['id'] } },
    add: { type: 'array', items: { type: 'object', properties: { after: { type: 'integer' }, layout: { type: 'string', enum: [...LAYOUTS] }, title: { type: 'string' }, subtitle: { type: 'string' }, kicker: { type: 'string' }, body: { type: 'string' }, left: { type: 'string' }, right: { type: 'string' }, quote: { type: 'string' }, attribution: { type: 'string' }, card1: { type: 'string' }, card2: { type: 'string' }, card3: { type: 'string' }, notes: { type: 'string' } }, required: ['after', 'layout'] } },
    remove: { type: 'array', items: { type: 'integer' } },
    move: { type: 'array', items: { type: 'object', properties: { slide: { type: 'integer' }, to: { type: 'integer' } }, required: ['slide', 'to'] } },
  },
}

/** The system prompt for an ops turn. Short: it has to fit a small window
 *  beside the outline, and a small model follows a short list better. */
export const OPS_PROMPT = `You are the editing assistant inside Bento Slides, a presentation editor. The user shows you an outline of their slides: each slide is numbered, each text starts with its address in [square brackets], tables list their cells as r<row>c<col>, charts list their series and numbers. Reply with ONE JSON object and nothing else, using only the keys you need:
- "edits": [{"id","text"}] — a text's complete new wording (markdown allowed: **bold**, *italic*, a blank line between paragraphs). The id copied exactly as shown.
- "notes": [{"slide","text"}] — a slide's speaker notes.
- "cells": [{"id","row","col","text"}] — one table cell.
- "chart": [{"id","series":[{"name","data":[numbers]}],"categories":[...]}] — a chart's numbers.
- "style": [{"id","size":"bigger"|"smaller","weight":"bold"|"normal","align":"left"|"center"|"right"}] — a text's look.
- "add": [{"after": slide number (0 = at the start), "layout": "title"|"title-content"|"two-col"|"section"|"three-cards"|"quote", "title","subtitle","kicker","body","left","right","quote","attribution","card1","card2","card3","notes"}] — a new slide; give only the texts the layout uses.
- "remove": [slide numbers]. "move": [{"slide","to"}] — put a slide where another is.
Change only what the request asks. Leave everything else out. If the request needs something not in this list — positions, colours, pictures, shapes — reply in plain text that this needs a hosted provider (set in the extension settings) and do not write JSON.`

export interface OpsResult { doc: Obj; applied: string[]; skipped: string[]; structural: boolean }

/**
 * Apply an ops reply to the elided compact doc (a deep copy is patched).
 * `applied`/`skipped` name every op for the panel's card.
 */
export function applyOps(compact: Obj, ops: unknown): OpsResult {
  const doc = JSON.parse(JSON.stringify(compact)) as Obj
  const applied: string[] = []
  const skipped: string[] = []
  const o = isObj(ops) ? ops : {}
  const slides = Array.isArray(doc.slides) ? (doc.slides as Obj[]) : []
  const list = (k: string): unknown[] => Array.isArray(o[k]) ? (o[k] as unknown[]) : []

  // ---- addressing: "<n>/<id>" → element; a bare id when exactly one slide has it
  const byAddr = new Map<string, Obj>()
  const bare = new Map<string, Obj[]>()
  slides.forEach((slide, si) => {
    let i = 0
    const visit = (v: unknown) => {
      if (Array.isArray(v)) { for (const x of v) visit(x); return }
      if (!isObj(v)) return
      const idx = i++
      const id = elId(slide, v, idx)
      byAddr.set(`${si + 1}/${id}`, v)
      bare.set(id, [...(bare.get(id) ?? []), v])
    }
    visit(slide.elements)
  })
  const find = (id: unknown, type: string): Obj | null => {
    if (!str(id)) return null
    const el = byAddr.get(id) ?? (bare.get(id)?.length === 1 ? bare.get(id)![0] : undefined)
    return el && el.type === type ? el : null
  }
  const slideAt = (n: unknown): Obj | null => int(n) && n >= 1 && n <= slides.length ? slides[n - 1] : null

  // ---- content ops, by the outline's numbers
  for (const e of list('edits')) {
    const el = isObj(e) ? find(e.id, 'text') : null
    if (!el || !isObj(e) || !str(e.text)) { skipped.push(`edit ${isObj(e) && str(e.id) ? e.id : '?'}`); continue }
    el.md = e.text.slice(0, TEXT_EDIT_MAX); delete el.html
    applied.push(`edit ${e.id}`)
  }
  for (const n of list('notes')) {
    const s = isObj(n) ? slideAt(n.slide) : null
    if (!s || !isObj(n) || !str(n.text)) { skipped.push(`notes ${isObj(n) ? String(n.slide) : '?'}`); continue }
    s.notes = n.text.slice(0, TEXT_EDIT_MAX)
    applied.push(`notes ${n.slide}`)
  }
  for (const c of list('cells')) {
    const el = isObj(c) ? find(c.id, 'table') : null
    const rows = el && Array.isArray(el.rows) ? (el.rows as Obj[]) : null
    const row = rows && isObj(c) && int(c.row) && c.row >= 1 && c.row <= rows.length ? rows[c.row - 1] : null
    const cells = row && Array.isArray(row.cells) ? (row.cells as Obj[]) : null
    const cell = cells && isObj(c) && int(c.col) && c.col >= 1 && c.col <= cells.length ? cells[c.col - 1] : null
    if (!cell || !isObj(c) || !str(c.text)) { skipped.push(`cell ${isObj(c) && str(c.id) ? `${c.id} r${String(c.row)}c${String(c.col)}` : '?'}`); continue }
    cell.html = escapeHtml(c.text.slice(0, TEXT_EDIT_MAX))
    applied.push(`cell ${c.id} r${c.row}c${c.col}`)
  }
  for (const ch of list('chart')) {
    const el = isObj(ch) ? find(ch.id, 'chart') : null
    const opt = el && isObj(el.option) ? el.option : null
    if (!opt || !isObj(ch)) { skipped.push(`chart ${isObj(ch) && str(ch.id) ? ch.id : '?'}`); continue }
    let did = 0
    const series = Array.isArray(opt.series) ? (opt.series as Obj[]) : []
    for (const s of Array.isArray(ch.series) ? ch.series : []) {
      if (!isObj(s) || !Array.isArray(s.data)) continue
      const target = series.find((x) => str(s.name) && x.name === s.name) ?? (series.length === 1 ? series[0] : undefined)
      if (!target) continue
      const nums = (s.data as unknown[]).slice(0, SERIES_MAX).map((d) => typeof d === 'number' && Number.isFinite(d) ? d : 0)
      // a pie keeps its slice names; the numbers land by position
      target.data = target.type === 'pie' && Array.isArray(target.data)
        ? (target.data as unknown[]).map((d, i) => isObj(d) ? { ...d, value: nums[i] ?? d.value } : (nums[i] ?? d))
        : nums
      did++
    }
    if (Array.isArray(ch.categories) && isObj(opt.xAxis)) { opt.xAxis.data = (ch.categories as unknown[]).slice(0, SERIES_MAX).map(String); did++ }
    if (did) applied.push(`chart ${ch.id}`); else skipped.push(`chart ${ch.id}`)
  }
  for (const s of list('style')) {
    const el = isObj(s) ? find(s.id, 'text') : null
    if (!el || !isObj(s)) { skipped.push(`style ${isObj(s) && str(s.id) ? s.id : '?'}`); continue }
    let did = 0
    if (s.size === 'bigger' || s.size === 'smaller') {
      const cur = typeof el.fontSize === 'number' ? el.fontSize : DEFAULT_FONT_SIZE
      el.fontSize = Math.round(s.size === 'bigger' ? cur * SIZE_STEP : cur / SIZE_STEP); did++
    }
    if (s.weight === 'bold' || s.weight === 'normal') { el.fontWeight = s.weight === 'bold' ? 700 : 400; did++ }
    if (s.align === 'left' || s.align === 'center' || s.align === 'right') { el.align = s.align; did++ }
    if (did) applied.push(`style ${s.id}`); else skipped.push(`style ${s.id}`)
  }

  // ---- structure, on the original slide objects
  let structural = false
  const removeSet = new Set<Obj>()
  for (const n of list('remove')) {
    const s = slideAt(n)
    if (!s) { skipped.push(`remove ${String(n)}`); continue }
    removeSet.add(s); applied.push(`remove ${n}`); structural = true
  }
  // adds: inserted after the ORIGINAL slide n (0 = start); several after the
  // same slide keep their reply order
  const inserts = new Map<Obj | null, Obj[]>()
  let added = 0
  for (const a of list('add')) {
    if (!isObj(a) || !int(a.after) || a.after < 0 || a.after > slides.length || !str(a.layout) || !(LAYOUTS as readonly string[]).includes(a.layout)) { skipped.push(`add ${isObj(a) ? String(a.layout ?? '?') : '?'}`); continue }
    if (added >= ADD_MAX) { skipped.push(`add ${a.layout} (limit)`); continue }
    const anchor = a.after === 0 ? null : slides[a.after - 1]
    const elements: Obj[] = []
    for (const [field, role] of Object.entries(ADD_ROLES)) {
      if (str(a[field]) && (a[field] as string).trim()) elements.push({ type: 'text', role, md: (a[field] as string).slice(0, TEXT_EDIT_MAX) })
    }
    // an id of its own: an unnamed slide would be minted `s<index>` on
    // load, which can collide with a slide already called that and re-key
    // it (dedupeIds) — links and states would then point elsewhere
    const slide: Obj = { id: freshSlideId(slides), layout: a.layout, elements }
    if (str(a.notes) && a.notes.trim()) slide.notes = a.notes.slice(0, TEXT_EDIT_MAX)
    inserts.set(anchor, [...(inserts.get(anchor) ?? []), slide])
    added++; structural = true
    applied.push(`add ${a.layout} after ${a.after}`)
  }
  // moves: "put slide N where slide M is" — resolved on the original objects
  const moves: Array<{ s: Obj; before: Obj; after: boolean }> = []
  for (const m of list('move')) {
    const s = isObj(m) ? slideAt(m.slide) : null
    const t = isObj(m) ? slideAt(m.to) : null
    if (!s || !t || !isObj(m) || s === t) { skipped.push(`move ${isObj(m) ? `${String(m.slide)}→${String(m.to)}` : '?'}`); continue }
    moves.push({ s, before: t, after: (m.to as number) > (m.slide as number) }); structural = true
    applied.push(`move ${m.slide}→${m.to}`)
  }
  if (structural) {
    let out: Obj[] = [...(inserts.get(null) ?? [])]
    for (const s of slides) { out.push(s); out.push(...(inserts.get(s) ?? [])) }
    for (const { s, before, after } of moves) {
      out = out.filter((x) => x !== s)
      const at = out.indexOf(before)
      if (at < 0) continue
      out.splice(after ? at + 1 : at, 0, s)
    }
    out = out.filter((s) => !removeSet.has(s))
    doc.slides = out
  }
  return { doc, applied, skipped, structural }
}

const takenIds = new WeakMap<Obj[], Set<string>>()
const freshSlideId = (slides: Obj[]): string => {
  let taken = takenIds.get(slides)
  if (!taken) { taken = new Set(slides.map((s) => String(s.id ?? ''))); takenIds.set(slides, taken) }
  const stamp = Date.now().toString(36)
  let id = `s-${stamp}`
  for (let n = 2; taken.has(id); n++) id = `s-${stamp}-${n}`
  taken.add(id)
  return id
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
