// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The ENTIRE web-side surface of a bento/home native host: a polyfill of the
// one File System Access call Bento tests for. Injected at document start,
// because capability is read during boot — inject it later and the editor has
// already decided it cannot save.
//
// Bento needs exactly this much of the API (kernel/src/save.ts):
//   showSaveFilePicker({suggestedName}) -> { name, createWritable() }
//   createWritable() -> { write(Blob|string), close() }
// ...plus, from runtimes that know to ask, the file it was opened with:
//   launchQueue.setConsumer(fn) -> fn({ files: [handle] })
// ...and hasFsAccess() is just `typeof window.showSaveFilePicker === 'function'`.
//
// That is why the app needs NO changes to Bento and works with decks saved by
// any past version: every in-place path (⌘S, autosave write-back, self-update)
// already routes through this one function. A bespoke `window.__bentoHost`
// bridge would only have helped decks re-saved after it shipped.
//
// ONE FILE, EVERY HOST. This used to live in home/ios/Resources/ and iOS was
// the only caller. It is shared now because the interesting part of it is not
// the transport — it is the FileSystemWritableFileStream semantics below, whose
// comments record a bug that wrote users' documents out as zero bytes. A second
// host with its own copy is a second chance to reintroduce exactly that. The
// per-platform half is the ~15 lines of transport immediately below; everything
// after it is identical on every host, by construction.
(function () {
  // ---------------------------------------------------------------- transport
  //
  // WebKit hands the page a message handler that takes a structured-cloneable
  // object and replies by evaluating JS in the frame.
  //
  // Android's WebMessageListener hands over a named JS object with
  // `postMessage(string)` and an `onmessage` event, so the payload is JSON in
  // both directions and the reply arrives as an event instead of an injected
  // call. It is used in preference to addJavascriptInterface precisely because
  // it is ORIGIN-SCOPED: an interface added the old way is injected into every
  // frame, so a remote iframe inside an untrusted document would have been
  // handed the user's file.
  const wk = window.webkit && window.webkit.messageHandlers
    && window.webkit.messageHandlers.bentoFile
  const droid = window.__bentoTrayNative

  const send = wk ? (m) => wk.postMessage(m)
    : droid ? (m) => droid.postMessage(JSON.stringify(m))
      : null

  if (!send) return // plain browser: leave the real API (or its absence) alone

  let seq = 0
  const pending = new Map()

  // native calls back into this — directly on WebKit, via the event below on
  // Android. Kept as a global on both so there is one reply path to reason about.
  window.__bentoNativeReply = (id, ok, value) => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    ok ? p.resolve(value) : p.reject(new Error(value || 'cancelled'))
  }

  if (droid) {
    droid.onmessage = (e) => {
      let r
      // A malformed reply must not take the listener down with it, or every
      // later save on this page hangs waiting for a callback that can no
      // longer arrive.
      try { r = JSON.parse(e.data) } catch (_) { return }
      window.__bentoNativeReply(r.id, r.ok, r.value)
    }
  }

  const call = (op, payload) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    send(Object.assign({ id, op }, payload))
  })

  // ------------------------------------------------------- the polyfill proper

  window.showSaveFilePicker = async (opts) => {
    const want = (opts && opts.suggestedName) || ''
    // Native decides what this call targets; the rule is DETERMINISTIC and lives
    // there, not here. Bento only reaches a picker when it holds no handle —
    // once it has one, ⌘S, autosave write-back and in-place update all reuse it
    // (kernel/src/save.ts). So the FIRST call is "the document already open in
    // the app" and resolves with no UI, and any LATER call is a genuine Save-As
    // or export (read-only copy, invite, template) that must not overwrite it.
    //
    // Do NOT try to infer this by comparing suggestedName to the open file:
    // Bento derives that name from the DECK TITLE, so it rarely matches and
    // every save would wrongly prompt.
    return makeHandle(await begin(want))
  }

  // The FIRST begin is the open document, by the host's rule above. Kept, so a
  // launch consumer that arrives after a ⌘S gets that same name rather than
  // asking again — a second begin would be an export, and would prompt.
  let opened = null
  const begin = (want, launch) => {
    const p = call('begin', launch ? { suggestedName: want, launch: true } : { suggestedName: want })
    if (!opened) {
      opened = p
      // A refused first begin vended nothing, so the next one may still claim it.
      p.catch(() => { if (opened === p) opened = null })
    }
    return p
  }

  // ----------------------------------------------------- the open document
  //
  // `launchQueue` is the File Handling API's way of handing a page the file it
  // was opened with. Without it, a page in this host holds NO handle until its
  // first ⌘S, and Bento's autosave writes the file only when it holds one — so
  // an edit made and left never reached disk. The kernel consumes this at boot
  // and adopts the handle, after which autosave writes in place from the first
  // edit.
  //
  // The request is marked `launch: true`. A host that cannot hand over the open
  // document — already handed out, or (Android) a read-only grant — must answer
  // no, never fall through to an export: the page would adopt an export handle as
  // its own file, and the first autosave after any edit would open a save dialog
  // nobody asked for (measured on Android; the same on iOS, where begin only
  // vends a name and the picker comes with the first write). bridge.js ships inside each host app,
  // so the flag and the host that honours it always arrive together.
  //
  // LAZY, deliberately: nothing is asked of the host until a page calls
  // setConsumer. A document saved by a runtime that predates this never calls
  // it, so its first ⌘S still gets the open document silently, exactly as
  // before. Asking eagerly at load would have spent that first begin and turned
  // every old document's first save into a Save-As prompt.
  //
  // Defined, not assigned: a Chromium WebView may already carry a native
  // launchQueue that will never deliver anything here, and an accessor
  // property silently ignores a plain assignment.
  Object.defineProperty(window, 'launchQueue', { configurable: true, enumerable: true, value: {
    setConsumer(consumer) {
      if (typeof consumer !== 'function') return
      ;(opened || begin('', true)).then(
        (name) => consumer({ files: [makeHandle(name)] }),
        () => { /* the host declined; the page keeps today's ⌘S path */ })
    },
  } })

  // A FileSystemFileHandle faithful enough for apps that are not Bento.
  // Bento itself only ever touches createWritable/write/close, but this host
  // opens ANY self-contained HTML document, and a real app may well call
  // queryPermission() before saving or truncate() to overwrite in place. Those
  // returned `undefined` and threw — measured against a live third-party page,
  // not guessed.
  function makeHandle(name) {
    return {
      kind: 'file',
      name: name,
      isSameEntry: (other) => Promise.resolve(!!other && other.name === name),
      // Permissions are meaningless here: the user already granted access by
      // opening the document. Always-granted is the truthful answer.
      queryPermission: () => Promise.resolve('granted'),
      requestPermission: () => Promise.resolve('granted'),
      getFile: async () => {
        const text = await call('read', { name })
        return new File([text == null ? '' : text], name, { type: 'text/html' })
      },
      createWritable: async (o) => {
        // keepExistingData means "start from what is on disk", which requires
        // reading it back — the spec default is an empty file.
        let buf = (o && o.keepExistingData) ? (await call('read', { name })) || '' : ''
        let pos = buf.length
        const asText = async (d) => {
          if (d == null) return ''
          if (typeof d === 'string') return d
          if (d instanceof Blob) return await d.text()
          if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) return new TextDecoder().decode(d)
          return String(d)
        }
        const put = (text) => {
          if (pos > buf.length) buf = buf + '\0'.repeat(pos - buf.length)
          buf = buf.slice(0, pos) + text + buf.slice(pos + text.length)
          pos += text.length
        }
        return {
          async write(data) {
            // The params form is {type:'write'|'seek'|'truncate', data, position, size}.
            //
            // A BLOB IS ALSO AN OBJECT WITH A STRING `type` — its MIME type —
            // so it must be excluded explicitly and the three type values
            // matched exactly. Testing only `typeof data.type === 'string'`
            // made `new Blob([html], {type: 'text/html'})` parse as params
            // whose `.data` is undefined, so asText() returned '' and the
            // document was written EMPTY. That is precisely the blob
            // kernel/src/save.ts writes, so every real save through this
            // polyfill truncated the user's file to zero bytes.
            const params = data && typeof data === 'object' && !(data instanceof Blob) &&
              (data.type === 'write' || data.type === 'seek' || data.type === 'truncate')
            if (params) {
              if (data.type === 'seek') { pos = data.position || 0; return }
              if (data.type === 'truncate') { buf = buf.slice(0, data.size || 0); if (pos > buf.length) pos = buf.length; return }
              if (typeof data.position === 'number') pos = data.position
              put(await asText(data.data))
              return
            }
            put(await asText(data))
          },
          async seek(p) { pos = p || 0 },
          async truncate(size) { buf = buf.slice(0, size || 0); if (pos > buf.length) pos = buf.length },
          async abort() { buf = ''; pos = 0 },
          async close() { await call('write', { name, text: buf }) },
        }
      },
    }
  }
  // ------------------------------------------------- the per-document store
  //
  // kernel/src/docstore.ts keeps two things out of the page's own web storage
  // when a host offers a store: the crash-recovery copy ('recovery') and this
  // device's member key for the document ('memberkey'). It finds the store by
  // `window.__bentoHost.ops` including 'store' at boot, then speaks a
  // request/response protocol over postMessage on its own window. This relays
  // that protocol to the native host, which keeps each document's entries in
  // storage partitioned by the document's own identity — never by anything the
  // page names.
  //
  // ONLY when the native side says it implements the store. This file is
  // shared, and a host that advertised a store it could not serve would cost
  // the user their member identity on every reload: the kernel, seeing a store
  // present but refusing, keeps the key for that page only and deliberately
  // never falls back to localStorage. So each host declares its capabilities
  // ahead of this file (`window.__bentoHostCaps`), and without that nothing
  // here runs.
  //
  // Top frame only. Android injects this script into same-origin subframes as
  // well; a store reachable from a frame the document created is not one the
  // document controls.
  ;(() => {
    const caps = Array.isArray(window.__bentoHostCaps) ? window.__bentoHostCaps.slice() : []
    try { delete window.__bentoHostCaps } catch (_) {}
    if (window !== window.top) return
    // Only what this file can relay; a host naming something else adds nothing.
    const offered = ['store', 'seal'].filter((c) => caps.indexOf(c) >= 0)
    if (!offered.length) return

    const prev = window.__bentoHost && Array.isArray(window.__bentoHost.ops) ? window.__bentoHost.ops : []
    const ops = Object.freeze(Array.from(new Set(prev.concat(offered))))
    Object.defineProperty(window, '__bentoHost', {
      value: Object.freeze({ ops }), writable: false, enumerable: true, configurable: false,
    })
    const CH = '__bento_tray__'

    // 'seal': the page tells the host whether the open document is sealed
    // (password or identity), whenever that changes, so the host can keep the
    // document out of its own surfaces (the app-switcher snapshot) before the
    // sealed file is even saved. Fire-and-forget: {sealed: boolean}, nothing
    // comes back. The host may only ADD protection on this signal; it never
    // lifts protection for a file it knows is sealed because a page said so.
    if (offered.indexOf('seal') >= 0) {
      window.addEventListener('message', (ev) => {
        const d = ev.data
        if (ev.source !== window || !d || d[CH] !== true || d.dir !== 'req' || d.op !== 'seal.state') return
        const p = d.payload || {}
        if (typeof p.sealed !== 'boolean') return
        call('seal.state', { sealed: p.sealed }).catch(() => {})
      })
    }
    if (offered.indexOf('store') < 0) return

    // THE NATIVE CONTRACT, identical on every host. Requests arrive through the
    // ordinary call() channel as {id, op, name} (plus b64 for store.set). The
    // native side answers through the ordinary reply, (id, ok, value), with
    // value a string or null:
    //   store.get     ok, value = base64 of the bytes | null when absent
    //   store.set     ok, value = null
    //   store.list    ok, value = JSON array of names, e.g. '["memberkey","recovery"]'
    //   store.delete  ok, value = null      (also when it was already absent)
    //   any failure   !ok, value = 'refused' (a name other than recovery/memberkey)
    //                             | 'too-large' (over the host's cap)
    //                             | 'unavailable' (the host could not do it)
    // The partition is the document's identity as the HOST derived it; nothing
    // in a request names it. scripts/test-home-docstore.mjs holds a host to this.
    const KNOWN = { 'store.get': 1, 'store.set': 1, 'store.list': 1, 'store.delete': 1 }
    // Both transports carry strings, so bytes travel as base64 — and are turned
    // back into a Uint8Array HERE, in the page's own realm, because the kernel
    // checks `instanceof Uint8Array` and a typed array built elsewhere fails it.
    const toB64 = (u8) => {
      let s = ''
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
      return btoa(s)
    }
    const fromB64 = (b64) => {
      const bin = atob(b64)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    }

    window.addEventListener('message', (ev) => {
      const d = ev.data
      if (ev.source !== window || !d || d[CH] !== true || d.dir !== 'req' ||
          typeof d.op !== 'string' || d.op.indexOf('store.') !== 0) return
      const respond = (result) => window.postMessage({ [CH]: true, dir: 'res', id: d.id, result }, '*')
      if (!KNOWN[d.op]) { respond({ ok: false, reason: 'unknown op' }); return }
      const p = d.payload || {}
      const params = { name: p.name }
      if (d.op === 'store.set') {
        if (!(p.bytes instanceof Uint8Array)) { respond({ ok: false, reason: 'bytes must be a Uint8Array' }); return }
        params.b64 = toB64(p.bytes)
      }
      call(d.op, params).then((value) => {
        if (d.op === 'store.get') respond({ ok: true, bytes: value == null ? null : fromB64(String(value)) })
        else if (d.op === 'store.list') respond({ ok: true, names: JSON.parse(String(value || '[]')) })
        else respond({ ok: true })
      }, (e) => respond({ ok: false, reason: String((e && e.message) || e) }))
    })
  })()
})();
