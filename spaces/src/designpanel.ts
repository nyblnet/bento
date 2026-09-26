// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Choosing and customising a page design — the controls, not the look.
//
// TWO SURFACES. The picker is a section of the About dialog, beside the
// document's other properties: a design is the AUTHOR's choice and belongs
// with the title, not with the reader's theme and language further down.
// Hovering a choice previews it on the page behind the dialog; clicking one
// is ONE undo step. "Customise…" forks the current design into a doc-local
// one and opens a NON-modal panel, so the page stays visible while its tokens
// change under the pointer.
//
// NOTHING HERE WRITES CSS. The panel edits `doc.designs[name]` — colours,
// font names, switch words and numbers — and designs.ts validates every value
// before it reaches a style. A colour input can only produce #rrggbb; a
// select can only produce one of its options; a range input is clamped by the
// browser and re-checked by validProp().

import { t } from './i18n'
import type { Store } from './store'
import type { SpacesDoc } from './model'
import { internAsset, blobToDataUri, humanBytes } from './assets'
import {
  BUILT_INS, BUILT_IN_NAMES, PLAIN, PALETTE_KEYS, FONT_ROLES, FONT_STACKS, PROPS, PROP_KEYS,
  resolveDesign, resolveData, localDesigns, localLabel, freshDesignName, setDesign, isBuiltIn,
  fontAssetUri, parseColour, resolvePageDesign, setPageDesign,
  type DesignData, type DesignPreview, type PaletteKey, type FontRole, type PropKey, type Design,
} from './designs.ts'

/** A design's name as the picker shows it. Literals, so the i18n sweep sees them. */
export function designLabel(doc: SpacesDoc, name: string | null): string {
  switch (name) {
    case null: return t('Default')
    case 'ledger': return t('Ledger')
    case 'almanac': return t('Almanac')
    case 'studio': return t('Studio')
    case 'broadsheet': return t('Broadsheet')
    case 'typescript': return t('Typescript')
    case 'riso': return t('Riso')
    default: return localLabel(doc, name)
  }
}

function designHint(name: string | null): string {
  switch (name) {
    case null: return t('The look every space starts with.')
    case 'ledger': return t('A precise grid, figures in a monospace, cobalt rules.')
    case 'almanac': return t('An editorial serif, a drop cap, and marigold for its accent.')
    case 'studio': return t('The Bento tile: navy, slate, coral and cream compartments.')
    case 'broadsheet': return t('A news serif under double rules, justified, with pull quotes.')
    case 'typescript': return t('A typewritten manuscript: one face, capitals, a two-colour ribbon.')
    case 'riso': return t('A risograph zine: two spot inks, heavy capitals, offset shadows.')
    default: return t('Carried by this space.')
  }
}

const COLOUR_LABEL = (k: PaletteKey): string => {
  switch (k) {
    case 'paper': return t('Paper')
    case 'ink': return t('Text')
    case 'muted': return t('Secondary text')
    case 'rule': return t('Rules')
    case 'soft': return t('Wells')
    case 'accent': return t('Accent')
    case 'accentInk': return t('Accent text')
    case 'onAccent': return t('Text on accent')
    case 'tile': return t('Tile')
    case 'tileInk': return t('Text on tile')
    case 'cell1': return t('Cell 1')
    case 'cell2': return t('Cell 2')
    case 'cell3': return t('Cell 3')
    case 'toneNote': return t('Note')
    case 'toneTip': return t('Tip')
    case 'toneImportant': return t('Important')
    case 'toneWarning': return t('Warning')
    case 'toneCaution': return t('Caution')
  }
}

const ROLE_LABEL = (r: FontRole): string =>
  r === 'display' ? t('Headings') : r === 'body' ? t('Body') : r === 'label' ? t('Labels') : t('Code and figures')

const STACK_LABEL = (k: string): string => {
  switch (k) {
    case 'system': return t('System')
    case 'grotesk': return t('Grotesque')
    case 'humanist': return t('Humanist')
    case 'condensed': return t('Condensed')
    case 'transitional': return t('Book serif')
    case 'oldstyle': return t('Old-style serif')
    case 'news': return t('News serif')
    case 'mono': return t('Monospace')
    case 'typewriter': return t('Typewriter')
    case 'rounded': return t('Rounded')
    default: return k
  }
}

const PROP_LABEL = (k: PropKey): string => {
  switch (k) {
    case 'size': return t('Text size')
    case 'leading': return t('Line spacing')
    case 'titleSize': return t('Title size')
    case 'titleWeight': return t('Title weight')
    case 'titleTracking': return t('Title letter spacing')
    case 'titleLeading': return t('Title line spacing')
    case 'headWeight': return t('Heading weight')
    case 'radius': return t('Corner radius')
    case 'rule': return t('Rule weight')
    case 'headStyle': return t('Heading style')
    case 'headCase': return t('Heading case')
    case 'label': return t('Labels')
    case 'labelInk': return t('Label colour')
    case 'h2': return t('Section heads')
    case 'dropCap': return t('Drop cap')
    case 'callout': return t('Callouts')
    case 'quote': return t('Quotes')
    case 'table': return t('Tables')
    case 'numerals': return t('Figures')
    case 'check': return t('Checkboxes')
    case 'tile': return t('Tiles')
    case 'shadow': return t('Shadows')
    case 'justify': return t('Justified text')
    case 'divider': return t('Dividers')
    case 'bullet': return t('Bullets')
  }
}

/** Display words for switch values; the stored value is always the model word. */
const VALUE_LABEL = (k: PropKey, v: string): string => {
  switch (`${k}:${v}`) {
    case 'headStyle:normal': return t('Upright')
    case 'headStyle:italic': case 'label:italic': return t('Italic')
    case 'headCase:none': return t('As written')
    case 'headCase:upper': case 'label:caps': return t('Capitals')
    case 'label:plain': case 'quote:plain': return t('Plain')
    case 'label:smallcaps': return t('Small capitals')
    case 'labelInk:ink': return t('Text colour')
    case 'labelInk:accent': return t('Accent')
    case 'h2:none': case 'shadow:none': return t('None')
    case 'h2:above': return t('Rule above')
    case 'h2:double': return t('Double rule above')
    case 'h2:bar': return t('Short bar below')
    case 'h2:under': return t('Underlined')
    case 'dropCap:off': case 'tile:off': case 'justify:off': return t('Off')
    case 'dropCap:on': case 'tile:on': case 'justify:on': return t('On')
    case 'callout:tint': return t('Tinted')
    case 'callout:outline': return t('Outlined')
    case 'callout:rules': return t('Rules above and below')
    case 'callout:fill': return t('Filled')
    case 'callout:shadow': return t('Offset shadow')
    case 'quote:bar': return t('Accent bar')
    case 'quote:display': return t('Display italic')
    case 'quote:pull': return t('Pull quote')
    case 'quote:tile': return t('Tile')
    case 'quote:indent': return t('Indented')
    case 'table:grid': return t('Grid')
    case 'table:rules': return t('Rules')
    case 'table:bands': return t('Bands')
    case 'numerals:lining': return t('Lining')
    case 'numerals:mono': return t('Monospace')
    case 'numerals:oldstyle': return t('Old-style')
    case 'check:native': return t('System')
    case 'check:square': case 'bullet:square': return t('Square')
    case 'check:round': return t('Round')
    case 'shadow:hard': return t('Hard offset')
    case 'divider:rule': return t('Hairline')
    case 'divider:ink': return t('Heavy rule')
    case 'divider:double': return t('Double rule')
    case 'divider:asterism': return t('Asterism')
    case 'divider:short': return t('Short bar')
    case 'bullet:disc': return t('Disc')
    case 'bullet:dash': return t('Dash')
    default: return v
  }
}

/** Three dots of a design's own palette: paper, ink, accent. */
function swatch(d: Design): HTMLElement {
  const s = document.createElement('i')
  s.className = 'sp-dsg-sw'
  s.setAttribute('aria-hidden', 'true')
  for (const k of ['paper', 'ink', 'accent'] as const) {
    const dot = document.createElement('b')
    // values straight out of the registry or through parseColour — never text
    dot.style.background = d.light[k]
    s.append(dot)
  }
  return s
}

export interface DesignHooks {
  store: Store
  /** paint a design on the page without writing it; undefined ends the preview */
  preview: (pv: DesignPreview | undefined) => void
  /** the About dialog closes itself before the panel opens over the page */
  openPanel: () => void
}

/**
 * The picker, as an About section's children.
 *
 * Buttons rather than a <select>: an option in a native dropdown cannot be
 * hovered for a preview on any platform, and the preview is the point.
 */
export function designSection(h: DesignHooks): HTMLElement[] {
  const { store } = h
  const doc = store.doc
  const current = resolveDesign(doc)
  const grid = document.createElement('div')
  grid.className = 'sp-dsg-grid'
  grid.setAttribute('role', 'radiogroup')
  grid.setAttribute('aria-label', t('Design'))

  const names: Array<string | null> = [null, ...BUILT_IN_NAMES,
    ...Object.keys(localDesigns(doc)).filter((n) => !isBuiltIn(n) && resolveDesign(doc, n))]
  const buttons: HTMLButtonElement[] = []
  for (const name of names) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sp-choice sp-dsg-choice'
    b.setAttribute('role', 'radio')
    const on = (current?.name ?? null) === name
    b.setAttribute('aria-checked', String(on))
    if (on) b.classList.add('sp-sel')
    b.disabled = store.readOnly
    const r = name === null ? null : resolveDesign(doc, name)
    const strong = document.createElement('strong')
    strong.append(swatch(r?.design ?? PLAIN), document.createTextNode(designLabel(doc, name)))
    const span = document.createElement('span')
    span.textContent = designHint(name)
    b.append(strong, span)
    // PREVIEW ON HOVER AND ON FOCUS — a keyboard reader gets it too. What is
    // previewed is the NAME tried at the space, so a page with a design of its
    // own keeps it, exactly as it would if this were chosen.
    const show = () => h.preview({ name })
    const hide = () => h.preview(undefined)
    b.addEventListener('mouseenter', show)
    b.addEventListener('focus', show)
    b.addEventListener('mouseleave', hide)
    b.addEventListener('blur', hide)
    b.addEventListener('click', () => {
      // read LIVE, not the value from when the dialog opened: an undo while it
      // is open changes the answer
      if ((resolveDesign(store.doc)?.name ?? null) === name) { h.preview(undefined); return }
      // ONE undo step, and the default DELETES the key (designs.ts setDesign)
      store.commit(() => setDesign(store.doc, name), { structure: false })
      h.preview(undefined)
      mark()
    })
    b.dataset.design = name ?? ''
    buttons.push(b)
    grid.append(b)
  }
  // leaving the whole grid ends any preview, whichever child the pointer left from
  grid.addEventListener('mouseleave', () => h.preview(undefined))
  // the checked choice follows the DOCUMENT, so an undo while the dialog is
  // open moves it back
  const mark = () => {
    const now = resolveDesign(store.doc)?.name ?? ''
    for (const o of buttons) {
      const sel = o.dataset.design === now
      o.classList.toggle('sp-sel', sel)
      o.setAttribute('aria-checked', String(sel))
    }
  }
  const off = store.on('doc', () => { if (grid.isConnected) mark(); else off() })

  const custom = document.createElement('button')
  custom.type = 'button'
  custom.className = 'sp-btn'
  custom.textContent = t('Customise…')
  custom.disabled = store.readOnly
  custom.addEventListener('click', () => {
    h.preview(undefined)
    forkIfNeeded(store)
    h.openPanel()
  })
  const acts = document.createElement('div')
  acts.className = 'sp-actions'
  acts.append(custom)

  const note = document.createElement('p')
  note.className = 'sp-note'
  note.textContent = t('The design travels with the file. Each reader’s light or dark setting picks between its two palettes.')
  // this is the SPACE's design; a page or a section can override it
  const per = document.createElement('p')
  per.className = 'sp-note'
  per.textContent = t('A page can wear a design of its own, and a section’s passes to the pages inside it: choose it from the page’s ⋯ menu.')
  return [grid, acts, note, per]
}

export interface PageDesignHooks {
  store: Store
  pageId: string
  /** paint a design without writing it; undefined ends the preview */
  preview: (pv: DesignPreview | undefined) => void
  /** close the menu the choices sit in */
  done: () => void
  /** open the customise panel on THIS page's own design */
  openPanel: (pageId: string) => void
}

/**
 * One page's design choices, as a menu's rows: the page ⋯ menu and the
 * properties panel both open these (editor.openPageDesign).
 *
 * THE FIRST ROW IS INHERIT, and it says what inheriting resolves to — "Same as
 * parent · Ledger" — because an absent key is otherwise invisible and the
 * question a reader is really asking is "what will this page look like".
 * Choosing it DELETES the key (setPageDesign). Every other row names a design;
 * each previews on hover and focus, and a click is ONE undo step.
 *
 * There is no "Default" row for a page: the format's value is a NAME, and the
 * default look has none. A page shows the default when nothing above it names
 * a design — or when it names one this build does not know.
 */
export function pageDesignRows(h: PageDesignHooks): HTMLElement[] {
  const { store, pageId } = h
  const doc = store.doc
  const page = store.index.page.get(pageId)
  if (!page) return []
  const own = page.design
  const topLevel = !page.parent || !store.index.page.has(page.parent)
  const inherited = resolvePageDesign(doc, pageId, undefined, true)
  const locals = Object.keys(localDesigns(doc)).filter((n) => !isBuiltIn(n) && resolveDesign(doc, n))
  const names: Array<string | null> = [null, ...BUILT_IN_NAMES, ...locals]
  // a name this build does not know is still the page's choice: show it, so
  // the reader can see why the page looks plain, and can move off it
  if (typeof own === 'string' && own && !names.includes(own)) names.push(own)
  const rows: HTMLElement[] = []
  const buttons: HTMLButtonElement[] = []
  let showing: HTMLElement | null = null
  for (const name of names) {
    const r = name === null ? inherited : resolveDesign(doc, name)
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sp-dditem sp-dsg-item'
    b.setAttribute('role', 'menuitemradio')
    const on = name === null ? own === undefined : own === name
    b.setAttribute('aria-checked', String(on))
    if (on) b.classList.add('sp-sel')
    b.disabled = store.readOnly
    b.dataset.design = name ?? ''
    const ico = document.createElement('span')
    ico.className = 'sp-result-ico'
    ico.append(swatch(r?.design ?? PLAIN))
    const txt = document.createElement('span')
    txt.className = 'sp-result-txt'
    const strong = document.createElement('strong')
    const hint = document.createElement('span')
    if (name === null) {
      // Two LITERAL calls, so the extractor sees both keys
      strong.textContent = topLevel ? t('Same as space') : t('Same as parent')
      hint.textContent = designLabel(doc, inherited?.name ?? null)
    } else if (!r) {
      strong.textContent = name
      hint.textContent = t('Not a design this build knows — shown in the default look')
    } else {
      strong.textContent = designLabel(doc, name)
      hint.textContent = designHint(r.custom ? 'custom' : name)
    }
    txt.append(strong, hint)
    b.append(ico, txt)
    // PREVIEW ON A REAL MOVE, not on mouseenter: the menu opens where the page
    // menu was, so a row lands under a pointer that has not moved, and the
    // browser reports that as an enter — measured, the page flipped to Riso
    // the instant the menu opened. A move is a person pointing at a row.
    const show = () => { if (showing !== b) { showing = b; h.preview({ page: pageId, name }) } }
    b.addEventListener('mousemove', show)
    b.addEventListener('focus', show)
    b.addEventListener('mouseleave', () => { showing = null; h.preview(undefined) })
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const p = store.index.page.get(pageId)
      h.preview(undefined)
      if (!p || store.readOnly) { h.done(); return }
      // read LIVE: an undo while the menu is open changes the answer
      if ((p.design ?? null) !== name) {
        // ONE undo step; inherit DELETES the key
        store.commit(() => {
          const q = store.index.page.get(pageId)
          if (q) setPageDesign(q, name)
        }, { structure: false })
      }
      h.done()
    })
    buttons.push(b)
    rows.push(b)
  }
  const custom = document.createElement('button')
  custom.type = 'button'
  custom.className = 'sp-dditem sp-dsg-item'
  custom.setAttribute('role', 'menuitem')
  custom.disabled = store.readOnly
  const ctxt = document.createElement('span')
  ctxt.className = 'sp-result-txt'
  const cs = document.createElement('strong')
  cs.textContent = t('Customise…')
  const ch = document.createElement('span')
  ch.textContent = t('A design of this page’s own, kept in this space')
  ctxt.append(cs, ch)
  const cico = document.createElement('span')
  cico.className = 'sp-result-ico'
  custom.append(cico, ctxt)
  custom.addEventListener('mousemove', () => { if (showing) { showing = null; h.preview(undefined) } })
  custom.addEventListener('click', (e) => {
    e.stopPropagation()
    h.preview(undefined)
    h.done()
    if (store.readOnly) return
    forkIfNeeded(store, pageId)
    h.openPanel(pageId)
  })
  rows.push(custom)
  return rows
}

/**
 * Make the design at one scope — the space, or ONE page — a design this
 * document owns, as ONE undo step, and return its name.
 *
 * A doc-local design that scope names ITSELF is edited in place. Anything
 * else is FORKED into `doc.designs` and assigned to that scope: a built-in or
 * the default becomes a new entry naming it as its base with no overrides
 * yet, and a doc-local design the page only INHERITS is copied — customising
 * one page must never restyle the section or space it inherits from.
 */
function forkIfNeeded(store: Store, pageId?: string): string {
  const doc = store.doc
  const page = pageId !== undefined ? store.index.page.get(pageId) : undefined
  const ownName = page ? page.design : (doc as { design?: unknown }).design
  const own = typeof ownName === 'string' ? resolveDesign(doc, ownName) : null
  if (own?.custom) return own.name
  const cur = page ? resolvePageDesign(doc, page.id) : resolveDesign(doc)
  const name = freshDesignName(doc)
  let data: DesignData
  if (cur?.custom) {
    data = { ...clone(localDesigns(doc)[cur.name] as DesignData), label: t('{name}, customised', { name: designLabel(doc, cur.name) }) }
  } else {
    const base = cur && isBuiltIn(cur.name) ? cur.name : undefined
    data = {
      label: base ? t('{name}, customised', { name: designLabel(doc, base) }) : t('Custom'),
      ...(base ? { base } : {}),
    }
  }
  store.commit(() => {
    const d = store.doc as { designs?: Record<string, unknown> }
    d.designs = { ...(d.designs && typeof d.designs === 'object' ? d.designs : {}), [name]: data }
    const p = pageId !== undefined ? store.index.page.get(pageId) : undefined
    if (p) setPageDesign(p, name)
    else setDesign(store.doc, name)
  }, { structure: false })
  return name
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T

/** The panel element, while it is open. One at a time. */
let openPanelEl: HTMLElement | null = null

/**
 * The customise panel: non-modal, over the inspector's side of the window,
 * so the page it is changing stays in view.
 */
export function openDesignPanel(store: Store, preview: (pv: DesignPreview | undefined) => void, pageId?: string): void {
  openPanelEl?.remove()
  const panel = document.createElement('aside')
  panel.className = 'sp-dsg-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', t('Customise design'))
  document.body.append(panel)
  openPanelEl = panel

  // THE DESIGN THIS SCOPE NAMES ITSELF — the space's, or one page's — when it
  // is one this document carries. Read live: an undo can take it away.
  const name = (): string | null => {
    const raw = pageId !== undefined ? store.index.page.get(pageId)?.design : (store.doc as { design?: unknown }).design
    const r = typeof raw === 'string' ? resolveDesign(store.doc, raw) : null
    return r?.custom ? r.name : null
  }
  let draft: DesignData = {}
  const stored = () => {
    const n = name()
    return n ? clone(localDesigns(store.doc)[n] as DesignData) : null
  }

  const close = () => {
    preview(undefined)
    off()
    panel.remove()
    document.removeEventListener('keydown', onKey, true)
    if (openPanelEl === panel) openPanelEl = null
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && panel.contains(document.activeElement)) { e.stopPropagation(); close() }
  }
  document.addEventListener('keydown', onKey, true)

  /** Live: paint the draft without writing it. */
  const live = () => {
    const n = name()
    // the DRAFT stands in wherever this name resolves — this page, and every
    // page that shares the design
    if (n) preview({ draft: { name: n, design: resolveData(store.doc, n, draft), custom: true } })
  }
  /** Commit the draft as ONE undo step, keeping only what differs from the base. */
  const commit = () => {
    const n = name()
    if (!n) return
    const base = isBuiltIn(draft.base) ? BUILT_INS[draft.base] : PLAIN
    const out = clone(draft)
    for (const mode of ['light', 'dark'] as const) {
      const pal = out[mode]
      if (!pal) continue
      for (const k of Object.keys(pal) as PaletteKey[]) if (pal[k] === base[mode][k]) delete pal[k]
      if (!Object.keys(pal).length) delete out[mode]
    }
    if (out.fonts) {
      for (const k of Object.keys(out.fonts) as FontRole[]) if (out.fonts[k] === base.fonts[k]) delete out.fonts[k]
      if (!Object.keys(out.fonts).length) delete out.fonts
    }
    if (out.props) {
      for (const k of Object.keys(out.props) as PropKey[]) if (out.props[k] === base.props[k]) delete out.props[k]
      if (!Object.keys(out.props).length) delete out.props
    }
    if (JSON.stringify(out) === JSON.stringify(stored())) { preview(undefined); return }
    store.commit(() => {
      const d = store.doc as { designs?: Record<string, unknown> }
      d.designs = { ...(d.designs ?? {}), [n]: out }
    }, { structure: false })
    preview(undefined)
  }

  const build = () => {
    const n = name()
    panel.replaceChildren()
    const head = document.createElement('div')
    head.className = 'sp-dsg-head'
    const title = document.createElement('h2')
    title.className = 'sp-card-h'
    title.textContent = t('Customise design')
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'sp-btn'
    x.textContent = t('Done')
    x.addEventListener('click', close)
    head.append(title, x)
    panel.append(head)
    if (!n) {
      const p = document.createElement('p')
      p.className = 'sp-note'
      p.textContent = pageId !== undefined ? t('This page no longer uses a design of its own.') : t('This space no longer uses a design of its own.')
      panel.append(p)
      return
    }
    draft = stored() ?? {}
    const doc = store.doc
    const resolved = resolveData(doc, n, draft)
    const base = isBuiltIn(draft.base) ? draft.base : null

    // ---- name
    const nameIn = document.createElement('input')
    nameIn.type = 'text'
    nameIn.className = 'sp-input'
    nameIn.maxLength = 60
    nameIn.value = localLabel(doc, n)
    nameIn.addEventListener('change', () => {
      const v = nameIn.value.trim()
      if (v) draft.label = v
      else delete draft.label
      commit()
    })
    panel.append(field(t('Name'), nameIn))
    const basis = document.createElement('p')
    basis.className = 'sp-note'
    basis.textContent = t('Based on {name}. Only what you change here is stored.', { name: designLabel(doc, base) })
    panel.append(basis)

    // ---- colours: light and dark side by side
    panel.append(heading(t('Colours')))
    const table = document.createElement('div')
    table.className = 'sp-dsg-cols'
    table.append(span(''), span(t('Light')), span(t('Dark')))
    for (const k of PALETTE_KEYS) {
      table.append(span(COLOUR_LABEL(k)))
      for (const mode of ['light', 'dark'] as const) {
        const c = document.createElement('input')
        c.type = 'color'
        c.value = resolved[mode][k]
        c.setAttribute('aria-label', `${COLOUR_LABEL(k)} · ${mode === 'light' ? t('Light') : t('Dark')}`)
        c.addEventListener('input', () => {
          const v = parseColour(c.value)
          if (!v) return
          ;(draft[mode] ??= {})[k] = v
          live()
        })
        c.addEventListener('change', commit)
        table.append(c)
      }
    }
    panel.append(table)

    // ---- fonts
    panel.append(heading(t('Type')))
    for (const role of FONT_ROLES) {
      const sel = document.createElement('select')
      sel.className = 'sp-select'
      for (const k of Object.keys(FONT_STACKS)) sel.append(option(k, STACK_LABEL(k)))
      // faces this file already carries
      for (const f of doc.fonts ?? []) {
        const ref = `asset:${f.asset}`
        if (fontAssetUri(doc, ref)) sel.append(option(ref, f.family || f.asset))
      }
      sel.append(option('+', t('Add a font file…')))
      sel.value = resolved.fonts[role]
      sel.addEventListener('change', () => {
        if (sel.value === '+') {
          sel.value = resolved.fonts[role]
          void addFont(store, (ref) => { (draft.fonts ??= {})[role] = ref; commit() })
          return
        }
        ;(draft.fonts ??= {})[role] = sel.value
        commit()
      })
      panel.append(field(ROLE_LABEL(role), sel))
    }

    // ---- switches and metrics
    panel.append(heading(t('Layout')))
    for (const k of PROP_KEYS) {
      const rule = PROPS[k] as { kind: 'num'; min: number; max: number } | { kind: 'enum'; values: readonly string[] }
      const v = resolved.props[k]
      if (rule.kind === 'enum') {
        const sel = document.createElement('select')
        sel.className = 'sp-select'
        for (const w of rule.values) sel.append(option(w, VALUE_LABEL(k, w)))
        sel.value = String(v)
        sel.addEventListener('change', () => { (draft.props ??= {} as Partial<typeof resolved.props>)[k] = sel.value as never; commit() })
        panel.append(field(PROP_LABEL(k), sel))
      } else {
        const r = document.createElement('input')
        r.type = 'range'
        r.min = String(rule.min)
        r.max = String(rule.max)
        const step = rule.max - rule.min >= 100 ? 50 : rule.max - rule.min >= 10 ? 1 : rule.max - rule.min >= 1 ? 0.05 : 0.005
        r.step = String(step)
        r.value = String(v)
        const out = document.createElement('output')
        out.textContent = String(v)
        r.addEventListener('input', () => {
          const nv = Number(r.value)
          out.textContent = String(nv)
          ;(draft.props ??= {})[k] = nv as never
          live()
        })
        r.addEventListener('change', commit)
        const wrap = document.createElement('span')
        wrap.className = 'sp-dsg-range'
        wrap.append(r, out)
        panel.append(field(PROP_LABEL(k), wrap))
      }
    }

    // ---- remove
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'sp-btn'
    del.textContent = t('Remove this design')
    del.addEventListener('click', () => {
      store.commit(() => {
        const d = store.doc as { designs?: Record<string, unknown> }
        if (d.designs) {
          delete d.designs[n]
          if (!Object.keys(d.designs).length) delete d.designs
        }
        // EVERY reference goes back to what it was forked from — the space's
        // and each page's — or, with no base, loses the key: the space to the
        // default look, a page to inheriting. A reference left pointing at a
        // deleted entry would render the default and read as a fault.
        if ((store.doc as { design?: unknown }).design === n) setDesign(store.doc, base)
        for (const p of store.doc.pages) if (p.design === n) setPageDesign(p, base)
      }, { structure: false })
      close()
    })
    const acts = document.createElement('div')
    acts.className = 'sp-actions'
    acts.append(del)
    panel.append(acts)
  }

  // An undo, a redo or a collaborator can change the entry underneath the
  // panel — and a commit here can change a DERIVED value (a new accent picks
  // its own text-on-accent). Rebuild from the document every time, keeping
  // the scroll, unless someone is mid-way through typing or dragging.
  const off = store.on('doc', () => {
    if (!panel.isConnected) return
    const focus = document.activeElement
    if (focus instanceof HTMLInputElement && panel.contains(focus) && (focus.type === 'text' || focus.type === 'range')) return
    const top = panel.scrollTop
    build()
    panel.scrollTop = top
  })
  build()
  panel.querySelector<HTMLElement>('input,select,button')?.focus()
}

const span = (text: string): HTMLElement => {
  const s = document.createElement('span')
  s.textContent = text
  return s
}
const heading = (text: string): HTMLElement => {
  const h = document.createElement('h3')
  h.className = 'sp-dsg-sub'
  h.textContent = text
  return h
}
const option = (value: string, label: string): HTMLOptionElement => {
  const o = document.createElement('option')
  o.value = value
  o.textContent = label
  return o
}
function field(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('label')
  row.className = 'sp-dsg-row'
  const s = document.createElement('span')
  s.textContent = label
  row.append(s, control)
  return row
}

/** Above this a face is asked about before it is embedded. */
const FONT_BUDGET = 1024 * 1024
const FONT_MIME: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' }

/**
 * Embed a font file as an asset — the only way a custom face reaches a design,
 * because nothing is ever fetched (PLATFORM §1). The bytes are interned like
 * an image (content-addressed, deduplicated) and listed in `doc.fonts`, which
 * is what names the face in the picker and keeps the asset from reading as an
 * orphan.
 */
async function addFont(store: Store, use: (ref: string) => void): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf'
  const file = await new Promise<File | null>((res) => {
    input.addEventListener('change', () => res(input.files?.[0] ?? null))
    input.click()
  })
  if (!file) return
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? '').toLowerCase()
  if (!Object.hasOwn(FONT_MIME, ext)) { alert(t('That is not a font file (.woff2, .woff, .ttf or .otf).')); return }
  if (file.size > FONT_BUDGET && !confirm(t('This font is {size}, and it travels inside the file. Embed it anyway?', { size: humanBytes(file.size) }))) return
  const raw = await blobToDataUri(file)
  // the MIME is decided HERE, from the extension, never taken from the picker:
  // fontAssetUri only honours data:font/… and a browser may report none
  const uri = `data:${FONT_MIME[ext]};base64,${raw.slice(raw.indexOf(',') + 1)}`
  const ref = await internAsset(store.doc, uri)
  const key = ref.slice(6)
  const family = file.name.replace(/\.[^.]+$/, '').slice(0, 60) || key
  const d = store.doc
  if (!(d.fonts ?? []).some((f) => f.asset === key)) {
    store.commit(() => { (d.fonts ??= []).push({ family, asset: key }) }, { structure: false })
  }
  use(ref)
}
