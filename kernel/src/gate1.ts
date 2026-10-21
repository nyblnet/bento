// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// GATE 1: is this file's runtime a genuine Bento release? (bento/connect K5,
// security §13–§18, §36, and the 2026-10-21 grammar ruling.) ONE shared
// implementation for every JavaScript host (the extension, the hosted runtime,
// release tooling). Native hosts (Swift, Kotlin, Rust) port it and must agree
// with it on every row of the conformance corpus in home/fixtures/gate1/.
//
// Two paths, by what the host can do:
//   - verifyServed(): for a host that SERVES the bytes it verified (iOS,
//     Android, desktop, the hosted runtime). It checks the file against the
//     signed release history: ONE release must match EVERY code block, under
//     the grammar below. It answers with the CSP to serve the file under. This
//     is the PRIMARY path, immune to serializer drift (security §17).
//   - verifyStrict(): the file:// fallback, where no CSP can be set. An exact
//     string check against a release's saved skeleton (vault's strict verifier,
//     signed off in security §15). It can only ever hold a RESULT: identity is
//     never exposed in a bare file:// tab (security §16).
//
// "Unknown" is never "tampered": it means "not provably one of ours", and the
// host shows the document without identity, or offers an update. It never
// borrows a pinned CSP for a file it couldn't match.
//
// Pure: no DOM, and WebCrypto for hashing, so it runs in a page, a worker, an
// extension and node alike.

/** A release's pins, as signed into its manifest and its history entry. */
export interface Pins {
  v: 1
  /** sha256 HEX of each code block's text; remover null for releases before the preview */
  blocks: { 'bento-rt': string; 'bento-rt-css': string; loader: string; remover: string | null }
  /** CSP form: 'sha256-' + BASE64 of the loader, then the remover */
  scriptSrc: string[]
}
export interface HistoryEntry { version: string; sha256: string; at: string; pins: Pins }
export interface History { app: string; v: 1; releases: HistoryEntry[] }

// --- the scanner ---------------------------------------------------------------

export interface Block {
  tag: 'script' | 'style'
  /** the whole start tag, exactly as written: html.slice(tagStart, start) */
  attrs: string
  /** the raw text, which ends at the element's real end tag, as the HTML tokenizer ends it */
  text: string
  /** offset of the start tag's "<" */
  tagStart: number
  /** offset of the text's first character in the file */
  start: number
  /** offset just past the end tag's ">", as the tokenizer ends it (quoted attribute values and all) */
  end: number
  type: string | null
  id: string | null
  src: string | null
  preview: boolean
  /** the start tag repeats an attribute name, or uses "/" between attributes (Bento writes neither) */
  duplicate: boolean
  slash: boolean
}

/**
 * A start tag's attributes, read the way the HTML tokenizer reads them (security,
 * #825 review). Names are separated by whitespace (tab, LF, FF, CR, space) OR by
 * "/". A quoted value ends the attribute even with no separator after it. Names
 * are case-insensitive, and the FIRST of duplicate names wins. Reading them any
 * other way lets `<script/type="module" type="application/bento+json">` look
 * inert when a browser runs it. `duplicate` and `slash` are reported because
 * Bento never writes either, so a script tag with either is refused outright
 * (markupProblems). Values are taken literally: a browser decodes character
 * references in them, but a literal read can only make a block look EXECUTABLE,
 * never inert (no data type contains "&").
 */
export interface StartTag { name: string; attrs: Map<string, string>; duplicate: boolean; slash: boolean; end: number }
/**
 * ASCII-only case fold: the HTML spec's, and LENGTH-PRESERVING. Never use
 * toLowerCase() on a file and index the original with its offsets: it changes
 * length ('İ' becomes two UTF-16 units). Every İ before a block then shifts the
 * offsets, so a genuine Turkish document reads as unknown and, worse, a <style>
 * close can land late enough to skip over an injected <script>, and a file
 * carrying foreign code reads as genuine (home-desktop, measured).
 */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

const WS = (c: string | undefined) => c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' '
export function parseStartTag(html: string, i: number): StartTag | null {
  return html[i] === '<' ? readTag(html, i + 1) : null
}

/**
 * An END tag, read exactly like a start tag. The tokenizer parses attributes in
 * end tags too, quoted values included, and then drops them, so
 * `</p a="><b c='">` ends at its SECOND ">". Skipping an end tag to its first ">"
 * instead read `<b c='">'<script>` as one tag and missed the script after it
 * (both engines ran it). null if `i` isn't "</" and a letter, or it's unterminated.
 */
export function parseEndTag(html: string, i: number): StartTag | null {
  return html[i] === '<' && html[i + 1] === '/' ? readTag(html, i + 2) : null
}

/** A tag's name and attributes, from its name's first character. */
function readTag(html: string, at: number): StartTag | null {
  const m = /^([a-zA-Z][^\t\n\f\r />]*)/.exec(html.slice(at, at + 256))
  if (!m) return null
  const attrs = new Map<string, string>()
  let duplicate = false, slash = false
  let j = at + m[0].length
  while (j < html.length) {
    const c = html[j]
    if (WS(c)) { j++; continue }
    if (c === '/') { slash = true; j++; continue } // a separator, or a self-closing mark
    if (c === '>') return { name: asciiLower(m[1]), attrs, duplicate, slash, end: j + 1 }
    // the name: a leading "=" is part of it; it ends at whitespace, "/", ">" or "="
    let k = j, name = ''
    if (html[k] === '=') { name = '='; k++ }
    while (k < html.length && !WS(html[k]) && html[k] !== '/' && html[k] !== '>' && html[k] !== '=') name += html[k++]
    name = asciiLower(name).replace(/\u0000/g, '�')
    let value = ''
    let p = k
    while (WS(html[p])) p++
    if (html[p] === '=') {
      p++
      while (WS(html[p])) p++
      if (html[p] === '"' || html[p] === "'") {
        const close = html.indexOf(html[p], p + 1)
        if (close < 0) return null
        value = html.slice(p + 1, close)
        k = close + 1
      } else {
        let e = p
        while (e < html.length && !WS(html[e]) && html[e] !== '>') e++
        value = html.slice(p, e)
        k = e
      }
    }
    if (attrs.has(name)) duplicate = true
    else attrs.set(name, value)
    j = k
  }
  return null // unterminated
}

/**
 * ONE walk over the file, in document order, tag by tag, as a browser's
 * tokenizer meets them. Both scanBlocks and markupProblems read it, so the
 * blocks gate1 hashes and the markup it judges come from the SAME reading.
 * Searching for "<script" or "<style" instead finds them where a browser never
 * would: inside another tag's name. In `<meta<style><script>…` a browser sees ONE
 * tag, named "meta<style", and then a real <script> that runs. A search saw a
 * <style> whose close swallowed the script (home-ios, found by a WebKit oracle).
 */
interface Walk { blocks: Block[]; problems: string[] }
const TAG_NAME = /^[a-z][a-z0-9-]*$/
/** Elements whose content is TEXT to a browser, never tags, up to their real end tag. */
const RAW_TEXT = ['script', 'style', 'textarea', 'title']

/**
 * Where a raw-text element really ends: "</name" (ASCII case-insensitive)
 * followed by whitespace, "/" or ">", as the tokenizer requires. "</scriptx>"
 * is text inside the script, not its end. -1 if it never ends.
 */
function rawTextEnd(lower: string, name: string, from: number): number {
  let at = from
  while ((at = lower.indexOf(`</${name}`, at)) !== -1) {
    const c = lower[at + 2 + name.length]
    if (c === undefined || WS(c) || c === '/' || c === '>') return at
    at += 2
  }
  return -1
}
function walk(html: string): Walk {
  const blocks: Block[] = [], problems: string[] = []
  const lower = asciiLower(html)
  let i = 0
  while ((i = html.indexOf('<', i)) !== -1) {
    if (html.startsWith('<!--', i)) {
      // "<!-->" and "<!--->" are whole (empty) comments to a browser
      if (html.startsWith('<!-->', i)) { i += 5; continue }
      if (html.startsWith('<!--->', i)) { i += 6; continue }
      const end = html.indexOf('-->', i + 4)
      if (lower.slice(i + 4, end < 0 ? html.length : end).includes('<script')) problems.push('a comment holds a <script>')
      if (end < 0) { problems.push('an unterminated comment'); break }
      i = end + 3; continue
    }
    if (html[i + 1] === '/' && /[a-zA-Z]/.test(html[i + 2] ?? '')) {
      // an end tag: tokenized with the start tag's attribute rules (see parseEndTag)
      const et = parseEndTag(html, i)
      if (!et) { problems.push('an unterminated end tag'); break }
      if (!TAG_NAME.test(et.name)) problems.push(`an end tag named ${JSON.stringify(et.name)}`)
      // a browser drops them, but they move where the tag ends: Bento writes none
      if (et.attrs.size) problems.push(`an end tag </${et.name}> carrying attributes`)
      i = et.end; continue
    }
    if (html.startsWith('</>', i)) { i += 3; continue } // ignored entirely
    if (html[i + 1] === '/' || html[i + 1] === '!' || html[i + 1] === '?') {
      // a doctype or a bogus comment: it ends at the first ">", quotes or not
      const end = html.indexOf('>', i + 2)
      if (end < 0) { problems.push('an unterminated tag'); break }
      i = end + 1; continue
    }
    if (!/^<[a-zA-Z]/.test(html.slice(i, i + 2))) { i++; continue } // a "<" that starts no tag is text
    const tag = parseStartTag(html, i)
    if (!tag) { problems.push('an unterminated start tag'); break }
    const name = tag.name
    // Bento writes only plain tag names. Anything else ("meta<style", a NUL, a
    // non-ASCII letter) is a tag a scanner and a browser may read differently.
    if (!TAG_NAME.test(name)) problems.push(`a start tag named ${JSON.stringify(name)}`)
    if (['iframe', 'object', 'embed', 'base'].includes(name)) problems.push(`a <${name}>`)
    if (name === 'meta' && /^\s*(refresh|content-security-policy)\s*$/i.test(tag.attrs.get('http-equiv') ?? '')) problems.push('a <meta> refresh or CSP')
    if ([...tag.attrs.keys()].some((n) => n.startsWith('on'))) problems.push(`an on*= attribute on <${name}>`)
    if (name === 'script' && (tag.duplicate || tag.slash)) problems.push(`a <script> start tag with a ${tag.duplicate ? 'duplicate attribute' : '"/" between attributes'} (Bento writes neither)`)
    if (RAW_TEXT.includes(name)) {
      const close = rawTextEnd(lower, name, tag.end)
      if (close < 0) { problems.push(`an unterminated <${name}>`); break }
      // inert to a browser, but a scanner that doesn't treat these as text
      // would count it: refuse, so every host's scanner reaches the same verdict
      if (name !== 'script' && lower.slice(tag.end, close).includes('<script')) problems.push(`a <${name}> holds a <script>`)
      if (name === 'textarea' || name === 'title') { i = close; continue }
      const et = parseEndTag(html, close)
      if (!et) { problems.push(`an unterminated </${name}>`); break }
      const get = (n: string) => tag.attrs.has(n) ? tag.attrs.get(n)! : null
      blocks.push({
        tag: name as 'script' | 'style', attrs: html.slice(i, tag.end), text: html.slice(tag.end, close),
        tagStart: i, start: tag.end, end: et.end,
        type: get('type'), id: get('id'), src: get('src'), preview: tag.attrs.has('data-bento-preview'),
        duplicate: tag.duplicate, slash: tag.slash,
      })
      i = close; continue // its end tag is judged next, as an end tag
    }
    i = tag.end
  }
  return { blocks, problems }
}

/** Every <script> and <style> element in the file, with its raw text, in document order. */
export function scanBlocks(html: string): Block[] {
  return walk(html).blocks
}

// --- the grammar (security, 2026-10-21) ------------------------------------------

/**
 * A <script> is inert ONLY if its type is exactly one of the data types Bento
 * writes. Everything else is executable: no type, a JavaScript type, "module",
 * an unknown type, a differently cased data type, and ANY src=. An executable
 * script must be exactly the pinned loader or remover by hash, or the file is
 * UNKNOWN. An allowlist, so a type browsers start running tomorrow can't pass as
 * data.
 */
export const DATA_TYPES: ReadonlySet<string> = new Set(['application/bento+json', 'application/bento+lang', 'bento/deflate-b64', 'bento/deflate-b86'])
export const isDataScript = (b: Block): boolean => b.tag === 'script' && b.src === null && b.type !== null && DATA_TYPES.has(b.type)

/** Every script that isn't one of Bento's data blocks: each must be the pinned loader or remover. */
export const executableScripts = (blocks: Block[]): Block[] => blocks.filter((b) => b.tag === 'script' && !isDataScript(b))

/**
 * Markup a genuine Bento file never carries, anywhere outside a script or style
 * element's own text:
 * - <iframe>, <object>, <embed> or <base>;
 * - a <meta> refresh or CSP;
 * - any on*= attribute;
 * - a comment or <style> holding a <script>;
 * - a data block containing "<".
 * Bento's data never contains "<": the JSON and language packs escape it, and
 * the b64/b86 alphabets exclude it. That also closes the "<!--<script"
 * double-escape state, where a later close tag doesn't end the element.
 * Returns the problems; [] = none.
 */
export function markupProblems(html: string): string[] {
  const { blocks, problems } = walk(html)
  for (const b of blocks) if (isDataScript(b) && b.text.includes('<')) problems.push(`the ${b.type} block contains "<"`)
  return problems
}

// --- hashing ---------------------------------------------------------------------

const enc = new TextEncoder()
async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s) as BufferSource))
}
/** sha256 HEX of a string's UTF-8 bytes: the encoding of every `blocks` pin. */
export async function sha256hex(s: string): Promise<string> {
  return Array.from(await digest(s), (b) => b.toString(16).padStart(2, '0')).join('')
}
/** 'sha256-' + BASE64: the CSP encoding of every `scriptSrc` pin. Never compare it to a hex pin. */
export async function cspHash(s: string): Promise<string> {
  let bin = ''
  for (const b of await digest(s)) bin += String.fromCharCode(b)
  return `sha256-${btoa(bin)}`
}

const CODE_IDS = ['bento-rt', 'bento-rt-css'] as const

/**
 * Check a file against ONE release's pins: no foreign markup, exactly one block
 * per code id with a matching hash, and every executable script exactly the
 * pinned loader or remover. Returns the problems; [] = this release's file.
 */
export async function checkAgainstPins(html: string, pins: Pins): Promise<string[]> {
  const problems = [...markupProblems(html)]
  const blocks = scanBlocks(html)
  for (const id of CODE_IDS) {
    const found = blocks.filter((b) => b.id === id)
    if (found.length !== 1) problems.push(`${found.length} #${id} blocks (exactly one expected)`)
    else if ((await sha256hex(found[0].text)) !== pins.blocks[id]) problems.push(`#${id} does not match`)
  }
  const exec = executableScripts(blocks)
  const hashes = await Promise.all(exec.map((s) => sha256hex(s.text)))
  const allowed = new Set([pins.blocks.loader, pins.blocks.remover].filter(Boolean))
  exec.forEach((s, k) => {
    if (s.src !== null || !allowed.has(hashes[k])) problems.push(`an executable script that is neither the pinned loader nor the remover (${s.src !== null ? 'src=' + s.src : s.text.length + 'B'})`)
  })
  const n = (h: string | null) => hashes.filter((x) => x === h).length
  if (n(pins.blocks.loader) === 0) problems.push('no pinned loader')
  if (n(pins.blocks.loader) > 1) problems.push('more than one loader')
  if (pins.blocks.remover && n(pins.blocks.remover) > 1) problems.push('more than one remover')
  return problems
}

// --- the release history --------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
export function cmpVersion(a: string, b: string): number {
  const x = SEMVER.exec(a), y = SEMVER.exec(b)
  if (!x || !y) throw new Error(`gate1: not a version: ${!x ? a : b}`)
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return d }
  return 0
}
const entryOk = (e: HistoryEntry | undefined): e is HistoryEntry => !!e && typeof e.version === 'string' && SEMVER.test(e.version) &&
  /^[0-9a-f]{64}$/.test(e.sha256 ?? '') && typeof e.at === 'string' && e.pins?.v === 1 && typeof e.pins.blocks === 'object'

/** A history payload's shape problems; [] = well-formed (versions unique, newest first). */
export function historyProblems(h: History | null | undefined): string[] {
  const p: string[] = []
  if (!h || h.v !== 1) p.push(`version ${h?.v} (expected 1)`)
  if (typeof h?.app !== 'string' || !h.app) p.push('no app')
  if (!Array.isArray(h?.releases)) { p.push('no releases'); return p }
  const seen = new Set<string>()
  h.releases.forEach((e, i) => {
    if (!entryOk(e)) { p.push(`entry ${i} is malformed`); return }
    if (seen.has(e.version)) p.push(`version ${e.version} appears twice`)
    seen.add(e.version)
    const prev = h.releases[i - 1]
    if (i > 0 && entryOk(prev) && cmpVersion(prev.version, e.version) <= 0) p.push(`entries are not newest-first at ${e.version}`)
  })
  return p
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * A HOST's acceptance of an incoming, already signature-verified history, given
 * the newest it holds: ANTI-ROLLBACK. It refuses one that lacks a held entry,
 * changes one, or rolls the newest version back. (With a well-formed history
 * the last is implied by the first, and is kept as defence in depth.)
 */
export function acceptHistory(held: History | null, incoming: History, app: string): { ok: true } | { ok: false; reason: string } {
  const problems = historyProblems(incoming)
  if (problems.length) return { ok: false, reason: `malformed: ${problems[0]}` }
  if (incoming.app !== app) return { ok: false, reason: `for ${incoming.app}, not ${app}` }
  if (!held) return { ok: true }
  if (!incoming.releases.length || (held.releases.length && cmpVersion(incoming.releases[0].version, held.releases[0].version) < 0)) {
    return { ok: false, reason: 'rollback: its newest release is older than the newest already held' }
  }
  for (const e of held.releases) {
    const there = incoming.releases.find((x) => x.version === e.version)
    if (!there) return { ok: false, reason: `rollback: it lacks ${e.version}, which is already held` }
    if (!same(there, e)) return { ok: false, reason: `${e.version} changed: a history never changes an entry` }
  }
  return { ok: true }
}

/** The ONE entry matching every block of the file, or null (none, or more than one: UNKNOWN). */
export async function matchRelease(history: History, html: string): Promise<HistoryEntry | null> {
  const rt = scanBlocks(html).filter((b) => b.id === 'bento-rt')
  if (rt.length !== 1) return null
  const rtHash = await sha256hex(rt[0].text)
  const full: HistoryEntry[] = []
  for (const e of history.releases.filter((x) => x.pins.blocks['bento-rt'] === rtHash)) {
    if ((await checkAgainstPins(html, e.pins)).length === 0) full.push(e)
  }
  return full.length === 1 ? full[0] : null
}

// --- the served path ----------------------------------------------------------------

/**
 * The CSP a host serves a verified document under (security §17/§18, §36a):
 * scripts hash-pinned to the release's loader and remover, plus blob: for the
 * runtime the loader imports; styles 'unsafe-inline' (the sanitizer is the style
 * control); everything else closed. `frameAncestors` is the host's own value.
 */
export function hostPolicy(pins: Pins, frameAncestors = "'none'"): string {
  return [
    "default-src 'none'",
    `script-src ${pins.scriptSrc.map((h) => `'${h}'`).join(' ')} blob:`,
    "style-src 'unsafe-inline'",
    'img-src data: blob: https:',
    'media-src data: blob: https:',
    'font-src data: blob:',
    'connect-src https://bento.page https://sync.bento.page wss://sync.bento.page',
    'frame-src https:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "worker-src 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ')
}

export type ServedVerdict =
  | { verdict: 'genuine'; release: HistoryEntry; csp: string }
  | { verdict: 'unknown'; reason: string }

/**
 * THE served-path gate: is this file one genuine release's? The history must
 * already have passed the release-key signature check and acceptHistory().
 */
export async function verifyServed(html: string, history: History, opts: { frameAncestors?: string } = {}): Promise<ServedVerdict> {
  const problems = historyProblems(history)
  if (problems.length) return { verdict: 'unknown', reason: `the history is malformed: ${problems[0]}` }
  const release = await matchRelease(history, html)
  if (!release) {
    const markup = markupProblems(html)
    return { verdict: 'unknown', reason: markup.length ? markup[0] : 'no single release matches every block' }
  }
  return { verdict: 'genuine', release, csp: hostPolicy(release.pins, opts.frameAncestors) }
}

// --- the strict file:// fallback (vault's strict verifier; security §15) ------------

const CLOSE = '</' + 'script>'
const DOC_ANCHOR = ' id="bento-doc"'
const DOC_OPEN = '<script type="application/bento+json" id="bento-doc">'

/** What the strict check compares against, taken from a GENUINE saved file of a release. */
export interface StrictExpected {
  /** the saved file with its variable spans collapsed to placeholders */
  skeleton: string
  /** the exact preview remover that release writes (with its tags), or null before previews */
  remover: string | null
}

function collapse(h: string, remover: string | null): string | { refuse: string } {
  const count = (n: string) => h.split(n).length - 1
  if (count(DOC_ANCHOR) !== 1) return { refuse: `doc anchor count ${count(DOC_ANCHOR)}` }
  const di = h.indexOf(DOC_ANCHOR), dOpen = h.lastIndexOf('<', di), dTagEnd = h.indexOf('>', di) + 1, dEnd = h.indexOf(CLOSE, di) + CLOSE.length
  if (h.slice(dOpen, dTagEnd) !== DOC_OPEN) return { refuse: 'doc block opening tag altered' }
  if (dEnd < CLOSE.length || h.slice(dTagEnd, dEnd - CLOSE.length).includes('<')) return { refuse: '"<" inside the doc block' }
  h = h.slice(0, dOpen) + '<!--DOC-->' + h.slice(dEnd)
  if (count('data-bento-preview') > 0) {
    if (!remover || count('<script data-bento-preview') !== 1 || count(remover) !== 1) return { refuse: 'remover missing, altered or repeated' }
    const pOpen = h.lastIndexOf('<', h.indexOf('data-bento-preview')), rem = h.indexOf(remover), body = h.slice(pOpen, rem)
    if (/<script/i.test(body)) return { refuse: 'script inside the preview markup' }
    if (/\son[a-z]+\s*=/i.test(body) || /javascript:/i.test(body)) return { refuse: 'handler or javascript: in the preview markup' }
    h = h.slice(0, pOpen) + '<!--PREVIEW-->' + h.slice(rem + remover.length)
  }
  return h.replace(/<title>[^<]*<\/title>/, '<title><!--TITLE--></title>')
}

/** The strict expectation from a GENUINE saved file of a release. */
export function strictExpectedFrom(genuineSave: string): StrictExpected {
  const at = genuineSave.indexOf('<script data-bento-preview')
  const remover = at < 0 ? null : genuineSave.slice(at, genuineSave.indexOf(CLOSE, at) + CLOSE.length)
  const skeleton = collapse(genuineSave, remover)
  if (typeof skeleton !== 'string') throw new Error(`gate1: the genuine save fails its own strict check: ${skeleton.refuse}`)
  return { skeleton, remover }
}

/**
 * The strict check: each variable span (the doc block, the preview, the title)
 * is type-checked to its exact allowed form and collapsed. Then EVERYTHING else
 * must equal the release's saved skeleton, byte for byte, over the WHOLE string,
 * bound at both ends. That final compare is what's load-bearing: it caught every
 * one of security's adversarial rows (§15). The span guards are defence in
 * depth that let the variable spans legitimately vary.
 */
export function verifyStrict(html: string, expected: StrictExpected): { ok: true } | { ok: false; reason: string } {
  const c = collapse(html, expected.remover)
  if (typeof c !== 'string') return { ok: false, reason: c.refuse }
  return c === expected.skeleton ? { ok: true } : { ok: false, reason: 'skeleton differs from the release\'s saved form' }
}
