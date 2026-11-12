// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/home in your browser, stage 1: open and present, nothing kept.
//
// A person picks or drops a .bento.html file. This page reads its bytes
// locally (they are never uploaded), checks the file's code against the signed
// release history (verify.ts), and runs that verified shell in a sandboxed
// frame on a separate site (frame.ts). The page itself runs no document code
// and never puts document markup in its own DOM: the file name and the
// verdict are the only things from a file it shows, as text.
//
// Nothing is kept: no storage, no file handles, no identity. The only
// network this page uses is the signed release channel: once per load, to ask
// whether this build has been withdrawn (offline.ts), and otherwise only when
// a file does not verify against the histories the build carries (or when the
// person asks to see an unverifiable file read-only). A service worker keeps
// the library's own files, never a document, so a returning visit opens
// offline (offline.ts, sw.ts).

import { startOffline } from './offline.ts'
import { Histories, judge, judgeWithRefresh, decodeExact, extractDoc, spliceDoc, newestShell, APPS, MAX_BYTES, type Jwk, type PlanStep } from './verify.ts'

declare const __FRAME_URL__: string
declare const __RELEASE_BASE__: string
declare const __SIGNED_BASE__: string
declare const __RELEASE_KEY__: Jwk
declare const __HISTORIES__: string[]

const FRAME_URL = __FRAME_URL__
const RELEASE_BASE = __RELEASE_BASE__
const KEY = __RELEASE_KEY__

const net = (url: string, init?: RequestInit) => fetch(url, init)
const histories = new Histories(KEY, RELEASE_BASE, net)
const bundled = (async () => {
  for (const raw of __HISTORIES__) {
    const why = await histories.take(raw)
    if (why) console.warn('[bento/home] a bundled history was refused:', why)
  }
})()

/** A signed URL names bento.page's release channel; fetch it from the configured one (trust is in the pins). */
const resolveSigned = (url: string): string | null =>
  url.startsWith(__SIGNED_BASE__) && !url.slice(__SIGNED_BASE__.length).includes('..') ? RELEASE_BASE + url.slice(__SIGNED_BASE__.length) : null

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const show = (id: string, on: boolean) => { $(id).hidden = !on }
const say = (id: string, text: string) => { $(id).textContent = text }

/**
 * The kill switch answers before any file opens. When this build is withdrawn
 * (or the answer cannot be trusted) the page stops, with a fixed message.
 */
const ready = startOffline({
  releaseBase: RELEASE_BASE, key: KEY,
  onStop: (why) => {
    closeDocument()
    say('withdrawn-text', why === 'withdrawn'
      ? 'This version of bento/home has been withdrawn. It has stopped, and removed itself from this browser. Reload to get the current version. Your files were not changed.'
      : 'bento/home could not confirm that this version is still safe to use, so it has stopped, and removed itself from this browser. Reload to try again. Your files were not changed.')
    document.body.classList.add('stopped')
  },
})

/** A file name as shown: no control, bidi or invisible format characters (they can reorder what the person reads). */
export const shownName = (name: string): string =>
  name.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').slice(0, 200) || 'document'

/** A download name from a file name: no path, no control or bidi characters, ends in .html. */
export function safeName(name: string): string {
  let n = shownName(name).replace(/[/\\:]/g, '').trim().slice(-120) || 'document.bento.html'
  if (!/\.html?$/i.test(n)) n += '.html'
  return n
}

interface Session { frame: HTMLIFrameElement; port: MessagePort | null; pong: number; onReady: (e: MessageEvent) => void }
/** How long a frame has to answer a ping after a load. */
const PING_MS = 5000
/** How long the frame page has to say it is ready, once it has loaded (or at all). */
const READY_AFTER_LOAD_MS = 2000
const READY_MS = 20000
let session: Session | null = null

function closeDocument() {
  if (!session) return
  removeEventListener('message', session.onReady)
  session.port?.close()
  session.frame.remove()
  session = null
  document.body.classList.remove('viewing')
  show('notice', false)
}

/**
 * Run a VERIFIED file in a new sandboxed frame. One frame per open, never
 * reused; the session is the MessagePort handed over at boot, not the frame's
 * WindowProxy. Window messages are listened to only until that handshake.
 */
function serve(html: string, plan: PlanStep[], name: string, label: string, opts: { download: boolean }) {
  closeDocument()
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-modals')
  frame.setAttribute('allow', 'fullscreen; clipboard-write')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.title = shownName(name)
  frame.className = 'doc'
  const s: Session = { frame, port: null, pong: 0, onReady: () => {} }
  s.onReady = (ev: MessageEvent) => {
    if (session !== s || ev.source !== frame.contentWindow || ev.origin !== 'null') return
    if (!ev.data || ev.data.kind !== 'bento-frame-ready') return
    removeEventListener('message', s.onReady) // one handshake per frame, ever
    const { port1, port2 } = new MessageChannel()
    s.port = port1
    port1.onmessage = (e) => fromFrame(s, e.data)
    frame.contentWindow!.postMessage({ kind: 'bento-serve', html, plan, name }, '*', [port2])
  }
  addEventListener('message', s.onReady)
  // After the handshake, every load of the frame is either the document being
  // written (the realm that holds the port answers a ping) or the frame
  // navigating somewhere else (nothing answers): then it is no longer the
  // document served, and it is closed. Load counts differ by engine; a ping
  // over the port does not.
  let ping = 0
  // Before the handshake, a frame page that never says it is ready did not
  // load (offline: the frame site is not this page's to cache) or refused.
  const notReady = () => {
    if (session !== s || s.port) return
    fail(navigator.onLine
      ? 'This document could not start: the page that runs it did not answer. Check your connection and try again.'
      : 'You are offline. Opening a document here needs a connection for now: the page that runs it could not be reached. Your file was not changed.')
  }
  setTimeout(notReady, READY_MS)
  frame.addEventListener('load', () => {
    if (session !== s) return
    if (!s.port) { setTimeout(notReady, READY_AFTER_LOAD_MS); return }
    const n = ++ping
    s.port.postMessage({ kind: 'ping', n })
    setTimeout(() => {
      // pings are numbered upward, so a later answer also answers this one
      if (session === s && s.pong < n) fail('The document tried to leave its sandbox, so it was closed.')
    }, PING_MS)
  })
  frame.src = FRAME_URL
  session = s
  say('doc-name', shownName(name))
  say('doc-label', label)
  const dl = $<HTMLButtonElement>('download')
  dl.hidden = !opts.download
  dl.onclick = opts.download ? () => download(html, name) : null
  $('stage').appendChild(frame)
  document.body.classList.add('viewing')
}

/** What the frame may say on its port. Anything else is ignored. */
function fromFrame(s: Session, d: unknown) {
  if (session !== s || !d || typeof d !== 'object') return
  const kind = (d as { kind?: unknown }).kind
  if (kind === 'pong') {
    const n = (d as { n?: unknown }).n
    if (typeof n === 'number' && n > s.pong) s.pong = n
  } else if (kind === 'save-declined') {
    say('notice', 'Saving is not available here yet: nothing you change is kept. Use Download to keep the file as you opened it.')
    show('notice', true)
  } else if (kind === 'boot-failed') {
    say('notice', 'This document could not start.')
    show('notice', true)
  }
}

/** Download the bytes that verified, exactly. Only for a file whose own code verified. */
function download(html: string, name: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = safeName(name)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function fail(text: string) {
  closeDocument()
  say('problem', text)
  show('problem-box', true)
  show('readonly', false)
}

/** A document that carries a live session is shown as it was last saved: this page joins no session (stage 1). */
function liveNotice(html: string) {
  const d = extractDoc(html)
  if (!('text' in d)) return
  let collab: unknown
  try { collab = (JSON.parse(d.text) as { collab?: unknown }).collab } catch { return }
  if (!collab || typeof collab !== 'object' || (collab as { on?: unknown }).on === false) return
  say('notice', 'This is a live document. You are seeing it as it was last saved: it is not live here.')
  show('notice', true)
}

const appName = (appId: string) => APPS.find((a) => a.appId === appId)?.name ?? appId

async function openFile(file: File) {
  closeDocument() // a new file replaces the open one, before anything else happens
  show('problem-box', false)
  if (file.size > MAX_BYTES) return fail('This file is too large to open here.')
  say('status', 'Checking…')
  if (!(await ready)) return // withdrawn: the page has stopped
  const html = decodeExact(await file.arrayBuffer())
  if (html === null) { say('status', ''); return fail('This is not a Bento document (it is not UTF-8 text).') }
  await bundled
  const v = await judgeWithRefresh(html, histories)
  say('status', '')
  if (v.verdict === 'genuine') {
    serve(html, v.plan, file.name, `${appName(v.appId)} ${v.release.version}`, { download: true })
    liveNotice(html)
    return
  }
  // Unverifiable: its code never runs. Offer the document read-only in the
  // newest signed release of its app, on request.
  fail(`This file's code is not a Bento release this page can verify, so it will not run here (${v.reason}).`)
  const doc = extractDoc(html)
  const app = 'text' in doc ? APPS.find((a) => a.format === doc.format) : undefined
  if (!app || !('text' in doc)) return
  const btn = $<HTMLButtonElement>('readonly')
  btn.textContent = `Show it read-only in the newest ${app.name}`
  show('readonly', true)
  btn.onclick = async () => {
    btn.disabled = true
    say('status', 'Fetching the newest signed release…')
    const shell = await newestShell(app.appId, histories, KEY, RELEASE_BASE, net, resolveSigned)
    btn.disabled = false
    say('status', '')
    if ('refuse' in shell) return fail(`The newest release could not be verified, so nothing was opened (${shell.refuse}).`)
    const spliced = spliceDoc(shell.html, doc.text)
    const v2 = spliced === null ? null : await judge(spliced, histories.list())
    if (!spliced || !v2 || v2.verdict !== 'genuine') return fail('The document could not be placed in the newest release.')
    show('problem-box', false)
    serve(spliced, v2.plan, file.name, `Read-only in ${app.name} ${shell.version}`, { download: false })
    liveNotice(spliced)
  }
}

function pick() {
  const input = $<HTMLInputElement>('file')
  const f = input.files?.[0]
  input.value = ''
  if (f) void openFile(f)
}

$('file').addEventListener('change', pick)
$('close').addEventListener('click', closeDocument)
$('reload').addEventListener('click', () => location.reload())
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging') })
addEventListener('dragleave', () => document.body.classList.remove('dragging'))
addEventListener('drop', (e) => {
  e.preventDefault()
  document.body.classList.remove('dragging')
  const f = e.dataTransfer?.files?.[0]
  if (f) void openFile(f)
})
