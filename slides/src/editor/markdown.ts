// Lightweight markdown affordances for text editing. Two entry points:
// - autoformatAtCaret: called on every input; when the text just before the
//   caret completes an inline pattern (**bold**, *italic*, `code`, ~~strike~~)
//   the markers collapse into the real element, Notion-style. "- " at the
//   start of a line becomes a bullet glyph.
// - markdownToHtml: converts pasted plain text (inline patterns + bullets +
//   line breaks) into the sanitized inline-HTML subset text elements store.
//
// Deliberately inline-only: slides have no headings/lists DOM — bullets are a
// "• " glyph, matching how decks lay out list lines as separate text rows.

const INLINE: Array<{ re: RegExp; tag: string }> = [
  { re: /\*\*([^*\n]+)\*\*$/, tag: 'b' },
  { re: /__([^_\n]+)__$/, tag: 'b' },
  { re: /(?<![*\w])\*([^*\n]+)\*$/, tag: 'i' },
  { re: /(?<![_\w])_([^_\n]+)_$/, tag: 'i' },
  { re: /~~([^~\n]+)~~$/, tag: 's' },
  { re: /`([^`\n]+)`$/, tag: 'code' },
]

/** The most recent conversion, revertible with ⌘Z until the next input. */
type LastFormat =
  | { kind: 'inline'; el: HTMLElement; source: string; tail: Text }
  | { kind: 'bullet'; node: Text; offset: number; source: string }
let lastFormat: LastFormat | null = null

/** Forget the revertible conversion (any input that isn't a fresh conversion). */
export function clearAutoformat() {
  lastFormat = null
}

/** ⌘Z immediately after a conversion: restore the literal typed markers.
 *  Returns true when it reverted (caller should preventDefault). */
export function undoAutoformat(): boolean {
  const last = lastFormat
  lastFormat = null
  if (!last) return false
  if (last.kind === 'bullet') {
    if (!last.node.isConnected) return false
    last.node.replaceData(last.offset, 2, last.source)
    placeCaret(last.node, last.offset + last.source.length)
    return true
  }
  if (!last.el.isConnected) return false
  const literal = document.createTextNode(last.source)
  last.el.replaceWith(literal)
  last.tail.remove()
  placeCaret(literal, literal.data.length)
  return true
}

/** Collapse a just-completed markdown marker before the caret. Returns true if it fired. */
export function autoformatAtCaret(): boolean {
  const sel = document.getSelection()
  if (!sel?.isCollapsed || !(sel.anchorNode instanceof Text)) return false
  const node = sel.anchorNode
  const off = sel.anchorOffset // capture — DOM mutation below resets the live selection
  const upto = node.data.slice(0, off)

  // "- " at line start → bullet glyph (contentEditable renders the trailing
  // space as NBSP, so match both; keep NBSP so the glyph's gap can't collapse)
  if (/(?:^|\n)-[  ]$/.test(upto) && off >= 2 && isLineStart(node, off - 2)) {
    const source = node.data.slice(off - 2, off)
    node.replaceData(off - 2, 2, '• ')
    placeCaret(node, off)
    lastFormat = { kind: 'bullet', node, offset: off - 2, source }
    return true
  }

  for (const { re, tag } of INLINE) {
    const m = upto.match(re)
    if (!m || !m[1]) continue
    const start = off - m[0].length
    // backslash escape: \*literal\* stays literal (stripped on commit)
    if (start > 0 && node.data[start - 1] === '\\') continue
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, off)
    range.deleteContents()
    const el = document.createElement(tag)
    el.textContent = m[1]
    range.insertNode(el)
    // caret into a fresh text node AFTER the element so typing continues plain
    const tail = document.createTextNode('​')
    el.after(tail)
    placeCaret(tail, 1)
    lastFormat = { kind: 'inline', el, source: m[0], tail }
    return true
  }
  return false
}

/** True when offset sits at the start of a rendered line (node start or after
 *  a <br>). Zero-width caret spacers left by autoformat are see-through. */
function isLineStart(node: Text, offset: number): boolean {
  const before = node.data.slice(0, offset).replace(/​/g, '')
  if (before) return before.endsWith('\n')
  let prev = node.previousSibling
  while (prev && prev.nodeType === Node.TEXT_NODE && /^[​\s]*$/.test((prev as Text).data)) {
    prev = prev.previousSibling
  }
  return !prev || (prev instanceof Element && prev.tagName === 'BR')
}

function placeCaret(node: Node, offset: number) {
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

const escapeHtml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** Pasted plain text → the inline-HTML subset (bold/italic/strike/code/bullets/<br>).
 *  Backslash escapes markers: \*x\* pastes as literal *x*. */
export function markdownToHtml(text: string): string {
  // park escaped markers in the private-use area so patterns can't see them
  const PARK = ''
  const parked: string[] = []
  const withParked = text.replace(/\\([*_~`-])/g, (_, c: string) => {
    parked.push(c)
    return PARK + (parked.length - 1) + PARK
  })
  const out = withParked
    .split('\n')
    .map((line) => {
      let s = escapeHtml(line).replace(/^(\s*)- /, '$1• ')
      s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      s = s.replace(/__([^_]+)__/g, '<b>$1</b>')
      s = s.replace(/(?<![*\w])\*([^*]+)\*/g, '<i>$1</i>')
      s = s.replace(/(?<![_\w])_([^_]+)_(?![\w])/g, '<i>$1</i>')
      s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>')
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
      return s
    })
    .join('<br>')
  return out.replace(/(\d+)/g, (_, i) => parked[+i])
}
