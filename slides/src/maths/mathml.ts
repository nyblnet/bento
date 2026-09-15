// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — tree → MathML Core. The browser lays it out; we only say what
 * each box is. Font styles become Unicode code points (Chrome ignores
 * mathvariant on <mi>; Temml does the same). \boxed is a border, \textcolor
 * is mathcolor + style, \cancel is a background gradient line — the three
 * things MathML Core dropped that decks still ask for.
 */

import type { MNode, Font } from './ast.ts'
import { styledChar } from './symbols.ts'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// operators that TeX spaces as relations/binaries get lspace/rspace from the
// browser's operator dictionary — we emit plain <mo> and let it work. The one
// thing the dictionary cannot know is a fence we invented (\left.), so '' is
// an invisible mo with no width.

export function toMathML(n: MNode, display: boolean): string {
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}>${print(n, undefined)}</math>`
}

/** a function name, or a scripted function name (\sin^2, \lim_{…}) */
const isFn = (n: MNode): boolean => (n.k === 'sym' && n.cls === 'i' && !!n.fn) || (n.k === 'scr' && isFn(n.b))

function print(n: MNode, font: Font | undefined): string {
  switch (n.k) {
    case 'row': {
      if (n.c.length === 0) return '<mrow></mrow>'
      if (n.c.length === 1) return print(n.c[0], font)
      // TeX puts a thin space between a function name and its operand
      // (\sin x): function application + 3mu, the way Temml spells it too.
      const parts: string[] = []
      n.c.forEach((c, i) => {
        parts.push(print(c, font))
        const nxt = n.c[i + 1]
        if (nxt && isFn(c) && !(nxt.k === 'sym' && nxt.cls === 'o' && nxt.t !== '(')) parts.push('<mo>\u2061</mo><mspace width="0.1667em"></mspace>')
      })
      return `<mrow>${parts.join('')}</mrow>`
    }
    case 'sym': {
      if (n.cls === 'n') return `<mn>${esc(n.t)}</mn>`
      if (n.cls === 'i') {
        if (n.fn) return `<mi>${esc(n.t)}</mi>` // multi-letter mi is upright by MathML default
        const t = font && font !== 'rm' ? [...n.t].map((c) => styledChar(c, font)).join('') : n.t
        // a single-letter mi is italic by default; \mathrm asks for upright
        return font === 'rm' || n.up ? `<mi mathvariant="normal">${esc(t)}</mi>` : `<mi>${esc(t)}</mi>`
      }
      const attrs: string[] = []
      if (n.t === '′' || n.t === '″') attrs.push(' lspace="0em" rspace="0em"')
      // a bare "(" in the middle of a row would be inferred INFIX by MathML
      // Core and spaced like a binary operator; TeX treats it as an opening
      // fence. Temml spells this out per paren; so do we.
      if (!n.stretchy && '([{'.includes(n.t)) attrs.push(' fence="true" form="prefix" stretchy="false"')
      else if (!n.stretchy && ')]}'.includes(n.t)) attrs.push(' fence="true" form="postfix" stretchy="false"')
      if (n.stretchy) attrs.push(' stretchy="true"')
      if (n.size) attrs.push(` minsize="${n.size}em" maxsize="${n.size}em"`)
      if (n.big) attrs.push(' largeop="true"')
      return `<mo${attrs.join('')}>${esc(n.t)}</mo>`
    }
    // MathML trims an mtext's edge whitespace; \text{if } keeps its space
    // only as a no-break space (Temml does the same)
    case 'text': return `<mtext>${esc(n.t).replace(/ /g, '\u00a0')}</mtext>`
    case 'space': return `<mspace width="${n.em}em"></mspace>`
    case 'frac': {
      const inner = `<mfrac${n.nobar ? ' linethickness="0"' : ''}>${print(n.n, font)}${print(n.d, font)}</mfrac>`
      return n.display === undefined ? inner : `<mstyle displaystyle="${n.display}">${inner}</mstyle>`
    }
    case 'sqrt': return n.i ? `<mroot>${print(n.b, font)}${print(n.i, font)}</mroot>` : `<msqrt>${print(n.b, font)}</msqrt>`
    case 'scr': {
      const b = print(n.b, font), s = n.sub && print(n.sub, font), p = n.sup && print(n.sup, font)
      if (n.limits) return s && p ? `<munderover>${b}${s}${p}</munderover>` : s ? `<munder>${b}${s}</munder>` : `<mover>${b}${p}</mover>`
      return s && p ? `<msubsup>${b}${s}${p}</msubsup>` : s ? `<msub>${b}${s}</msub>` : `<msup>${b}${p}</msup>`
    }
    case 'fence': {
      // \left…\right / \big: stretchy, said out loud. A plain paren group
      // (Typst's, or LaTeX's when it needs an mrow): the bare-paren spelling.
      const f = (d: string, close: boolean) => n.explicit || n.size
        ? `<mo stretchy="true"${n.size ? ` minsize="${n.size}em" maxsize="${n.size}em"` : ''}>${esc(d)}</mo>`
        : `<mo fence="true" form="${close ? 'postfix' : 'prefix'}" stretchy="false">${esc(d)}</mo>`
      return `<mrow>${f(n.l, false)}${print(n.c, font)}${f(n.r, true)}</mrow>`
    }
    case 'table': {
      const cols = n.align ?? 'c'
      const al = (i: number) => ({ l: 'left', r: 'right', c: 'center' } as Record<string, string>)[cols[Math.min(i, cols.length - 1)]] ?? 'center'
      // MathML Core has no columnspacing: the gap between columns is padding
      // on the cells (Temml does the same, 0.5em a side, none at the edges)
      const ncol = Math.max(...n.rows.map((r) => r.length))
      // Temml's exact figure (an absolute 5.9776pt a side, not an em), so a
      // matrix on a slide keeps the width it has today
      const pad = (i: number) => `padding-left:${i === 0 ? '0em' : '5.9776pt'};padding-right:${i === ncol - 1 ? '0em' : '5.9776pt'}`
      const body = n.rows.map((r) => `<mtr>${r.map((c, i) => `<mtd style="text-align:${al(i)};${pad(i)}">${print(c, font)}</mtd>`).join('')}</mtr>`).join('')
      const table = `<mtable>${body}</mtable>`
      return n.l || n.r ? `<mrow><mo stretchy="true">${esc(n.l ?? '')}</mo>${table}<mo stretchy="true">${esc(n.r ?? '')}</mo></mrow>` : table
    }
    case 'accent': {
      // math-depth:0 keeps the accent glyph at full size inside scripts — the
      // same spelling Temml uses, so a deck looks the way it does today
      const acc = `<mo stretchy="${n.stretchy ? 'true' : 'false'}" style="math-depth:0">${esc(n.a)}</mo>`
      // no accent="true": Chrome then draws the glyph as a plain over-script
      // at math-depth 0, which is how Temml's output (and so every deck today)
      // looks; with the attribute the hat sits higher and larger
      return n.under ? `<munder>${print(n.b, font)}${acc}</munder>` : `<mover>${print(n.b, font)}${acc}</mover>`
    }
    case 'style': {
      const inner = print(n.c, n.font ?? font)
      const st: string[] = []
      if (n.color) st.push(`color:${n.color}`)
      if (n.box) st.push('border:0.06em solid currentColor;padding:0.2em 0.3em')
      if (n.cancel) st.push('background:linear-gradient(to top right,transparent 47%,currentColor 47%,currentColor 53%,transparent 53%)')
      return st.length ? `<mrow style="${st.join(';')}">${inner}</mrow>` : inner
    }
  }
}
