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
 * Round two, still compact-input only (the saved file is unchanged):
 *
 *   - A text element may OMIT `h`, or say `h: "auto"`: the box is sized to
 *     its text — the same measurement the panel's "Fit height to text" makes,
 *     on the deck's real fonts. An agent cannot know how tall three lines of
 *     24 pt Inter at 800 px are; the runtime can. Measuring needs the DOM, so
 *     this module (pure, node-importable) writes a PROVISIONAL one-line h and
 *     lists the element in `autoHeight`; compactload.ts (browser) measures and
 *     writes the real number before the document reaches the store.
 *   - A text element may carry `md` instead of `html`: markdown, converted by
 *     the SAME function the editor uses for pasted plain text
 *     (editor/markdown.ts markdownToHtml — bold, italic, code, strike, bullets
 *     and indented sub-bullets, [caption](url)). When both are present `html`
 *     wins and `md` is dropped; `md` never reaches the document.
 *
 * Round three — placement by layout and role, so an agent never writes a
 * coordinate it did not choose:
 *
 *   - A compact slide may say `"layout": "<layout id>"` (a built-in, or one
 *     of the compact document's own `layouts`). Its elements may then omit
 *     geometry and typography and carry a `role` instead — `title`, `body`,
 *     `subtitle`, `kicker`, `quote`, `attribution`, `image`, `card1`…: the
 *     layout is instantiated the way the picker does it (element ids KEPT, so
 *     slides born from the same layout still morph their chrome) and each
 *     role'd element's content is laid onto the layout's slot with that role
 *     through model.ts applyLayout — the same matching "Apply layout" in the
 *     editor uses. An element WITH explicit `x y w h` is placed as given, on
 *     top, role or not. A role the layout has no slot for falls back to the
 *     body slot (or, with no body either, to the editor's default frame) and
 *     the load report says so. `left`/`right` name the first and second
 *     `body` slot of a two-column layout. More `body` elements than body slots
 *     STACK into the slot top-to-bottom: an equal share of the slot's height
 *     each here (pure); compactload.ts then measures each and restacks with a
 *     gap so a title and three paragraphs lay out as a reader expects.
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

import { markdownToHtml } from './editor/markdown.ts'
import {
  FORMAT, FORMAT_VERSION, FONT_STACK,
  defaultText, defaultShape, defaultImage, defaultChart, defaultCode, defaultTable, defaultMedia,
  readableInk, isLightBg, newDoc, builtinLayouts, applyLayout,
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

/** What expansion did, for the load report. `autoHeight` names the text
 *  elements (slide id + element id) whose `h` is provisional. */
export interface ExpandStats {
  /** fields filled in from defaults (doc, slide and element level) */
  expanded: number
  /** ids minted for elements that had none */
  minted: number
  /** text elements converted from `md` */
  fromMarkdown: number
  /** text elements whose h is provisional — the browser measures these */
  autoHeight: Array<{ slide: string; id: string }>
  /** slides laid out from a layout by role */
  laidOut: number
  /** role'd elements the layout had no slot for, and where they went */
  notes: Array<{ path: string; reason: string }>
  /** body elements stacked into one slot; compactload.ts restacks these by
   *  measured height (ids in stacking order, the slot's frame) */
  stacks: Array<{ slide: string; ids: string[]; slot: { x: number; y: number; w: number; h: number } }>
}

/** The gap between stacked body elements, in slide px. */
export const STACK_GAP = 16

/** A layout's role → slot map (first slot per role wins; `left`/`right` are
 *  the first and second `body` slot). Exported for AGENTS.md's table rig. */
export function layoutRoles(layout: Slide): Record<string, string> {
  const roles: Record<string, string> = {}
  const bodies: string[] = []
  for (const el of layout.elements) {
    if (!el.role) continue
    if (!(el.role in roles)) roles[el.role] = el.id
    if (el.role === 'body') bodies.push(el.id)
  }
  if (bodies.length >= 2) { roles.left = bodies[0]; roles.right = bodies[1] }
  return roles
}

/** The compact `layout` name resolved to a layout for this deck: a built-in
 *  (by id, with or without the `layout-` prefix) or one of the document's. */
export function findLayout(name: string, doc: Obj): Slide | undefined {
  const size = doc.size as { width: number; height: number } | undefined
  const own = Array.isArray(doc.layouts) ? (doc.layouts as Slide[]) : []
  const all = [...builtinLayouts(size), ...own]
  const key = LAYOUT_ALIASES[name] ?? name
  return all.find((l) => l.id === key) ?? all.find((l) => l.id === `layout-${key}`) ?? all.find((l) => l.name?.toLowerCase() === name.toLowerCase())
}

/** The names an agent says for a built-in, beside the ids themselves. */
export const LAYOUT_ALIASES: Record<string, string> = {
  'title-body': 'layout-title-content',
  'two-column': 'layout-two-col',
  'cards': 'layout-three-cards',
}

const hasFrame = (el: Obj) => ['x', 'y', 'w', 'h'].every((k) => typeof el[k] === 'number')

/**
 * Lay a compact slide's elements onto a layout. `els` are the expanded
 * elements (full defaults, md converted); `raw` the author's originals, to
 * know which carried a frame. Returns the slide's element list.
 */
function layOut(layout: Slide, els: Obj[], raw: Obj[], slideId: string, si: number, stats: ExpandStats): Obj[] {
  const roles = layoutRoles(layout)
  const donors: Obj[] = []
  const extras: Obj[] = []
  const bySlot = new Map<string, Obj[]>() // slot id → donors wanting it, in order
  els.forEach((el, i) => {
    const role = typeof el.role === 'string' ? el.role : ''
    if (!role || hasFrame(raw[i])) { extras.push(el); return }
    let slot = roles[role]
    if (!slot) {
      if (roles.body) {
        slot = roles.body
        stats.notes.push({ path: `/slides/${si}/elements/${i}/role`, reason: `no \`${role}\` slot in layout \`${layout.id}\`; placed as body` })
      } else {
        stats.notes.push({ path: `/slides/${si}/elements/${i}/role`, reason: `no \`${role}\` slot in layout \`${layout.id}\` and no body slot; placed at the default frame` })
        extras.push(el); return
      }
    }
    // the slot's own role is what applyLayout matches on
    const slotEl = layout.elements.find((e) => e.id === slot)!
    const d = { ...el, role: slotEl.role }
    const list = bySlot.get(slot) ?? []
    list.push(d); bySlot.set(slot, list)
    donors.push(d)
  })
  // applyLayout consumes donors in document order, one per slot
  const known = new Set(layout.elements.map((e) => e.id))
  const slideForApply = { id: slideId, elements: donors as unknown as SlideElement[] } as unknown as Slide
  const placed = applyLayout(slideForApply, layout, known) as unknown as Obj[]
  // an image donor that applyLayout turned into the slot keeps the slot id;
  // a text donor's content is now in the slot copy. Anything unconsumed of
  // ours is a SECOND body for its slot → stack. (applyLayout appends
  // unconsumed donors as extras; we take them back out.)
  const donorIds = new Set(donors.map((d) => d.id))
  const out: Obj[] = placed.filter((e) => !donorIds.has(e.id as string))
  for (const [slot, list] of bySlot) {
    if (list.length < 2) continue
    const slotEl = out.find((e) => e.id === slot)
    if (!slotEl || slotEl.type !== 'text') continue
    const n = list.length
    const frame = { x: slotEl.x as number, y: slotEl.y as number, w: slotEl.w as number, h: slotEl.h as number }
    const share = Math.floor((frame.h - STACK_GAP * (n - 1)) / n)
    const ids: string[] = []
    list.forEach((d, k) => {
      const id = k === 0 ? slot : `${slot}-${k + 1}`
      const copy: Obj = { ...slotEl, id, y: frame.y + k * (share + STACK_GAP), h: Math.max(1, share), html: d.html }
      if (k === 0) Object.assign(slotEl, copy)
      else out.splice(out.indexOf(slotEl) + k, 0, copy)
      ids.push(id)
      stats.autoHeight.push({ slide: slideId, id })
    })
    stats.stacks.push({ slide: slideId, ids, slot: frame })
  }
  stats.laidOut++
  return [...out, ...extras]
}

/**
 * Fill every omitted field, flatten nested element arrays, mint missing ids.
 * Pure; returns a new object. A document without the flag is returned as is
 * (so callers can pass everything through). Slides without an id get
 * `s${n}` (1-based); elements without one get `${slideId}-${type}-${index}`.
 */
export function expandDoc(input: unknown): BentoDoc {
  return expandDocWithStats(input).doc
}

/** One line of the text at its font size — the provisional `h` for a text
 *  element that asked to be fitted (compactload.ts replaces it). */
export const provisionalHeight = (fontSize: number, lineHeight: number): number =>
  Math.ceil(fontSize * lineHeight)

/** expandDoc, and what it did. */
export function expandDocWithStats(input: unknown): { doc: BentoDoc; stats: ExpandStats } {
  const stats: ExpandStats = { expanded: 0, minted: 0, fromMarkdown: 0, autoHeight: [], laidOut: 0, notes: [], stacks: [] }
  if (!isCompact(input)) return { doc: input as BentoDoc, stats }
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
    if (!(k in src) || !usableDocField(k, src[k], dd)) { doc[k] = dd[k]; stats.expanded++ }
  }
  doc.theme = { ...(dd.theme as Obj), ...(isObj(src.theme) ? src.theme : {}) }
  for (const k of Object.keys(dd.theme as Obj)) if (typeof (doc.theme as Obj)[k] !== 'string') { (doc.theme as Obj)[k] = (dd.theme as Obj)[k]; stats.expanded++ }
  const slidesIn = Array.isArray(src.slides) ? (src.slides as unknown[]) : []
  doc.slides = slidesIn.map((raw, si) => {
    const s0 = isObj(raw) ? raw : {}
    const sd = slideDefaults(doc)
    // a layout supplies the slide's background/transition unless the author set them
    const layout = typeof s0.layout === 'string' ? findLayout(s0.layout, doc) : undefined
    if (typeof s0.layout === 'string' && !layout) stats.notes.push({ path: `/slides/${si}/layout`, reason: `unknown layout \`${s0.layout}\`; elements placed as given` })
    const slide: Obj = { ...sd, ...(layout ? { background: layout.background, transition: layout.transition } : {}), ...s0 }
    delete slide.layout
    stats.expanded += Object.keys(sd).filter((k) => !(k in s0)).length
    if (typeof slide.id !== 'string' || !slide.id) slide.id = `s${si + 1}`
    const flat: Obj[] = []
    const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (isObj(v)) flat.push(v) }
    walk(s0.elements)
    slide.elements = flat.map((el0, i) => {
      // a role'd or text-bearing element with no `type` is a text box
      const el: Obj = (!el0.type && (typeof el0.role === 'string' || typeof el0.md === 'string' || typeof el0.html === 'string')) ? { type: 'text', ...el0 } : el0
      const defaults = elementDefaults(el, slide, doc) ?? {}
      const out: Obj = { ...defaults, ...el }
      stats.expanded += Object.keys(defaults).filter((k) => !(k in el)).length + (el === el0 ? 0 : 1)
      if (typeof out.id !== 'string' || !out.id) { out.id = mintId(slide, el, i); stats.minted++ }
      if (el.type === 'text') {
        // md → html by the editor's own paste conversion; html wins when both
        if (typeof el.md === 'string') {
          if (typeof el.html !== 'string') { out.html = markdownToHtml(el.md); stats.fromMarkdown++ }
          delete out.md
        }
        // h omitted or "auto": provisional one line; the browser fits it
        if (el.h === undefined || el.h === 'auto') {
          out.h = provisionalHeight(Number(out.fontSize) || 24, Number(out.lineHeight) || 1.2)
          stats.autoHeight.push({ slide: slide.id as string, id: out.id as string })
        }
      }
      return out as unknown as SlideElement
    })
    if (layout) {
      const before = new Set(stats.autoHeight.filter((a) => a.slide === slide.id).map((a) => a.id))
      const laid = layOut(layout, slide.elements as unknown as Obj[], flat, slide.id as string, si, stats)
      // donors that became slot content no longer exist under their own id:
      // their provisional heights are the slot's, not to be measured
      const ids = new Set(laid.map((e) => e.id as string))
      stats.autoHeight = stats.autoHeight.filter((a) => a.slide !== slide.id || !before.has(a.id) || ids.has(a.id))
      slide.elements = laid as unknown as SlideElement[]
    }
    return slide as unknown as Slide
  })
  return { doc: doc as unknown as BentoDoc, stats }
}

/** The font stack expansion assumes for text — exported so the rig can state
 *  why a full document without `fontFamily` is NOT auto-expanded. */
export const EXPANDED_TEXT_FONT = FONT_STACK

/** The compact JSON of a document, for "Copy compact JSON" and window.bento.compact(). */
export const compactJson = (doc: BentoDoc): string => JSON.stringify(compactDoc(doc))
