// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The keyboard shortcuts dialog (?, ⌘/, the ⌨ button): Figma's and Linear's
// shape — a search field, a category rail, rows of name · keycaps. Every keyed
// command comes from the command list (commands.ts), so the dialog cannot
// drift from what the keys do; what is not a command — a gesture, a key that
// only means something in one mode — is declared once below.
import { t } from '../i18n'
import { MOD, type Command } from './commands'

type Group = 'tools' | 'selection' | 'edit' | 'arrange' | 'frames' | 'text' | 'view' | 'slides' | 'present' | 'mouse'

const GROUPS: Array<[Group, string]> = [
  ['tools', 'Tools'], ['selection', 'Selection'], ['edit', 'Edit'], ['arrange', 'Arrange & align'],
  ['frames', 'Frames & layout'], ['text', 'Text'], ['view', 'View & zoom'], ['slides', 'Slides'],
  ['present', 'Present'], ['mouse', 'Mouse & trackpad'],
]

/** A command's category, by its id. */
function groupOf(id: string): Group {
  if (id.startsWith('tool-') || id === 'insert-text' || id === 'comment') return 'tools'
  if (id.startsWith('select-')) return 'selection'
  if (/^(align|distribute|flip|bool)-/.test(id) || id === 'group' || id === 'ungroup') return 'arrange'
  if (id === 'auto-layout') return 'frames'
  if (id.startsWith('zoom-') || id.startsWith('toggle-')) return 'view'
  if (id.endsWith('-slide')) return 'slides'
  if (id === 'present') return 'present'
  return 'edit'
}

interface Row {
  group: Group
  /** shown (translated) and its English source, both searched */
  label: string
  en: string
  hint?: string
  /** alternatives, each a chord of keycaps */
  keys: string[][]
}

const MAC = MOD === '⌘'
/** Words for the modifier glyphs where the keyboard has no ⌘ */
const WORD: Record<string, string> = MAC ? {} : { '⌘': 'Ctrl', '⇧': 'Shift', '⌥': 'Alt', '⌃': 'Ctrl' }
const SPOKEN: Record<string, string> = { '⌘': 'Command', '⇧': 'Shift', '⌥': MAC ? 'Option' : 'Alt', '⌃': 'Control', '⌫': 'Delete', '←': 'Left', '→': 'Right', '↑': 'Up', '↓': 'Down' }

/** '⇧⌘G' / 'CtrlS' / 'PageDown' → the chord's caps, one per key. */
function caps(chord: string): string[] {
  const parts = chord.match(/Ctrl|Alt|Shift|Esc|PageUp|PageDown|Enter|Space|Tab|F\d+|./gu) ?? []
  return parts.map((k) => WORD[k] ?? (k.length === 1 ? k.toUpperCase() : k))
}

/** What the keyboard parts of a query or a chord are, comparable either way:
 *  ⌘ cmd command ctrl control ⌃ → mod, ⇧ shift, ⌥ alt option. */
const NORM: Record<string, string> = { '⌘': 'mod', cmd: 'mod', command: 'mod', ctrl: 'mod', control: 'mod', '⌃': 'mod', '⇧': 'shift', shift: 'shift', '⌥': 'alt', alt: 'alt', option: 'alt', opt: 'alt' }
function keyTokens(s: string): string[] {
  return (s.toLowerCase().match(/command|control|option|shift|cmd|ctrl|alt|opt|pageup|pagedown|esc|f\d+|[⌘⌃⇧⌥]|[^\s+\-]/gu) ?? []).map((k) => NORM[k] ?? k)
}
const sameKeys = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

function rows(commands: Command[]): Row[] {
  const out: Row[] = []
  const seen = new Set<string>()
  for (const c of commands) {
    if (!c.keys || seen.has(c.id)) continue
    seen.add(c.id)
    out.push({ group: groupOf(c.id), label: t(c.label), en: c.label, keys: c.keys.split(/\s+or\s+/).map(caps), hint: HINT[c.id] && t(HINT[c.id]) })
  }
  // what is not a command: one place, reusing the descriptions the old sheet said
  const word = (s: string) => t(s)
  const x = (group: Group, en: string, keys: string[][]) => out.push({ group, label: t(en), en, keys })
  const M = MAC ? '⌘' : 'Ctrl', A = MAC ? '⌥' : 'Alt', S = MAC ? '⇧' : 'Shift'
  x('edit', 'Paste', [[M, 'V']])
  x('edit', 'Type arithmetic into a number; a leading + * / starts from its current value', [['360/2'], ['+24'], ['*2']])
  x('edit', 'Step a number; ⇧ steps by 10', [['↑'], ['↓']])
  x('text', 'Bold', [[M, 'B']])
  x('text', 'Italic', [[M, 'I']])
  x('text', 'Underline', [[M, 'U']])
  x('text', 'Insert the page number, date, time, title or a document property; a date can pin its format — {{date:M/D/YY}}', [[word('Text ▸ Field')]])
  x('selection', 'Add an element to the selection, or take it out', [[S, word('click')]])
  x('selection', 'Select the element under the pointer, even inside a group', [[M, word('click')]])
  x('selection', 'Select the element behind it; click again to go deeper', [[A, word('click')]])
  x('selection', 'Lists every element under the pointer, to select one that is covered', [[word('Right-click')]])
  x('selection', 'Walk the slides when nothing is selected; nudge the selection otherwise', [['←'], ['→']])
  x('frames', 'Puts it inside, where the bar shows — in Layers, drop it on the frame row; hold {mod} while dragging to move over it instead', [[word('Drag onto a frame')]])
  x('view', 'Zoom in and out', [[M, word('scroll')]])
  x('view', 'Pan the canvas, including past the edges of the slide', [[word('Space-drag')]])
  x('view', 'Pan as well, if your mouse has a middle button', [[word('Middle-drag')]])
  x('slides', 'Select several slides in the sidebar; drag any of them to move them all, Delete removes them', [[M, word('click')], [S, word('click')]])
  x('present', 'Toggle fullscreen while presenting', [['F']])
  x('present', 'Speaker view — notes on a second screen if you have one', [['S']])
  x('present', 'Toggle laser pointer while presenting', [['L']])
  x('present', 'Reduce motion — pause animations (also honours your OS setting)', [['M']])
  x('present', 'Black screen — and back', [['B']])
  x('present', 'All slides in the speaker view — pick one to jump to', [['G']])
  x('present', 'Previous · next slide, or the next reveal step on a slide that has them', [['←'], ['→']])
  x('present', 'End the show', [['Esc']])
  x('mouse', 'Measure from the selection to the element under the pointer', [[A, word('hover')]])
  x('mouse', 'Scrub the number — ⇧ ×10, Alt ×0.1; the drag never stops at the screen edge', [[word('Drag a label')]])
  x('mouse', 'Rename a layer or a group in the Layers list', [[word('Double-click')]])
  x('mouse', 'Break a smooth point into a sharp corner', [[A, word('drag')]])
  x('mouse', 'Click to place corners, drag to pull out curves (Alt breaks a handle); click the first point to close, Enter or Esc to finish', [[word('Pen'), 'P']])
  x('mouse', 'Add a point on the line; double-click a point to remove it', [[word('Double-click')]])
  x('mouse', 'Set how fast the element moves through that point', [[word('Scroll a point')]])
  x('mouse', 'Move an endpoint or anchor; drag the body to move the whole line', [[word('Drag a point')]])
  x('mouse', 'Reveal its bézier handles for a precise curve', [[word('Click a point')]])
  x('mouse', 'Corner, Smooth or Symmetric for the clicked point (or every point); Close path joins the ends', [[word('Path bar')]])
  x('mouse', 'Draw a line, curved line or connector — then drag on the canvas', [[word('Shape ▾')]])
  x('mouse', 'Choose Follow a path, then Edit path on canvas', [[word('Animate ▸ Loop animation')]])
  x('mouse', 'Add a point on the path; double-click a point to remove it', [[word('Double-click')]])
  x('edit', 'Several elements differ: an edit moves each by the same amount', [[word('Mixed')]])
  x('present', 'Hide the selected elements until → is pressed, one after another in reading order — numbered badges on the canvas show the order', [[word('Right-click ▸ Reveal in order')]])
  // the {mod} the frame-drop row speaks of
  for (const r of out) r.label = r.label.replace('{mod}', M)
  return out
}

/** A command's one-line explanation, where its name alone undersells it. */
const HINT: Record<string, string> = {
  copy: 'Copy · paste — elements, or the whole slide when nothing is selected',
  'ghost-cut': 'Cut to move — the selection fades until you paste it in its new place; Esc cancels',
  component: 'Create component — copies inserted from the Tokens view follow it',
  palette: 'Command palette — search every action by name',
  'auto-layout': 'Wrap the selection in an auto-layout frame',
}

export function openShortcuts(commands: Command[]) {
  document.querySelector('.ed-keys-overlay')?.remove()
  const opener = document.activeElement as HTMLElement | null
  const all = rows(commands)
  const overlay = document.createElement('div')
  overlay.className = 'ed-about-overlay ed-keys-overlay'
  const box = document.createElement('div')
  box.className = 'ed-keys'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('aria-labelledby', 'ed-keys-title')
  const head = document.createElement('div')
  head.className = 'ed-keys-head'
  const title = document.createElement('h2')
  title.id = 'ed-keys-title'
  title.textContent = t('Keyboard shortcuts')
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'ed-keys-search'
  search.placeholder = t('Search shortcuts')
  search.setAttribute('aria-label', t('Search shortcuts'))
  head.append(title, search)
  const rail = document.createElement('nav')
  rail.className = 'ed-keys-rail'
  rail.setAttribute('aria-label', t('Categories'))
  const list = document.createElement('div')
  list.className = 'ed-keys-list'
  list.setAttribute('role', 'list')
  const foot = document.createElement('div')
  foot.className = 'ed-keys-foot'
  const link = document.createElement('a')
  link.href = 'https://bento.page/help'
  link.target = '_blank'
  link.rel = 'noopener'
  link.textContent = t('Full guide at bento.page/help →')
  foot.appendChild(link)
  const body = document.createElement('div')
  body.className = 'ed-keys-body'
  body.append(rail, list)
  box.append(head, body, foot)
  overlay.appendChild(box)

  let group: Group | 'all' = 'all'
  const railBtn = (g: Group | 'all', label: string, n: number) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-keys-cat'
    b.dataset.group = g
    b.setAttribute('aria-pressed', String(g === group))
    const name = document.createElement('span')
    name.textContent = label
    const count = document.createElement('span')
    count.className = 'ed-keys-count'
    count.textContent = String(n)
    b.append(name, count)
    b.addEventListener('click', () => { group = g; search.value = ''; paint() })
    return b
  }
  const paintRail = () => rail.replaceChildren(railBtn('all', t('All'), all.length),
    ...GROUPS.map(([g, en]) => railBtn(g, t(en), all.filter((r) => r.group === g).length)).filter((b) => b.querySelector('.ed-keys-count')!.textContent !== '0'))

  const rowEl = (r: Row, withGroup: boolean) => {
    const el = document.createElement('div')
    el.className = 'ed-keys-row'
    el.setAttribute('role', 'listitem')
    el.tabIndex = -1
    const text = document.createElement('div')
    text.className = 'ed-keys-text'
    const name = document.createElement('span')
    name.className = 'ed-keys-name'
    name.textContent = r.label
    text.appendChild(name)
    const sub = r.hint ?? (withGroup ? t(GROUPS.find(([g]) => g === r.group)![1]) : '')
    if (sub) { const h = document.createElement('span'); h.className = 'ed-keys-hint'; h.textContent = sub; text.appendChild(h) }
    const keys = document.createElement('div')
    keys.className = 'ed-keys-keys'
    r.keys.forEach((chord, i) => {
      if (i) { const or = document.createElement('span'); or.className = 'ed-keys-or'; or.textContent = t('or'); keys.appendChild(or) }
      for (const k of chord) { const kbd = document.createElement('kbd'); kbd.textContent = k; keys.appendChild(kbd) }
    })
    el.append(text, keys)
    el.setAttribute('aria-label', `${r.label}, ${r.keys.map((c) => c.map((k) => SPOKEN[k] ?? k).join(' ')).join(` ${t('or')} `)}`)
    return el
  }

  const matches = (r: Row, q: string) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const hay = `${r.label} ${r.en} ${r.hint ?? ''}`.toLowerCase()
    if (words.every((w) => hay.includes(w))) return true
    const kq = keyTokens(q)
    return kq.length > 0 && r.keys.some((chord) => sameKeys(keyTokens(chord.join(' ')), kq))
  }

  const paint = () => {
    const q = search.value.trim()
    for (const b of rail.querySelectorAll<HTMLElement>('.ed-keys-cat')) b.setAttribute('aria-pressed', String(!q && b.dataset.group === group))
    if (q) {
      const hits = all.filter((r) => matches(r, q))
      list.replaceChildren(...(hits.length ? hits.map((r) => rowEl(r, true)) : [Object.assign(document.createElement('p'), { className: 'ed-keys-empty', textContent: t('No shortcut matches') })]))
      return
    }
    const parts: HTMLElement[] = []
    for (const [g, en] of GROUPS) {
      if (group !== 'all' && group !== g) continue
      const these = all.filter((r) => r.group === g)
      if (!these.length) continue
      const h = document.createElement('h3')
      h.className = 'ed-keys-group'
      h.textContent = t(en)
      parts.push(h, ...these.map((r) => rowEl(r, false)))
    }
    list.replaceChildren(...parts)
    list.scrollTop = 0
  }
  paintRail()
  paint()
  search.addEventListener('input', paint)

  const rowsNow = () => [...list.querySelectorAll<HTMLElement>('.ed-keys-row')]
  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
    opener?.focus?.()
  }
  const onKey = (ev: KeyboardEvent) => {
    // a sheet removed without close() must not keep swallowing every key
    if (!overlay.isConnected) { document.removeEventListener('keydown', onKey, true); return }
    ev.stopPropagation()
    if (ev.key === 'Escape') {
      ev.preventDefault()
      if (search.value) { search.value = ''; paint(); search.focus() } else close()
      return
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const rs = rowsNow()
      if (!rs.length) return
      ev.preventDefault()
      const i = rs.indexOf(document.activeElement as HTMLElement)
      const next = ev.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(i + 1, rs.length - 1)) : (i <= 0 ? -1 : i - 1)
      if (next < 0) search.focus(); else rs[next].focus()
    }
  }
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  search.focus()
}
