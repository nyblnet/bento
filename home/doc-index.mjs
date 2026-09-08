// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE REFERENCE INDEXER, and the executable half of a contract.
//
// Every bento/tray host has to answer the same questions about a file it did
// not write: is this one of ours, what is it called, which app is it, is it
// encrypted, what does its first page look like, and what words does it
// contain. `home/webext` answers them in JavaScript because it lives in a
// browser; `home/android` answers them in Kotlin and `home/ios` in Swift,
// because their list UIs are native and must stay that way (docs/DECISIONS.md,
// 2026-08-16 — putting the extension's HTML library in a WebView costs ~0.5s of
// cold start, iOS its system document browser, and both their accessibility).
//
// Three implementations of one algorithm is a drift problem. This file is the
// reference, `home/fixtures/` is the corpus, and `scripts/test-doc-index.mjs`
// checks this implementation against it — the native ports run the SAME corpus
// from their own test rigs. The guarantee is deliberately "cannot diverge
// SILENTLY" rather than "cannot diverge": a divergence here makes search find
// less, which is visible and recoverable, unlike the writable-stream semantics
// in `home/bridge.js` that are shared outright because a divergence there
// wrote users' documents out as zero bytes.
//
// Ported from home/webext/src/library.js. If you change the algorithm, change
// it here, extend the corpus, and re-run every port.

/** The splice contract's marker — docs/PLATFORM.md §2, frozen because old
 *  updaters depend on it. A Bento document is one because of what is INSIDE
 *  it, not what it is called: files get renamed to `deck.html` to email them,
 *  saved as `Q3(1).html`, downloaded without the compound extension. */
export const MARKER = 'id="bento-doc"'

/** How much to read before deciding a file is not ours. The marker sits ~5.8KB
 *  into a real shell, after the chrome and the notice, so this is generous —
 *  and it runs against every stray .html in a granted folder, most of which
 *  are not ours, so it is deliberately smaller than HEAD_BYTES. */
export const SNIFF_BYTES = 64 * 1024

/** Enough to reach the title, which lives inside the block. The block itself
 *  runs to megabytes when a document carries images — the trap an earlier
 *  metadata reader fell into by looking for the CLOSING tag and so finding
 *  nothing in any document with a picture in it. */
export const HEAD_BYTES = 300 * 1024

/** How much extracted prose to keep. Enough for any phrase somebody would
 *  search for; far short of storing the document twice. */
export const TEXT_BUDGET = 40 * 1024

export const isDocument = (head) => head.includes(MARKER)

export const titleOf = (head) =>
  head.match(/"title"\s*:\s*"((?:[^"\\]|\\.){0,200})"/)?.[1] ?? null

/** Which Bento this is. A pristine shell has no document yet, so no format:
 *  that is not a failure, it is a document nobody has saved. */
export const appOf = (head) =>
  head.match(/"format"\s*:\s*"bento\/([a-z]+)"/)?.[1] ?? null

/** An encrypted document gets NO text and NO preview. That is a privacy rule,
 *  not an optimisation: a plaintext title page beside the ciphertext is the
 *  leak the password exists to prevent. */
export const isEncrypted = (head) =>
  /"format"\s*:\s*"bento\/enc"/.test(head) || /data-bento-enc/.test(head)

/** The still render of page one that every save writes into the shell
 *  (kernel/src/preview.ts) so file managers can thumbnail it. Self-contained
 *  and self-scaling, so it drops into a small sandboxed view with no work. */
export function previewOf(whole) {
  const start = whole.indexOf('<div data-bento-preview')
  if (start === -1) return null
  const end = whole.indexOf('<script data-bento-preview', start)
  return end > start ? whole.slice(start, end) : null
}

/**
 * The words a document actually contains.
 *
 * Deliberately NOT a JSON parse. The block runs to megabytes with images
 * inline, every app shapes it differently (slides put prose in `element.html`,
 * spaces in blocks, dash in cells), and a parser that has to know the format is
 * a parser that breaks when the format moves. Pulling string VALUES out —
 * `:"…"`, never keys — is format-agnostic and degrades to "finds less" rather
 * than "throws".
 *
 * Data URIs go FIRST: one embedded image is bigger than every word in the
 * document and would dominate both the work and the budget.
 */
export function extractText(html) {
  const start = html.indexOf(MARKER)
  if (start === -1) return null
  const end = html.indexOf('</script>', start)
  if (end === -1) return null

  let block = html.slice(start, end)
  block = block.replace(/data:[^"\\]{200,}/g, ' ')      // embedded media
  const out = []
  let size = 0
  for (const m of block.matchAll(/:"((?:[^"\\]|\\.){1,400})"/g)) {
    const v = m[1]
    if (!/[A-Za-z]{3,}/.test(v)) continue               // ids, colours, numbers
    out.push(v)
    size += v.length
    if (size > TEXT_BUDGET) break
  }
  return out.join(' ')
    .replace(/<[^>]{1,200}>/g, ' ')                     // element html
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_BUDGET) || null
}

/** Everything a host needs about one file, from the bytes it already read. */
export function describe(whole) {
  const head = whole.slice(0, HEAD_BYTES)
  if (!isDocument(whole.slice(0, SNIFF_BYTES))) {
    return { isDocument: false, title: null, app: null, encrypted: false, preview: null, text: null }
  }
  const encrypted = isEncrypted(head)
  return {
    isDocument: true,
    title: titleOf(head),
    app: appOf(head),
    encrypted,
    preview: encrypted ? null : previewOf(whole),
    text: encrypted ? null : extractText(whole),
  }
}
