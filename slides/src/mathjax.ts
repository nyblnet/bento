// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Lazy LaTeX → SVG baker. MathJax's tex-svg component (~680KB gz) is FAR bigger
// than the whole compressed shell, so it is NEVER bundled. It is fetched on
// demand — in the EDITOR only, the first time an author touches math — used to
// bake LaTeX into self-contained SVG markup, then forgotten. Viewing/presenting
// a deck needs ZERO runtime and ZERO network: the baked SVG travels in the file.
//
// The engine JS is cached in its own IndexedDB (`bento-mathjax`) so later
// authoring sessions bake offline. Loading is gated by the offline switch:
// with offline on and nothing cached, baking fails gracefully (the panel
// surfaces the message) and any already-baked math still displays.
//
// Every byte that reaches the script tag is checked against a pinned sha256
// first — from the network AND from the cache. See ENGINE_SHA256.
//
// Why markup and not a data: URI <img> — an <img> is opaque. Storing the SVG
// as markup lets render.ts inline it (ids scoped per instance, exactly like the
// gradient/marker counters) which buys three things a data: URI cannot:
//   1. per-symbol morphing (mathmorph.ts addresses individual glyph nodes),
//   2. ink as a live CSS property — the glyphs paint `currentColor`, so colour
//      changes need no re-bake and tween during a morph like text colour,
//   3. ~33% smaller than base64.

import { offlineEnabled } from './update'

/** The pinned engine build. Every candidate source must deliver exactly these
 *  bytes — see ENGINE_SHA256. */
export const MATHJAX_VERSION = '3.2.2'

/** Engine sources, tried in order. bento.page is preferred (same origin as the
 *  app's own update channel, versioned with it); the official MathJax build on
 *  jsDelivr is the fallback so a locally-served or freshly-cloned checkout
 *  bakes math with no setup. Dev override: localStorage 'bento-mathjax-url'
 *  (mirrors update.ts 'bento-update-url'). */
const MATHJAX_URLS = [
  'https://bento.page/vendor/tex-svg.js',
  `https://cdn.jsdelivr.net/npm/mathjax@${MATHJAX_VERSION}/es5/tex-svg.js`,
]

/**
 * SHA-256 of mathjax@3.2.2's `es5/tex-svg.js`, taken from the npm tarball
 * (jsDelivr, cdnjs and unpkg all serve that same file byte-for-byte).
 *
 * This pin is not optional book-keeping. The engine is ~2MB of third-party JS
 * that we execute in the app's OWN origin — the origin holding decrypted deck
 * content, the collab room key and the ECDSA owner/writer/member private keys.
 * update.ts refuses to apply the app's own code without an ECDSA signature and
 * a sha256 match; fetching a CDN blob and running it unchecked would be a much
 * bigger hole than the one that guards. So: no source is trusted, including
 * bento.page, the localStorage override and the local /vendor copy (update.ts
 * verifies its dev override too — an override changes WHERE code comes from,
 * never WHETHER it is checked). A mismatch is treated as a dead source; the
 * next candidate is tried and a total failure reports the mismatch by name.
 *
 * Bumping MATHJAX_VERSION means recomputing this — scripts/fetch-mathjax.mjs
 * prints the hash of whatever it downloaded, and verifies against this pin.
 */
export const ENGINE_SHA256 = 'd4295dc33744836935c1399feece5159577b34c5c8ffb9f1c6324cd82e03a882'

const isLocalDev = (): boolean => {
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
  } catch {
    return false
  }
}

/** Candidate engine URLs, highest priority first. */
const engineUrls = (): string[] => {
  try {
    const override = localStorage.getItem('bento-mathjax-url')
    if (override) return [override]
  } catch {
    /* storage unavailable */
  }
  // Dev/testing convenience: when served from localhost, prefer an engine
  // placed at slides/public/vendor/tex-svg.js (gitignored, not bundled) so math
  // bakes with no network at all. `npm run fetch-mathjax` puts it there.
  return isLocalDev()
    ? [new URL('/vendor/tex-svg.js', location.origin).href, ...MATHJAX_URLS]
    : MATHJAX_URLS
}

// --- tiny IndexedDB cache for the engine JS text -------------------------
const DB_NAME = 'bento-mathjax'
const STORE = 'engine'
// One cache slot, unversioned: every source must deliver the SAME pinned
// bytes, so a copy fetched from any candidate URL satisfies a later boot that
// would have picked a different one (and a source going away never strands a
// cached engine). Bumping the pin needs no migration either — the old entry
// simply fails verification on read and is refetched.
const CACHE_KEY = 'tex-svg'
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(DB_NAME, 1) } catch { resolve(null); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
  return dbPromise
}

function idbGet(key: string): Promise<string | null> {
  return openDb().then((db) => {
    if (!db) return null
    return new Promise<string | null>((resolve) => {
      let t: IDBTransaction
      try { t = db.transaction(STORE, 'readonly') } catch { resolve(null); return }
      const req = t.objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as string) ?? null)
      req.onerror = () => resolve(null)
    })
  })
}

function idbPut(key: string, val: string): Promise<void> {
  return openDb().then((db) => {
    if (!db) return
    return new Promise<void>((resolve) => {
      let t: IDBTransaction
      try { t = db.transaction(STORE, 'readwrite') } catch { resolve(); return }
      t.objectStore(STORE).put(val, key)
      t.oncomplete = () => resolve()
      t.onerror = () => resolve()
    })
  })
}

// --- engine bootstrap ----------------------------------------------------
interface MathJaxSvgApi {
  tex2svg(tex: string, opts?: { display?: boolean }): HTMLElement
  startup?: { promise?: Promise<unknown> }
}
declare global {
  interface Window { MathJax?: unknown }
}

let readyPromise: Promise<MathJaxSvgApi> | null = null

function currentApi(): MathJaxSvgApi | null {
  const mj = window.MathJax as MathJaxSvgApi | undefined
  return mj && typeof mj.tex2svg === 'function' ? mj : null
}

/** True once the engine is live and baking is instant. The editor uses this to
 *  say "loading…" for the one bake that has to wait on a ~2MB download. */
export function mathjaxLoaded(): boolean {
  return !!currentApi()
}

/** Hex SHA-256 of a UTF-8 string. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Does this text hash to the pinned engine build? */
export async function isPinnedEngine(js: string): Promise<boolean> {
  return (await sha256Hex(js)) === ENGINE_SHA256
}

/** Fetch the engine from the first candidate that answers with the PINNED
 *  bytes. Errors are collected so a total failure reports something actionable
 *  rather than the last 404. */
async function fetchEngine(): Promise<string> {
  const urls = engineUrls()
  const failures: string[] = []
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'force-cache' })
      if (!res.ok) { failures.push(`${url} → ${res.status}`); continue }
      const js = await res.text()
      // A tiny response is a login/redirect page, not the engine. (Cheap
      // pre-check; the hash below is the real gate — unpkg has been observed
      // answering 200 with a 21-byte "Internal Server Error".)
      if (js.length < 10000) { failures.push(`${url} → not the engine`); continue }
      if (!(await isPinnedEngine(js))) {
        failures.push(`${url} → wrong bytes (expected MathJax ${MATHJAX_VERSION}, sha256 ${ENGINE_SHA256.slice(0, 12)}…)`)
        continue
      }
      return js
    } catch (ex) {
      failures.push(`${url} → ${(ex as Error).message}`)
    }
  }
  throw new Error(`Could not load the math engine. Tried:\n${failures.join('\n')}`)
}

/** Load + initialise MathJax's tex-svg component once. Idempotent; safe to call
 *  on every math insert. Rejects (with a human message) when offline and the
 *  engine isn't cached, or when every source fails. */
export function ensureMathjax(): Promise<MathJaxSvgApi> {
  const live = currentApi()
  if (live) return Promise.resolve(live)
  if (readyPromise) return readyPromise

  readyPromise = (async () => {
    // The cache is re-verified on every read, not just on write: IndexedDB is
    // same-origin storage like any other, so a cached engine is only as
    // trustworthy as the last thing that could write to it. Hashing 2MB costs
    // a few ms against a 2MB download.
    let js = await idbGet(CACHE_KEY)
    if (js && !(await isPinnedEngine(js))) js = null
    if (!js) {
      if (offlineEnabled()) {
        throw new Error('Math engine unavailable offline')
      }
      js = await fetchEngine()
      // cache-and-forget; a failed put just means we refetch next session
      idbPut(CACHE_KEY, js).catch(() => {})
    }

    // Configure BEFORE the component script runs. fontCache:'local' keeps each
    // formula's glyph defs inside its own <svg>, so every baked formula is
    // independently self-contained (copy/paste across decks just works, and
    // deleting an element strands nothing). typeset:false — we drive tex2svg by
    // hand, never scan the page (that would try to typeset the whole editor).
    ;(window as Window).MathJax = {
      tex: { inlineMath: [['$', '$']], displayMath: [['$$', '$$']] },
      svg: { fontCache: 'local' },
      startup: { typeset: false },
    }

    await injectScript(js)
    const api = currentApi()
    if (!api) throw new Error('Math engine failed to initialise')
    await api.startup?.promise
    return api
  })()

  // don't cache a rejection — allow a later retry (e.g. after going online)
  readyPromise.catch(() => { readyPromise = null })
  return readyPromise
}

function injectScript(js: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([js], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    const s = document.createElement('script')
    s.src = url
    s.onload = () => { URL.revokeObjectURL(url); resolve() }
    s.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Math engine script error')) }
    document.head.appendChild(s)
  })
}

// --- baking --------------------------------------------------------------

export interface BakedMath {
  /** self-contained <svg> markup; glyphs paint `currentColor` */
  svg: string
  /** intrinsic height in `ex` units (font-relative — matches surrounding prose) */
  heightEx: number
  /** baseline offset for inline placement, e.g. "-0.566ex" */
  valign: string
}

function typeset(tex: string, api: MathJaxSvgApi, display: boolean): BakedMath {
  const container = api.tex2svg(tex, { display })
  const svg = container.querySelector('svg')
  if (!svg) throw new Error('No SVG produced')
  const err = svg.querySelector('[data-mml-node="merror"]')
  if (err) throw new Error(err.textContent?.trim() || 'Invalid LaTeX')

  const heightEx = parseFloat(svg.getAttribute('height') || '0') || 0
  const valign = (svg.style.verticalAlign || '0').trim()
  // Strip the container's inline sizing/vertical-align off the root — the host
  // owns layout and re-applies what it needs; keep the intrinsic viewBox.
  svg.removeAttribute('style')
  // MathJax writes xmlns as a literal attribute, and the element is already IN
  // the SVG namespace — some serializers then emit the declaration twice,
  // producing markup that is not well-formed XML. Drop the literal one and let
  // the serializer declare the namespace itself, exactly once.
  svg.removeAttribute('xmlns')
  normalizeHrefs(svg)
  // Ink is NOT baked: MathJax already paints stroke/fill `currentColor`, and an
  // inlined <svg> inherits it, so colour stays a live CSS property.
  const markup = new XMLSerializer().serializeToString(svg)
  return { svg: markup, heightEx, valign }
}

const XLINK_NS = 'http://www.w3.org/1999/xlink'

/**
 * Rewrite MathJax's SVG 1.1 `xlink:href` glyph references to plain SVG 2
 * `href`, and drop the now-unused xlink namespace.
 *
 * This matters more than it looks. XMLSerializer only keeps the `xlink:` prefix
 * if that prefix is bound in scope; otherwise it invents one and emits
 * `ns1:href="#…"`. Downstream code that looks for `href` or `xlink:href` by
 * qualified name then misses it — the sanitizer would drop the attribute as
 * unknown and every glyph would vanish. Normalising here means the stored
 * markup has exactly one spelling, whatever the serializer felt like doing.
 */
function normalizeHrefs(root: SVGElement) {
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(node.attributes)) {
      if (attr.localName === 'href' && attr.namespaceURI === XLINK_NS) {
        node.setAttribute('href', attr.value)
        node.removeAttributeNS(XLINK_NS, 'href')
      }
      if (attr.localName === 'xlink' && attr.value === XLINK_NS) node.removeAttribute(attr.name)
    }
  }
}

/** Bake a standalone equation into self-contained SVG markup.
 *
 *  `tags` are optional morph hints: each `{tex, tag}` names a sub-expression the
 *  author wants paired across a morph. They are resolved HERE, at bake time,
 *  and written into the markup as `data-bento-tag` on the matching glyphs — so
 *  presenting still needs no engine, and mathmorph.ts just reads the attribute.
 */
export async function bakeEquation(
  tex: string,
  opts: { display?: boolean; tags?: Array<{ tex: string; tag: string }> } = {},
): Promise<BakedMath> {
  const api = await ensureMathjax()
  const baked = typeset(tex, api, opts.display !== false)
  if (!opts.tags?.length) return baked
  return { ...baked, svg: applyMorphTags(baked.svg, opts.tags, api, opts.display !== false) }
}

/**
 * Resolve morph tags against baked markup.
 *
 * Each hint is baked on its own to learn the codepoint sequence its glyphs
 * produce, then that sequence is located as a contiguous run in the parent
 * formula's glyph list and those `<use>` nodes are tagged. Matching on rendered
 * glyphs rather than on TeX source means `\frac{a}{b}` and `\dfrac{a}{b}` tag
 * the same symbols, and it needs no MathJax extension packages.
 */
function applyMorphTags(
  markup: string,
  tags: Array<{ tex: string; tag: string }>,
  api: MathJaxSvgApi,
  display: boolean,
): string {
  // HTML parsing, for the same leniency reason as mathmorph.glyphAtoms
  let host: HTMLTemplateElement
  try {
    host = document.createElement('template')
    host.innerHTML = markup
  } catch {
    return markup
  }
  const doc = host.content
  const uses = Array.from(doc.querySelectorAll('use[data-c]'))
  if (!uses.length) return markup
  const seq = uses.map((u) => u.getAttribute('data-c')!)
  const taken = new Array<boolean>(uses.length).fill(false)

  for (const { tex, tag } of tags) {
    if (!tex.trim() || !tag.trim()) continue
    let needle: string[]
    try {
      const sub = typeset(tex, api, display)
      const subHost = document.createElement('template')
      subHost.innerHTML = sub.svg
      needle = Array.from(subHost.content.querySelectorAll('use[data-c]')).map((u) => u.getAttribute('data-c')!)
    } catch {
      continue // an unparseable hint is ignored, never fatal
    }
    if (!needle.length) continue
    for (let i = 0; i + needle.length <= seq.length; i++) {
      if (taken[i]) continue
      let hit = true
      for (let j = 0; j < needle.length; j++) {
        if (seq[i + j] !== needle[j] || taken[i + j]) { hit = false; break }
      }
      if (!hit) continue
      for (let j = 0; j < needle.length; j++) {
        uses[i + j].setAttribute('data-bento-tag', tag)
        taken[i + j] = true
      }
      break // first occurrence only — a tag names one sub-expression
    }
  }
  const out = doc.querySelector('svg')
  return out ? new XMLSerializer().serializeToString(out) : markup
}

/** Bake a 'note' cell: prose (HTML-escaped, deck font) with inline `$…$` /
 *  block `$$…$$` math inlined as <svg> spans. Returns the html string, which
 *  the renderer sanitizes before it ever reaches innerHTML. */
export async function bakeMathCell(source: string): Promise<string> {
  const api = await ensureMathjax()
  let out = ''
  for (const part of splitMath(source)) {
    if (part.tex === undefined) {
      out += escapeHtml(part.text).replace(/\n/g, '<br>')
      continue
    }
    const { svg, heightEx, valign } = typeset(part.tex, api, part.display)
    const style = `height:${heightEx}ex;vertical-align:${valign};` +
      (part.display ? 'display:block;margin:0.4em auto;' : '')
    out += `<span class="bento-math-inline" style="${style}"` +
      ` role="math" aria-label="${escapeHtml(part.tex)}">${svg}</span>`
  }
  return out
}

/** Index of the next UNESCAPED `delim` at or after `from`, or -1. A backslash
 *  escapes the character after it, so `\$` inside a formula stays a literal
 *  dollar (which is what it means in LaTeX) instead of closing the run early. */
function findClose(src: string, from: number, delim: string): number {
  for (let i = from; i <= src.length - delim.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (src.startsWith(delim, i)) return i
  }
  return -1
}

/**
 * Split prose into text runs and math runs. `$$…$$` is display math, `$…$` is
 * inline; a backslash-escaped `\$` is a literal dollar and never opens OR
 * closes a run (mirroring the markdown escape convention in
 * editor/markdown.ts). In a text run the escape is consumed; inside a formula
 * it is passed through to MathJax, which renders `\$` as a dollar sign.
 */
export function splitMath(src: string): Array<{ text: string; tex?: string; display: boolean }> {
  const out: Array<{ text: string; tex?: string; display: boolean }> = []
  let text = ''
  let i = 0
  const pushText = () => { if (text) { out.push({ text, display: false }); text = '' } }
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && src[i + 1] === '$') { text += '$'; i += 2; continue }
    if (c === '$') {
      const display = src[i + 1] === '$'
      const open = display ? 2 : 1
      const close = findClose(src, i + open, display ? '$$' : '$')
      if (close > i + open) {
        pushText()
        out.push({ text: '', tex: src.slice(i + open, close), display })
        i = close + open
        continue
      }
    }
    text += c
    i++
  }
  pushText()
  return out
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
