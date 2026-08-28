// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The right-hand properties panel — "what can I change about this thing".
//
// WHY IT EXISTS. Block settings were scattered across three idioms: a hover
// chip on the block (language, tone), a floating tool row (image width, media
// playback), a per-block menu (link card) and the PAGE menu (page width). Each
// one is discoverable only if you already know it is there, and none of them
// answers the question in the general case. Slides answers it with a right
// panel; this is the same panel, the same accordion, the same persisted open
// state, so the two apps do not teach two different editors.
//
// THOSE OTHER SURFACES STAY. This is a second route, not a replacement: the
// chip on a callout is still the fastest way to change a tone, and taking it
// away to justify a panel would be a worse editor with a tidier diagram.
//
// WIDTH IS THE CONSTRAINT, not a detail. A notes app is the page; a panel that
// permanently costs 280px of it undoes the wide-page work that shipped one
// commit ago. So it DEFAULTS TO CLOSED, its state is the reader's
// (localStorage, never the file), and while it is closed it contributes
// nothing but a 5px strip — `flex-basis: 0`, no padding, no border. Below the
// drawer breakpoint it is an overlay, exactly as the page list is, because a
// third column on a phone is not a column.

import type { Store } from './store'
import type { Block, Page } from './model'
import { tableOf, TABLE_MAX_COLS, TABLE_MAX_ROWS } from './model'
import { CALLOUT_TONES, SPEC } from './blocks'
import { toneLabel } from './render'
import { CODE_LANGS, normLang } from './highlight'
import { t } from './i18n'

/**
 * What the panel needs from the editor.
 *
 * A narrow interface rather than the Editor itself: the panel is allowed to
 * ask for a repaint and to hand a job back to a picker the editor already
 * owns, and nothing else. Every one of these already existed — the panel adds
 * no second implementation of anything it offers.
 */
export interface PropsHost {
  store: Store
  /** the block the panel is describing — the last one the caret was in */
  target(): string | null
  /** the editor is showing the reading view, or the document is locked */
  locked(): boolean
  repaint(): void
  pickPoster(id: string): void
  /** a page's cover picture — the editor owns the file picker and the budget */
  pickCover(pageId: string): void
  removeCover(pageId: string): void
  pickMedia(id: string): void
  openIconPicker(pageId: string, anchor: HTMLElement): void
  /** the editor owns popovers; the panel only says which page wants one */
  openAddProperty(pageId: string, anchor: HTMLElement): void
  /** the editor owns the icon set and the emoji fallback */
  pageIcon(icon: string | undefined): string
  openLinkCard(id: string): void
  addTableRow(id: string, at?: number): void
  removeTableRow(id: string, at: number): void
  addTableCol(id: string, at?: number): void
  removeTableCol(id: string, at: number): void
}

const OPEN_KEY = 'bento-sp-insp-open'

const mk = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

export class PropsPanel {
  private stale = false

  constructor(private host: HTMLElement, private app: PropsHost) {
    const s = app.store
    s.on('page', () => this.rebuild(true))
    s.on('selection', () => this.rebuild(true))
    s.on('doc', () => this.rebuild())
    // Slides' rule: a rebuild must not rip the field out from under the person
    // typing in it, so a doc event lands when focus leaves instead.
    this.host.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.stale && !this.host.matches(':focus-within')) this.rebuild()
      }, 0)
    })
    this.rebuild(true)
  }

  /** Rebuild now — for the changes no store event announces (the reading view
   *  flipping, which changes what is editable but not what is in the file). */
  refresh(): void { this.rebuild(true) }

  /** The caret moved to another block — same panel, different subject. */
  retarget(): void {
    if (this.host.dataset.on !== (this.app.target() ?? '')) this.rebuild(true)
  }

  /** Typing in a text field is an edit in progress; a select is not. */
  private editing(): boolean {
    const a = document.activeElement as HTMLElement | null
    if (!a || !this.host.contains(a)) return false
    if (a.tagName === 'TEXTAREA' || a.isContentEditable) return true
    if (a.tagName === 'INPUT') return (a as HTMLInputElement).type !== 'checkbox'
    return false
  }

  private rebuild(force = false): void {
    if (!force && this.editing()) { this.stale = true; return }
    this.stale = false
    this.host.innerHTML = ''
    const s = this.app.store
    const page = s.page
    const id = this.app.target()
    const block = id ? s.block(id) : undefined
    this.host.dataset.on = id ?? ''

    this.host.append(mk('h2', 'sp-insp-title', t('Properties')))
    if (block) this.buildBlock(block)
    else this.host.append(mk('p', 'sp-insp-hint', t('Put the caret in a block to see what it can be.')))
    if (page) this.buildPage(page)
    this.accordion()
  }

  // ---- accordion ------------------------------------------------------------

  /**
   * The same retrofit slides does: each `.sp-insp-sec` header gathers the
   * siblings after it into a body it can collapse, and the open state is
   * remembered PER TITLE so it survives a rebuild, a reload and a different
   * block being selected.
   */
  private accordion(): void {
    let open: Record<string, boolean> = {}
    try { open = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') || {} } catch { open = {} }
    for (const h of [...this.host.querySelectorAll<HTMLElement>('.sp-insp-sec')]) {
      const key = h.dataset.key ?? h.textContent ?? ''
      const body = mk('div', 'sp-insp-body')
      let n: ChildNode | null = h.nextSibling
      while (n && !(n instanceof HTMLElement && n.classList.contains('sp-insp-sec'))) {
        const next: ChildNode | null = n.nextSibling
        body.appendChild(n)
        n = next
      }
      h.after(body)
      const shut = open[key] === false
      if (shut) { h.classList.add('sp-shut'); body.style.display = 'none' }
      h.setAttribute('aria-expanded', String(!shut))
      h.addEventListener('click', () => {
        const nowShut = h.classList.toggle('sp-shut')
        body.style.display = nowShut ? 'none' : ''
        h.setAttribute('aria-expanded', String(!nowShut))
        open[key] = !nowShut
        try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)) } catch { /* locked-down origin */ }
      })
    }
  }

  // ---- block ----------------------------------------------------------------

  private buildBlock(b: Block): void {
    const label = SPEC.get(b.type)?.label
    // An unknown type spells ITSELF out rather than claiming to be a paragraph
    // — a block from a newer build is a thing you can see, not a lie.
    this.section(t('Block'), label ? t(label) : b.type)
    switch (b.type) {
      case 'table': this.tableRows(b); break
      case 'code': this.codeRows(b); break
      case 'callout': this.calloutRows(b); break
      case 'image': this.imageRows(b); break
      case 'media': this.mediaRows(b); break
      case 'link': this.linkRows(b); break
      default:
        this.host.append(mk('p', 'sp-insp-hint',
          t('This block has no settings of its own — its content is all of it.')))
    }
  }

  private tableRows(b: Block): void {
    const shape = tableOf(b)
    this.row(t('Rows'), this.stepper(shape.h, 1, TABLE_MAX_ROWS,
      () => this.app.addTableRow(b.id),
      () => this.app.removeTableRow(b.id, shape.h - 1)))
    this.row(t('Columns'), this.stepper(shape.w, 1, TABLE_MAX_COLS,
      () => this.app.addTableCol(b.id),
      () => this.app.removeTableCol(b.id, shape.w - 1)))
    // ABSENT MEANS TRUE for `header` (model.ts), so the toggle reads the
    // absence rather than the value.
    this.row(t('Header row'), this.toggle(b.header !== false, (v) => {
      this.commit(b.id, (bb) => { if (v) delete bb.header; else bb.header = false })
    }))
  }

  private codeRows(b: Block): void {
    const raw = String(b.lang ?? '').trim()
    const known = normLang(raw)
    const opts: Array<[string, string]> = CODE_LANGS.map(
      (l) => [l.id, l.label || t('Plain text')] as [string, string])
    // A tag this build cannot highlight is kept and OFFERED, so choosing
    // something else is a decision rather than a silent deletion.
    if (raw && !known) opts.unshift([raw, raw])
    this.row(t('Language'), this.select(opts, known || raw, (v) => {
      this.commit(b.id, (bb) => { if (v) bb.lang = v; else delete bb.lang })
    }))
  }

  private calloutRows(b: Block): void {
    this.row(t('Tone'), this.select(
      CALLOUT_TONES.map((x) => [x.tone, toneLabel(x.tone)] as [string, string]),
      String(b.tone ?? 'note'),
      (v) => this.commit(b.id, (bb) => { bb.tone = v })))
    this.row(t('Icon'), this.text(String(b.icon ?? ''), t('Leave it empty to use the tone mark'),
      (v) => this.commit(b.id, (bb) => { if (v) bb.icon = v; else delete bb.icon })))
  }

  private imageRows(b: Block): void {
    this.widthRow(b)
    this.row(t('Alt text'), this.text(String(b.alt ?? ''), t('What is in the picture'),
      (v) => this.commit(b.id, (bb) => { if (v) bb.alt = v; else delete bb.alt })))
  }

  private mediaRows(b: Block): void {
    const audio = String(b.kind ?? 'video') === 'audio'
    // WIDTH IS A VIDEO QUESTION (blocks.ts): an <audio> is a control bar of the
    // browser's own height, and a percentage of the measure only makes it a
    // shorter control bar.
    if (!audio) {
      this.widthRow(b)
      const poster = mk('button', 'sp-btn' + (b.poster ? ' sp-on' : ''), t('Poster…'))
      poster.type = 'button'
      poster.title = t('A still frame, shown before play — and what a printout or a file preview shows')
      poster.addEventListener('click', () => this.app.pickPoster(b.id))
      this.row(t('Poster'), poster)
      this.row(t('Muted'), this.toggle(b.muted === true,
        (v) => this.commit(b.id, (bb) => { if (v) bb.muted = true; else delete bb.muted })))
    }
    this.row(t('Loop'), this.toggle(b.loop === true,
      (v) => this.commit(b.id, (bb) => { if (v) bb.loop = true; else delete bb.loop })))
    // absent means shown, so the OFF state is the one that is written down
    this.row(t('Controls'), this.toggle(b.controls !== false,
      (v) => this.commit(b.id, (bb) => { if (v) delete bb.controls; else bb.controls = false })))
    const replace = mk('button', 'sp-btn', t('Replace…'))
    replace.type = 'button'
    replace.addEventListener('click', () => this.app.pickMedia(b.id))
    this.row(t('File'), replace)
  }

  private linkRows(b: Block): void {
    // NOTHING IS FETCHED — a card is what the author typed (DECISIONS,
    // 2026-08-03). The panel says so once rather than per field.
    const f = (key: 'url' | 'title' | 'desc' | 'site' | 'icon', label: string, hint: string) =>
      this.row(label, this.text(String(b[key] ?? ''), hint, (v) => {
        this.commit(b.id, (bb) => {
          // an EMPTY field is an ABSENT field, exactly as applyLinkCard has it
          if (v) (bb as Record<string, unknown>)[key] = v
          else delete (bb as Record<string, unknown>)[key]
        })
      }))
    f('url', t('Web address'), 'https://example.com')
    f('title', t('Title'), t('What this is'))
    f('desc', t('Description'), t('One line about what is there'))
    f('site', t('Site name'), t('Taken from the address if blank'))
    f('icon', t('Icon'), t('One emoji'))
    const more = mk('button', 'sp-btn', t('Picture…'))
    more.type = 'button'
    more.title = t('Nothing is fetched. A card shows what you type here — opening this space never contacts the site.')
    more.addEventListener('click', () => this.app.openLinkCard(b.id))
    this.row(t('Picture'), more)
  }

  /** Percentage of the text column — no block carries absolute px. */
  private widthRow(b: Block): void {
    const n = document.createElement('input')
    n.type = 'number'
    n.className = 'sp-insp-num'
    n.min = '10'
    n.max = '100'
    n.step = '5'
    n.value = String(Number(b.width ?? 100))
    n.addEventListener('change', () => {
      const v = Math.round(Math.min(100, Math.max(10, Number(n.value) || 100)))
      this.commit(b.id, (bb) => { if (v === 100) delete bb.width; else bb.width = v })
    })
    this.row(t('Width %'), n)
  }

  // ---- page -----------------------------------------------------------------

  private buildPage(page: Page): void {
    const s = this.app.store
    this.section(t('Page'), page.title || t('Untitled'))

    const icon = mk('button', 'sp-btn sp-insp-icon', '')
    icon.type = 'button'
    icon.innerHTML = this.app.pageIcon(page.icon)
    icon.title = t("Change this page's icon")
    icon.addEventListener('click', () => this.app.openIconPicker(page.id, icon))
    this.row(t('Icon'), icon)

    // THE COVER, beside the icon, because they are the same question asked of
    // two sizes: what does this page look like before you have read it.
    //
    // Two LITERAL calls rather than t(has ? a : b): the extractor sweeps
    // literals, so an interpolated key compiles, runs, and is never translated
    // in any of the eight catalogs.
    const has = !!String((page as { cover?: unknown }).cover ?? '')
    const covers = mk('div', 'sp-insp-btns')
    const pick = mk('button', 'sp-btn' + (has ? ' sp-on' : ''), has ? t('Replace…') : t('Choose…'))
    pick.type = 'button'
    pick.title = t('A picture across the top of this page')
    pick.addEventListener('click', () => this.app.pickCover(page.id))
    covers.appendChild(pick)
    if (has) {
      const drop = mk('button', 'sp-btn', t('Remove'))
      drop.type = 'button'
      drop.addEventListener('click', () => { this.app.removeCover(page.id); this.rebuild(true) })
      covers.appendChild(drop)
    }
    this.row(t('Cover'), covers)

    // HOW WIDE THIS PAGE IS — the page menu's own control, in the place the
    // question is now asked. The default is an ABSENT key, never a stored
    // 'normal': a page set to wide and back is byte-identical to one never
    // touched.
    const cur = page.width === 'wide' ? 'wide' : page.width === 'full' ? 'full' : 'normal'
    this.row(t('Width'), this.select([
      ['normal', t('Column')], ['wide', t('Wide')], ['full', t('Full width')],
    ], cur, (v) => {
      if (s.readOnly) return
      s.commit(() => {
        const p = s.index.page.get(page.id)
        if (!p) return
        if (v === 'normal') delete p.width
        else p.width = v as 'wide' | 'full'
      }, { scope: 'doc' })
      this.app.repaint()
    }))

    this.row(t('Archived'), this.toggle(page.archived === true, (v) => {
      if (s.readOnly) return
      s.commit(() => {
        const p = s.index.page.get(page.id)
        if (!p) return
        if (v) p.archived = true
        else delete p.archived
      })
      this.app.repaint()
    }))

    if (typeof page.journal === 'string') {
      this.row(t('Journal date'), mk('span', 'sp-mono', page.journal))
    }

    // A PAGE IS A RECORD when it wants to be. The properties themselves live in
    // the page's header strip, where they are read and edited; this is the way
    // to give the page one it does not have yet — the only route before was
    // "Make this page an issue", which is four fields or nothing.
    if (!this.app.locked()) {
      const addProp = mk('button', 'sp-btn', t('Add property…'))
      addProp.type = 'button'
      addProp.addEventListener('click', () => this.app.openAddProperty(page.id, addProp))
      this.row(t('Properties'), addProp)
    }

    // WHAT IS ACTUALLY IN THIS PAGE. Derived at render, never stored: a count
    // written into the file is a count that goes stale in somebody's copy.
    const words = page.blocks.reduce(
      (n, b) => n + (String(b.html ?? '').replace(/<[^>]*>/g, ' ').match(/\S+/g)?.length ?? 0), 0)
    const back = s.index.backlinks.get(page.id)?.length ?? 0
    // ONE STRING WITH THREE HARDCODED PLURALS read "1 blocks · 1 words · 1
    // links in" on every new page — the first thing anyone sees in this panel.
    // The rest of the app dodges this with the "(s)" convention (52 uses), but
    // that is for one-off dialogs; this line is permanent chrome, and "1
    // block(s)" is a shrug in the corner of the screen. So each count picks its
    // own form. English, German, Spanish, French, Italian and Portuguese all
    // split at one; the CJK catalogs have one form and use it for both.
    // "links in" also said nothing useful — they are links TO this page.
    //
    // Written out rather than routed through a pick-a-key helper: the extractor
    // sweeps t() call sites for LITERALS, so `t(v === 1 ? one : many)` compiles
    // and runs and is never translated by anybody. Every form below has to be
    // visible at its own call site to reach the catalogs.
    const blocks = page.blocks.length
    const stats = [
      blocks === 1 ? t('{n} block', { n: blocks }) : t('{n} blocks', { n: blocks }),
      words === 1 ? t('{n} word', { n: words }) : t('{n} words', { n: words }),
      back === 1 ? t('{n} link to this page', { n: back }) : t('{n} links to this page', { n: back }),
    ].join(' · ')
    // its own class: a statistic that looks exactly like the instruction above
    // it is a statistic nobody reads as data
    this.host.append(mk('p', 'sp-insp-stat', stats))
  }

  // ---- rows -----------------------------------------------------------------

  private section(title: string, sub?: string): void {
    const h = mk('h3', 'sp-insp-sec', title)
    h.dataset.key = title
    h.setAttribute('role', 'button')
    h.tabIndex = 0
    if (sub) h.append(mk('span', 'sp-insp-sub', sub))
    this.host.append(h)
  }

  private row(label: string, control: HTMLElement): void {
    const r = mk('label', 'sp-insp-row')
    r.append(mk('span', 'sp-insp-lbl', label), control)
    if (this.app.locked()) for (const c of r.querySelectorAll('input,select,button')) {
      (c as HTMLInputElement).disabled = true
    }
    this.host.append(r)
  }

  /** ONE commit per change — so every control here is exactly one ⌘Z. */
  private commit(id: string, fn: (b: Block) => void): void {
    const s = this.app.store
    if (s.readOnly) return
    s.commit(() => { const b = s.block(id); if (b) fn(b) })
    this.app.repaint()
  }

  private select(opts: Array<[string, string]>, value: string, on: (v: string) => void): HTMLElement {
    const sel = document.createElement('select')
    sel.className = 'sp-select'
    for (const [v, label] of opts) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = label
      if (v === value) o.selected = true
      sel.append(o)
    }
    sel.addEventListener('change', () => on(sel.value))
    return sel
  }

  private toggle(value: boolean, on: (v: boolean) => void): HTMLElement {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'sp-insp-tog'
    cb.checked = value
    cb.addEventListener('change', () => on(cb.checked))
    return cb
  }

  /** `change`, not `input`: one commit when the field is done with, rather
   *  than one undo entry per keystroke. */
  private text(value: string, hint: string, on: (v: string) => void): HTMLElement {
    const i = document.createElement('input')
    i.className = 'sp-insp-txt'
    i.value = value
    i.placeholder = hint
    i.addEventListener('change', () => on(i.value.trim()))
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); i.blur() } })
    return i
  }

  private stepper(n: number, min: number, max: number, add: () => void, drop: () => void): HTMLElement {
    const wrap = mk('span', 'sp-insp-step')
    const b = (glyph: string, title: string, off: boolean, run: () => void) => {
      const x = mk('button', 'sp-btn', glyph)
      x.type = 'button'
      x.title = title
      x.disabled = off
      x.addEventListener('click', (e) => { e.preventDefault(); run() })
      return x
    }
    wrap.append(
      b('−', t('One fewer'), n <= min, drop),
      mk('span', 'sp-insp-n', String(n)),
      b('+', t('One more'), n >= max, add),
    )
    return wrap
  }
}
