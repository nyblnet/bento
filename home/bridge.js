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
    const name = await call('begin', { suggestedName: want })
    return makeHandle(name)
  }

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
})();
