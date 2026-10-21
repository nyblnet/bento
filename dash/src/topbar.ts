// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The top bar's fit, its phone fold, and the 🌐 language menu.
//
// SIZED BY MEASURING, NOT BY BREAKPOINTS — slides' fitTopbar/applyPhoneChrome
// (slides/src/editor/editor.ts), ported. Dash used to step its bar down at
// fixed widths (1600, 1380, 1040, 860, 760, 700, 380), each one measured once
// against the bar as it was that day, and every control added since quietly
// invalidated the numbers: measured at 390px the bar was 509px wide and the
// DOCUMENT scrolled sideways, with About and Help unreachable. Browser zoom,
// OS text size and a longer translation change how much room the same buttons
// need at the same width, so a width cannot answer the question. The bar can.
//
// The tiers, as classes on `.dx-bar`, stepped down while the bar still
// overflows its own box:
//
//   dx-bar-compact  button labels give way (icons and tooltips take over)
//   dx-bar-tight    the wordmark goes; the glyph stays as the About button
//   dx-bar-fold     the insert tools move under ＋, the occasional controls
//                   under ⋯ (REPARENTED, never copied — a copy would need its
//                   own listeners and would desync from live state such as the
//                   unsaved dot and a disabled tool's reason)
//
// BELOW THE FOLD'S FLOOR THE BAR SCROLLS, NOT THE PAGE. Fully folded the bar
// still needs its touch targets, the mark and the title; a 320px phone has
// less. So on a phone the bar itself is `overflow-x: auto` and the menus that
// hang off ＋ and ⋯ are `position: fixed` (a scroll container clips BOTH axes —
// CLAUDE.md hard-won 10), anchored under the bar through --dx-bar-bottom.

// `translateKey` is t() under another name for the two DYNAMIC lookups below
// (a key read off the screen, not a literal), so the catalog sweep in
// scripts/test-dash-i18n.ts does not mistake them for a missing string.
import { t, t as translateKey, locale, setLocale, localeChoices } from './i18n.ts'
import { PACKED } from './i18n/packed.ts'
import { ICONS } from './icons.ts'

export interface TopbarHost {
  app: HTMLElement
  /** fill the Save-as list into ⋯ (marked, so it can be torn down again) */
  fillSaveAs: (into: HTMLElement, close: () => void) => void
  /** About and Settings — reachable from ⋯ on a phone */
  openAbout: () => void
  openSettings: () => void
  /** re-render whatever builds its strings on demand after a language switch */
  afterLocale: () => void
}

export interface Topbar {
  fit(): void
  /** is the bar folded right now (phone chrome)? */
  folded(): boolean
}

const PHONE_W = 700
const TIERS = ['dx-bar-compact', 'dx-bar-tight', 'dx-bar-fold'] as const

/** Every open dropdown except `keep` and anything containing it. */
export function shutMenus(root: ParentNode, keep?: Element | null): void {
  for (const dd of root.querySelectorAll('.dx-dd.open')) {
    if (keep && (dd === keep || dd.contains(keep))) continue
    dd.classList.remove('open')
  }
}

export function installTopbar(host: TopbarHost): Topbar {
  const { app } = host
  const bar = app.querySelector<HTMLElement>('.dx-bar')!
  const insert = bar.querySelector<HTMLElement>('.dx-insert')!
  const insertDd = bar.querySelector<HTMLElement>('.dx-insert-dd')!
  const insertMenu = insertDd.querySelector<HTMLElement>('.dx-menu')!
  const end = bar.querySelector<HTMLElement>('.dx-bar-end')!
  const moreDd = bar.querySelector<HTMLElement>('.dx-more-dd')!
  const moreMenu = moreDd.querySelector<HTMLElement>('.dx-more-menu')!

  // --- 🌐 language, rebuilt LIVE ----------------------------------------------
  const langDd = languageDropdown(host)
  // The end group in the house order: … Data · Share · Format · Save · 🌐 · ?
  const q = (sel: string) => end.querySelector<HTMLElement>(sel)
  const order = [q('.dx-data-dd'), q('.dx-share-dd'), q('.dx-format-btn'), q('.dxs-wrap') ?? q('.dx-btn-save'), langDd, q('.dx-help-btn')]
  for (const n of order) if (n) end.appendChild(n)

  // ⋯'s own two rows: About and Settings, which have no bar button of their
  // own on a phone (the mark is the About button, but a 20px glyph is not a
  // door anybody finds on glass).
  const fixed = document.createElement('div')
  fixed.className = 'dx-more-fixed'
  const row = (icon: string, label: string, run: () => void): HTMLElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'dx-btn'
    b.innerHTML = icon
    const s = document.createElement('span')
    s.textContent = label
    b.append(s)
    b.addEventListener('click', () => { shutMenus(app); run() })
    return b
  }
  fixed.append(row(ICONS.info, t('About this workbook'), host.openAbout), row(ICONS.gear, t('Settings'), host.openSettings))

  // demoted into ⋯ on the fold, in this order
  const demote = [
    bar.querySelector<HTMLElement>('[data-act="redo"]'),
    bar.querySelector<HTMLElement>('[data-act="comment"]'),
    q('.dx-data-dd'), q('.dx-share-dd'), langDd, q('.dx-help-btn'),
  ].filter((x): x is HTMLElement => !!x)

  // The authored desktop layout, captured once the bar is assembled. Unfolding
  // REPLAYS it rather than guessing where each button belonged (slides found
  // that guessing moved Comment between groups and put Save after Help).
  const authored = new Map<HTMLElement, HTMLElement[]>()
  const homeOf = new Map<HTMLElement, HTMLElement>()
  for (const g of [bar.querySelector<HTMLElement>('.dx-history')!, insert, end]) {
    authored.set(g, [...g.children] as HTMLElement[])
    for (const k of g.children) homeOf.set(k as HTMLElement, g)
  }

  let phoneOn: boolean | null = null
  const applyPhone = (on: boolean): void => {
    if (phoneOn === on) return
    const fresh = phoneOn === null
    phoneOn = on
    if (on) {
      while (insert.firstChild) insertMenu.appendChild(insert.firstChild)
      for (const b of demote) {
        // an icon-only control gets its tooltip as a caption inside the menu,
        // minus the shortcut: "Redo (⇧⌘Z)" -> "Redo"
        const face = b.classList.contains('dx-dd') ? b.firstElementChild as HTMLElement | null : b
        if (face && !face.querySelector('span') && face.title) {
          const lab = document.createElement('span')
          lab.dataset.phoneLabel = '1'
          lab.textContent = face.title.split('(')[0].split('—')[0].trim()
          face.appendChild(lab)
        }
        moreMenu.appendChild(b)
      }
      moreMenu.appendChild(fixed)
    } else if (!fresh) {
      while (insertMenu.firstChild) insert.appendChild(insertMenu.firstChild)
      for (const lab of moreMenu.querySelectorAll('[data-phone-label]')) lab.remove()
      for (const r of moreMenu.querySelectorAll('[data-phone-saveas]')) r.remove()
      fixed.remove()
      for (const b of demote) homeOf.get(b)?.appendChild(b)
      for (const [group, kids] of authored) for (const k of kids) if (k.parentElement === group) group.appendChild(k)
      moreDd.classList.remove('open')
      insertDd.classList.remove('open')
    }
  }

  let mo: MutationObserver | null = null
  const fit = (): void => {
    if (!bar.isConnected) return
    if (window.innerWidth <= PHONE_W) {
      bar.classList.add(...TIERS)
      applyPhone(true)
      mo?.takeRecords()
      return
    }
    // Re-fitting starts by unfolding, which reparents buttons and would slam a
    // menu shut under the reader. Skip while one is open.
    if (bar.querySelector('.dx-dd.open')) return
    // scrollWidth counts content sticking out of the padding box even with
    // overflow visible, so this IS the clipped-buttons condition. 1px slack
    // absorbs subpixel rounding at fractional zoom.
    const overflow = () => bar.scrollWidth - bar.clientWidth > 1
    // The title is the only shrinkable item, so flexbox crushes it before
    // anything overflows: step down while it is squeezed badly, too.
    const title = bar.querySelector<HTMLElement>('.dx-title')
    const cramped = () => overflow() || (!!title && title.getBoundingClientRect().width < 120)
    bar.classList.remove(...TIERS)
    applyPhone(false)
    if (cramped()) bar.classList.add('dx-bar-compact')
    if (cramped()) bar.classList.add('dx-bar-tight')
    if (overflow()) {
      bar.classList.add('dx-bar-fold')
      applyPhone(true)
    }
    // the class flips and reparenting queued records of their own; drop them,
    // or the observer re-runs this forever
    mo?.takeRecords()
  }

  // ⋯ carries the Save-as list too on a fold (the split caret does not fit
  // beside a phone's Save). Filled BEFORE it opens: the list is live state.
  moreDd.querySelector('.dx-more-trig')!.addEventListener('click', () => {
    for (const r of moreMenu.querySelectorAll('[data-phone-saveas]')) r.remove()
    if (!phoneOn || moreDd.classList.contains('open')) return
    const sep = document.createElement('div')
    sep.className = 'dx-menu-sep'
    sep.dataset.phoneSaveas = '1'
    moreMenu.insertBefore(sep, fixed.isConnected ? fixed : null)
    const box = document.createElement('div')
    host.fillSaveAs(box, () => shutMenus(app))
    for (const n of [...box.children] as HTMLElement[]) {
      n.dataset.phoneSaveas = '1'
      moreMenu.insertBefore(n, fixed.isConnected ? fixed : null)
    }
  }, true)

  // A command picked from ＋ or ⋯ shuts the menu — a dropdown TRIGGER parked
  // there (Data, Share, 🌐) opens its own section instead.
  for (const m of [insertMenu, moreMenu]) {
    m.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('.dx-btn')
      if (!b || !m.contains(b)) return
      if (b.classList.contains('dx-dd-trig') || b.classList.contains('dx-share')) return
      if (b.closest('.dx-share-pop')) return
      queueMicrotask(() => shutMenus(app))
    })
  }

  fit()
  const ro = new ResizeObserver(() => fit())
  ro.observe(bar)
  window.addEventListener('resize', fit)
  mo = new MutationObserver(() => fit())
  mo.observe(bar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'hidden'] })

  // Where the bar ends, for the fixed-position phone menus.
  const publish = () => app.style.setProperty('--dx-bar-bottom', `${Math.round(bar.getBoundingClientRect().bottom)}px`)
  new ResizeObserver(publish).observe(bar)
  window.addEventListener('resize', publish)
  publish()

  return { fit, folded: () => !!phoneOn }
}

// --- the 🌐 menu --------------------------------------------------------------

function languageDropdown(host: TopbarHost): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'dx-dd dx-lang-dd'
  const trig = document.createElement('button')
  trig.type = 'button'
  trig.className = 'dx-btn dx-dd-trig dx-lang-trig'
  trig.title = t('Language')
  trig.setAttribute('aria-label', t('Language'))
  trig.innerHTML = ICONS.globe
  const menu = document.createElement('div')
  menu.className = 'dx-menu dx-lang-menu'
  const fill = () => {
    menu.textContent = ''
    for (const c of localeChoices()) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'dx-btn'
      b.dataset.lang = c.code
      const s = document.createElement('span')
      s.textContent = c.label
      b.append(s)
      if (c.code === locale()) b.classList.add('dx-lang-on')
      b.addEventListener('click', () => {
        wrap.classList.remove('open')
        switchLocale(c.code, host)
        fill()
      })
      menu.append(b)
    }
  }
  fill()
  wrap.append(trig, menu)
  trig.addEventListener('click', (e) => {
    e.stopPropagation()
    const opening = !wrap.classList.contains('open')
    shutMenus(host.app, wrap)
    wrap.classList.toggle('open', opening)
  })
  return wrap
}

/**
 * Switch the interface language NOW, without a reload.
 *
 * Slides rebuilds its whole editor from code. Dash cannot: main.ts builds the
 * app once, from one template, with several hundred listeners hanging off it,
 * and re-running boot would mint a second store and a second sync session.
 * Reloading is worse — a file:// page reloads from DISK and the unsaved edits
 * go with it.
 *
 * So the chrome is translated IN PLACE. Every UI string is English-as-key, so
 * the text on screen under the OLD locale can be mapped back to its key and
 * re-translated under the new one: text nodes, and the title, placeholder and
 * aria-label attributes. A string with a {placeholder} was interpolated and
 * cannot be matched, so whatever renders those (panels, the tabs, the share
 * button) is asked to re-render through `afterLocale`. An ambiguous match —
 * two keys rendering the same text in the old language and differently in the
 * new — is left alone rather than guessed.
 */
export function switchLocale(code: string, host: Pick<TopbarHost, 'afterLocale'>): void {
  const from = locale()
  if (code === from) return
  // the reverse map is built under the OLD locale, before the switch
  const rev = new Map<string, string[]>()
  for (const key of Object.keys(PACKED)) {
    if (key.includes('{')) continue
    const shown = translateKey(key)
    const list = rev.get(shown)
    if (list) list.push(key)
    else rev.set(shown, [key])
  }
  setLocale(code)
  const translate = (s: string): string | null => {
    const v = s.trim()
    if (!v) return null
    const keys = rev.get(v)
    if (!keys) return null
    const outs = new Set(keys.map((k) => translateKey(k)))
    if (outs.size !== 1) return null
    const out = [...outs][0]
    return out === v ? null : s.replace(v, out)
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text)
  for (const n of texts) {
    const p = n.parentElement
    // never the document: a cell's text or a sheet name that happens to equal
    // a UI string is the author's, not ours
    if (!p || p.closest('.dg-sizer, .dg-head-row, .dx-grid .dg-cell, input, textarea, [contenteditable="true"]')) continue
    const out = translate(n.data)
    if (out !== null) n.data = out
  }
  for (const el of document.body.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label], [data-tip]')) {
    if (el.closest('.dg-sizer')) continue
    // data-tip: a gated tool's own tooltip, parked while a reason replaces it
    for (const a of ['title', 'placeholder', 'aria-label', 'data-tip']) {
      const v = el.getAttribute(a)
      if (v === null) continue
      const out = translate(v)
      if (out !== null) el.setAttribute(a, out)
    }
  }
  host.afterLocale()
}
