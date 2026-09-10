// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// WRITING ERGONOMICS — the outline rail, focus mode, typewriter mode, and the
// word count.
//
// All four are the READER'S, never the document's. They live in localStorage
// beside the language, the pane widths and the reader's column width, for the
// reason PLATFORM §8 gives about locale: two people opening one space bring
// their own habits to it, and a writing preference written into the file would
// travel to everyone who ever opens it. Nothing here touches the format —
// `bento/spaces` is byte-identical before and after every toggle on this page.
//
// It is one file because it is one idea (the shape of the act of writing) and
// because nine branches are editing `editor.ts` in parallel: the hooks it needs
// there are an import, a field, six lines in `build()`, one line in
// `paintPage()`, four menu rows and two keys. Everything else — the listeners,
// the geometry, the persistence — is here.

import type { Block, Page } from './model.ts'
// EXPLICIT `.ts` on every one of these. node's strip-only TypeScript loader
// will not follow an extensionless import, and `agent.ts` — which a node rig
// loads directly — now imports this file. Without the extension the whole
// agent surface stops being testable outside a bundle.
import { textOf } from './sanitize.ts'
import { t } from './i18n.ts'

// ---------------------------------------------------------------------------
// headings and counting — ONE parser, and one counter
// ---------------------------------------------------------------------------

export interface Heading {
  id: string
  level: 1 | 2 | 3
  text: string
}

/** Is this block a heading, and which level? `0` for anything else. */
export function headingLevel(b: Block): 0 | 1 | 2 | 3 {
  return b.type === 'h1' ? 1 : b.type === 'h2' ? 2 : b.type === 'h3' ? 3 : 0
}

/**
 * The headings of one page, in document order.
 *
 * `agent.ts outlineDoc` used to carry its own copy of this three-line test and
 * `about.ts` its own word counter. Two copies of one fact is how a model with
 * four heading levels ends up with an outline that shows three, silently, on
 * whichever side nobody edited — this repo has paid for that shape twice
 * recently. So the agent verb and the panel a person looks at now derive their
 * headings from the same function, and if the model ever grows an `h4` there is
 * exactly one place that has to learn about it.
 */
export function headingsOf(page: Pick<Page, 'blocks'>): Heading[] {
  const out: Heading[] = []
  for (const b of page.blocks) {
    const level = headingLevel(b)
    if (!level) continue
    out.push({ id: b.id, level, text: textOf(b.html).trim() })
  }
  return out
}

/**
 * Words in a run of plain text.
 *
 * Whitespace-split is right for the languages that put spaces between words and
 * useless for the ones that do not, so CJK runs are counted per CHARACTER — the
 * convention every Japanese and Chinese word processor uses, and the one the
 * reading-time estimate below assumes. Without it a 400-character Japanese page
 * counts as one word and reads as "0 min", which is worse than showing nothing.
 */
export function countWords(text: string): number {
  const s = text.trim()
  if (!s) return 0
  const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/g
  const cjk = s.match(CJK)?.length ?? 0
  const rest = s.replace(CJK, ' ')
  const latin = rest.trim() ? rest.trim().split(/\s+/).length : 0
  return latin + cjk
}

export interface PageStats {
  words: number
  chars: number
  /** Minutes at 220 wpm, never rounded below 1 for a page with any words at all. */
  minutes: number
}

export function pageStats(page: Pick<Page, 'blocks' | 'title'> | undefined): PageStats {
  if (!page) return { words: 0, chars: 0, minutes: 0 }
  let words = 0
  let chars = 0
  for (const b of page.blocks) {
    const text = textOf(b.html)
    words += countWords(text)
    chars += text.trim().length
  }
  return { words, chars, minutes: words ? Math.max(1, Math.round(words / 220)) : 0 }
}

// ---------------------------------------------------------------------------
// preferences
// ---------------------------------------------------------------------------

export type Pref = 'outline' | 'focus' | 'typewriter' | 'count'

const KEY: Record<Pref, string> = {
  outline: 'bento-sp-outline',
  focus: 'bento-sp-focus',
  typewriter: 'bento-sp-typewriter',
  count: 'bento-sp-wordcount',
}

/** Outline and the count are on out of the box; the two MODES are not. A mode
 *  that arrives switched on is a mode you have to discover in order to turn
 *  off, which is the opposite of the thing it was for. */
const DEFAULT: Record<Pref, boolean> = {
  outline: true, focus: false, typewriter: false, count: true,
}

function readPref(p: Pref): boolean {
  try {
    const v = localStorage.getItem(KEY[p])
    return v === null ? DEFAULT[p] : v === '1'
  } catch { return DEFAULT[p] } // locked-down origin
}

function writePref(p: Pref, on: boolean): void {
  try { localStorage.setItem(KEY[p], on ? '1' : '0') } catch { /* locked-down origin */ }
}

// ---------------------------------------------------------------------------
// small dom helpers (editor.ts's `el` is private to it, and importing across
// for six lines would couple two files that have no other reason to meet)
// ---------------------------------------------------------------------------

function tag<K extends keyof HTMLElementTagNameMap>(
  name: K, cls: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(name)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/**
 * The caret's rectangle in viewport coordinates.
 *
 * A COLLAPSED range does not always have a box: `getBoundingClientRect` on one
 * that sits between two nodes, or at the very start of an empty editable line,
 * comes back all zeros in every engine. So this asks three ways and takes the
 * first that has height — the range itself, its client rects, and finally the
 * block the caret is in, which is always a real box.
 *
 * Returning the BLOCK's box as the last resort is what makes typewriter mode
 * work on an empty new paragraph, which is precisely the moment somebody who
 * turned it on is looking at it.
 */
export function caretRect(): DOMRect | null {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  let box = r.getBoundingClientRect()
  if (!box.height) {
    const rects = r.getClientRects()
    if (rects.length) box = rects[0]
  }
  if (!box.height) {
    const n = r.startContainer
    const host = (n instanceof HTMLElement ? n : n.parentElement)
      ?.closest<HTMLElement>('[data-block-id]')
    if (!host) return null
    box = host.getBoundingClientRect()
  }
  return box.height || box.width ? box : null
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WritingHost {
  /** `.sp-app` — where the mode classes go. */
  root: HTMLElement
  /** `.sp-main`, the scroller. Re-read on every use: `paintPage` replaces its
   *  children, and a stale reference to the element itself would survive that
   *  but a stale reference to anything INSIDE it would not. */
  main: () => HTMLElement
  /** The page whose headings and words are being shown, or undefined. */
  page: () => Pick<Page, 'blocks' | 'title'> | undefined
  /** Jump to a block: the editor knows how to scroll and focus one. */
  goToBlock: (id: string) => void
  /** A one-line report in the topbar. */
  say: (msg: string) => void
}

export class Writing {
  private host: WritingHost
  readonly rail: HTMLElement
  readonly chip: HTMLElement
  private ticks: HTMLElement
  private list: HTMLElement
  private empty: HTMLElement
  private heads: Heading[] = []
  private now = ''
  private raf = 0
  private countTimer = 0
  private on: Record<Pref, boolean>

  constructor(host: WritingHost) {
    this.host = host
    this.on = {
      outline: readPref('outline'),
      focus: readPref('focus'),
      typewriter: readPref('typewriter'),
      count: readPref('count'),
    }

    // ——— the rail ———
    //
    // A THIRD PANEL WOULD HAVE BEEN THE WRONG SHAPE. The page list and the
    // properties panel already own the two edges, a phone boots with both of
    // them collapsed, and an outline that took the tree's place on a narrow
    // screen would be a regression dressed as a feature. So this is 26px of
    // ticks — one per heading, indented by level — and the readable list is an
    // overlay that appears over the reading column's right gutter on hover or
    // keyboard focus, and takes no layout space at all. The column never
    // reflows when it opens.
    this.rail = tag('nav', 'sp-outline')
    this.rail.setAttribute('aria-label', t('Outline'))
    this.ticks = tag('div', 'sp-ol-ticks')
    const panel = tag('div', 'sp-ol-panel')
    panel.append(tag('div', 'sp-ol-head', t('Outline')))
    // THE TRAP THIS SHAPE WALKS INTO. `overflow-y: auto` also clips
    // HORIZONTALLY — set either axis to a non-`visible` value and the browser
    // computes the other to `auto` — so a scrolling box is a clipping box, and
    // nothing positioned inside one can ever escape it. That is survivable here
    // for exactly one reason: the scroller is `.sp-ol-list` and the only things
    // in it are plain in-flow rows. No popover, no menu, no tooltip of our own
    // may be added inside this element; anything of that kind belongs on the
    // rail, outside the scroller.
    this.list = tag('div', 'sp-ol-list')
    this.empty = tag('p', 'sp-ol-empty', t('No headings on this page yet.'))
    panel.append(this.list, this.empty)
    this.rail.append(this.ticks, panel)

    // ——— the count ———
    //
    // In the bar, not in a dialog: a writer checking their length does it every
    // few minutes, and a number you have to open something to see is a number
    // you stop looking at. It sits BEFORE the status text, because everything
    // ahead of the status is fixed-width and therefore cannot be shoved
    // sideways when the status grows from nothing to a sentence — the same
    // reasoning that put the status after undo/redo in the first place.
    this.chip = tag('span', 'sp-wc')
    this.chip.setAttribute('role', 'status')

    this.applyClasses()
    this.wire()
  }

  isOn(p: Pref): boolean { return this.on[p] }

  // ---- the four toggles ---------------------------------------------------

  toggle(p: Pref, force?: boolean): void {
    this.on[p] = force ?? !this.on[p]
    writePref(p, this.on[p])
    this.applyClasses()
    if (p === 'outline' && this.on.outline) this.refresh()
    if (p === 'count' && this.on.count) this.recount()
    if (p === 'focus') this.paintFocus()
    // Turning typewriter ON should not wait for the next keystroke to prove it
    // did anything — that is how a mode reads as broken.
    if (p === 'typewriter' && this.on.typewriter) this.centreCaret()
    this.host.say(this.report(p))
  }

  /** What the topbar says about a toggle. Literals, never a lookup: `t(MAP[k])`
   *  reaches no catalog while the packer happily reports 100%. */
  private report(p: Pref): string {
    if (p === 'outline') return this.on.outline ? t('Outline shown') : t('Outline hidden')
    if (p === 'focus') return this.on.focus ? t('Focus mode on — everything but the line you are writing is dimmed') : t('Focus mode off')
    if (p === 'typewriter') return this.on.typewriter ? t('Typewriter mode on — the line you are writing stays centred') : t('Typewriter mode off')
    return this.on.count ? t('Word count shown') : t('Word count hidden')
  }

  private applyClasses(): void {
    const r = this.host.root
    r.classList.toggle('sp-has-outline', this.on.outline)
    r.classList.toggle('sp-focus', this.on.focus)
    r.classList.toggle('sp-typewriter', this.on.typewriter)
    this.rail.hidden = !this.on.outline
    this.chip.hidden = !this.on.count
    if (!this.on.focus) this.clearFocus()
  }

  // ---- listeners ----------------------------------------------------------

  private wire(): void {
    // The caret is the one signal all three modes need, and it moves for four
    // different reasons — typing, clicking, arrowing, and a programmatic focus
    // after a block split. `selectionchange` is the only event that catches all
    // four, and it is on `document` because a Selection is a document-level
    // thing, not an element-level one.
    document.addEventListener('selectionchange', () => this.caretMoved())
    // …but `selectionchange` does not fire while a key REPEATS inside one text
    // node in every engine, and typing is exactly when typewriter mode is
    // supposed to be doing its work.
    document.addEventListener('input', () => { this.caretMoved(); this.scheduleCount() }, true)
    document.addEventListener('keyup', (e) => {
      if (e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === 'Backspace') this.caretMoved()
    }, true)
    window.addEventListener('resize', () => { this.fitTicks(); this.schedule() })
  }

  /** Called by the editor once the scroller exists and after every repaint. */
  refresh(): void {
    const main = this.host.main()
    if (main.dataset.olWired !== '1') {
      main.dataset.olWired = '1'
      main.addEventListener('scroll', () => this.schedule(), { passive: true })
    }
    this.heads = this.on.outline ? headingsOf(this.host.page() ?? { blocks: [] }) : []
    this.paintOutline()
    this.recount()
    this.paintFocus()
    this.schedule()
  }

  // ---- the outline --------------------------------------------------------

  private paintOutline(): void {
    this.ticks.innerHTML = ''
    this.list.innerHTML = ''
    this.empty.hidden = this.heads.length > 0
    for (const h of this.heads) {
      const tick = tag('button', `sp-ol-tick sp-ol-l${h.level}`)
      tick.type = 'button'
      tick.dataset.h = h.id
      // The ticks are the only control at rest, so each one carries its
      // heading's text as its accessible name. A column of unlabelled dashes
      // is a column of unlabelled dashes to a screen reader too.
      tick.setAttribute('aria-label', h.text || t('Untitled heading'))
      tick.addEventListener('click', () => this.jump(h.id))
      this.ticks.append(tick)

      const row = tag('button', `sp-ol-item sp-ol-l${h.level}`, h.text || t('Untitled heading'))
      row.type = 'button'
      row.dataset.h = h.id
      row.addEventListener('click', () => this.jump(h.id))
      this.list.append(row)
    }
    this.fitTicks()
    this.markNow()
  }

  /**
   * Keep the tick column inside the rail, however long the page is.
   *
   * The gap is a CSS constant until it cannot be: measured on a 44-heading page
   * the ticks ran to 425px of an 814px rail, so at about 85 headings — an
   * ordinary length for a handbook page — they would have run off the bottom of
   * the screen, and a sticky column that overflows does not scroll, it is simply
   * cut. So the gap is computed from the room there actually is. It never grows
   * past the 7px the stylesheet asks for; it only ever tightens.
   *
   * Measured from the RAIL's box rather than the viewport's, because the rail is
   * a flex item between the topbar and the safe-area inset and those are not the
   * same number.
   */
  private fitTicks(): void {
    const n = this.heads.length
    if (n < 2) { this.ticks.style.removeProperty('gap'); return }
    const room = this.rail.getBoundingClientRect().height - 36 // the column's own padding
    if (room <= 0) { this.ticks.style.removeProperty('gap'); return }
    const marks = n * 3 // the tallest a tick draws, so this never under-counts
    const gap = Math.max(1, Math.min(7, (room - marks) / (n - 1)))
    this.ticks.style.gap = `${gap.toFixed(2)}px`
  }

  private jump(id: string): void {
    this.host.goToBlock(id)
    this.now = id
    this.markNow()
  }

  /**
   * Which heading the reader is inside, from measured geometry.
   *
   * `getBoundingClientRect` against the scroller's own box, never a running
   * total of offsets: a page has covers, callouts, tables and images between
   * its headings, and the only honest answer to "where is this heading on
   * screen" is to ask the element.
   */
  private markNow(): void {
    if (!this.heads.length) { this.now = ''; return }
    const main = this.host.main()
    const box = main.getBoundingClientRect()
    // A heading counts as "current" once it has passed a line a fifth of the
    // way down the visible column — not once it reaches the top, which would
    // leave the last heading of a page never highlighted, and not the middle,
    // which lags a whole screen behind where the eye is.
    const line = box.top + Math.max(80, box.height * 0.2)
    let found = ''
    for (const h of this.heads) {
      const node = main.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(h.id)}"]`)
      if (!node) continue
      if (node.getBoundingClientRect().top <= line) found = h.id
      else break
    }
    // Above the first heading there is no current section, and pretending the
    // first one is current highlights a section the reader has not reached.
    this.now = found
    for (const n of this.rail.querySelectorAll<HTMLElement>('[data-h]')) {
      n.classList.toggle('sp-now', !!found && n.dataset.h === found)
    }
  }

  /**
   * Coalesce scroll work into one frame — with a synchronous fallback.
   *
   * `requestAnimationFrame` is throttled to ZERO in a hidden or occluded tab.
   * A rAF-only version of this is not merely slow there, it never runs at all,
   * so the highlight silently stops tracking and any rig driving a background
   * tab measures nothing and concludes the feature is broken. Checking
   * `visibilityState` and doing the work inline is both the correct behaviour
   * and the thing that makes it measurable.
   */
  private schedule(): void {
    if (document.visibilityState !== 'visible') { this.markNow(); return }
    if (this.raf) return
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.markNow() })
  }

  // ---- focus mode ---------------------------------------------------------

  private caretMoved(): void {
    this.paintFocus()
    this.centreCaret()
  }

  private clearFocus(): void {
    for (const n of this.host.root.querySelectorAll('.sp-focus-now')) n.classList.remove('sp-focus-now')
  }

  /**
   * Dim everything but the block being written in.
   *
   * EVERY ANCESTOR IS MARKED, not just the block itself. `opacity` composites
   * down the tree — a dimmed parent multiplies its children — so a paragraph
   * inside a callout inside a list item would still render at 0.25³ however
   * bright its own rule said it was. Walking the `[data-block-id]` chain to the
   * page and lighting each link of it is what makes a nested block actually
   * legible, and it is invisible in a flat test page.
   */
  private paintFocus(): void {
    if (!this.on.focus) return
    this.clearFocus()
    const a = document.activeElement
    const host = (a instanceof HTMLElement ? a : null)?.closest<HTMLElement>('[data-block-id]')
    if (!host || !this.host.main().contains(host)) return
    for (let n: HTMLElement | null = host; n; n = n.parentElement?.closest<HTMLElement>('[data-block-id]') ?? null) {
      n.classList.add('sp-focus-now')
    }
  }

  // ---- typewriter mode ----------------------------------------------------

  /**
   * Hold the caret's line at a fixed height in the column.
   *
   * 42% rather than 50%: a true centre puts the line you are writing below the
   * middle of your gaze and the text you just wrote crowds the top of the
   * screen. Every typewriter-scroll implementation worth using sits a little
   * high, and this is the number that looks right against a 16px measure.
   *
   * The 2px deadband is load-bearing. Without it, sub-pixel layout differences
   * make every `selectionchange` write a scrollTop that fires another
   * `scroll`, and the column shivers.
   */
  private centreCaret(): void {
    if (!this.on.typewriter) return
    const main = this.host.main()
    const box = caretRect()
    if (!box) return
    const view = main.getBoundingClientRect()
    if (box.bottom < view.top - 400 || box.top > view.bottom + 400) return
    const target = view.top + main.clientHeight * 0.42
    const delta = (box.top + box.height / 2) - target
    if (Math.abs(delta) < 2) return
    main.scrollTop += delta
  }

  /** The caret's line, in viewport coordinates — the rig's measuring point. */
  caretLine(): number | null {
    const box = caretRect()
    return box ? box.top + box.height / 2 : null
  }

  /** Where typewriter mode is aiming, in viewport coordinates. */
  targetLine(): number {
    const main = this.host.main()
    return main.getBoundingClientRect().top + main.clientHeight * 0.42
  }

  /** The current section's heading id, or '' above the first one. */
  currentHeading(): string { return this.now }

  // ---- the word count -----------------------------------------------------

  private scheduleCount(): void {
    if (!this.on.count) return
    clearTimeout(this.countTimer)
    // A count is not worth a re-walk of the page on every keystroke, and it is
    // not worth being stale either. 400ms is under the threshold where a number
    // reads as frozen.
    this.countTimer = setTimeout(() => this.recount(), 400) as unknown as number
  }

  recount(): void {
    if (!this.on.count) return
    const s = pageStats(this.host.page())
    const n = s.words.toLocaleString()
    this.chip.textContent = ''
    // THE WHOLE PHRASE IS THE KEY, and the number is cut back out of it.
    // A bare "words" as its own key would have been a lone noun for a
    // translator to guess the grammar of, and it pins the English word ORDER:
    // a locale that says "単語 1,204" cannot be expressed by a number followed
    // by a unit. Splitting the translated sentence on the placeholder keeps the
    // bold numeral and lets every locale put it where it belongs.
    //
    // (And the key sweeper reads the SOURCE, comments included. A translate
    // call written out inside a comment — the function name, an open paren, a
    // quoted string — mints a key no catalog has, and the packer then reports a
    // missing translation forever. This very comment did it twice while it was
    // being written: name the string in prose, never in the call's own syntax.)
    const [before, after] = t('{n} words', { n: '\u0000' }).split('\u0000')
    if (before) this.chip.append(tag('span', 'sp-wc-unit', before))
    this.chip.append(tag('b', 'sp-wc-n', n))
    if (after) this.chip.append(tag('span', 'sp-wc-unit', after))
    if (s.minutes) {
      this.chip.append(
        tag('span', 'sp-wc-sep', ' · '),
        tag('span', 'sp-wc-min', t('{n} min', { n: String(s.minutes) })),
      )
    }
    this.chip.title = t('{words} words, {chars} characters — about {min} min to read', {
      words: n, chars: s.chars.toLocaleString(), min: String(s.minutes),
    })
  }
}
