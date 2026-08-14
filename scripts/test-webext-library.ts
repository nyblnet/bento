#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// tray/webext document-library rig.
//
//   node scripts/test-webext-library.ts
//
// WHAT THIS PROVES. The popup is a document browser now, and everything it
// shows is DERIVED from files on disk — the title out of the document block,
// the thumbnail out of the preview block, the openable path out of a prefix
// learned elsewhere. Each of those is a parse against a format that moves, and
// each fails in the same quiet way: a row that says `Q3-board` instead of
// "Q3 Board Review", or a blank square where a picture should be. Nothing
// throws, so nothing reports it.
//
// The title parse has form here. An earlier metadata reader looked for the
// CLOSING `</script>` of the document block and so found nothing in any
// document carrying an image, because those blocks run to megabytes — every
// real deck showed no title, and it was caught only by opening real files.
// So this rig reads a REAL BUILT SHELL where one is available, not only
// hand-written fixtures shaped to pass.

import { existsSync, readFileSync } from 'node:fs'
import { listDocuments, describe, newDocument } from '../tray/webext/src/library.js'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ---- fake filesystem --------------------------------------------------------
function fileHandle(name: string, text = '', modified = 1_700_000_000_000) {
  return {
    kind: 'file' as const,
    name,
    async getFile() {
      return {
        size: text.length,
        lastModified: modified,
        async text() { return text },
        slice(a: number, b: number) {
          const part = text.slice(a, b)
          return { async text() { return part } }
        },
      }
    },
    async createWritable() {
      return { async write(t: string) { (this as any)._ = t; written.set(name, t) }, async close() {} }
    },
  }
}
const written = new Map<string, string>()

function dirHandle(name: string, tree: Record<string, any>, perm = 'granted') {
  return {
    kind: 'directory' as const,
    name,
    async queryPermission() { return perm },
    async getFileHandle(n: string, opts?: { create?: boolean }) {
      const v = tree[n]
      if (v && v.kind === 'file') return v
      if (!opts?.create) throw Object.assign(new Error(n), { name: 'NotFoundError' })
      const h = fileHandle(n)
      tree[n] = h
      return h
    },
    async *entries() {
      for (const [k, v] of Object.entries(tree)) {
        yield [k, v.kind ? v : dirHandle(k, v, perm)] as const
      }
    },
  }
}

const noCache = { get: async () => null, put: async () => {} }

// ---- 1. what counts as a document ------------------------------------------
{
  const tree = {
    'Q3.bento.html': fileHandle('Q3.bento.html'),
    'notes.txt': fileHandle('notes.txt'),
    'page.html': fileHandle('page.html'),          // html, but not ours
    '.hidden': { 'Secret.bento.html': fileHandle('Secret.bento.html') },
    Clients: { 'Plan.bento.html': fileHandle('Plan.bento.html') },
  }
  const docs = await listDocuments({
    getGrants: async () => [dirHandle('Decks', tree)],
    prefixes: async () => ({}),
  })
  const names = docs.map((d: any) => d.name).sort()
  ok(names.length === 2 && names[0] === 'Plan.bento.html' && names[1] === 'Q3.bento.html',
    `only .bento.html documents are listed, at any depth (${names.join(', ')})`)
  ok(!docs.some((d: any) => d.name === 'Secret.bento.html'),
    'a dot-directory is not walked — those are caches and version control, not documents')
  ok(docs.every((d: any) => d.path === null),
    'without a learned prefix a document has no path, so the row can say it is not openable')
  ok(docs.find((d: any) => d.name === 'Plan.bento.html')?.rel.join('/') === 'Clients/Plan.bento.html',
    'a nested document keeps its route, which is what the path is built from')
}
{
  const tree = { Clients: { 'Plan.bento.html': fileHandle('Plan.bento.html') } }
  const docs = await listDocuments({
    getGrants: async () => [dirHandle('Decks', tree)],
    prefixes: async () => ({ Decks: '/Users/x/Decks' }),
  })
  ok(docs[0].path === '/Users/x/Decks/Clients/Plan.bento.html',
    'with a learned prefix the absolute path is reassembled — this is what makes a row clickable')
}
{
  // A lapsed folder cannot be read; the OTHER folders must still list.
  const good = dirHandle('Good', { 'A.bento.html': fileHandle('A.bento.html') })
  const bad = dirHandle('Bad', { 'B.bento.html': fileHandle('B.bento.html') }, 'prompt')
  const docs = await listDocuments({ getGrants: async () => [bad, good], prefixes: async () => ({}) })
  ok(docs.length === 1 && docs[0].name === 'A.bento.html',
    'a lapsed folder is skipped rather than throwing, so one bad grant cannot empty the list')
}

// ---- 2. title and preview, against a REAL shell -----------------------------
// The parse that has failed before. Fixtures shaped by hand would have passed
// then too; only a real file caught it.
const REAL = 'slides/dist-single/Bento_Slides.bento.html'
if (existsSync(REAL)) {
  const html = readFileSync(REAL, 'utf8')
  const doc = { base: 'Bento_Slides', folder: 'Decks', rel: ['Bento_Slides.bento.html'],
    handle: fileHandle('Bento_Slides.bento.html', html) }
  const meta = await describe(doc as any, noCache)
  // A PRISTINE shell ships with an EMPTY block — `id="bento-doc"></script>` —
  // because the starter document is built at runtime and only written into the
  // file on the first save. So it legitimately has no title, and the filename
  // fallback is the right answer rather than a parse failure. This is also what
  // `+ New document` produces, so its rows read "Untitled" until first saved.
  ok(meta.title === 'Bento_Slides',
    'a pristine shell has no document in it yet, so the file name is shown')
  ok(meta.encrypted === false, 'and it is not mistaken for an encrypted document')

  const docBlock = html.indexOf('id="bento-doc"')
  ok(docBlock > 0 && docBlock < 300 * 1024,
    `the document block starts inside the head that is read (${Math.round(docBlock / 1024)}KB)`)

  // And now the case that matters: the same real shell with a document spliced
  // in, at the real offset, in the real byte layout. This is what every SAVED
  // document looks like, and it is where the previous metadata reader failed —
  // it hunted for the block's closing tag, which sits megabytes away in any
  // document carrying an image.
  const saved = html.replace('id="bento-doc"></script>',
    'id="bento-doc">{"format":"bento/slides","title":"Q3 Board Review","slides":[]}</script>')
  ok(saved !== html, 'the fixture actually spliced (the empty-block shape has not changed)')
  const savedMeta = await describe({ ...doc, handle: fileHandle('Q3.bento.html', saved) } as any, noCache)
  ok(savedMeta.title === 'Q3 Board Review',
    `a saved document yields its title from inside a real shell (${JSON.stringify(savedMeta.title)})`)

  // Same shell, but with a megabyte of document after the title — the exact
  // shape that broke the old reader. The title must still be found, because it
  // is matched directly rather than by finding the end of the block.
  const big = html.replace('id="bento-doc"></script>',
    `id="bento-doc">{"title":"Big Deck","blob":"${'x'.repeat(1_200_000)}"}</script>`)
  const bigMeta = await describe({ ...doc, handle: fileHandle('Big.bento.html', big) } as any, noCache)
  ok(bigMeta.title === 'Big Deck',
    'and still yields it when the document block runs past the head that is read')
} else {
  console.log('  ..    skipped real-shell checks (no dist-single build present)')
}

// ---- 3. title and preview, synthetic edge cases -----------------------------
{
  const withPreview =
    '<html><script id="bento-doc" type="application/json">{"title":"Q3 Board Review","slides":[]}</script>'
    + '<div data-bento-preview="1"><b>page one</b></div>'
    + '<script data-bento-preview="1">/* remover */</script></html>'
  const meta = await describe({ base: 'Q3', folder: 'D', rel: ['Q3.bento.html'],
    handle: fileHandle('Q3.bento.html', withPreview) } as any, noCache)
  ok(meta.title === 'Q3 Board Review', 'the title is read out of the document block')
  ok(meta.preview === '<div data-bento-preview="1"><b>page one</b></div>',
    'the preview block is extracted whole, and stops before the script that removes it')
  ok(!meta.preview!.includes('<script'),
    'no script comes with it — the thumbnail renders inert in a sandboxed frame')
}
{
  // The remover script MUST NOT be included: it deletes the very element we are
  // about to render, so a sloppy boundary produces a blank thumbnail that looks
  // like a rendering bug rather than a parsing one.
  const meta = await describe({ base: 'X', folder: 'D', rel: ['X.bento.html'],
    handle: fileHandle('X.bento.html', '<div data-bento-preview="1">hi</div>') } as any, noCache)
  ok(meta.preview === null,
    'a preview with no closing marker is refused rather than run past the end of the file')
}
{
  const enc = '<script id="bento-doc" type="application/json">{"format":"bento/enc","v":1}</script>'
  const meta = await describe({ base: 'Locked', folder: 'D', rel: ['Locked.bento.html'],
    handle: fileHandle('Locked.bento.html', enc) } as any, noCache)
  ok(meta.encrypted === true, 'an encrypted document is recognised')
  ok(meta.preview === null,
    'and gets NO preview — a plaintext title page beside the ciphertext is the leak the password prevents')
  ok(meta.title === 'Locked', 'falling back to the file name, since there is no readable title')
}
{
  const meta = await describe({ base: 'Plain', folder: 'D', rel: ['Plain.bento.html'],
    handle: fileHandle('Plain.bento.html', '<html>nothing here</html>') } as any, noCache)
  ok(meta.title === 'Plain', 'a document with no title falls back to its file name rather than blank')
}
{
  // The cache is keyed on size and mtime, so an edited document must re-read.
  const calls: string[] = []
  const cache = new Map<string, any>()
  const deps = {
    get: async (k: string) => { calls.push(`get ${k}`); return cache.get(k) ?? null },
    put: async (k: string, v: any) => { cache.set(k, v) },
  }
  const body = '<script id="bento-doc">{"title":"One"}</script>'
  const d1 = { base: 'C', folder: 'D', rel: ['C.bento.html'], handle: fileHandle('C.bento.html', body, 1) }
  await describe(d1 as any, deps)
  const again = await describe(d1 as any, deps)
  ok(again.title === 'One' && cache.size === 1, 'an unchanged document is served from cache')
  const d2 = { ...d1, handle: fileHandle('C.bento.html', '<script id="bento-doc">{"title":"Two"}</script>', 2) }
  const edited = await describe(d2 as any, deps)
  ok(edited.title === 'Two' && cache.size === 2,
    'an edited document re-reads — the key carries size and mtime, so nothing needs invalidating by hand')
}

// ---- 4. new document --------------------------------------------------------
const fakeNet = (version = '1.0.17', html = '<html>shell</html>') => async (url: string) => ({
  ok: true,
  async json() { return { version, url: 'https://bento.page/releases/slides/Bento_Slides.bento.html' } },
  async text() { return html },
  url,
})
{
  written.clear()
  const tree: Record<string, any> = {}
  const dir = dirHandle('Decks', tree)
  const made = await newDocument(dir as any, 'Untitled', { fetch: fakeNet() })
  ok(made.name === 'Untitled.bento.html', 'the first new document is Untitled.bento.html')
  ok(written.get('Untitled.bento.html') === '<html>shell</html>',
    'and carries the downloaded release, so it is the same version everyone else has')
}
{
  written.clear()
  const tree: Record<string, any> = { 'Untitled.bento.html': fileHandle('Untitled.bento.html') }
  const dir = dirHandle('Decks', tree)
  const made = await newDocument(dir as any, 'Untitled', { fetch: fakeNet() })
  // UIKit's own de-duplicator produces "Untitled.bento 2.html" here, because it
  // reads `.bento.html` as the name "Untitled.bento" plus extension "html" and
  // counts before the LAST extension only. tray/ios had to write its own for
  // exactly this; so does this.
  ok(made.name === 'Untitled 2.bento.html',
    `a second document counts on the base name, not inside the extension (${made.name})`)
  ok(!/\.bento \d/.test(made.name), 'never "Untitled.bento 2.html" — the double extension trap')
}
{
  const dir = dirHandle('Decks', {})
  let threw = ''
  await newDocument(dir as any, 'X', { fetch: async () => ({ ok: false, status: 503 }) })
    .catch((e: any) => { threw = e.message })
  ok(/release server/.test(threw), `an unreachable release server is reported, not silent (${threw})`)
}
{
  const dir = dirHandle('Decks', {})
  let threw = ''
  await newDocument(dir as any, 'X', {
    fetch: async () => ({ ok: true, async json() { return {} } }),
  }).catch((e: any) => { threw = e.message })
  ok(/did not offer a build/.test(threw), 'a manifest with no build is reported rather than written as empty')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
