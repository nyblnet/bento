// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The isolated-world half of the bridge: a pure relay.
//
// Content scripts in the ISOLATED world can talk to the extension but cannot
// touch the page's globals; a MAIN-world script can define `showSaveFilePicker`
// but has no extension APIs. Neither half can do the job alone, so the pair
// meet over `window.postMessage`.
//
// This file deliberately holds NO logic. It does not decide what may be
// written, does not read the document, and does not touch the filesystem — it
// forwards two message shapes and nothing else. Every decision that matters
// lives on the extension side, which is the only side the page cannot reach.

const CH = '__bento_tray__'

/**
 * Say hello, once, on load.
 *
 * This is the ONLY thing here that the page did not ask for, and it exists to
 * fix a chicken-and-egg. The tray lists documents by walking granted folders,
 * but a `FileSystemDirectoryHandle` has no path, so it cannot turn one into a
 * URL to open. The path is learned by subtracting a file's route-from-the-grant
 * from its absolute `sender.url` — and that only happened during a SAVE. So on
 * a fresh install every row was listed and none could be opened, which is
 * exactly as useful as no list at all.
 *
 * Opening a document is the natural moment to learn where its folder is. One
 * document opened teaches the prefix for its whole folder, and every other
 * document in there becomes openable from the tray.
 *
 * It sends no payload — the extension reads `sender.url`, which the browser
 * stamps and this page cannot forge — and ignores the answer. A page that
 * cannot be placed inside a grant simply is not one, and nothing is written
 * either way.
 */
chrome.runtime.sendMessage({ op: 'hello' }).catch(() => {
  /* worker asleep, extension reloading, page outside every grant — all fine */
})

// ---------------------------------------------------------------- DocStore
//
// The page speaks BYTES (store.get/set/list/delete — the kernel's DocStore
// interface); runtime messaging speaks JSON. So this is the one place bytes
// become base64 and back, and a large value is cut into chunks under one
// transaction id and committed in one step (store.js). Encoding, not logic:
// every decision — which partition, what is allowed — is the worker's.
const STORE_CHUNK = 3 * 1024 * 1024
const STORE_MAX = 64 * 1024 * 1024
const toB64 = (u8) => {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (b64) => {
  const s = atob(b64)
  const u8 = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i)
  return u8
}
const ask = (op, payload) => chrome.runtime.sendMessage({ op, payload })

async function storeRequest(op, payload) {
  if (op === 'store.set') {
    const bytes = payload?.bytes
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'bytes must be a Uint8Array' }
    if (bytes.length > STORE_MAX) return { ok: false, reason: 'too large' }
    if (bytes.length <= STORE_CHUNK) return ask('store.set', { name: payload.name, data: toB64(bytes) })
    const tx = crypto.randomUUID()
    let n = 0
    for (let i = 0; i < bytes.length; i += STORE_CHUNK, n++) {
      const r = await ask('store.put', { name: payload.name, tx, i: n, data: toB64(bytes.subarray(i, i + STORE_CHUNK)) })
      if (!r?.ok) return r
    }
    return ask('store.commit', { name: payload.name, tx, n })
  }
  if (op === 'store.get') {
    // a value replaced mid-read is read again from the top, once
    for (let attempt = 0; attempt < 2; attempt++) {
      const m = await ask('store.get', { name: payload?.name })
      if (!m?.ok) return m
      if (!m.found) return { ok: true, bytes: null }
      if (typeof m.inline === 'string') return { ok: true, bytes: fromB64(m.inline) }
      const out = new Uint8Array(m.size)
      let at = 0
      let gone = false
      for (let i = 0; i < m.n; i++) {
        const c = await ask('store.chunk', { name: payload.name, tx: m.tx, i })
        if (!c?.ok) { if (c?.reason === 'gone') { gone = true; break } return c }
        const part = fromB64(c.data)
        out.set(part, at)
        at += part.length
      }
      if (!gone) return { ok: true, bytes: out }
    }
    return { ok: false, reason: 'changed while reading' }
  }
  if (op === 'store.list') return ask('store.list', { prefix: payload?.prefix ?? '' })
  if (op === 'store.delete') return ask('store.delete', { name: payload?.name })
  return { ok: false, reason: 'unknown op' }
}

window.addEventListener('message', async (ev) => {
  const d = ev.data
  // Same-window only: `ev.source !== window` rejects anything posted in from a
  // frame or an opener, which is the one way a page could try to speak for
  // another document.
  if (ev.source !== window || !d || d[CH] !== true || d.dir !== 'req') return

  if (typeof d.op === 'string' && d.op.startsWith('store.')) {
    let result
    try { result = await storeRequest(d.op, d.payload) } catch (e) { result = { ok: false, reason: String(e?.message || e) } }
    window.postMessage({ [CH]: true, dir: 'res', id: d.id, result }, '*')
    return
  }

  let result
  try {
    result = await chrome.runtime.sendMessage({ op: d.op, payload: d.payload })
  } catch (e) {
    // The service worker can be asleep or the extension reloading; a failure
    // here means the page falls back to the native picker, not that a save is
    // lost.
    result = { ok: false, reason: String(e?.message || e) }
  }
  window.postMessage({ [CH]: true, dir: 'res', id: d.id, result }, '*')
})
