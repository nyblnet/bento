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
