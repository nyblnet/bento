// System-clipboard copy/paste: external objects (images, text) onto the canvas,
// and Bento elements or whole slides between decks (across tabs/windows).
//
// Bento content is written to the clipboard as JSON tagged with `__bento:"clip"`
// (plain text, so it survives the OS clipboard). Referenced assets (image data,
// fonts) travel inside the payload, so pasting into another deck brings the
// pixels and typefaces along; asset-key collisions with different content are
// remapped so nothing clobbers the target deck.

import type { BentoDoc, Slide, SlideElement } from '../model'
import { uid } from '../model'

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
    if (el.type === 'image' && typeof el.src === 'string' && el.src.startsWith('asset:')) keys.add(el.src.slice(6))
    const a = (el as { asset?: string }).asset
    if (typeof a === 'string') keys.add(a) // svg elements reference an asset key
  }
  return keys
}

function collectAssets(els: SlideElement[], doc: BentoDoc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of assetKeysOf(els)) if (doc.assets?.[k] != null) out[k] = doc.assets[k]
  return out
}

export function serializeElements(els: SlideElement[], doc: BentoDoc): string {
  const payload: ClipPayload = {
    __bento: 'clip', kind: 'elements',
    elements: JSON.parse(JSON.stringify(els)),
    assets: collectAssets(els, doc),
  }
  return JSON.stringify(payload)
}

export function serializeSlides(slides: Slide[], doc: BentoDoc): string {
  const els = slides.flatMap((s) => s.elements)
  const payload: ClipPayload = {
    __bento: 'clip', kind: 'slides',
    slides: JSON.parse(JSON.stringify(slides)),
    assets: collectAssets(els, doc),
    fonts: doc.fonts, // carry typefaces so pasted slides keep their look
  }
  return JSON.stringify(payload)
}

export function parseClip(text: string): ClipPayload | null {
  if (!text || text.length > 40_000_000) return null
  try { const p = JSON.parse(text); return p && p.__bento === 'clip' ? p as ClipPayload : null } catch { return null }
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

function rewriteRefs(els: SlideElement[], remap: Map<string, string>) {
  if (!remap.size) return
  for (const el of els) {
    if (el.type === 'image' && typeof el.src === 'string' && el.src.startsWith('asset:')) {
      const k = el.src.slice(6); if (remap.has(k)) el.src = 'asset:' + remap.get(k)
    }
    const a = (el as { asset?: string }).asset
    if (typeof a === 'string' && remap.has(a)) (el as { asset?: string }).asset = remap.get(a)
  }
}

/** Insert pasted elements onto a slide with fresh ids, nudged so they're visible. */
export function insertElements(payload: ClipPayload, doc: BentoDoc, slide: Slide): SlideElement[] {
  const remap = mergeAssets(payload, doc)
  const els: SlideElement[] = (payload.elements ?? []).map((e) => ({
    ...(JSON.parse(JSON.stringify(e)) as SlideElement),
    id: uid(e.type[0]),
    x: (e.x ?? 0) + 20, y: (e.y ?? 0) + 20,
  }))
  rewriteRefs(els, remap)
  slide.elements.push(...els)
  return els
}

/** Insert pasted slides at `at` with fresh slide ids; merge assets + fonts. */
export function insertSlides(payload: ClipPayload, doc: BentoDoc, at: number): Slide[] {
  const remap = mergeAssets(payload, doc)
  if (payload.fonts?.length) {
    doc.fonts = doc.fonts ?? []
    for (const f of payload.fonts) if (!doc.fonts.some((g) => g.family === f.family)) doc.fonts.push(f)
  }
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
