// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Your documents — the thing the extension is actually for.
//
// The popup used to be a permissions control panel: "local file access is on,
// folder: documents". True, and nobody wants it. home/ios is a
// UIDocumentBrowserViewController — you see your documents and tap one — and
// that is the right shape here too. Permissions are plumbing and belong at the
// bottom, speaking only when broken.
//
// ENUMERATION IS FINE HERE, and that is worth saying because `background.js`
// went to some trouble to stop enumerating. The difference is who is waiting:
// resolving a SAVE must not walk a folder, because the user is mid-⌘S and a
// granted home directory would hang it. Listing is user-initiated, happens when
// the popup opens, is bounded, and its results are cached. Different job,
// different rules.

import { CACHE, GRANT, get, put, prefixes } from './db.js'
import { getGrants } from './status.js'
import { verifyManifest, fetchPinned, ACCEPT_BYTES } from './release.js'
// Not a third implementation: `update.js` already has the dotted-numeric
// compare, and it behaves the same as the kernel's — an unparsable component
// coerces to 0 rather than throwing, because `NaN || 0` is 0. A strange version
// string should be able to fail to RAISE the floor, never to block a release.
import { compareVersions } from './update.js'

/** How deep to look, and how many documents to show. A folder of documents is
 *  not a filesystem; someone who granted a home directory should get a useful
 *  list quickly rather than a complete one slowly. */
const MAX_DEPTH = 4
const MAX_DOCS = 300
/** How many unrecognised .html files to open and look inside, per listing. */
const MAX_SNIFFS = 400

/** Enough to reach the title, which sits in the `#bento-doc` block that starts
 *  a few KB in. Measured on a real deck: block at 5.8KB, title inside it. The
 *  block itself runs to megabytes when a document carries images, which is the
 *  trap an earlier metadata reader fell into — it looked for the CLOSING tag
 *  and so found nothing in any document with a picture in it. Reading a fixed
 *  head and matching the field directly avoids needing the end at all. */
const HEAD_BYTES = 300 * 1024

/** Named like one of ours. Free to decide — no read at all. */
const namedDoc = (name) => /\.bento\.html$/i.test(name)

/** Any other local page, which MIGHT be one of ours under a different name. */
const maybeDoc = (name) => /\.html?$/i.test(name) && !namedDoc(name)

/**
 * How much of a file to read before deciding whether it is a Bento document.
 *
 * The marker is `id="bento-doc"` — the splice contract every Bento app honours
 * (docs/PLATFORM.md §2), frozen because old updaters depend on it. Measured on
 * a real shell it sits 5.8KB in, after the chrome and the notice, so 64KB is
 * generous. It is deliberately NOT the 300KB head used for titles: this runs
 * against every stray .html in a granted folder, and most of them are not ours.
 */
const SNIFF_BYTES = 64 * 1024
const MARKER = 'id="bento-doc"'

/**
 * Is this actually a Bento document, whatever it is called?
 *
 * A Bento document is a Bento document because of what is INSIDE it. The name
 * is a convention, and conventions get broken by people: renamed to `deck.html`
 * to email it, saved by a browser that appended `(1)`, downloaded as
 * `Q3.html`. Those are still documents this extension can open, and until now
 * they were invisible because the filter was a regular expression on the name.
 *
 * Cheap enough to do honestly: the marker is in the first few KB, the verdict
 * is cached by size and mtime like everything else read here, and a file that
 * is not ours is rejected after one 64KB read that never happens again.
 */
async function sniff(handle, cacheGet, cachePut) {
  const file = await handle.getFile()
  const key = `sniff:${handle.name}:${file.size}:${file.lastModified}`
  const hit = await cacheGet(key)
  if (hit !== null && hit !== undefined) return hit.isDoc
  const head = await file.slice(0, SNIFF_BYTES).text()
  const isDoc = head.includes(MARKER)
  try { await cachePut(key, { isDoc }) } catch { /* best effort */ }
  return isDoc
}

/**
 * Every Bento document in the granted folders.
 *
 * Returns descriptors, not contents: name, folder, route, size, mtime. Reading
 * the documents themselves is a separate, cached step (`describe`), because a
 * folder of twenty decks is twenty megabytes and the list has to appear now.
 */
export async function listDocuments(deps = {}) {
  const grants = await (deps.getGrants ?? getGrants)()
  const known = await (deps.prefixes ?? prefixes)()
  const cacheGet = deps.get ?? ((k) => get(CACHE, k))
  const cachePut = deps.put ?? ((k, v) => put(CACHE, k, v))
  const out = []

  // Reading is only free the first time. A granted home directory can hold
  // thousands of unrelated .html files, and sniffing every one on every popup
  // open would be a real cost for a rare case — so the budget is per listing,
  // and named documents never spend from it.
  let sniffs = MAX_SNIFFS

  const walk = async (dir, root, rel, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_DOCS) return
    for await (const [name, handle] of dir.entries()) {
      if (out.length >= MAX_DOCS) return
      if (handle.kind === 'file') {
        let named = namedDoc(name)
        if (!named) {
          // Not named like ours — but a document is a document because of what
          // is inside it, and names get changed by people. Look, once, cheaply.
          if (!maybeDoc(name) || sniffs <= 0) continue
          sniffs--
          let is = false
          try { is = await sniff(handle, cacheGet, cachePut) } catch { continue }
          if (!is) continue
        }
        out.push({
          name,
          named,
          base: name.replace(/\.bento\.html$/i, '').replace(/\.html?$/i, ''),
          folder: root.name,
          rel: [...rel, name],
          // Absolute path only if this folder has taught us where it lives.
          // Without it the row still renders — it just cannot be opened, and
          // says so, rather than silently doing nothing when clicked.
          path: known[root.name] ? `${known[root.name]}/${[...rel, name].join('/')}` : null,
          handle,
          // The directory the document actually sits in, so the page can act on
          // it — duplicate beside it, rename within it — without walking again.
          parent: dir,
        })
      } else if (handle.kind === 'directory' && !name.startsWith('.')) {
        await walk(handle, root, [...rel, name], depth + 1)
      }
    }
  }

  for (const dir of grants) {
    // A lapsed folder cannot be read at all; skipping it beats throwing, since
    // the other folders are still perfectly listable.
    if (await dir.queryPermission({ mode: 'readwrite' }) !== 'granted') continue
    try { await walk(dir, dir, [], 0) } catch { /* unreadable folder: skip */ }
  }
  return out
}

/** Cache key. Includes size and mtime so an edited document re-reads itself,
 *  and nothing has to be invalidated by hand. */
const keyFor = (doc, file) => `${doc.folder}/${doc.rel.join('/')}:${file.size}:${file.lastModified}`

/**
 * What a document is called, and what its first page looks like.
 *
 * TITLE. Documents are named `Q3-board.bento.html`; the document knows it is
 * "Q3 Board Review". Showing the filename when the title is right there is the
 * difference between a file list and a document list.
 *
 * PREVIEW. Every save already writes a still render of page one into the shell
 * (`kernel/src/preview.ts`) so that file managers can thumbnail it. This IS a
 * file manager. The block is self-contained and scales itself to whatever
 * viewport it lands in, so it drops straight into a small sandboxed iframe with
 * no work — which is precisely what it was designed for.
 *
 * An ENCRYPTED document deliberately carries no preview: a plaintext title page
 * beside the ciphertext is the leak the password exists to prevent. So a
 * missing preview is not a failure here, it is a signal, and the caller shows a
 * lock rather than a blank.
 */
export async function describe(doc, deps = {}) {
  const cacheGet = deps.get ?? ((k) => get(CACHE, k))
  const cachePut = deps.put ?? ((k, v) => put(CACHE, k, v))
  const file = await doc.handle.getFile()
  const key = keyFor(doc, file)
  const hit = await cacheGet(key)
  if (hit) return hit

  const head = await file.slice(0, HEAD_BYTES).text()
  const title = head.match(/"title"\s*:\s*"((?:[^"\\]|\\.){0,200})"/)?.[1]
  // Which Bento this is. The format field is the document's own answer — the
  // extension supports three apps now and the UI never said which one a
  // document was, so a folder of decks and sheets looked like one undifferentiated
  // pile. A pristine shell has no document yet, so no format: that is not a
  // failure, it is a document nobody has saved.
  const app = head.match(/"format"\s*:\s*"bento\/([a-z]+)"/)?.[1] ?? null
  const encrypted = /"format"\s*:\s*"bento\/enc"/.test(head) || /data-bento-enc/.test(head)

  // The preview sits AFTER the document block — a quarter of the way into a
  // 900KB file, measured — so unlike the title it cannot be had from the head.
  // This is the expensive read, and the only reason the cache exists.
  // ONE read, two answers. The preview and the searchable text both come out of
  // the same bytes, so an encrypted document costs nothing extra and everything
  // else costs exactly one pass.
  let preview = null
  let text = null
  if (!encrypted) {
    const whole = await file.text()
    const start = whole.indexOf('<div data-bento-preview')
    const end = start === -1 ? -1 : whole.indexOf('<script data-bento-preview', start)
    if (start !== -1 && end > start) preview = whole.slice(start, end)
    text = extractText(whole)
  }

  const meta = {
    title: title ? title.replace(/\\(.)/g, '$1') : doc.base,
    app,
    // What the document SAYS, so search can find a deck by a phrase on a slide
    // rather than only by what somebody happened to call the file. Free in I/O:
    // the same read that produced the preview.
    text,
    encrypted,
    preview,
    size: file.size,
    modified: file.lastModified,
  }
  // Best effort: a cache that cannot be written costs a re-read, nothing more.
  try { await cachePut(key, meta) } catch { /* quota, private mode */ }
  return meta
}

/** How much extracted prose to keep per document. Enough for any phrase
 *  somebody would search for; far short of storing the document twice. */
const TEXT_BUDGET = 40 * 1024

/**
 * The words a document actually contains.
 *
 * Search used to cover the title, the file name and the folder — which finds a
 * deck you can already name. What you usually remember is a phrase ON a slide,
 * and the bytes to answer that were already read for the thumbnail and then
 * thrown away.
 *
 * Deliberately NOT a JSON parse. The document block runs to megabytes with
 * images inline, every app shapes it differently (slides put prose in
 * `element.html`, spaces in blocks, dash in cells), and a parser that has to
 * know the format is a parser that breaks when the format moves. Pulling string
 * VALUES out — `:"…"`, never keys — is format-agnostic and degrades to "finds
 * less" rather than "throws".
 *
 * Data URIs go first: one embedded image is bigger than every word in the
 * document, and they would dominate both the work and the budget.
 */
function extractText(html) {
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

/**
 * The `+` from home/ios, which mints a new document from a seed.
 *
 * iOS bundles that seed. We deliberately do not: bundling an app shell would
 * put a copy of Bento inside the extension, to drift from the real release and
 * to be re-reviewed on every update — the same trap home/ios avoided by letting
 * documents carry their own runtime. Fetching the current signed release
 * instead means a document created here is the same version everyone else has,
 * the same day.
 *
 * Bundling is settled policy across all three hosts now (2026-08-16), which
 * makes this the ONLY way any of them creates a document — so the download is
 * verified, not trusted: signature, then digest, then the file handle. See
 * `release.js` for the chain and why it is mirrored from the kernel.
 *
 * Create-only, and the name is derived here rather than taken from anywhere —
 * the same rule as `backup`. Nothing existing is ever replaced.
 */
/**
 * The Bento apps, each with its own signed release channel.
 *
 * They all write `.bento.html`, all carry their own runtime, and all save
 * through the same kernel — so listing, opening, thumbnails and in-place saving
 * never needed to know which app a document belongs to, and still do not. This
 * list exists for ONE thing: creating a new document means choosing what it
 * should be.
 *
 * Adding an app here is the whole integration; nothing else in the extension
 * asks which app it is looking at.
 */
// `appId` is the name the app calls ITSELF inside its signed manifest
// (scripts/apps.mjs, and the shell's own `configureApp({appId})`), and it is
// checked against the payload — the channels are sibling paths on one origin,
// so without that check a genuine manifest served from the wrong path hands
// somebody the wrong application. It is spelled out rather than derived from
// `id` so that adding an app cannot silently opt out of the check.
export const APPS = [
  { id: 'slides', name: 'Slides', blurb: 'Presentations', appId: 'bento-slides',
    manifest: 'https://bento.page/releases/slides/manifest.json' },
  { id: 'spaces', name: 'Spaces', blurb: 'Notes and pages', appId: 'bento-spaces',
    manifest: 'https://bento.page/releases/spaces/manifest.json' },
  { id: 'dash', name: 'Dash', blurb: 'Data and sheets', appId: 'bento-dash',
    manifest: 'https://bento.page/releases/dash/manifest.json' },
]

/**
 * A free name in `dir`, counting on the BASE.
 *
 * `Untitled 2.bento.html`, never `Untitled.bento 2.html`. A double extension
 * defeats naive counters — including UIKit's, which reads `.bento.html` as the
 * name "Untitled.bento" plus extension "html" and inserts before the last
 * extension only. home/ios had to write its own for exactly this.
 */
export async function freeName(dir, wantedBase) {
  let base = wantedBase
  for (let n = 2; n < 999; n++) {
    let taken = true
    try { await dir.getFileHandle(`${base}.bento.html`) } catch (e) { taken = e?.name !== 'NotFoundError' }
    if (!taken) return { base, name: `${base}.bento.html` }
    base = `${wantedBase} ${n}`
  }
  throw new Error('too many documents with that name')
}

/**
 * Copy a document beside itself.
 *
 * Byte-for-byte, deliberately: a Bento document carries its own runtime, its
 * own collaboration keys and its own identity, and re-deriving any of that here
 * would make a copy that is subtly not the original. Whether a duplicate should
 * get a fresh `docId` is the DOCUMENT's business — Bento's own "Duplicate as
 * new deck" exists for that — and a file manager has no standing to decide it.
 */
export async function duplicate(doc) {
  const { name, base } = await freeName(doc.parent, `${doc.base} copy`)
  const bytes = await (await doc.handle.getFile()).arrayBuffer()
  const out = await doc.parent.getFileHandle(name, { create: true })
  const w = await out.createWritable()
  await w.write(bytes)
  await w.close()
  return { name, base }
}

/**
 * Rename a document.
 *
 * The File System Access API has no rename, so this is write-then-remove — in
 * that ORDER, and never the reverse. If the write fails the original is
 * untouched; if the remove fails the worst case is two copies, which is a
 * nuisance rather than a loss. Removing first would put the only copy of
 * somebody's document in a variable.
 */
export async function rename(doc, wantedBase) {
  // This string came from a prompt box and is about to become a filename.
  // Separators go first, so nothing can escape the folder; then the extension,
  // so typing it does not double it; then leading dots, because a document
  // called `.something` is invisible in every file manager including this one
  // — it would vanish from the list the moment it was renamed.
  const clean = wantedBase.trim()
    .replace(/[/\\:\0]/g, '')
    .replace(/\.bento\.html$/i, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .trim()
  if (!clean) throw new Error('a document needs a name')
  if (clean === doc.base) return { name: doc.name, base: doc.base }

  const { name, base } = await freeName(doc.parent, clean)
  const bytes = await (await doc.handle.getFile()).arrayBuffer()
  const out = await doc.parent.getFileHandle(name, { create: true })
  const w = await out.createWritable()
  await w.write(bytes)
  await w.close()
  await doc.parent.removeEntry(doc.name)
  return { name, base }
}

/**
 * The highest release version of an app this browser has ever accepted.
 *
 * Per app, in the extension's own store — a document carries no version of its
 * own to compare against, so unlike the shell's self-update (which has its
 * running build to measure from) creating a document has nothing to be
 * monotonic ABOUT unless the host remembers.
 *
 * An unreadable store reads as NO floor rather than as a refusal: private mode,
 * quota, a migration mid-flight. That is a deliberate choice of availability
 * over protection in a case that is not an attack — being unable to remember
 * must not mean being unable to create a document.
 */
const floorKey = (app) => `release-floor:${app.id}`

async function readFloor(app, deps) {
  const read = deps.getFloor ?? (() => get(GRANT, floorKey(app)))
  try { return (await read()) || null } catch { return null }
}

async function raiseFloor(app, version, floor, deps) {
  // EQUAL is not a downgrade. Re-fetching the version already seen is the
  // normal case — the second document somebody creates — and treating it as a
  // rollback would break the `+` button on its second use rather than at some
  // exotic edge.
  if (floor && compareVersions(version, floor) <= 0) return
  const write = deps.putFloor ?? ((v) => put(GRANT, floorKey(app), v))
  // Best effort: a floor that cannot be written costs protection next time, not
  // this document.
  try { await write(version) } catch { /* quota, private mode */ }
}

export async function newDocument(dir, wantedBase = 'Untitled', deps = {}) {
  const net = deps.fetch ?? fetch
  const app = APPS.find((a) => a.id === deps.app) ?? APPS[0]

  // The manifest is a SIGNED ENVELOPE — `{payload, sig}`, the fields inside the
  // payload STRING — and it is read as text for that reason: the bytes the
  // signature covers are the bytes that arrived, so anything that parses and
  // re-serialises on the way past has verified something else.
  //
  // This was the bug, and it is worth naming because it was invisible. The code
  // here read `manifest.url` off the ENVELOPE, where there is no `url`, so every
  // attempt threw "the release server did not offer a build" — the `+` button
  // had never once worked. The rig agreed with it, because the fixture was
  // hand-written to the shape the code expected rather than to the shape the
  // server sends. It is checked against a real captured manifest now
  // (scripts/test-webext-release.ts).
  // ACCEPT_BYTES on the manifest too. The edge injection measured on the shell
  // targets things it reads as pages, so a JSON manifest is not today's victim
  // — but "ask for bytes on the one request we remembered" is a rule that only
  // holds until somebody adds a third fetch.
  const res = await net(app.manifest, { cache: 'no-store', headers: ACCEPT_BYTES })
  // Only Slides has a published channel today, so a 404 here is an EXPECTED
  // answer rather than a fault, and an HTTP status is the wrong way to say it.
  // The wording matches home/ios (and home/android is following): the app list
  // is aspirational on all three hosts, so all three phrase this identically.
  if (res.status === 404) throw new Error(`${app.name} has not been released yet`)
  if (!res.ok) throw new Error(`could not reach the ${app.name} release server (${res.status})`)
  const release = await verifyManifest(await res.text(), app.appId, deps.jwk)

  // NO DOWNGRADES. Everything above passes for a replayed OLD release: it is
  // genuinely signed, it names the right app, and its shell really does hash to
  // its pin. Every byte is authentic — it is just last month's. That is what
  // survives an origin or CDN compromise where the attacker can re-serve but
  // cannot forge, so the only thing that catches it is remembering.
  const floor = await readFloor(app, deps)
  if (floor && compareVersions(release.version, floor) < 0)
    throw new Error(
      `the ${app.name} channel offered ${release.version}, older than the ${floor} `
      + 'already seen — refusing it')

  // Signature over the pin, pin over the bytes. Both, or the shell being written
  // to somebody's disk is whatever the network felt like returning.
  const bytes = await fetchPinned(net, release.url, release.sha256)

  // Raised only NOW, after the bytes passed their digest. Raising it on a
  // merely-verified manifest would let one forged-but-unfetchable release lock
  // this browser out of every real release below it — turning a failed attack
  // into a permanent one. (home/ios hit this reasoning first, on PR #315.)
  await raiseFloor(app, release.version, floor, deps)

  const { name, base } = await freeName(dir, wantedBase)
  const handle = await dir.getFileHandle(name, { create: true })
  const w = await handle.createWritable()
  await w.write(bytes)
  await w.close()
  return { name, base, version: release.version, app: app.name }
}
