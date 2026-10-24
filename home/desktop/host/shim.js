// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Tauri transport for home/bridge.js, shaped exactly like Android's
// WebMessageListener object (postMessage(string) out, onmessage({data}) back),
// so bridge.js's existing `droid` path carries it and the shared file needs no
// edit. Runs before bridge.js, in the MAIN FRAME ONLY.
//
// Every call carries this load's CAPABILITY secret (security §19d). Tauri's
// IPC has no frame identity and its invoke key is per process and readable by
// page script, so the secret is the frame identity. The host hands it to this
// realm alone, after a finished load of the document, with a NONCE; the shim
// echoes the nonce, and the host arms the secret only if no newer load has
// started meanwhile (§19e: generation-bound arming). Calls made before that
// are queued, never sent. The secret lives in this closure.
;(function () {
  if (window.top !== window) return
  let cap = null
  let armed = false
  const queue = []
  const native = {
    onmessage: null,
    postMessage(s) { armed ? send(s) : queue.push(s) },
  }
  function send(s) {
    const back = (data) => native.onmessage && native.onmessage({ data })
    window.__TAURI_INTERNALS__.invoke('bento_file', { msg: s, cap }).then(back, (e) => {
      let id = null
      try { id = JSON.parse(s).id } catch (_) {}
      back(JSON.stringify({ id, ok: false, value: String(e) }))
    })
  }
  Object.defineProperty(window, '__bentoTrayNative', { value: native })
  // Non-writable, non-configurable: page script cannot swap it to catch the
  // secret on its way in. Takes one secret per load.
  Object.defineProperty(window, '__bentoArm', { value: function (s, nonce) {
    if (cap || typeof s !== 'string' || typeof nonce !== 'string') return
    cap = s
    window.__TAURI_INTERNALS__.invoke('bento_arm', { nonce, cap: s }).then(() => {
      armed = true
      queue.splice(0).forEach(send)
    }, () => {})
  } })
})()
