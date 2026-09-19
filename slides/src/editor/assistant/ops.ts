// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The OPS patch: how the model writes to a deck. An edit turn (prompt.ts)
// sends the addressed outline — `<slide number>/<element id>` on every text,
// table and chart — plus the focus in full, and takes back ONE object whose
// keys are operations. The deck is read whole and written surgically; it is
// never handed back (a re-emitted deck is the wrong shape: as long as the
// input, and every slide at risk of a careless rewrite).
//
// Words and choices — what any model, down to a few-thousand-token
// on-device one, does reliably:
//   edits      [{id, text}]                    the wording of a text element
//   notes      [{slide, text}]                 speaker notes
//   cells      [{id, row, col, text}]          one table cell (1-based)
//   chart      [{id, series:[{name, data}], categories?}]   a chart's numbers
//   style      [{id, size?, weight?, align?}]  enum verbs: bigger/smaller,
//                                              bold/normal, left/center/right
//   add        [{after, layout, title?, …, notes?, elements?}]
//              a new slide from a built-in layout — the roles place the text;
//              `elements` (full compact elements) for a designed slide
//   remove     [slide]
//   move       [{slide, to}]                   put slide N where slide M is
// Precise — for a model that was shown the focus JSON:
//   set        [{id, …fields}]                 merge fields onto an element
//                                              (geometry, colours, fonts, src…;
//                                              never id or type)
//   insert     [{slide, type, …fields}]        a new element with geometry
//   delete     ["n/id"]                        remove elements
//   slide      [{slide, background?, transition?, layout?, hidden?}]
//
// Numbers are the outline's numbers (1-based over the compact slide list,
// hidden states included). Content ops are applied first, by those numbers;
// then structure — add, remove, move — on the ORIGINAL slide objects, so
// "add after 3, remove 5, move 7 to 2" in one reply means what it read as.
// The result is a patched COPY of the elided compact doc, which then takes
// the same road as pasted JSON: mergeReply → the gate → cleanDoc → one
// undoable swap — so a `set` of arbitrary fields is exactly as trusted as
// a field in a pasted file, no more. Everything unknown, malformed or out
// of range is skipped and named, never fatal.
//
// The PROMPT that teaches a model these verbs and the JSON SCHEMA that
// constrains its output are the extension's (home/webext/src/assistant.js):
// model knowledge, kept beside the model. This file is the format's side:
// what a verb MEANS for the document. The two are kept in step by hand and
// by the rig's fixture replies.

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

export const DEFAULT_FONT_SIZE = 32   // model.ts defaultText — compact omits it when default
const SIZE_STEP = 1.25

/** The reply's shape, for providers that constrain output. Kept to
 *  type/properties/items/required/enum — the subset every dialect takes. */
/** fields a set/insert may never write: identity, the keys the loader and
 *  the gate own, `live` — an embed's live iframe is the USER's opt-in
 *  (model.ts), a capability, not content; the model edits content — and
 *  an embed's `doc`/`view`: an embedded document is not this surface's to
 *  write (material.ts holds them back from the model and restores them). */
const LOCKED_FIELDS = new Set(['id', 'type', 'comments', 'collab', 'docId', 'blobs', 'live', 'doc', 'view', '__proto__', 'constructor', 'prototype'])

/** Every http(s) origin+path a document refers to (src, url, poster —
 *  any string field), so the result card can name the fetches a patch
 *  introduced: a remote picture is a request the deck will make at render,
 *  and a poisoned model could add a tracking pixel silently. */
export function remoteUrls(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    if (/^https?:\/\//i.test(v) && v.length < 2048) { try { const u = new URL(v); out.add(u.host + (u.pathname === '/' ? '' : u.pathname)) } catch { /* not a URL */ } }
  } else if (Array.isArray(v)) { for (const x of v) remoteUrls(x, out) }
  else if (isObj(v)) { for (const x of Object.values(v)) remoteUrls(x, out) }
  return out
}
const SLIDE_FIELDS = new Set(['background', 'transition', 'layout', 'hidden', 'notes', 'hover'])
export const INSERT_MAX = 40      // elements one reply may insert
export const SET_MAX = 200        // set ops one reply may carry

export interface OpsResult { doc: Obj; applied: string[]; skipped: string[]; structural: boolean }

/**
 * Apply an ops reply to the elided compact doc (a deep copy is patched).
 * `applied`/`skipped` name every op for the panel's card.
 */
/** `focus` = the open slide (0-based): a BARE element id — the model copied
 *  the id out of the focus JSON instead of the address — resolves there
 *  first, then anywhere it is unique. Measured: gemini-3.5-flash-lite wrote
 *  `sd-title` for a slide whose focus JSON said `"id":"sd-title"`, and
 *  sd-title lives on every slide (the morph idiom). */
export function applyOps(compact: Obj, ops: unknown, focus: { slide?: number } = {}): OpsResult {
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
  const onFocus = (id: string): Obj | undefined => typeof focus.slide === 'number' ? byAddr.get(`${focus.slide + 1}/${id}`) : undefined
  const resolve = (id: unknown): Obj | undefined => !str(id) ? undefined
    : byAddr.get(id) ?? onFocus(id) ?? (bare.get(id)?.length === 1 ? bare.get(id)![0] : undefined)
  const find = (id: unknown, type: string): Obj | null => {
    const el = resolve(id)
    return el && el.type === type ? el : null
  }
  const slideAt = (n: unknown): Obj | null => int(n) && n >= 1 && n <= slides.length ? slides[n - 1] : null

  // ---- content ops, by the outline's numbers
  for (const e of list('edits')) {
    const el = isObj(e) ? find(e.id, 'text') : null
    if (!el || !isObj(e) || !str(e.text)) { skipped.push(`edit ${isObj(e) && str(e.id) ? e.id : '?'}`); continue }
    el.md = mdText(e.text); delete el.html
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

  // ---- precise verbs: set / insert / delete / slide
  let sets = 0
  for (const e of list('set')) {
    if (!isObj(e) || !str(e.id)) { skipped.push('set ?'); continue }
    const el = resolve(e.id)
    if (!el) { skipped.push(`set ${e.id}`); continue }
    if (sets++ >= SET_MAX) { skipped.push(`set ${e.id} (limit)`); continue }
    let did = 0
    for (const [k, v] of Object.entries(e)) {
      if (k === 'id' || LOCKED_FIELDS.has(k)) continue
      if (v === null) { delete el[k]; did++; continue }
      el[k] = v; did++
      // a text set by html or md is one or the other, never a stale pair
      if (k === 'md') delete el.html
      else if (k === 'html') delete el.md
    }
    if (did) applied.push(`set ${e.id}`); else skipped.push(`set ${e.id}`)
  }
  let inserted = 0
  for (const e of list('insert')) {
    const s = isObj(e) ? slideAt(e.slide) : null
    if (!s || !isObj(e) || !str(e.type) || !e.type) { skipped.push(`insert ${isObj(e) ? String(e.type ?? '?') : '?'}`); continue }
    if (inserted >= INSERT_MAX) { skipped.push(`insert ${e.type} (limit)`); continue }
    const el: Obj = {}
    for (const [k, v] of Object.entries(e)) { if (k !== 'slide' && !LOCKED_FIELDS.has(k) && v !== null) el[k] = v }
    el.type = e.type
    el.id = freshElementId(s, e.type)
    if (!Array.isArray(s.elements)) s.elements = []
    ;(s.elements as unknown[]).push(el)
    inserted++
    applied.push(`insert ${e.type} on ${e.slide}`)
  }
  for (const id of list('delete')) {
    const el = resolve(id)
    const home = el ? slides.find((s) => flat(s.elements).includes(el)) : undefined
    if (!el || !home) { skipped.push(`delete ${str(id) ? id : '?'}`); continue }
    home.elements = prune(home.elements, el)
    applied.push(`delete ${id}`)
  }
  for (const e of list('slide')) {
    const s = isObj(e) ? slideAt(e.slide) : null
    if (!s || !isObj(e)) { skipped.push(`slide ${isObj(e) ? String(e.slide) : '?'}`); continue }
    let did = 0
    for (const [k, v] of Object.entries(e)) {
      if (k === 'slide' || !SLIDE_FIELDS.has(k)) continue
      if (v === null) { delete s[k]; did++; continue }
      if (k === 'hidden' && typeof v !== 'boolean') continue
      if (k !== 'hidden' && !str(v)) continue
      s[k] = k === 'notes' ? (v as string).slice(0, TEXT_EDIT_MAX) : v; did++
    }
    if (did) applied.push(`slide ${e.slide}`); else skipped.push(`slide ${e.slide}`)
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
    // a designed slide: full elements ride along (the loader mints their
    // ids; the gate checks their shape). Locked keys never do.
    if (Array.isArray(a.elements)) {
      for (const e of (a.elements as unknown[]).slice(0, INSERT_MAX)) {
        if (!isObj(e) || !str(e.type)) continue
        const el: Obj = {}
        for (const [k, v] of Object.entries(e)) { if (!LOCKED_FIELDS.has(k) || k === 'type' || k === 'id') el[k] = v }
        elements.push(el)
      }
    }
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

/** every element on a slide, flat; and the list with one element removed,
 *  nesting kept */
const flat = (v: unknown): Obj[] => Array.isArray(v) ? v.flatMap(flat) : isObj(v) ? [v] : []
const prune = (v: unknown, el: Obj): unknown => Array.isArray(v) ? v.filter((x) => x !== el).map((x) => prune(x, el)) : v

const freshElementId = (slide: Obj, type: string): string => {
  const taken = new Set(flat(slide.elements).map((e) => String(e.id ?? '')))
  const stamp = Date.now().toString(36)
  let id = `${type}-${stamp}`
  for (let n = 2; taken.has(id); n++) id = `${type}-${stamp}-${n}`
  return id
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

/** An edit's text is markdown, but a model that saw `Code<br>is the<br>canvas`
 *  in the focus html writes it back that way (measured: gemini-3.5-flash-
 *  lite) and the loader would show the tags. A <br> is a line break; a
 *  <p>…</p> pair is a paragraph; any other tag is text (escaped by the
 *  markdown path). */
const mdText = (t: string): string => t.slice(0, TEXT_EDIT_MAX)
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/\s*<\/p>\s*<p[^>]*>\s*/gi, '\n\n')
  .replace(/^\s*<p[^>]*>|<\/p>\s*$/gi, '')

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
