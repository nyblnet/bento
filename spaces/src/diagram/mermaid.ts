// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Mermaid flowcharts ⇄ an editable diagram made of slides' own elements:
// shape nodes, text labels, and line/path connectors whose ends are anchored
// with slides' `from`/`to` ConnectorEnd refs (syncConnectors keeps them
// attached afterwards). Pure and DOM-free, with zero app imports, so slides can
// import it too — a kernel candidate, beside the connector engine.
//
// The official mermaid library is megabytes and nothing may be fetched at
// runtime (PLATFORM §1), so this is our own reading of the flowchart grammar:
//
//   mermaidToDiagram(src, {w, h}) → {elements, warnings, ast}
//   diagramToMermaid(elements)    → {src, lost}
//
// LOSSY BOTH WAYS, and exactly how:
//   · mermaid → elements INVENTS positions (layout.ts). The `layout` sidecar
//     ({id: {x,y,w,h}}, from diagramLayout) makes hand-placed positions win.
//   · elements → mermaid drops positions and sizes (keep the sidecar for
//     those), edge length (`--->`), and whatever `lost` lists per element:
//     rotation, opacity, gradients, shadows, rich text, tips mermaid cannot
//     draw, edge colour, free text, and element types mermaid has no word for.
//   · labels are TEXT. `<br>` is a line break; every other tag stays literal
//     and inert, so a label can never become markup (mermaid would render
//     `<b>`; we show it). Output escapes `<`/`>` so GitHub agrees with us.
//   · slides has no edge labels; an edge label is a text element beside the
//     edge's middle, and it does not follow the edge when nodes move.

import { layout, type Box, type Dir, type Pt, type LEdge } from './layout.ts'

// --- slides' element shapes (structural copies of slides/src/model.ts) -------

export type Tip = 'none' | 'arrow' | 'dot' | 'bar' | 'arrow-open' | 'triangle' | 'triangle-open' | 'diamond' | 'diamond-open' | 'square' | 'circle-open'
export interface ConnectorEnd { el: string; side?: 'auto' | 'top' | 'right' | 'bottom' | 'left' }
interface Base { id: string; x: number; y: number; w: number; h: number; rotation: number; opacity: number; groupId?: string; role?: string }
export interface DShape extends Base {
  type: 'shape'
  shape: 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'
  fill: string
  stroke: string
  strokeWidth: number
  radius: number
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  lineStart?: Tip
  lineEnd?: Tip
  d?: string
  pathBox?: [number, number, number, number]
  from?: ConnectorEnd
  to?: ConnectorEnd
}
export interface DText extends Base {
  type: 'text'
  html: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
}
export type DElement = DShape | DText

// --- the AST ------------------------------------------------------------------

export type NodeShape = 'rect' | 'round' | 'stadium' | 'subroutine' | 'cylinder' | 'circle' | 'dblcircle' | 'diamond' | 'hexagon' | 'lean-r' | 'lean-l' | 'trap-b' | 'trap-t' | 'odd' | 'tri'
export type Head = 'none' | 'arrow' | 'circle' | 'cross'
export interface MStyle { fill?: string; stroke?: string; color?: string }
export interface MNode { id: string; label: string; shape: NodeShape; classes: string[]; style: MStyle; parent: string | null }
export interface MEdge { from: string; to: string; label: string; start: Head; end: Head; stroke: 'normal' | 'thick' | 'dotted' | 'invisible'; len: number }
export interface MSubgraph { id: string; label: string; parent: string | null; dir?: Dir; style: MStyle; classes: string[] }
export interface FlowAST { dir: Dir; nodes: MNode[]; edges: MEdge[]; subgraphs: MSubgraph[] }

/** Caps. Past them the rest is dropped WITH a warning — never a hang. */
export const LIMITS = { nodes: 500, edges: 2000, depth: 24, labelLines: 12, warnings: 40, dummies: 12000 }

const DIRS: Record<string, Dir> = { TD: 'TB', TB: 'TB', BT: 'BT', LR: 'LR', RL: 'RL' }

// `(((`…`)))` must be tried before `((`…`))` before `(`…`)`: longest opener first.
// A null closer means "either slash" — `[/ /]` vs `[/ \]` is decided by the end.
const OPEN: Array<[string, string | null, NodeShape]> = [
  ['(((', ')))', 'dblcircle'], ['((', '))', 'circle'], ['([', '])', 'stadium'], ['[[', ']]', 'subroutine'],
  ['[(', ')]', 'cylinder'], ['{{', '}}', 'hexagon'], ['[/', null, 'lean-r'], ['[\\', null, 'lean-l'],
  ['{', '}', 'diamond'], ['(', ')', 'round'], ['[', ']', 'rect'], ['>', ']', 'odd'],
]
// mermaid v11 `A@{ shape: … }` names → ours
const V11: Record<string, NodeShape> = { __proto__: null as never,
  rounded: 'round', subproc: 'subroutine', 'fr-rect': 'subroutine', cyl: 'cylinder', database: 'cylinder', circ: 'circle', 'dbl-circ': 'dblcircle',
  diam: 'diamond', decision: 'diamond', hex: 'hexagon', triangle: 'tri', proc: 'rect', process: 'rect',
}
// Named colours are accepted by SHAPE — letters only — rather than from a
// 148-name list: a name can carry nothing but a colour, and a name the
// browser does not know paints as the attribute's default, not as anything else.
const NAMED = /^[a-z]{3,24}$/i
const NUM = String.raw`\s*-?[\d.]+(?:%|deg)?\s*`
const FN = new RegExp(`^(rgba?|hsla?)\\(${NUM}[,\\s]${NUM}[,\\s]${NUM}(?:[,/]${NUM})?\\)$`, 'i')

/** A colour we are willing to write into an element, or null. */
export function validColor(v: string): string | null {
  v = v.trim().replace(/\s*!important$/i, '')
  return /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(v) || FN.test(v) || NAMED.test(v) ? v : null
}

const ENT: Record<string, string> = { __proto__: null as never, quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ', semi: ';', colon: ':', hash: '#', num: '#' }
const cp = (n: number, m: string) => (n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m)
/** Mermaid label text → plain text. `<br>` is the only tag with a meaning. */
function decode(s: string): string {
  s = s.trim()
  if (s.length > 1 && s[0] === '"' && s.endsWith('"')) s = s.slice(1, -1)
  if (s.length > 1 && s[0] === '`' && s.endsWith('`')) s = s.slice(1, -1)
  return s
    .replace(/\bfa[bklrs]?:fa-[\w-]+\s?/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/#(\w+);/g, (m, n) => (/^\d+$/.test(n) ? cp(+n, m) : ENT[n] ?? m))
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, n: string) =>
      n[0] === '#' ? cp(n[1] === 'x' || n[1] === 'X' ? parseInt(n.slice(2), 16) : +n.slice(1), m) : ENT[n.toLowerCase()] ?? m)
}

// --- the parser ---------------------------------------------------------------

/** Parse a Mermaid flowchart. Never throws: what it cannot read is a warning. */
export function parseMermaid(src: string): { ast: FlowAST; warnings: string[] } {
  const warnings: string[] = []
  let dropped = 0
  const warn = (line: number, msg: string) => {
    const w = line ? `line ${line}: ${msg}` : msg
    if (warnings.length < LIMITS.warnings) { if (!warnings.includes(w)) warnings.push(w) } else dropped++
  }
  const no = (line: number, what: string) => warn(line, what + ' unsupported')
  const ast: FlowAST = { dir: 'TB', nodes: [], edges: [], subgraphs: [] }
  const nodes = new Map<string, MNode>()
  const subs = new Map<string, MSubgraph>()
  const classDefs = new Map<string, MStyle>()
  const stack: MSubgraph[] = []
  let created: string[] = []
  let header = false, skipUntil: RegExp | null = null, overDepth = 0

  const node = (id: string): MNode | null => {
    let n = nodes.get(id)
    if (!n) {
      if (nodes.size >= LIMITS.nodes) { warn(0, `over ${LIMITS.nodes} nodes, rest dropped`); return null }
      n = { id, label: id, shape: 'rect', classes: [], style: {}, parent: null }
      nodes.set(id, n)
      created.push(id)
    }
    // a node belongs to the first subgraph that mentions it
    if (!n.parent && stack.length) n.parent = stack[stack.length - 1].id
    return n
  }
  const props = (line: number, s: string): MStyle => {
    const st: MStyle = {}
    for (const part of s.split(/[,;](?![^(]*\))/)) {
      const m = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(part)
      if (!m) continue
      const k = m[1].toLowerCase()
      if (k !== 'fill' && k !== 'stroke' && k !== 'color') { no(0, `style ${k}`); continue }
      const c = validColor(m[2])
      if (c) st[k] = c
      else warn(line, `bad colour ${m[2].slice(0, 40)}`)
    }
    return st
  }

  // statements: newlines, and `;` outside quotes and brackets; `%%` comments
  const stmts: Array<[number, string]> = []
  {
    let cur = '', q = false, depth = 0, line = 1, startLine = 1
    const flush = () => { if (cur.trim()) stmts.push([startLine, cur.trim()]); cur = '' }
    for (let i = 0; i < src.length; i++) {
      const c = src[i]
      if (c === '\n') {
        line++
        if (q) { cur += c; continue }
        depth = 0; flush(); startLine = line; continue
      }
      if (!q && c === '%' && src[i + 1] === '%') {
        if (src[i + 2] === '{') no(line, '%%{directive}%%')
        while (i < src.length && src[i + 1] !== '\n') i++
        continue
      }
      if (c === '"') q = !q && src.indexOf('"', i + 1) > 0
      else if (!q) {
        if ('[({'.includes(c)) depth++
        else if (')]}'.includes(c)) depth = Math.max(0, depth - 1)
        else if (c === ';' && !depth) { flush(); continue }
      }
      cur += c
    }
    flush()
  }

  let front = false
  for (const [ln, s] of stmts) {
    if (skipUntil) { if (skipUntil.test(s)) skipUntil = null; continue }
    if (!header) {
      if (s === '---') { front = !front; continue }
      if (front) { if (/^title\s*:/.test(s)) no(ln, 'title'); continue }
      const h = /^(flowchart(?:-elk)?|graph)\b\s*(\w+)?\s*$/i.exec(s)
      if (!h) {
        no(ln, `diagram "${s.split(/\s/)[0].slice(0, 30)}" (only flowchart/graph)`)
        return { ast, warnings }
      }
      header = true
      if (h[2]) {
        const d = DIRS[h[2].toUpperCase()]
        if (d) ast.dir = d
        else warn(ln, `bad direction ${h[2]}`)
      }
      continue
    }
    const kw = /^(\w+)\b\s*(.*)$/.exec(s)
    const k = kw?.[1], rest = kw?.[2] ?? ''
    if (k === 'subgraph') {
      if (stack.length >= LIMITS.depth) { overDepth++; warn(ln, `subgraphs deeper than ${LIMITS.depth} flattened`); continue }
      let id: string, label: string
      const m = /^([^\s[\]"]+)\s*\[(.*)\]\s*$/.exec(rest)
      if (m) { id = m[1]; label = decode(m[2]) }
      else { label = decode(rest); id = /^[^\s"]+$/.test(rest) ? rest : label || `subgraph${subs.size + 1}` }
      if (subs.has(id)) { warn(ln, `duplicate subgraph ${id}`); id = `${id}_${subs.size + 1}` }
      const sg: MSubgraph = { id, label, parent: stack.length ? stack[stack.length - 1].id : null, style: {}, classes: [] }
      subs.set(id, sg)
      ast.subgraphs.push(sg)
      stack.push(sg)
      continue
    }
    if (k === 'end' && !rest) { if (overDepth) overDepth--; else if (stack.pop() === undefined) warn(ln, 'stray end'); continue }
    if (k === 'direction') {
      const d = DIRS[rest.toUpperCase()]
      if (!d) warn(ln, `bad direction ${rest}`)
      else if (stack.length) stack[stack.length - 1].dir = d
      else ast.dir = d
      continue
    }
    if (k === 'classDef') {
      const m = /^(\S+)\s+(.*)$/.exec(rest)
      if (m) { const st = props(ln, m[2]); for (const c of m[1].split(',')) classDefs.set(c, st) }
      continue
    }
    if (k === 'class') {
      const m = /^(\S+)\s+([\w-]+)\s*$/.exec(rest)
      if (m) for (const id of m[1].split(',')) (subs.get(id) ?? node(id))?.classes.push(m[2])
      continue
    }
    if (k === 'style') {
      const m = /^(\S+)\s+(.*)$/.exec(rest)
      if (m) { const t = subs.get(m[1]) ?? node(m[1]); if (t) Object.assign(t.style, props(ln, m[2])) }
      continue
    }
    if (k === 'linkStyle') { no(ln, k); continue }
    if (k === 'click' || k === 'href' || k === 'call') { no(0, 'click'); continue }
    if (k === 'accTitle' || k === 'accDescr') {
      if (/^\s*\{/.test(rest) && !rest.includes('}')) skipUntil = /\}/
      no(ln, k)
      continue
    }
    // a statement lands whole or not at all
    const e0 = ast.edges.length
    created = []
    if (!chain(ln, s)) {
      ast.edges.length = e0
      for (const id of created) nodes.delete(id)
      warn(ln, `could not read: ${s.slice(0, 60)}`)
    }
  }
  if (!header) warn(0, 'empty')
  if (stack.length) warn(0, 'unclosed subgraph')
  if (dropped) warnings.push(`+${dropped} more`)

  // an id that names a subgraph is the subgraph (edges may point at it)
  for (const id of subs.keys()) nodes.delete(id)
  for (const n of nodes.values()) {
    if (n.parent && !subs.has(n.parent)) n.parent = null
    n.style = merge(n.classes, n.style)
    ast.nodes.push(n)
  }
  for (const sg of ast.subgraphs) sg.style = merge(sg.classes, sg.style)
  ast.edges = ast.edges.filter((e) => (nodes.has(e.from) || subs.has(e.from)) && (nodes.has(e.to) || subs.has(e.to)))
  return { ast, warnings }

  function merge(classes: string[], own: MStyle): MStyle {
    const out: MStyle = { ...classDefs.get('default') }
    for (const c of classes) {
      const d = classDefs.get(c)
      if (d) Object.assign(out, d)
      else warn(0, `undefined class ${c}`)
    }
    return Object.assign(out, own)
  }

  // A --> B & C -- text --> D ...
  function chain(ln: number, s: string): boolean {
    let i = 0
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }
    const group = (): string[] | null => {
      const ids: string[] = []
      for (;;) {
        ws()
        const id = one()
        if (id === null) return null
        ids.push(id)
        ws()
        if (s[i] !== '&') return ids
        i++
      }
    }
    const one = (): string | null => {
      const st = i
      while (i < s.length) {
        const c = s[i], n = s[i + 1]
        if (/[\s[\](){}<>|&;:"',@]/.test(c)) break
        if ((c === '-' && (n === '-' || n === '.' || n === '>')) || (c === '=' && n === '=') || (c === '~' && n === '~') || (c === '.' && n === '-')) break
        i++
      }
      if (i === st) return null
      const id = s.slice(st, i)
      const n = node(id)
      shape(n)
      const cls = /^:::([\w-]+)/.exec(s.slice(i))
      if (cls) { i += cls[0].length; n?.classes.push(cls[1]) }
      return id
    }
    const shape = (n: MNode | null) => {
      if (s.startsWith('@{', i)) {
        const end = s.indexOf('}', i)
        if (end < 0) { i = s.length; return }
        const body = s.slice(i + 2, end)
        i = end + 1
        let sh: NodeShape = 'rect', lab: string | null = null
        for (const m of body.matchAll(/(\w+)\s*:\s*("[^"]*"|[^,]+)/g)) {
          const v = m[2].trim()
          if (m[1] === 'shape') {
            const name = decode(v), got = V11[name] ?? (/^(rect|stadium|subroutine|cylinder|circle|diamond|hexagon|lean-[rl]|trap-[bt]|odd|tri)$/.test(name) ? name as NodeShape : null)
            if (got) sh = got
            else no(ln, `shape ${name}`)
          } else if (m[1] === 'label') lab = decode(v)
        }
        if (n) { n.shape = sh; if (lab !== null) n.label = lab }
        return
      }
      for (const [o, c, sh] of OPEN) {
        if (!s.startsWith(o, i)) continue
        let j = i + o.length
        const quoted = s[j] === '"'
        let text: string, endAt: number, kind = sh
        const closers = c ? [c] : ['/]', '\\]']
        const from = quoted ? s.indexOf('"', j + 1) + 1 : j
        if (quoted && from === 0) return
        let best = -1, which = ''
        for (const cl of closers) {
          let at = s.indexOf(cl, from)
          if (!quoted && cl.length === 1) {
            // an unquoted label may hold balanced brackets: `[messages[] in]`
            const op = cl === ']' ? '[' : cl === ')' ? '(' : '{'
            for (let d = 0, x = from; x < s.length; x++) {
              if (s[x] === op) d++
              else if (s[x] === cl && !d--) { at = x; break }
            }
          }
          if (at >= 0 && (best < 0 || at < best)) { best = at; which = cl }
        }
        if (best < 0) return
        text = s.slice(j, best)
        endAt = best + which.length
        if (!c) kind = sh === 'lean-r' ? (which === '/]' ? 'lean-r' : 'trap-b') : which === '\\]' ? 'lean-l' : 'trap-t'
        i = endAt
        if (n) { n.shape = kind; n.label = decode(text) }
        return
      }
    }
    const link = (): Omit<MEdge, 'from' | 'to'> | null => {
      ws()
      const e = /^[\w-]+@(?=[-=.~<ox])/.exec(s.slice(i))
      if (e) { i += e[0].length; no(ln, 'edge id') }
      const rest = s.slice(i)
      const heads: Record<string, Head> = { '>': 'arrow', '<': 'arrow', o: 'circle', x: 'cross' }
      // a complete link: `-->`, `---`, `-.->`, `==>`, `~~~`, `<-->`, `--o`, `--x` …
      const m = /^([<ox](?=[-=.]))?(-{2,}|={2,}|-\.+-|~{3,})(>|[ox](?![\w-]))?/.exec(rest)
      if (m && (m[3] || !/^(--|==)$/.test(m[2]))) {
        const body = m[2]
        i += m[0].length
        const stroke = body[0] === '~' ? 'invisible' : body[0] === '=' ? 'thick' : body[1] === '.' ? 'dotted' : 'normal'
        let label = ''
        ws()
        const p = /^\|("[^"]*"|[^|]*)\|/.exec(s.slice(i))
        if (p) { i += p[0].length; label = decode(p[1]) }
        return { label, start: m[1] ? heads[m[1]] : 'none', end: m[3] ? heads[m[3]] : 'none', stroke, len: Math.max(1, (stroke !== 'normal' && stroke !== 'thick') || !m[3] ? body.length - 2 : body.length - 1) }
      }
      // a label inside the link: `A -- text --> B`, `A ==text==> B`, `A -. text .-> B`
      const open = /^([<ox](?=[-=]))?(--|==|-\.)/.exec(rest)
      if (!open) return null
      const dot = open[2] === '-.', ch = open[2][0] === '=' ? '=' : '-'
      const close = dot ? /(\.+)-(>|[ox](?![\w-]))?/g : ch === '=' ? /(=+)(>|[ox](?![\w-]))?/g : /(-+)(>|[ox](?![\w-]))?/g
      close.lastIndex = open[0].length
      for (let c; (c = close.exec(rest));) {
        const n = c[1].length
        if (!dot && (n < 2 || (!c[2] && n < 3))) continue
        const text = rest.slice(open[0].length, c.index)
        if (!text.trim()) return null
        i += c.index + c[0].length
        return {
          label: decode(text), start: open[1] ? heads[open[1]] : 'none', end: c[2] ? heads[c[2]] : 'none',
          stroke: dot ? 'dotted' : ch === '=' ? 'thick' : 'normal', len: Math.max(1, dot ? n : c[2] ? n - 1 : n - 2),
        }
      }
      return null
    }
    let prev = group()
    if (!prev) return false
    for (;;) {
      ws()
      if (i >= s.length) return true
      const l = link()
      if (!l) return false
      const next = group()
      if (!next) return false
      for (const a of prev) for (const b of next) {
        if (ast.edges.length >= LIMITS.edges) { warn(0, `over ${LIMITS.edges} edges, rest dropped`); break }
        ast.edges.push({ from: a, to: b, ...l })
      }
      if (l.stroke === 'invisible') warn(ln, '~~~ is layout-only')
      prev = next
    }
  }
}

// --- ids ----------------------------------------------------------------------

const RESERVED = /^(end|graph|flowchart|subgraph|style|class|classDef|click|linkStyle|direction|default|call|href)$/
/** A mermaid id → a safe element id (and a safe mermaid id back): [A-Za-z0-9_-],
 *  never a keyword, never an Object.prototype name like `__proto__`. */
export function makeIds() {
  const used = new Set<string>()
  return (raw: string): string => {
    let id = raw.replace(/[^\w-]/g, '_').slice(0, 64) || 'n'
    if (RESERVED.test(id) || id in Object.prototype) id += '_'
    let out = id
    for (let k = 2; used.has(out); k++) out = `${id}_${k}`
    used.add(out)
    return out
  }
}

// --- geometry -----------------------------------------------------------------

export interface Palette { fill: string; stroke: string; ink: string; edge: string; groupFill: string; groupStroke: string }
export const PALETTE: Palette = { fill: '#EEF2F8', stroke: '#5B6B82', ink: '#1E2A3A', edge: '#5B6B82', groupFill: 'rgba(91,107,130,0.06)', groupStroke: '#AEB8C6' }
export const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const F = 16, LH = 1.25, WRAP = 200, PADX = 16, PADY = 10

/** Width of `text` at `fontSize`, without a DOM: per-glyph class widths. */
export function estimateWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    w += c >= 0x1100 ? 1 : /[iljtf.,:;'|!()[\] ]/.test(ch) ? 0.3 : /[mwMW@%]/.test(ch) ? 0.86 : /[A-Z0-9#&]/.test(ch) ? 0.66 : 0.55
  }
  return w * fontSize
}

const r2 = (v: number) => Math.round(v * 100) / 100
// canonical path templates in a 100×100 box; reverse recognises them by string
const PATHS: Partial<Record<NodeShape, string>> = {
  diamond: 'M50 0L100 50L50 100L0 50Z',
  hexagon: 'M15 0L85 0L100 50L85 100L15 100L0 50Z',
  'lean-r': 'M15 0L100 0L85 100L0 100Z',
  'lean-l': 'M0 0L85 0L100 100L15 100Z',
  'trap-b': 'M15 0L85 0L100 100L0 100Z',
  'trap-t': 'M0 0L100 0L85 100L15 100Z',
  odd: 'M0 0L100 0L100 100L0 100L15 50Z',
  subroutine: 'M0 0L100 0L100 100L0 100Z M8 0L8 100M92 0L92 100',
  cylinder: 'M0 10C0 -3 100 -3 100 10L100 90C100 103 0 103 0 90Z M0 10C0 23 100 23 100 10',
  // two circles (r 50 and 42) as four cubics each
  dblcircle: 'M50 0C77.62 0 100 22.38 100 50C100 77.62 77.62 100 50 100C22.38 100 0 77.62 0 50C0 22.38 22.38 0 50 0Z M50 8C73.2 8 92 26.8 92 50C92 73.2 73.2 92 50 92C26.8 92 8 73.2 8 50C8 26.8 26.8 8 50 8Z',
}
// how much of the node's width the label may use, and extra height
const INNER: Partial<Record<NodeShape, number>> = { diamond: 0.75, hexagon: 0.7, 'lean-r': 0.7, 'lean-l': 0.7, 'trap-b': 0.7, 'trap-t': 0.7, odd: 0.85, subroutine: 0.84, tri: 0.5, circle: 0.72, dblcircle: 0.62 }

function center(b: Box): Pt { return { x: b.x + b.w / 2, y: b.y + b.h / 2 } }
/** slides' lineedit.borderPoint: where the ray from b's centre toward t leaves b */
function border(b: Box, t: Pt): Pt {
  const c = center(b), dx = t.x - c.x, dy = t.y - c.y
  if (!dx && !dy) return c
  const s = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity)
  return { x: r2(c.x + dx * s), y: r2(c.y + dy * s) }
}
/** slides' patheditor.anchorsToPath (Catmull-Rom → cubic), relative to (ox, oy) */
function smooth(pts: Pt[], ox: number, oy: number): string {
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]
  const f = (x: number, y: number) => `${r2(x - ox)} ${r2(y - oy)}`
  let d = `M ${f(pts[0].x, pts[0].y)}`
  for (let i = 0; i < pts.length - 1; i++)
    d += ` C ${f(P(i).x + (P(i + 1).x - P(i - 1).x) / 6, P(i).y + (P(i + 1).y - P(i - 1).y) / 6)} ${f(P(i + 1).x - (P(i + 2).x - P(i).x) / 6, P(i + 1).y - (P(i + 2).y - P(i).y) / 6)} ${f(P(i + 1).x, P(i + 1).y)}`
  return d
}
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>')

// --- mermaid → elements -------------------------------------------------------

export interface MermaidOpts {
  w: number
  h: number
  /** hand-placed positions by element id; they win, new nodes go around them */
  layout?: Record<string, Box>
  measure?: (text: string, fontSize: number) => number
  palette?: Partial<Palette>
  fontFamily?: string
}

export function mermaidToDiagram(src: string, opts: MermaidOpts): { elements: DElement[]; warnings: string[]; ast: FlowAST } {
  const { ast, warnings } = parseMermaid(String(src ?? ''))
  const P = { ...PALETTE, ...opts.palette }
  const measure = opts.measure ?? estimateWidth
  const font = opts.fontFamily ?? FONT
  const idOf = makeIds()
  const eid = new Map<string, string>()
  for (const n of ast.nodes) eid.set(n.id, idOf(n.id))
  for (const g of ast.subgraphs) eid.set(g.id, idOf(g.id))
  let clipped = 0

  // wrap a label to WRAP px and measure it; very long labels size to LIMITS.labelLines
  const text = (label: string, fs: number) => {
    const lines: string[] = []
    let w = 0
    for (const para of label.split('\n')) {
      let cur = '', cw = 0
      for (const word of para.split(/(?<=\s)/)) {
        const ww = measure(word, fs)
        if (cur && cw + ww > WRAP * fs / F) { lines.push(cur); w = Math.max(w, cw); cur = ''; cw = 0 }
        if (ww > WRAP * fs / F) {
          // hard-break a word longer than the wrap width
          for (const ch of word) {
            const c = measure(ch, fs)
            if (cw + c > WRAP * fs / F && cur) { lines.push(cur); w = Math.max(w, cw); cur = ''; cw = 0 }
            cur += ch; cw += c
          }
        } else { cur += word; cw += ww }
        if (lines.length > LIMITS.labelLines) break
      }
      lines.push(cur); w = Math.max(w, cw)
      if (lines.length > LIMITS.labelLines) break
    }
    if (lines.length > LIMITS.labelLines) clipped++
    const n = Math.min(lines.length, LIMITS.labelLines)
    return { w: Math.ceil(w), h: Math.ceil(n * fs * LH) }
  }

  const size = new Map<string, { w: number; h: number; tw: number }>()
  for (const n of ast.nodes) {
    const t = text(n.label, F)
    let w = t.w + 2 * PADX, h = t.h + 2 * PADY
    const s = n.shape
    if (s === 'diamond') w = h = t.w + t.h + 2 * PADX
    else if (s === 'tri') { w *= 2; h *= 2 }
    else if (s === 'circle' || s === 'dblcircle') w = h = Math.hypot(t.w, t.h) + 2 * PADY + (s === 'dblcircle' ? 12 : 0)
    else if (INNER[s]) w = w / INNER[s]!
    if (s === 'stadium') w += h / 2
    if (s === 'cylinder') h += 16
    size.set(n.id, { w: r2(Math.max(w, 40)), h: r2(h), tw: t.w })
  }
  const horiz = ast.dir === 'LR' || ast.dir === 'RL'
  const EF = F * 0.875
  const elab = ast.edges.map((e) => (e.label ? text(e.label, EF) : null))
  const lnodes = ast.nodes.map((n) => ({ id: n.id, ...size.get(n.id)!, parent: n.parent }))
  const lclusters = ast.subgraphs.map((g) => ({ id: g.id, parent: g.parent, dir: g.dir, top: Math.ceil(F * 0.875 * LH) + 8, minW: text(g.label, F * 0.875).w + 8 }))
  const ledges: LEdge[] = ast.edges.map((e, i) => {
    const t = elab[i]
    // a label sits BESIDE its edge: the layout reserves room on both sides of the line
    const lw = t ? (horiz ? t.w + 8 : 2 * (t.w + 8) + 12) : 0
    const lh = t ? (horiz ? 2 * (t.h + 4) + 8 : t.h + 4) : 0
    return { from: e.from, to: e.to, minlen: e.len, lw, lh }
  })
  const L = layout(lnodes, lclusters, ledges, ast.dir, { nodeGap: 40, rankGap: 56, pad: 16, maxDummies: LIMITS.dummies })
  for (const id of L.ignoredDir) warnings.push(`direction in subgraph ${id} ignored: its members link outside it (as in mermaid)`)
  if (L.capped) warnings.push('the graph is too large to route every long edge; some are drawn straight')
  if (clipped) warnings.push(`${clipped} label(s) longer than ${LIMITS.labelLines} lines: the text is kept but the shape is sized for ${LIMITS.labelLines}`)

  // fit into w×h: scale down (never up) and centre
  const M = 16
  const s = Math.min(1, (opts.w - 2 * M) / (L.w || 1), (opts.h - 2 * M) / (L.h || 1))
  const k = s > 0 && isFinite(s) ? s : 1
  if (k < 0.5) warnings.push(`scaled to ${Math.round(k * 100)}% to fit ${opts.w}×${opts.h}`)
  const ox = (opts.w - L.w * k) / 2, oy = (opts.h - L.h * k) / 2
  const tp = (p: Pt): Pt => ({ x: r2(ox + p.x * k), y: r2(oy + p.y * k) })
  const tb = (b: Box): Box => ({ ...tp(b), w: r2(b.w * k), h: r2(b.h * k) })
  const boxes = new Map<string, Box>()
  for (const [id, b] of L.nodes) boxes.set(id, tb(b))
  let bends = L.edges.map((e) => e.bends.map(tp))
  let labAt = L.edges.map((e) => (e.label ? tp(e.label) : undefined))

  // the layout sidecar: named boxes win; the rest shift to sit around them
  const side = opts.layout
  const pinned = new Set<string>()
  if (side && typeof side === 'object') {
    const dx: number[] = [], dy: number[] = []
    for (const n of ast.nodes) {
      const id = eid.get(n.id)!
      const b = Object.hasOwn(side, id) ? side[id] : null
      if (!b || ![b.x, b.y, b.w, b.h].every((v) => typeof v === 'number' && isFinite(v)) || b.w <= 0 || b.h <= 0) continue
      const a = center(boxes.get(n.id)!), c = center(b)
      dx.push(c.x - a.x); dy.push(c.y - a.y)
      boxes.set(n.id, { x: b.x, y: b.y, w: b.w, h: b.h })
      pinned.add(n.id)
    }
    if (pinned.size) {
      const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1]
      const tx = med(dx), ty = med(dy)
      const placed = [...pinned].map((id) => boxes.get(id)!)
      const hit = (a: Box, b: Box) => a.x < b.x + b.w + 8 && b.x < a.x + a.w + 8 && a.y < b.y + b.h + 8 && b.y < a.y + a.h + 8
      for (const n of ast.nodes) {
        if (pinned.has(n.id)) continue
        const b = boxes.get(n.id)!
        b.x = r2(b.x + tx); b.y = r2(b.y + ty)
        for (let guard = 0; guard <= placed.length; guard++) {
          const o = placed.find((p) => hit(b, p))
          if (!o) break
          if (horiz) b.y = r2(o.y + o.h + 16)
          else b.x = r2(o.x + o.w + 16)
        }
        placed.push(b)
      }
      bends = bends.map((bs, i) => (pinned.has(ast.edges[i].from) || pinned.has(ast.edges[i].to) ? [] : bs.map((p) => ({ x: r2(p.x + tx), y: r2(p.y + ty) }))))
      labAt = labAt.map((p, i) => (p && bends[i].length ? { x: r2(p.x + tx), y: r2(p.y + ty) } : undefined))
    }
  }
  // subgraph boxes: the layout's, or (with a sidecar) the hull of their members
  const depth = (g: MSubgraph) => { let d = 0; for (let p = g.parent; p; p = ast.subgraphs.find((x) => x.id === p)?.parent ?? null) d++; return d }
  const order = [...ast.subgraphs].sort((a, b) => depth(b) - depth(a))
  for (const g of order) {
    let b = tb(L.clusters.get(g.id)!)
    if (pinned.size) {
      const kids = [...ast.nodes.filter((n) => n.parent === g.id).map((n) => n.id), ...ast.subgraphs.filter((x) => x.parent === g.id).map((x) => x.id)].map((id) => boxes.get(id)!).filter(Boolean)
      if (kids.length) {
        const pad = 16 * k, top = lclusters[0].top * k
        const x0 = Math.min(...kids.map((q) => q.x)) - pad, y0 = Math.min(...kids.map((q) => q.y)) - pad - top
        b = { x: r2(x0), y: r2(y0), w: r2(Math.max(...kids.map((q) => q.x + q.w)) + pad - x0), h: r2(Math.max(...kids.map((q) => q.y + q.h)) + pad - y0) }
      }
    }
    boxes.set(g.id, b)
  }

  const out: DElement[] = []
  const base = (id: string, b: Box, extra: object = {}) => ({ id, x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h), rotation: 0, opacity: 1, ...extra })
  const label = (id: string, b: Box, str: string, fs: number, color: string, extra: Partial<DText> = {}): DText => ({
    ...base(idOf(id + '-label'), b), type: 'text', html: escHtml(str), fontSize: r2(fs * k), fontFamily: font, fontWeight: 400,
    color, align: 'center', valign: 'middle', lineHeight: LH, ...extra,
  })
  for (const g of [...ast.subgraphs].sort((a, b) => depth(a) - depth(b))) {
    const b = boxes.get(g.id)!, id = eid.get(g.id)!
    out.push({ ...base(id, b), type: 'shape', shape: 'rect', fill: g.style.fill ?? P.groupFill, stroke: g.style.stroke ?? P.groupStroke, strokeWidth: 1, radius: r2(8 * k), role: 'subgraph', groupId: id })
    out.push(label(id, { x: b.x + 8 * k, y: b.y + 4 * k, w: b.w - 16 * k, h: lclusters[0].top * k - 4 * k }, g.label, F * 0.875, g.style.color ?? P.ink, { align: 'left', valign: 'top', fontWeight: 600, groupId: id }))
  }
  const edgeLabels: DText[] = []
  const polys: Pt[][] = []
  const jobs: Array<[string, number, Pt[], number]> = []
  ast.edges.forEach((e, i) => {
    if (e.stroke === 'invisible') return
    const A = boxes.get(e.from)!, B = boxes.get(e.to)!
    const a0 = eid.get(e.from)!, b0 = eid.get(e.to)!
    const id = idOf(`${a0}-${b0}`)
    const sw = e.stroke === 'thick' ? 3.5 : 2
    const tip = (h: Head): Tip | undefined => (h === 'arrow' ? 'arrow' : h === 'circle' ? 'circle-open' : h === 'cross' ? 'bar' : undefined)
    const deco: Partial<DShape> = { lineStart: tip(e.start), lineEnd: tip(e.end), strokeStyle: e.stroke === 'dotted' ? 'dashed' : undefined }
    for (const key of ['lineStart', 'lineEnd', 'strokeStyle'] as const) if (deco[key] === undefined) delete deco[key]
    let pts: Pt[]
    let el: DShape
    if (e.from === e.to) {
      // self-loop: pinned sides, since 'auto' would collapse both ends to the centre
      const c = center(A)
      pts = [{ x: A.x + A.w, y: c.y }, { x: A.x + A.w + 24, y: A.y - 24 }, { x: c.x, y: A.y }]
      const x0 = Math.min(...pts.map((p) => p.x)), y0 = Math.min(...pts.map((p) => p.y))
      const w = Math.max(...pts.map((p) => p.x)) - x0, h = Math.max(...pts.map((p) => p.y)) - y0
      el = { ...base(id, { x: x0, y: y0, w, h }), type: 'shape', shape: 'path', fill: 'none', stroke: P.edge, strokeWidth: sw, radius: 0, ...deco,
        d: `M ${r2(pts[0].x - x0)} ${r2(pts[0].y - y0)} C ${r2(pts[1].x - x0)} ${r2(pts[0].y - y0)} ${r2(pts[1].x - x0)} ${r2(pts[1].y - y0)} ${r2(pts[2].x - x0)} ${r2(pts[1].y - y0)} C ${r2(pts[2].x - x0)} ${r2(pts[1].y - y0)} ${r2(pts[2].x - x0)} ${r2(pts[2].y - y0)} ${r2(pts[2].x - x0)} ${r2(pts[2].y - y0)}`,
        pathBox: [0, 0, r2(w), r2(h)], from: { el: a0, side: 'right' }, to: { el: b0, side: 'top' } }
    } else {
      // ends exactly where slides' syncConnectors would put them, so nothing jumps on the first edit
      const a = border(A, center(B)), b = border(B, center(A))
      const bs = bends[i]
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
      const off = (p: Pt) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len
      if (!bs.length || bs.every((p) => off(p) < 2)) {
        const h = sw + 2
        el = { ...base(id, { x: (a.x + b.x) / 2 - len / 2, y: (a.y + b.y) / 2 - h / 2, w: len, h }), type: 'shape', shape: 'line', fill: P.edge, stroke: 'transparent', strokeWidth: sw, radius: 0, ...deco,
          rotation: r2((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI), from: { el: a0, side: 'auto' }, to: { el: b0, side: 'auto' } }
        pts = [a, b]
      } else {
        pts = [a, ...bs, b]
        const x0 = Math.min(...pts.map((p) => p.x)), y0 = Math.min(...pts.map((p) => p.y))
        const w = Math.max(Math.max(...pts.map((p) => p.x)) - x0, 1), h = Math.max(Math.max(...pts.map((p) => p.y)) - y0, 1)
        el = { ...base(id, { x: x0, y: y0, w, h }), type: 'shape', shape: 'path', fill: 'none', stroke: P.edge, strokeWidth: sw, radius: 0, ...deco,
          d: smooth(pts, x0, y0), pathBox: [0, 0, r2(w), r2(h)], from: { el: a0, side: 'auto' }, to: { el: b0, side: 'auto' } }
      }
    }
    out.push(el)
    polys.push(pts)
    if (elab[i]) jobs.push([id, i, pts, polys.length - 1])
  })
  // Edge labels: the layout's spot first (beside the edge's middle, where it
  // reserved room), else the other side, else further along the edge — the
  // first spot that crosses no other edge and covers no node or label wins.
  // With no clear spot the layout's stands.
  const seg = (a: Pt, b: Pt, r: Box) => {
    // Liang–Barsky: does segment ab enter box r?
    let t0 = 0, t1 = 1
    const dx = b.x - a.x, dy = b.y - a.y
    for (const [p, q] of [[-dx, a.x - r.x], [dx, r.x + r.w - a.x], [-dy, a.y - r.y], [dy, r.y + r.h - a.y]]) {
      if (!p) { if (q < 0) return false; continue }
      const t = q / p
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
    }
    return t0 < t1
  }
  const over = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const along = (pts: Pt[], f: number): Pt => {
    let total = 0
    for (let j = 1; j < pts.length; j++) total += Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y)
    for (let j = 1, acc = 0; j < pts.length; j++) {
      const d = Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y)
      if (acc + d >= total * f) { const u = d ? (total * f - acc) / d : 0; return { x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * u, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * u } }
      acc += d
    }
    return pts[0]
  }
  const taken: Box[] = ast.nodes.map((n) => boxes.get(n.id)!)
  for (const [id, i, pts, own] of jobs) {
    const t = elab[i]!, e = ast.edges[i]
    const lw = t.w * k + 8 * k, lh = t.h * k + 4 * k
    const at = (p: Pt, s: number): Box => {
      const c = horiz ? { x: p.x, y: p.y + s * (4 * k + lh / 2) } : { x: p.x + s * (6 * k + lw / 2), y: p.y }
      return { x: c.x - lw / 2, y: c.y - lh / 2, w: lw, h: lh }
    }
    const clear = (r: Box) => !taken.some((b) => over(b, r)) && !polys.some((pl, j) => j !== own && pl.some((p, q) => q > 0 && seg(pl[q - 1], p, r)))
    const first = at(labAt[i] ?? along(pts, 0.5), 1)
    let best = first
    if (!clear(first)) {
      for (const f of [0.5, 0.35, 0.65, 0.25, 0.75]) {
        const c = [at(along(pts, f), 1), at(along(pts, f), -1)].find(clear)
        if (c) { best = c; break }
      }
    }
    taken.push(best)
    // the text box gets 12px of slack past the reserved space: a label that
    // wraps because the width estimate ran short is worse than a tight one
    edgeLabels.push(label(id, { x: best.x - (horiz ? 6 * k : 0), y: best.y, w: lw + 12 * k, h: lh }, e.label, EF, P.ink, horiz ? {} : { align: 'left' }))
  }
  for (const n of ast.nodes) {
    const b = boxes.get(n.id)!, id = eid.get(n.id)!
    const g = n.parent ? { groupId: eid.get(n.parent)! } : {}
    const st: Partial<DShape> = PATHS[n.shape]
      ? { shape: 'path', d: PATHS[n.shape], pathBox: [0, 0, 100, 100] }
      : { shape: n.shape === 'circle' ? 'ellipse' : n.shape === 'tri' ? 'triangle' : 'rect' }
    out.push({ ...base(id, b, g), type: 'shape', fill: n.style.fill ?? P.fill, stroke: n.style.stroke ?? P.stroke, strokeWidth: 1.5,
      radius: n.shape === 'round' ? r2(8 * k) : n.shape === 'stadium' ? r2(b.h / 2) : 0, ...st } as DShape)
    const iw = b.w * (INNER[n.shape] ?? 1)
    const ty = n.shape === 'tri' ? b.y + b.h * 0.35 : b.y
    out.push(label(id, { x: b.x + (b.w - iw) / 2, y: ty, w: iw, h: b.y + b.h - ty }, n.label, F, n.style.color ?? P.ink, g))
  }
  out.push(...edgeLabels)
  return { elements: out, warnings, ast }
}

/** The sidecar for an edited diagram: every node's box, keyed by element id. */
export function diagramLayout(elements: readonly { type: string; id: string }[]): Record<string, Box> {
  const out: Record<string, Box> = {}
  for (const e of elements as DElement[]) {
    if (e.type !== 'shape' || e.role === 'subgraph' || e.from || e.to || e.shape === 'line') continue
    Object.defineProperty(out, e.id, { value: { x: e.x, y: e.y, w: e.w, h: e.h }, enumerable: true, writable: true, configurable: true })
  }
  return out
}

// --- elements → mermaid -------------------------------------------------------

const TIPS: Partial<Record<Tip, Head>> = { arrow: 'arrow', 'arrow-open': 'arrow', triangle: 'arrow', 'triangle-open': 'arrow', 'circle-open': 'circle', dot: 'circle', bar: 'cross' }
const WRAPS: Record<NodeShape, [string, string]> = {
  rect: ['[', ']'], round: ['(', ')'], stadium: ['([', '])'], subroutine: ['[[', ']]'], cylinder: ['[(', ')]'], circle: ['((', '))'], dblcircle: ['(((', ')))'],
  diamond: ['{', '}'], hexagon: ['{{', '}}'], 'lean-r': ['[/', '/]'], 'lean-l': ['[\\', '\\]'], 'trap-b': ['[/', '\\]'], 'trap-t': ['[\\', '/]'], odd: ['>', ']'], tri: ['', ''],
}
/** Plain text of a label's html (slides' inline subset). */
function plain(html: string): { text: string; rich: boolean } {
  const rich = /<(?!br\s*\/?>)[a-z]/i.test(html)
  const text = html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, n: string) => (n[0] === '#' ? cp(n[1] === 'x' || n[1] === 'X' ? parseInt(n.slice(2), 16) : +n.slice(1), m) : ENT[n.toLowerCase()] ?? m))
  return { text, rich }
}
/** A label as mermaid source: bare when it is plain words, else quoted. */
function quote(t: string, force = false): string {
  if (!force && /^[\w ]+$/.test(t) && t.trim() === t) return t
  return '"' + t.replace(/#(?=\w+;)/g, '#35;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/\n/g, '<br>') + '"'
}

export function diagramToMermaid(elements: readonly { type: string; id: string }[], opts: { direction?: Dir; palette?: Partial<Palette> } = {}): { src: string; lost: Array<{ el: string; what: string }> } {
  const P = { ...PALETTE, ...opts.palette }
  const lost: Array<{ el: string; what: string }> = []
  const els = elements as DElement[]
  const idOf = makeIds()
  const mid = new Map<string, string>()
  const nodes: Array<{ e: DShape; shape: NodeShape }> = [], groups: DShape[] = [], edges: DShape[] = [], texts: DText[] = []
  for (const e of els) {
    if (e.type === 'text') { texts.push(e); continue }
    if (e.type !== 'shape') { const o = e as { id: string; type: string }; lost.push({ el: o.id, what: `${o.type} element` }); continue }
    if (e.from || e.to) { edges.push(e); continue }
    if (e.role === 'subgraph') { groups.push(e); mid.set(e.id, idOf(e.id)); continue }
    let shape: NodeShape = 'rect'
    if (e.shape === 'line') { lost.push({ el: e.id, what: 'unanchored line' }); continue }
    if (e.shape === 'path') {
      const hit = (Object.keys(PATHS) as NodeShape[]).find((k) => PATHS[k] === e.d)
      if (hit) shape = hit
      else if (/z\s*$/i.test(e.d ?? '')) lost.push({ el: e.id, what: 'shape: freeform path drawn as a rectangle' })
      else { lost.push({ el: e.id, what: 'unanchored path' }); continue }
    } else if (e.shape === 'ellipse') shape = 'circle'
    else if (e.shape === 'triangle') shape = 'tri'
    else if (e.shape === 'arrow') lost.push({ el: e.id, what: 'shape: arrow drawn as a rectangle' })
    else if (e.radius > 0) shape = e.radius >= Math.min(e.w, e.h) / 2 - 0.5 ? 'stadium' : 'round'
    nodes.push({ e, shape })
    mid.set(e.id, idOf(e.id))
  }
  for (const e of els) {
    const o = e as DElement & { fillGradient?: unknown; shadow?: unknown; blur?: number }
    if (o.rotation && !(e.type === 'shape' && (e.shape === 'line' || e.shape === 'path'))) lost.push({ el: e.id, what: 'rotation' })
    if (o.opacity !== undefined && o.opacity !== 1) lost.push({ el: e.id, what: 'opacity' })
    if (o.fillGradient) lost.push({ el: e.id, what: 'gradient' })
    if (o.shadow || o.blur) lost.push({ el: e.id, what: 'shadow or blur' })
  }
  // labels: by id convention first, then the smallest shape containing the text's centre
  const labelOf = new Map<string, string>()
  const colorOf = new Map<string, string>()
  const byId = new Map(els.map((e) => [e.id, e]))
  const spare: DText[] = []
  for (const t of texts) {
    const own = t.id.endsWith('-label') ? t.id.slice(0, -6) : ''
    if (own && byId.has(own) && byId.get(own)!.type === 'shape' && !labelOf.has(own)) take(own, t)
    else spare.push(t)
  }
  for (const t of spare) {
    const c = center(t)
    let best: DShape | null = null
    for (const { e } of nodes) if (!labelOf.has(e.id) && c.x >= e.x && c.x <= e.x + e.w && c.y >= e.y && c.y <= e.y + e.h && (!best || e.w * e.h < best.w * best.h)) best = e
    if (!best) {
      // nearest edge midpoint within reach
      let bd = Math.max(48, Math.hypot(t.w, t.h))
      for (const e of edges) {
        if (labelOf.has(e.id)) continue
        const d = Math.hypot(e.x + e.w / 2 - c.x, e.y + e.h / 2 - c.y)
        if (d < bd) { bd = d; best = e }
      }
    }
    if (!best) for (const g of groups) if (!labelOf.has(g.id) && c.x >= g.x && c.x <= g.x + g.w && c.y >= g.y && c.y <= g.y + g.h && (!best || g.w * g.h < best.w * best.h)) best = g
    if (best) take(best.id, t)
    else lost.push({ el: t.id, what: 'free text' })
  }
  function take(id: string, t: DText) {
    const p = plain(t.html)
    if (p.rich) lost.push({ el: t.id, what: 'rich text formatting' })
    labelOf.set(id, p.text)
    if (t.color !== P.ink) colorOf.set(id, t.color)
  }
  // subgraph nesting: the smallest other box containing this one
  const inside = (a: Box, b: Box) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
  const parentOf = new Map<string, string | null>()
  for (const g of groups) {
    let best: DShape | null = null
    for (const o of groups) if (o !== g && inside(g, o) && !inside(o, g) && (!best || o.w * o.h < best.w * best.h)) best = o
    parentOf.set(g.id, best?.id ?? null)
  }
  const gids = new Set(groups.map((g) => g.id))
  const nodeParent = (e: DShape) => (e.groupId && gids.has(e.groupId) ? e.groupId : null)

  // direction, per scope: where the edges between that scope's children point
  const holder = (id: string): string | null => (gids.has(id) ? parentOf.get(id) ?? null : nodeParent(byId.get(id) as DShape))
  // the element that stands for x among S's children; a subgraph whose members
  // link outside is transparent (its members are laid out with S's own)
  const childOf = (x: string, S: string | null): string | undefined => {
    let stand = x
    for (let cur = x, k = 0; k < 100; k++) {
      const p = holder(cur)
      if (p === S) return stand
      if (p === null) return undefined
      if (!crossed(p)) stand = p
      cur = p
    }
  }
  // In a layered layout every forward edge moves the same way along the layer
  // axis while its sideways sign varies, so a direction scores the edges that
  // move its way (a sum of vectors would let one long edge decide)
  const DIRS4: Dir[] = ['TB', 'LR', 'BT', 'RL']
  const infer = (S: string | null | undefined): Dir | undefined => {
    const votes = [0, 0, 0, 0]
    for (const e of edges) {
      if (!e.from || !e.to || !byId.has(e.from.el) || !byId.has(e.to.el)) continue
      const a = S === undefined ? e.from.el : childOf(e.from.el, S), b = S === undefined ? e.to.el : childOf(e.to.el, S)
      if (!a || !b || a === b) continue
      const p = center(byId.get(a)!), q = center(byId.get(b)!), dx = q.x - p.x, dy = q.y - p.y
      if (dy > 1) votes[0]++
      if (dx > 1) votes[1]++
      if (dy < -1) votes[2]++
      if (dx < -1) votes[3]++
    }
    const best = votes.indexOf(Math.max(...votes))
    return votes[best] ? DIRS4[best] : undefined
  }
  // a subgraph none of whose members links outside is laid out in its own direction
  const within = (x: string, g: string) => { for (let c: string | null = holder(x), k = 0; c && k < 100; c = holder(c), k++) if (c === g) return true; return false }
  const cross = new Map<string, boolean>()
  const crossed = (g: string): boolean => cross.get(g) ?? (cross.set(g, edges.some((e) => e.from && e.to && e.from.el !== g && e.to.el !== g && byId.has(e.from.el) && byId.has(e.to.el) && within(e.from.el, g) !== within(e.to.el, g))), cross.get(g)!)
  const dir = opts.direction ?? infer(null) ?? infer(undefined) ?? 'TB'
  const lines = [`flowchart ${dir === 'TB' ? 'TD' : dir}`]
  const styles: string[] = []
  const style = (e: DShape, dfFill: string, dfStroke: string) => {
    const s: string[] = []
    if (e.fill !== dfFill) s.push(`fill:${e.fill}`)
    if (e.stroke !== dfStroke) s.push(`stroke:${e.stroke}`)
    const c = colorOf.get(e.id)
    if (c) s.push(`color:${c}`)
    if (s.length) styles.push(`    style ${mid.get(e.id)} ${s.join(',')}`)
  }
  const decl = (n: { e: DShape; shape: NodeShape }, ind: string) => {
    const id = mid.get(n.e.id)!
    const lab = labelOf.get(n.e.id) ?? ''
    if (n.shape === 'tri') lines.push(`${ind}${id}@{ shape: tri, label: ${quote(lab, true)} }`)
    else if (n.shape === 'rect' && lab === id) lines.push(ind + id)
    else { const [o, c] = WRAPS[n.shape]; lines.push(`${ind}${id}${o}${quote(lab || ' ')}${c}`) }
    style(n.e, P.fill, P.stroke)
  }
  const emit = (parent: string | null, ind: string, cdir: Dir) => {
    for (const n of nodes) if (nodeParent(n.e) === parent) decl(n, ind)
    for (const g of groups) {
      if (parentOf.get(g.id) !== parent) continue
      const id = mid.get(g.id)!, lab = labelOf.get(g.id) ?? id
      lines.push(`${ind}subgraph ${id}${lab === id ? '' : ` [${quote(lab)}]`}`)
      let d = cdir
      if (!crossed(g.id)) {
        // mermaid's default for such a subgraph is the parent's direction turned (TB ⇄ LR)
        const def: Dir = cdir === 'TB' ? 'LR' : 'TB'
        d = infer(g.id) ?? def
        if (d !== def) lines.push(`${ind}    direction ${d}`)
      }
      emit(g.id, ind + '    ', d)
      lines.push(`${ind}end`)
      style(g, P.groupFill, P.groupStroke)
    }
  }
  emit(null, '    ', dir)
  for (const e of edges) {
    const a = e.from && mid.get(e.from.el), b = e.to && mid.get(e.to.el)
    if (!a || !b) { lost.push({ el: e.id, what: e.from && e.to ? 'connector to an element mermaid cannot name' : 'connector with a free end' }); continue }
    let s = TIPS[e.lineStart ?? 'none'] ?? 'none', t = TIPS[e.lineEnd ?? 'none'] ?? 'none'
    for (const tip of [e.lineStart, e.lineEnd]) if (tip && tip !== 'none' && tip !== 'arrow' && tip !== 'circle-open' && tip !== 'bar') lost.push({ el: e.id, what: `tip "${tip}"` })
    let from = a, to = b
    if (s !== 'none' && t === 'none') { [from, to, s, t] = [b, a, 'none', s] }
    else if (s !== 'none' && s !== t) { lost.push({ el: e.id, what: 'different tips at the two ends' }); s = 'none' }
    const colour = e.shape === 'line' ? e.fill : e.stroke
    if (colour !== P.edge) lost.push({ el: e.id, what: 'edge colour' })
    const dotted = e.strokeStyle === 'dashed' || e.strokeStyle === 'dotted'
    const thick = !dotted && e.strokeWidth >= 3
    const ch = (h: Head, start: boolean) => (h === 'arrow' ? (start ? '<' : '>') : h === 'circle' ? 'o' : h === 'cross' ? 'x' : '')
    const body = dotted ? (t === 'none' ? '-.-' : '-.-') : thick ? (t === 'none' ? '===' : '==') : t === 'none' ? '---' : '--'
    const lab = labelOf.get(e.id)
    lines.push(`    ${from} ${ch(s, true)}${body}${ch(t, false)}${lab ? `|${quote(lab)}|` : ''} ${to}`)
  }
  return { src: [...lines, ...styles].join('\n') + '\n', lost }
}
