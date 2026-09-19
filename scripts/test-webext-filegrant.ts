#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext file-grant rig.
//
//   node scripts/test-webext-filegrant.ts
//
// WHAT THIS PROVES. Saving in place for a document that no granted folder
// covers goes through three more doors — a per-file grant the extension
// holds, the downloads API for the Downloads folder, and the one-time offer —
// and every one of them must (1) write only the sender's own file, (2) use a
// handle only when it is PROVEN to be that file (name and bytes), (3) fail to
// the browser's own picker, never to nothing. A file:// page never holds a
// grant: every local document shares that origin's storage.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'home/webext')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')
const fg = await import('../home/webext/src/filegrant.js')
const bg = await import('../home/webext/src/background.js')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** An in-memory store + disk + downloads API, the shape filegrant.js takes as deps. */
function world(disk: Record<string, string>) {
  const store = new Map<string, any>()
  const downloaded: any[] = []
  let nextId = 1
  const items = new Map<number, any>()
  const listeners: any[] = []
  const kv: Record<string, unknown> = {}
  const deps: any = {
    all: async () => [...store.entries()],
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: any) => { store.set(k, v) },
    del: async (k: string) => { store.delete(k) },
    fetch: async (url: string) => {
      const path = decodeURIComponent(url.replace(/^file:\/\//, ''))
      const body = disk[path]
      if (body === undefined) return { ok: false }
      const bytes = new TextEncoder().encode(body)
      return { ok: true, arrayBuffer: async () => bytes.buffer, text: async () => body }
    },
    storage: { get: async (k: string) => ({ [k]: kv[k] }), set: async (o: any) => { Object.assign(kv, o) } },
    downloads: {
      search: async (q: any) => (q.id != null ? [items.get(q.id)].filter(Boolean) : [...items.values()].slice(-1)),
      download: async (o: any) => { const id = nextId++; downloaded.push(o); items.set(id, { id, filename: `/Users/andy/Downloads/${o.filename}`, state: 'complete' }); return id },
      erase: async () => {}, removeFile: async () => {},
      onChanged: { addListener: (f: any) => listeners.push(f), removeListener: () => {} },
    },
    setUiOptions: async () => {},
  }
  return { deps, store, downloaded, kv }
}
/** A handle over given bytes. */
const handleOf = (name: string, body: string, perm = 'granted') => ({
  name, kind: 'file', perm,
  queryPermission: async () => perm,
  requestPermission: async () => perm,
  getFile: async () => { const b = new TextEncoder().encode(body); return { size: b.length, arrayBuffer: async () => b.buffer } },
  createWritable: async () => ({ write: async () => {}, close: async () => {} }),
})

console.log('\n— the file grant: proven, never assumed')
{
  const w = world({ '/Users/andy/Downloads/Q3.bento.html': 'DECK-Q3', '/Users/andy/Desktop/Q3.bento.html': 'OTHER' })
  const h = handleOf('Q3.bento.html', 'DECK-Q3')
  await fg.addFileGrant(h, null, w.deps)
  const r = await fg.resolveFileGrant('/Users/andy/Downloads/Q3.bento.html', w.deps)
  ok(r.ok && r.handle === h, 'a name-keyed grant serves the path whose bytes it holds')
  ok([...w.store.values()].some((v) => v.path === '/Users/andy/Downloads/Q3.bento.html'), 'and the path is learned onto the record')
  const other = await fg.resolveFileGrant('/Users/andy/Desktop/Q3.bento.html', w.deps)
  ok(!other.ok && other.reason === 'none', 'the same name with other bytes is NOT served — a grant is for one file')
  ok(!(await fg.resolveFileGrant('/Users/andy/Downloads/Nope.bento.html', w.deps)).ok, 'no grant of that name → none')
  const lapsed = world({ '/Users/andy/Downloads/L.bento.html': 'L' })
  await fg.addFileGrant(handleOf('L.bento.html', 'L', 'prompt'), '/Users/andy/Downloads/L.bento.html', lapsed.deps)
  const lr = await fg.resolveFileGrant('/Users/andy/Downloads/L.bento.html', lapsed.deps)
  ok(!lr.ok && lr.reason === 'lapsed', 'a grant without permission is lapsed, and never prompted for from the worker')
  ok(!(await fg.declined('/x', w.deps)), 'not declined by default')
  await fg.decline('/x', w.deps)
  ok(await fg.declined('/x', w.deps), 'a decline is remembered')
  w.store.set(fg.declineKey('/x'), { at: Date.now() - fg.DECLINE_MS - 1 })
  ok(!(await fg.declined('/x', w.deps)), 'and expires after DECLINE_MS')
}

console.log('\n— downloads: the folder Chrome lets an extension write')
{
  const w = world({})
  const dir = await fg.downloadsDir(w.deps)
  ok(dir === '/Users/andy/Downloads', `downloadsDir: learned from the API (${dir}) and`)
  ok(w.kv.downloadsDir === dir, 'remembered in extension storage')
  ok(fg.downloadsRelative('/Users/andy/Downloads/Q3.bento.html', dir) === 'Q3.bento.html', 'downloadsRelative: a file in Downloads → its relative name')
  ok(fg.downloadsRelative('/Users/andy/Downloads/decks/Q3.bento.html', dir) === 'decks/Q3.bento.html', 'downloadsRelative: nested is fine')
  ok(fg.downloadsRelative('/Users/andy/Documents/Q3.bento.html', dir) === null && fg.downloadsRelative('/Users/andy/Downloads/../x.html', dir) === null, 'downloadsRelative: outside, or climbing out → null')
  const n = await fg.writeViaDownloads('Q3.bento.html', '<html>hi</html>', w.deps)
  ok(n === 15 && w.downloaded.at(-1).conflictAction === 'overwrite' && w.downloaded.at(-1).saveAs === false && w.downloaded.at(-1).url.startsWith('data:text/html;base64,'), 'writeViaDownloads: overwrite in place, no dialog, the bytes as a data URL')
  const win = world({}); win.deps.downloads.search = async () => [{ filename: 'C:\\Users\\Andy\\Downloads\\x.txt' }]
  ok(await fg.downloadsDir(win.deps) === '/C:/Users/Andy/Downloads', 'downloadsDir: a Windows path becomes the file:// shape')
}

console.log('\n— the worker: folder, then file, then Downloads; own file only')
const FILE = (p: string) => ({ url: `file://${p}`, frameId: 0 })
{
  const w = world({ '/Users/andy/Downloads/Q3.bento.html': 'DECK-Q3' })
  const h = handleOf('Q3.bento.html', 'DECK-Q3')
  await fg.addFileGrant(h, '/Users/andy/Downloads/Q3.bento.html', w.deps)
  const deps = { readGrants: async () => [], filegrant: w.deps }
  const c = await bg.claim(FILE('/Users/andy/Downloads/Q3.bento.html'), deps)
  ok(c.ok && c.via === 'file' && c.name === 'Q3.bento.html', 'claim: no folder grant → the file grant serves it (via file)')
  const wr = await bg.write(FILE('/Users/andy/Downloads/Q3.bento.html'), 'NEW', deps)
  const decks = () => w.downloaded.filter((d) => d.filename.endsWith('.bento.html')).length
  ok(wr.ok && wr.via === 'file' && decks() === 0, 'write: through the file handle, not the downloads API')
  const dl = await bg.claim(FILE('/Users/andy/Downloads/Other.bento.html'), deps)
  ok(dl.ok && dl.via === 'downloads', 'claim: a Downloads file with no grant → the downloads API (via downloads)')
  const dw = await bg.write(FILE('/Users/andy/Downloads/Other.bento.html'), 'BYTES', deps)
  ok(dw.ok && dw.via === 'downloads' && w.downloaded.at(-1).filename === 'Other.bento.html', 'write: Downloads → downloads.download overwrite of that relative name')
  const doc = await bg.claim(FILE('/Users/andy/Documents/Q3.bento.html'), deps)
  ok(!doc.ok, 'claim: a Documents file with no grant → not ok (the page falls to its picker, or the offer)')
  // the page names nothing: a payload path is never read
  const spoof = await bg.write({ url: 'file:///Users/andy/Documents/x.bento.html', frameId: 0 } as any, 'X', { ...deps })
  ok(!spoof.ok && decks() === 1, 'write: only the sender\'s own url is ever resolved')
  const https = await bg.claim({ url: 'https://bento.page/slides/', frameId: 0 } as any, deps)
  ok(!https.ok, 'claim: not a local file → nothing')
  // a folder grant wins over a file grant for the same document
  const folderDeps = { ...deps, readGrants: async () => [{ name: 'Downloads-decks', queryPermission: async () => 'granted', resolve: async () => ['Q3.bento.html'] }], locateIn: async () => [{ file: { name: 'Q3.bento.html', createWritable: h.createWritable, isSameEntry: async () => true }, rel: ['Q3.bento.html'] }], findByName: async () => [] }
  const fc = await bg.claim(FILE('/Users/andy/Downloads/Q3.bento.html'), folderDeps)
  ok(fc.ok && fc.via === 'folder', 'a folder grant that covers the file takes precedence')
  // a file grant whose file is gone is forgotten on use
  const gone = world({ '/Users/andy/Downloads/G.bento.html': 'G' })
  const gh: any = handleOf('G.bento.html', 'G')
  gh.createWritable = async () => { const e: any = new Error('gone'); e.name = 'NotFoundError'; throw e }
  await fg.addFileGrant(gh, '/Users/andy/Downloads/G.bento.html', gone.deps)
  const gw = await bg.write(FILE('/Users/andy/Downloads/G.bento.html'), 'X', { readGrants: async () => [], filegrant: gone.deps, downloadsDir: async () => null })
  ok(!gw.ok && [...gone.store.values()].every((v) => !v.handle), 'write: NotFoundError on a file grant drops it')
}

console.log('\n— the page side: waiting on the offer')
{
  const SRC_BRIDGE = read('src/page-bridge.js')
  const posted: any[] = []
  const answers: Record<string, any> = {}
  const win: any = {
    location: { pathname: '/Users/andy/Downloads/Q3.bento.html' },
    addEventListener() {},
    postMessage(msg: any) {
      posted.push(msg)
      // answer as the relay would, from a script of replies by op+payload
      const key = msg.payload?.token ? 'claim:token' : msg.op
      const res = answers[key]
      if (res) setTimeout(() => win._deliver({ __bento_tray__: true, dir: 'res', id: msg.id, result: res }), 0)
    },
    showSaveFilePicker: async () => ({ __native: true }),
    bento: { updates: { version: '1.2.1' } },
  }
  const listeners: any[] = []
  win.addEventListener = (_: string, f: any) => listeners.push(f)
  win._deliver = (data: any) => listeners.forEach((f) => f({ data, source: win }))
  const ctx: any = createContext({ window: win, setTimeout, clearTimeout, Date, Math, JSON, Promise, Blob, console, DOMException: class extends Error { constructor(m: string, n: string) { super(m); this.name = n } }, FileSystemHandle: class {}, crypto: { randomUUID: () => 'x' } })
  ctx.globalThis = ctx
  runInContext(SRC_BRIDGE, ctx)
  answers.claim = { ok: false, reason: 'setup', token: 'tok-1' }
  answers['claim:token'] = { ok: true, name: 'Q3.bento.html', via: 'file' }
  const h = await win.showSaveFilePicker({ id: 'bento-doc', suggestedName: 'Q3.bento.html' })
  ok(posted.filter((m) => m.op === 'claim').length === 2 && posted[1].payload?.token === 'tok-1', 'setup → the bridge asks again with the token and waits')
  ok(h.name === 'Q3.bento.html' && !h.__native, 'and the save goes through the extension once the window answered')
  answers['claim:token'] = { ok: false, reason: 'declined' }
  const h2 = await win.showSaveFilePicker({ id: 'bento-doc', suggestedName: 'Q3.bento.html' })
  ok(h2.__native === true, 'declined → the browser\'s own picker, as without the extension')
  ok(/120000/.test(SRC_BRIDGE), 'the second claim waits as long as a dialog takes')
}
{
  const manifest = JSON.parse(read('manifest.json'))
  ok(manifest.permissions.includes('downloads') && manifest.permissions.includes('downloads.ui'), 'manifest: downloads (the write) and downloads.ui (the bubble, quiet for the write)')
  const bgSrc = read('src/background.js')
  ok(/claimOrOffer/.test(bgSrc) && /filegrant\.html/.test(bgSrc) && /isFileAccessOn/.test(bgSrc), 'the worker offers the window only with file-URL access on')
  ok(/declined\(path\)/.test(bgSrc), 'a declined file is not asked again')
  const winSrc = read('src/filegrant-window.js')
  ok(/showOpenFilePicker/.test(winSrc) && /handleIsPath\(handle, path\)/.test(winSrc) && /addFileGrant\(handle, path\)/.test(winSrc), 'the window picks in the extension\'s context, proves the bytes, then stores')
  const home = read('src/home.js')
  ok(/getAsFileSystemHandle/.test(home) && /addFileGrant\(handle, path\)/.test(home), 'the library takes drops as grants — a folder or a file — with no dialog')
  ok(/listFileGrants\(\)/.test(home) && /dropFileGrant\(g\.key\)/.test(home), 'Settings lists file grants with Remove')
}

console.log('\n— a Chrome that asks where to save every download')
{
  // the downloads API "completes" with USER_CANCELED when Chrome prompted and the person cancelled
  const w = world({ '/Users/andy/Downloads/P.bento.html': 'P' })
  w.deps.downloads.download = async (o: any) => { const id = 99; w.downloaded.push(o); return id }
  w.deps.downloads.search = async (q: any) => (q.id === 99 ? [{ id: 99, state: 'interrupted', error: 'USER_CANCELED', filename: '/Users/andy/Downloads/P.bento.html' }] : [{ filename: '/Users/andy/Downloads/x.txt' }])
  const deps = { readGrants: async () => [], filegrant: w.deps }
  const first = await bg.write(FILE('/Users/andy/Downloads/P.bento.html'), 'X', deps)
  ok(!first.ok && first.retry === 'native' && /asks where to save/.test(first.reason), 'a prompted download: the page is told to finish this save with the browser\'s own picker')
  ok(w.kv.downloadsUnusable === true, 'and the Downloads door is switched off for this Chrome')
  const next = await bg.claim(FILE('/Users/andy/Downloads/P.bento.html'), deps)
  ok(!next.ok && next.via !== 'downloads', 'the next claim no longer takes the Downloads door (the offer follows in the worker)')
  await fg.setDownloadsUnusable(false, w.deps)
  ok((await bg.claim(FILE('/Users/andy/Downloads/P.bento.html'), deps)).via === 'downloads', 'Settings "Try again" reopens it')
  ok(/retry === 'native'/.test(read('src/page-bridge.js')) && /native\(forNative\(\{ suggestedName: name \}\)\)/.test(read('src/page-bridge.js')), 'page-bridge finishes such a save through the native picker instead of throwing the bytes away')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
