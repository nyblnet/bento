// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/home in your browser: open, present and save (stages 1 and 2).
//
// A person picks or drops a .bento.html file. This page reads its bytes
// locally (they are never uploaded), checks the file's code against the signed
// release history (verify.ts), and runs that verified shell in a sandboxed
// frame on a separate site (frame.ts). The page itself runs no document code
// and never puts document markup in its own DOM: the file name and the
// verdict are the only things from a file it shows, as text.
//
// Saving (stage 2): the document's own ⌘S reaches the frame's
// showSaveFilePicker, which posts the file on the session port. This page
// never writes that html: it puts the document's data back into the bytes it
// verified for this open and judges the result again (writeback.ts). A file
// whose own release runs, opened through this browser's file picker, is
// written in place through the handle that picker gave, held in this page's
// memory for the open only. Every other save (no handle, a copy, a file shown
// read-only in the newest release) waits for the person to save it from this
// page, and until then a chip says the changes are only in this tab.
//
// Nothing is written to this browser's storage for a document: its store (the
// recovery copy and member key, kernel/src/docstoreport.ts) lives in this
// page's memory, per tab. The recovery copy outlives the open only in memory,
// keyed by the hash of the bytes it was taken against, so reopening the SAME
// bytes offers it (never matched by docId). The one thing this page remembers
// on disk is the kill switch's: the highest status seq seen and the builds
// seen withdrawn (offline.ts). The only network this page uses is the
// signed release channel: once per load, to ask whether this build has been
// withdrawn, and otherwise only when a file does not verify against the
// histories the build carries (or when the person asks to see an unverifiable
// file read-only). A service worker keeps the library's own files, never a
// document, so a returning visit opens offline (offline.ts, sw.ts).

import { startOffline } from './offline.ts'
import { serveDocStore, entryKey, type StoreSession, type StoredRecord, type DocStoreName } from '../../../kernel/src/docstoreport.ts'
import { Histories, judge, judgeWithRefresh, decodeExact, extractDoc, spliceDoc, newestShell, APPS, MAX_BYTES, type Jwk, type PlanStep } from './verify.ts'
import { resplice, parseSave, hashOf, type Purpose } from './writeback.ts'

declare const __FRAME_URL__: string
declare const __RELEASE_BASE__: string
declare const __SIGNED_BASE__: string
/** The largest save taken, if a development build lowered it (0 = MAX_BYTES; never above it). */
declare const __SAVE_CAP__: number
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

/** A file handle, as the File System Access API gives one (Chromium). Held in memory for one open, never stored. */
interface FileHandle { kind: 'file'; getFile(): Promise<File>; createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }
/** What this tab knows about an entry across opens: memory only. */
interface Kept { entry: string; opened: string; dirty: boolean; exported: string[]; noRetain: boolean }
/** How a file was served: its release, whether a save may write the file, the handle. */
interface Serving { release: { appId: string; version: string }; writable: boolean; handle: FileHandle | null; kept: Kept }
interface Session extends Serving {
  frame: HTMLIFrameElement; port: MessagePort | null; pong: number; onReady: (e: MessageEvent) => void; entry: string; store: StoreSession | null
  served: string; name: string; lastN: number; busy: boolean; window: number; inWindow: number; drops: number
  /** The hash of what the handle's file holds as far as this open knows: the opened bytes, then each write. */
  onDisk: string
  held: { html: string; name: string; purpose: Purpose } | null
}
/** How long a frame has to answer a ping after a load. */
const PING_MS = 5000
/** How long the frame page has to say it is ready, once it has loaded (or at all). */
const READY_AFTER_LOAD_MS = 2000
const READY_MS = 20000
let session: Session | null = null

/**
 * The document's store, in this page's memory (per tab: ruling 947 gates any
 * persistent backend). Each open is an ENTRY minted here; nothing the document
 * sends names one. At close the member key goes; a recovery copy stays, for
 * this tab only, under the hash of the bytes it was taken against, so the SAME
 * bytes reopened get the same entry back (S.1a). It goes when a save writes the
 * file through its handle, when the person says they have saved it, or when
 * bytes they exported are opened again (D12). Counts are on the root element
 * for the rigs: requests served, refused and dropped.
 */
const mem = new Map<string, StoredRecord>()
const kept = new Map<string, Kept>()
const RECOVERY: DocStoreName = 'recovery'
const memory = {
  get: async (k: string) => mem.get(k),
  put: async (k: string, r: StoredRecord) => {
    mem.set(k, r)
    for (const e of kept.values()) if (k === entryKey(e.entry, RECOVERY)) { e.dirty = true; chip() }
  },
  delete: async (k: string) => { mem.delete(k) },
  dropEntry: (entry: string) => { for (const n of ['recovery', 'memberkey'] as const) mem.delete(entryKey(entry, n)); kept.delete(entry) },
}
/** How many entries a tab keeps past their open (the oldest goes first). */
const KEEP_ENTRIES = 16
/** The recovery copy is gone: the file holds the changes, or the person says so. */
const settle = (k: Kept) => { mem.delete(entryKey(k.entry, RECOVERY)); k.dirty = false; chip() }
const storeCount = { served: 0, refused: 0, dropped: 0 }
const onStoreEvent = (e: { kind: string }) => {
  if (e.kind === 'served' || e.kind === 'refused' || e.kind === 'dropped') storeCount[e.kind]++
  document.documentElement.setAttribute('data-bento-store', `${storeCount.served} ${storeCount.refused} ${storeCount.dropped}`)
}
const mintEntry = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * The docId of a file this page verified, or null. Only a body in a known
 * PLAINTEXT app format has one: an allowlist of the apps' formats, never "not
 * bento/enc", because an encrypted envelope may carry any extra field
 * (the shell's envelope parser ignores them), a docId included, and an
 * encrypted document never gets a store here.
 */
function docIdOf(html: string): string | null {
  const d = extractDoc(html)
  if (!('text' in d)) return null
  if (!APPS.some((a) => a.format === d.format)) return null
  try {
    const id = (JSON.parse(d.text) as { docId?: unknown }).docId
    return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : null
  } catch { return null }
}

/** Close the open document. With `ask`, a document with changes only in this tab asks first; false = the person kept it open. */
function closeDocument(ask = false): boolean {
  if (!session) return true
  if (ask && session.kept.dirty && !confirm('Your changes to this document are only in this tab. Close it anyway?')) return false
  removeEventListener('message', session.onReady)
  session.store?.close()
  mem.delete(entryKey(session.entry, 'memberkey'))
  // a recovery copy outlives the open, in memory, unless the document became encrypted
  if (!mem.has(entryKey(session.entry, RECOVERY)) || session.kept.noRetain) memory.dropEntry(session.entry)
  while (kept.size > KEEP_ENTRIES) memory.dropEntry(kept.keys().next().value!)
  session.port?.close()
  session.frame.remove()
  session = null
  document.body.classList.remove('viewing')
  show('notice', false)
  chip()
  return true
}

/**
 * Run a VERIFIED file in a new sandboxed frame. One frame per open, never
 * reused; the session is the MessagePort handed over at boot, not the frame's
 * WindowProxy. Window messages are listened to only until that handshake.
 */
function serve(html: string, plan: PlanStep[], name: string, label: string, opts: { download: boolean } & Serving) {
  closeDocument()
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-modals')
  frame.setAttribute('allow', 'fullscreen; clipboard-write')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.title = shownName(name)
  frame.className = 'doc'
  const { release, writable, handle, kept: k } = opts
  const s: Session = { frame, port: null, pong: 0, onReady: () => {}, entry: k.entry, store: null, release, writable, handle, kept: k,
    served: html, name, lastN: 0, busy: false, window: 0, inWindow: 0, drops: 0, held: null, onDisk: k.opened }
  document.documentElement.setAttribute('data-bento-save-drops', '0')
  s.onReady = (ev: MessageEvent) => {
    if (session !== s || ev.source !== frame.contentWindow || ev.origin !== 'null') return
    if (!ev.data || ev.data.kind !== 'bento-frame-ready') return
    removeEventListener('message', s.onReady) // one handshake per frame, ever
    const { port1, port2 } = new MessageChannel()
    s.port = port1
    port1.onmessage = (e) => fromFrame(s, e.data)
    // the store: its own channel, bound to this open's entry and the docId of the verified bytes
    const sc = new MessageChannel()
    s.store = serveDocStore(sc.port1, { entry: s.entry, docId: docIdOf(html), backend: memory, onEvent: onStoreEvent })
    frame.contentWindow!.postMessage({ kind: 'bento-serve', html, plan, name }, '*', [port2, sc.port2])
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
  chip()
}

/** What the frame may say on its port. Anything else is ignored. */
function fromFrame(s: Session, d: unknown) {
  if (session !== s || !d || typeof d !== 'object') return
  const kind = (d as { kind?: unknown }).kind
  if (kind === 'pong') {
    const n = (d as { n?: unknown }).n
    if (typeof n === 'number' && n > s.pong) s.pong = n
  } else if (kind === 'save') {
    void onSave(s, d)
  } else if (kind === 'boot-failed') {
    say('notice', 'This document could not start.')
    show('notice', true)
  }
}

/** Saves a document may send in a window, and how many refused before it is closed. */
const SAVE_WINDOW_MS = 10_000
const SAVES_PER_WINDOW = 8
const MAX_SAVE_DROPS = 16
const reply = (s: Session, n: number, why?: string) => s.port?.postMessage(why === undefined ? { kind: 'saved', n, ok: true } : { kind: 'saved', n, ok: false, why })
const tellSave = (text: string) => { say('notice', text); show('notice', true) }

/**
 * A save from the document. Only on this open's session port (fromFrame), one
 * at a time, within a rate. The file written is never the posted html: it is
 * the served bytes with the posted data put back, judged again (writeback.ts).
 * In place only through this open's handle, and only for a file whose own
 * release runs; anything else is held for the person to save from this page.
 */
async function onSave(s: Session, d: unknown) {
  const now = Date.now()
  if (now - s.window >= SAVE_WINDOW_MS) { s.window = now; s.inWindow = 0 }
  const m = parseSave(d, s.lastN, __SAVE_CAP__ > 0 ? Math.min(__SAVE_CAP__, MAX_BYTES) : MAX_BYTES)
  const drop = () => {
    // for the rigs: how many saves this open refused unanswered (a count, never content)
    document.documentElement.setAttribute('data-bento-save-drops', String(s.drops + 1))
    if (++s.drops >= MAX_SAVE_DROPS) fail('The document sent saves this page does not accept, so it was closed.')
  }
  // not the frame's shape, or a second save while one is in flight (the frame never sends one): no answer
  if (!m || s.busy) return drop()
  s.lastN = m.n
  if (++s.inWindow > SAVES_PER_WINDOW) {
    reply(s, m.n, 'too many saves')
    tellSave('Saves are arriving faster than this page writes them. Wait a moment, then save again.')
    return drop()
  }
  s.busy = true
  try {
    const r = await resplice(s.served, m.html, histories.list(), s.release)
    if (session !== s) return
    if ('refuse' in r) {
      reply(s, m.n, 'not saved')
      return tellSave(`This save was not written: it could not be checked (${r.refuse}). Your file is unchanged.`)
    }
    // the document became encrypted: no plaintext copy of it stays in this tab (ruling 947, condition 4)
    if (r.encrypted) { s.kept.noRetain = true; settle(s.kept) }
    if (m.purpose === 'bento-doc' && s.writable && s.handle) {
      // never over a file something else changed since this open read or wrote it
      const now = await s.handle.getFile().then((f) => f.arrayBuffer()).then(hashOf, () => null)
      if (session !== s) return
      if (now !== s.onDisk) {
        s.held = { html: r.html, name: m.name || s.name, purpose: m.purpose }
        s.kept.dirty = true
        reply(s, m.n)
        chip()
        return tellSave('Your file changed on disk since it was opened here, so it was not written over. Use Save a copy to keep your changes.')
      }
      try {
        const w = await s.handle.createWritable()
        await w.write(new Blob([r.html], { type: 'text/html' }))
        await w.close()
      } catch (e) {
        s.held = { html: r.html, name: m.name || s.name, purpose: m.purpose }
        s.kept.dirty = true
        reply(s, m.n)
        chip()
        return tellSave(`Your file could not be written (${String((e as Error)?.name ?? e)}). Use Save a copy to keep your changes.`)
      }
      s.held = null
      s.onDisk = await hashOf(r.html)
      settle(s.kept)
      return reply(s, m.n)
    }
    s.held = { html: r.html, name: m.name || s.name, purpose: m.purpose }
    if (m.purpose === 'bento-doc') s.kept.dirty = true
    if (!s.writable) tellSave('This file opened read-only in a newer release, so it is never changed. Your changes can be kept only as a new file.')
    chip()
    reply(s, m.n)
  } finally { s.busy = false }
}

/** The save chip and the buttons beside it, from the open's state and the entries kept in this tab. */
function chip() {
  const s = session
  // for the rigs: how many recovery copies this tab holds (a count, never content)
  document.documentElement.setAttribute('data-bento-recovery', String([...kept.values()].filter((k) => mem.has(entryKey(k.entry, RECOVERY))).length))
  show('unsaved', !!s && s.kept.dirty)
  show('saved-it', !!s && s.kept.dirty)
  const b = $<HTMLButtonElement>('save-copy')
  b.hidden = !s?.held
  b.textContent = !s?.writable ? 'Save as a new file' : s.held?.purpose === 'bento-doc' ? 'Save a copy' : 'Save the copy'
  const away = [...kept.values()].filter((k) => k.dirty && k !== s?.kept).length
  say('away', away ? `${away === 1 ? 'A document' : `${away} documents`} you opened here ${away === 1 ? 'has' : 'have'} changes only in this tab. Open the same file again to get them back.` : '')
  show('away', away > 0)
}

/** Save what the document last sent, as a file the person chooses. The chip stays until the file is opened again or they say so. */
async function saveHeld() {
  const s = session
  if (!s?.held) return
  const { html, name } = s.held
  download(html, name)
  s.kept.exported.push(await hashOf(html))
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

/**
 * The entry for bytes being opened. Bytes someone exported from this tab and
 * now opened again settle that entry (D12); the SAME bytes as an entry's open
 * that still holds a recovery copy get that entry back (S.1a). Never by docId.
 */
async function entryFor(bytes: ArrayBuffer): Promise<Kept> {
  const opened = await hashOf(bytes)
  for (const k of [...kept.values()]) {
    if (!k.exported.includes(opened)) continue
    settle(k)
    memory.dropEntry(k.entry)
  }
  const again = [...kept.values()].find((k) => k.opened === opened && mem.has(entryKey(k.entry, RECOVERY)))
  if (again) return again
  const k: Kept = { entry: mintEntry(), opened, dirty: false, exported: [], noRetain: false }
  kept.set(k.entry, k)
  return k
}

async function openFile(file: File, handle: FileHandle | null = null) {
  if (!closeDocument(true)) return // a new file replaces the open one, before anything else happens
  show('problem-box', false)
  if (file.size > MAX_BYTES) return fail('This file is too large to open here.')
  say('status', 'Checking…')
  if (!(await ready)) return // withdrawn: the page has stopped
  const bytes = await file.arrayBuffer()
  const html = decodeExact(bytes)
  if (html === null) { say('status', ''); return fail('This is not a Bento document (it is not UTF-8 text).') }
  await bundled
  const v = await judgeWithRefresh(html, histories)
  say('status', '')
  if (v.verdict === 'genuine') {
    const k = await entryFor(bytes)
    serve(html, v.plan, file.name, `${appName(v.appId)} ${v.release.version}${handle ? ' · saves to this file' : ''}`,
      { download: true, release: { appId: v.appId, version: v.release.version }, writable: true, handle, kept: k })
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
    // read-only: no handle, ever; a save is kept only as a new file, in that newest release
    serve(spliced, v2.plan, file.name, `Read-only in ${app.name} ${shell.version}`,
      { download: false, release: { appId: v2.appId, version: v2.release.version }, writable: false, handle: null, kept: await entryFor(bytes) })
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
// Where this browser has a file picker that gives a handle (Chromium), opening
// through it is what lets ⌘S write the file in place. The handle stays in this
// page's memory for that open only.
$('file').addEventListener('click', (e) => {
  const picker = (window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileHandle[]> }).showOpenFilePicker
  if (typeof picker !== 'function') return
  e.preventDefault()
  picker({ id: 'bento-home-open', types: [{ description: 'Bento document', accept: { 'text/html': ['.html', '.htm'] } }] })
    .then(async ([h]) => openFile(await h.getFile(), h), () => { /* cancelled */ })
})
$('close').addEventListener('click', () => closeDocument(true))
$('save-copy').addEventListener('click', () => void saveHeld())
$('saved-it').addEventListener('click', () => { if (session) settle(session.kept) })
addEventListener('beforeunload', (e) => { if ([...kept.values()].some((k) => k.dirty)) e.preventDefault() })
$('reload').addEventListener('click', () => location.reload())
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging') })
addEventListener('dragleave', () => document.body.classList.remove('dragging'))
addEventListener('drop', (e) => {
  e.preventDefault()
  document.body.classList.remove('dragging')
  const f = e.dataTransfer?.files?.[0]
  if (f) void openFile(f)
})
