// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Where a granted folder lives on disk, found WITHOUT the person's help.
//
// THE GAP. A `FileSystemDirectoryHandle` has no path, and a card can only
// open a document by its `file://` URL. So a folder was openable only after
// something had taught its absolute prefix — a document opened once from
// the Finder (the bridge's `hello`), or the history survey. A folder granted
// on a fresh profile listed 29 documents and opened none of them, and the
// banner said "Chrome never tells an extension where a folder is on disk"
// as if that settled it.
//
// THE OTHER DOOR. It does not tell us — but an extension with file-URL
// access can READ `file://` URLs, so it can ASK: "is /Users/andy/Desktop/
// teams-test/S1.bento.html the same bytes as the S1.bento.html in this
// grant?" A guess that is wrong 404s; a guess that is right is then proven
// the way every path is proven here (`prefixFor`: the route resolves inside
// the grant and `dir.resolve()` agrees). Nothing is trusted from the guess
// itself, and no path is ever recorded that the grant did not confirm.
//
// WHERE TO GUESS. Home directories (Chrome's listing of /Users, /home,
// C:/Users, when it will give one), the usual places inside a home
// (Desktop, Documents, Downloads, iCloud Drive, cloud-storage mounts), any
// prefix already learned for another folder and its neighbours — and the
// folder's own name under each, one level of nesting allowed. A few dozen
// fetches at most, once, and the result is remembered like every prefix.
//
// Pure: fetch, the grant and the two route helpers come in as `deps`, so the
// rig runs it in node against a fake disk.

const HOME_ROOTS = ['/Users', '/home', '/C:/Users', '/root']
const HOME_SUBDIRS = ['', 'Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents/com~apple~CloudDocs', 'Library/CloudStorage', 'OneDrive', 'Dropbox', 'Google Drive', 'iCloud Drive', 'Projects', 'Work', 'devel', 'dev', 'src', 'code']
const SKIP_USERS = new Set(['Shared', 'Guest', 'Public', 'Default', 'Default User', 'All Users', '.localized'])
/** How many candidate directories one placement may try. */
export const MAX_CANDIDATES = 240

// A drive letter's colon must stay a colon: `file:///C%3A/` is not a drive.
const enc = (p) => p.split('/').map((seg) => encodeURIComponent(seg).replace(/^([A-Za-z])%3A$/, '$1:')).join('/')
export const fileUrl = (path) => `file://${enc(path)}`

/**
 * The entries of a directory, from Chrome's own `file://` listing: it is
 * HTML with one `addRow("name", "url", isDir, …)` per entry. Empty when the
 * fetch is refused or the page is not a listing — both mean "no idea", never
 * an error.
 */
export async function listDir(path, deps) {
  let html
  try {
    const r = await deps.fetch(fileUrl(path.endsWith('/') ? path : `${path}/`))
    if (!r.ok) return []
    html = await r.text()
  } catch { return [] }
  const out = []
  for (const m of html.matchAll(/addRow\("((?:[^"\\]|\\.)*)"\s*,\s*"(?:[^"\\]|\\.)*"\s*,\s*(\d)/g)) {
    const name = m[1].replace(/\\(.)/g, '$1')
    if (name && name !== '.' && name !== '..') out.push({ name, dir: m[2] === '1' })
  }
  return out
}

/** Is the file at this path byte-for-byte the granted file? Size first, then the bytes. */
export async function sameFile(path, file, deps) {
  let r
  try { r = await deps.fetch(fileUrl(path)) } catch { return false }
  if (!r.ok) return false
  const bytes = new Uint8Array(await r.arrayBuffer())
  if (bytes.length !== file.size) return false
  const mine = new Uint8Array(await file.arrayBuffer())
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== mine[i]) return false
  return true
}

/** The directories to try, in order: near what is already known, then the usual places. */
export async function candidateDirs(folderName, knownPrefixes, deps) {
  const dirs = []
  const seen = new Set()
  const add = (d) => { const p = d.replace(/\/+$/, ''); if (p && !seen.has(p)) { seen.add(p); dirs.push(p) } }
  // 1. beside and under folders already placed: the same parent, or one level in
  const homes = new Set()
  for (const prefix of Object.values(knownPrefixes || {})) {
    if (typeof prefix !== 'string') continue
    const parts = prefix.split('/').filter(Boolean)
    for (let i = parts.length - 1; i >= 1; i--) add(`/${parts.slice(0, i).join('/')}/${folderName}`)
    const home = /^\/(Users|home)\/[^/]+/.exec(prefix)?.[0] ?? /^\/C:\/Users\/[^/]+/.exec(prefix)?.[0]
    if (home) homes.add(home)
  }
  // 2. every home directory the listing will name
  for (const root of HOME_ROOTS) {
    for (const e of await listDir(root, deps)) if (e.dir && !SKIP_USERS.has(e.name) && !e.name.startsWith('.')) homes.add(`${root}/${e.name}`)
  }
  for (const home of homes) {
    for (const sub of HOME_SUBDIRS) add(`${home}${sub ? `/${sub}` : ''}/${folderName}`)
    // one level deeper under the usual places, from their listings
    for (const sub of ['Desktop', 'Documents', 'Downloads', 'Library/CloudStorage', 'Library/Mobile Documents/com~apple~CloudDocs']) {
      for (const e of await listDir(`${home}/${sub}`, deps)) if (e.dir && !e.name.startsWith('.')) add(`${home}/${sub}/${e.name}/${folderName}`)
      if (dirs.length > MAX_CANDIDATES) break
    }
  }
  return dirs.slice(0, MAX_CANDIDATES)
}

/**
 * Place one grant: the absolute prefix its documents live under, or null.
 * `probe` is one document inside the grant — `{ rel: [...segments], handle }`
 * as listDocuments describes it — used as the fingerprint.
 */
export async function placeFolder(dir, probe, knownPrefixes, deps) {
  if (!probe?.handle || !Array.isArray(probe.rel) || !probe.rel.length) return null
  const file = await probe.handle.getFile()
  if (!file.size) return null
  const tail = probe.rel.join('/')
  for (const cand of await candidateDirs(dir.name, knownPrefixes, deps)) {
    const path = `${cand}/${tail}`
    if (!(await sameFile(path, file, deps))) continue
    // the same bytes at that path — now the grant itself has to agree
    const prefix = await deps.prefixFor(dir, path)
    if (prefix) return prefix
  }
  return null
}

// ---------------------------------------------------------------- the scan
//
// WHY A GRANT IS NOT THE ONLY WAY IN. Chrome will not hand a web page or an
// extension the home folder, Desktop, Documents or Downloads as a whole —
// only folders inside them. That makes "add a folder" a poor first door: the
// three places documents actually live are the three it refuses. But the
// extension can READ file:// (once file-URL access is on), so it can find
// every .bento.html under those places by itself and open each by URL. A
// grant then means one more thing, not the first thing: that documents in
// that folder save back in place without a prompt.

/**
 * Where documents live, under a home. The same three folders on every
 * platform (Chrome blocks the same three as wholes everywhere), plus the
 * places a platform moves them to: iCloud Drive and cloud mounts on macOS,
 * OneDrive's "known folder move" on Windows — where Documents and Desktop
 * live under OneDrive — and on Linux whatever `~/.config/user-dirs.dirs`
 * calls them, since a German desktop has "Dokumente", not "Documents".
 */
export const SCAN_ROOTS = ['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents/com~apple~CloudDocs', 'Library/CloudStorage', 'OneDrive', 'OneDrive/Documents', 'OneDrive/Desktop']

/** The XDG user directories a Linux home declares, as paths under it. */
export function xdgDirs(text, home) {
  const out = []
  for (const m of String(text || '').matchAll(/^\s*XDG_(DOCUMENTS|DESKTOP|DOWNLOAD)_DIR\s*=\s*"([^"]*)"/gm)) {
    let v = m[2].replace(/^\$HOME\/?/, '').replace(/\/+$/, '')
    if (v.startsWith('/')) out.push(v)           // an absolute path elsewhere
    else if (v) out.push(`${home}/${v}`)
  }
  return out
}

/** The roots to scan under one home: the usual names, plus what the platform says. */
export async function scanRootsFor(home, deps) {
  const roots = SCAN_ROOTS.map((r) => `${home}/${r}`)
  try {
    const r = await deps.fetch(fileUrl(`${home}/.config/user-dirs.dirs`))
    if (r.ok) for (const d of xdgDirs(await r.text(), home)) if (!roots.includes(d)) roots.push(d)
  } catch { /* not a Linux home, or no such file */ }
  return roots
}
export const SCAN_DEPTH = 4
export const SCAN_MAX = 2000
const SKIP_DIRS = /^(node_modules|\.git|\.svn|\.hg|Library|Applications|\.Trash|\.cache|dist|build|target|__pycache__|venv|\.venv)$/i

/** The home directories Chrome's listings will name. */
export async function homeDirs(deps) {
  const homes = []
  for (const root of HOME_ROOTS) {
    for (const e of await listDir(root, deps)) if (e.dir && !SKIP_USERS.has(e.name) && !e.name.startsWith('.')) homes.push(`${root}/${e.name}`)
  }
  return homes
}

/**
 * Every Bento document under the usual places, as `{ path, name, dir }`.
 * Listing only — nothing is read — so a large Documents costs a few hundred
 * directory fetches at most and no bytes.
 */
export async function scanDisk(deps, roots = null) {
  const out = []
  const seen = new Set()
  const walk = async (dir, depth) => {
    if (out.length >= SCAN_MAX || depth > SCAN_DEPTH || seen.has(dir)) return
    seen.add(dir)
    const entries = await listDir(dir, deps)
    for (const e of entries) {
      if (out.length >= SCAN_MAX) return
      if (e.dir) { if (!e.name.startsWith('.') && !SKIP_DIRS.test(e.name)) await walk(`${dir}/${e.name}`, depth + 1) }
      else if (/\.bento\.html$/i.test(e.name)) out.push({ path: `${dir}/${e.name}`, name: e.name, dir })
    }
  }
  let bases = roots
  if (!bases) {
    bases = []
    for (const h of await homeDirs(deps)) bases.push(...await scanRootsFor(h, deps))
  }
  for (const b of bases) await walk(b, 0)
  return out
}
