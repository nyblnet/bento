// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Self-saving: a Bento file writes itself back to disk with updated data.
//
// At boot (before the app mutates the DOM) we deep-clone the document. On save
// we swap the clone's data block content for the current model JSON and
// serialize the clone back to an HTML string — byte-for-byte the same app
// shell, new document inside. TiddlyWiki pioneered this trick.

import type { KernelDoc } from './doc.ts'
import { appConfig } from './app.ts'

const DATA_BLOCK_ID = 'bento-doc'
// Split so the literal never appears in the bundle (it would terminate the
// inline <script> that carries this very code inside a built Bento file).
const SCRIPT_CLOSE = '</scr' + 'ipt>'

/**
 * DOM the runtime injects at boot and that must NEVER reach a saved file.
 *
 * capturePristine() clones the live document, and the compressed shell's
 * loader has already inflated the app stylesheet into a <style> by then (see
 * scripts/postbuild-compress.mjs). Serializing the clone as-is wrote that
 * ~100KB of CSS back as PLAINTEXT — and the next boot inflated the payload and
 * appended another copy, so every save grew the file by another 100KB, forever.
 * The CSS ships deflated in the #bento-rt-css payload for a reason; the saved
 * file must carry it exactly once, compressed.
 *
 * So: anything injected before the pristine capture carries this attribute and
 * is stripped from every serialized shell. The kernel does not care what the
 * node is — only that the app declared it runtime-owned.
 */
const TRANSIENT_SELECTOR = '[data-bento-transient]'

let pristine: Document | null = null

/** Call first thing at boot, before any DOM mutation. */
export function capturePristine() {
  pristine = document.cloneNode(true) as Document
}

export function readEmbeddedDoc(): string | null {
  const block = document.getElementById(DATA_BLOCK_ID)
  const text = block?.textContent?.trim()
  return text || null
}

/**
 * Extra plaintext blocks the app wants written into every saved shell —
 * language packs today (docs/i18n-packs.md), whatever else later. The kernel
 * stays ignorant of what they mean: it is told an id, a type and a JSON body,
 * and guarantees only that they survive a save the same way #bento-doc does.
 *
 * The full set is re-declared on every serialize, so dropping one from the
 * list removes it from the next saved file — that is how "remove from this
 * file" works without a second API.
 */
export interface ShellBlock {
  id: string
  type: string
  /** JSON text; `<` is escaped on write exactly as the doc block's is */
  body: string
  attrs?: Record<string, string>
}
let shellBlocks: () => ShellBlock[] = () => []
let managedTypes: string[] = []

/**
 * Register the provider consulted on every serialize, and the block types it
 * OWNS. Call once, at boot.
 *
 * The types are declared rather than inferred from what the provider returns,
 * because the empty list is meaningful: "this file should carry no language
 * pack" has to clear the blocks the file arrived with, and a set derived from
 * the blocks about to be written would be empty exactly then — leaving the
 * last removed pack in the file (it would come back on the next open).
 */
export function registerShellBlocks(fn: () => ShellBlock[], types: string[]): void {
  shellBlocks = fn
  managedTypes = types
}

/** Every extra block currently in THIS document (as loaded from disk). */
export function readShellBlocks(type: string): Array<{ id: string; body: string; el: Element }> {
  return Array.from(document.querySelectorAll(`script[type="${type}"]`)).map((el) => ({
    id: el.id,
    body: (el.textContent ?? '').trim(),
    el,
  }))
}

/** Serialize a raw data-block body into an app shell. */
function serializeBody(shell: Document, body: string, doc: KernelDoc): string {
  const clone = shell.cloneNode(true) as Document

  // Runtime-injected DOM is not part of the shell (see TRANSIENT_SELECTOR).
  for (const el of Array.from(clone.querySelectorAll(TRANSIENT_SELECTOR))) el.remove()

  // Re-declare the app's extra blocks: drop every one of a managed type, then
  // write the current set back. Removing a language from the file is therefore
  // just "stop listing it" — no deletion path to get wrong. The clear-set is
  // the DECLARED types, never the types about to be written: an empty write
  // set still has to clear (that is what removing the file's last pack looks
  // like).
  const wanted = shellBlocks()
  for (const type of new Set([...managedTypes, ...wanted.map((b) => b.type)])) {
    for (const stale of Array.from(clone.querySelectorAll(`script[type="${type}"]`))) stale.remove()
  }
  for (const b of wanted) {
    const el = clone.createElement('script')
    el.setAttribute('type', b.type)
    el.id = b.id
    for (const [k, v] of Object.entries(b.attrs ?? {})) el.setAttribute(k, v)
    // same <-escape as the doc block: these can never contain "</script>"
    el.textContent = '\n' + b.body.replace(/</g, '\\u003c') + '\n'
    clone.head.appendChild(el)
  }

  let block = clone.getElementById(DATA_BLOCK_ID)
  if (!block) {
    block = clone.createElement('script')
    block.setAttribute('type', 'application/bento+json')
    block.id = DATA_BLOCK_ID
    clone.head.appendChild(block)
  }
  // <-escape so the JSON can never contain "</script>" and break the file.
  block.textContent = '\n' + body.replace(/</g, '\\u003c') + '\n'

  writePreview(clone, body, doc)

  const titleEl = clone.querySelector('title')
  if (titleEl) titleEl.textContent = doc.title + ' — ' + appConfig().appName

  const html = '<!DOCTYPE html>\n' + clone.documentElement.outerHTML
  // Belt-and-braces: an unescaped close tag anywhere in generated output would
  // corrupt the file; this should never trigger given the escaping above.
  if (html.split(SCRIPT_CLOSE).length !== clone.querySelectorAll('script').length + 1) {
    console.warn('bento: unexpected script-close count in serialized file')
  }
  return html
}

// --- static first-page preview (file-manager thumbnails) ---------------------
//
// THE PROBLEM. A Bento file is one HTML document, and thumbnailers — iOS
// Files, macOS QuickLook/Finder, the bento/home app — render HTML with
// JavaScript DISABLED (verified: `qlmanage -t` renders <noscript> content).
// Until our runtime boots, every deck genuinely IS the same bytes plus the
// boot splash, so every deck thumbnailed as the same dark box.
//
// THE FIX. At save time we write a STATIC rendering of page one into the file
// and park it inside a `<noscript>`. That element's contents are rendered only
// when scripting is off, which is exactly the population we are addressing:
// a real reader never sees it — not for a frame — so there is no flash to
// suppress, no interaction with the splash's `.done`/`bsAuto` dismissal, and
// nothing for print or present to exclude. When a thumbnailer runs scripts
// after all, the preview is simply never rendered and we are back to today's
// behaviour: a regression is not possible, only an improvement.
//
// It is shell FURNITURE, not document data: nothing here enters `#bento-doc`,
// no format field is added, and a file saved by an older build (which has no
// preview) opens identically.
//
// The kernel knows nothing about how any app draws a page. It owns the
// placement, the replace-don't-append rule, the encryption veto and the
// output-safety check; the app hands back a ready-made element.

const PREVIEW_ATTR = 'data-bento-preview'

/** Builds the app's static first-page rendering. Return null for "no preview". */
export type PreviewProvider = (doc: KernelDoc) => HTMLElement | null

let previewProvider: PreviewProvider | null = null

/** Register the app's first-page renderer. Call once, at boot. Optional — an
 *  app that registers nothing simply saves files without a preview. */
export function registerPreview(fn: PreviewProvider): void {
  previewProvider = fn
}

/**
 * May this saved file carry a plaintext preview of its first page?
 *
 * NO for an encrypted deck, and this is the single most important rule here.
 * The whole point of the `bento/enc` envelope is that the content is
 * unreadable on disk without the password; rendering page one in plaintext
 * beside the ciphertext would hand an attacker the title slide — usually the
 * most disclosive page in the deck — and would do it silently, because the
 * owner would never see the markup they were shipping. A missing thumbnail is
 * the correct, expected cost of encrypting a file.
 *
 * Two independent tests, because they fail independently: the in-memory
 * password flag covers the live session, and re-parsing the body covers any
 * path that hands us an already-encrypted block without the flag set.
 *
 * Pure and exported so `scripts/test-preview.ts` can exercise it directly —
 * the surrounding DOM work is not unit-testable in node, this decision is.
 */
export function previewAllowed(body: string, encrypted = isEncryptionActive()): boolean {
  return !encrypted && parseEnvelope(body) === null
}

// Built by concatenation for the usual reason (AGENTS.md #1): these literals
// must never appear in a Bento bundle, which is itself inline script.
// Note the close forms carry no ">": an HTML parser ends a script element at
// `</script` followed by whitespace, `/` or `>`, so `</script foo>` closes it
// just as surely as the tidy form does.
const SCRIPT_OPEN = '<scr' + 'ipt'
const SCRIPT_CLOSE_START = '</scr' + 'ipt'
const NOSCRIPT_CLOSE = '</nosc' + 'ript'
const STYLE_OPEN = '<sty' + 'le'
const STYLE_CLOSE_START = '</sty' + 'le'

/**
 * The preview's one stylesheet, and nothing hiding inside it.
 *
 * `<style>` is a RAW TEXT element: its content is not escaped on the way out, so
 * whatever a provider puts in it is written to the file verbatim. Every app's
 * preview has one (slides and dash hoist repeated declarations into it, spaces
 * writes a sheet), and every one of them builds declarations out of AUTHOR
 * data — colours, fonts, sizes. A single `</style>` in one of those values ends
 * the element early and everything after it is live markup in the reader's DOM,
 * outside `#bento-doc`, at parse time, before the remover runs.
 *
 * A flat "refuse any `<style`" would be simpler and would refuse EVERY preview,
 * so the rule is shaped like the tokenizer instead: at most one style element,
 * no `<` anywhere in its text (the breakout attempt is itself a `<`), and no
 * second opener or stray closer anywhere around it. That last clause is what
 * catches the tidy version of the attack, which re-opens a style after the
 * markup it smuggled in and leaves the tag counts balanced.
 */
function styleIsInert(lower: string): boolean {
  const open = lower.indexOf(STYLE_OPEN)
  if (open < 0) return !lower.includes(STYLE_CLOSE_START)
  if (lower.slice(0, open).includes(STYLE_CLOSE_START)) return false
  const gt = lower.indexOf('>', open)
  if (gt < 0) return false
  const end = lower.indexOf(STYLE_CLOSE_START, gt)
  if (end < 0) return false
  const rest = lower.slice(end + STYLE_CLOSE_START.length)
  return !lower.slice(gt + 1, end).includes('<') &&
    !rest.includes(STYLE_OPEN) && !rest.includes(STYLE_CLOSE_START)
}

/**
 * Refuse any preview markup that could unbalance the file.
 *
 * The preview is generated from user content, so it is not shaped by us. A
 * `<script>`/`</script>` in it would break the open/close balance the frozen
 * splice contract (and `scripts/shell-gate.mjs`) depends on. `</noscript>` is
 * still refused although the preview no longer lives in a `<noscript>`: it
 * costs nothing, and a document written by an older Bento may still carry one.
 *
 * This check got MORE load-bearing when the preview left `<noscript>`. It is no
 * longer inert markup that only a scripting-less renderer ever parses — it now
 * lands in the live DOM of every reader's page until the remover runs.
 *
 * The app sanitizes its own output; this is the kernel refusing to take its
 * word for it. Dropping the preview costs a thumbnail. Emitting it anyway could
 * brick the file — or, through the preview's own stylesheet, put live markup in
 * the reader's DOM; see styleIsInert for the half escaping cannot reach.
 *
 * Exported for `scripts/test-preview.ts`, like previewAllowed.
 */
export function previewIsSafe(html: string): boolean {
  const lower = html.toLowerCase()
  if (lower.includes(SCRIPT_OPEN) || lower.includes(SCRIPT_CLOSE_START) || lower.includes(NOSCRIPT_CLOSE)) return false
  return styleIsInert(lower)
}

/**
 * Deletes the preview, and itself, the instant the parser reaches it.
 *
 * Parser-BLOCKING on purpose: a classic inline script placed immediately after
 * the preview runs before the parser continues, so the browser never paints a
 * frame containing it. That is what makes this free for readers.
 *
 * It is written as a string rather than built from a template because it must
 * stay one line and contain no `</script>`.
 */
const PREVIEW_REMOVER =
  `(function(){var a=document.querySelectorAll('[${PREVIEW_ATTR}]');` +
  `for(var i=a.length;i--;){var n=a[i];if(n.parentNode)n.parentNode.removeChild(n)}})()`

function writePreview(clone: Document, body: string, doc: KernelDoc): void {
  // REPLACE, NEVER APPEND. `capturePristine()` snapshots the document as it
  // was loaded, so the shell we are cloning already carries the preview the
  // PREVIOUS save wrote; appending would stack a new one on every ⌘S until the
  // file was mostly stale previews. Removing unconditionally — before deciding
  // whether to write a new one — is also how a preview correctly DISAPPEARS
  // when a plaintext deck gains a password, or when an app stops providing
  // one. Both of those are silent leaks if the removal is conditional.
  // The selector is deliberately attribute-only: it must sweep the host AND the
  // remover script beside it, and it must still find previews written by an
  // older Bento, which parked them in a <noscript>.
  for (const stale of Array.from(clone.querySelectorAll(`[${PREVIEW_ATTR}]`))) stale.remove()

  if (!previewProvider || !previewAllowed(body)) return

  let el: HTMLElement | null = null
  try {
    el = previewProvider(doc)
  } catch (err) {
    // A preview is a nicety; a failed save is not. Never let rendering page
    // one take the file down with it.
    console.warn('bento: first-page preview failed, saving without one', err)
    return
  }
  if (!el) return

  // ORDINARY MARKUP, NOT <noscript>, AND A PARSER-BLOCKING REMOVER.
  //
  // `<noscript>` was the obvious home and it is wrong here. It renders only
  // where scripting is DISABLED, and iOS — the platform this feature exists for
  // — satisfies neither half of that: probed with a page whose inline script
  // repaints it, the iOS thumbnailer renders neither the script's result nor
  // the <noscript>, so a deck thumbnailed as its boot splash no matter what we
  // put in the noscript.
  //
  // Since that thumbnailer runs no script, plain markup survives for it. And
  // since every real reader DOES run script, a parser-blocking inline remover
  // placed immediately after deletes the preview before the browser paints a
  // frame containing it. Both audiences get the right answer with no flash and
  // no compromise — which the <noscript> version could not manage.
  //
  // A reader with scripting genuinely off keeps the preview on screen, exactly
  // as before: without scripts the deck cannot render at all, so a still of
  // page one is the best available answer rather than a regression.
  const host = clone.createElement('div')
  host.setAttribute(PREVIEW_ATTR, '1')
  host.appendChild(clone.importNode(el, true))
  if (!previewIsSafe(host.innerHTML)) {
    console.warn('bento: first-page preview rejected as unsafe, saving without one')
    return
  }
  const remover = clone.createElement('script')
  remover.setAttribute(PREVIEW_ATTR, '1')
  remover.textContent = PREVIEW_REMOVER

  // Straight after the splash it replaces, so a thumbnailer reaches it before
  // the ~550KB of compressed payload at the end of the body. The remover goes
  // immediately after the host: any markup between them is markup the parser
  // could paint first.
  const splash = clone.getElementById('bento-splash')
  const parent = splash?.parentNode ?? clone.body ?? clone.documentElement
  const after = splash?.parentNode ? splash.nextSibling : null
  parent.insertBefore(host, after)
  parent.insertBefore(remover, host.nextSibling)
}

/**
 * Serialize `doc` into an arbitrary app shell (a parsed Bento HTML document).
 * Used with the boot-time pristine copy on every save, and by the self-update
 * flow with a freshly fetched NEWER shell — same document, new app around it.
 * PLAIN output — encryption-aware callers use serializeDocInto/serializeAuto.
 */
export function serializeWith(shell: Document, doc: KernelDoc): string {
  return serializeBody(shell, JSON.stringify(doc), doc)
}

/** The full .bento.html file content with `doc` embedded (plain). */
export function serializeFile(doc: KernelDoc): string {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  return serializeWith(pristine, doc)
}

// --- password encryption ----------------------------------------------------
//
// An encrypted file keeps the SAME plaintext #bento-doc block (the splice
// contract old updaters rely on) — but the block holds a bento/enc envelope
// instead of the document: AES-GCM-256 over the doc JSON, key derived from
// the password with PBKDF2-SHA-256. The password is held in memory for the
// session so ⌘S and self-update keep writing encrypted output.

export interface EncEnvelope {
  format: 'bento/enc'
  v: 1
  it: number
  salt: string
  iv: string
  data: string
}

/**
 * PBKDF2 rounds for NEW envelopes only.
 *
 * A .bento.html is offline at-rest storage: the ciphertext sits in a file that
 * gets mailed, synced and backed up, so an attacker guesses passwords at their
 * own pace with no rate limit anywhere. 300k was half of current guidance
 * (OWASP: 600k for PBKDF2-HMAC-SHA256), and it is the cheapest possible thing
 * to fix — one number, and the cost lands on a keypress the user already waits
 * through.
 *
 * READING IS UNAFFECTED, deliberately: the count travels in the envelope (`it`)
 * and `decryptEnvelope` derives with THAT number, never this one. Every deck
 * encrypted by an older build keeps opening with its own 300k, and re-saving it
 * re-encrypts at the new count. A file that stops opening would be far worse
 * than a weak KDF, so `scripts/test-preview.ts` pins a real 300k envelope.
 */
const ENC_ITERATIONS = 600_000

const eb64 = {
  enc(bytes: Uint8Array): string {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  },
  dec(s: string): Uint8Array {
    const b = atob(s)
    const out = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  },
}

let encPassword: string | null = null

/** Set (or clear with null) the password used for every subsequent save. */
export function setEncryptionPassword(p: string | null) {
  encPassword = p
}

export const isEncryptionActive = () => encPassword !== null

/** Parse a data-block body as an encryption envelope; null if it is not one. */
export function parseEnvelope(text: string): EncEnvelope | null {
  try {
    const env = JSON.parse(text)
    if (env && env.format === 'bento/enc' && env.v === 1 && env.data && env.salt && env.iv) {
      return env as EncEnvelope
    }
  } catch {
    /* not an envelope */
  }
  return null
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function encryptBody(json: string, password: string): Promise<string> {
  const salt = new Uint8Array(16)
  const iv = new Uint8Array(12)
  crypto.getRandomValues(salt)
  crypto.getRandomValues(iv)
  const key = await deriveKey(password, salt, ENC_ITERATIONS)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(json))
  const env: EncEnvelope = {
    format: 'bento/enc', v: 1, it: ENC_ITERATIONS,
    salt: eb64.enc(salt), iv: eb64.enc(iv), data: eb64.enc(new Uint8Array(ct)),
  }
  return JSON.stringify(env)
}

/** Decrypt an envelope with a candidate password; null on wrong password. */
export async function decryptEnvelope(env: EncEnvelope, password: string): Promise<string | null> {
  try {
    const key = await deriveKey(password, eb64.dec(env.salt), env.it || ENC_ITERATIONS)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: eb64.dec(env.iv) as BufferSource }, key, eb64.dec(env.data) as BufferSource)
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

/**
 * Encryption-aware serialization into an arbitrary shell — THE path for
 * saves and self-updates. Plain when no password is active.
 */
export async function serializeDocInto(shell: Document, doc: KernelDoc): Promise<string> {
  const body = encPassword
    ? await encryptBody(JSON.stringify(doc), encPassword)
    : JSON.stringify(doc)
  return serializeBody(shell, body, doc)
}

/** Encryption-aware serializeFile. */
export async function serializeAuto(doc: KernelDoc): Promise<string> {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  return serializeDocInto(pristine, doc)
}

export function suggestedFileName(doc: KernelDoc, suffix = ''): string {
  const base = doc.title.replace(/[^\w\d-]+/g, '_').replace(/^_+|_+$/g, '') || 'Untitled'
  return `${base}${suffix ? `-${suffix}` : ''}.bento.html`
}

// --- writing to disk --------------------------------------------------------

type SaveResult = 'saved' | 'saved-as' | 'downloaded' | 'cancelled'

interface FsFileHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>
  name: string
}

let fileHandle: FsFileHandle | null = null

const hasFsAccess = () => typeof (window as any).showSaveFilePicker === 'function'

/**
 * Can this browser rewrite the open file, or only hand back copies?
 *
 * The File System Access API is Chrome/Edge only: Safari and Firefox lack it,
 * and so does EVERY browser on iOS, because they are all WebKit underneath.
 * Without it there is no writable handle, which costs three things — in-place
 * save, silent autosave write-back, and in-place self-update.
 *
 * Exported because the UI must not promise what the browser cannot do. "⌘S
 * rewrites this file in place" is the product's central claim and it is simply
 * false here; saying it anyway and retracting it in a toast after the first
 * save is worse than saying the true thing up front.
 */
export const canWriteInPlace = () => hasFsAccess()

/**
 * What a save is FOR. The three cases want different files in different places,
 * and until now the picker could not tell them apart.
 *
 * · `in-place` — ⌘S. Overwrite the document being edited.
 * · `copy`     — "Save a copy…". A second file, chosen by the author.
 * · `share`    — a suffixed export: view-only, presentation package, invite,
 *                template. Deliberately a new file, and never the ⌘S target.
 * · `backup`   — the rollback copy a self-update leaves behind. Belongs BESIDE
 *                the document it backs up, and is the one save the author never
 *                asked for, so it is also the one that must never interrupt.
 */
export type SavePurpose = 'in-place' | 'copy' | 'share' | 'backup'

/**
 * The picker `id` for a purpose — and, incidentally, the only signal a HOST has
 * about what it is being asked to do.
 *
 * Browsers remember the last directory used per `id`, so distinct ids are worth
 * having on their own: exports and working files usually live in different
 * places, and one shared id made the picker open wherever you last put a
 * view-only copy.
 *
 * The other reason is not incidental. A host that polyfills
 * `showSaveFilePicker` (home/ios over UIDocument, home/webext over a directory
 * grant) sees ONLY the options bag. `saveFile(doc, forcePicker)` used to reach
 * this function with byte-identical arguments for ⌘S and for "Save a copy…",
 * so a host could not distinguish them — and one that guessed wrong overwrote
 * the open document instead of copying it. Measured, in a browser extension,
 * 2026-08-02. Intent has to be explicit in the call, because it cannot be
 * recovered from anything else in it.
 */
export const pickerIdFor = (purpose: SavePurpose): string =>
  purpose === 'in-place' ? 'bento-doc'
    : purpose === 'copy' ? 'bento-copy'
      : purpose === 'backup' ? 'bento-backup'
        : 'bento-share'

/**
 * Is a HOST polyfilling the picker — home/ios, home/webext — rather than the
 * browser's own?
 *
 * The kernel cannot infer this. `showSaveFilePicker` exists either way, and a
 * host that declines a request is indistinguishable from one that is not there:
 * both end in the native dialog. So a host that can do more than the bare
 * contract announces itself, and this is the only thing the kernel reads.
 *
 * It gates exactly one decision — see `writeBackupBeside`. Nothing else may
 * branch on it: every in-place path must keep working when it is false, because
 * that is the plain-browser case and it is the majority one.
 *
 * PRESENCE IS NOT ENOUGH, so this asks about a named capability. A host that
 * announced itself but did not recognise `bento-backup` would pass the request
 * through to the native picker — producing exactly the dialog this exists to
 * remove, and only for people who installed the host. Decks outlive host
 * versions in both directions; neither side may assume the other is current.
 */
export const hostCan = (op: string): boolean => {
  const host = (window as any).__bentoHost
  return !!host && Array.isArray(host.ops) && host.ops.includes(op)
    && typeof (window as any).showSaveFilePicker === 'function'
}

async function pickHandle(
  doc: KernelDoc, suffix = '', suggestedName?: string, purpose: SavePurpose = 'in-place',
): Promise<FsFileHandle | null> {
  try {
    // The name to offer is the file the user is ALREADY looking at, when we know
    // it. suggestedFileName() derives from doc.title, and the two drift apart
    // constantly — a deck called "Bento Slides Showcase" living in
    // Q3-board.bento.html offered to save as Bento_Slides_Showcase.bento.html,
    // so an ordinary ⌘S silently proposed a SECOND file beside the real one.
    // A suffixed export (share copies) still names itself, hence the suffix
    // check: those are deliberately new files.
    const openedName = suffix ? null : openedFileName()
    return await (window as any).showSaveFilePicker({
      suggestedName: suggestedName ?? openedName ?? suggestedFileName(doc, suffix),
      // startIn takes a HANDLE, never a path — the API gives no way to point a
      // picker at an arbitrary directory, by design. With a handle we land in
      // the open file's own folder; without one, `id` is the fallback: the
      // browser remembers the last directory used under this id, so the second
      // update onwards opens where the first one saved.
      ...(fileHandle ? { startIn: fileHandle } : {}),
      id: pickerIdFor(purpose),
      // `.bento.html`, NOT `.html`, and the compound extension is the point.
      //
      // `suggestedFileName` has always produced `.bento.html`, but the picker
      // accepted `.html` — so an author who edited the name to "Q3" got
      // `Q3.html`, and a document named that is a second-class citizen
      // everywhere the convention is what identifies us: home/webext injects
      // its save bridge on `file:///*.bento.html`, so such a file opens fine
      // and then asks where to save, and home/ios matches the same way.
      //
      // Bento was manufacturing the exception and then being asked to cope with
      // it. Accepting only the compound extension means the browser appends it
      // to a bare name, which is what everybody meant. Compound suffixes are
      // explicitly legal here (`.tar.gz` is the spec's own example) and the
      // limit is 16 characters against this one's 11.
      types: [{ description: appConfig().appName, accept: { 'text/html': ['.bento.html'] } }],
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') return null
    throw err
  }
}

async function writeHandle(handle: FsFileHandle, html: string) {
  const writable = await handle.createWritable()
  await writable.write(new Blob([html], { type: 'text/html' }))
  await writable.close()
}

export function downloadFile(html: string, name: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * Save the document. Chrome/Edge: File System Access API (picker on first
 * save, silent rewrite after). Firefox/Safari: download a copy.
 */
export async function saveFile(doc: KernelDoc, forcePicker = false): Promise<SaveResult> {
  const html = await serializeAuto(doc)
  if (hasFsAccess()) {
    if (forcePicker || !fileHandle) {
      // forcePicker is only ever "Save a copy…"; a first save of an unsaved
      // document is in-place by intent even though it must also pick.
      const handle = await pickHandle(doc, '', undefined, forcePicker ? 'copy' : 'in-place')
      if (!handle) return 'cancelled'
      fileHandle = handle
      await writeHandle(handle, html)
      return 'saved-as'
    }
    await writeHandle(fileHandle, html)
    return 'saved'
  }
  downloadFile(html, suggestedFileName(doc))
  return 'downloaded'
}

export const currentFileName = () => fileHandle?.name ?? null

/**
 * Adopt a handle obtained outside the save picker — today, a file dropped onto
 * the editor via `DataTransferItem.getAsFileSystemHandle()`.
 *
 * Why this exists: a deck double-clicked from disk opens on `file://` with NO
 * handle, so every ⌘S re-runs the picker and the user re-navigates to a file
 * they are already looking at. A drop yields a real handle, so adopting it
 * turns that document into one Bento can rewrite in place.
 *
 * The caller MUST have obtained readwrite permission first — this only records
 * the handle. It is deliberately not exported through `window.bento`: adopting
 * a handle silently redirects where ⌘S writes, which is a user gesture, never
 * something a script should do behind their back.
 */
export function adoptFileHandle(handle: FsFileHandle): void {
  fileHandle = handle
}

/**
 * The name of the file this document is actually open AS, when knowable.
 *
 * Two sources, best first: a held FS Access handle, else this document's own
 * URL. The URL case is the one that matters — a `.bento.html` double-clicked
 * from disk grants no handle, which is exactly when a save picker appears with
 * nothing useful in it.
 *
 * Only a name ending in `.bento.html` counts. That deliberately excludes the
 * hosted demo (`/slides/`, `index.html`), so the anonymous try-it deck still
 * falls back to naming itself after its title instead of "index".
 */
export function openedFileName(): string | null {
  if (fileHandle?.name) return fileHandle.name
  try {
    const base = decodeURIComponent(new URL(location.href).pathname.split('/').pop() ?? '')
    return /\.bento\.html$/i.test(base) ? base : null
  } catch {
    return null
  }
}

/** Strip the document extension: "Q3-board.bento.html" -> "Q3-board". */
export const fileBase = (name: string) => name.replace(/\.bento\.html$/i, '').replace(/\.html$/i, '')

// --- self-update writing ----------------------------------------------------

/** Whether we hold a writable handle to the file (in-place update possible). */
export const hasFileHandle = () => fileHandle !== null

/** Overwrite the held file with arbitrary html (the freshly updated shell). */
export async function writeUpdatedFile(html: string): Promise<void> {
  if (!fileHandle) throw new Error('no file handle')
  await writeHandle(fileHandle, html)
}

/**
 * Save updated html via a picker (user points it at the file they have open,
 * or anywhere else). Returns false if cancelled. Keeps the picked handle so
 * subsequent ⌘S saves go to the same place.
 */
export async function writeUpdatedFileAs(
  html: string,
  doc: KernelDoc,
  opts: { suffix?: string; keepHandle?: boolean; suggestedName?: string; purpose?: SavePurpose } = {},
): Promise<boolean> {
  if (!hasFsAccess()) {
    downloadFile(html, opts.suggestedName ?? suggestedFileName(doc, opts.suffix))
    return true
  }
  // `share` is the right default — every caller but one is an export. The
  // exception is the self-update, which is overwriting the open document and
  // must say so: a host reads only the picker id, and `bento-share` tells it
  // "a new file the author will choose", so it correctly declines and the
  // author gets a dialog for the one save that should never need one.
  const handle = await pickHandle(doc, opts.suffix, opts.suggestedName, opts.purpose ?? 'share')
  if (!handle) return false
  // Share/export artifacts must NOT become the ⌘S target — otherwise the next
  // save would overwrite e.g. a view-only copy with the FULL document (owner
  // keys included). Only an explicit keepHandle retargets in-place saving.
  if (opts.keepHandle) fileHandle = handle
  await writeHandle(handle, html)
  return true
}

/**
 * Leave the rollback copy an in-place update depends on.
 *
 * WHY THIS IS NOT JUST `downloadFile`. It was, and the backup landed in
 * ~/Downloads: detached from the document it backs up, one per update, and — for
 * anyone with Chrome's "ask where to save each file" enabled — behind a save
 * dialog. Reported 2026-08-14 against 1.0.16. That is the wrong outcome twice
 * over: an update that rewrites the file in place, silently, ended with the one
 * prompt in the flow being for a file the author never asked for, and the
 * rollback it produced was somewhere they would have to go hunting for.
 *
 * With a host, the backup goes where it belongs — beside the original, inside
 * the folder already granted. The host derives the directory itself, from the
 * sender's own resolved path; `name` is only ever validated against that, never
 * trusted as a path. See home/webext/src/background.js `backup`.
 *
 * Without a host this stays a download, because the alternative is a picker and
 * a picker is strictly worse than the status quo for the majority case.
 *
 * Never throws: a backup that fails must not take the update down with it. The
 * caller decides what to tell the author, which is why the outcome comes back
 * as a value.
 */
export async function writeBackupBeside(html: string, name: string): Promise<'beside' | 'downloaded'> {
  if (hostCan('backup')) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: name,
        id: pickerIdFor('backup'),
        types: [{ description: appConfig().appName, accept: { 'text/html': ['.bento.html'] } }],
      })
      if (handle) {
        await writeHandle(handle, html)
        return 'beside'
      }
    } catch {
      // Declined, cancelled, or the grant lapsed. Fall through — a backup in
      // Downloads is a worse place, not a lost one.
    }
  }
  downloadFile(html, name)
  return 'downloaded'
}
