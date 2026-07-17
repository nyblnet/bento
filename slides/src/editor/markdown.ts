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
    node.replaceData(off - 2, 2, '• ')
    placeCaret(node, off)
    return true
  }

  for (const { re, tag } of INLINE) {
    const m = upto.match(re)
    if (!m || !m[1]) continue
    const start = off - m[0].length
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

/** Pasted plain text → the inline-HTML subset (bold/italic/strike/code/bullets/<br>). */
export function markdownToHtml(text: string): string {
  return text
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
}
