// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The extension side: the only place that holds the folder grant and the only
// place that writes.
//
// MEASURED (docs/DECISIONS.md, 2026-08-02): one `showDirectoryPicker` grant
// survives IndexedDB and a reload — still `granted` with no gesture, and
// re-grantable with one click when it lapses — and covers files INSIDE the
// folder that were never picked. That is what lets a deck opened by
// double-clicking be written without a destination prompt, which no web page
// can do for itself.
//
// TWO RULES SHAPE THIS FILE.
//
// 1. NO STATE BETWEEN MESSAGES. An MV3 service worker is evicted whenever the
//    browser feels like it, and a save serialises the whole deck first —
//    encryption, preview, ~900KB — so an eviction can easily land between
//    "which file is this?" and "write it". Anything held in memory across that
//    gap produces a failed save that looks random and reproduces on nobody's
//    machine. So every message re-resolves from the grant; nothing is cached.
//
// 2. THE PAGE DOES NOT GET TO SAY WHICH FILE IT IS. `sender.url` is set by the
//    browser, not by the content script, so it cannot be forged by the document
//    — whereas anything in the message payload can. A local HTML file is
//    untrusted content; if it could name its own target it could name somebody
//    else's deck in the granted folder and overwrite it. The path comes from
//    the sender, and a payload path is ignored even if present.

const DB = 'bento-tray'
const STORE = 'grant'

const open = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1)
  r.onupgradeneeded = () => r.result.createObjectStore(STORE)
  r.onsuccess = () => res(r.result)
  r.onerror = () => rej(r.error)
})

async function readGrant() {
  const d = await open()
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readonly')
    const q = t.objectStore(STORE).get('dir')
    q.onsuccess = () => res(q.result ?? null)
    q.onerror = () => rej(q.error)
  })
}

/**
 * The file this message is about, according to the BROWSER.
 *
 * Not according to the page: a content script's `sender.url` is stamped by
 * Chrome. Only `file:` is accepted — the bridge exists for local documents, and
 * an http page has no business claiming one.
 */
export function pathFromSender(sender) {
  try {
    const u = new URL(sender?.url ?? '')
    if (u.protocol !== 'file:') return null
    return decodeURIComponent(u.pathname)
  } catch {
    return null
  }
}

/** Every file of this name in the granted tree. Depth-limited: a Decks folder
 *  is not a filesystem, and an unbounded walk on a mistakenly-granted home
 *  directory would hang the save the user is waiting on. */
export async function findByName(dir, name, depth = 0, found = []) {
  if (depth > 4 || found.length > 1) return found
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind === 'file' && entryName === name) found.push(handle)
    else if (handle.kind === 'directory' && !entryName.startsWith('.')) {
      await findByName(handle, name, depth + 1, found)
    }
    if (found.length > 1) break // ambiguous is already an answer
  }
  return found
}

/**
 * Resolve the writable handle for a sender's own file, or say why not.
 *
 * THE MATCHING PROBLEM. A page is at `/Users/…/Decks/Q3.bento.html`; a
 * `FileSystemDirectoryHandle` knows its own NAME but not its path, and no API
 * exposes one, so the two cannot be compared directly. This searches the
 * granted tree for that file name and requires EXACTLY ONE match — unambiguous
 * in the ordinary case, and when it is ambiguous the answer is to decline and
 * let the browser's own picker handle it. Declining costs a prompt; guessing
 * costs somebody's file.
 */
export async function resolve(sender, deps = {}) {
  const grant = deps.readGrant ?? readGrant
  const search = deps.findByName ?? findByName

  const path = pathFromSender(sender)
  if (!path) return { ok: false, reason: 'not a local file' }

  const dir = await grant()
  if (!dir) return { ok: false, reason: 'no folder granted' }
  // queryPermission only — never prompt from here. A service worker has no user
  // gesture, so a request would be refused, and a save is the wrong moment to
  // discover that. The options page is where granting happens.
  const perm = await dir.queryPermission({ mode: 'readwrite' })
  if (perm !== 'granted') return { ok: false, reason: 'folder grant needs renewing' }

  const name = path.split('/').pop() || ''
  if (!name) return { ok: false, reason: 'no file name' }
  const hits = await search(dir, name)
  if (hits.length !== 1) {
    return {
      ok: false,
      reason: hits.length ? `${name} is ambiguous in the granted folder` : 'not in the granted folder',
    }
  }

  // The candidate shares the sender's FILE NAME. That is not the same as being
  // the sender's file, and treating it as such destroys documents:
  //
  //   grant = ~/Documents, which holds ~/Documents/Clients/Q3.bento.html
  //   the user opens a working copy at ~/Desktop/Q3.bento.html
  //   -> exactly one hit, so a save wrote the Desktop deck over the Clients one
  //      and never wrote the file being edited.
  //
  // The ambiguity guard above cannot catch that: the sender's own copy is
  // OUTSIDE the grant, so it is not a second hit. No attacker is required.
  //
  // `resolve()` on the directory gives the candidate's path segments relative to
  // the grant, so the sender's absolute path must end with them. An earlier
  // comment here claimed the two "cannot be compared directly" — that is true of
  // the directory handle, which knows no path, but not of a resolved child.
  const rel = await dir.resolve(hits[0])
  if (!rel || !rel.length) return { ok: false, reason: 'not inside the granted folder' }
  const suffix = `/${rel.join('/')}`
  if (!path.endsWith(suffix)) {
    return { ok: false, reason: `${name} in the granted folder is a different file` }
  }

  return { ok: true, name, handle: hits[0], within: suffix }
}

/** Can this sender's file be written in place? Resolves; writes nothing. */
export async function claim(sender, deps) {
  const r = await resolve(sender, deps)
  return r.ok ? { ok: true, name: r.name } : { ok: false, reason: r.reason }
}

/** Write the sender's own file. Re-resolves, so no state is carried. */
export async function write(sender, text, deps) {
  const r = await resolve(sender, deps)
  if (!r.ok) return { ok: false, reason: r.reason }
  try {
    const w = await r.handle.createWritable()
    await w.write(text)
    await w.close()
    return { ok: true, bytes: text.length }
  } catch (e) {
    return { ok: false, reason: `${e.name}: ${e.message}` }
  }
}

// `chrome` is absent when this module is loaded by the test rig, which imports
// the logic above and never needs the listener.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const run = msg?.op === 'claim' ? claim(sender)
      : msg?.op === 'write' ? write(sender, msg.payload?.text ?? '')
      : Promise.resolve({ ok: false, reason: 'unknown op' })
    run.then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e?.message || e) }))
    return true // async response
  })
}
