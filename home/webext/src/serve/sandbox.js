// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect W2 — the TRUSTED script of the extension's sandbox page.
//
// The host page (serve.js) has read a file, verified it (gate 1), and sends it
// here with the plan of its executable elements and ONE MessagePort. This
// script turns exactly those elements into blob: scripts, defines the identity
// agent and the save bridge, and writes the document in. The sandbox's fixed
// CSP (script-src 'self' blob:, no inline) refuses everything else.
//
// THE REALM IS SHARED. Document script runs in this same JavaScript realm, so
// it can patch any prototype — MessagePort.prototype.postMessage,
// EventTarget.prototype.addEventListener, the MessageEvent data getter,
// Function.prototype.call/bind, Object.defineProperty… If this script called
// any of those AFTER the document loaded, a patched one would receive the
// port (as `this`, or through the event) and could send anything on it or
// transfer it into a child frame (security, 2026-10-24: CRITICAL). So every
// built-in used after the document starts is CAPTURED HERE, before any
// document byte runs, and only ever called through the captured copies. The
// port lives only inside these closures; no agent method returns it, an event,
// or any host object — plain data only.
//
// The handshake is ONE-SHOT: the first message from `parent` carrying a port
// is accepted, before the document is written; any later one is ignored.

(() => {
  'use strict'
  // --- captured before any document byte exists -------------------------------
  const FnCall = Function.prototype.call
  const FnBind = Function.prototype.bind
  const uncurry = (f) => FnBind.call(FnCall, f)
  const gp = Object.getOwnPropertyDescriptor
  const defineProperty = Object.defineProperty
  const freeze = Object.freeze
  const isArray = Array.isArray
  const PromiseCtor = Promise
  const then = uncurry(Promise.prototype.then)
  const promiseResolve = Promise.resolve.bind(Promise)
  const promiseReject = Promise.reject.bind(Promise)
  const blobText = uncurry(Blob.prototype.text)
  const MapCtor = Map
  const mapSet = uncurry(Map.prototype.set)
  const mapGet = uncurry(Map.prototype.get)
  const mapDelete = uncurry(Map.prototype.delete)
  const portPost = uncurry(MessagePort.prototype.postMessage)
  const portStart = uncurry(MessagePort.prototype.start)
  const listen = uncurry(EventTarget.prototype.addEventListener)
  const unlisten = uncurry(EventTarget.prototype.removeEventListener)
  const evData = uncurry(gp(MessageEvent.prototype, 'data').get)
  const evSource = uncurry(gp(MessageEvent.prototype, 'source').get)
  const evPorts = uncurry(gp(MessageEvent.prototype, 'ports').get)
  const docOpen = uncurry(Document.prototype.open)
  const docWrite = uncurry(Document.prototype.write)
  const docClose = uncurry(Document.prototype.close)
  const BlobCtor = Blob
  const createURL = URL.createObjectURL
  const strSlice = uncurry(String.prototype.slice)
  const strIncludes = uncurry(String.prototype.includes)
  const DOMExceptionCtor = DOMException
  const win = window
  const doc = document
  const PARENT = window.parent

  let handshakeDone = false
  let port = null
  let seq = 0
  const pending = new MapCtor()

  // one request on the port; the reply is plain data, matched by id
  const ask = (op, args) => new PromiseCtor((resolve) => {
    const id = 's' + (++seq)
    mapSet(pending, id, resolve)
    portPost(port, { id, op, args })
  })
  const onReply = (ev) => {
    const d = evData(ev)
    if (!d || typeof d !== 'object' || typeof d.id !== 'string') return
    const resolve = mapGet(pending, d.id)
    if (!resolve) return
    mapDelete(pending, d.id)
    resolve(d.result)
  }
  // copy a reply into fresh plain data: nothing host-side ever reaches the document
  const JSONparse = JSON.parse
  const JSONstringify = JSON.stringify
  const clone = (v) => (v === undefined || v === null ? null : JSONparse(JSONstringify(v)))

  // --- the identity agent (kernel/src/identity.ts contract 1) -------------------
  const agent = freeze({
    contract: 1,
    whoami: () => then(ask('identity.whoami', null), clone),
    sign: (purpose, payload) => then(ask('identity.sign', { purpose: String(purpose), payload: String(payload) }), clone),
    resolve: (query) => then(ask('identity.resolve', { pub: query && typeof query.pub === 'string' ? query.pub : null, email: query && typeof query.email === 'string' ? query.email : null }), clone),
  })

  // --- the save bridge: ⌘S writes the file the host opened ----------------------
  const handle = (name) => freeze({
    name, kind: 'file',
    createWritable: () => {
      const parts = []
      return promiseResolve(freeze({
        write: (data) => { parts[parts.length] = data; return promiseResolve() },
        close: () => then(then(blobText(new BlobCtor(parts)), (text) => ask('save.write', { text })), (r) => {
          if (!r || r.ok !== true) throw new DOMExceptionCtor((r && r.reason) || 'write failed', 'NotAllowedError')
        }),
      }))
    },
    queryPermission: () => promiseResolve('granted'),
    requestPermission: () => promiseResolve('granted'),
    isSameEntry: () => promiseResolve(false),
  })
  let docName = 'document.bento.html'
  const showSaveFilePicker = (opts) => {
    const id = opts && typeof opts.id === 'string' ? opts.id : ''
    // ⌘S of the open document only, for now; copies and exports in a later slice
    if (id === 'bento-doc') return promiseResolve(handle(docName))
    return promiseReject(new DOMExceptionCtor('Save a copy and exports are not available here yet', 'AbortError'))
  }

  const define = (name, value) => defineProperty(win, name, { value, writable: false, configurable: false, enumerable: false })

  const onHandshake = (ev) => {
    if (handshakeDone) return
    if (evSource(ev) !== PARENT) return
    const d = evData(ev)
    const ports = evPorts(ev)
    if (!d || d.kind !== 'bento-serve' || typeof d.html !== 'string' || !isArray(d.plan) || !ports || ports.length !== 1) return
    handshakeDone = true
    unlisten(win, 'message', onHandshake)
    port = ports[0]
    listen(port, 'message', onReply)
    portStart(port)
    if (typeof d.name === 'string') docName = d.name

    // the splice, by the plan's offsets (serve/prepare.js splice, inlined so
    // this file loads no module the document could reach)
    const html = d.html
    let out = ''
    let at = 0
    for (let i = 0; i < d.plan.length; i++) {
      const p = d.plan[i]
      if (!(p && p.tagStart >= at && p.end > p.tagStart && p.end <= html.length && strIncludes(strSlice(html, p.tagStart, p.end), p.text))) {
        portPost(port, { id: 'boot', op: 'serve.failed', args: { reason: 'plan' } })
        return
      }
      const url = createURL(new BlobCtor([p.text], { type: 'text/javascript' }))
      out += strSlice(html, at, p.tagStart) + '<script' + (p.module ? ' type="module"' : '') + ' src="' + url + '"></' + 'script>'
      at = p.end
    }
    out += strSlice(html, at)

    // the agent and the bridge exist before ANY document byte does
    define('__bentoIdentity', agent)
    define('showSaveFilePicker', showSaveFilePicker)
    define('__bentoHost', freeze({ name: 'home/webext (served)', ops: freeze(['claim', 'write']) }))
    docOpen(doc)
    docWrite(doc, out)
    docClose(doc)
  }
  listen(win, 'message', onHandshake)
  // tell the host this frame is ready for the handshake
  PARENT.postMessage({ kind: 'bento-serve-ready' }, '*')
})()
