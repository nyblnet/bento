// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A small namespace-aware XML parser — the one dash's regex scanner cannot be.
//
// dash/src/xlsx.ts reads spreadsheet XML with regex, and its header is explicit
// that this is safe ONLY because none of the elements it reads can nest inside
// themselves. PresentationML breaks that guarantee immediately: `p:grpSp`
// contains `p:grpSp` (94 groups across the census decks), so the convert
// engine needs a real parser. It also needs to run in node — every rig in this
// repo does — which rules out DOMParser, and it must never execute or fetch
// anything, which a real DOM parser must be configured out of.
//
// So: a tokenizing parser producing a plain tree. What it accepts is the XML
// that OOXML producers actually write; what it refuses, it refuses loudly:
//
//   - DOCTYPE is REJECTED outright. OOXML never carries one, and refusing it
//     kills the entire entity-expansion attack class (billion laughs, external
//     entities) by construction rather than by limits.
//   - Only the five predefined entities and numeric character references
//     expand. Anything else is an error, not a silent pass-through.
//   - A mismatched close tag is an error with an offset, never a re-sync — a
//     half-parsed document is a wrong document.
//
// Namespaces are resolved for real (xmlns tracking with proper scoping), not
// assumed from prefixes. Real files essentially always use the conventional
// prefixes, but a resolver keyed on `a:` would silently read nothing from a
// file that says `xmlns:d="…drawingml…"` — and "silently read nothing" is the
// exact failure mode this engine exists to avoid.

export class XmlError extends Error {
  // NOT a constructor parameter property: rigs run under plain node type
  // stripping, which refuses non-erasable TS syntax — a parameter property
  // here made every convert rig unrunnable.
  offset: number
  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`)
    this.offset = offset
  }
}

export interface XElem {
  /** tag name as written in the file, e.g. "p:grpSp" */
  name: string
  /** local part, e.g. "grpSp" */
  local: string
  /** resolved namespace URI; '' when the element is in no namespace */
  ns: string
  /** attribute names exactly as written (a Map: `__proto__="…"` is legal XML) */
  attrs: Map<string, string>
  children: Array<XElem | string>
}

/** The OOXML namespaces this engine reads. */
export const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  asvg: 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
} as const

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' }

function decodeEntities(s: string, at: number): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new XmlError(`bad character reference ${m}`, at)
      }
      return String.fromCodePoint(code)
    }
    const v = ENTITIES[body]
    if (v === undefined) throw new XmlError(`unknown entity ${m}`, at)
    return v
  })
}

const NAME_RE = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/

/**
 * Parse one XML document to its root element.
 *
 * Comments and processing instructions are skipped; CDATA becomes text; text
 * is kept verbatim (leading/trailing whitespace included — `a:t` content with
 * `xml:space="preserve"` depends on it; callers that want tag-only children
 * filter for themselves).
 */
export function parseXml(src: string): XElem {
  let i = 0
  const n = src.length

  // prolog: BOM, xml declaration, comments/PIs, whitespace — and no DOCTYPE
  if (src.charCodeAt(0) === 0xfeff) i = 1
  const skipMisc = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++
      if (src.startsWith('<?', i)) {
        const end = src.indexOf('?>', i)
        if (end < 0) throw new XmlError('unterminated processing instruction', i)
        i = end + 2
      } else if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i)
        if (end < 0) throw new XmlError('unterminated comment', i)
        i = end + 3
      } else if (src.startsWith('<!DOCTYPE', i)) {
        throw new XmlError('DOCTYPE is not allowed', i)
      } else return
    }
  }
  skipMisc()
  if (src[i] !== '<') throw new XmlError('expected an element', i)

  // xmlns scopes: a stack of prefix→uri maps, innermost last
  const scopes: Array<Map<string, string>> = [new Map([['xml', 'http://www.w3.org/XML/1998/namespace']])]
  const lookup = (prefix: string, at: number): string => {
    for (let s = scopes.length - 1; s >= 0; s--) {
      const uri = scopes[s].get(prefix)
      if (uri !== undefined) return uri
    }
    if (prefix === '') return ''
    throw new XmlError(`undeclared namespace prefix "${prefix}"`, at)
  }

  function parseAttrs(at: number): { attrs: Map<string, string>; scope: Map<string, string> | null } {
    const attrs = new Map<string, string>()
    let scope: Map<string, string> | null = null
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++
      const ch = src[i]
      if (ch === '>' || ch === '/' || ch === '?') return { attrs, scope }
      if (i >= n) throw new XmlError('unterminated start tag', at)
      const eq = src.indexOf('=', i)
      if (eq < 0) throw new XmlError('malformed attribute', i)
      const name = src.slice(i, eq).trim()
      if (!NAME_RE.test(name) && !name.startsWith('xmlns')) throw new XmlError(`bad attribute name "${name}"`, i)
      let j = eq + 1
      while (j < n && /\s/.test(src[j])) j++
      const quote = src[j]
      if (quote !== '"' && quote !== "'") throw new XmlError('attribute value must be quoted', j)
      const close = src.indexOf(quote, j + 1)
      if (close < 0) throw new XmlError('unterminated attribute value', j)
      const value = decodeEntities(src.slice(j + 1, close), j)
      if (name === 'xmlns') (scope ??= new Map()).set('', value)
      else if (name.startsWith('xmlns:')) (scope ??= new Map()).set(name.slice(6), value)
      attrs.set(name, value)
      i = close + 1
    }
  }

  function parseElement(): XElem {
    const at = i
    i++ // consume '<'
    let j = i
    while (j < n && !/[\s/>]/.test(src[j])) j++
    const name = src.slice(i, j)
    if (!NAME_RE.test(name)) throw new XmlError(`bad element name "${name}"`, at)
    i = j
    const { attrs, scope } = parseAttrs(at)
    if (scope) scopes.push(scope)
    const colon = name.indexOf(':')
    const prefix = colon < 0 ? '' : name.slice(0, colon)
    const local = colon < 0 ? name : name.slice(colon + 1)
    const el: XElem = { name, local, ns: lookup(prefix, at), attrs, children: [] }

    if (src[i] === '/') {
      if (src[i + 1] !== '>') throw new XmlError('malformed self-closing tag', i)
      i += 2
      if (scope) scopes.pop()
      return el
    }
    if (src[i] !== '>') throw new XmlError('malformed start tag', i)
    i++

    // content
    for (;;) {
      if (i >= n) throw new XmlError(`unclosed element <${name}>`, at)
      if (src[i] === '<') {
        if (src.startsWith('</', i)) {
          const end = src.indexOf('>', i)
          if (end < 0) throw new XmlError('unterminated close tag', i)
          const closing = src.slice(i + 2, end).trim()
          if (closing !== name) throw new XmlError(`expected </${name}>, found </${closing}>`, i)
          i = end + 1
          if (scope) scopes.pop()
          return el
        }
        if (src.startsWith('<!--', i)) {
          const end = src.indexOf('-->', i)
          if (end < 0) throw new XmlError('unterminated comment', i)
          i = end + 3
        } else if (src.startsWith('<![CDATA[', i)) {
          const end = src.indexOf(']]>', i)
          if (end < 0) throw new XmlError('unterminated CDATA', i)
          el.children.push(src.slice(i + 9, end))
          i = end + 3
        } else if (src.startsWith('<?', i)) {
          const end = src.indexOf('?>', i)
          if (end < 0) throw new XmlError('unterminated processing instruction', i)
          i = end + 2
        } else if (src.startsWith('<!DOCTYPE', i)) {
          throw new XmlError('DOCTYPE is not allowed', i)
        } else {
          el.children.push(parseElement())
        }
      } else {
        const next = src.indexOf('<', i)
        const end = next < 0 ? n : next
        const text = decodeEntities(src.slice(i, end), i)
        if (text) el.children.push(text)
        i = end
      }
    }
  }

  const root = parseElement()
  skipMisc()
  if (i < n) throw new XmlError('content after the root element', i)
  return root
}

// --- tree helpers -----------------------------------------------------------

/** Child elements, optionally filtered by namespace URI + local name. */
export function kids(el: XElem, ns?: string, local?: string): XElem[] {
  const out: XElem[] = []
  for (const c of el.children) {
    if (typeof c === 'string') continue
    if (ns !== undefined && c.ns !== ns) continue
    if (local !== undefined && c.local !== local) continue
    out.push(c)
  }
  return out
}

/** First matching child element, or undefined. */
export function kid(el: XElem, ns: string, local: string): XElem | undefined {
  for (const c of el.children) {
    if (typeof c !== 'string' && c.ns === ns && c.local === local) return c
  }
  return undefined
}

/** Every matching descendant, document order, the element itself excluded. */
export function descendants(el: XElem, ns: string, local: string): XElem[] {
  const out: XElem[] = []
  const walk = (e: XElem) => {
    for (const c of e.children) {
      if (typeof c === 'string') continue
      if (c.ns === ns && c.local === local) out.push(c)
      walk(c)
    }
  }
  walk(el)
  return out
}

/** Concatenated text content of the subtree. */
export function textOf(el: XElem): string {
  let out = ''
  for (const c of el.children) out += typeof c === 'string' ? c : textOf(c)
  return out
}

/** Attribute by name, prefix-insensitive (`r:id` matches `id` and vice versa). */
export function attr(el: XElem, name: string): string | undefined {
  const v = el.attrs.get(name)
  if (v !== undefined) return v
  for (const [k, val] of el.attrs) {
    if (k === name || k.endsWith(`:${name}`)) return val
  }
  return undefined
}

/** Integer attribute, or the fallback when absent/unparseable. */
export function intAttr(el: XElem, name: string, fallback = 0): number {
  const v = attr(el, name)
  if (v === undefined) return fallback
  const num = parseInt(v, 10)
  return Number.isFinite(num) ? num : fallback
}

/**
 * Resolve mc:AlternateContent: take the FIRST mc:Choice whose Requires prefix
 * we understand, else mc:Fallback's children. An mc-blind reader double-imports
 * (it sees Choice AND Fallback); the census has 61 of these carrying 100% of
 * the transitions and every SVG image pair.
 */
export function resolveAlternate(el: XElem, understood: Set<string>): Array<XElem | string> {
  if (el.ns !== NS.mc || el.local !== 'AlternateContent') return [el]
  for (const choice of kids(el, NS.mc, 'Choice')) {
    const req = attr(choice, 'Requires') ?? ''
    if (req.split(/\s+/).every((p) => !p || understood.has(p))) return choice.children
  }
  const fb = kid(el, NS.mc, 'Fallback')
  return fb ? fb.children : []
}
