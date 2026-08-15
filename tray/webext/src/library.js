// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Your documents — the thing the extension is actually for.
//
// The popup used to be a permissions control panel: "local file access is on,
// folder: documents". True, and nobody wants it. tray/ios is a
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

import { CACHE, get, put, prefixes } from './db.js'
import { getGrants } from './status.js'

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
  const encrypted = /"format"\s*:\s*"bento\/enc"/.test(head) || /data-bento-enc/.test(head)

  // The preview sits AFTER the document block — a quarter of the way into a
  // 900KB file, measured — so unlike the title it cannot be had from the head.
  // This is the expensive read, and the only reason the cache exists.
  let preview = null
  if (!encrypted) {
    const whole = await file.text()
    const start = whole.indexOf('<div data-bento-preview')
    const end = start === -1 ? -1 : whole.indexOf('<script data-bento-preview', start)
    if (start !== -1 && end > start) preview = whole.slice(start, end)
  }

  const meta = {
    title: title ? title.replace(/\\(.)/g, '$1') : doc.base,
    encrypted,
    preview,
    size: file.size,
    modified: file.lastModified,
  }
  // Best effort: a cache that cannot be written costs a re-read, nothing more.
  try { await cachePut(key, meta) } catch { /* quota, private mode */ }
  return meta
}

/**
 * The `+` from tray/ios, which mints a new document from a seed.
 *
 * iOS bundles that seed. We deliberately do not: bundling an app shell would
 * put a copy of Bento inside the extension, to drift from the real release and
 * to be re-reviewed on every update — the same trap tray/ios avoided by letting
 * documents carry their own runtime. Fetching the current signed release
 * instead means a document created here is the same version everyone else has,
 * the same day.
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
export const APPS = [
  { id: 'slides', name: 'Slides', blurb: 'Presentations',
    manifest: 'https://bento.page/releases/slides/manifest.json' },
  { id: 'spaces', name: 'Spaces', blurb: 'Notes and pages',
    manifest: 'https://bento.page/releases/spaces/manifest.json' },
  { id: 'dash', name: 'Dash', blurb: 'Data and sheets',
    manifest: 'https://bento.page/releases/dash/manifest.json' },
]

/**
 * A free name in `dir`, counting on the BASE.
 *
 * `Untitled 2.bento.html`, never `Untitled.bento 2.html`. A double extension
 * defeats naive counters — including UIKit's, which reads `.bento.html` as the
 * name "Untitled.bento" plus extension "html" and inserts before the last
 * extension only. tray/ios had to write its own for exactly this.
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

export async function newDocument(dir, wantedBase = 'Untitled', deps = {}) {
  const net = deps.fetch ?? fetch
  const app = APPS.find((a) => a.id === deps.app) ?? APPS[0]
  const res = await net(app.manifest, { cache: 'no-store' })
  if (!res.ok) throw new Error(`could not reach the ${app.name} release server (${res.status})`)
  const manifest = await res.json()
  const url = manifest?.url
  if (!url) throw new Error('the release server did not offer a build')

  const shell = await net(url, { cache: 'no-store' })
  if (!shell.ok) throw new Error(`could not download the app (${shell.status})`)
  const html = await shell.text()

  const { name, base } = await freeName(dir, wantedBase)
  const handle = await dir.getFileHandle(name, { create: true })
  const w = await handle.createWritable()
  await w.write(html)
  await w.close()
  return { name, base, version: manifest.version, app: app.name }
}
