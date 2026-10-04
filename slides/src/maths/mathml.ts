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

// ARROWS CHROME WILL NOT STRETCH, DRAWN (#551). Measured in Chrome 153 on
// macOS with every maths font: ← ⇐ ⇒ ⇔ ↤ ↩ ↪ and the harpoons stretch to a
// label as MathML asks; → ↦ ↔ ↠ ↞ = ⇌ ⇋ ⇄ never do, whatever the form, font
// or script element, so \xrightarrow{a long label} drew a short arrow under
// a long label. Mirroring a stretched ← lost its head; a harpoon pair
// misplaced its barb. So these are an inline SVG: lines at 0…100% of a box
// the layout sizes (a table column for \x…arrow, the base for an accent),
// heads in a nested svg pinned at 0% or 100% so they never distort, all in
// em so they follow the text size. role="img" + aria-label keep the arrow
// the author wrote for assistive tech. The ones Chrome stretches stay glyphs.
type Head = [side: 'l' | 'r', dy: number, kind: 'f' | 'u' | 'd', dx: number]
const DRAWN: Record<string, { lines: number[]; heads: Head[]; bar?: boolean }> = {
  '→': { lines: [0], heads: [['r', 0, 'f', 0]] },
  '↦': { lines: [0], heads: [['r', 0, 'f', 0]], bar: true },
  '↔': { lines: [0], heads: [['r', 0, 'f', 0], ['l', 0, 'f', 0]] },
  '↠': { lines: [0], heads: [['r', 0, 'f', 0], ['r', 0, 'f', -0.25]] },
  '↞': { lines: [0], heads: [['l', 0, 'f', 0], ['l', 0, 'f', 0.25]] },
  '=': { lines: [-0.1, 0.1], heads: [] },
  '⇌': { lines: [-0.12, 0.12], heads: [['r', -0.12, 'u', 0], ['l', 0.12, 'd', 0]] },
  '⇋': { lines: [-0.12, 0.12], heads: [['l', -0.12, 'u', 0], ['r', 0.12, 'd', 0]] },
  '⇄': { lines: [-0.14, 0.14], heads: [['r', -0.14, 'f', 0], ['l', 0.14, 'f', 0]] },
}
/** the arrow as svg filling its (positioned) box; `s` = head size in em */
function arrowSvg(a: string, s: number, stroke: number): string {
  const spec = DRAWN[a]
  const sw = ` stroke="currentColor" stroke-width="${stroke}em" fill="none" stroke-linecap="round"`
  const hw = ` stroke="currentColor" stroke-width="${+(stroke / s * 10).toFixed(2)}" fill="none" stroke-linecap="round"`
  // a head: tip at (0,5) of a 10-unit box, barbs back toward the line
  const path = (side: string, kind: string) => { const b = side === 'r' ? -9 : 9, c = side === 'r' ? -2 : 2
    return `${kind !== 'd' ? `M${b},0.5 Q${c},4.6 0,5` : 'M0,5'}${kind !== 'u' ? ` Q${c},5.4 ${b},9.5` : ''}` }
  const at = (x: string, dy: number, dx: number, d: string) => `<svg x="${x}" y="50%" overflow="visible"><svg x="${dx}em" y="${+(dy - s / 2).toFixed(3)}em" width="${s}em" height="${s}em" viewBox="0 0 10 10" overflow="visible"><path d="${d}"${hw}></path></svg></svg>`
  return `<svg role="img" aria-label="${esc(a)}" style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible">`
    + spec.lines.map((dy) => `<svg y="50%" overflow="visible"><line x1="0" x2="100%" y1="${dy}em" y2="${dy}em"${sw}></line></svg>`).join('')
    + spec.heads.map(([side, dy, kind, dx]) => at(side === 'r' ? '100%' : '0', dy, dx, path(side, kind))).join('')
    + (spec.bar ? at('0', 0, 0, 'M0,1 L0,9') : '') + '</svg>'
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
      // a bare | or ‖ never grows (#551): beside a cases block the first bar
      // of |x| stretched to the block's height. Temml draws a typed | as an
      // ordinary symbol and \lvert as a non-stretchy fence — same result
      if ((n.t === '|' || n.t === '‖') && !n.stretchy) attrs.push(' stretchy="false"')
      // a bare "(" in the middle of a row would be inferred INFIX by MathML
      // Core and spaced like a binary operator; TeX treats it as an opening
      // fence. Temml spells this out per paren; so do we.
      // (⟨ ⌊ ⌈ too, #551: an unpaired \langle beside a tall fraction grew to
      // the whole row's height — Temml says stretchy="false" for these)
      if (!n.stretchy && '([{⟨⌊⌈'.includes(n.t)) attrs.push(' fence="true" form="prefix" stretchy="false"')
      else if (!n.stretchy && ')]}⟩⌋⌉'.includes(n.t)) attrs.push(' fence="true" form="postfix" stretchy="false"')
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
      if (n.level) return `<mstyle displaystyle="false" scriptlevel="${n.level}">${inner}</mstyle>`
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
      // Column alignment, the way TeX sets it (#551): aligned is right then
      // left so the relations line up, cases and rcases are left, a starred
      // matrix or an array says per column. Temml asks for the same through
      // its tml-left/tml-right classes, but Bento never loaded Temml's
      // stylesheet, so until #551 every column rendered centred — the
      // 2026-09-15 choice to keep that look was reversed by the maintainer
      // (docs/DECISIONS.md, 2026-09-24): an `&=` that does not line up is a
      // bug to the person who typed it. Centred cells say nothing.
      // HOW, measured in Chrome 153: an mtd ignores text-align:left/right/
      // center/end (every one lays out at the start edge) and honours only
      // the -webkit- keywords — Chrome's own UA sheet centres cells with
      // -webkit-center. So the style says -webkit-left/right, and the MathML
      // columnalign attribute says it for engines that read that instead.
      const colOf = (i: number) => (n.cols ? n.cols[Math.min(i, n.cols.length - 1)] : 'c')
      const cell = (i: number) => { const c = colOf(i); return c === 'l' || c === 'r' ? ` columnalign="${c === 'l' ? 'left' : 'right'}" style="text-align:-webkit-${c === 'l' ? 'left' : 'right'};` : ' style="' }
      // Rules (#551), as Temml draws them — plain cell borders, which is why
      // they showed in Bento before 1.2.0 without Temml's stylesheet: a column
      // rule on the right of the column before it (the left of the first), a
      // row rule on the bottom of the row above it (the top of the first).
      const RULE: Record<string, string> = { solid: '0.06em solid', dashed: '0.06em dashed', double: '0.15em double' }
      const rules = (r: number, i: number) => {
        const out: string[] = []
        if (r === 0 && n.hlines?.[0]) out.push(`border-top:${RULE[n.hlines[0]]}`)
        if (n.hlines?.[r + 1]) out.push(`border-bottom:${RULE[n.hlines[r + 1]]}`)
        if (i === 0 && n.vlines?.[0]) out.push(`border-left:${RULE[n.vlines[0]]}`)
        if (n.vlines?.[i + 1]) out.push(`border-right:${RULE[n.vlines[i + 1]]}`)
        return out.length ? ';' + out.join(';') : ''
      }
      const body = n.rows.map((r, ri) => `<mtr>${r.map((c, i) => `<mtd${cell(i)}${pad(i)}${rules(ri, i)}">${print(c, font)}</mtd>`).join('')}</mtr>`).join('')
      // aligned/gather rows are display-style (Temml sets it on the table)
      const table = `<mtable${cols === 'rl' || cols === 'd' || n.display ? ' displaystyle="true"' : ''}>${body}</mtable>`
      return n.l || n.r ? `<mrow><mo fence="true" form="prefix" stretchy="true">${esc(n.l ?? '')}</mo>${table}<mo fence="true" form="postfix" stretchy="true">${esc(n.r ?? '')}</mo></mrow>` : table
    }
    case 'xarrow': {
      // Temml's spelling, so a deck keeps its look: the arrow stretches under
      // a label padded 0.4286em a side, over a 3.5em minimum, a thick space
      // either side of the whole
      if (DRAWN[n.a]) {
        // one column, three rows: over label | the drawn arrow | under label.
        // The column is as wide as the wider label (3.5em at least) and the
        // svg fills its cell. Each label row carries an invisible copy of the
        // other label, so the two rows are the same height and the arrow row
        // sits on the math axis — where the table is centred — like an mo.
        // labels at script size, as an over/under script would be
        const text = (x?: MNode) => (x ? `<mrow scriptlevel="1" displaystyle="false"><mspace width="0.4286em"></mspace>${print(x, font)}<mspace width="0.4286em"></mspace></mrow>` : '')
        const ghost = (x?: MNode) => (x ? `<mpadded width="0px"><mphantom>${text(x)}</mphantom></mpadded>` : '')
        const td = '<mtd style="padding:0">'
        return `<mrow><mspace width="0.2778em"></mspace><mtable><mtr>${td}${text(n.over)}${ghost(n.under)}</mtd></mtr>`
          + `<mtr><mtd style="padding:0;position:relative;min-width:3.5em;height:0.6em"><mtext>${arrowSvg(n.a, 0.5, 0.055)}</mtext></mtd></mtr>`
          + `<mtr>${td}${text(n.under)}${ghost(n.over)}</mtd></mtr></mtable><mspace width="0.2778em"></mspace></mrow>`
      }
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
      // a stretchy accent Chrome will not stretch (\overrightarrow): the base,
      // padded above (or below), with the drawn arrow absolutely over that
      // padding at the base's full width; the baseline never moves
      if (n.stretchy && DRAWN[n.a]) {
        const edge = n.under ? 'bottom' : 'top'
        return `<mrow style="position:relative;padding-${edge}:0.5em">${print(n.b, font)}<mtext style="position:absolute;left:0;${edge}:0;width:100%;height:0.45em">${arrowSvg(n.a, 0.36, 0.045)}</mtext></mrow>`
      }
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
      const line = (dir: string) => `linear-gradient(${dir},transparent 47%,currentColor 47%,currentColor 53%,transparent 53%)`
      if (n.cancel) st.push(`background:${n.cancel === 'down' ? line('to bottom right') : n.cancel === 'x' ? line('to top right') + ',' + line('to bottom right') : n.cancel === 'h' ? line('to bottom') : line('to top right')}`)
      if (n.size) st.push(`font-size:${n.size}em`)
      if (n.bold) st.push('font-weight:bold')
      if (n.bg && isCssColor(n.bg)) st.push(`background-color:${n.bg};padding:0.3em`)
      if (n.frame && isCssColor(n.frame)) st.push(`border:0.0667em solid ${n.frame}`)
      if (n.rule === 'angl') st.push('border-top:0.065em solid;border-right:0.065em solid;padding:0.1em 0.12em 0 0.1em')
      if (n.rule === 'top') st.push('border-top:0.065em solid;padding-top:0.1em')
      if (n.mirror) st.push('transform:scaleX(-1)')
      return st.length ? `<mrow style="${st.join(';')}">${inner}</mrow>` : inner
    }
    case 'pad': {
      // Temml's spelling (mpadded; mphantom for the phantoms). The laps take
      // no width and shift their content with a transform, the one way to
      // say "-100% of my own width" in MathML Core (lspace="-1width" is not)
      const inner = n.phantom ? `<mphantom>${print(n.c, font)}</mphantom>` : print(n.c, font)
      if (n.lap) return `<mpadded width="0px">${n.lap === 'r' ? inner : `<mrow style="transform:translateX(${n.lap === 'l' ? '-100%' : '-50%'})">${inner}</mrow>`}</mpadded>`
      return `<mpadded${n.w0 ? ' width="0px"' : ''}${n.h0 ? ' height="0px"' : ''}${n.d0 ? ' depth="0px"' : ''}>${inner}</mpadded>`
    }
    case 'multi': {
      const x = (m?: MNode) => (m ? print(m, font) : '<none></none>')
      return `<mmultiscripts>${print(n.b, font)}${x(n.sub)}${x(n.sup)}<mprescripts></mprescripts>${x(n.presub)}${x(n.presup)}</mmultiscripts>`
    }
    case 'bond': {
      // Temml's construction, in the text colour instead of black (a bond
      // must read on a dark slide): 0.06em rules, dashes 0.15em apart 0.1111em,
      // raised with voffset, stacked by zero-width overlays
      const dash = (w: number) => `<mspace width="${w}em" height="0.06em" style="background:currentColor"></mspace>`
      const gap = (w: number) => `<mspace width="${w}em"></mspace>`
      const tri = `<mrow>${dash(0.15)}${gap(0.1111)}${dash(0.15)}${gap(0.1111)}${dash(0.15)}</mrow>`
      const line = dash(0.672)
      const up = (x: string, v: number) => `<mpadded voffset="${v}em" style="padding-top:${v}em">${x}</mpadded>`
      const over = (x: string) => `<mpadded width="0px">${x}</mpadded>`
      const body: Record<string, string> = {
        uniDash: line, triDash: tri, tripleDash: up(tri, 0.25),
        tripleDashOverLine: over(up(line, 0.125)) + up(tri, 0.34),
        tripleDashOverDoubleLine: over(`<mrow>${over(up(tri, 0.48))}${up(line, 0.27)}</mrow>`) + up(line, 0.05),
        tripleDashBetweenDoubleLine: over(`<mrow>${over(up(line, 0.48))}${up(tri, 0.27)}</mrow>`) + up(line, 0.05),
      }
      return n.kind === 'uniDash' || n.kind === 'triDash' ? body[n.kind] : `<mrow>${gap(0.075)}${body[n.kind]}${gap(0.075)}</mrow>`
    }
    case 'unknown': {
      // the command's own name, in a warning colour: the audience sees the
      // formula with one word they can read, not a wall of raw LaTeX
      return `<mtext mathcolor="#D14343" class="bento-math-unknown">${esc(n.t)}</mtext>`
    }
  }
}

/** A CSS colour and nothing else: hex, a name, or rgb()/rgba()/hsl()/hsla()
 *  over numbers, percentages, commas, slashes and spaces. */
export const isCssColor = (c: string): boolean =>
  /^#[0-9a-f]{3,8}$/i.test(c) || /^[a-z]{3,20}$/i.test(c) || /^(rgba?|hsla?)\(\s*[\d.%,\s/]+\)$/i.test(c)

