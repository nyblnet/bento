// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/home in your browser: the TRUSTED script of the frame page.
//
// The frame page is served from its own site, never the library's, with a
// header CSP whose `sandbox` directive makes it an opaque origin whoever loads
// it, `frame-ancestors` naming only the library, `worker-src 'none'`, and a
// script policy of this script's hash plus blob:. The library sends it a file
// whose code it has verified against the signed release history, with the plan
// of that file's executable elements, and ONE MessagePort. This script turns
// exactly those elements into blob: scripts and writes the document in. Any
// inline script the plan did not name stays inline and the CSP refuses it.
//
// It refuses to boot anywhere else: if this document is not opaque (the header
// was lost), if it is the top-level page, or if the message did not come from
// the library's origin through its parent.
//
// THE REALM IS SHARED with the document once it is written, so every built-in
// used after that is captured here first (the extension's sandbox.js does the
// same, for the reason its header gives). The port lives only in these closures.
//
// Stage 1 offers the document no storage, no identity and no file handle.
// ⌘S reaches showSaveFilePicker below, which tells the library and declines.
// Every other path the shell has to write a file is a download, and the frame
// has no allow-downloads: downloads go through the library only.

declare const __LIBRARY_ORIGIN__: string

(() => {
  'use strict'
  const FnCall = Function.prototype.call
  const FnBind = Function.prototype.bind
  const uncurry = <T extends (...a: any[]) => any>(f: T) => FnBind.call(FnCall, f) as (self: any, ...a: any[]) => any
  const gp = Object.getOwnPropertyDescriptor
  const defineProperty = Object.defineProperty
  const freeze = Object.freeze
  const isArray = Array.isArray
  const promiseReject = Promise.reject.bind(Promise)
  const portPost = uncurry(MessagePort.prototype.postMessage)
  const portStart = uncurry(MessagePort.prototype.start)
  const listen = uncurry(EventTarget.prototype.addEventListener)
  const unlisten = uncurry(EventTarget.prototype.removeEventListener)
  const evData = uncurry(gp(MessageEvent.prototype, 'data')!.get!)
  const evSource = uncurry(gp(MessageEvent.prototype, 'source')!.get!)
  const evOrigin = uncurry(gp(MessageEvent.prototype, 'origin')!.get!)
  const evPorts = uncurry(gp(MessageEvent.prototype, 'ports')!.get!)
  const docOpen = uncurry(Document.prototype.open)
  const docWrite = uncurry(Document.prototype.write)
  const docClose = uncurry(Document.prototype.close)
  const BlobCtor = Blob
  const createURL = URL.createObjectURL
  const strSlice = uncurry(String.prototype.slice)
  const DOMExceptionCtor = DOMException
  const win = window
  const doc = document
  const PARENT = window.parent
  const LIBRARY = __LIBRARY_ORIGIN__

  // data-bento-frame says what this script decided, for the rigs: 'refused'
  // or 'waiting' (for the library's handshake). The document replaces it.
  const mark = (state: string) => doc.documentElement.setAttribute('data-bento-frame', state)
  const refuse = (why: string) => {
    mark('refused')
    const p = doc.createElement('p')
    p.textContent = 'This page only runs inside bento/home. ' + why
    doc.body.appendChild(p)
  }
  // Opaque or nothing: a lost header must not leave document code running on
  // the frame site's real origin, which every library user shares.
  if (win.origin !== 'null') { refuse('(not sandboxed)'); return }
  if (PARENT === win) { refuse('(not framed)'); return }

  let done = false
  let port: MessagePort | null = null
  const tell = (kind: string, reason?: string) => { if (port) portPost(port, reason === undefined ? { kind } : { kind, reason: strSlice(String(reason), 0, 200) }) }

  const showSaveFilePicker = () => {
    tell('save-declined')
    return promiseReject(new DOMExceptionCtor('Saving is not available here yet', 'AbortError'))
  }

  const onHandshake = (ev: MessageEvent) => {
    if (done) return
    if (evSource(ev) !== PARENT || evOrigin(ev) !== LIBRARY) return
    const d = evData(ev)
    const ports = evPorts(ev)
    if (!d || d.kind !== 'bento-serve' || typeof d.html !== 'string' || !isArray(d.plan) || !ports || ports.length !== 1) return
    done = true
    unlisten(win, 'message', onHandshake)
    port = ports[0]
    // the library pings after every load of this frame: only this realm, which
    // holds the port, can answer, so a frame that navigated away goes silent
    listen(port, 'message', (e: MessageEvent) => {
      const m = evData(e)
      if (m && m.kind === 'ping' && typeof m.n === 'number') portPost(port!, { kind: 'pong', n: m.n })
    })
    portStart(port)

    // The splice by the plan's offsets: each planned element, and only those,
    // becomes a blob: script. The plan and the bytes must line up exactly.
    const html: string = d.html
    let out = ''
    let at = 0
    for (let i = 0; i < d.plan.length; i++) {
      const p = d.plan[i]
      const ok = p && typeof p.text === 'string' && Number.isInteger(p.tagStart) && Number.isInteger(p.start) && Number.isInteger(p.end) &&
        p.tagStart >= at && p.start > p.tagStart && p.start + p.text.length < p.end && p.end <= html.length &&
        strSlice(html, p.start, p.start + p.text.length) === p.text
      if (!ok) { tell('boot-failed', 'plan'); return }
      const url = createURL(new BlobCtor([p.text], { type: 'text/javascript' }))
      out += strSlice(html, at, p.tagStart) + '<script' + (p.module ? ' type="module"' : '') + ' src="' + url + '"></' + 'script>'
      at = p.end
    }
    out += strSlice(html, at)

    defineProperty(win, 'showSaveFilePicker', { value: showSaveFilePicker, writable: false, configurable: false, enumerable: false })
    tell('booting')
    docOpen(doc)
    docWrite(doc, out)
    docClose(doc)
  }
  listen(win, 'message', onHandshake)
  mark('waiting')
  PARENT.postMessage(freeze({ kind: 'bento-frame-ready' }), LIBRARY)
})()
