// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * MathML as a TREE, DOM-free — what an engine MEANS, not how it spells it.
 *
 * Used by scripts/test-maths-lite.ts to hold maths-lite to the frozen Temml
 * reference (scripts/fixtures/maths-reference.json) and by the script that
 * froze it. The normalisation is the one the spike's Chrome harness used
 * (spike-maths-lite, 2026-09-15), ported off DOMParser so CI needs no
 * browser: spelling attributes dropped, mstyle/mpadded/semantics unwrapped,
 * single-child and nested mrows folded, invisible operators and mspace
 * removed, entities decoded.
 *
 * The tokenizer expects what the two engines emit: well-formed tags,
 * double-quoted attributes, self-closing allowed. It is not an HTML parser.
 */

export type MNode = { tag: string; kids: MNode[]; attrs?: Record<string, string> } | { t: string }

const DROP_ATTR = new Set(['class', 'data-sym', 'data-msx', 'xmlns', 'style', 'stretchy', 'form', 'lspace', 'rspace', 'accent', 'accentunder', 'largeop', 'movablelimits', 'symmetric', 'fence', 'separator', 'minsize', 'maxsize', 'mathvariant', 'displaystyle', 'scriptlevel', 'columnalign', 'rowspacing', 'columnspacing', 'linethickness', 'width', 'height', 'depth', 'voffset', 'encoding', 'display', 'mathcolor', 'mathbackground', 'href', 'id', 'aria-hidden', 'columnlines', 'rowlines', 'frame', 'notation'])

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  return ENT[e.toLowerCase()] ?? m
})

type Raw = { tag: string; attrs: Record<string, string>; kids: (Raw | string)[] }

/** Parse a markup string into a raw element tree (the first element found). */
export function parseMarkup(html: string): Raw | null {
  const root: Raw = { tag: '#root', attrs: {}, kids: [] }
  const stack: Raw[] = [root]
  const re = /<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1]
    if (m[1]) { if (stack.length > 1) stack.pop() }
    else if (m[2]) {
      const attrs: Record<string, string> = {}
      for (const a of m[3].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? '')
      const el: Raw = { tag: m[2].toLowerCase(), attrs, kids: [] }
      top.kids.push(el)
      if (!m[4]) stack.push(el)
    } else if (m[5]) top.kids.push(decode(m[5]))
  }
  return root.kids.find((k): k is Raw => typeof k !== 'string') ?? null
}

function norm(node: Raw | string): MNode | null {
  if (typeof node === 'string') { const t = node.replace(/\s+/g, ' ').trim(); return t ? { t } : null }
  const tag = node.tag
  let kids = node.kids.map(norm).filter((k): k is MNode => !!k)
  if (tag === 'mstyle' || tag === 'mpadded' || tag === 'semantics') return kids.length === 1 ? kids[0] : { tag: 'mrow', kids }
  if (tag === 'annotation' || tag === 'annotation-xml') return null
  if (tag === 'mrow') {
    kids = kids.flatMap((k) => ('tag' in k && k.tag === 'mrow' ? k.kids : [k]))
    if (kids.length === 1) return kids[0]
    if (kids.length === 0) return null
  }
  if (tag === 'mo' && kids.length === 1 && 't' in kids[0] && /^[⁡⁢⁣​]$/.test(kids[0].t)) return null
  if (tag === 'mspace') return null
  const attrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(node.attrs)) if (!DROP_ATTR.has(k)) attrs[k] = v
  return { tag, kids, ...(Object.keys(attrs).length ? { attrs } : {}) }
}

/** The <math> element of a rendered string, normalised — or null if none. */
export function mathTree(html: string): MNode | null {
  const el = parseMarkup(html)
  if (!el) return null
  const find = (r: Raw): Raw | null => (r.tag === 'math' ? r : r.kids.map((k) => (typeof k === 'string' ? null : find(k))).find(Boolean) ?? null)
  const m = find(el)
  return m ? norm(m) : null
}

/** A stable string key for equality. */
export const treeKey = (html: string): string | null => { const t = mathTree(html); return t ? JSON.stringify(t) : null }
