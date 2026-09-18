// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What the model is told about a deck, and how its reply is read. Ported
// from slides/src/editor/assistant/prompt.ts + ops.ts (the prompt half) when
// the maintainer moved the assistant's weight out of the shell. The split:
// the PAGE keeps format knowledge — it builds the outlines (compact form,
// table cells, chart options, the minted-id rule change with the format,
// not with models) and it validates and applies the patch; THIS side keeps
// model knowledge — which turn a request is, how much of the material fits
// the model's window, the prompts and reply schemas, how a reply is read.
// PURE: no DOM, no `chrome`, no fetch; assistant.js runs it and the rig
// drives it in node.
//
// TWO KINDS OF TURN. A QUESTION ("summarise this deck", "what is slide 4
// about?") sends a text OUTLINE of the deck — slide numbers, the words on
// each slide, the notes — and asks for prose. An EDIT sends the ADDRESSED
// outline (every text, table cell and chart with its <slide>/<id>) plus the
// FOCUS in full — the selected elements' compact JSON, or the open slide's —
// and asks for an OPS PATCH: targeted operations the page applies to a copy
// of its deck and passes through its own gate. The deck is read whole and
// written surgically; the model never hands it back.
//
// THE WINDOW DECIDES HOW MUCH GOES. Outline + focus + room for the reply must
// fit the model's input window; when the focus does not, only the outline
// goes (words-and-choices ops still work — that is what Gemini Nano gets on
// a busy slide); when even the outline does not, the turn is refused with
// the numbers.
//
// THE MATERIAL. The page answers `assistant.document` with every shape at
// once and this side picks by the model it holds:
//
//   outline    string   words + notes, no addresses            (a question)
//   addressed  string   every text/table cell/chart as <slide>/<id>  (an edit)
//   open       number   the open slide, 1-based
//   size       {width, height}
//   focus      null | { kind:'elements'|'slide', label, json }
//                       the selected elements or the open slide, compact
//                       JSON with ids filled in; `label` the phrase for
//                       the prompt ("the 2 selected elements on slide 3
//                       (address each as 3/<id>)")
//   theme?     string   JSON, when the deck has one
//
// Assets never arrive (the page tokenises them); nothing here reads any of
// it as anything but text to place in a prompt.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

export const LAYOUTS = ['title', 'title-content', 'two-col', 'section', 'three-cards', 'quote', 'image-left', 'image-right', 'blank']
const SIZE = ['bigger', 'smaller']
const WEIGHT = ['bold', 'normal']
const ALIGN = ['left', 'center', 'right']

/** The strict schema: the words-and-choices verbs only — what a turn that
 *  carried no focus JSON (a small window) is asked for. Kept to type/
 *  properties/items/required/enum, the subset every dialect takes. */
export const OPS_SCHEMA = {
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

/** The loose shape for a turn that carried the focus JSON and may `set`/`insert` free fields. */
export const OBJECT_SCHEMA = { type: 'object' }

/** The system prompt for an ops turn. Short: it has to fit a small window
 *  beside the outline, and a small model follows a short list better. */
export const OPS_PROMPT = `You are the editing assistant inside Bento Slides, a presentation editor. The user shows you an outline of their whole deck — each slide numbered, each text with its address in [square brackets], tables listing cells as r<row>c<col>, charts their series and numbers — and, when there is room, the FOCUS in full: the selected elements or the open slide as compact JSON (fields: x y w h in slide pixels, fill, stroke, strokeWidth, radius, fontSize, fontWeight, color, align, valign, fontFamily, lineHeight, html/md, src, shape, option). Requests about "this" mean the focus. Reply with ONE JSON object and nothing else, using only the keys you need:
- "edits": [{"id","text"}] — a text's complete new wording (markdown allowed: **bold**, *italic*, a blank line between paragraphs). The id copied exactly as shown.
- "notes": [{"slide","text"}] — a slide's speaker notes.
- "cells": [{"id","row","col","text"}] — one table cell.
- "chart": [{"id","series":[{"name","data":[numbers]}],"categories":[...]}] — a chart's numbers.
- "style": [{"id","size":"bigger"|"smaller","weight":"bold"|"normal","align":"left"|"center"|"right"}] — a text's look.
- "add": [{"after": slide number (0 = at the start), "layout": "title"|"title-content"|"two-col"|"section"|"three-cards"|"quote"|"blank", "title","subtitle","kicker","body","left","right","quote","attribution","card1","card2","card3","notes", "elements": [full elements, only for a slide you design yourself]}] — a new slide.
- "remove": [slide numbers]. "move": [{"slide","to"}] — put a slide where another is.
- "set": [{"id", ...fields}] — change an element precisely: only the fields you change, values in the compact form shown in the focus; never id or type.
- "insert": [{"slide", "type": "text"|"shape"|"image"|"table"|"chart", ...fields with x y w h}] — a new element (the slide is 1280×720 unless the size says otherwise; keep 96px side margins).
- "delete": ["n/id"] — remove elements. "slide": [{"slide","background","transition","layout","hidden"}] — a slide's own fields.
Change only what the request asks. Leave everything else out. If it cannot be done with these operations, say so in plain text and do not write JSON.`

/** The system prompt for a QUESTION turn: an outline goes out, prose comes
 *  back. Short on purpose — it has to fit an on-device model too. */
export const QUESTION_PROMPT = `You are the assistant inside Bento Slides, a presentation editor. The user shows you an outline of their slides (the words on each slide and the speaker notes) and asks about it. Answer in plain text: clear and short, no JSON, no code. If they ask for a change rather than a question, describe what you would change and say they can ask for it as an instruction.`

/** The one follow-up when an edit comes back as prose: sent once, as the
 *  next user turn, before the reply is shown as text. */
export const RETRY_NUDGE = 'Reply with only the JSON object described — no explanation, no prose.'

export const MAX_HISTORY = 8
/** A small-window edit keeps only the last exchange: a small model primed
 *  by a paragraph of its own summary answers with another one. */
export const WORDS_HISTORY = 2
export const ASSUMED_WINDOW_LOCAL = 6144
export const ASSUMED_WINDOW_HOSTED = 128_000
/** tokens kept for the reply: a prose answer, or a patch (which can carry
 *  the focus back changed — hence the focus's own size on top) */
const REPLY_ROOM = 1500

/**
 * Does the request ask ABOUT the deck rather than for a change to it? A
 * trailing question mark, or an opening that asks. A wrong guess costs
 * little either way: a question sent as an edit gets prose back (the edit
 * prompt allows prose), an edit sent as a question gets prose describing
 * the change — the reply says so and the user rephrases.
 */
const QUESTION_RE = /^(?:(?:please|can|could|would)\s+(?:you\s+)?)?(?:summari[sz]e|sum up|explain|describe|review|critique|assess|evaluate|check|proofread|list|count|compare|what|what's|whats|why|how|which|who|where|when|is|are|does|do|did|tell me|give me (?:a |an |some |your )?(?:summary|overview|feedback|thoughts|opinion|ideas?|suggestions?)|suggest|recommend|any (?:ideas|thoughts|suggestions)|thoughts on|feedback on)\b/i
export function isQuestion(request) {
  const r = String(request).trim()
  if (/\?\s*$/.test(r)) return true
  return QUESTION_RE.test(r)
}

/** Roughly how many model tokens a text costs: chars/4, the usual estimate
 *  for English and JSON. Only used to refuse early, never to bill. */
export const approxTokens = (text) => Math.ceil(String(text).length / 4)

/** The reply's shape for providers that constrain output: strict when no
 *  focus went (a small model asked in prose answers in prose), loose when
 *  the focus went (set/insert need free fields), none for a question. */
export const responseSchema = (mode, focus = 'none') => (mode === 'ask' ? undefined : focus === 'none' ? OPS_SCHEMA : OBJECT_SCHEMA)

/** The material as the page sends it, bounded to strings and numbers; null when it is not material. */
export function validMaterial(payload) {
  if (!isObj(payload)) return null
  const str = (v) => (typeof v === 'string' ? v : '')
  const m = {
    outline: str(payload.outline),
    addressed: str(payload.addressed),
    open: Number.isInteger(payload.open) && payload.open >= 1 ? payload.open : 1,
    size: isObj(payload.size) && Number.isFinite(payload.size.width) && Number.isFinite(payload.size.height)
      ? { width: payload.size.width, height: payload.size.height } : { width: 1280, height: 720 },
    focus: null,
  }
  if (!m.outline && !m.addressed) return null
  const f = payload.focus
  if (isObj(f) && (f.kind === 'elements' || f.kind === 'slide') && typeof f.json === 'string' && f.json) {
    m.focus = { kind: f.kind, label: str(f.label), json: f.json }
  }
  if (typeof payload.theme === 'string' && payload.theme) m.theme = payload.theme
  return m
}

/**
 * The messages for one turn from the material. `focus` here is what WENT
 * ('elements' | 'slide' | 'none'); `window` the model's input window in
 * tokens. `fits:false` means even the outline cannot fit — the caller
 * refuses with the numbers.
 */
export function buildMessages(material, history, request, window) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
    .slice(-MAX_HISTORY)
  const tokensOf = (ts) => approxTokens(ts.map((t) => t.text).join('\n'))
  const req = String(request).trim()

  if (isQuestion(req)) {
    const context = `Deck outline (slide ${material.open} is open):\n${material.outline || material.addressed}`
    const contextTokens = approxTokens(QUESTION_PROMPT + context)
    const messages = [{ role: 'system', content: QUESTION_PROMPT }]
    for (const turn of turns) messages.push({ role: turn.role, content: turn.text })
    messages.push({ role: 'user', content: `${context}\n\n${req}` })
    return { messages, mode: 'ask', focus: 'none', contextTokens, window, fits: contextTokens + REPLY_ROOM + tokensOf(turns) <= window }
  }

  const outline = `Deck outline, addressed (slide ${material.open} is open; the deck's size is ${JSON.stringify(material.size)}):\n${material.addressed || material.outline}`
  let focusSent = 'none'
  let focusText = ''
  if (material.focus) {
    focusSent = material.focus.kind
    focusText = `Focus — ${material.focus.label}${material.theme ? `; the deck's theme is ${material.theme}` : ''}:\n${material.focus.json}`
  }
  const base = approxTokens(OPS_PROMPT + outline)
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
  const messages = [{ role: 'system', content: OPS_PROMPT }]
  for (const turn of history2) messages.push({ role: turn.role, content: turn.text })
  // the outline first, the request last: the thing to do is the freshest text
  messages.push({ role: 'user', content: `${context}\n\n${req}` })
  return { messages, mode: 'edit', focus: focusSent, contextTokens: approxTokens(OPS_PROMPT + context), window, fits }
}

/**
 * Find the one JSON object in a reply. A fenced block wins; otherwise the
 * outermost {…} that parses. Anything else is plain text. A note is whatever
 * text stood before the object.
 */
export function parseReply(text) {
  const s = String(text ?? '')
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/i.exec(s)
  if (fence) {
    try {
      const v = JSON.parse(fence[1])
      if (isObj(v)) return { kind: 'json', note: s.slice(0, fence.index).trim(), value: v }
    } catch { /* fall through to the brace scan */ }
  }
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      const v = JSON.parse(s.slice(a, b + 1))
      if (isObj(v)) return { kind: 'json', note: s.slice(0, a).trim(), value: v }
    } catch { /* not JSON after all */ }
  }
  return { kind: 'text', text: s.trim() }
}
