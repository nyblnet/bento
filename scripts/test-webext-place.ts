#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext placement rig.
//
//   node scripts/test-webext-place.ts
//
// WHAT THIS PROVES. A granted folder is placed on disk by GUESSING paths and
// PROVING one: the folder's name under each likely parent, one document's
// bytes compared at that path, the grant asked to confirm. Two things must
// hold: a wrong guess (same name, different bytes; same bytes, a copy outside
// the grant) is never recorded, and a right one is found among the usual
// places without the person doing anything. Also here: the title card drawn
// from a document that carries no preview render.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'home/webext')
const place = await import('../home/webext/src/place.js')
const { cardFrom } = await import('../home/webext/src/library.js')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** A fake disk: paths → bytes; directories → Chrome-style listings. */
function disk(files: Record<string, string>) {
  const fetched: string[] = []
  const listing = (dir: string) => {
    const names = new Map<string, boolean>()
    for (const p of Object.keys(files)) {
      if (!p.startsWith(dir + '/')) continue
      const rest = p.slice(dir.length + 1)
      const head = rest.split('/')[0]
      names.set(head, rest.includes('/'))
    }
    if (!names.size) return null
    return [...names].map(([n, isDir]) => `<script>addRow("${n}","${n}",${isDir ? 1 : 0},0,"0",0,"");</script>`).join('\n')
  }
  const fetch = async (url: string) => {
    const path = decodeURIComponent(url.replace(/^file:\/\//, ''))
    fetched.push(path)
    if (path.endsWith('/')) {
      const html = listing(path.slice(0, -1))
      return html ? { ok: true, text: async () => html } : { ok: false }
    }
    const body = files[path]
    if (body === undefined) return { ok: false }
    const bytes = new TextEncoder().encode(body)
    return { ok: true, arrayBuffer: async () => bytes.buffer, text: async () => body }
  }
  return { fetch, fetched }
}

/** A grant: its name, the documents in it (rel → bytes). `prefixFor` proves a path by looking the tail up in it. */
function grant(name: string, docs: Record<string, string>) {
  const dir = { name }
  const handleOf = (rel: string) => ({ getFile: async () => { const b = new TextEncoder().encode(docs[rel]); return { size: b.length, arrayBuffer: async () => b.buffer } } })
  const prefixFor = async (d: any, path: string) => {
    for (const rel of Object.keys(docs)) {
      const suffix = `/${name}/${rel}`
      if (path.endsWith(suffix)) return path.slice(0, -suffix.length) + `/${name}`
    }
    return null
  }
  const probe = (rel: string) => ({ rel: rel.split('/'), handle: handleOf(rel) })
  return { dir, prefixFor, probe }
}

console.log('\n— listing and fingerprints')
{
  const d = disk({ '/Users/andy/Desktop/x.txt': 'x', '/Users/andy/Decks/a.bento.html': 'A' })
  const users = await place.listDir('/Users', { fetch: d.fetch })
  ok(users.length === 1 && users[0].name === 'andy' && users[0].dir, 'listDir: Chrome\'s addRow() listing → names and kinds')
  ok((await place.listDir('/nowhere', { fetch: d.fetch })).length === 0, 'listDir: a refused fetch is an empty listing, not an error')
  const file = { size: 1, arrayBuffer: async () => new TextEncoder().encode('A').buffer }
  ok(await place.sameFile('/Users/andy/Decks/a.bento.html', file, { fetch: d.fetch }), 'sameFile: the same bytes at the path')
  ok(!(await place.sameFile('/Users/andy/Desktop/x.txt', file, { fetch: d.fetch })), 'sameFile: same size, different bytes → no')
  ok(!(await place.sameFile('/Users/andy/Decks/missing.bento.html', file, { fetch: d.fetch })), 'sameFile: nothing there → no')
  ok(place.fileUrl('/Users/andy/My Decks/Q3 #1.bento.html') === 'file:///Users/andy/My%20Decks/Q3%20%231.bento.html', 'fileUrl: segments encoded')
}

console.log('\n— placing a grant')
{
  const g = grant('teams-test', { 'S1.bento.html': 'DECK-S1', 'sub/B9.bento.html': 'DECK-B9' })
  // the real folder on the Desktop; a same-named folder with other bytes in Documents; a copy of S1 elsewhere
  const d = disk({
    '/Users/andy/Desktop/teams-test/S1.bento.html': 'OTHER',
    '/Users/andy/Documents/teams-test/S1.bento.html': 'DECK-S1',
    '/Users/andy/Documents/teams-test/sub/B9.bento.html': 'DECK-B9',
    '/Users/andy/Downloads/copies/S1.bento.html': 'DECK-S1',
    '/Users/shared-user/Desktop/x': 'x',
  })
  const prefix = await place.placeFolder(g.dir, g.probe('S1.bento.html'), {}, { fetch: d.fetch, prefixFor: g.prefixFor })
  ok(prefix === '/Users/andy/Documents/teams-test', `placeFolder: found in Documents from nothing but the /Users listing (${prefix})`)
  ok(d.fetched.some((p) => p === '/Users/andy/Desktop/teams-test/S1.bento.html'), 'the same-named folder with other bytes (Desktop, tried first) was rejected')
  ok(!d.fetched.some((p) => p.includes('/copies/')), 'a copy elsewhere is never a candidate: only the folder\'s own name is looked for')
  ok(d.fetched.length < place.MAX_CANDIDATES, `bounded: ${d.fetched.length} fetches`)
  // a probe deeper in the tree proves the same prefix
  const viaSub = await place.placeFolder(g.dir, g.probe('sub/B9.bento.html'), {}, { fetch: d.fetch, prefixFor: g.prefixFor })
  ok(viaSub === '/Users/andy/Documents/teams-test', 'placeFolder: a nested document as the fingerprint lands on the same prefix')
}
{
  // the grant must agree: same bytes at the path, but prefixFor says no → not recorded
  const g = grant('Decks', { 'a.bento.html': 'A' })
  const d = disk({ '/Users/andy/Decks/a.bento.html': 'A' })
  const prefix = await place.placeFolder(g.dir, g.probe('a.bento.html'), {}, { fetch: d.fetch, prefixFor: async () => null })
  ok(prefix === null, 'placeFolder: matching bytes are not enough — the grant has to resolve the path')
}
{
  // near what is already known: a sibling of a placed folder is found without any listing
  const g = grant('Decks', { 'a.bento.html': 'A' })
  const d = disk({ '/Volumes/Work/projects/Decks/a.bento.html': 'A' })
  const prefix = await place.placeFolder(g.dir, g.probe('a.bento.html'), { Notes: '/Volumes/Work/projects/Notes' }, { fetch: d.fetch, prefixFor: g.prefixFor })
  ok(prefix === '/Volumes/Work/projects/Decks', 'placeFolder: a sibling of an already-placed folder, on a volume no listing names')
  const empty = await place.placeFolder(g.dir, g.probe('a.bento.html'), {}, { fetch: async () => ({ ok: false }), prefixFor: g.prefixFor })
  ok(empty === null, 'placeFolder: a disk that answers nothing → null, quietly')
  ok((await place.placeFolder(g.dir, { rel: [], handle: null }, {}, { fetch: d.fetch, prefixFor: g.prefixFor })) === null, 'placeFolder: no probe document → null')
}
{
  const dirs = await place.candidateDirs('X', { A: '/Users/andy/Documents/A' }, { fetch: async () => ({ ok: false }) })
  ok(dirs[0] === '/Users/andy/Documents/X' && dirs.includes('/Users/andy/Desktop/X') && dirs.includes('/Users/andy/X'), 'candidateDirs: beside the known folder first, then the usual places in that home')
  ok(new Set(dirs).size === dirs.length && dirs.length <= place.MAX_CANDIDATES, 'candidateDirs: unique and bounded')
}

console.log('\n— the title card from a document with no preview')
{
  const doc = { format: 'bento/slides', title: 'Q3', theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F28C5A' }, slides: [
    { id: 's0', stateOf: 'x', background: '#000000', elements: [{ type: 'text', html: 'hidden state' }] },
    { id: 's1', background: '#123456', elements: [{ type: 'text', role: 'kicker', html: '<b>Kicker</b>', fontSize: 20 }, { type: 'text', role: 'title', html: 'The <i>file</i> is the&nbsp;software.', fontSize: 64 }, { type: 'text', html: 'sub', placeholder: 'x' }, { type: 'shape', html: 'no' }, { type: 'text', md: 'body words', fontSize: 24 }] },
  ] }
  const shell = `<html><script id="bento-doc" type="application/json">${JSON.stringify(doc).replace(/</g, '\\u003c')}</script><body></body></html>`
  const card = cardFrom(shell)!
  ok(!!card && card.bg === '#123456' && card.ink === '#1E2A3A' && card.accent === '#F28C5A', 'cardFrom: the first NON-state slide\'s background, the theme\'s ink and accent')
  ok(card.lines.map((l) => l.text).join('|') === 'Kicker|The file is the software.|body words', 'cardFrom: the slide\'s texts, tags stripped, placeholders and shapes skipped')
  ok(card.lines[1].role === 'title' && card.lines[1].size === 64, 'cardFrom: role and size ride along so the card can lead with the title')
  ok(cardFrom('<html>no doc</html>') === null && cardFrom('<script id="bento-doc">{bad</script>') === null, 'cardFrom: not a deck → null')
  const bare = cardFrom(`<script id="bento-doc">${JSON.stringify({ slides: [{ id: 'a', elements: [] }] })}</script>`)!
  ok(bare && bare.bg === null && bare.lines.length === 0, 'cardFrom: missing colours stay null (the UI palette fills in), no literal of its own')
  ok(cardFrom(`<script id="bento-doc">${JSON.stringify({ slides: [{ id: 'a', background: 'url(javascript:x)', elements: [] }] })}</script>`)!.bg === null, 'cardFrom: a background that is not a colour is dropped')
}
{
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
  ok(Array.isArray(manifest.host_permissions) && manifest.host_permissions.includes('file:///*') && manifest.host_permissions.length === 1, 'manifest: file:///* is the only declared host — what reading a local path needs, and nothing on the web')
  const home = readFileSync(join(SRC, 'src/home.js'), 'utf8')
  ok(/placeFolders\(\)/.test(home) && /placeFolders\(\{ force: true \}\)/.test(home), 'home.js places on load and again on Find my folders / a click')
  ok(!/card\.disabled = true/.test(home), 'an unplaced card is no longer disabled — it explains and retries')
}

console.log('\n— the scan: documents found without a grant')
{
  const d = disk({
    '/Users/andy/Documents/Decks/Q3.bento.html': 'A',
    '/Users/andy/Documents/Decks/old/Q2.bento.html': 'B',
    '/Users/andy/Documents/notes.txt': 'n',
    '/Users/andy/Documents/node_modules/x/y.bento.html': 'skip',
    '/Users/andy/Desktop/teams-test/S1.bento.html': 'C',
    '/Users/andy/Downloads/Untitled.bento.html': 'D',
    '/Users/andy/Library/Mobile Documents/com~apple~CloudDocs/Work/W.bento.html': 'E',
    '/Users/andy/Movies/x.bento.html': 'not scanned',
    '/Users/Shared/y.bento.html': 'not a home',
  })
  const found = await place.scanDisk({ fetch: d.fetch })
  const paths = found.map((f) => f.path).sort()
  ok(paths.join('|') === [
    '/Users/andy/Desktop/teams-test/S1.bento.html',
    '/Users/andy/Documents/Decks/Q3.bento.html',
    '/Users/andy/Documents/Decks/old/Q2.bento.html',
    '/Users/andy/Downloads/Untitled.bento.html',
    '/Users/andy/Library/Mobile Documents/com~apple~CloudDocs/Work/W.bento.html',
  ].join('|'), `scanDisk: every .bento.html under Documents/Desktop/Downloads/iCloud, nested, nothing else (${found.length})`)
  ok(!paths.some((p) => p.includes('node_modules') || p.includes('/Movies/') || p.startsWith('/Users/Shared')), 'scanDisk: noisy trees, other folders and non-home users are skipped')
  ok(found[0].name.endsWith('.bento.html') && found.every((f) => f.dir && !f.dir.endsWith('/')), 'scanDisk: name and directory for each')
  ok(!d.fetched.some((p) => !p.endsWith('/')), 'scanDisk: listings only — no document bytes are read')
  const none = await place.scanDisk({ fetch: async () => ({ ok: false }) })
  ok(none.length === 0, 'scanDisk: a disk that answers nothing → nothing, no throw')
  const deep = disk(Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`/Users/u/Documents/${'d/'.repeat(place.SCAN_DEPTH + 2)}f${i}.bento.html`, 'x'])))
  ok((await place.scanDisk({ fetch: deep.fetch })).length === 0, 'scanDisk: depth-limited')
  const home = readFileSync(join(SRC, 'src/home.js'), 'utf8')
  ok(/scannedDocs\(/.test(home) && /scanned: true/.test(home) && /addFolderFor/.test(home), 'home.js lists found documents beside granted ones and offers the grant per folder')
  ok(/prefixFor\(dir, d\.path\)/.test(home), 'a grant made for a found document is checked against that document\'s path before it is kept')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
