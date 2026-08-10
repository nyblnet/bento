#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// tray/webext background rig.
//
//   node scripts/test-webext-background.ts
//
// WHAT THIS PROVES. This is the half that WRITES, and it was the untested half:
// the bridge had 15 checks while the code putting bytes on disk had none. Two
// properties matter more than the rest, and neither is visible by reading a
// successful save.
//
//   1. THE PAGE DOES NOT CHOOSE THE FILE. The path comes from `sender.url`,
//      which the browser stamps, never from the message payload, which a local
//      HTML file controls. A document that could name its own target could name
//      the deck next to it in the granted folder and overwrite that instead.
//
//   2. NOTHING IS HELD BETWEEN MESSAGES. An MV3 service worker is evicted
//      whenever the browser likes, and a save serialises ~900KB first, so an
//      eviction between "which file?" and "write it" is ordinary. State carried
//      across that gap fails a save intermittently and reproduces on nobody's
//      machine. Every message re-resolves.
//
// Both are checked by construction here: a write is issued with no preceding
// claim at all, which is exactly what a service worker restart looks like.

import { pathFromSender, findByName, claim, write, resolve } from '../tray/webext/src/background.js'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ---- a fake granted folder --------------------------------------------------
const written = new Map<string, string>()

/**
 * A file in the fake grant. `rel` is its path RELATIVE to the granted folder,
 * which is what a real `FileSystemDirectoryHandle.resolve()` returns — and the
 * thing the identity check depends on.
 */
function fileHandle(name: string, rel?: string[]) {
  return {
    kind: 'file' as const,
    name,
    __rel: rel ?? [name],
    async createWritable() {
      let buf = ''
      return {
        async write(t: string) { buf += t },
        async close() { written.set(name, buf) },
      }
    },
  }
}

function dirHandle(tree: Record<string, any>, perm = 'granted', base: string[] = []) {
  return {
    kind: 'directory' as const,
    name: base.at(-1) ?? 'Decks',
    async queryPermission() { return perm },
    /** The real API: path segments from THIS directory down to `child`, or null. */
    async resolve(child: any) {
      const rel = child?.__rel
      if (!rel) return null
      // only children at or below this directory resolve
      return base.every((seg, i) => rel[i] === seg) ? rel.slice(base.length) : null
    },
    async *entries() {
      for (const [k, v] of Object.entries(tree)) {
        yield [k, typeof v === 'object' && !v.kind ? dirHandle(v, perm, [...base, k]) : v] as const
      }
    },
  }
}

const senderFor = (path: string) => ({ url: 'file://' + path })

// ---- 1. the path comes from the browser, not the page -----------------------
ok(pathFromSender({ url: 'file:///Users/x/Decks/Q3.bento.html' }) === '/Users/x/Decks/Q3.bento.html',
  'a file:// sender yields its path')
ok(pathFromSender({ url: 'https://evil.example/x.bento.html' }) === null,
  'an http sender is refused — the bridge is for local documents')
ok(pathFromSender({}) === null, 'a sender with no url is refused')
ok(pathFromSender({ url: 'file:///Users/x/My%20Decks/Q3.bento.html' }) === '/Users/x/My Decks/Q3.bento.html',
  'a percent-encoded path is decoded')

// ---- 2. resolution inside the grant ----------------------------------------
const deps = (tree: Record<string, any>, perm = 'granted') => ({
  readGrant: async () => dirHandle(tree, perm),
  findByName,
})

{
  const tree = { 'Q3.bento.html': fileHandle('Q3.bento.html'), 'notes.txt': fileHandle('notes.txt') }
  const r = await resolve(senderFor('/Users/x/Decks/Q3.bento.html'), deps(tree))
  ok(r.ok === true && r.name === 'Q3.bento.html', 'a unique file in the granted folder resolves')
}
{
  const tree = { 'Q3.bento.html': fileHandle('Q3.bento.html') }
  const r = await resolve(senderFor('/Users/x/Decks/Other.bento.html'), deps(tree))
  ok(r.ok === false && /not in the granted folder/.test(r.reason!),
    'a file outside the grant is declined, not guessed at')
}
{
  // the same name in two subfolders — the case a real Decks folder hits
  const tree = {
    ClientA: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['ClientA', 'Q3.bento.html']) },
    ClientB: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['ClientB', 'Q3.bento.html']) },
  }
  const r = await resolve(senderFor('/Users/x/Decks/ClientA/Q3.bento.html'), deps(tree))
  ok(r.ok === false && /ambiguous/.test(r.reason!),
    'a duplicate file name is declined rather than written to the wrong one')
}
{
  const tree = { 'Q3.bento.html': fileHandle('Q3.bento.html') }
  const r = await resolve(senderFor('/Users/x/Decks/Q3.bento.html'), deps(tree, 'prompt'))
  ok(r.ok === false && /renewing/.test(r.reason!),
    'a lapsed folder grant is reported, never silently prompted for')
}
{
  const r = await resolve({ url: 'https://evil.example/Q3.bento.html' },
    deps({ 'Q3.bento.html': fileHandle('Q3.bento.html') }))
  ok(r.ok === false && /not a local file/.test(r.reason!),
    'an http page cannot resolve a file in the granted folder')
}

// ---- 2b. a NAME match is not an IDENTITY match ------------------------------
// The bug this rig did not previously cover, and it destroyed files with no
// attacker involved: the grant holds Clients/Q3.bento.html, the user opens a
// working copy at ~/Desktop/Q3.bento.html, and exactly one hit is found —
// because the sender's own copy is outside the grant and so is not a second
// hit. Writing that hit puts the Desktop deck's bytes over the Clients file and
// never writes the file being edited.
{
  const tree = { Clients: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Clients', 'Q3.bento.html']) } }
  const r = await resolve(senderFor('/Users/x/Desktop/Q3.bento.html'), deps(tree))
  ok(r.ok === false && /different file/.test(r.reason ?? ''),
    'a same-named file elsewhere in the grant is NOT treated as the sender\'s file')
}
{
  // and the legitimate nested case still resolves
  const tree = { Clients: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Clients', 'Q3.bento.html']) } }
  const r = await resolve(senderFor('/Users/x/Decks/Clients/Q3.bento.html'), deps(tree))
  ok(r.ok === true, 'the sender\'s own file in a subfolder still resolves')
}
{
  // a candidate the directory refuses to resolve is refused here too
  const orphan = fileHandle('Q3.bento.html')
  ;(orphan as any).__rel = null
  const r = await resolve(senderFor('/Users/x/Decks/Q3.bento.html'), deps({ 'Q3.bento.html': orphan }))
  ok(r.ok === false && /not inside the granted folder/.test(r.reason ?? ''),
    'a candidate that does not resolve inside the grant is declined')
}
{
  // a write must be refused for the same reason, not only a claim
  written.clear()
  const tree = { Clients: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Clients', 'Q3.bento.html']) } }
  const r = await write(senderFor('/Users/x/Desktop/Q3.bento.html'), 'attacker bytes', deps(tree))
  ok(r.ok === false, 'a write to a same-named file elsewhere is refused')
  ok(written.size === 0, 'and nothing was written')
}

// ---- 3. a write needs no prior claim (service-worker eviction) --------------
{
  written.clear()
  const tree = { 'Q3.bento.html': fileHandle('Q3.bento.html') }
  // NO claim() first — this is precisely what a restarted service worker sees.
  const r = await write(senderFor('/Users/x/Decks/Q3.bento.html'), '<html>deck</html>', deps(tree))
  ok(r.ok === true && r.bytes === 17, 'a write with no preceding claim succeeds — no state is carried')
  ok(written.get('Q3.bento.html') === '<html>deck</html>', 'and the bytes land in the right file')
}

// ---- 4. claim reports without writing --------------------------------------
{
  written.clear()
  const tree = { 'Q3.bento.html': fileHandle('Q3.bento.html') }
  const r = await claim(senderFor('/Users/x/Decks/Q3.bento.html'), deps(tree))
  ok(r.ok === true && r.name === 'Q3.bento.html', 'claim reports the file it would write')
  ok(written.size === 0, 'and writes nothing while doing so')
}

// ---- 5. the depth limit ----------------------------------------------------
{
  // 6 levels deep — past the limit, so it must NOT be found rather than hang
  let deep: any = { 'Q3.bento.html': fileHandle('Q3.bento.html', ['sub','sub','sub','sub','sub','sub','Q3.bento.html']) }
  for (let i = 0; i < 6; i++) deep = { sub: deep }
  const r = await resolve(senderFor('/Users/x/Decks/Q3.bento.html'), deps(deep))
  ok(r.ok === false, 'a file buried past the depth limit is declined, not searched forever')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
