// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The compact document — an authoring shape for agents (issue #422,
 * discussion #411 by benedictjohannes, whose bentoUtils.ts POC is the idea
 * this follows).
 *
 * A full bento/slides element carries a dozen fields no author chose:
 * rotation 0, opacity 1, the font stack, weight 400, centre/middle, line
 * height 1.25 … An agent writing a hundred-element deck spends most of its
 * output on that boilerplate. The compact form is the same document with
 * every field that equals what the editor would have inserted LEFT OUT, and
 * three conveniences on top:
 *
 *   - `"compact": true` at the top level says "expand me". Without it a
 *     document is taken as full, exactly as today — so a full file that
 *     happens to lack an optional field keeps its meaning (a text box with
 *     no `fontFamily` renders in the THEME font; the expanded default is the
 *     editor's font stack, and those are not the same thing).
 *   - `elements` may nest arrays: `[title, [cardBg, cardTitle, cardBody]]`.
 *     A factory helper that returns a group is the natural way to write a
 *     card, and flattening it here means the helper needs no spread at the
 *     call site (the POC's `BentoElement | BentoElement[]`).
 *   - `id` may be omitted. A missing id is minted DETERMINISTICALLY as
 *     `${slideId}-${type}-${n}` (n = the element's index on that slide), so
 *     re-running the same generator yields the same ids, morph pairing across
 *     slides still works when the author repeats an id on purpose, and a
 *     round-trip through the editor never changes an id it did not mint.
 *
 * Defaults come from the SAME functions model.ts's editor paths use
 * (defaultText, defaultShape, …), never a second table — a second table is
 * what drifts. Where the editor derives a value from the deck (text colour
 * from the slide background via readableInk, a table's style from the theme,
 * a slide's background from the theme), expansion consults the same thing.
 *
 * Contract: `expandDoc(compactDoc(d))` deep-equals `d` for every valid full
 * document (scripts/test-slides-compact.ts holds the starter deck and the
 * gallery decks to it), and `compactDoc` never removes a field whose value
 * differs from the default. The FILE on disk is always full: nothing here
 * touches save, so no shipped shell ever meets a compact document.
 */

import {
  FORMAT, FORMAT_VERSION, FONT_STACK,
  defaultText, defaultShape, defaultImage, defaultChart, defaultCode, defaultTable, defaultMedia,
  readableInk, isLightBg, newDoc,
  type BentoDoc, type Slide, type SlideElement, type ShapeKind,
} from './model.ts'

/** Marker on a compact document. Consumed by expandDoc; never stored. */
export const COMPACT_FLAG = 'compact'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => deepEqual(v, (b as unknown[])[i]))
  const ka = Object.keys(a as Obj), kb = Object.keys(b as Obj)
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Obj)[k], (b as Obj)[k]))
}

/**
 * What the editor would insert for this element type on this slide, with the
 * author's fields laid over it. `x y w h` and the type's required content are
 * never defaulted here in a way an author would keep — the defaults' geometry
 * is a fixed spot on the canvas, so compactDoc keeps geometry always.
 */
function elementDefaults(el: Obj, slide: Obj, doc: Obj): Obj | null {
  const theme = (doc.theme ?? {}) as BentoDoc['theme']
  const bg = typeof slide.background === 'string' ? slide.background : (theme?.background ?? '#FFFFFF')
  const ink = readableInk(bg)
  switch (el.type) {
    case 'text': return defaultText({ id: '', html: '', color: ink }) as unknown as Obj
    case 'shape': return defaultShape((el.shape as ShapeKind) ?? 'rect', { id: '' }) as unknown as Obj
    case 'image': return defaultImage('', { id: '' }) as unknown as Obj
    case 'chart': return defaultChart({}, { id: '' }) as unknown as Obj
    case 'code': return defaultCode({ id: '', content: '', color: ink }) as unknown as Obj
    case 'table': {
      // editor.newTable(): themed style, adapted for a dark slide
      const tbl = defaultTable({ id: '' }, theme) as unknown as Obj
      if (!isLightBg(bg)) {
        const style = { ...(tbl.style as Obj) }
        style.color = ink
        style.zebra = 'rgba(255,255,255,0.06)'
        style.borderColor = 'rgba(255,255,255,0.16)'
        tbl.style = style
      }
      return tbl
    }
    case 'media': return defaultMedia((el.kind as 'video' | 'audio') ?? 'video', '', { id: '' }) as unknown as Obj
    default: return null // svg, embed: no insert helper, nothing to default
  }
}

/** Keys compactDoc never strips even when equal to the default: identity,
 *  geometry and the type's own content. Absent = the element is unplaced. */
const KEEP = new Set(['id', 'type', 'x', 'y', 'w', 'h', 'html', 'shape', 'kind', 'src', 'option', 'content', 'columns', 'rows'])

function slideDefaults(doc: Obj): Obj {
  const theme = (doc.theme ?? {}) as { background?: string }
  return { background: theme.background ?? '#FFFFFF', transition: 'fade', notes: '', elements: [] }
}

function docDefaults(): Obj {
  const d = newDoc() as unknown as Obj
  // docId and modified are minted per document; never a default to strip or fill
  return { format: FORMAT, version: FORMAT_VERSION, title: d.title, size: d.size, theme: d.theme }
}

// ---------------------------------------------------------------------------

/** Strip every field equal to what expandDoc would put back. Pure; the input
 *  is not mutated. The result carries `compact: true`. */
export function compactDoc(full: BentoDoc): Obj {
  const doc = full as unknown as Obj
  const out: Obj = { [COMPACT_FLAG]: true }
  const dd = docDefaults()
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'slides' || k === COMPACT_FLAG) continue
    if (k in dd && deepEqual(v, dd[k])) continue
    out[k] = v
  }
  // theme: strip the slots that equal newDoc's theme, keep the rest
  if (isObj(doc.theme)) {
    const base = dd.theme as Obj
    const th: Obj = {}
    for (const [k, v] of Object.entries(doc.theme)) if (!(k in base && deepEqual(v, base[k]))) th[k] = v
    if (Object.keys(th).length) out.theme = th; else delete out.theme
  }
  out.slides = ((doc.slides ?? []) as Obj[]).map((slide) => {
    const sd = slideDefaults(doc)
    const s: Obj = {}
    for (const [k, v] of Object.entries(slide)) {
      if (k === 'elements') continue
      if (k in sd && deepEqual(v, sd[k])) continue
      s[k] = v
    }
    const els = ((slide.elements ?? []) as Obj[]).map((el, i) => {
      const defaults = elementDefaults(el, slide, doc)
      const e: Obj = {}
      const minted = el.id === mintId(slide, el, i)
      for (const [k, v] of Object.entries(el)) {
        if (k === 'id' && minted) continue
        if (KEEP.has(k) || !defaults || !(k in defaults)) { e[k] = v; continue }
        if (deepEqual(v, defaults[k])) continue
        e[k] = v
      }
      return e
    })
    if (els.length) s.elements = els
    return s
  })
  return out
}

const mintId = (slide: Obj, el: Obj, i: number) => `${slide.id}-${el.type}-${i}`

/** Is the author's doc-level value the shape the editor will dereference?
 *  format/version must be ours; size a {width,height} of numbers; theme an
 *  object; title a string. */
const usableDocField = (k: string, v: unknown, dd: Obj): boolean =>
  k === 'size' ? isObj(v) && typeof v.width === 'number' && typeof v.height === 'number' && v.width > 0 && v.height > 0
  : k === 'theme' ? isObj(v)
  : k === 'title' ? typeof v === 'string'
  : k === 'format' || k === 'version' ? v === dd[k]
  : true

/** Is this JSON a compact document? The flag decides; nothing is inferred. */
export const isCompact = (doc: unknown): boolean => isObj(doc) && doc[COMPACT_FLAG] === true

/**
 * Fill every omitted field, flatten nested element arrays, mint missing ids.
 * Pure; returns a new object. A document without the flag is returned as is
 * (so callers can pass everything through). Slides without an id get
 * `s${n}` (1-based); elements without one get `${slideId}-${type}-${index}`.
 */
export function expandDoc(input: unknown): BentoDoc {
  if (!isCompact(input)) return input as BentoDoc
  const src = input as Obj
  const dd = docDefaults()
  const doc: Obj = { ...dd, ...src }
  delete doc[COMPACT_FLAG]
  // The editor dereferences these unconditionally on first render — render.ts
  // reads doc.size.width/height for every thumbnail (rebuildSidebar) and
  // doc.theme.fontFamily for every text box; the About dialog reads
  // doc.title — and parseDoc only checks format and a non-empty slides array,
  // so a document without `size` passes it and throws in the sidebar. A
  // missing one is the default; so is one of the wrong shape (`size: null`,
  // `title: 3`): an author who wrote that meant "I don't care", not "break".
  for (const k of Object.keys(dd)) {
    if (!(k in src) || !usableDocField(k, src[k], dd)) doc[k] = dd[k]
  }
  doc.theme = { ...(dd.theme as Obj), ...(isObj(src.theme) ? src.theme : {}) }
  for (const k of Object.keys(dd.theme as Obj)) if (typeof (doc.theme as Obj)[k] !== 'string') (doc.theme as Obj)[k] = (dd.theme as Obj)[k]
  const slidesIn = Array.isArray(src.slides) ? (src.slides as unknown[]) : []
  doc.slides = slidesIn.map((raw, si) => {
    const s0 = isObj(raw) ? raw : {}
    const slide: Obj = { ...slideDefaults(doc), ...s0 }
    if (typeof slide.id !== 'string' || !slide.id) slide.id = `s${si + 1}`
    const flat: Obj[] = []
    const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (isObj(v)) flat.push(v) }
    walk(s0.elements)
    slide.elements = flat.map((el, i) => {
      const defaults = elementDefaults(el, slide, doc) ?? {}
      const out: Obj = { ...defaults, ...el }
      if (typeof out.id !== 'string' || !out.id) out.id = mintId(slide, el, i)
      return out as unknown as SlideElement
    })
    return slide as unknown as Slide
  })
  return doc as unknown as BentoDoc
}

/** The font stack expansion assumes for text — exported so the rig can state
 *  why a full document without `fontFamily` is NOT auto-expanded. */
export const EXPANDED_TEXT_FONT = FONT_STACK

/** The compact JSON of a document, for "Copy compact JSON" and window.bento.compact(). */
export const compactJson = (doc: BentoDoc): string => JSON.stringify(compactDoc(doc))
