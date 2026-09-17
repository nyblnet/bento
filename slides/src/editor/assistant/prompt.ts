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

import type { BentoDoc } from '../../model.ts'
import { compactDoc, COMPACT_FLAG } from '../../compact.ts'
import type { AssistantMessage } from './transport.ts'

export type AssistantScope = 'slide' | 'deck'

/** A conversation turn as the panel keeps it: text only. A reply that edited
 *  the deck is remembered as its note, never as its JSON — the current deck is
 *  sent fresh every turn, so the old JSON would only cost tokens. */
export interface Turn { role: 'user' | 'assistant'; text: string }

export const SYSTEM_PROMPT = `You are the editing assistant inside Bento Slides, a presentation editor. The user shows you their deck as JSON in the bento/slides COMPACT form and asks for changes or questions.

The compact form: a document is { "compact": true, "title", "size": {width,height}, "theme", "layouts", "slides": [...] }. A slide is { "id", "background"?, "transition"?, "notes"?, "elements": [...] }. Every element has "type" and, unless placed by a layout, "x" "y" "w" "h" in slide pixels (the default slide is 1280x720; keep 96px side margins). Types and their content: "text" (html, or md for markdown; fontSize, fontWeight, color, align, valign, fontFamily, lineHeight), "shape" (shape: rect|ellipse|line|path…, fill, stroke, strokeWidth, radius), "image" (src), "table" (columns weights, rows of {cells:[{html}]}, header), "chart" (option in the ECharts shape: bar/line/pie/scatter), "svg" (content). Every field that equals the editor's default may be left out. "elements" may nest arrays. "id" may be omitted — it is minted as <slideId>-<type>-<index>; KEEP an existing element's id when you change it so its identity survives, and give elements that should morph across slides the same id. Text may carry "md" instead of "html". A slide may say "layout" (title, title-content, two-col, section, three-cards, quote, image-left, image-right) and its elements a "role" (title, subtitle, body, kicker, quote, attribution, image, card1…) with no geometry. A string like "@@bento-asset-3@@" stands for an embedded asset: copy it unchanged where you keep that picture; never invent one.

How to answer:
- To CHANGE the deck, reply with one JSON object and nothing else but an optional single sentence before it. For scope "deck" reply with the whole compact document. For scope "slide" reply with just that one slide object (keep its "id").
- Keep everything you were not asked to change exactly as it is. Change only what the request needs.
- To answer a question or when no change is right, reply in plain text with no JSON object.
- Never include "collab", "docId" or "modified".`

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

/** Doc-level fields that are identity or capability, never content. */
const PRIVATE_KEYS = ['collab', 'docId', 'modified', '$schema']

/** The deck as the model sees it: compact, private fields out, assets tokenised. */
export function elideDoc(doc: BentoDoc): Elided {
  const c = compactDoc(doc)
  for (const k of PRIVATE_KEYS) delete c[k]
  const assets: string[] = []
  return { doc: elideWalk(c, assets) as Obj, assets }
}

const MAX_HISTORY = 8

/** The messages for one turn. `currentIndex` picks the slide for scope 'slide'. */
export function buildMessages(doc: BentoDoc, scope: AssistantScope, currentIndex: number, history: Turn[], request: string): { messages: AssistantMessage[]; elided: Elided } {
  const elided = elideDoc(doc)
  const slides = (elided.doc.slides ?? []) as Obj[]
  const messages: AssistantMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]
  for (const turn of history.slice(-MAX_HISTORY)) messages.push({ role: turn.role, content: turn.text })
  const slide = slides[currentIndex]
  const context = scope === 'slide' && slide
    ? `Scope: slide (slide ${currentIndex + 1} of ${slides.length}, id "${String(slide.id ?? '')}").\nThe deck's size is ${JSON.stringify((elided.doc.size ?? { width: 1280, height: 720 }))}${elided.doc.theme ? ` and its theme is ${JSON.stringify(elided.doc.theme)}` : ''}.\nThe slide:\n${JSON.stringify(slide)}`
    : `Scope: deck (${slides.length} slides; slide ${currentIndex + 1} is open).\nThe deck:\n${JSON.stringify(elided.doc)}`
  messages.push({ role: 'user', content: `${request.trim()}\n\n${context}` })
  return { messages, elided }
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
  }
  for (const k of PRIVATE_KEYS) delete next[k]
  const live = doc as unknown as Obj
  if (live.docId !== undefined) next.docId = live.docId
  return JSON.stringify(next)
}
