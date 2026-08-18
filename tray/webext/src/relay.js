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

window.addEventListener('message', async (ev) => {
  const d = ev.data
  // Same-window only: `ev.source !== window` rejects anything posted in from a
  // frame or an opener, which is the one way a page could try to speak for
  // another document.
  if (ev.source !== window || !d || d[CH] !== true || d.dir !== 'req') return

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
