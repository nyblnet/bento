// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// How a document that asks where to save becomes one that never asks —
// with as little navigating as possible. Shared by the ⌘S offer window and
// the side panel's button, which run in the extension's own context (the
// only place a picker may be shown and its handle kept).
//
// TWO RULES, both from the maintainer's day of using it: "you need to go
// back and find the directory again, and often you start at Downloads".
//
// 1. GRANT THE FOLDER, NOT THE FILE, whenever Chrome allows it. A document
//    in any subfolder (Documents/Decks, Desktop/teams-test, the Bento
//    folder) gets a folder grant, and every sibling saves silently from
//    then on — one dialog per folder, not one per file. Only a document
//    sitting DIRECTLY in the home folder, Documents, Desktop or Downloads
//    falls back to a file grant: Chrome refuses those four as wholes.
// 2. OPEN THE PICKER NEAR THE DOCUMENT. `startIn` takes a handle, and the
//    extension holds handles — folder grants and file grants — with known
//    paths. The one sharing the longest path with the document is where the
//    dialog opens (a folder handle opens in itself, a file handle in its
//    parent); with nothing near, the well-known folder the path is under.
//    `id` makes Chrome remember the last folder chosen for these pickers.

import { getGrants, putGrants } from './status.js'
import { prefixes, learnPrefix } from './db.js'
import { prefixFor } from './route.js'
import { listFileGrants, grantPickedFile } from './filegrant.js'

export const PICKER_ID = 'bento-grant'

const segs = (p) => String(p).split('/').filter(Boolean)
const dirOf = (p) => p.slice(0, p.lastIndexOf('/'))

/** Is this document directly in a folder Chrome will not grant (home, Documents, Desktop, Downloads)? */
export function inBlockedFolder(path) {
  const d = dirOf(String(path))
  return /^\/(Users|home)\/[^/]+(\/(Documents|Desktop|Downloads))?$/.test(d)
    || /^\/[A-Za-z]:\/Users\/[^/]+(\/(Documents|Desktop|Downloads|OneDrive(\/(Documents|Desktop))?))?$/.test(d)
}

/** The folder a grant should cover: the document's own folder. */
export const folderOf = (path) => dirOf(String(path))

const commonDepth = (a, b) => {
  const x = segs(a), y = segs(b)
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return i
}

/**
 * Where a picker for this document should open: the held handle nearest to
 * it, else the well-known folder its path is under. `deps` lets the rig
 * supply grants without a browser.
 */
export async function startInFor(path, deps = {}) {
  const target = folderOf(path)
  const cands = []
  try {
    const known = await (deps.prefixes ?? prefixes)()
    for (const dir of await (deps.getGrants ?? getGrants)()) {
      const at = known[dir.name]
      if (at) cands.push({ handle: dir, dir: at })
    }
  } catch { /* none */ }
  try {
    for (const g of await (deps.listFileGrants ?? listFileGrants)()) if (g.path) cands.push({ handle: g.handle, dir: dirOf(g.path) })
  } catch { /* none */ }
  let best = null
  for (const c of cands) {
    const d = commonDepth(c.dir, target)
    // only a candidate that shares more than the home itself is "near"
    if (d >= 3 && (!best || d > best.d)) best = { d, handle: c.handle }
  }
  if (best) return best.handle
  return /\/Downloads\//.test(path) ? 'downloads' : /\/Desktop\//.test(path) ? 'desktop' : 'documents'
}

/**
 * Grant the folder a document lives in (or any folder above it that Chrome
 * will give). The picker opens near the document; the choice is accepted
 * only when the grant really contains the document — the grant itself
 * resolves the path (route.js prefixFor). Returns { ok, name } or
 * { ok:false, reason: 'not-containing'|'denied' }.
 */
export async function grantFolderFor(path, deps = {}) {
  const pick = deps.showDirectoryPicker ?? ((o) => window.showDirectoryPicker(o))
  const dir = await pick({ mode: 'readwrite', id: PICKER_ID, startIn: await startInFor(path, deps) })
  if (await dir.requestPermission({ mode: 'readwrite' }) !== 'granted') return { ok: false, reason: 'denied' }
  const prefix = await (deps.prefixFor ?? prefixFor)(dir, path)
  if (!prefix) return { ok: false, reason: 'not-containing', name: dir.name }
  const dirs = await (deps.getGrants ?? getGrants)()
  let already = false
  for (const d of dirs) { try { if (await d.isSameEntry(dir)) already = true } catch { /* stale */ } }
  if (!already) await (deps.putGrants ?? putGrants)([...dirs, dir])
  await (deps.learnPrefix ?? learnPrefix)(dir.name, prefix)
  return { ok: true, name: dir.name }
}

/** Grant just this file — for a document directly in a folder Chrome refuses. The picker opens near it. */
export async function grantFileFor(path, deps = {}) {
  const pick = deps.showOpenFilePicker ?? ((o) => window.showOpenFilePicker(o))
  const [handle] = await pick({ id: PICKER_ID, startIn: await startInFor(path, deps), multiple: false, types: [{ description: 'Bento', accept: { 'text/html': ['.html'] } }] })
  if (!handle) return { ok: false, reason: 'cancelled' }
  return (deps.grantPickedFile ?? grantPickedFile)(handle, path)
}
