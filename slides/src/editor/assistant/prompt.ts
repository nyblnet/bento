// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What the assistant is told, and how its reply becomes a document. Pure —
// no DOM, no transport — so scripts/test-slides-assistant.ts drives it in
// node; the panel (panel.ts) does the wiring.
//
// The deck goes out in its COMPACT form (src/compact.ts — the shape AGENTS.md
// teaches every agent) and the reply comes back in it too, then takes the
// same road pasted JSON takes: parseDocInputReport → the untrusted gate → one
// store.replaceDoc, undoable as one step. Nothing the model says reaches the
// renderer without passing the gate.
//
// Three things never leave the page:
//   - `collab` (room keys) and `docId`: identity and capability are not
//     content. Stripped from the prompt, carried over from the live document
//     on apply — the same rule "Replace from JSON…" applies.
//   - inline assets (data: URIs, `assets`, `fonts`): elided to a short token
//     the reply can echo back, restored on apply. A 4 MB photo is not
//     something to spend tokens on, and a model cannot edit pixels anyway.
//   - anything the model invents at those slots: a reply's collab/docId are
//     ignored, a token it did not receive stays a string (the gate then
//     treats it as a broken src, which is what it is).
//
// TWO KINDS OF TURN. An EDIT sends the JSON and expects JSON back. A QUESTION
// ("summarise this deck", "what is slide 4 about?") sends a text OUTLINE of
// the same scope — slide numbers, the words on each slide, the notes — and
// asks for prose. Measured on the starter deck: the compact deck is 88 KB
// (~22k tokens), its outline under 5 KB. Chrome's on-device model has a
// window of a few thousand tokens, so before this every deck-scope question
// on it failed as "too large", and the slide-scope ones came back as the
// slide's JSON echoed — a small model answers in the shape it was shown. The
// outline is what a question needs from any provider; the JSON is what an
// edit needs. `isQuestion` decides from the request's wording; a question's
// reply is never applied, whatever shape it comes back in.

import { isWebUrl, type BentoDoc } from '../../model.ts'
import { compactDoc, COMPACT_FLAG } from '../../compact.ts'
import type { AssistantMessage } from './transport.ts'

export type AssistantScope = 'slide' | 'deck'

/** A conversation turn as the panel keeps it: text only. A reply that edited
 *  the deck is remembered as its note, never as its JSON — the current deck is
 *  sent fresh every turn, so the old JSON would only cost tokens. */
export interface Turn { role: 'user' | 'assistant'; text: string }

export const SYSTEM_PROMPT = `You are the editing assistant inside Bento Slides, a presentation editor. The user shows you their deck as JSON in the bento/slides COMPACT form and asks for changes or questions.

The compact form: a document is { "compact": true, "title", "size": {width,height}, "theme", "layouts", "slides": [...] }. A slide is { "id", "background"?, "transition"?, "notes"?, "elements": [...] }. Every element has "type" and, unless placed by a layout, "x" "y" "w" "h" in slide pixels (the default slide is 1280x720; keep 96px side margins). Types and their content: "text" (html, or md for markdown; fontSize, fontWeight, color, align, valign, fontFamily, lineHeight), "shape" (shape: rect|ellipse|line|path…, fill, stroke, strokeWidth, radius), "image" (src), "table" (columns weights, rows of {cells:[{html}]}, header), "chart" (option in the ECharts shape: bar/line/pie/scatter), "svg" (markup, optional css). Every field that equals the editor's default may be left out. "elements" may nest arrays. "id" may be omitted — it is minted as <slideId>-<type>-<index>; KEEP an existing element's id when you change it so its identity survives, and give elements that should morph across slides the same id. Text may carry "md" instead of "html". A slide may say "layout" (title, title-content, two-col, section, three-cards, quote, image-left, image-right) and its elements a "role" (title, subtitle, body, kicker, quote, attribution, image, card1…) with no geometry. A string like "@@bento-asset-3@@" stands for an embedded asset: copy it unchanged where you keep that picture; never invent one.

How to answer:
- To CHANGE the deck, reply with one JSON object and nothing else but an optional single sentence before it. For scope "deck" reply with the whole compact document. For scope "slide" reply with just that one slide object (keep its "id").
- Keep everything you were not asked to change exactly as it is. Change only what the request needs.
- To answer a question or when no change is right, reply in plain text with no JSON object.
- Never include "collab", "docId" or "modified".`

/** The system prompt for a QUESTION turn: an outline goes out, prose comes
 *  back. Short on purpose — it has to fit an on-device model too. */
export const QUESTION_PROMPT = `You are the assistant inside Bento Slides, a presentation editor. The user shows you an outline of their slides (the words on each slide and the speaker notes) and asks about it. Answer in plain text: clear and short, no JSON, no code. If they ask for a change rather than a question, describe what you would change and say they can ask for it as an instruction.`

const ASSET_TOKEN = /^@@bento-asset-(\d+)@@$/

export interface Elided { doc: Record<string, unknown>; assets: string[] }

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
  for (const s of (c.slides ?? []) as Obj[]) delete s.comments
  const assets: string[] = []
  return { doc: elideWalk(c, assets) as Obj, assets }
}

/** The shape of a slide/element id, and of a `link` that names one. */
export const ID_RE = /^[A-Za-z0-9._:/-]{1,120}$/

const MAX_HISTORY = 8

/**
 * Does the request ask ABOUT the deck rather than for a change to it? A
 * trailing question mark, or an opening that asks — summarise, explain,
 * what, why, how, which, describe, review, list, suggest, tell me… A wrong
 * guess costs little either way: a question sent as an edit gets prose back
 * (the edit prompt allows prose), an edit sent as a question gets prose
 * describing the change instead of the change — the reply says so and the
 * user rephrases as an instruction ("change…", "make…", "add…").
 */
const QUESTION_RE = /^(?:(?:please|can|could|would)\s+(?:you\s+)?)?(?:summari[sz]e|sum up|explain|describe|review|critique|assess|evaluate|check|proofread|list|count|compare|what|what's|whats|why|how|which|who|where|when|is|are|does|do|did|tell me|give me (?:a |an |some |your )?(?:summary|overview|feedback|thoughts|opinion|ideas?|suggestions?)|suggest|recommend|any (?:ideas|thoughts|suggestions)|thoughts on|feedback on)\b/i
export function isQuestion(request: string): boolean {
  const r = request.trim()
  if (/\?\s*$/.test(r)) return true
  return QUESTION_RE.test(r)
}

const TEXT_MAX = 400
/** The words in a piece of html or markdown: tags gone, whitespace folded. */
const words = (s: unknown): string => typeof s === 'string'
  ? s.replace(/<br\s*\/?>|<\/(?:p|div|li|h\d|tr)>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)
  : ''

/**
 * One slide as a text outline: its number and id, then every piece of text
 * on it in element order (table cells joined, chart series with their
 * numbers), then the notes. Geometry, colours, assets and svg markup are
 * not words and stay out — this is what a question about CONTENT needs.
 */
export function outlineSlide(slide: Obj, n: number): string {
  const lines: string[] = [`Slide ${n}${slide.id ? ` (id "${String(slide.id)}")` : ''}${slide.stateOf ? ` — a hidden state of slide id "${String(slide.stateOf)}"` : ''}${slide.layout ? ` [layout ${String(slide.layout)}]` : ''}:`]
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return }
    if (!isObj(v)) return
    const type = String(v.type ?? '')
    if (type === 'text') {
      const w = words(v.md ?? v.html)
      if (w) lines.push(`  - ${v.role ? `${String(v.role)}: ` : ''}${w}`)
    } else if (type === 'table') {
      const rows = Array.isArray(v.rows) ? v.rows as Obj[] : []
      const out = rows.map((r) => (Array.isArray(r.cells) ? r.cells as Obj[] : []).map((c) => words(c.html)).join(' | ')).filter(Boolean)
      if (out.length) lines.push(`  - table: ${out.join(' / ').slice(0, TEXT_MAX * 2)}`)
    } else if (type === 'chart') {
      const opt = isObj(v.option) ? v.option : {}
      const series = Array.isArray(opt.series) ? (opt.series as Obj[]).map((x) => `${String(x.name ?? x.type ?? 'series')}${Array.isArray(x.data) ? ` [${(x.data as unknown[]).slice(0, 12).map((d) => isObj(d) ? `${String(d.name ?? '')}=${String(d.value ?? '')}` : String(d)).join(', ')}]` : ''}`) : []
      const cats = isObj(opt.xAxis) && Array.isArray(opt.xAxis.data) ? ` over ${(opt.xAxis.data as unknown[]).slice(0, 12).map(String).join(', ')}` : ''
      lines.push(`  - chart${series.length ? `: ${series.join('; ')}` : ''}${cats}`)
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
export function outlineDeck(compact: Obj): string {
  const slides = (compact.slides ?? []) as Obj[]
  const head = `Deck${compact.title ? ` "${String(compact.title)}"` : ''}, ${slides.length} slides.`
  return [head, ...slides.map((s, i) => outlineSlide(s, i + 1))].join('\n')
}

/** Roughly how many model tokens a text costs: chars/4, the usual estimate
 *  for English and JSON. Only used to refuse early, never to bill. */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4)

/** A conservative window for an on-device model (Chrome's Gemini Nano
 *  reports ~6k tokens of input quota; the reply shares it, and an edit's
 *  reply is as long as its input). A context past this is refused BEFORE it
 *  is sent, with a note that says why, instead of the provider's "too
 *  large" after the wait. */
export const LOCAL_TOKEN_BUDGET = 2800

export interface BuiltMessages { messages: AssistantMessage[]; elided: Elided; question: boolean; contextTokens: number }

/** The messages for one turn. `currentIndex` picks the slide for scope 'slide'. */
export function buildMessages(doc: BentoDoc, scope: AssistantScope, currentIndex: number, history: Turn[], request: string): BuiltMessages {
  const elided = elideDoc(doc)
  const slides = (elided.doc.slides ?? []) as Obj[]
  const question = isQuestion(request)
  const messages: AssistantMessage[] = [{ role: 'system', content: question ? QUESTION_PROMPT : SYSTEM_PROMPT }]
  for (const turn of history.slice(-MAX_HISTORY)) messages.push({ role: turn.role, content: turn.text })
  const slide = slides[currentIndex]
  let context: string
  if (question) {
    context = scope === 'slide' && slide
      ? `Scope: slide ${currentIndex + 1} of ${slides.length}.\n${outlineSlide(slide, currentIndex + 1)}`
      : `Scope: the whole deck (slide ${currentIndex + 1} is open).\n${outlineDeck(elided.doc)}`
  } else {
    context = scope === 'slide' && slide
      ? `Scope: slide (slide ${currentIndex + 1} of ${slides.length}, id "${String(slide.id ?? '')}").\nThe deck's size is ${JSON.stringify((elided.doc.size ?? { width: 1280, height: 720 }))}${elided.doc.theme ? ` and its theme is ${JSON.stringify(elided.doc.theme)}` : ''}.\nThe slide:\n${JSON.stringify(slide)}`
      : `Scope: deck (${slides.length} slides; slide ${currentIndex + 1} is open).\nThe deck:\n${JSON.stringify(elided.doc)}`
  }
  // a question reads the outline first and the question last (the thing to
  // do is the freshest text); an edit leads with the instruction
  messages.push({ role: 'user', content: question ? `${context}\n\n${request.trim()}` : `${request.trim()}\n\n${context}` })
  return { messages, elided, question, contextTokens: approxTokens(messages[0].content + context) }
}

/** What a reply turned out to be. */
export type ParsedReply =
  | { kind: 'text'; text: string }
  | { kind: 'json'; note: string; value: Obj }

/**
 * Find the one JSON object in a reply. A fenced block wins; otherwise the
 * outermost {…} that parses. Anything else is plain text. A note is whatever
 * text stood before the object.
 */
export function parseReply(text: string): ParsedReply {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/i.exec(text)
  if (fence) {
    try {
      const v = JSON.parse(fence[1])
      if (isObj(v)) return { kind: 'json', note: text.slice(0, fence.index).trim(), value: v }
    } catch { /* fall through to the brace scan */ }
  }
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      const v = JSON.parse(text.slice(a, b + 1))
      if (isObj(v)) return { kind: 'json', note: text.slice(0, a).trim(), value: v }
    } catch { /* not JSON after all */ }
  }
  return { kind: 'text', text: text.trim() }
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
 * Turn a reply's JSON into the compact document to load, or null when the
 * shape is not one the scope asked for. Slide scope: the object is a slide
 * and replaces the open one (its id is forced back to the open slide's, so
 * a reply cannot re-key it); deck scope: the object is the deck. Private
 * fields come from the live document, assets from the elision map.
 */
export function mergeReply(doc: BentoDoc, scope: AssistantScope, currentIndex: number, value: Obj, elided: Elided): string | null {
  let next: Obj
  if (scope === 'slide') {
    if (!Array.isArray(value.elements) && !isObj(value.slide)) return null
    const slideIn = (isObj(value.slide) ? value.slide : value) as Obj
    // the other slides come from the LIVE document, assets and all — only the
    // reply's slide carries tokens, and only the send-time map can read them
    const base = compactDoc(doc)
    const slides = [...((base.slides ?? []) as Obj[])]
    const cur = slides[currentIndex]
    if (!cur) return null
    slides[currentIndex] = { ...(restoreWalk(slideIn, elided.assets) as Obj), id: cur.id }
    next = { ...base, slides }
  } else {
    if (!Array.isArray(value.slides)) return null
    next = { ...(restoreWalk(value, elided.assets) as Obj), [COMPACT_FLAG]: true }
    dedupeIds(next)
    // comments never went out, so a reply cannot carry them back: the live
    // document's threads stay on the slides that still exist
    const threads = new Map(doc.slides.map((s) => [s.id, s.comments]))
    for (const s of next.slides as Obj[]) {
      const c = threads.get(String(s.id))
      if (c) s.comments = c; else delete s.comments
    }
  }
  for (const k of PRIVATE_KEYS) delete next[k]
  const live = doc as unknown as Obj
  if (live.docId !== undefined) next.docId = live.docId
  return JSON.stringify(next)
}
