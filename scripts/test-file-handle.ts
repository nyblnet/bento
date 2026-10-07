#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Remember-the-file-handle rig (kernel/src/save.ts reconnectHandle).
//
//   node scripts/test-file-handle.ts
//
// WHAT THIS PROVES. Chrome's File System Access blocklist refuses ~/Documents
// and ~/Downloads as directory grants, so a deck there re-ran the full save
// picker on every reopen. We now remember the FILE handle (IndexedDB, by docId)
// and re-request permission inside the save gesture. The behaviour that matters
// is all in reconnectHandle — serializeAuto/writeHandle need a real DOM and a
// picker, so saveFile itself is asserted at source (that it reconnects BEFORE
// serialize, to keep the user activation fresh). The reconnect paths are driven
// here against a fake IndexedDB and a fake FileSystemFileHandle.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0, checks = 0
function ok(cond: boolean, msg: string) { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

// --- the world save.ts's handle code expects --------------------------------
// A minimal IndexedDB backed by one Map (the 'handles' store), so the rig can
// seed a stored handle and inspect what reconnect left behind.
const store = new Map<string, unknown>()
;(globalThis as Record<string, unknown>).indexedDB = {
  open() {
    const req: Record<string, unknown> = {}
    Promise.resolve().then(() => {
      const request = (fn: () => unknown) => {
        const r: Record<string, unknown> = {}
        Promise.resolve().then(() => { try { r.result = fn(); (r.onsuccess as (() => void))?.() } catch (e) { r.error = e; (r.onerror as (() => void))?.() } })
        return r
      }
      req.result = {
        createObjectStore() {},
        transaction() {
          return { objectStore() {
            return {
              get: (k: string) => request(() => store.get(k)),
              put: (v: unknown, k: string) => request(() => { store.set(k, v); return undefined }),
              delete: (k: string) => request(() => { store.delete(k); return undefined }),
            }
          } }
        },
        close() {},
      }
      ;(req.onupgradeneeded as (() => void))?.()
      ;(req.onsuccess as (() => void))?.()
    })
    return req
  },
}

// A fake FileSystemFileHandle: instanceof is the real guard, so this IS the
// global. Options steer the permission answers and a thrown error.
class FakeFSHandle {
  name: string
  queryCalls = 0
  requestCalls = 0
  private q: string
  private r: string
  private throwName?: string
  constructor(name: string, opts: { q?: string; r?: string; throwName?: string } = {}) {
    this.name = name; this.q = opts.q ?? 'granted'; this.r = opts.r ?? 'granted'; this.throwName = opts.throwName
  }
  async queryPermission() { this.queryCalls++; if (this.throwName) { const e = new Error('x') as Error & { name: string }; e.name = this.throwName; throw e } return this.q }
  async requestPermission() { this.requestCalls++; return this.r }
}
;(globalThis as Record<string, unknown>).FileSystemFileHandle = FakeFSHandle
// A real, isolated web origin — persistence and reconnect are ON here. (The
// file:// shared-origin gate is exercised in its own block near the end.)
;(globalThis as Record<string, unknown>).location = { href: 'https://bento.page/Q3-board.bento.html', protocol: 'https:', origin: 'https://bento.page' }
;(globalThis as Record<string, unknown>).self = { origin: 'https://bento.page' }
const ON_SCREEN = 'Q3-board.bento.html'

const { reconnectHandle, consumeLaunchQueue, hasFileHandle, currentFileName, writeUpdatedFile, encodeDocBody, setEncryptionPassword, parseEnvelope, decryptEnvelope } = await import('../kernel/src/save.ts')
const DOC = { docId: 'd1', title: 'Q3' }
const reset = () => store.clear()
const has = () => store.has('d1')
// the drop on denied/NotFound is fire-and-forget (void) so the save is not held
// on it — in production the picker interaction gives it ample time; here, let the
// microtasks flush before asserting the entry is gone.
const settle = () => new Promise((r) => setTimeout(r, 10))

// 1. remembered + already granted → reconnect, no prompt, entry kept
{
  reset(); const h = new FakeFSHandle(ON_SCREEN, { q: 'granted' }); store.set('d1', h)
  const got = await reconnectHandle(DOC as never)
  ok(got === (h as never), 'a granted handle reconnects (no picker)')
  ok(h.requestCalls === 0, 'and does not prompt when permission is already granted')
  ok(has(), 'the entry is kept')
}
// 2. remembered, permission prompt → granted → reconnect (the "one prompt then silent" case)
{
  reset(); const h = new FakeFSHandle(ON_SCREEN, { q: 'prompt', r: 'granted' }); store.set('d1', h)
  const got = await reconnectHandle(DOC as never)
  ok(got === (h as never) && h.requestCalls === 1, 'a prompt that the user grants reconnects the handle')
  ok(has(), 'the entry is kept after a granted prompt')
}
// 3. denied → null (picker) AND the entry is dropped
{
  reset(); const h = new FakeFSHandle(ON_SCREEN, { q: 'prompt', r: 'denied' }); store.set('d1', h)
  const got = await reconnectHandle(DOC as never)
  ok(got === null, 'a denied prompt falls back to the picker')
  await settle()
  ok(!has(), 'and the stored entry is dropped')
}
// 4. NotFoundError (file moved/deleted) → null (picker) AND the entry is dropped
{
  reset(); const h = new FakeFSHandle(ON_SCREEN, { throwName: 'NotFoundError' }); store.set('d1', h)
  const got = await reconnectHandle(DOC as never)
  ok(got === null, 'a moved/deleted file (NotFoundError) falls back to the picker')
  await settle()
  ok(!has(), 'and the stored entry is dropped')
}
// 5. name mismatch → null (picker), no prompt, entry KEPT (it is not proven stale)
{
  reset(); const h = new FakeFSHandle('Other.bento.html', { q: 'granted' }); store.set('d1', h)
  const got = await reconnectHandle(DOC as never)
  ok(got === null, 'a handle whose name is not the file on screen is not used')
  ok(h.queryCalls === 0 && h.requestCalls === 0, 'and it is rejected before touching permissions')
  ok(has(), 'the entry is kept on a mere name mismatch')
}
// 6. a host polyfill handle (not a FileSystemFileHandle) → skipped, entry kept
{
  reset(); const poly = { name: ON_SCREEN, async queryPermission() { return 'granted' }, async requestPermission() { return 'granted' } }
  store.set('d1', poly)
  const got = await reconnectHandle(DOC as never)
  ok(got === null, 'a host polyfill handle is never reconnected (the bridge path owns it)')
  ok(has(), 'and it is left in place, harmless')
}
// 7. nothing remembered → null
{
  reset()
  ok((await reconnectHandle(DOC as never)) === null, 'no stored handle → null (first-ever save picks)')
}

// 8. SHARED file:// ORIGIN: persistence off, and a planted entry is never used.
// Chrome gives every file:// deck one IndexedDB, so a malicious local file can
// plant a handle keyed to this docId and NAMED to match the file on screen —
// the name check alone would pass. The shared-origin gate must refuse to read
// it at all, so the victim's handle is never re-permissioned on the user's ⌘S.
{
  ;(globalThis as Record<string, unknown>).location = { href: 'file:///Users/x/Downloads/Q3-board.bento.html', protocol: 'file:', origin: 'null' }
  ;(globalThis as Record<string, unknown>).self = { origin: 'null' }
  reset()
  const planted = new FakeFSHandle(ON_SCREEN, { q: 'granted' }) // forged: matches the file on screen
  store.set('d1', planted)
  const got = await reconnectHandle(DOC as never)
  ok(got === null, 'on a shared file:// origin a planted, name-matching entry is NEVER reconnected')
  ok(planted.queryCalls === 0 && planted.requestCalls === 0, 'and permission is never requested on it (the forgery is blocked before any prompt)')
  ok(store.has('d1'), 'the shared store is not touched — we neither read into nor delete from it')
  // restore a real origin for the source block below (origin-independent, but tidy)
  ;(globalThis as Record<string, unknown>).location = { href: 'https://bento.page/Q3-board.bento.html', protocol: 'https:', origin: 'https://bento.page' }
  ;(globalThis as Record<string, unknown>).self = { origin: 'https://bento.page' }
}

// --- the shared-origin gate is on both the read and the write path ----------
{
  const src = readFileSync(join(root, 'kernel/src/save.ts'), 'utf8')
  const persist = src.slice(src.indexOf('async function persistHandle'), src.indexOf('async function persistHandle') + 400)
  const reconnect = src.slice(src.indexOf('export async function reconnectHandle'), src.indexOf('export async function reconnectHandle') + 700)
  ok(/sharedStorageOrigin\(\)/.test(persist), 'persistHandle does not store on a shared-storage origin')
  ok(/if \(sharedStorageOrigin\(\)\) return null/.test(reconnect), 'reconnectHandle refuses to read on a shared-storage origin')
}

// --- saveFile must reconnect BEFORE it serializes ---------------------------
// requestPermission() has to fire inside the fresh save gesture; serializeAuto
// can take ~a second and would age out the transient activation. Asserted at
// source because the write path needs a DOM.
{
  const src = readFileSync(join(root, 'kernel/src/save.ts'), 'utf8')
  const body = src.slice(src.indexOf('export async function saveFile'))
  const reAt = body.indexOf('reconnectHandle(doc)')
  const serAt = body.indexOf('serializeAuto(doc)')
  ok(reAt > 0 && serAt > 0 && reAt < serAt, 'saveFile calls reconnectHandle BEFORE serializeAuto (activation stays fresh)')
  ok(/void persistHandle\(doc, handle\)/.test(body) && /void persistHandle\(doc, fileHandle\)/.test(body),
    'saveFile persists the handle on both the picked and the reconnected/adopted save')
  ok(/instanceof FileSystemFileHandle/.test(src), 'only a real FileSystemFileHandle is stored (host polyfill skipped)')
}

// --- launchQueue: a launched document holds a writable handle at boot ---------
// A page opened in a native host or an installed PWA held NO handle until its
// first Cmd-S, so autosave only snapshotted to IndexedDB and the file on disk
// never changed. consumeLaunchQueue() adopts the handle the File Handling API
// delivers, so autosave's `if (hasFileHandle())` path (editor.ts) writes the FILE
// from the first edit. These drive the consumer against a fake launchQueue; the
// module import itself is a no-op here (node has no window).
console.log('\nlaunchQueue: a launched document is writable from the first edit')
{
  // a writable handle like the one home/bridge.js vends (makeHandle): name, kind,
  // createWritable — records whether bytes reached it.
  const written: string[] = []
  const launched = {
    kind: 'file', name: ON_SCREEN,
    async createWritable() { return { async write(s: string) { written.push(s) }, async close() {} } },
  }
  // a queue the rig controls: setConsumer hands the consumer one params object
  const setQueue = (params: { files?: unknown[] } | null) => {
    ;(globalThis as Record<string, unknown>).launchQueue = params === null ? undefined
      : { setConsumer(fn: (p: unknown) => void) { fn(params) } }
  }

  ok(!hasFileHandle(), 'no handle before a launch (so autosave would only snapshot — the bug)')

  setQueue(null)
  consumeLaunchQueue()
  ok(!hasFileHandle(), 'no launchQueue (plain tab / node) → nothing adopted, no throw')

  setQueue({ files: [] }) // a host that refused the launch (e.g. a read-only doc) vends nothing
  consumeLaunchQueue()
  ok(!hasFileHandle(), 'a refused launch (empty files) adopts nothing')

  // (c) with no vended handle, the write path writes NOTHING — it throws rather
  // than touch a file it was never given. (fileHandle is still null here.)
  let threw = false
  try { await writeUpdatedFile('<html>x') } catch { threw = true }
  ok(threw && !hasFileHandle(), 'with no handle, writeUpdatedFile writes nothing (throws, no file touched)')

  setQueue({ files: [launched] }) // the host handed over the open document
  consumeLaunchQueue()
  ok(hasFileHandle(), 'the launched file handle is adopted — hasFileHandle() is now true, so autosave writes the FILE')
  ok(currentFileName() === ON_SCREEN, `and it is the open document (${currentFileName()})`)

  // a second consume (the module init already ran one in a browser) must not throw
  setQueue({ files: [launched] })
  consumeLaunchQueue()
  ok(hasFileHandle(), 'a second consume is harmless (setConsumer re-registration is caught)')

}

// The whole B6 claim, proven by RUNNING the REAL write path: boot with a vended
// handle, then writeUpdatedFile → the handle's createWritable().write (what the
// editor autosave invokes under hasFileHandle()) must put the real document bytes
// on THAT handle. We drive it with encodeDocBody — the exact bytes a save puts in
// #bento-doc; the HTML shell around them is DOM-only furniture (serializeBody),
// proven by the splice/preview rigs, and carries the body verbatim.
console.log('\nthe first write after a launch carries the real document')
{
  const DOC = { docId: 'launch-doc', title: 'Secret Q3 numbers', format: 'bento/slides', slides: [] }
  const MARKER = 'Secret Q3 numbers' // document content that must never appear in an encrypted file
  const capture = () => {
    let got: Blob | null = null
    return { kind: 'file', name: ON_SCREEN, text: async () => (got ? await got.text() : ''),
      async createWritable() { return { async write(b: Blob) { got = b }, async close() {} } } }
  }
  const vend = (h: unknown) => { (globalThis as Record<string, unknown>).launchQueue = { setConsumer(fn: (p: unknown) => void) { fn({ files: [h] }) } }; consumeLaunchQueue() }

  // (a) plaintext: the bytes written parse back to the edited document
  setEncryptionPassword(null)
  const plain = capture(); vend(plain)
  await writeUpdatedFile(await encodeDocBody(DOC))
  const back = JSON.parse(await plain.text())
  ok(back.docId === DOC.docId && back.title === DOC.title, 'the written bytes parse back to the edited document')

  // (b) with a password active: a bento/enc envelope, no plaintext, decrypts back
  setEncryptionPassword('hunter2')
  const sealed = capture(); vend(sealed)
  await writeUpdatedFile(await encodeDocBody(DOC))
  const bytes = await sealed.text()
  const env = parseEnvelope(bytes)
  ok(!!env, 'with a password active the written bytes are a bento/enc envelope')
  ok(!bytes.includes(MARKER), 'and carry NO plaintext — the document title appears nowhere in the file')
  const dec = env ? await decryptEnvelope(env, 'hunter2') : null
  ok(!!dec && JSON.parse(dec).docId === DOC.docId, 'and decrypt back to the edited document with the password')
  setEncryptionPassword(null) // reset module state for anything after
}

// Source pin for the trigger the behavioural row stands in for: the editor
// autosave calls writeUpdatedFile only under hasFileHandle() — which the adopted
// launch handle satisfies, so the first autosave takes the file path, not the
// IndexedDB snapshot.
{
  const ed = readFileSync(join(root, 'slides/src/editor/editor.ts'), 'utf8')
  ok(/if \(hasFileHandle\(\)\) \{[\s\S]{0,200}?writeUpdatedFile\(/.test(ed),
    'editor autosave calls writeUpdatedFile under hasFileHandle() — the trigger for the write above')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
