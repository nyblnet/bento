// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The XML emitter — the write-side twin of xml.ts.
//
// Every OOXML part the export engine produces goes through this one door, and
// the door is strict on purpose. A malformed emitted part is the worst kind of
// export bug: nothing fails here, the ZIP is valid, and the user discovers the
// problem days later when PowerPoint says "needs repair" (or just refuses) with
// no hint of which of forty parts is at fault. So everything that could make a
// part malformed is a THROW at build time, where a rig can see it:
//
//   - element and attribute names are checked against the XML name grammar
//     (the same shape xml.ts accepts — ASCII names with at most one colon,
//     which is all OOXML ever uses);
//   - control characters below 0x20 (except tab/lf/cr) are rejected in text
//     and attribute values — they are unrepresentable in XML 1.0, escaped or
//     not, and one stray \x00 from a corrupted string corrupts the whole part;
//   - non-finite numbers are rejected — String(NaN) is "NaN", which serializes
//     happily and then poisons a cx/cy/sz attribute silently.
//
// What it does NOT do: namespaces. The parser resolves them for real because
// input files are other people's; output is ours, and every part we emit
// declares the conventional prefixes (a:, p:, r:) on its root — real consumers
// accept nothing else gracefully, so there is nothing to abstract. Prefixed
// names are just names here.

export type XChild = XNode | string

export interface XNode {
  name: string
  attrs?: Record<string, string | number>
  kids?: XChild[]
}

/** Build one node. Sugar over the literal shape — `kids` may mix nodes and
 *  text, matching how mixed content actually occurs (an a:t with one string). */
export function x(name: string, attrs?: Record<string, string | number>, kids?: XChild[]): XNode {
  return { name, attrs, kids }
}

// The name shape xml.ts's NAME_RE parses: an ASCII NCName, optionally
// prefixed. Stricter than the XML spec (no unicode names) — OOXML is ASCII
// throughout, and anything outside this shape in OUR output is a bug, not a
// document.
const NAME_RE = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/

// C0 controls minus tab (09), lf (0a), cr (0d): illegal in XML 1.0 in any
// form. There is no escape for them — &#0; is ALSO a well-formedness error —
// so the only correct handling is refusal.
const BAD_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/

/**
 * Strip the unrepresentable C0 controls from AUTHOR-authored text (pasted
 * content, imported docs, chart labels, speaker notes). The writers scrub at
 * ingestion so one stray byte costs a character, not the whole export —
 * mirroring how the text tokenizer already treats a C0 arriving as a numeric
 * entity. Programmer-built strings do NOT go through this: for them the
 * serializer's throwing guard below is the correct posture (a control char in
 * an id or a part name is an upstream bug a rig must see).
 */
export const scrubC0 = (s: string): string => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

function checkText(s: string, where: string): string {
  const m = BAD_CHARS.exec(s)
  if (m) {
    const code = m[0].charCodeAt(0).toString(16).padStart(2, '0')
    throw new Error(`xmlout: control character U+00${code.toUpperCase()} in ${where} — not representable in XML`)
  }
  return s
}

// Text escapes the three characters that can change structure; attributes add
// the quote (we always emit double-quoted values). `>` is not strictly
// required outside `]]>` but escaping it unconditionally costs nothing and
// removes the special case.
const escText = (s: string): string =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
const escAttr = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))

function attrValue(name: string, v: string | number): string {
  if (typeof v === 'number') {
    // A non-finite number in an attribute is always an upstream arithmetic
    // bug (divide by zero in a geometry mapper); "NaN" in a cx= attribute is
    // exactly the silent corruption this module exists to prevent.
    if (!Number.isFinite(v)) throw new Error(`xmlout: non-finite number for attribute "${name}"`)
    return String(v)
  }
  return escAttr(checkText(v, `attribute "${name}"`))
}

function write(out: string[], node: XNode): void {
  if (!NAME_RE.test(node.name)) throw new Error(`xmlout: invalid element name "${node.name}"`)
  out.push('<', node.name)
  if (node.attrs) {
    for (const [k, v] of Object.entries(node.attrs)) {
      if (!NAME_RE.test(k)) throw new Error(`xmlout: invalid attribute name "${k}" on <${node.name}>`)
      out.push(' ', k, '="', attrValue(k, v), '"')
    }
  }
  const kids = node.kids
  if (!kids || kids.length === 0) {
    out.push('/>')
    return
  }
  out.push('>')
  for (const kid of kids) {
    if (typeof kid === 'string') out.push(escText(checkText(kid, `text inside <${node.name}>`)))
    else write(out, kid)
  }
  out.push('</', node.name, '>')
}

/**
 * Serialize one document: the XML declaration plus the tree, no trailing
 * newline. Empty elements self-close — PowerPoint reads either form, but
 * self-closing is what it writes, and matching the native shape keeps diffs
 * against real files readable.
 *
 * `standalone` defaults to true (`standalone="yes"`), which is what every
 * OOXML part carries; pass false to omit the attribute entirely.
 */
export function serialize(root: XNode, standalone = true): string {
  const out: string[] = [
    standalone
      ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      : '<?xml version="1.0" encoding="UTF-8"?>',
  ]
  write(out, root)
  return out.join('')
}
