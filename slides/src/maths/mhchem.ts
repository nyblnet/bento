// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — mhchem's \ce{…} and \pu{…}, rewritten to LaTeX the parser
 * already reads (#551). Not the whole of mhchem (Temml's is a 1,500-line
 * state machine): the notation a slide about chemistry uses —
 *
 *   formulas      H2O, SO4^2-, Fe^3+, NH4+, (NH4)2SO4, [Cu(NH3)4]^2+
 *   coefficients  2H2 + O2, 1/2 O2
 *   states        H2O(l), NaCl(aq), CO2(g), s/l/g/aq/cr
 *   hydrates      CuSO4.5H2O, CuSO4*5H2O
 *   arrows        ->  <-  <->  <=>  <=>>  <<=>, with labels ->[heat][-H2O]
 *   gas, solid    ^ and v standing alone
 *   bonds         C-C  C=C  C#C
 *   electrons     e-
 *   maths         $…$ passes through
 *
 * and \pu{1.2e3 kJ/mol}: a number (with an exponent) and units, upright,
 * a thin space between. Anything it does not recognise passes through as
 * upright text, so an exotic formula still reads.
 */

const ARROWS: Record<string, string> = { '->': 'rightarrow', '<-': 'leftarrow', '<->': 'leftrightarrow', '<=>': 'rightleftharpoons', '<=>>': 'rightleftharpoons', '<<=>': 'rightleftharpoons', '<-->': 'leftrightarrows' }
const ARROW = /^(<=>>|<<=>|<-->|<=>|<->|->|<-)((?:\[[^\]]*\])*)$/

/** a label on an arrow: chemistry, unless it is $maths$ or already LaTeX */
const label = (s: string) => (s.startsWith('$') && s.endsWith('$') ? s.slice(1, -1) : s.includes('\\') ? s : ceToTex(s))
/** the labelled form of each arrow: they stretch to the label */
const X_ARROWS: Record<string, string> = { rightarrow: 'xrightarrow', leftarrow: 'xleftarrow', leftrightarrow: 'xleftrightarrow', rightleftharpoons: 'xrightleftharpoons', leftrightarrows: 'xtofrom' }

function arrow(tok: string): string {
  const m = ARROW.exec(tok)!
  const [over, under] = [...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1])
  const a = ARROWS[m[1]]
  if (!over && !under) return `\\${a}`
  return `\\${X_ARROWS[a]}${under ? `[${label(under)}]` : ''}{${over ? label(over) : ''}}`
}

/** one species: 2H2O(l), SO4^2-, [Cu(NH3)4]^2+, CuSO4.5H2O, e- */
function species(t: string): string {
  let out = ''
  let i = 0
  // a leading coefficient: 2, 1/2, 0.5, n
  const coef = /^(\d+\/\d+|\d*\.\d+|\d+|[a-z](?=[A-Z(\[]))/.exec(t)
  if (coef && coef[0].length < t.length) { out += coef[0].includes('/') ? `\\frac{${coef[0].replace('/', '}{')}}` : coef[0]; i = coef[0].length }
  let prevAtom = false
  while (i < t.length) {
    const rest = t.slice(i)
    let m: RegExpExecArray | null
    if ((m = /^\$([^$]*)\$/.exec(rest))) { out += m[1]; i += m[0].length; prevAtom = true; continue }
    // a state symbol in parentheses: (s) (l) (g) (aq) (cr)
    if ((m = /^\((s|l|g|aq|cr|sln|ads)\)/.exec(rest))) { out += `\\mathrm{(${m[1]})}`; i += m[0].length; prevAtom = false; continue }
    if ((m = /^[A-Z][a-z]*/.exec(rest)) || (!prevAtom && (m = /^[a-z]+/.exec(rest)))) { out += `\\mathrm{${m[0]}}`; i += m[0].length; prevAtom = true; continue }
    // subscript count after an atom or a closing bracket; any other count
    // (after a hydrate dot: CuSO4.5H2O) is a coefficient
    if ((m = /^\d+/.exec(rest))) { out += prevAtom ? `_{${m[0]}}` : m[0]; i += m[0].length; continue }
    // a charge: ^2-, ^{3+}, ^+ — or a bare trailing + or - (Na+, Cl-, SO4^2-)
    if ((m = /^\^\{?([0-9]*[+-]|[0-9]+|[+-])\}?/.exec(rest))) { out += `^{${m[1]}}`; i += m[0].length; prevAtom = false; continue }
    if (prevAtom && (m = /^([0-9]*[+-])$/.exec(rest))) { out += `^{${m[1]}}`; i += m[0].length; continue }
    const c = t[i]
    if (c === '(' || c === '[') { out += c; i++; prevAtom = false; continue }
    if (c === ')' || c === ']') { out += c; i++; prevAtom = true; continue }
    // hydrate dot, bonds
    if (c === '.' || c === '*') { out += '\\cdot '; i++; prevAtom = false; continue }
    if (c === '-') { out += '{-}'; i++; prevAtom = false; continue }
    if (c === '=') { out += '{=}'; i++; prevAtom = false; continue }
    if (c === '#') { out += '{\\equiv}'; i++; prevAtom = false; continue }
    out += `\\text{${c}}`; i++; prevAtom = false
  }
  return out
}

/** \ce{…} → LaTeX */
export function ceToTex(src: string): string {
  // arrows need no spaces around them in mhchem: give them some
  const spaced = src.replace(/(<=>>|<<=>|<-->|<=>|<->|->|<-)((?:\[[^\]]*\])*)/g, ' $1$2 ').trim()
  // split on spaces, but never inside a [label] or {group}: ->[heat up]
  return (spaced.match(/(?:\[[^\]]*\]|\{[^}]*\}|\S)+/g) ?? []).map((tok) => {
    if (ARROW.test(tok)) return arrow(tok)
    if (tok === '+') return '+'
    if (tok === '^') return '\\uparrow'
    if (tok === 'v') return '\\downarrow'
    if (tok === '=') return '='
    return species(tok)
  }).join(' ')
}

/** \pu{…} → LaTeX: 1.2e3 kJ/mol, 25 °C, 9.81 m s^-2 */
export function puToTex(src: string): string {
  const m = /^\s*(-?[\d.,]+)(?:\s*[eE](-?\d+))?\s*(.*)$/.exec(src)
  const num = m ? m[1] + (m[2] ? `\\times 10^{${m[2]}}` : '') : ''
  const unit = (m ? m[3] : src).trim()
  if (!unit) return num
  // letters first: the commands inserted after (\cdot, \mathord) must not
  // themselves be wrapped in \mathrm
  const u = unit.split(/\s+/).map((w) => w
    .replace(/([A-Za-zµμΩ°]+)/g, '\\mathrm{$1}')
    .replace(/[.*]/g, '\\cdot ')
    .replace(/\//g, '\\mathord{/}')
    .replace(/\^\{?(-?\d+)\}?/g, '^{$1}')).join('\\,')
  return num ? `${num}\\,${u}` : u
}
