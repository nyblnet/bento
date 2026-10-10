// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// "Save a copy…" and exports, answered by the extension so they start BESIDE
// the document instead of in Downloads.
//
// WHY THE PAGE CANNOT DO THIS ITSELF. A double-clicked document has no file
// handle, and a picker's `startIn` takes a handle, never a path. So the
// browser's own dialog opens wherever it last was — usually Downloads. The
// extension knows where the document lives (`sender.url`, stamped by the
// browser) and often holds a handle for its folder. A handle cannot cross
// into the page (it would land in the one origin every local file shares), so
// the dialog runs in the extension's own small window instead.
//
// THE KERNEL IS UNCHANGED. save.ts already tells hosts what a picker call is
// for, by its `id` (pickerIdFor): `bento-copy` for "Save a copy…",
// `bento-share` for every export. page-bridge.js sends those here; ⌘S
// (`bento-doc`) and backups never come this way.
//
// THE FLOW
//   page   showSaveFilePicker({id:'bento-copy', suggestedName})
//          → `saveas` {name, purpose}       (waits while the window is open)
//   worker opens src/saveas.html with a token; records { path, purpose, name,
//          dir } in this module's IndexedDB — `dir` is the document's own
//          folder when a folder grant reaches it
//   window "Save next to <document>" (one click, into `dir`), or "Choose a
//          folder…" (the picker, opening in `dir` or the nearest folder the
//          extension holds). Its choice is written to the record.
//   page   gets { ok, token, name } and a handle whose close() sends
//          `saveas.write` {token, text}; the worker writes the chosen file.
//
// WHAT HOLDS IT
//   · The record is bound to the path of the document that asked. A write
//     with that token from any other document is refused.
//   · The page supplies only a NAME, and only as a suggestion: the person
//     sees it and can change it. A beside-name is a single file name ending
//     .bento.html, never the open document's own, and an existing file is
//     replaced only after the person says so in the window.
//   · Nothing is written until the page sends bytes, and only to the place
//     the person chose.
//   · A copy's token stays valid for that document's later writes: save.ts
//     makes a "Save a copy…" target the next ⌘S, as the browser's own picker
//     does. An export's is spent by its one write. Either ends when the
//     document unloads (`drop`), or after KEEP_MS.
//   · The suggestion never arrives aimed at an existing file (freshName); an
//     existing file is replaced only for a name the person typed, after a
//     warning, and that choice is checked again at write time.
//
// Pure: storage, folder resolution and the window come in as `deps`, so
// scripts/test-webext-saveas.ts runs the real logic in node.

export const PURPOSES = Object.freeze({ 'bento-copy': 'copy', 'bento-share': 'share' })
export const EXT = '.bento.html'
/** A record (and its handle) outlives the window by this much; swept on startup. */
export const KEEP_MS = 24 * 3600 * 1000

/**
 * A name the window may create beside the document. `{ ok, name }` or
 * `{ ok:false, reason }`. The compound extension is appended to a bare name,
 * as the browser's own picker does for `accept: ['.bento.html']`.
 */
/**
 * Characters a file name may not carry: path separators, controls, and the
 * invisible FORMAT characters (bidi overrides and isolates, zero-width) — with
 * those, "report\u202Elmth.bento.html" displays as something it is not.
 */
const BAD_CHARS = /[/\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/

/** The same name as far as a file system may care: Unicode-normalised (NFC) and case-folded. */
export const sameName = (a, b) => String(a).normalize('NFC').toLowerCase() === String(b).normalize('NFC').toLowerCase()

export function besideName(proposed, original) {
  let n = String(proposed ?? '').trim()
  if (!n) return { ok: false, reason: 'empty' }
  if (BAD_CHARS.test(n) || n === '.' || n === '..') return { ok: false, reason: 'bad-name' }
  if (!n.toLowerCase().endsWith(EXT)) n = n.replace(/\.html?$/i, '') + EXT
  if (n.length > 200) return { ok: false, reason: 'bad-name' }
  if (original && sameName(n, original)) return { ok: false, reason: 'is-original' }
  return { ok: true, name: n }
}

/** Is there a file of this name in `dir`? */
async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true } catch (e) { return e?.name !== 'NotFoundError' }
}

/**
 * A name that is FREE in `dir`: the suggestion, or "<stem> copy", "<stem> copy 2"…
 * The page chooses the suggestion, so it must never arrive aimed at a file
 * that is already there: a hostile document could name a sibling deck and
 * have two clicks replace it. Replacing is only ever for a name the PERSON typed.
 */
export async function freshName(dir, name, original) {
  if (!dir || !(await exists(dir, name))) return name
  const stem = name.slice(0, -EXT.length).replace(/ copy( \d+)?$/, '')
  for (let i = 1; i < 100; i++) {
    const n = `${stem} copy${i > 1 ? ` ${i}` : ''}${EXT}`
    if (!sameName(n, original) && !(await exists(dir, n))) return n
  }
  return name
}

/**
 * The window's rule for a beside-name that already exists: 'ok' (free),
 * 'refuse' (the page's suggestion, untouched — never replaced), 'confirm'
 * (the person typed it — warn first), 'replace' (warned, and they clicked again).
 */
export function replaceDecision({ exists: there, edited, confirmed }) {
  if (!there) return 'ok'
  if (!edited) return 'refuse'
  return confirmed ? 'replace' : 'confirm'
}

/** The page's suggestion, made safe to SHOW (it is never used as a path). */
export function suggestion(name, original) {
  const r = besideName(String(name ?? '').split(/[/\\]/).pop(), original)
  return r.ok ? r.name : (String(original ?? 'Untitled').replace(/\.bento\.html?$/i, '') + ' copy' + EXT)
}

/**
 * The page asked. Opens the window and waits for it; returns what the page
 * gets: `{ ok, token, name }`, `{ ok:false, cancelled:true }`, or `{ ok:false,
 * reason }` — the last means "use the browser's own picker".
 */
export async function ask(path, payload, deps) {
  if (!path) return { ok: false, reason: 'not a document' }
  const purpose = PURPOSES[payload?.id]
  if (!purpose) return { ok: false, reason: 'not a save-as' }
  // One window per document at a time: a page cannot stack them up.
  if (deps.busy?.(path)) return { ok: false, cancelled: true }
  const original = path.split('/').pop()
  const name = suggestion(payload?.name, original)
  let dir = null
  try { dir = await deps.folderOf() } catch { dir = null }
  const shown = dir ? await freshName(dir, name, original) : name
  const token = deps.token()
  await deps.db.put(token, { path, purpose, name: shown, dir, choice: null, at: deps.now() })
  const answered = await deps.openWindow(token, path)
  const rec = await deps.db.get(token)
  if (!answered || !rec?.choice) {
    await deps.db.del(token)
    return answered === null ? { ok: false, reason: 'window unavailable' } : { ok: false, cancelled: true }
  }
  return { ok: true, token, name: rec.choice.name }
}

/** The page's bytes, for the place the person chose. */
export async function write(path, payload, deps) {
  if (!path) return { ok: false, reason: 'not a document' }
  const token = payload?.token
  if (typeof token !== 'string' || typeof payload?.text !== 'string') return { ok: false, reason: 'bad request' }
  const rec = await deps.db.get(token)
  if (!rec?.choice) return { ok: false, reason: 'no such save' }
  if (rec.path !== path) return { ok: false, reason: 'not this document\'s save' }
  try {
    let h
    if (rec.choice.kind === 'beside') {
      if (!rec.dir) return { ok: false, reason: 'no folder' }
      const ok = besideName(rec.choice.name, path.split('/').pop())
      if (!ok.ok) return { ok: false, reason: ok.reason }
      if (await rec.dir.queryPermission({ mode: 'readwrite' }) !== 'granted') return { ok: false, reason: 'folder grant needs renewing' }
      let there = null
      try { there = await rec.dir.getFileHandle(ok.name) } catch (e) { if (e?.name !== 'NotFoundError') throw e }
      if (there) {
        // never the open document, compared as FILES (NFD vs NFC, case) when its handle is known
        const doc = await deps.docHandle?.().catch(() => null)
        if (doc && await there.isSameEntry(doc)) return { ok: false, reason: 'is-original' }
        // an existing file is replaced only when the person chose to, in the window;
        // later writes of a "Save a copy" (save.ts's next ⌘S target) are to our own file
        if (!rec.written && rec.choice.replace !== true) return { ok: false, reason: 'exists' }
      }
      h = there ?? await rec.dir.getFileHandle(ok.name, { create: true })
    } else if (rec.choice.kind === 'handle') {
      h = rec.choice.handle
      if (await h.queryPermission({ mode: 'readwrite' }) !== 'granted') return { ok: false, reason: 'permission lapsed' }
    } else {
      return { ok: false, reason: 'no such save' }
    }
    const w = await h.createWritable()
    await w.write(payload.text)
    await w.close()
    // An export is written once: save.ts never makes it a later ⌘S target (that
    // would overwrite a view-only or invite copy with the full document). A
    // copy IS the next ⌘S target, so its record stays for this session.
    if (rec.purpose === 'share') await deps.db.del(token)
    else await deps.db.put(token, { ...rec, written: true, at: deps.now() })
    return { ok: true, name: h.name, bytes: payload.text.length }
  } catch (e) {
    return { ok: false, reason: `${e?.name}: ${e?.message}` }
  }
}

/** The document is going away: its saves end with it. Only the document that made them may drop them. */
export async function drop(path, payload, deps) {
  const rec = typeof payload?.token === 'string' ? await deps.db.get(payload.token) : null
  if (rec && path && rec.path === path) await deps.db.del(payload.token)
  return { ok: true }
}

/** Records older than KEEP_MS. */
export async function gc(deps) {
  const cut = deps.now() - KEEP_MS
  for (const [k, v] of await deps.db.all()) if (!v?.at || v.at < cut) await deps.db.del(k)
}

/** The window's helpers: the record, and storing the person's choice. */
export async function readRecord(token, db) { return db.get(token) }
export async function choose(token, choice, db) {
  const rec = await db.get(token)
  if (!rec) return false
  await db.put(token, { ...rec, choice })
  return true
}

/** Its own small database: handles are structured-cloneable into IndexedDB, not into chrome.storage. */
export function idb(name = 'bento-saveas') {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(name, 1)
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('rec')) r.result.createObjectStore('rec') }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const run = async (mode, fn) => {
    const d = await open()
    return new Promise((res, rej) => {
      const t = d.transaction('rec', mode)
      const req = fn(t.objectStore('rec'))
      t.oncomplete = () => res(req?.result)
      t.onerror = () => rej(t.error)
    })
  }
  return {
    get: (k) => run('readonly', (s) => s.get(k)).then((v) => v ?? null),
    put: (k, v) => run('readwrite', (s) => s.put(v, k)).then(() => {}),
    del: (k) => run('readwrite', (s) => s.delete(k)).then(() => {}),
    all: async () => {
      const keys = await run('readonly', (s) => s.getAllKeys())
      const vals = await run('readonly', (s) => s.getAll())
      return (keys ?? []).map((k, i) => [k, vals[i]])
    },
  }
}
