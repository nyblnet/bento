// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The floating selection toolbar — the Notion/Confluence convention — over the
// Range mark engine in marks.ts.
//
// Before this, the only way to make text bold in a space was to know that ⌘B
// existed. Strikethrough, inline code, highlight and links had no gesture at
// all. A block editor's formatting has to be DISCOVERABLE from the selection,
// because selecting the words is what a person does before they decide how the
// words should look.
//
// THREE THINGS THIS FILE IS CAREFUL ABOUT.
//
// (1) THE BAR LIVES IN `document.body`, NEVER IN THE BLOCK. A block's host
//     element IS the model — `host.innerHTML` is written to `Block.html` on
//     every input event. A button appended inside the editable subtree would be
//     committed to the document as content and then eaten by the sanitizer on
//     the next canonicalisation, so the file would carry the toolbar's markup
//     for exactly as long as it took someone to notice. It is also marked
//     `data-bento-transient`, because the kernel's save clones the LIVE
//     document: an open toolbar at ⌘S time would otherwise be written into the
//     saved file's body.
//
// (2) IT REMEMBERS OFFSETS, NOT A RANGE. Once the bar is up it holds
//     `{blockId, start, end}` in the block's plain-text coordinates. Every
//     operation is computed from those numbers and the selection is rebuilt
//     from them afterwards, so no live Range ever has to survive the innerHTML
//     write that each operation performs. Stale-Range-after-DOM-surgery is not
//     handled here; it is made impossible.
//
// (3) A COARSE POINTER GETS A BOTTOM BAR, NOT A FLOATING ONE. On a touch screen
//     a toolbar positioned over the selection lands exactly where iOS and
//     Android put the selection handles and the OS callout (Copy / Look Up /
//     Share). Two overlapping menus in the same 40 pixels is worse than one, so
//     on `pointer: coarse` the same buttons dock to the bottom of the viewport
//     — well clear of both, and the same idiom this app already uses for its
//     menus on a phone (`.sp-sheet`). "Nothing at all" was the other defensible
//     answer and was rejected: it would leave a phone with no way to format
//     text whatsoever, since a phone has no ⌘B either.

import { t } from './i18n'
import { ICONS } from './icons'
import { Store } from './store'
import {
  type MarkTag, TOOLBAR_MARKS, applyMark, clearMarks, markActive, linkAt, linkAttrs,
  offsetsOf, rangeAt, PALETTE, colourAttrs,
} from './marks.ts'
import { externalHref } from './sanitize'

/** What the bar needs to know about the editor around it. */
export interface FormatBarHost {
  store: Store
  /** false in reading view, in a readonly file, and while a modal owns the app */
  editable(): boolean
  /** the page surface, so the bar only reacts to selections inside it */
  main(): HTMLElement
}

/** A selection the mark engine can act on. */
export interface MarkTarget { id: string; host: HTMLElement; start: number; end: number }

type ItemKey = MarkTag | 'link' | 'clear' | 'colour'
interface Item { tag: ItemKey; icon: string; label: string; hint: string }

/** Glyphs drawn here rather than in icons.ts: they are letterforms, not line
 *  art, and they have to read as the letter B and the letter I at 16px. */
const glyph = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

const GLYPHS: Record<string, string> = {
  strong: glyph('<path d="M7 4h6.5a4 4 0 0 1 0 8H7z"/><path d="M7 12h7.5a4 4 0 0 1 0 8H7z"/>'),
  em: glyph('<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>'),
  u: glyph('<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" y1="21" x2="20" y2="21"/>'),
  s: glyph('<path d="M16 5.5C15 4.5 13.6 4 12 4c-2.8 0-4.5 1.4-4.5 3.2 0 1.5 1 2.5 3 3.3"/><path d="M8.5 15c.6 2 2.3 3 4.5 3 2.9 0 4.5-1.4 4.5-3.3 0-.9-.3-1.6-.9-2.2"/><line x1="3" y1="12" x2="21" y2="12"/>'),
  mark: glyph('<path d="M4 20h16"/><path d="m9 15-3 1 1-3 8-8 2 2z"/><path d="m13 5 2 2"/>'),
  clear: glyph('<path d="M6 4h13"/><path d="M11 4 8.5 16"/><line x1="3" y1="21" x2="21" y2="21"/><line x1="14" y1="12" x2="20" y2="18"/><line x1="20" y1="12" x2="14" y2="18"/>'),
  // an A over a bar, the universal "this changes the colour of letters"
  colour: glyph('<path d="M5 19 11 5h2l6 14"/><path d="M7.5 14h9"/><path d="M4 22h16" stroke-width="3"/>'),
}

export class FormatBar {
  private bar: HTMLElement | null = null
  private target: MarkTarget | null = null
  private buttons = new Map<string, HTMLButtonElement>()
  private frame = 0
  /** suppressed while a mouse selection drag is still in progress */
  private dragging = false
  /**
   * The url field or the palette has the bar.
   *
   * NOT tidiness — without it the link field DESTROYS ITSELF. Focusing the
   * input moves the selection out of the block, `selectionchange` fires,
   * `refresh` finds nothing markable and closes the bar the input is inside,
   * one frame after it opened. Measured in the built shell: ⌘K produced
   * neither a url field nor the search it falls back to. While a panel is
   * open the bar answers to its own Apply/Back/Escape and to a click outside,
   * and to nothing else.
   */
  private locked = false

  constructor(private readonly app: FormatBarHost) {
    document.addEventListener('selectionchange', this.schedule)
    // A drag that is still down is not a finished selection. Showing the bar
    // mid-drag puts it under the pointer, so the gesture that was extending the
    // selection ends on a button instead.
    document.addEventListener('mousedown', this.onDown, true)
    document.addEventListener('mouseup', this.onUp, true)
    window.addEventListener('resize', this.schedule)
    window.addEventListener('scroll', this.schedule, true)
  }

  destroy(): void {
    document.removeEventListener('selectionchange', this.schedule)
    document.removeEventListener('mousedown', this.onDown, true)
    document.removeEventListener('mouseup', this.onUp, true)
    window.removeEventListener('resize', this.schedule)
    window.removeEventListener('scroll', this.schedule, true)
    this.close()
  }

  private onDown = (e: MouseEvent): void => {
    if (this.bar?.contains(e.target as Node)) return
    this.dragging = true
    this.close()
  }

  private onUp = (): void => { this.dragging = false; this.schedule() }

  /** One recompute per frame: selectionchange fires per character of a drag. */
  private schedule = (): void => {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.refresh())
  }

  // ---- what is selected ----------------------------------------------------

  /**
   * The current selection, if the mark engine can act on it.
   *
   * PUBLIC because the keyboard path asks the same question: ⌘B has to mean
   * "bold this selection" under exactly the conditions the toolbar appears
   * under, or the two disagree about what is formattable and only one of them
   * is visible.
   */
  markable(): MarkTarget | null {
    if (!this.app.editable()) return null
    const sel = getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    const host = (range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>('[data-edit]')
    if (!host || !this.app.main().contains(host)) return null
    const id = host.dataset.edit!
    // A code block's host holds TEXT, not inline html — its `innerHTML` is
    // syntax colouring that must never reach the model (see wireCode). Marks
    // inside source code are meaningless anyway.
    if (this.app.store.block(id)?.type === 'code') return null
    const at = offsetsOf(host, range)
    if (!at || at.end <= at.start) return null
    return { id, host, start: at.start, end: at.end }
  }

  // ---- the bar -------------------------------------------------------------

  private items(): Item[] {
    // Translated at CALL time, never in a module const — a catalog frozen at
    // import ships English forever once someone changes the language.
    const labels: Partial<Record<ItemKey, [string, string]>> = {
      strong: [t('Bold'), t('Bold — ⌘B')],
      em: [t('Italic'), t('Italic — ⌘I')],
      u: [t('Underline'), t('Underline — ⌘U')],
      s: [t('Strikethrough'), t('Strikethrough — ⇧⌘S')],
      code: [t('Code'), t('Inline code — ⌘E')],
      mark: [t('Highlight'), t('Highlight — ⇧⌘H')],
      colour: [t('Color'), t('Text and background color')],
      link: [t('Link'), t('Link — ⌘K')],
      clear: [t('Clear formatting'), t('Clear formatting')],
    }
    const keys: ItemKey[] = [...TOOLBAR_MARKS, 'colour', 'link', 'clear']
    return keys.map((key) => {
      const [label, hint] = labels[key] ?? ['', '']
      const icon = key === 'link' ? ICONS.link : GLYPHS[key] ?? ICONS.code
      return { tag: key, icon, label, hint }
    })
  }

  private sheet(): boolean {
    return matchMedia('(pointer: coarse)').matches
  }

  private build(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = this.sheet() ? 'sp-fmt sp-fmt-dock' : 'sp-fmt'
    // The kernel's save clones the live document; anything of ours in the body
    // has to say it is not part of it.
    bar.setAttribute('data-bento-transient', '')
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', t('Text formatting'))
    // mousedown INSIDE the bar must not move the caret out of the block
    bar.addEventListener('mousedown', (e) => e.preventDefault())
    this.buttons.clear()
    for (const item of this.items()) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sp-fmt-btn'
      b.innerHTML = item.icon
      b.title = item.hint
      b.setAttribute('aria-label', item.label)
      b.addEventListener('click', (e) => { e.preventDefault(); this.run(item.tag) })
      if (item.tag === 'link') b.classList.add('sp-fmt-gap')
      this.buttons.set(item.tag, b)
      bar.append(b)
    }
    return bar
  }

  private refresh(): void {
    if (this.dragging || this.locked) return
    const next = this.markable()
    if (!next) { this.close(); return }
    this.target = next
    if (!this.bar) { this.bar = this.build(); document.body.append(this.bar) }
    const html = this.app.store.block(next.id)?.html ?? ''
    for (const [key, btn] of this.buttons) {
      const on = key === 'link' ? !!linkAt(html, next.start, next.end)
        // "coloured" means either role is set — the ink OR the band behind it
        : key === 'colour' ? !!markActive(html, next.start, next.end, 'span')
        : key !== 'clear' && markActive(html, next.start, next.end, key as MarkTag)
      btn.classList.toggle('sp-fmt-on', on)
      btn.setAttribute('aria-pressed', String(on))
    }
    if (!this.sheet()) this.place()
  }

  /**
   * Above the selection, flipped below when the top of the window is in the
   * way, and never off either edge.
   *
   * `getBoundingClientRect()` of a multi-line selection is the union of its
   * lines, so anchoring to it would put the bar over the LAST line of a
   * three-line selection. The FIRST client rect is the line the selection
   * starts on, which is where a person is looking.
   */
  private place(): void {
    const bar = this.bar!
    const sel = getSelection()
    if (!sel || sel.rangeCount === 0) return
    const rects = sel.getRangeAt(0).getClientRects()
    const r = rects.length ? rects[0] : sel.getRangeAt(0).getBoundingClientRect()
    const w = bar.offsetWidth || 260
    const h = bar.offsetHeight || 36
    const GAP = 8
    let top = r.top - h - GAP
    if (top < GAP) top = Math.min(r.bottom + GAP, innerHeight - h - GAP)
    let left = r.left + r.width / 2 - w / 2
    left = Math.max(GAP, Math.min(left, innerWidth - w - GAP))
    bar.style.left = `${Math.round(left)}px`
    bar.style.top = `${Math.round(Math.max(GAP, top))}px`
  }

  close(): void {
    this.locked = false
    this.bar?.remove()
    this.bar = null
    this.target = null
    this.buttons.clear()
  }

  // ---- the operations ------------------------------------------------------

  private run(kind: ItemKey): void {
    const tgt = this.target ?? this.markable()
    if (!tgt) return
    this.target = tgt
    if (kind === 'link') { this.editLink(tgt); return }
    if (kind === 'colour') { this.editColour(tgt); return }
    const html = this.app.store.block(tgt.id)?.html ?? ''
    this.write(tgt, kind === 'clear'
      ? clearMarks(html, tgt.start, tgt.end)
      : applyMark(html, tgt.start, tgt.end, kind))
  }

  /** ⌘B and friends, and the toolbar's own buttons, land here. */
  toggle(tag: MarkTag): void {
    const tgt = this.markable()
    if (!tgt) return
    this.target = tgt
    const html = this.app.store.block(tgt.id)?.html ?? ''
    this.write(tgt, applyMark(html, tgt.start, tgt.end, tag))
  }

  /** ⌘K on a selection. */
  link(): boolean {
    const tgt = this.markable()
    if (!tgt) return false
    this.target = tgt
    if (!this.bar) { this.bar = this.build(); document.body.append(this.bar); this.refresh() }
    this.editLink(tgt)
    return true
  }

  /**
   * The url field, drawn INSIDE the bar rather than as a second popover.
   *
   * A popover would be a second floating thing to position, to dismiss and to
   * keep the selection alive under. The bar already holds the offsets, so the
   * field can simply replace the buttons for as long as it is open and the
   * selection can be rebuilt from numbers when it closes.
   */
  private editLink(tgt: MarkTarget): void {
    const bar = this.bar
    if (!bar) return
    const html = this.app.store.block(tgt.id)?.html ?? ''
    const current = linkAt(html, tgt.start, tgt.end)
    const kids = [...bar.childNodes]
    for (const k of kids) k.remove()
    bar.classList.add('sp-fmt-linking')
    this.locked = true

    const input = document.createElement('input')
    input.className = 'sp-fmt-url'
    input.type = 'url'
    input.value = current
    input.placeholder = t('Paste or type a link')
    input.setAttribute('aria-label', t('Link address'))
    const restore = (): void => {
      this.locked = false
      bar.classList.remove('sp-fmt-linking')
      for (const k of [...bar.childNodes]) k.remove()
      bar.append(...kids)
      this.select(tgt)
      this.refresh()
    }
    const apply = (): void => {
      const url = externalHref(input.value)
      if (!url && input.value.trim()) { input.classList.add('sp-fmt-bad'); return }
      this.write(tgt, url
        ? applyMark(html, tgt.start, tgt.end, 'a', { op: 'on', attrs: linkAttrs(url) })
        : applyMark(html, tgt.start, tgt.end, 'a', { op: 'off' }))
      restore()
    }
    input.addEventListener('input', () => input.classList.remove('sp-fmt-bad'))
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); apply() }
      if (e.key === 'Escape') { e.preventDefault(); restore() }
    })
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'sp-fmt-btn sp-fmt-go'
    go.textContent = t('Apply')
    go.addEventListener('mousedown', (e) => e.preventDefault())
    go.addEventListener('click', apply)
    bar.append(input, go)
    if (current) {
      const off = document.createElement('button')
      off.type = 'button'
      off.className = 'sp-fmt-btn'
      off.textContent = t('Remove')
      off.addEventListener('mousedown', (e) => e.preventDefault())
      off.addEventListener('click', () => { input.value = ''; apply() })
      bar.append(off)
    }
    if (!this.sheet()) this.place()
    input.focus()
    input.select()
  }

  /**
   * The colour palette, in the bar, in the same swap-in slot as the url field.
   *
   * TWO ROWS OF THE SAME NINE COLOURS plus a Default — the ink and the band
   * behind it. One palette in two roles rather than two palettes: "Red" is
   * named once and the ROLE is named once, which is nine UI strings and two
   * headings instead of eighteen, and it is also how a person thinks about it.
   *
   * A PALETTE AND NOT A COLOUR PICKER. An arbitrary hex would have to be stored
   * as a `style` attribute (making the sanitizer a CSS parser), it could not
   * adapt to the surface it is drawn on, and it would let an author pick a
   * colour their own document cannot read. See marks.ts PALETTE.
   */
  private editColour(tgt: MarkTarget): void {
    const bar = this.bar
    if (!bar) return
    const html = this.app.store.block(tgt.id)?.html ?? ''
    const kids = [...bar.childNodes]
    for (const k of kids) k.remove()
    bar.classList.add('sp-fmt-pal')
    this.locked = true
    const restore = (): void => {
      this.locked = false
      bar.classList.remove('sp-fmt-pal')
      for (const k of [...bar.childNodes]) k.remove()
      bar.append(...kids)
      this.select(tgt)
      this.refresh()
    }
    const names: Record<string, string> = {
      '': t('Default'), gray: t('Gray'), brown: t('Brown'), orange: t('Orange'),
      yellow: t('Yellow'), green: t('Green'), blue: t('Blue'), purple: t('Purple'),
      pink: t('Pink'), red: t('Red'),
    }
    const row = (role: 'fg' | 'bg', heading: string, tag: MarkTag): void => {
      const h = document.createElement('div')
      h.className = 'sp-fmt-pal-h'
      h.textContent = heading
      const strip = document.createElement('div')
      strip.className = 'sp-fmt-sw-row'
      for (const name of ['', ...PALETTE]) {
        const sw = document.createElement('button')
        sw.type = 'button'
        sw.className = `sp-fmt-sw sp-${role}-${name || 'default'}`
        sw.textContent = 'A'
        const label = `${heading} · ${names[name]}`
        sw.title = label
        sw.setAttribute('aria-label', label)
        sw.addEventListener('mousedown', (e) => e.preventDefault())
        sw.addEventListener('click', () => {
          // "Default" is REMOVAL, not a colour named default: a paragraph
          // nobody coloured and one coloured back to default must be the same
          // bytes, or every diff carries the ghost of an undone decision.
          this.write(tgt, applyMark(html, tgt.start, tgt.end, tag,
            name ? { op: 'on', attrs: colourAttrs(role, name) } : { op: 'off' }))
          restore()
        })
        strip.append(sw)
      }
      bar.append(h, strip)
    }
    row('fg', t('Text'), 'span')
    row('bg', t('Background'), 'mark')
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'sp-fmt-btn sp-fmt-back'
    back.textContent = t('Back')
    back.addEventListener('mousedown', (e) => e.preventDefault())
    back.addEventListener('click', restore)
    bar.append(back)
    if (!this.sheet()) this.place()
  }

  /**
   * Commit one mark change.
   *
   * A COMMIT, NOT A `runEdit` — this closes the typing run, deliberately.
   *
   * A typing run takes ONE checkpoint, at its first keystroke, and everything
   * after that mutates in place (store.ts). Fold a mark toggle into the open
   * run and the run's single checkpoint is the state BEFORE the sentence was
   * typed, so the ⌘Z that was meant to take back the bold takes back the
   * sentence as well. It is also not a keystroke by any other measure: it is a
   * discrete, deliberate, undoable act, it rewrites tags across a span rather
   * than inserting a character, and it is the one text edit that can safely be
   * canonicalised immediately, because the caret is restored from stored
   * offsets rather than left where the DOM put it. `scope: 'page'` because it
   * touches exactly one block of the page in view, and `structure: false`
   * because the page TREE has not changed and a sidebar repaint would be
   * wasted work on every button press.
   */
  private write(tgt: MarkTarget, next: string): void {
    const s = this.app.store
    const b = s.block(tgt.id)
    if (!b || next === b.html) return
    s.commit(() => { b.html = next }, { structure: false, scope: 'page' })
    tgt.host.innerHTML = next
    this.select(tgt)
    this.refresh()
  }

  /** Rebuild the selection from the stored offsets after an innerHTML write. */
  private select(tgt: MarkTarget): void {
    tgt.host.focus()
    const sel = getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(rangeAt(tgt.host, tgt.start, tgt.end))
  }
}
