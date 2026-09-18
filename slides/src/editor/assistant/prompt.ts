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
// TWO KINDS OF TURN. A QUESTION ("summarise this deck", "what is slide 4
// about?") sends a text OUTLINE of the deck — slide numbers, the words on
// each slide, the notes — and asks for prose; its reply is never applied,
// whatever shape it comes back in. An EDIT sends the ADDRESSED outline
// (every text, table cell and chart with its <slide>/<id>) plus the FOCUS
// in full — the selected elements' compact JSON, or the open slide's — and
// asks for an OPS PATCH (ops.ts): targeted operations, applied to a copy of
// the elided compact doc, which then takes the same road as pasted JSON:
// mergeReply → the gate → cleanDoc → one undoable swap. The deck is read
// whole and written surgically; the model never hands it back. Measured on
// the starter deck: the compact deck is 88 KB (~22k tokens), its outline
// under 5 KB, one slide 3–11 KB — and the window rule (below) decides how
// much of that a given model gets.

import { isWebUrl, type BentoDoc } from '../../model.ts'
import { compactDoc, COMPACT_FLAG } from '../../compact.ts'
import type { AssistantMessage } from './transport.ts'
import { applyOps, elId, OPS_PROMPT, OPS_SCHEMA } from './ops.ts'
export { applyOps, elId, OPS_PROMPT, OPS_SCHEMA } from './ops.ts'

/** A conversation turn as the panel keeps it: text only. A reply that edited
 *  the deck is remembered as its note, never as its JSON — the current deck is
 *  sent fresh every turn, so the old JSON would only cost tokens. */
export interface Turn { role: 'user' | 'assistant'; text: string }

/** The system prompt for an EDIT turn: ops.ts owns it (outline + focus in,
 *  an ops patch out). */
export const EDIT_PROMPT = OPS_PROMPT

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

/**
 * The wording half of an ops patch on its own (ops.ts applyOps does the
 * rest): each edit names a text element as the outline showed it —
 * `<slide number>/<element id>`, because element ids REPEAT across slides
 * (the morph idiom: the kicker on every slide is `sd-kicker`) and a bare
 * id would land on the wrong slide. Returns the ids as given.
 */
export function applyWordEdits(compact: Obj, edits: unknown): { doc: Obj; applied: string[]; skipped: string[] } {
  const r = applyOps(compact, { edits })
  const strip = (s: string) => s.replace(/^edit /, '')
  return { doc: r.doc, applied: r.applied.map(strip), skipped: r.skipped.map(strip) }
}

/** Roughly how many model tokens a text costs: chars/4, the usual estimate
 *  for English and JSON. Only used to refuse early, never to bill. */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * ONE SHAPE OF EDIT TURN, THE WAY THE BIG ASSISTANTS DO IT. The model reads
 * the whole deck cheaply — the addressed OUTLINE (every slide's words,
 * notes, table cells, chart numbers, a few KB) — plus the FOCUS in full:
 * the selected elements' compact JSON, or the current slide's when nothing
 * is selected. It answers with an OPS PATCH (ops.ts): targeted operations
 * addressed by slide number and element id. The document is read whole and
 * written surgically; it is never handed back. That is the shape Gemini in
 * Slides and Claude with a file use, and it is why there is no "this slide
 * / whole deck" switch: the selection is the scope, and a model that can
 * see the outline can act on any slide the request names.
 *
 * THE WINDOW STILL DECIDES HOW MUCH GOES. Every model has an input window;
 * the extension reports it (describe.contextTokens) or the page assumes one
 * (small on-device, large hosted). Outline + focus + room for the reply must
 * fit; when the focus does not, only the outline goes (words-and-choices
 * ops still work — that is what Gemini Nano gets on a busy slide); when
 * even the outline does not, the turn is refused with the numbers. A
 * question sends the plain outline and takes prose.
 */
export const ASSUMED_WINDOW_LOCAL = 6144
export const ASSUMED_WINDOW_HOSTED = 128_000
/** tokens kept for the reply: a prose answer, or a patch (which can carry
 *  the focus back changed — hence the focus's own size on top) */
const REPLY_ROOM = 1500

/** What a turn is: a question (outline out, prose back) or an edit (outline
 *  + focus out, an ops patch back). */
export type TurnMode = 'ask' | 'edit'

/** What the turn sent as focus: the selected elements, the current slide,
 *  or nothing beyond the outline (the window was too small for it). */
export type FocusSent = 'elements' | 'slide' | 'none'

/**
 * The reply's shape, for providers that constrain output (the Prompt API's
 * responseConstraint, Gemini's responseSchema, OpenAI's json_schema). A turn
 * that carried no focus JSON is a small-window turn: the strict words-and-
 * choices schema (ops.ts OPS_SCHEMA) — a small model asked in prose answers
 * in prose (measured on Gemini Nano); constrained, it cannot. A turn with
 * focus may also `set`/`insert` free properties, which a strict schema
 * would forbid, so it takes the loose "an object". A question has none.
 */
export const OBJECT_SCHEMA: Record<string, unknown> = { type: 'object' }
export const responseSchema = (mode: TurnMode, focus: FocusSent = 'none'): Record<string, unknown> | undefined =>
  mode === 'ask' ? undefined : focus === 'none' ? OPS_SCHEMA : OBJECT_SCHEMA

/** A small-window edit keeps only the last exchange: a small model primed
 *  by a paragraph of its own summary answers with another one. */
export const WORDS_HISTORY = 2

/** The one follow-up when an edit comes back as prose: sent once, as the
 *  next user turn, before the reply is shown as text. */
export const RETRY_NUDGE = 'Reply with only the JSON object described — no explanation, no prose.'

/** Where the user is: the open slide, and what is selected on it. */
export interface Focus { index: number; selection: string[] }

export interface BuiltMessages {
  messages: AssistantMessage[]
  elided: Elided
  mode: TurnMode
  question: boolean
  /** what went as focus */
  focus: FocusSent
  /** tokens this turn sends (system prompt + context), estimated */
  contextTokens: number
  /** the window the turn was sized to */
  window: number
  /** false = nothing fits: the panel refuses with the numbers */
  fits: boolean
}

export interface BuildOpts { local?: boolean; contextTokens?: number }

/** The messages for one turn. `focus` is where the user is; `opts` what
 *  the model is (window, on-device). */
export function buildMessages(doc: BentoDoc, focus: Focus, history: Turn[], request: string, opts: BuildOpts = {}): BuiltMessages {
  const elided = elideDoc(doc)
  const slides = (elided.doc.slides ?? []) as Obj[]
  const window = opts.contextTokens ?? (opts.local ? ASSUMED_WINDOW_LOCAL : ASSUMED_WINDOW_HOSTED)
  const turns = history.slice(-MAX_HISTORY)
  const tokensOf = (ts: Turn[]) => approxTokens(ts.map((t) => t.text).join('\n'))
  const n = focus.index + 1
  const slide = slides[focus.index]

  if (isQuestion(request)) {
    const context = `Deck outline (slide ${n} is open):\n${outlineDeck(elided.doc, false)}`
    const contextTokens = approxTokens(QUESTION_PROMPT + context)
    const messages: AssistantMessage[] = [{ role: 'system', content: QUESTION_PROMPT }]
    for (const turn of turns) messages.push({ role: turn.role, content: turn.text })
    messages.push({ role: 'user', content: `${context}\n\n${request.trim()}` })
    return { messages, elided, mode: 'ask', question: true, focus: 'none', contextTokens, window, fits: contextTokens + REPLY_ROOM + tokensOf(turns) <= window }
  }

  // the focus: selected elements (by id, on the open slide), else the slide
  const outline = `Deck outline, addressed (slide ${n} is open; the deck's size is ${JSON.stringify(elided.doc.size ?? { width: 1280, height: 720 })}):\n${outlineDeck(elided.doc, true)}`
  let focusSent: FocusSent = 'none'
  let focusText = ''
  if (slide) {
    const els = flatElements(slide)
    const picked = focus.selection.length ? els.filter((e, i) => focus.selection.includes(elId(slide, e, i))) : []
    if (picked.length) {
      focusSent = 'elements'
      focusText = `Focus — the ${picked.length === 1 ? 'selected element' : `${picked.length} selected elements`} on slide ${n} (address each as ${n}/<id>), in full:\n${JSON.stringify(picked.map((e) => ({ id: elId(slide, e, els.indexOf(e)), ...e })))}`
    } else {
      focusSent = 'slide'
      focusText = `Focus — slide ${n} (id "${String(slide.id ?? '')}") in full, its elements addressed as ${n}/<id>${elided.doc.theme ? `; the deck's theme is ${JSON.stringify(elided.doc.theme)}` : ''}:\n${JSON.stringify({ ...slide, elements: els.map((e, i) => ({ id: elId(slide, e, i), ...e })) })}`
    }
  }
  const base = approxTokens(EDIT_PROMPT + outline)
  const focusTokens = approxTokens(focusText)
  let fits = true
  let history2 = turns
  // outline + focus + a reply that may carry the focus back changed
  if (base + focusTokens * 2 + REPLY_ROOM + tokensOf(turns) > window) {
    focusSent = 'none'; focusText = ''
    history2 = turns.slice(-WORDS_HISTORY)
    fits = base + REPLY_ROOM + tokensOf(history2) <= window
  }
  const context = focusText ? `${outline}\n\n${focusText}` : outline
  const messages: AssistantMessage[] = [{ role: 'system', content: EDIT_PROMPT }]
  for (const turn of history2) messages.push({ role: turn.role, content: turn.text })
  // the outline first, the request last: the thing to do is the freshest text
  messages.push({ role: 'user', content: `${context}\n\n${request.trim()}` })
  return { messages, elided, mode: 'edit', question: false, focus: focusSent, contextTokens: approxTokens(EDIT_PROMPT + context), window, fits }
}

/** A compact slide's elements, flat (authoring may nest arrays). */
export function flatElements(slide: Obj): Obj[] {
  const out: Obj[] = []
  const visit = (v: unknown) => { if (Array.isArray(v)) { for (const x of v) visit(x) } else if (isObj(v)) out.push(v) }
  visit(slide.elements)
  return out
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
 * The patched compact deck (ops.ts applyOps) → the compact document to
 * load: assets back from the elision map, ids de-duplicated, the live
 * document's comment threads back on the slides that still exist, private
 * fields from the live document. Null when it is not a deck.
 */
export function mergeReply(doc: BentoDoc, value: Obj, elided: Elided): string | null {
  if (!Array.isArray(value.slides)) return null
  const next: Obj = { ...(restoreWalk(value, elided.assets) as Obj), [COMPACT_FLAG]: true }
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
