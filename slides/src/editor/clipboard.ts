// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// System-clipboard copy/paste: external objects (images, text) onto the canvas,
// and Bento elements or whole slides between decks (across tabs/windows).
//
// Bento content is written to the clipboard as JSON tagged with `__bento:"clip"`
// (plain text, so it survives the OS clipboard). Referenced assets (image data,
// fonts) travel inside the payload, so pasting into another deck brings the
// pixels and typefaces along; asset-key collisions with different content are
// remapped so nothing clobbers the target deck.
//
// Reading that channel is the untrusted direction — the clipboard is public,
// and a payload on it need not have come from a Bento deck. parseClip rebuilds
// what it finds through untrusted.ts before anything reaches the document, so
// that a fragment the format cannot express never becomes part of one.

import type { BentoDoc, Slide, SlideElement, TextElement } from '../model'
import { uid } from '../model'
import { firstFamily } from '../fonts'
import { stripEmbeddedEnvelopes } from '../envelope'
import { LIMITS, sanitizeAssets, sanitizeElement, sanitizeFonts, sanitizeSlide } from '../untrusted'

export interface ClipPayload {
  __bento: 'clip'
  kind: 'elements' | 'slides'
  elements?: SlideElement[]
  slides?: Slide[]
  assets?: Record<string, string>
  fonts?: BentoDoc['fonts']
}

function assetKeysOf(els: SlideElement[]): Set<string> {
  const keys = new Set<string>()
  for (const el of els) {
    // image AND media: both embed through doc.assets, so both can carry a ref
    if ((el.type === 'image' || el.type === 'media') && typeof el.src === 'string' && el.src.startsWith('asset:')) keys.add(el.src.slice(6))
    const a = (el as { asset?: string }).asset
    if (typeof a === 'string') keys.add(a) // svg elements reference an asset key
    // embed: the view may live in doc.assets, and a paste that
    // kept the reference and lost the picture would paint a hole
    if (el.type === 'embed' && typeof el.view === 'string' && el.view.startsWith('asset:')) keys.add(el.view.slice(6))
  }
  return keys
}

function fontsFor(els: SlideElement[], doc: BentoDoc): NonNullable<BentoDoc['fonts']> {
  const families = new Set(
    els
      .filter((el): el is TextElement => el.type === 'text')
      // a text element without its own fontFamily inherits the theme's, so the
      // theme face's embedded font travels with it (#710)
      .map((el) => firstFamily(el.fontFamily ?? doc.theme?.fontFamily ?? '')),
  )
  return (doc.fonts ?? []).filter((font) => families.has(firstFamily(font.family)))
}

function collectAssets(els: SlideElement[], fonts: NonNullable<BentoDoc['fonts']>, doc: BentoDoc): Record<string, string> {
  const out: Record<string, string> = {}
  const keys = assetKeysOf(els)
  for (const font of fonts) keys.add(font.asset)
  for (const k of keys) if (doc.assets?.[k] != null) out[k] = doc.assets[k]
  return out
}

/**
 * A deep clone with every embedded document's envelope removed (envelope.ts —
 * the rule every other copy applies). The system clipboard is readable by any
 * app, and a payload pasted into a chat must not carry another deck's room key.
 * The paste side gates the same rule on the way back in.
 */
function cloneForClipboard<T extends { elements: SlideElement[] }>(slides: T[]): T[] {
  const out = JSON.parse(JSON.stringify(slides)) as T[]
  stripEmbeddedEnvelopes({ slides: out } as unknown as BentoDoc)
  return out
}

export function serializeElements(els: SlideElement[], doc: BentoDoc): string {
  const fonts = fontsFor(els, doc)
  const payload: ClipPayload = {
    __bento: 'clip', kind: 'elements',
    elements: cloneForClipboard([{ elements: els }])[0].elements,
    assets: collectAssets(els, fonts, doc),
    fonts,
  }
  return JSON.stringify(payload)
}

export function serializeSlides(slides: Slide[], doc: BentoDoc): string {
  const els = slides.flatMap((s) => s.elements)
  const fonts = fontsFor(els, doc)
  const payload: ClipPayload = {
    __bento: 'clip', kind: 'slides',
    slides: cloneForClipboard(slides),
    assets: collectAssets(els, fonts, doc),
    fonts,
  }
  return JSON.stringify(payload)
}

/**
 * Read a clip payload off the system clipboard — the ONE place foreign
 * document fragments enter the deck, and so the place they are checked.
 *
 * Nothing about clipboard text says a Bento deck wrote it: any page with a
 * Copy button can leave a `__bento:"clip"` payload there, and this used to
 * hand whatever it contained to insertElements/insertSlides unread. So the
 * payload is REBUILT through untrusted.ts — known kind, known element types,
 * known keys, values of the right shape — and anything that does not conform
 * is dropped rather than repaired.
 *
 * This is the model-shape layer, not the escaping layer: render.ts escapes and
 * validates what it writes into markup on its own (it has to — a deck opened
 * from disk never passes through here). What this adds is that the DOCUMENT
 * never holds the value in the first place, which is the part every future
 * renderer inherits for free.
 *
 * A payload with nothing left after the rebuild returns null, so the paste
 * handler falls through to its plain-text branch: the JSON lands as a visible
 * text element instead of silently doing nothing. That fallback is a poor fit
 * for the SIZE ceiling — an over-budget but perfectly legitimate slide copy
 * deserves "that paste is too large", not 4000 characters of raw JSON — so the
 * ceiling is set where real payloads cannot reach it (LIMITS.clipText).
 */
export function parseClip(text: string): ClipPayload | null {
  if (!text || text.length > LIMITS.clipText) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (p.__bento !== 'clip') return null
  if (p.kind !== 'elements' && p.kind !== 'slides') return null

  const payload: ClipPayload = {
    __bento: 'clip', kind: p.kind,
    assets: sanitizeAssets(p.assets),
    fonts: sanitizeFonts(p.fonts),
  }
  if (p.kind === 'elements') {
    if (!Array.isArray(p.elements) || p.elements.length > LIMITS.elements) return null
    payload.elements = p.elements.map(sanitizeElement).filter((el): el is SlideElement => el !== null)
    if (!payload.elements.length) return null
  } else {
    if (!Array.isArray(p.slides) || p.slides.length > LIMITS.slides) return null
    payload.slides = p.slides.map(sanitizeSlide).filter((s): s is Slide => s !== null)
    if (!payload.slides.length) return null
  }
  return payload
}

/** Merge payload assets into doc; on same-key-different-value, remap to a fresh key. */
function mergeAssets(payload: ClipPayload, doc: BentoDoc): Map<string, string> {
  const remap = new Map<string, string>()
  if (!payload.assets) return remap
  doc.assets = doc.assets ?? {}
  for (const [k, v] of Object.entries(payload.assets)) {
    if (doc.assets[k] === undefined) doc.assets[k] = v
    else if (doc.assets[k] !== v) { const nk = `${k}-${uid('a')}`; doc.assets[nk] = v; remap.set(k, nk) }
  }
  return remap
}

/** Merge embedded-font records after their asset keys have been remapped. */
function mergeFonts(payload: ClipPayload, doc: BentoDoc, remap: Map<string, string>) {
  if (!payload.fonts?.length) return
  doc.fonts = doc.fonts ?? []
  for (const source of payload.fonts) {
    if (doc.fonts.some((font) => font.family === source.family)) continue
    doc.fonts.push({ ...source, asset: remap.get(source.asset) ?? source.asset })
  }
}

function rewriteRefs(els: SlideElement[], remap: Map<string, string>) {
  if (!remap.size) return
  for (const el of els) {
    if ((el.type === 'image' || el.type === 'media') && typeof el.src === 'string' && el.src.startsWith('asset:')) {
      const k = el.src.slice(6); if (remap.has(k)) el.src = 'asset:' + remap.get(k)
    }
    const a = (el as { asset?: string }).asset
    if (typeof a === 'string' && remap.has(a)) (el as { asset?: string }).asset = remap.get(a)
    if (el.type === 'embed' && typeof el.view === 'string' && el.view.startsWith('asset:')) {
      const k = el.view.slice(6); if (remap.has(k)) el.view = 'asset:' + remap.get(k)
    }
  }
}

/**
 * How far to nudge a pasted group so it never lands exactly on top of an
 * element it duplicates (#569). Pasting onto ANOTHER slide keeps the copied
 * position — the point of copying a header or a logo across is that it lands
 * where it was. Only where an element of the same type and size already sits
 * at a pasted element's spot (the source slide, or a slide that got this
 * paste before) does the whole group step +20/+20, as many times as it takes,
 * so repeated pastes still cascade. Payload-independent, so a clip written by
 * an older build behaves the same.
 */
function pasteOffset(els: SlideElement[], slide: Slide): number {
  const sits = (e: SlideElement, d: number) => slide.elements.some((o) =>
    o.type === e.type && o.w === e.w && o.h === e.h && o.x === (e.x ?? 0) + d && o.y === (e.y ?? 0) + d)
  let d = 0
  while (d < 20 * 50 && els.some((e) => sits(e, d))) d += 20
  return d
}

/** Insert pasted elements onto a slide with fresh ids — at their copied
 *  position, nudged only where they would cover what they duplicate. */
export function insertElements(payload: ClipPayload, doc: BentoDoc, slide: Slide): SlideElement[] {
  const remap = mergeAssets(payload, doc)
  mergeFonts(payload, doc, remap)
  const d = pasteOffset(payload.elements ?? [], slide)
  const els: SlideElement[] = (payload.elements ?? []).map((e) => ({
    ...(JSON.parse(JSON.stringify(e)) as SlideElement),
    id: uid(e.type[0]),
    x: (e.x ?? 0) + d, y: (e.y ?? 0) + d,
  }))
  rewriteRefs(els, remap)
  slide.elements.push(...els)
  return els
}

/** Insert pasted slides at `at` with fresh slide ids; merge assets + fonts. */
export function insertSlides(payload: ClipPayload, doc: BentoDoc, at: number): Slide[] {
  const remap = mergeAssets(payload, doc)
  mergeFonts(payload, doc, remap)
  const slides: Slide[] = (payload.slides ?? []).map((s) => {
    const copy = JSON.parse(JSON.stringify(s)) as Slide
    copy.id = uid('slide')
    if (copy.stateOf) delete copy.stateOf // a pasted state becomes a normal slide
    rewriteRefs(copy.elements, remap)
    return copy
  })
  doc.slides.splice(at, 0, ...slides)
  return slides
}
