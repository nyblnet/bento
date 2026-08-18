// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shortcut card — and every row of it is GENERATED.
//
// A spreadsheet is a keyboard instrument. Dash already had the key set — the
// Tab run, ⌘↓ to the edge of a block, ⇧Space for the row — and no way at all to
// discover it: the only complete list was `keyToAction` in select.ts, which is
// not a place users look. This is the door.
//
// NOTHING HERE LISTS A KEY. `describeBindings()` probes the map and reports
// what it answers, and this file supplies only the ENGLISH for each action. A
// hand-written card is a copy of the map, and a copy drifts inside one release
// — at which point it is teaching people bindings that do not exist, which is
// strictly worse than having no card at all. The rig fails when the map grows
// an action nobody here has named, and when a name here matches no action.
//
// TWO SORTS OF CONTENT, and the line between them is load-bearing:
//   · SHORTCUTS come from the map. Never edit them here.
//   · TIPS are prose about gestures the map cannot express — typing over a
//     cell, double-click, the fill handle. They are hand-written because there
//     is nothing to derive them from, and they name no keystroke that a row
//     could contradict.
//
// The overlay sits INSIDE main.ts's document-level handlers (a bare printable
// key goes to the selected cell; ⌘S saves; a paste is sniffed for CSV), so it
// stops keydown and paste at its backdrop exactly as about.ts does. Without
// that, reading the shortcut card types into the sheet behind it.

import './help.css'
import { describeBindings, keyToAction, type BindingRow, type KeyChord } from './select.ts'
import { t } from './i18n.ts'

// --- naming the actions ------------------------------------------------------

/** Section order IS this array's order. */
const SECTIONS = ['move', 'select', 'enter', 'clip', 'file'] as const
type Section = (typeof SECTIONS)[number]

/** Raw English, translated at RENDER time — a t() in a module const freezes. */
const SECTION_TITLE: Record<Section, string> = {
  move: 'Moving around',
  select: 'Selecting',
  enter: 'Entering data',
  clip: 'Clipboard',
  file: 'The workbook',
}

/**
 * One line of English per ACTION, keyed by its signature (select.ts
 * `actionSig`). Rows appear in this order within their section.
 *
 * The keys are the contract with the map. `scripts/test-dash-select.ts` reads
 * this table out of the source and checks it against `describeBindings()` in
 * BOTH directions, so an unnamed action and a name for an action that no longer
 * exists are each a failing test rather than a card that quietly lies.
 */
const LABELS: Record<string, [Section, string]> = {
  'move.cell': ['move', 'Move one cell'],
  'move.edge': ['move', 'Jump to the edge of the data block'],
  'move.page': ['move', 'Move one screen'],
  'home': ['move', 'First column of this row'],
  'end': ['move', 'Last column of this row'],
  'home.whole': ['move', 'First cell of the sheet'],
  'end.whole': ['move', 'Last cell of the sheet'],

  'move.cell.extend': ['select', 'Extend the selection one cell'],
  'move.edge.extend': ['select', 'Extend the selection to the edge of the block'],
  'move.page.extend': ['select', 'Extend the selection one screen'],
  'home.extend': ['select', 'Extend to the first column'],
  'end.extend': ['select', 'Extend to the last column'],
  'home.whole.extend': ['select', 'Extend to the first cell of the sheet'],
  'end.whole.extend': ['select', 'Extend to the last cell of the sheet'],
  'selectRow': ['select', 'Select the whole row'],
  'selectCol': ['select', 'Select the whole column'],
  'selectAll': ['select', 'Select the whole sheet'],

  'edit': ['enter', 'Edit the active cell, keeping what is in it'],
  'enter': ['enter', 'Commit and move down — after a Tab run, back under where the run started'],
  'enter.back': ['enter', 'Commit and move up'],
  'tab': ['enter', 'Commit and move right — inside a selected block, walk the block'],
  'tab.back': ['enter', 'Commit and move left'],
  'fill': ['enter', 'Fill the selection down from its top row'],
  'clear': ['enter', 'Clear the selected cells'],
  'cancel': ['enter', 'Cancel what you are editing'],

  'style.bold': ['enter', 'Bold the selected cells — or un-bold them, when every one is already bold'],
  'style.italic': ['enter', 'Italic the selected cells'],
  'style.underline': ['enter', 'Underline the selected cells'],

  'copy': ['clip', 'Copy the selection'],
  'cut': ['clip', 'Cut the selection'],
  'paste': ['clip', 'Paste into the selection'],
  'pasteSpecial': ['clip', 'Paste special — values only, formulas, formats only, transposed'],
  'textToColumns': ['clip', 'Split the selected column into several, on a delimiter or at fixed widths'],

  'find': ['file', 'Find in the sheet — the grid is windowed, so the browser’s own ⌘F cannot see it all'],
  'findNext': ['file', 'Go to the next match'],
  'findNext.back': ['file', 'Go to the previous match'],

  'undo': ['file', 'Undo'],
  'redo': ['file', 'Redo'],
  'save': ['file', 'Save this workbook'],
  'sheetStep': ['file', 'Previous / next sheet'],
  'panel.left': ['file', 'Show or hide the sheet tabs'],
  'panel.right': ['file', 'Show or hide the properties panel'],
  'help': ['file', 'This card'],
}

/** Gestures that never reach the key map, so nothing can derive them. */
const TIPS = [
  'Just start typing over a selected cell — the first character replaces what was there. F2 (or a double-click) edits what is already in it instead.',
  'A cell that starts with “?” has to be typed that way: press F2 first, because a bare “?” opens this card.',
  'Drag the small square at the corner of the selection to fill — dash continues 1, 2, 3 and Jan, Feb, Mar, and repeats anything it cannot read as a series.',
  'Paste from Excel or Sheets lands in the cells at the cursor. Use Data ▸ Import to bring a file in as a new sheet.',
  'Right-click a cell for the clipboard, rows, columns, fill and conditional formatting. Right-click a row number or a column header for the whole row or column — insert, delete and clear, counted from the selection.',
  'Click a column letter to select it, the corner box to select the sheet, and a column header’s caret to sort or filter.',
  'The row of + cells under the last row adds a row: click it and type. The + past the last column header adds a column — a column needs a name first, so it asks for one.',
]

// --- drawing a chord ---------------------------------------------------------

const KEY_LABEL: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Escape: 'Esc', Delete: 'Del', Backspace: '⌫',
  PageUp: 'PgUp', PageDown: 'PgDn', ' ': 'Space',
}

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

/**
 * The modifier prefix. Symbols on a Mac, words elsewhere — writing '⌘' to a
 * Windows user names a key that is not on their keyboard.
 */
function mods(c: KeyChord): string {
  const mac = isMac()
  let s = ''
  if (c.mod !== 'none') {
    // ⌘Space IS Spotlight on macOS: the keystroke never reaches the page, so
    // naming it here would be advice that cannot work. The map takes either
    // modifier, and ctrl is the one that arrives.
    const ctrlOnly = c.mod === 'ctrl' || (c.key === ' ' && mac)
    s += ctrlOnly ? (mac ? '⌃' : 'Ctrl+') : (mac ? '⌘' : 'Ctrl+')
  }
  if (c.alt) s += mac ? '⌥' : 'Alt+'
  if (c.shift) s += mac ? '⇧' : 'Shift+'
  return s
}

const keyText = (key: string): string => KEY_LABEL[key] ?? (key.length === 1 ? key.toUpperCase() : key)

/**
 * A row's chords as printable chips.
 *
 * Four arrows sharing one set of modifiers collapse into a single chip:
 * "⌘⇧↑ ⌘⇧↓ ⌘⇧← ⌘⇧→" is four chips of noise for one idea, and the collapse is
 * checked (same modifiers, all arrows) rather than assumed.
 */
function chips(chords: KeyChord[]): string[] {
  // Plainest first: the probe walks the key space in its own order, which put
  // "⌘/" ahead of "?" on the row whose whole job is to teach you "?".
  const rank = (c: KeyChord): number => (c.mod === 'none' ? 0 : 1) + (c.shift ? 1 : 0) + (c.alt ? 1 : 0)
  const sorted = [...chords].sort((a, b) => rank(a) - rank(b))
  const first = sorted[0]
  const allArrows = sorted.length > 1 && sorted.every((c) =>
    ARROWS.has(c.key) && mods(c) === mods(first))
  if (allArrows) return [`${mods(first)}${sorted.map((c) => keyText(c.key)).join('')}`]
  return sorted.map((c) => `${mods(c)}${keyText(c.key)}`)
}

// --- the card ----------------------------------------------------------------

/** Rows in card order, with their English. Exported for the rig, and for scripts. */
export function helpRows(): Array<{ section: Section; label: string; chords: KeyChord[]; sig: string }> {
  const found = new Map<string, BindingRow>()
  for (const row of describeBindings()) found.set(row.sig, row)
  const out: Array<{ section: Section; label: string; chords: KeyChord[]; sig: string }> = []
  for (const [sig, [section, label]] of Object.entries(LABELS)) {
    const row = found.get(sig)
    if (!row) continue                     // named, but no longer bound — the rig says so
    out.push({ section, label, chords: row.chords, sig })
    found.delete(sig)
  }
  // A binding nobody has named still SHOWS, under its raw signature. Silently
  // dropping it would make the card look complete while hiding a shortcut, and
  // the whole point of generating this is that it cannot go quietly stale.
  for (const row of found.values()) out.push({ section: 'file', label: row.sig, chords: row.chords, sig: row.sig })
  return out
}

let card: HTMLElement | null = null

export function closeHelp(): void {
  card?.remove()
  card = null
}

export function helpOpen(): boolean { return card !== null }

export function openHelp(): void {
  closeHelp()
  const back = document.createElement('div')
  back.className = 'dx-help-back'
  const box = document.createElement('div')
  box.className = 'dx-help'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')

  const h = document.createElement('h2')
  h.textContent = t('Keyboard shortcuts')
  box.append(h)

  const cols = document.createElement('div')
  cols.className = 'dx-help-cols'
  box.append(cols)

  const rows = helpRows()
  for (const section of SECTIONS) {
    const mine = rows.filter((r) => r.section === section)
    if (!mine.length) continue
    const sec = document.createElement('section')
    sec.className = 'dx-help-sec'
    const st = document.createElement('h3')
    st.textContent = t(SECTION_TITLE[section])
    sec.append(st)
    for (const r of mine) {
      const line = document.createElement('div')
      line.className = 'dx-help-row'
      const keys = document.createElement('span')
      keys.className = 'dx-help-keys'
      for (const chip of chips(r.chords)) {
        const kbd = document.createElement('kbd')
        kbd.textContent = chip
        keys.append(kbd)
      }
      const what = document.createElement('span')
      what.className = 'dx-help-what'
      what.textContent = t(r.label)
      line.append(keys, what)
      sec.append(line)
    }
    cols.append(sec)
  }

  const tips = document.createElement('section')
  tips.className = 'dx-help-sec dx-help-tipsec'
  const tt = document.createElement('h3')
  tt.textContent = t('Good to know')
  tips.append(tt)
  const ul = document.createElement('ul')
  ul.className = 'dx-help-tips'
  for (const tip of TIPS) {
    const li = document.createElement('li')
    li.textContent = t(tip)
    ul.append(li)
  }
  tips.append(ul)
  cols.append(tips)

  const close = document.createElement('button')
  close.className = 'dx-btn dx-help-close'
  close.type = 'button'
  close.textContent = t('Close')
  close.addEventListener('click', closeHelp)
  box.append(close)

  // main.ts owns document-level keydown and paste handlers that this card sits
  // inside: the keydown routes any bare printable key into the selected cell,
  // and the paste sniffer would treat a stray clipboard drop as a CSV import.
  // Both are stopped at the backdrop, which contains everything in the card.
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHelp()
    e.stopPropagation()
  })
  back.addEventListener('paste', (e) => e.stopPropagation())
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeHelp() })

  back.append(box)
  document.body.append(back)
  card = back
  // FOCUS THE CARD, NOT THE BUTTON. Focusing Close scrolls the backdrop to the
  // bottom of a card that is taller than the window — measured: the card opened
  // showing its last section, with the heading and the whole "Moving around"
  // group above the fold. The dialog itself takes focus so Escape and the tab
  // order still start inside it.
  box.tabIndex = -1
  box.focus({ preventScroll: true })
}

export function toggleHelp(): void { helpOpen() ? closeHelp() : openHelp() }

/**
 * The card's two doors: a '?' button in the top bar and the '?' key.
 *
 * THE KEY LISTENER IS CAPTURE-PHASE, for the same reason panels.ts's '[' and
 * ']' listener is: main.ts's document keydown hands every bare printable key to
 * `grid.typeInto`, which would open a cell editor seeded with "?". Capturing on
 * `document` runs before every bubble listener on it, and
 * `stopImmediatePropagation` (not `stopPropagation` — the handlers share a
 * node) is what keeps the keystroke from reaching the grid at all.
 *
 * WHAT THE KEY MEANS is still the map's decision, not this file's: the listener
 * asks `keyToAction`. So '?' and ⌘/ are bound in exactly one place, which is
 * the same place the card reads to describe them.
 */
export function mountHelp(app: HTMLElement): void {
  const bar = app.querySelector<HTMLElement>('.dx-bar-end') ?? app.querySelector<HTMLElement>('.dx-bar')
  if (bar) {
    const b = document.createElement('button')
    b.className = 'dx-btn dx-help-btn'
    b.type = 'button'
    b.dataset.act = 'help'
    b.title = t('Keyboard shortcuts (?)')
    b.setAttribute('aria-label', t('Keyboard shortcuts'))
    b.textContent = '?'
    b.addEventListener('click', toggleHelp)
    // Before the version chip, so the card's door survives the responsive
    // ladder that hides the chip first; insertBefore(x, null) appends.
    bar.insertBefore(b, bar.querySelector('.dx-ver'))
  }

  document.addEventListener('keydown', (e) => {
    // Escape closes from anywhere — the backdrop only sees it while focus is
    // inside the card, and a click on the sheet behind moves focus out.
    if (card && e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation(); closeHelp(); return
    }
    if (keyToAction(e)?.kind !== 'help') return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    toggleHelp()
  }, true)
}
