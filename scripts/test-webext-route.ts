#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext route rig.
//
//   node scripts/test-webext-route.ts
//
// WHAT THIS PROVES. `prefixFor` turns "an absolute path" into "where this
// granted folder lives", and that answer is then used to build the URLs the
// tray opens. It is fed by browser HISTORY — paths the extension did not
// choose, for files that may have moved, been deleted, or never been in a
// granted folder at all.
//
// So the only property that matters is that it PROVES rather than guesses. A
// path is accepted only when the route resolves inside the grant AND
// `dir.resolve()` on what it lands on agrees with the path's own tail. The
// failure mode of getting this wrong is not a broken link: it is a folder
// recorded at the wrong location, and every document in it opening something
// else.

import { pathFromSender, locateIn, prefixFor } from '../home/webext/src/route.js'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

function fileHandle(name: string, rel: string[]) {
  return { kind: 'file' as const, name, __rel: rel }
}
function dirHandle(name: string, tree: Record<string, any>, base: string[] = []) {
  return {
    kind: 'directory' as const,
    name: base.at(-1) ?? name,
    async resolve(child: any) {
      const rel = child?.__rel
      if (!rel) return null
      return base.every((seg, i) => rel[i] === seg) ? rel.slice(base.length) : null
    },
    async getDirectoryHandle(n: string) {
      const v = tree[n]
      if (!v || v.kind) throw Object.assign(new Error(n), { name: 'NotFoundError' })
      return dirHandle(name, v, [...base, n])
    },
    async getFileHandle(n: string) {
      const v = tree[n]
      if (v && v.kind === 'file') return v
      throw Object.assign(new Error(n), { name: 'NotFoundError' })
    },
  }
}

// ---- the sender's path ------------------------------------------------------
ok(pathFromSender({ url: 'file:///Users/x/Decks/Q3.bento.html' }) === '/Users/x/Decks/Q3.bento.html',
  'a file:// sender yields its path')
ok(pathFromSender({ url: 'https://evil.example/x.bento.html' }) === null,
  'an http sender is refused — the bridge is for local documents')
ok(pathFromSender({ url: 'file:///Users/x/My%20Decks/Q3.bento.html' }) === '/Users/x/My Decks/Q3.bento.html',
  'a percent-encoded path is decoded')

// ---- placing a path ---------------------------------------------------------
{
  const dir = dirHandle('Decks', { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Q3.bento.html']) })
  const p = await prefixFor(dir, '/Users/andy/Work/Decks/Q3.bento.html')
  ok(p === '/Users/andy/Work/Decks', `a document at the grant root places the folder (${p})`)
}
{
  const dir = dirHandle('Decks', {
    Clients: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Clients', 'Q3.bento.html']) },
  })
  const p = await prefixFor(dir, '/Users/andy/Decks/Clients/Q3.bento.html')
  ok(p === '/Users/andy/Decks', `a nested document places the folder, not its subfolder (${p})`)
}
{
  // The grant's name repeating in the path. Both split points are tried, and
  // only the one that actually resolves is taken.
  const dir = dirHandle('Decks', {
    Decks: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Decks', 'Q3.bento.html']) },
  })
  const p = await prefixFor(dir, '/Users/andy/Decks/Decks/Q3.bento.html')
  ok(p === '/Users/andy/Decks', `a repeated folder name resolves to the route that exists (${p})`)
}

// ---- what must be REFUSED ---------------------------------------------------
// History is full of paths that are nothing to do with a grant. Every one of
// these would, if accepted, record a folder at the wrong place — and then every
// document in it opens the wrong file, silently.
{
  const dir = dirHandle('Decks', { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Q3.bento.html']) })
  ok(await prefixFor(dir, '/Users/andy/Elsewhere/Q3.bento.html') === null,
    'a path whose folder name does not appear is refused')
  ok(await prefixFor(dir, '/Users/andy/Decks/Missing.bento.html') === null,
    'a document that is not in the grant is refused, even under the right folder name')
  ok(await prefixFor(dir, '/Users/andy/Decks/Sub/Q3.bento.html') === null,
    'a route through a directory that does not exist is refused')
  ok(await prefixFor(dir, '/Q3.bento.html') === null,
    'a path with no folder segment at all is refused')
}
{
  // The case that has destroyed a document before: same NAME, different FILE.
  // `dir.resolve` reports where the candidate really sits, and it must agree
  // with the path's own tail.
  const dir = dirHandle('Decks', {
    Clients: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Clients', 'Q3.bento.html']) },
  })
  // A history entry for a DIFFERENT Q3 at the grant root — the grant has no such
  // file, only Clients/Q3, so nothing may be learned from it.
  ok(await prefixFor(dir, '/Users/andy/Decks/Q3.bento.html') === null,
    'a same-named file at a different depth teaches nothing — resolve() must agree with the tail')
}
{
  // A handle the directory refuses to resolve (outside it) must not be trusted
  // even though the route reached something.
  const orphan: any = fileHandle('Q3.bento.html', ['Q3.bento.html'])
  orphan.__rel = null
  const dir = dirHandle('Decks', { 'Q3.bento.html': orphan })
  ok(await prefixFor(dir, '/Users/andy/Decks/Q3.bento.html') === null,
    'a candidate the grant will not resolve is refused')
}

// ---- locateIn does not enumerate -------------------------------------------
// The whole reason the route exists: a grant may be a home directory, and
// placing a path must not walk it.
{
  const tree: Record<string, any> = { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Q3.bento.html']) }
  for (let i = 0; i < 500; i++) tree[`junk${i}`] = { x: fileHandle('x', ['x']) }
  const dir: any = dirHandle('home', tree)
  let enumerated = 0
  dir.entries = async function* () { enumerated++ }
  const hits = await locateIn(dir, '/Users/andy/home/Q3.bento.html')
  ok(hits.length === 1, 'the route finds the file inside a 500-entry grant')
  ok(enumerated === 0, `and enumerates nothing to do it (${enumerated} scans)`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
