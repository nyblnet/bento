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

const { reconnectHandle, persistHandle, consumeLaunchQueue, hasFileHandle, currentFileName, writeUpdatedFile, encodeDocBody, setEncryptionPassword, parseEnvelope, decryptEnvelope, adoptFileHandle, embeddedDocBlock } = await import('../kernel/src/save.ts')
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

// 7b. #556 — "Save a copy…" must not evict the original's remembered handle.
// A copy shares the original's docId, so a docId-only key let the copy's save
// overwrite the original's entry; reopening the original then fell to the picker.
// Drive the REAL persist→reconnect cycle (per-file keying), both reopen orders.
// At an original web origin, each file lives at its own URL, so openedFileName()
// (location basename here) is how "which file is on screen" is set.
{
  const atFile = (name: string) => {
    ;(globalThis as Record<string, unknown>).location = { href: `https://bento.page/${name}`, protocol: 'https:', origin: 'https://bento.page' }
  }
  reset()
  const original = new FakeFSHandle('Q3-board.bento.html', { q: 'granted' })
  const copy = new FakeFSHandle('Q3-copy.bento.html', { q: 'granted' })
  // save the original, then Save a copy… (same docId d1, different file)
  atFile('Q3-board.bento.html'); await persistHandle(DOC as never, original as never)
  atFile('Q3-copy.bento.html'); await persistHandle(DOC as never, copy as never)
  ok(store.size === 2, 'the copy gets its OWN entry — it does not evict the original (two files, two handles)')
  // reopen the ORIGINAL
  atFile('Q3-board.bento.html')
  ok((await reconnectHandle(DOC as never)) === (original as never),
    'reopening the original reconnects the original\'s handle (no picker) — the #556 fix')
  // reopen the COPY
  atFile('Q3-copy.bento.html')
  ok((await reconnectHandle(DOC as never)) === (copy as never),
    'reopening the copy reconnects the copy\'s handle')
  ;(globalThis as Record<string, unknown>).location = { href: 'https://bento.page/Q3-board.bento.html', protocol: 'https:', origin: 'https://bento.page' }
}
// 7c. a legacy docId-only entry (written before #556) still reconnects, via the
// fallback, and is still name-checked.
{
  reset()
  const legacy = new FakeFSHandle(ON_SCREEN, { q: 'granted' })
  store.set('d1', legacy) // the pre-#556 key: docId alone
  ok((await reconnectHandle(DOC as never)) === (legacy as never),
    'a legacy docId-only entry reconnects through the fallback')
  reset()
  const legacyWrong = new FakeFSHandle('Other.bento.html', { q: 'granted' })
  store.set('d1', legacyWrong)
  ok((await reconnectHandle(DOC as never)) === null,
    'and a legacy entry whose name is not the file on screen is still rejected (name guard holds on the fallback)')
}

// 7d. #556 edge (security): with NO file name on screen (the hosted app, nothing
// open — openedFileName() is null), a docId-only entry must NOT reconnect: there
// is no name to verify it against, and a real reopen always has one.
{
  reset()
  ;(globalThis as Record<string, unknown>).location = { href: 'https://bento.page/', protocol: 'https:', origin: 'https://bento.page' } // no .bento.html basename → openedFileName() === null
  const h = new FakeFSHandle('anything.bento.html', { q: 'granted' })
  store.set('d1', h) // a legacy docId-only entry
  ok((await reconnectHandle(DOC as never)) === null, 'with no file name on screen, a docId-only entry is not reconnected (no name to check → picker)')
  ok(h.queryCalls === 0 && h.requestCalls === 0, 'and its permission is never touched')
  ok(store.has('d1'), 'the entry is kept (not proven stale)')
  ;(globalThis as Record<string, unknown>).location = { href: 'https://bento.page/Q3-board.bento.html', protocol: 'https:', origin: 'https://bento.page' }
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
  // "Save a copy…" keeps the open deck on the ORIGINAL (maintainer ruling
  // 2026-10-15): the copy path writes the file but must NOT retarget fileHandle
  // or persist the copy as the doc's handle — only a first in-place save does.
  // Asserted at source like the ordering above (the write path needs a DOM).
  {
    const copyRet = body.indexOf("if (isCopy) return 'copied'")
    // holdHandle is the one retarget (it also resets the outside-edit stamp)
    const setHandle = body.indexOf('holdHandle(handle)')
    const persistPicked = body.indexOf('void persistHandle(doc, handle)')
    ok(copyRet > 0, 'the copy path returns early with \'copied\'')
    ok(setHandle > copyRet && persistPicked > copyRet,
      'holdHandle(handle) and persistHandle(doc, handle) run ONLY after the isCopy early-return — never for a copy')
  }
}

// --- embeddedDocBlock: the string-level #bento-doc extractor ------------------
// It reads the block from file BYTES (so the launch check runs with no parser),
// anchored by indexOf on the exact ` id="bento-doc"` attribute.
console.log('\nembeddedDocBlock reads the #bento-doc body from file bytes')
{
  // the block body is opaque to the extractor (it is whatever bytes sit there), so
  // an interior newline is possible; the boot DOM holds it as LF (HTML parsing
  // normalises), a file on disk may hold it as CRLF. A multi-line body proves the
  // normalise does real work — with single-line JSON, trim alone would hide it.
  const body = '{"docId":"x",\n"title":"T"}'
  const close = '</scr' + 'ipt>'
  const file = (b: string) => `<!doctype html><head><script type="application/json" id="bento-doc">\n${b}\n${close}</head>`
  ok(embeddedDocBlock(file(body)) === body, 'extracts the #bento-doc body')
  ok(embeddedDocBlock(file(body.replace(/\n/g, '\r\n'))) === body,
    'CRLF line endings (surrounding AND interior) normalise to the LF body — a CRLF file still compares equal')
  // a data-id lookalike must NOT be mistaken for the real block (the old \bid regex did)
  const lookalike = `<script data-id="bento-doc">\nDECOY\n${close}` + file(body)
  ok(embeddedDocBlock(lookalike) === body, 'a data-id="bento-doc" lookalike is skipped; the real id block is read')
  ok(embeddedDocBlock('<html>no block here</html>') === null, 'no block → null')
  ok(embeddedDocBlock(file('')) === '', 'a present-but-EMPTY block → "" (a pristine New shell, distinct from a non-Bento file that has no block)')
  ok(embeddedDocBlock(file('   \n  ')) === '', 'a whitespace-only block is empty too → ""')
}

// --- launchQueue: a launched document holds a writable handle at boot ---------
// A page opened in a native host or an installed PWA held NO handle until its
// first Cmd-S, so autosave only snapshotted to IndexedDB and the file on disk
// never changed. consumeLaunchQueue() adopts the handle the File Handling API
// delivers, so autosave's `if (hasFileHandle())` path (editor.ts) writes the FILE
// from the first edit. These drive the consumer against a fake launchQueue; the
// module import itself is a no-op here (node has no window).
console.log('\nlaunchQueue adopts the open document — and only it')
{
  const DOC = { docId: 'launch-doc', title: 'Secret Q3 numbers', format: 'bento/slides', slides: [] }
  const MARKER = 'Secret Q3 numbers' // content that must never appear in an encrypted file
  const BOOT = JSON.stringify(DOC) // the open document's #bento-doc body
  const esc = (s: string) => s.replace(/</g, '\\u003c')
  // the live page holds the open doc's #bento-doc (escaped, as a file does)
  ;(globalThis as Record<string, unknown>).document = {
    getElementById: (id: string) => (id === 'bento-doc' ? { textContent: '\n' + esc(BOOT) + '\n' } : null),
  }
  const fileWith = (body: string) =>
    `<!doctype html><html><head><script type="application/json" id="bento-doc">\n${esc(body)}\n` +
    `</scr` + `ipt></head><body></body></html>`
  // a handle: getFile() yields its CURRENT file; createWritable() captures writes.
  // fileBody null = unreadable (getFile throws); omit getFile = cannot be verified.
  const handle = (fileBody: string | null, opts: { noGetFile?: boolean } = {}) => {
    let got: Blob | null = null
    const h: Record<string, unknown> = {
      kind: 'file', name: ON_SCREEN, wrote: async () => (got ? await got.text() : ''),
      async createWritable() { return { async write(b: Blob) { got = b }, async close() {} } },
    }
    if (!opts.noGetFile) h.getFile = async () => {
      if (fileBody === null) throw new Error('unreadable')
      return { text: async () => fileWith(fileBody) }
    }
    return h
  }
  let pending: unknown
  const vend = async (files: unknown[] | null) => {
    ;(globalThis as Record<string, unknown>).launchQueue = files === null ? undefined
      : { setConsumer(fn: (p: unknown) => void) { pending = fn({ files }) } }
    pending = undefined
    consumeLaunchQueue()
    await pending // the consumer reads the file and verifies BEFORE it adopts
  }

  ok(!hasFileHandle(), 'no handle before a launch (autosave would only snapshot — the bug)')
  await vend(null);   ok(!hasFileHandle(), 'no launchQueue (plain tab / node) → nothing adopted, no throw')
  await vend([]);     ok(!hasFileHandle(), 'a refused launch (empty files) adopts nothing')

  // (c) with no handle, the write path writes NOTHING — it throws, touches no file
  let threw = false
  try { await writeUpdatedFile('<html>x') } catch { threw = true }
  ok(threw && !hasFileHandle(), 'with no handle, writeUpdatedFile writes nothing (throws)')

  // the WRONG-FILE guard: a host that vends a handle to a DIFFERENT document, or an
  // unreadable one, or one that cannot be checked, must NOT be adopted — otherwise
  // the first autosave would silently overwrite a file that is not this document.
  await vend([handle('{"docId":"someone-elses","title":"Not yours"}')])
  ok(!hasFileHandle(), 'a handle whose file is a DIFFERENT document is NOT adopted')
  await vend([handle(null)])
  ok(!hasFileHandle(), 'an unreadable handle is NOT adopted')
  await vend([handle(BOOT, { noGetFile: true })])
  ok(!hasFileHandle(), 'a handle that cannot be verified (no getFile) is NOT adopted')

  // the open document: its file's #bento-doc equals the boot block → adopted
  const open = handle(BOOT)
  await vend([open])
  ok(hasFileHandle(), 'the handle whose file IS this document is adopted')
  ok(currentFileName() === ON_SCREEN, `and it is the open document (${currentFileName()})`)

  // Then the REAL write path (what autosave invokes under hasFileHandle()) puts the
  // document bytes on it — driven with encodeDocBody (the exact #bento-doc bytes;
  // the HTML shell is DOM-only furniture, proven by the splice/preview rigs).
  // (a) plaintext parses back to the edited document
  setEncryptionPassword(null)
  await writeUpdatedFile(await encodeDocBody(DOC as never))
  ok(JSON.parse(await (open.wrote as () => Promise<string>)()).docId === DOC.docId,
    'the first write parses back to the edited document')
  // (b) with a password: a bento/enc envelope, no plaintext, decrypts back
  setEncryptionPassword('hunter2')
  await writeUpdatedFile(await encodeDocBody(DOC as never))
  const bytes = await (open.wrote as () => Promise<string>)()
  const env = parseEnvelope(bytes)
  ok(!!env, 'with a password active the written bytes are a bento/enc envelope')
  ok(!bytes.includes(MARKER), 'and carry NO plaintext — the title appears nowhere in the file')
  const dec = env ? await decryptEnvelope(env, 'hunter2') : null
  ok(!!dec && JSON.parse(dec).docId === DOC.docId, 'and decrypt back to the edited document with the password')
  setEncryptionPassword(null)

  // a second consume is harmless (setConsumer re-registration is caught)
  await vend([open])
  ok(hasFileHandle(), 'a second consume is harmless')

  // THE RACE (security's condition): the consumer awaits getFile. If a Save As /
  // "Duplicate as new deck" sets its own handle WHILE the check is pending, the
  // launch must NOT snap the handle back to the launched file and overwrite it.
  // A deferred getFile holds the check open across the adopt.
  {
    let release!: (v: { text: () => Promise<string> }) => void
    const slow = {
      kind: 'file', name: ON_SCREEN, // its file WOULD match — only the race must stop it
      getFile: () => new Promise<{ text: () => Promise<string> }>((res) => { release = res }),
      async createWritable() { return { async write() {}, async close() {} } },
    }
    let pending: unknown
    ;(globalThis as Record<string, unknown>).launchQueue = { setConsumer(fn: (p: unknown) => void) { pending = fn({ files: [slow] }) } }
    consumeLaunchQueue() // the consumer starts and awaits slow.getFile() — still pending
    const saveAs = {
      kind: 'file', name: 'Saved-As-elsewhere.bento.html',
      async createWritable() { return { async write() {}, async close() {} } },
    }
    adoptFileHandle(saveAs as never) // the user does Save As during the await
    release({ text: async () => fileWith(BOOT) }) // now getFile resolves and the file DOES match
    await pending
    ok(hasFileHandle() && currentFileName() === 'Saved-As-elsewhere.bento.html',
      'a Save As during the pending check wins — the launch does not snap back and overwrite it')
  }

  delete (globalThis as Record<string, unknown>).document
}

// --- B6: a pristine New document adopts its handle ----------------------------
// A document made with New in bento/home is a pristine shell: #bento-doc is
// PRESENT but empty. readEmbeddedDoc collapses that to null (like a missing
// block), so consumeLaunchQueue used to discard the host's hand-over and the
// first Cmd-S opened a Save-As picker that wrote a SECOND file, leaving the
// created one empty — the 1.2.9 B6 regression, on every New document in bento/home
// (Android and iOS via the shared bridge). The adopter now reads the element
// directly: '' (pristine) adopts; null (no block at all) does not.
console.log('\nlaunchQueue: a pristine New document adopts its handle (B6)')
{
  const pristineFile =
    `<!doctype html><html><head><script type="application/json" id="bento-doc">\n\n` +
    `</scr` + `ipt></head><body></body></html>`
  const handle = (fileText: string | null) => ({
    kind: 'file', name: 'New-1.bento.html',
    getFile: async () => { if (fileText === null) throw new Error('unreadable'); return { text: async () => fileText } },
    async createWritable() { return { async write() {}, async close() {} } },
  })
  let pending: unknown
  const vend = async (files: unknown[], liveBlock: { textContent: string } | null) => {
    adoptFileHandle(null as never) // reset so this adoption is observable
    ;(globalThis as Record<string, unknown>).document = {
      getElementById: (id: string) => (id === 'bento-doc' ? liveBlock : null),
    }
    ;(globalThis as Record<string, unknown>).launchQueue =
      { setConsumer(fn: (p: unknown) => void) { pending = fn({ files }) } }
    pending = undefined
    consumeLaunchQueue()
    await pending
  }

  // pristine live page (empty block) + a pristine host file (empty block) → adopt
  await vend([handle(pristineFile)], { textContent: '\n\n' })
  ok(hasFileHandle(), 'a pristine New shell adopts the host handle — first Cmd-S saves in place, no picker')
  ok(currentFileName() === 'New-1.bento.html', `and it is the launched New document (${currentFileName()})`)

  // a live page with NO #bento-doc at all (not a Bento document) → booted null → never adopt
  await vend([handle(pristineFile)], null)
  ok(!hasFileHandle(), 'a page with no document block adopts nothing (booted is null, not "")')

  adoptFileHandle(null as never)
  delete (globalThis as Record<string, unknown>).document
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
