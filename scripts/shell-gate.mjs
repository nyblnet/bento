#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// CONFORMANCE GATE — old updaters are frozen code; every shell must satisfy
// the splice contract they rely on (see postbuild-compress.mjs): plaintext
// #bento-doc, regex-extractable, balanced script tags, and a v0.1.0-style
// text splice must produce a well-formed document.
//
// It also covers the SECOND class of plaintext block: `application/bento+*`
// data blocks written by kernel/src/save.ts `registerShellBlocks` — language
// packs today (docs/i18n-packs.md), other version-bound extras later. A pack
// body is arbitrary translated text from the release channel, so unlike the
// document it is not shaped by us: it can contain `<`, quotes, non-ASCII, and
// — if nothing stopped it — the literal sequence that closes a script tag.
// A fresh build carries no packs, so the gate SYNTHESIZES an adversarial one
// and proves the contract holds with it in the file (and, as a negative
// control, that the same pack written *unescaped* is caught).
//
// A THIRD invariant is about size rather than correctness: the runtime ships
// DEFLATED, and a save must not quietly turn it back into plaintext. The
// loader inflates the app stylesheet into a <style> at boot, and a save clones
// the live document — so unless that node is marked `data-bento-transient` for
// `serializeBody` to strip, every save writes ~100KB of CSS into the file and
// the next boot appends another copy. It is invisible in review and unbounded
// in a shipped file, so the gate checks the artifact for it.
//
// The `<`-escape rule is deliberately restated here rather than imported: a
// gate that shares code with the thing it gates cannot notice the thing
// drifting. The one link back to the implementation is a source assertion
// (checkEscapeIsImplemented) that the rule is still applied on both write
// paths in kernel/src/save.ts.
//
// One implementation, two callers: release.mjs runs it before signing, and
// CI runs it on every PR's build (node scripts/shell-gate.mjs <shell.html>).
// CI validating the contract is NOT a release — signing stays local-only
// (docs/RELEASING.md); this file must never touch keys or manifests.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

// Never write these literals: this file is not bundled, but the habit is the
// hard rule (AGENTS.md #1) and the adversarial fixtures below need them as
// data, not as tokens the reader's tooling might act on.
const SCRIPT_CLOSE = '</scr' + 'ipt>'
const DOC_BLOCK_OPEN = '<script type="application/bento+json" id="bento-doc">'
const DOC_BLOCK_RE = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/

/** The escape every plaintext Bento block is written with. `<` can then never
 *  start a close tag, a comment, or a nested `<script` — and stays valid JSON. */
const escapeBlockText = (json) => json.replace(/</g, '\\u003c')

const fail = (msg) => { throw new Error('GATE: ' + msg) }

// --- a small rawtext scanner ------------------------------------------------
//
// Script content is RAWTEXT: an HTML parser ends the element at the first
// `</script` followed by whitespace, `/` or `>` (case-insensitive). Modelling
// that is enough to reason about DOMParser → outerHTML without a DOM in node,
// because the escaped/double-escaped script-data states it ignores can only be
// entered through a raw `<` — which every check below forbids in a data block.

const CLOSE_RE = /<\/script[\s/>]/i

/** Index of the parser-visible end of script data starting at `from`, or -1. */
function scriptDataEnd(html, from) {
  const rest = html.slice(from)
  const m = rest.match(CLOSE_RE)
  return m ? from + m.index : -1
}

/** Every `<script>` in the file, with its attributes and raw text. */
function scanScripts(html) {
  const out = []
  const openRe = /<script\b([^>]*)>/gi
  let m
  while ((m = openRe.exec(html))) {
    const bodyStart = m.index + m[0].length
    const end = scriptDataEnd(html, bodyStart)
    if (end < 0) fail(`unterminated <script> at offset ${m.index}`)
    const attrs = m[1]
    out.push({
      attrs,
      id: (attrs.match(/\bid="([^"]*)"/i) ?? [])[1] ?? '',
      type: (attrs.match(/\btype="([^"]*)"/i) ?? [])[1] ?? '',
      text: html.slice(bodyStart, end),
      start: m.index,
    })
    openRe.lastIndex = end + SCRIPT_CLOSE.length
  }
  return out
}

/** HTML attribute-value escaping, as a DOM serializer does it. */
const attrValue = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')

// --- invariant 1: the frozen splice contract --------------------------------

/** The checks the gate has always run, on any candidate file. */
function checkSpliceContract(html, label) {
  if (!DOC_BLOCK_RE.test(html)) fail(`#bento-doc block not found/extractable (${label})`)
  const opens = (html.match(/<script[\s>]/g) ?? []).length
  const closes = html.split(SCRIPT_CLOSE).length - 1
  if (opens !== closes) fail(`script tag imbalance ${opens}/${closes} (${label})`)

  const fakeDoc = escapeBlockText(JSON.stringify({ format: 'bento/slides', probe: '<tag> & </close>' }))
  // function replacement throughout: `$` in generated text must stay literal
  const spliced = html.replace(DOC_BLOCK_RE, () => `${DOC_BLOCK_OPEN}\n${fakeDoc}\n${SCRIPT_CLOSE}`)
  if (!spliced.includes(fakeDoc)) fail(`splice failed (${label})`)
  const opens2 = (spliced.match(/<script[\s>]/g) ?? []).length
  const closes2 = spliced.split(SCRIPT_CLOSE).length - 1
  if (opens2 !== closes2) fail(`spliced document imbalanced (${label})`)
  return spliced
}

// --- invariant 2: every plaintext data block is escaped and lossless --------

/**
 * `application/bento+*` blocks are the app's plaintext data: the document
 * itself and anything `registerShellBlocks` writes beside it. All of them are
 * JSON with `<` escaped, so none can terminate its own script element, open a
 * comment, or forge another block's opening tag.
 */
function checkDataBlocks(html, label) {
  const blocks = scanScripts(html).filter((s) => /^application\/bento\+/.test(s.type))
  const docs = blocks.filter((b) => b.id === 'bento-doc')
  if (docs.length !== 1) fail(`expected exactly one #bento-doc, found ${docs.length} (${label})`)

  const ids = new Set()
  for (const b of blocks) {
    const where = `${b.type}#${b.id || '(no id)'} (${label})`
    if (b.id && ids.has(b.id)) fail(`duplicate block id ${b.id} (${label})`)
    if (b.id) ids.add(b.id)
    if (b.text.includes('<')) fail(`unescaped "<" in ${where} — must be written as \\u003c`)
    const text = b.text.trim()
    // The released shell ships an EMPTY doc block (the demo boots the starter
    // deck); an empty block is legal, anything present must be JSON.
    if (!text) continue
    try {
      JSON.parse(text)
    } catch (e) {
      fail(`${where} is not parseable JSON: ${e.message}`)
    }
  }
  return blocks
}

// --- invariant 3: a pack-carrying shell ------------------------------------

/**
 * A pack designed to break the file if anything is unescaped: it closes a
 * script tag, forges a `#bento-doc` opening tag (an old updater splices into
 * the FIRST match, so a forged one placed above the real block would hijack
 * the document), opens an HTML comment, and carries non-ASCII, RTL, emoji and
 * the line separators JSON leaves raw.
 */
const ADVERSARIAL_PACK = {
  app: 'slides',
  version: '9.9.9',
  // ampersand + quote: the lang also lands in the `id` and `data-lang`
  // ATTRIBUTES — a second escaping path (attrValue here, a DOM serializer
  // in the product), which must not let a pack break out of the tag.
  lang: 'zz-Adv&"ersarial',
  label: '한국어 · 日本語 · Ελληνικά · «Z» 🎌',
  strings: {
    Save: SCRIPT_CLOSE,
    Open: `${DOC_BLOCK_OPEN}{\"format\":\"bento/slides\",\"hijacked\":true}${SCRIPT_CLOSE}`,
    Close: '</SCRIPT\t> </script/ <script> <!-- --> <![CDATA[',
    Quotes: '\"\'`\\ & &amp; &quot; \u0000\u001f',
    // JSON.stringify leaves these RAW in its output: a JS parser reads them
    // as line terminators even though JSON does not.
    Separators: 'a\u2028b\u2029c',
    RTL: 'مرحبا — שלום',
  },
}

/** Exactly how kernel/src/save.ts serializes one registered block. */
function packBlockHtml(pack, { escaped = true } = {}) {
  const json = JSON.stringify(pack)
  const text = escaped ? escapeBlockText(json) : json
  return (
    `<script type="application/bento+lang" id="${attrValue('bento-lang-' + pack.lang)}"` +
    ` data-lang="${attrValue(pack.lang)}">\n${text}\n${SCRIPT_CLOSE}`
  )
}

// Function replacements: a `$` in a pack body must stay literal.
/** Insert a block where `serializeBody` does — appended to <head>. */
const withBlockInHead = (html, block) => html.replace('</head>', () => `${block}\n</head>`)
/** …and, for the forged-doc-block case, ABOVE the real #bento-doc. */
const withBlockBeforeDoc = (html, block) => html.replace(DOC_BLOCK_OPEN, () => `${block}\n${DOC_BLOCK_OPEN}`)

function checkPackCarryingShell(shell) {
  const pack = ADVERSARIAL_PACK
  const block = packBlockHtml(pack)
  const realDoc = shell.match(DOC_BLOCK_RE)[0]

  for (const [where, html] of [
    ['pack after #bento-doc', withBlockInHead(shell, block)],
    ['pack before #bento-doc', withBlockBeforeDoc(shell, block)],
  ]) {
    checkSpliceContract(html, where)
    const blocks = checkDataBlocks(html, where)

    // The forged opening tag inside the pack must not become what an updater
    // extracts — the real block, wherever the pack sits, is still the match.
    if (html.match(DOC_BLOCK_RE)[0] !== realDoc) fail(`#bento-doc extraction hijacked by a pack (${where})`)

    // Round-trip: what a parser sees in the block is byte-identical to what we
    // wrote, and JSON.parse of it reproduces the pack exactly.
    // by id, not by type: a shell may already carry real packs of its own
    const wantId = attrValue('bento-lang-' + pack.lang)
    const got = blocks.find((b) => b.id === wantId)
    if (!got) fail(`pack block not found after insertion (${where})`)
    if (got.text.trim() !== escapeBlockText(JSON.stringify(pack)))
      fail(`pack block text changed on round-trip (${where})`)
    const parsed = JSON.parse(got.text)
    if (JSON.stringify(parsed) !== JSON.stringify(pack)) fail(`pack did not round-trip losslessly (${where})`)

    // …and it survives the frozen text splice unchanged: an updater rewriting
    // the document must not disturb the languages riding beside it.
    const spliced = checkSpliceContract(html, where + ' + splice')
    if (!spliced.includes(block)) fail(`pack block did not survive the doc splice (${where})`)
    checkDataBlocks(spliced, where + ' + splice')
  }

  // NEGATIVE CONTROL — the same pack written without the escape must be
  // caught. If this passes, the checks above prove nothing.
  const raw = packBlockHtml(pack, { escaped: false })
  let caught = 0
  for (const html of [withBlockInHead(shell, raw), withBlockBeforeDoc(shell, raw)]) {
    try {
      checkSpliceContract(html, 'unescaped control')
      checkDataBlocks(html, 'unescaped control')
      if (html.match(DOC_BLOCK_RE)[0] !== realDoc) fail('hijack')
    } catch {
      caught++
    }
  }
  if (caught !== 2) fail('negative control passed — the pack-block checks have no teeth')
}

// --- invariant 4: the runtime stays compressed, and stays out of the save ---

const TRANSIENT_ATTR = 'data-bento-transient'
const PAYLOAD_TYPE = 'bento/deflate-b64'

/** Every `<style>` in the file, with its raw text. */
function scanStyles(html) {
  return Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)).map((m) => m[1])
}

/** The inflated text of each `bento/deflate-b64` payload, by id. */
function inflatePayloads(html) {
  const out = new Map()
  for (const s of scanScripts(html).filter((x) => x.type === PAYLOAD_TYPE)) {
    try {
      out.set(s.id, inflateRawSync(Buffer.from(s.text.trim(), 'base64')).toString('utf8'))
    } catch (e) {
      fail(`payload #${s.id} does not inflate: ${e.message}`)
    }
  }
  return out
}

/**
 * No payload's content may ALSO appear as plaintext in the file.
 *
 * This is the shape the bug takes on disk: the file carries the stylesheet
 * twice, once deflated (27KB, the copy the loader uses) and once as a `<style>`
 * the previous save cloned out of the live DOM (100KB, dead weight that grows
 * by another copy every save).
 */
function checkRuntimeStaysCompressed(html, label) {
  const payloads = inflatePayloads(html)
  if (!payloads.size) return false // an uncompressed build — nothing to check
  const plaintext = [
    ...scanStyles(html),
    ...scanScripts(html).filter((s) => s.type !== PAYLOAD_TYPE).map((s) => s.text),
  ]
  for (const [id, text] of payloads) {
    if (plaintext.some((body) => body.includes(text)))
      fail(`#${id} also appears as plaintext in the file — the runtime must ship deflated only (${label})`)
  }
  return true
}

/**
 * …and the two halves of the mechanism that keeps it that way, checked in the
 * ARTIFACT rather than in source: the loader marks the style it injects, and
 * the runtime it boots still strips marked nodes when it serializes. Both are
 * string literals that survive minification.
 */
function checkTransientMarking(shell) {
  const scripts = scanScripts(shell)
  const loader = scripts.find((s) => !s.type && s.text.includes('bento-rt-css'))
  if (!loader) fail('boot loader not found in the shell')
  // Specifically: it SETS the attribute. Merely mentioning the name is what
  // the loader's stale-copy sweep does, and that must not satisfy this check.
  if (!new RegExp(String.raw`setAttribute\(\s*['"]${TRANSIENT_ATTR}['"]`).test(loader.text))
    fail(
      `the boot loader injects the stylesheet without marking it ${TRANSIENT_ATTR} — ` +
        'every save would write it back as plaintext (scripts/postbuild-compress.mjs)',
    )
  const runtime = inflatePayloads(shell).get('bento-rt') ?? ''
  if (!runtime.includes(`[${TRANSIENT_ATTR}]`))
    fail(
      `the runtime no longer strips [${TRANSIENT_ATTR}] when serializing — ` +
        'saved files would grow by the stylesheet on every save (kernel/src/save.ts)',
    )

  // NEGATIVE CONTROL — a shell carrying the inflated stylesheet as plaintext
  // (exactly what a save produced before the marker existed) must be caught.
  const css = inflatePayloads(shell).get('bento-rt-css')
  if (css) {
    const bloated = shell.replace('</head>', () => `<style>${css}</style>\n</head>`)
    let caught = false
    try {
      checkRuntimeStaysCompressed(bloated, 'plaintext-runtime control')
    } catch {
      caught = true
    }
    if (!caught) fail('negative control passed — the plaintext-runtime check has no teeth')
  }
}

// --- invariant 5: the product still applies the escape ----------------------

/**
 * The only assertion that reaches into the implementation. The gate works on
 * built artifacts, and a fresh shell carries no packs, so nothing above could
 * notice `serializeBody` quietly dropping the escape on the block it writes at
 * save time — which is precisely the change that would brick shipped files.
 * If a refactor moves the rule, re-point this check; do not delete it.
 */
function checkEscapeIsImplemented() {
  const src = join(repoRoot, 'kernel/src/save.ts')
  if (!existsSync(src)) return // an app repo vendored without the kernel
  const text = readFileSync(src, 'utf8')
  const applied = (text.match(/replace\(\/<\/g, *'\\\\u003c'\)/g) ?? []).length
  if (applied < 2)
    fail(
      'kernel/src/save.ts no longer applies the \\u003c escape on both write paths ' +
        `(#bento-doc and registerShellBlocks) — found ${applied}`,
    )
}

// --- invariant 5: a preview-carrying shell ---------------------------------
//
// The THIRD class of plaintext content a saved file carries: the static
// first-page preview `kernel/src/save.ts` writes as a `[data-bento-preview]`
// element, followed by a parser-blocking remover script that deletes it before
// the page is ever painted (docs/DECISIONS.md). Like a language pack it is not
// shaped by us — it is rendered from whatever the author typed on page one —
// but unlike a pack it is HTML, not JSON in a script block, so the `<`
// escape does not and cannot apply to it. Its safety rests on the kernel
// REFUSING to emit markup containing a script tag, which is what this checks —
// and that refusal carries MORE weight now the preview lands in the live DOM
// instead of sitting inert inside a `<noscript>`.

const NOSCRIPT_CLOSE = '</nosc' + 'ript>'
const SCRIPT_OPEN_TAG = '<scr' + 'ipt'

/** A preview whose content came from a hostile deck: entity-escaped exactly as
 *  a DOM serializer escapes text, plus quotes, RTL, emoji and separators. */
const ADVERSARIAL_PREVIEW =
  `<div data-bento-preview="1"><div style="position:fixed;left:0;top:0;background:#0D1B2E">` +
  `<div>&lt;/script&gt; &lt;script&gt;alert(1)&lt;/script&gt; ` +
  `&lt;script type="application/bento+json" id="bento-doc"&gt;{"hijacked":true}&lt;/script&gt;` +
  `&lt;/noscript&gt; &lt;!-- --&gt; &lt;![CDATA[ &amp; &quot; ' \` \\ ` +
  `مرحبا שלום 🎌 a b c</div>` +
  `</div></div>` +
  // the remover that now ships beside every preview: a REAL script element,
  // so the shell's open/close balance has to survive one more of them
  `${SCRIPT_OPEN_TAG} data-bento-preview="1">/* remover */${SCRIPT_CLOSE}`

/** …and the same content with the escapes NOT applied — what the kernel's
 *  `previewIsSafe` refusal exists to keep out of a file. */
const UNSAFE_PREVIEW =
  `<div data-bento-preview="1"><div>${SCRIPT_CLOSE} ` +
  `${DOC_BLOCK_OPEN}{"hijacked":true}${SCRIPT_CLOSE}</div></div>`

/** Insert a preview where `writePreview` does — straight after the splash. */
const withPreview = (html, preview) =>
  html.includes('<div id="bento-splash"')
    ? html.replace('<div id="app">', () => `${preview}\n    <div id="app">`)
    : html.replace('</body>', () => `${preview}\n</body>`)

function checkPreviewCarryingShell(shell) {
  const realDoc = shell.match(DOC_BLOCK_RE)[0]
  const html = withPreview(shell, ADVERSARIAL_PREVIEW)

  checkSpliceContract(html, 'preview-carrying shell')
  checkDataBlocks(html, 'preview-carrying shell')
  if (html.match(DOC_BLOCK_RE)[0] !== realDoc) fail('#bento-doc extraction hijacked by a preview')

  // …and the preview survives the frozen text splice untouched: an updater
  // rewriting the document must not disturb the thumbnail riding beside it.
  const spliced = checkSpliceContract(html, 'preview-carrying shell + splice')
  if (!spliced.includes(ADVERSARIAL_PREVIEW)) fail('preview did not survive the doc splice')
  checkDataBlocks(spliced, 'preview-carrying shell + splice')

  // NEGATIVE CONTROL — the unescaped form must be caught. If it is not, the
  // check above proves nothing about why the escaped form is safe.
  let caught = false
  try {
    checkSpliceContract(withPreview(shell, UNSAFE_PREVIEW), 'unsafe preview control')
  } catch {
    caught = true
  }
  if (!caught) fail('negative control passed — the preview checks have no teeth')
}

/**
 * Source assertions for the preview, for the same reason as the escape one
 * above: a fresh shell carries no preview, so nothing in the built artifact
 * could notice these rules being dropped at save time.
 *
 * Two rules, both silent failures if they go: the ENCRYPTION VETO (a
 * `bento/enc` deck must never ship a plaintext rendering of page one beside
 * its ciphertext) and the OUTPUT REFUSAL (`previewIsSafe`, which is the only
 * thing standing between author content and an unbalanced script tag).
 */
function checkPreviewRulesAreImplemented() {
  const src = join(repoRoot, 'kernel/src/save.ts')
  if (!existsSync(src)) return // an app repo vendored without the kernel
  const text = readFileSync(src, 'utf8')
  if (!/previewAllowed\s*\(\s*body\s*\)/.test(text))
    fail('kernel/src/save.ts no longer gates the first-page preview on previewAllowed(body) — an encrypted deck could ship a plaintext page one')
  if (!/parseEnvelope\(body\) === null/.test(text) || !/!encrypted/.test(text))
    fail('kernel/src/save.ts previewAllowed no longer checks BOTH the password flag and the body envelope')
  if (!/previewIsSafe\(host\.innerHTML\)/.test(text))
    fail('kernel/src/save.ts no longer refuses unsafe first-page preview markup')
  // The preview is a full-bleed overlay. Since it left <noscript> it is live
  // markup, and the remover is the ONLY thing keeping it off a reader's screen.
  if (!/PREVIEW_REMOVER/.test(text) || !/removeChild/.test(text))
    fail('kernel/src/save.ts no longer emits the preview remover — every reader would stare at page one')
  if (!/insertBefore\(remover, host\.nextSibling\)/.test(text))
    fail('kernel/src/save.ts no longer places the remover immediately after the preview — a frame could paint between the two')
}

/** Throws with a GATE: message on the first violated invariant. */
export function gateShell(shellPath) {
  const shell = readFileSync(shellPath, 'utf8')
  checkSpliceContract(shell, 'shell')
  checkDataBlocks(shell, 'shell')
  checkPackCarryingShell(shell)
  checkPreviewCarryingShell(shell)
  const compressed = checkRuntimeStaysCompressed(shell, 'shell')
  if (compressed) checkTransientMarking(shell)
  checkEscapeIsImplemented()
  checkPreviewRulesAreImplemented()
  console.log(
    'conformance gate: old-updater splice contract OK (incl. pack- and preview-carrying shells)' +
      (compressed ? '; runtime ships deflated only' : ''),
  )
}

// CLI: node scripts/shell-gate.mjs <path-to-shell.html>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/shell-gate.mjs <shell.html>')
    process.exit(2)
  }
  gateShell(target)
}
