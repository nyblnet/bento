// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What the page knows about a deck FOR a model, and how a model's patch
// becomes a document. Pure — no DOM, no transport — so
// scripts/test-slides-assistant.ts drives it in node; the panel (panel.ts)
// does the wiring.
//
// WHERE KNOWLEDGE LIVES. This module holds FORMAT knowledge: the compact
// form (src/compact.ts — the shape AGENTS.md teaches every agent), how to
// elide it, how to address every text, table and chart as
// `<slide number>/<element id>`, how to write an outline of it, and how a
// patch is merged and cleaned. It holds NO model knowledge: no prompts, no
// token budgets, no window sizes, no schema, no turn shapes. Those live in
// the extension (home/webext/src/assistant.js), which holds the key and
// the model and is the only party that knows what the model can take.
// The page hands the extension the MATERIAL for a turn (`material()`) —
// the plain outline, the addressed outline, and the focus in full — and
// the extension decides what to send, builds the prompt, calls the model
// and returns either prose or an ops patch (ops.ts). Measured reason: the
// first split put 25 KB of prompts, budgets and a model-family table in a
// 660 KB shell that ships in every saved file; the extension updates
// itself and its model knowledge goes stale monthly, the file format does
// not.
//
// Three things never leave the page:
//   - `collab` (room keys) and `docId`: identity and capability are not
//     content. Stripped from the material, carried over from the live
//     document on apply — the same rule "Replace from JSON…" applies.
//   - inline assets (data: URIs, `assets`, `fonts`): elided to a short token
//     the patch can echo back, restored on apply. A 4 MB photo is not
//     something to spend tokens on, and a model cannot edit pixels anyway.
//   - anything the model invents at those slots: a patch's collab/docId are
//     ignored, a token it did not receive stays a string (the gate then
//     treats it as a broken src, which is what it is).
//
// The patch is the ONLY way a model writes: applied to a copy of the elided
// compact doc (ops.ts applyOps), then mergeReply → parseDocInputReport (the
// gate) → cleanDoc → one store.replaceDoc, undoable as one step. The model
// is never asked to hand the deck back (docs/DECISIONS.md, 2026-09-18).

import { isWebUrl, type BentoDoc } from '../../model.ts'
import { compactDoc, COMPACT_FLAG } from '../../compact.ts'
import { elId } from './ops.ts'
export { applyOps, elId } from './ops.ts'

/** A conversation turn as the panel keeps it: text only. A reply that edited
 *  the deck is remembered as its note, never as its patch — the material is
 *  sent fresh every turn. */
export interface Turn { role: 'user' | 'assistant'; text: string }

const ASSET_TOKEN = /^@@bento-asset-(\d+)@@$/

export interface Elided {
  doc: Record<string, unknown>
  assets: string[]
  /** an embed's `doc` (an embedded document, envelope and all) and `view`
   *  (its render), keyed slide-id U+001F element-id — held back from the
   *  model, put back on apply (G) */
  embeds: Map<string, { doc?: unknown; view?: unknown }>
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** A string worth taking out of the prompt: an embedded asset. */
const isBulky = (s: string) => s.length > 200 && /^data:/i.test(s)

const elideWalk = (v: unknown, assets: string[]): unknown => {
  if (typeof v === 'string') {
    if (!isBulky(v)) return v
    let i = assets.indexOf(v)
    if (i < 0) { i = assets.length; assets.push(v) }
    return `@@bento-asset-${i}@@`
  }
  if (Array.isArray(v)) return v.map((x) => elideWalk(x, assets))
  if (isObj(v)) {
    const out: Obj = {}
    for (const [k, x] of Object.entries(v)) out[k] = elideWalk(x, assets)
    return out
  }
  return v
}

const restoreWalk = (v: unknown, assets: string[]): unknown => {
  if (typeof v === 'string') {
    const m = ASSET_TOKEN.exec(v)
    if (!m) return v
    const a = assets[Number(m[1])]
    return a ?? v
  }
  if (Array.isArray(v)) return v.map((x) => restoreWalk(x, assets))
  if (isObj(v)) {
    const out: Obj = {}
    for (const [k, x] of Object.entries(v)) out[k] = restoreWalk(x, assets)
    return out
  }
  return v
}

/** Doc-level fields that are identity, capability or bytes, never content.
 *  `blobs` is the offloaded-asset store (sync/blobs.ts): keys and bytes. */
const PRIVATE_KEYS = ['collab', 'docId', 'modified', '$schema', 'blobs']

/**
 * The deck as the model sees it: compact, private fields out, assets
 * tokenised. Speaker `notes` go (they are the author's intent for the slide);
 * review `comments` do NOT — they carry reviewers' names and words that were
 * addressed to the author, not to a model endpoint. The drawer says so under
 * its input. On apply the live document's comments are put back (mergeReply).
 */
export function elideDoc(doc: BentoDoc): Elided {
  const c = compactDoc(doc)
  for (const k of PRIVATE_KEYS) delete c[k]
  const embeds: Elided['embeds'] = new Map()
  for (const s of (c.slides ?? []) as Obj[]) {
    delete s.comments
    // G: an embed carries a whole other document — its own collab keys and
    // docId inside `doc` — and a bulky render in `view`. The model cannot
    // edit an embedded document through this surface, so neither goes;
    // both come back from here on apply (mergeReply).
    flatElements(s).forEach((e, i) => {
      if (e.type !== 'embed') return
      embeds.set(`${String(s.id)}\u001f${elId(s, e, i)}`, { doc: e.doc, view: e.view })
      delete e.doc; delete e.view
    })
  }
  const assets: string[] = []
  return { doc: elideWalk(c, assets) as Obj, assets, embeds }
}

/** The shape of a slide/element id, and of a `link` that names one. */
export const ID_RE = /^[A-Za-z0-9._:/-]{1,120}$/

const TEXT_MAX = 400
/** The words in a piece of html or markdown: tags gone, whitespace folded.
 *  `full` keeps the whole text (an edit needs it; a question needs a taste). */
const words = (s: unknown, full = false): string => typeof s === 'string'
  ? s.replace(/<br\s*\/?>|<\/(?:p|div|li|h\d|tr)>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim().slice(0, full ? Infinity : TEXT_MAX)
  : ''


/**
 * One slide as a text outline: its number and id, then every piece of text
 * on it in element order (table cells joined, chart series with their
 * numbers), then the notes. Geometry, colours, assets and svg markup are
 * not words and stay out — this is what a question about CONTENT needs.
 */
export function outlineSlide(slide: Obj, n: number, ids = false): string {
  const lines: string[] = [`Slide ${n}${slide.id ? ` (id "${String(slide.id)}")` : ''}${slide.stateOf ? ` — a hidden state of slide id "${String(slide.stateOf)}"` : ''}${slide.layout ? ` [layout ${String(slide.layout)}]` : ''}:`]
  let i = 0
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return }
    if (!isObj(v)) return
    const type = String(v.type ?? '')
    const idx = i++
    if (type === 'text') {
      const w = words(v.md ?? v.html, ids)
      if (w) lines.push(`  - ${ids ? `[${n}/${elId(slide, v, idx)}] ` : ''}${v.role ? `${String(v.role)}: ` : ''}${w}`)
    } else if (type === 'table') {
      const rows = Array.isArray(v.rows) ? v.rows as Obj[] : []
      // addressed: every cell as r<row>c<col> so a cell op can name it;
      // unaddressed: the rows joined, a taste for a question
      const out = ids
        ? rows.map((r, ri) => (Array.isArray(r.cells) ? r.cells as Obj[] : []).map((c, ci) => `r${ri + 1}c${ci + 1}: ${words(c.html, true)}`).join(' | '))
        : rows.map((r) => (Array.isArray(r.cells) ? r.cells as Obj[] : []).map((c) => words(c.html)).join(' | ')).filter(Boolean)
      if (out.length) lines.push(`  - ${ids ? `[${n}/${elId(slide, v, idx)}] ` : ''}table: ${ids ? out.join(' / ') : out.join(' / ').slice(0, TEXT_MAX * 2)}`)
    } else if (type === 'chart') {
      const opt = isObj(v.option) ? v.option : {}
      const take = ids ? 500 : 12
      const series = Array.isArray(opt.series) ? (opt.series as Obj[]).map((x) => `${String(x.name ?? x.type ?? 'series')}${Array.isArray(x.data) ? ` [${(x.data as unknown[]).slice(0, take).map((d) => isObj(d) ? `${String(d.name ?? '')}=${String(d.value ?? '')}` : String(d)).join(', ')}]` : ''}`) : []
      const cats = isObj(opt.xAxis) && Array.isArray(opt.xAxis.data) ? ` over ${(opt.xAxis.data as unknown[]).slice(0, take).map(String).join(', ')}` : ''
      lines.push(`  - ${ids ? `[${n}/${elId(slide, v, idx)}] ` : ''}chart${series.length ? `: ${series.join('; ')}` : ''}${cats}`)
    } else if (type === 'image' || type === 'media') {
      lines.push(`  - ${type}${typeof v.alt === 'string' && v.alt ? `: ${words(v.alt)}` : ''}`)
    } else if (type === 'shape') {
      const w = words(v.html)
      if (w) lines.push(`  - ${w}`)
    }
  }
  visit(slide.elements)
  if (typeof slide.notes === 'string' && slide.notes.trim()) lines.push(`  notes: ${words(slide.notes)}`)
  return lines.join('\n')
}

/** The whole deck as an outline: title, then every slide (hidden states included, marked). */
export function outlineDeck(compact: Obj, ids = false): string {
  const slides = (compact.slides ?? []) as Obj[]
  const head = `Deck${compact.title ? ` "${String(compact.title)}"` : ''}, ${slides.length} slides.`
  return [head, ...slides.map((s, i) => outlineSlide(s, i + 1, ids))].join('\n')
}

/** Where the user is: the open slide, and what is selected on it. */
export interface Focus { index: number; selection: string[] }

/** What the extension gets for one turn. Everything a turn could need, in
 *  every shape, so the extension can pick by the model it holds: the plain
 *  outline (a question), the addressed outline (an edit), the focus in
 *  full (the selected elements or the open slide, as compact JSON with
 *  every element's address). The elision map stays on the page. */
export interface Material {
  /** the plain outline of the whole deck: words and notes */
  outline: string
  /** the same with every text, table and chart addressed <slide>/<id> */
  addressed: string
  /** the open slide, 1-based */
  open: number
  /** the deck's page size */
  size: { width: number; height: number }
  /** the focus: the selected elements or the open slide; null on an empty deck */
  focus: { kind: 'elements' | 'slide'; label: string; json: string } | null
  /** the theme, when the deck has one, as JSON */
  theme?: string
}

/** The material for one turn, and the elision map for the apply. */
export function material(doc: BentoDoc, focus: Focus): { material: Material; elided: Elided } {
  const elided = elideDoc(doc)
  const slides = (elided.doc.slides ?? []) as Obj[]
  const n = focus.index + 1
  const slide = slides[focus.index]
  const size = (elided.doc.size ?? { width: 1280, height: 720 }) as { width: number; height: number }
  let f: Material['focus'] = null
  if (slide) {
    const els = flatElements(slide)
    const picked = focus.selection.length ? els.filter((e, i) => focus.selection.includes(elId(slide, e, i))) : []
    f = picked.length
      ? { kind: 'elements', label: `the ${picked.length === 1 ? 'selected element' : `${picked.length} selected elements`} on slide ${n} (address each as ${n}/<id>)`, json: JSON.stringify(picked.map((e) => ({ id: elId(slide, e, els.indexOf(e)), ...e }))) }
      : { kind: 'slide', label: `slide ${n} (id "${String(slide.id ?? '')}"), its elements addressed as ${n}/<id>`, json: JSON.stringify({ ...slide, elements: els.map((e, i) => ({ id: elId(slide, e, i), ...e })) }) }
  }
  return {
    material: {
      outline: outlineDeck(elided.doc, false),
      addressed: outlineDeck(elided.doc, true),
      open: n,
      size,
      focus: f,
      ...(elided.doc.theme ? { theme: JSON.stringify(elided.doc.theme) } : {}),
    },
    elided,
  }
}

/** A compact slide's elements, flat (authoring may nest arrays). */
export function flatElements(slide: Obj): Obj[] {
  const out: Obj[] = []
  const visit = (v: unknown) => { if (Array.isArray(v)) { for (const x of v) visit(x) } else if (isObj(v)) out.push(v) }
  visit(slide.elements)
  return out
}

/**
 * A deck reply must not carry two slides with one id, nor two elements on a
 * slide with one id: links, states and morphs target by id, and the CRDT
 * keys slides by id, so a poisoned reply could make replicas diverge. A
 * repeat is re-minted the way the compact loader mints a MISSING id
 * (`s<n>` for a slide, `<slideId>-<type>-<index>` for an element), suffixed
 * until unique. Element ids repeated ACROSS slides are the morph idiom and
 * stay. Slide scope needs none of this: its one id is forced.
 */
export function dedupeIds(compact: Obj): number {
  let fixed = 0
  const slides = (compact.slides ?? []) as Obj[]
  const flat = (v: unknown): Obj[] => Array.isArray(v) ? v.flatMap(flat) : isObj(v) ? [v] : []
  const strId = (o: Obj) => (typeof o.id === 'string' && o.id ? o.id : null)
  // a minted name must not collide with an id that appears LATER either, or
  // re-keying one repeat would turn an innocent slide into the next repeat
  const taken = new Set(slides.map(strId).filter((x): x is string => !!x))
  const seenSlides = new Set<string>()
  slides.forEach((s, si) => {
    let id = strId(s) ?? `s${si + 1}`
    if (seenSlides.has(id)) {
      const base = `s${si + 1}`
      id = base
      for (let n = 2; taken.has(id) || seenSlides.has(id); n++) id = `${base}-${n}`
      s.id = id
      fixed++
    }
    seenSlides.add(id)
    const els = flat(s.elements)
    const takenEls = new Set(els.map(strId).filter((x): x is string => !!x))
    const seenEls = new Set<string>()
    els.forEach((e, ei) => {
      const eid0 = strId(e)
      if (!eid0) return // minted on expansion, unique by construction
      let eid = eid0
      if (seenEls.has(eid)) {
        const base = `${id}-${String(e.type ?? 'el')}-${ei}`
        eid = base
        for (let n = 2; takenEls.has(eid) || seenEls.has(eid); n++) eid = `${base}-${n}`
        e.id = eid
        fixed++
      }
      seenEls.add(eid)
    })
  })
  return fixed
}

/**
 * Sanitizers the apply step runs over a PARSED (full) document before it is
 * stored — injectable so the node rig can pass the real sanitizeHtml through
 * a DOM shim or a spy. The untrusted gate is a SHAPE gate: after it the
 * document can still carry `<img onerror>` in text html, `<script>` inside svg
 * markup and a `javascript:` link. Nothing executes here (the renderer
 * sanitizes at draw time), but the FILE would carry the payload to whoever it
 * is shared with, and shells before 1.1.0 drew svg through an unwrap hole —
 * so the model's markup is cleaned the way pasted markup is cleaned at
 * commit, once, on the way into the document.
 */
export interface Sanitizers { html: (html: string) => string; svg: (markup: string) => string; svgCss: (css: string) => string }

export function cleanDoc(doc: BentoDoc, san: Sanitizers): number {
  let n = 0
  const cleanHtml = (o: Obj, key: string) => {
    const v = o[key]
    if (typeof v !== 'string') return
    const c = san.html(v)
    if (c !== v) { o[key] = c; n++ }
  }
  for (const slide of doc.slides) {
    for (const el of slide.elements as unknown as Obj[]) {
      if (el.type === 'text') cleanHtml(el, 'html')
      if (el.type === 'table') {
        for (const row of (el.rows ?? []) as Obj[]) for (const cell of (row.cells ?? []) as Obj[]) cleanHtml(cell, 'html')
      }
      if (el.type === 'svg') {
        if (typeof el.markup === 'string') { const c = san.svg(el.markup); if (c !== el.markup) { el.markup = c; n++ } }
        if (typeof el.css === 'string') { const c = san.svgCss(el.css); if (c !== el.css) { el.css = c; n++ } }
      }
      if (el.link !== undefined && !(isWebUrl(el.link) || (typeof el.link === 'string' && ID_RE.test(el.link)))) {
        delete el.link
        n++
      }
    }
  }
  // an svg element may draw from `doc.assets` (markup, not bytes — so not
  // tokenised, so a reply can hand it back changed): the same walk
  const assets = (doc as unknown as Obj).assets
  if (isObj(assets)) {
    for (const [k, v] of Object.entries(assets)) {
      if (typeof v === 'string' && /<svg[\s>]/i.test(v)) { const c = san.svg(v); if (c !== v) { assets[k] = c; n++ } }
    }
  }
  return n
}

/**
 * The patched compact deck (ops.ts applyOps) → the compact document to
 * load: assets back from the elision map, ids de-duplicated, the live
 * document's comment threads back on the slides that still exist, private
 * fields from the live document. Null when it is not a deck.
 */
export function mergeReply(doc: BentoDoc, value: Obj, elided: Elided): string | null {
  if (!Array.isArray(value.slides)) return null
  const next: Obj = { ...(restoreWalk(value, elided.assets) as Obj), [COMPACT_FLAG]: true }
  // G: an embed's document and render come back from the send-time map,
  // never from the reply (a patch cannot carry, forge or alter them)
  for (const s of (next.slides ?? []) as Obj[]) {
    if (!isObj(s)) continue
    flatElements(s).forEach((e, i) => {
      if (e.type !== 'embed') return
      const kept = elided.embeds.get(`${String(s.id)}\u001f${elId(s, e, i)}`)
      delete e.doc; delete e.view
      if (kept) { if (kept.doc !== undefined) e.doc = kept.doc; if (kept.view !== undefined) e.view = kept.view }
    })
  }
  dedupeIds(next)
  // comments never went out, so a reply cannot carry them back: the live
  // document's threads stay on the slides that still exist
  const threads = new Map(doc.slides.map((s) => [s.id, s.comments]))
  for (const s of next.slides as Obj[]) {
    const c = threads.get(String(s.id))
    if (c) s.comments = c; else delete s.comments
  }
  for (const k of PRIVATE_KEYS) delete next[k]
  const live = doc as unknown as Obj
  if (live.docId !== undefined) next.docId = live.docId
  return JSON.stringify(next)
}
