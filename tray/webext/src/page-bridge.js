// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The page-world half of the bridge. Runs in the DOCUMENT's world (MAIN), at
// document_start, so it is in place before the deck's own runtime boots.
//
// WHAT IT OVERRIDES AND WHY. `kernel/src/save.ts` tests exactly one thing —
// `typeof window.showSaveFilePicker === 'function'` — and needs only:
//
//     showSaveFilePicker({suggestedName}) -> { name, createWritable() }
//     createWritable() -> { write(Blob|string), close() }
//
// That is tray's contract (tray/README.md), and it is why no web-side change is
// needed: every in-place path (⌘S, autosave write-back, self-update) already
// routes through that function, including in decks whose embedded runtime
// predates this extension.
//
// The wrinkle unique to a browser host: on `file://` in Chrome that function
// ALREADY EXISTS. So unlike tray on iOS, where the polyfill fills a gap, here it
// REPLACES a working API that prompts for a destination. The override therefore
// has to be conservative — see `wantsOpenFile` below. Anything it does not
// recognise falls through to the native picker, which still works exactly as it
// did.

;(() => {
  const native = window.showSaveFilePicker?.bind(window)
  const CH = '__bento_tray__'
  let seq = 0
  const pending = new Map()

  /** One round trip to the isolated world, which relays to the extension. */
  const ask = (op, payload) =>
    new Promise((resolve) => {
      const id = `${Date.now()}-${seq++}`
      pending.set(id, resolve)
      window.postMessage({ [CH]: true, dir: 'req', id, op, payload }, '*')
      // A host that never answers must not hang a save forever — the caller
      // falls back to the native picker instead.
      setTimeout(() => {
        if (pending.delete(id)) resolve({ ok: false, reason: 'timeout' })
      }, 5000)
    })

  window.addEventListener('message', (ev) => {
    const d = ev.data
    if (ev.source !== window || !d || d[CH] !== true || d.dir !== 'res') return
    const resolve = pending.get(d.id)
    if (resolve) { pending.delete(d.id); resolve(d.result) }
  })

  /**
   * Is this save aimed at the file we are already looking at?
   *
   * The deck asks to save under a suggested name. When that name is the file on
   * screen, the author means "save my work" and the host can write in place.
   * When it differs — "Save a copy…", a template, a read-only export, an invite
   * — they mean a NEW file somewhere they choose, and taking that over silently
   * would write to a place nobody asked for. Those go to the native picker.
   */
  /**
   * Is this save meant to overwrite the document on screen?
   *
   * `id` is the answer, and it is the ONLY reliable one. It was added to
   * `save.ts` for exactly this (#213, `pickerIdFor`): before it, ⌘S and "Save a
   * copy…" reached the picker with byte-identical arguments, this code guessed
   * in-place, and it overwrote the open deck — no dialog, no new file.
   *
   *   bento-doc    ⌘S, or a first save of an unsaved document → write in place
   *   bento-copy   "Save a copy…"                             → the author chooses
   *   bento-share  view-only, package, invite, template       → the author chooses
   *
   * Default to declining. An unknown or absent id means a caller we have not
   * seen; the native picker is the correct answer.
   *
   * And the id alone is not enough: a deck whose runtime PREDATES #213 sends
   * `bento-doc` for every save, "Save a copy…" included, so acting on it there
   * reproduces exactly the bug this replaced. Hence the runtime-version gate —
   * old decks keep the behaviour they have today, which is correct and safe.
   * The failure directions are not symmetric: declining costs a prompt, taking
   * over wrongly costs the file.
   */
  /**
   * The release that first sent a distinct picker `id` per purpose (#213).
   *
   * CONFIRMED: `pickerIdFor` is absent from v1.0.14 and present in v1.0.15, so
   * 1.0.15 is the floor. A deck whose embedded runtime predates it sends
   * `bento-doc` for EVERY save — including "Save a copy…" — so the id carries
   * no information there and this bridge must not act on it. Those decks get
   * the browser's own picker, exactly as they do with no extension installed.
   */
  const ID_SINCE = [1, 0, 15]

  const runtimeAtLeast = (min) => {
    const v = window.bento?.updates?.version
    if (typeof v !== 'string') return false // no runtime yet, or too old to say
    const parts = v.split('.').map((n) => parseInt(n, 10))
    if (parts.some(Number.isNaN)) return false
    for (let i = 0; i < min.length; i++) {
      if ((parts[i] ?? 0) > min[i]) return true
      if ((parts[i] ?? 0) < min[i]) return false
    }
    return true
  }

  const wantsOpenFile = (opts) => opts?.id === 'bento-doc' && runtimeAtLeast(ID_SINCE)

  /**
   * Options safe to hand to the NATIVE picker.
   *
   * MEASURED 2026-08-02, and it broke every export: once a save returns one of
   * our handles, `save.ts` keeps it (`fileHandle = handle`) and later passes it
   * back as `startIn` — `...(fileHandle ? { startIn: fileHandle } : {})`. The
   * native picker requires a REAL FileSystemHandle there, so it threw
   * TypeError, and `pickHandle` rethrows anything that is not AbortError. View-
   * only and present-only copies simply stopped working, with no clue pointing
   * here.
   *
   * A polyfilled handle must never escape into an API that needs the genuine
   * article. Anything not actually a FileSystemHandle is dropped; `startIn` is
   * only ever a convenience about which folder opens first.
   */
  const forNative = (opts) => {
    const out = { ...opts }
    const real = typeof FileSystemHandle !== 'undefined' && out.startIn instanceof FileSystemHandle
    if (out.startIn && !real) delete out.startIn
    return out
  }

  window.showSaveFilePicker = async (opts = {}) => {
    if (!wantsOpenFile(opts)) {
      if (native) return native(forNative(opts))
      throw new DOMException('No file picker available', 'AbortError')
    }
    // No path is sent: the extension takes it from `sender.url`, which the
    // browser stamps and this page cannot forge. A local HTML file is untrusted
    // content, and one that could name its own target could name someone else's
    // deck in the granted folder.
    const claim = await ask('claim')
    if (!claim?.ok) {
      // Say WHY. Falling through to the native picker is the safe outcome, but
      // an unexplained dialog is indistinguishable from the extension not being
      // installed — which cost a full diagnostic round trip. The common cause
      // is the folder grant lapsing after an extension reload, which the
      // options page can renew in one click.
      console.info('[bento-tray] not saving in place:', claim?.reason ?? 'no answer from the extension',
        '— falling back to the browser picker. Open the extension options to check the folder grant.')
      // The extension cannot reach this file — no folder granted, or the deck
      // lives outside it. The native picker is not a worse outcome, it is
      // exactly what happens without the extension installed.
      if (native) return native(forNative(opts))
      throw new DOMException('No writable location', 'AbortError')
    }
    return {
      name: claim.name,
      kind: 'file',
      createWritable: async () => {
        const chunks = []
        return {
          async write(data) { chunks.push(data) },
          async close() {
            const blob = chunks.length === 1 && chunks[0] instanceof Blob
              ? chunks[0]
              : new Blob(chunks)
            const text = await blob.text()
            const res = await ask('write', { text })
            if (!res?.ok) throw new DOMException(res?.reason || 'write failed', 'NotAllowedError')
            console.info('[bento-tray] wrote', claim.name, `(${res.bytes} bytes) in place`)
          },
        }
      },
      // save.ts re-queries permission on a retained handle; a host-backed handle
      // is granted for as long as the folder grant stands.
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      isSameEntry: async () => false,
    }
  }
})()
