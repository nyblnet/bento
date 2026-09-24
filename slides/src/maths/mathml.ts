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
        // an operator straight after another operator (\nabla \cdot, - -) is
        // prefix in TeX's eyes — no left spacing; Temml marks it, so do we
        const prev = n.c[i - 1]
        const afterOp = c.k === 'sym' && c.cls === 'o' && '+−±∓⋅×∗'.includes(c.t) && prev?.k === 'sym' && prev.cls === 'o' && '+−±∓⋅×∗=<>≤≥≠∇∈'.includes(prev.t)
        parts.push(afterOp && c.k === 'sym' ? print({ ...c, prefix: true }, font) : print(c, font))
        const nxt = n.c[i + 1]
        if (nxt && isFn(c) && !(nxt.k === 'sym' && nxt.cls === 'o')) parts.push(nxt.k === 'fence' && !nxt.size ? '<mo>\u2061</mo>' : '<mo>\u2061</mo><mspace width="0.1667em"></mspace>')
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
      if (n.pad !== undefined) attrs.push(` lspace="${n.pad}" rspace="${n.rpad ?? n.pad}"`)
      if (n.prefix && !'([{)]}'.includes(n.t)) attrs.push(' form="prefix" stretchy="false"')
      if (n.t === '|' && n.pad !== undefined && !n.stretchy) attrs.push(' stretchy="false"')
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
    case 'space': return n.em < 0 ? `<mrow style="margin-left:${n.em}em;"></mrow>` : `<mspace width="${n.em}em"></mspace>`
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
        ? `<mo fence="true" form="${close ? 'postfix' : 'prefix'}" stretchy="true"${n.size ? ` minsize="${n.size}em" maxsize="${n.size}em"` : ''}>${esc(d)}</mo>`
        : `<mo fence="true" form="${close ? 'postfix' : 'prefix'}" stretchy="false">${esc(d)}</mo>`
      return `<mrow>${f(n.l, false)}${print(n.c, font)}${f(n.r, true)}</mrow>`
    }
    case 'table': {
      const cols = n.align ?? 'c'
      // MathML Core has no columnspacing: the gap between columns is padding
      // on the cells (Temml does the same, 0.5em a side, none at the edges)
      const ncol = Math.max(...n.rows.map((r) => r.length))
      // Temml's exact figure (an absolute 5.9776pt a side, not an em), so a
      // matrix on a slide keeps the width it has today
      // cases: 1em before the condition column; aligned: none (the & carries
      // the relation's own spacing); matrices: Temml's absolute 5.9776pt
      const pad = (i: number) => cols === 'll' ? `padding-left:${i === 0 ? '0' : '1'}em;padding-right:0em`
        : cols === 'rl' || cols === 's' || cols === 'd' ? 'padding-left:0em;padding-right:0em'
        : `padding-left:${i === 0 ? '0em' : '5.9776pt'};padding-right:${i === ncol - 1 ? '0em' : '5.9776pt'}`
      // centred cells say nothing (the default); left/right say so the way
      // Temml's tml-left/tml-right classes would with its stylesheet
      // Every column is CENTRED — cases and aligned included. TeX would
      // left/right-align them, and Temml asks for that through CSS classes;
      // but Bento never loads Temml's stylesheet, so every deck today renders
      // those columns centred, and the maintainer chose to keep that look
      // (2026-09-15): nothing moves on update. `al` still decides the padding.
      const body = n.rows.map((r) => `<mtr>${r.map((c, i) => `<mtd style="${pad(i)}">${print(c, font)}</mtd>`).join('')}</mtr>`).join('')
      // aligned/gather rows are display-style (Temml sets it on the table)
      const table = `<mtable${cols === 'rl' || cols === 'd' ? ' displaystyle="true"' : ''}>${body}</mtable>`
      return n.l || n.r ? `<mrow><mo fence="true" form="prefix" stretchy="true">${esc(n.l ?? '')}</mo>${table}<mo fence="true" form="postfix" stretchy="true">${esc(n.r ?? '')}</mo></mrow>` : table
    }
    case 'xarrow': {
      // Temml's spelling, so a deck keeps its look: the arrow stretches under
      // a label padded 0.4286em a side, over a 3.5em minimum, a thick space
      // either side of the whole
      const lab = (x: MNode, under: boolean) => `<${under ? 'munder' : 'mover'}><mrow><mspace width="0.4286em"></mspace>${print(x, font)}<mspace width="0.4286em"></mspace></mrow><mspace width="3.5em"></mspace></${under ? 'munder' : 'mover'}>`
      const arrow = `<mo stretchy="true" lspace="0em" rspace="0em">${esc(n.a)}</mo>`
      const body = n.over && n.under ? `<munderover>${arrow}${lab(n.under, true)}${lab(n.over, false)}</munderover>`
        : n.under ? `<munder>${arrow}${lab(n.under, true)}</munder>`
        : n.over ? `<mover>${arrow}${lab(n.over, false)}</mover>`
        : `<mover>${arrow}<mspace width="3.5em"></mspace></mover>`
      return `<mrow><mspace width="0.2778em"></mspace>${body}<mspace width="0.2778em"></mspace></mrow>`
    }
    case 'accent': {
      // math-depth:0 keeps the accent glyph at full size inside scripts — the
      // same spelling Temml uses, so a deck looks the way it does today
      // Temml keeps hats/bars/tildes at full size (math-depth:0) but lets the
      // arrow accents shrink to script size — matched, so \vec looks as today
      const full = n.stretchy || !/[→←]/.test(n.a)
      const acc = `<mo stretchy="${n.stretchy ? 'true' : 'false'}"${full ? ' style="math-depth:0"' : ''}>${esc(n.a)}</mo>`
      // no accent="true": Chrome then draws the glyph as a plain over-script
      // at math-depth 0, which is how Temml's output (and so every deck today)
      // looks; with the attribute the hat sits higher and larger
      return n.under ? `<munder>${print(n.b, font)}${acc}</munder>` : `<mover>${print(n.b, font)}${acc}</mover>`
    }
    case 'style': {
      const inner = print(n.c, n.font ?? font)
      const st: string[] = []
      // A colour reaches a style attribute, so it is the ONE place author text
      // could carry CSS. Only a colour shape passes: #hex, a colour word,
      // rgb()/hsl() of digits. Anything else (a `;`, `url(`, an expression) is
      // dropped and the text renders uncoloured rather than refused.
      if (n.color && isCssColor(n.color)) st.push(`color:${n.color}`)
      if (n.box) st.push('padding:3pt;border:1px solid')
      if (n.cancel) st.push('background:linear-gradient(to top right,transparent 47%,currentColor 47%,currentColor 53%,transparent 53%)')
      return st.length ? `<mrow style="${st.join(';')}">${inner}</mrow>` : inner
    }
  }
}

/** A CSS colour and nothing else: hex, a name, or rgb()/rgba()/hsl()/hsla()
 *  over numbers, percentages, commas, slashes and spaces. */
export const isCssColor = (c: string): boolean =>
  /^#[0-9a-f]{3,8}$/i.test(c) || /^[a-z]{3,20}$/i.test(c) || /^(rgba?|hsla?)\(\s*[\d.%,\s/]+\)$/i.test(c)

