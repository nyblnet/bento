#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext "Save a copy…" / export rig.
//
//   node scripts/test-webext-saveas.ts
//
// WHAT THIS PROVES. A copy or an export is answered by the extension's own
// window, so it can land beside the document instead of in Downloads. The
// properties: the page supplies a NAME, never a place; a write lands only
// where the person chose, and only for the document that asked; a beside-name
// can never be a path or the open document itself; cancelling is cancelling;
// and no window, no answer, means the browser's own picker. The real
// saveas.js runs here.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'home/webext/src')
const sa = await import('../home/webext/src/saveas.js')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** A folder handle with the methods saveas.js uses; files are name → text. */
function folder(name: string, files: Record<string, string> = {}, perm = 'granted') {
  const fileHandle = (n: string) => ({
    name: n, kind: 'file',
    queryPermission: async () => perm,
    createWritable: async () => { let buf = ''; return { write: async (t: string) => { buf += t }, close: async () => { files[n] = buf } } },
  })
  return {
    name, kind: 'directory', files,
    queryPermission: async () => perm,
    getFileHandle: async (n: string, o: any = {}) => {
      if (!(n in files) && !o.create) { const e: any = new Error('nf'); e.name = 'NotFoundError'; throw e }
      return fileHandle(n)
    },
    fileHandle,
  }
}
const memdb = () => {
  const m = new Map<string, any>()
  return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: any) => { m.set(k, v) }, del: async (k: string) => { m.delete(k) }, all: async () => [...m.entries()] }
}
let clock = Date.UTC(2026, 9, 9)
let n = 0
const DOC = '/Users/you/Decks/Q3.bento.html'
const OTHER = '/Users/you/Decks/Other.bento.html'

/** deps whose window "does" what `person` says, by writing the record the way saveas-window.js does. */
const depsFor = (opts: { dir?: any; person?: (token: string, db: any) => Promise<boolean | null> } = {}) => {
  const db = memdb()
  return {
    db, now: () => clock, token: () => `tok-${++n}`,
    folderOf: async () => opts.dir ?? null,
    openWindow: async (token: string) => (opts.person ? opts.person(token, db) : false),
  }
}

console.log('\n— names: a suggestion to show, a beside-name to create')
{
  ok(sa.besideName('Q3 copy', 'Q3.bento.html').name === 'Q3 copy.bento.html', 'a bare name gets .bento.html, as the browser\'s picker would')
  ok(sa.besideName('Q3 view.html', 'Q3.bento.html').name === 'Q3 view.bento.html', 'a plain .html becomes .bento.html')
  for (const bad of ['../x', 'a/b.bento.html', 'a\\b', '', '  ', '..', 'x\u0000y'])
    ok(!sa.besideName(bad, 'Q3.bento.html').ok, `refused: ${JSON.stringify(bad)}`)
  ok(sa.besideName('q3.BENTO.html', 'Q3.bento.html').reason === 'is-original', 'the open document\'s own name (any case) is refused')
  ok(sa.suggestion('../../etc/evil.bento.html', 'Q3.bento.html') === 'evil.bento.html', 'a page\'s suggestion is reduced to a name before it is even shown')
  ok(sa.suggestion('Q3.bento.html', 'Q3.bento.html') === 'Q3 copy.bento.html', 'suggesting the original name itself falls back to "<name> copy"')
}

console.log('\n— asking: only copies and exports, only for a document')
{
  const d = depsFor()
  ok((await sa.ask(null, { id: 'bento-copy', name: 'x' }, d)).reason === 'not a document', 'no path (not a top-frame file://) → not a document → the page uses its own picker')
  for (const id of ['bento-doc', 'bento-backup', 'other', undefined])
    ok((await sa.ask(DOC, { id, name: 'x' }, d)).reason === 'not a save-as', `${id} is not a save-as (⌘S and backups never come here)`)
  ok(d.db.m.size === 0, 'and nothing was recorded for any of them')
}

console.log('\n— beside the document, in one click')
{
  const dir = folder('Decks', { 'Q3.bento.html': 'ORIGINAL' })
  const d = depsFor({ dir, person: async (t, db) => sa.choose(t, { kind: 'beside', name: 'Q3 copy.bento.html' }, db) })
  const r = await sa.ask(DOC, { id: 'bento-copy', name: 'Q3.bento.html' }, d)
  ok(r.ok && r.name === 'Q3 copy.bento.html' && typeof r.token === 'string', 'the window\'s choice comes back as a token and a name')
  const rec = await d.db.get(r.token)
  ok(rec.path === DOC && rec.purpose === 'copy' && rec.dir === dir, 'the record binds the token to the asking document and its own folder')
  const w = await sa.write(DOC, { token: r.token, text: 'COPY' }, d)
  ok(w.ok && dir.files['Q3 copy.bento.html'] === 'COPY' && dir.files['Q3.bento.html'] === 'ORIGINAL', 'the copy lands beside the original; the original is untouched')
  ok((await sa.write(DOC, { token: r.token, text: 'COPY 2' }, d)).ok && dir.files['Q3 copy.bento.html'] === 'COPY 2', 'and the next save to it (save.ts makes the copy the ⌘S target) writes it again')
  ok((await sa.write(OTHER, { token: r.token, text: 'EVIL' }, d)).reason === 'not this document\'s save' && dir.files['Q3 copy.bento.html'] === 'COPY 2', 'another document holding the token writes nothing')
  ok((await sa.write(null, { token: r.token, text: 'EVIL' }, d)).reason === 'not a document', 'a sender with no path (a sub-frame) writes nothing')
  ok((await sa.write(DOC, { token: 'tok-guess', text: 'x' }, d)).reason === 'no such save', 'an unknown token writes nothing')
  // a record tampered to name the original is still refused at the write
  await d.db.put(r.token, { ...rec, choice: { kind: 'beside', name: 'Q3.bento.html' } })
  ok((await sa.write(DOC, { token: r.token, text: 'CLOBBER' }, d)).reason === 'is-original' && dir.files['Q3.bento.html'] === 'ORIGINAL', 'a beside-write can never replace the open document, even from a bad record')
  await d.db.put(r.token, { ...rec, choice: { kind: 'beside', name: '../escape.bento.html' } })
  ok(!(await sa.write(DOC, { token: r.token, text: 'x' }, d)).ok && !('../escape.bento.html' in dir.files), 'nor climb out of the folder')
}
{
  const dir = folder('Decks', {}, 'prompt')
  const d = depsFor({ dir, person: async (t, db) => sa.choose(t, { kind: 'beside', name: 'X.bento.html' }, db) })
  const r = await sa.ask(DOC, { id: 'bento-share', name: 'X.bento.html' }, d)
  ok((await sa.write(DOC, { token: r.token, text: 'x' }, d)).reason === 'folder grant needs renewing' && !('X.bento.html' in dir.files), 'a lapsed folder grant writes nothing and says why')
}

console.log('\n— a folder the person chose in the picker')
{
  const elsewhere = folder('Exports')
  const picked = elsewhere.fileHandle('Q3-view.bento.html')
  const d = depsFor({ person: async (t, db) => sa.choose(t, { kind: 'handle', handle: picked, name: picked.name }, db) })
  const r = await sa.ask(DOC, { id: 'bento-share', name: 'Q3-view.bento.html' }, d)
  ok(r.ok && r.name === 'Q3-view.bento.html' && (await d.db.get(r.token)).dir === null, 'with no folder grant there is no "beside", only the picker')
  ok((await sa.write(DOC, { token: r.token, text: 'VIEW' }, d)).ok && elsewhere.files['Q3-view.bento.html'] === 'VIEW', 'the bytes land in the picked file')
}

console.log('\n— cancelling, and no window at all')
{
  const d = depsFor({ dir: folder('Decks'), person: async () => false })
  const r = await sa.ask(DOC, { id: 'bento-copy', name: 'x' }, d)
  ok(!r.ok && r.cancelled === true && d.db.m.size === 0, 'closing or cancelling the window is "cancelled" (no native dialog after it), and the record is gone')
  const d2 = depsFor({ dir: folder('Decks'), person: async () => true })
  ok((await sa.ask(DOC, { id: 'bento-copy', name: 'x' }, d2)).cancelled === true, 'a window that answered without recording a choice is also cancelled')
  const d3 = depsFor({ person: async () => null })
  const r3 = await sa.ask(DOC, { id: 'bento-copy', name: 'x' }, d3)
  ok(!r3.ok && !r3.cancelled && r3.reason === 'window unavailable', 'a window that could not open is NOT cancelled — the page falls to its own picker')
}

console.log('\n— one window per document')
{
  const open = new Set<string>()
  let windows = 0
  let release: any
  const d = { ...depsFor(), busy: (p: string) => open.has(p), openWindow: (_t: string, p: string) => { windows++; open.add(p); return new Promise((r) => { release = () => { open.delete(p); r(false) } }) } }
  const first = sa.ask(DOC, { id: 'bento-copy', name: 'x' }, d)
  await new Promise((r) => setTimeout(r, 0))
  const second: any = await Promise.race([sa.ask(DOC, { id: 'bento-share', name: 'y' }, d), new Promise((r) => setTimeout(() => r({ hung: true }), 200))])
  ok(second.cancelled === true && windows === 1, 'a second ask from the same document while its window is open opens nothing')
  const other = sa.ask(OTHER, { id: 'bento-copy', name: 'z' }, { ...d, openWindow: async () => { windows++; return false } })
  await other
  ok(windows === 2, 'another document still gets its own')
  release(); await Promise.race([first, new Promise((r) => setTimeout(r, 200))])
}

console.log('\n— the sweep')
{
  const d = depsFor()
  await d.db.put('old', { path: DOC, at: clock - sa.KEEP_MS - 1 })
  await d.db.put('new', { path: DOC, at: clock })
  await sa.gc(d)
  ok(!d.db.m.has('old') && d.db.m.has('new'), `records older than ${sa.KEEP_MS / 3600000}h are swept, fresh ones kept`)
}

console.log('\n— the wiring')
{
  const bg = readFileSync(join(SRC, 'background.js'), 'utf8')
  ok(/op === 'saveas' \? saveas\.ask\(topPath\(sender\)/.test(bg) && /op === 'saveas\.write' \? saveas\.write\(topPath\(sender\)/.test(bg), 'the worker passes only the sender\'s own top-frame path')
  ok(/const topPath = \(sender\) => \(sender\?\.frameId === 0 \? pathFromSender\(sender\) : null\)/.test(bg), 'topPath is top frame only')
  ok(/function saveasAnswered[\s\S]{0,120}isSaveasWindow\(sender\)/.test(bg), 'only the save-as window may answer')
  const win = readFileSync(join(SRC, 'saveas-window.js'), 'utf8')
  ok(/showSaveFilePicker\(\{[\s\S]{0,80}startIn,/.test(win) && /startIn = rec\.dir \?\? await startInFor\(rec\.path\)/.test(win), 'the picker opens in the document\'s folder, or the nearest one held')
  ok(/exists && confirmReplace !== name/.test(win), 'an existing file beside the document is replaced only on a second, warned click')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
