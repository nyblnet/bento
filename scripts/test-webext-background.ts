#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext background rig.
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

import { readFileSync } from 'node:fs'
import { pathFromSender, findByName, claim, write, resolve, backup, backupNameFor } from '../home/webext/src/background.js'

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
    /** Identity, not equality: the real API answers "same file on disk?", which
     *  is how one file reached through two nested grants is told apart from two
     *  different files that merely share a name. */
    async isSameEntry(other: any) { return other === this || other?.__id === (this as any).__id },
    async createWritable() {
      let buf = ''
      return {
        async write(t: string) { buf += t },
        async close() { written.set(name, buf) },
      }
    },
  }
}

// `base` is where this directory sits BELOW the grant root, which is what
// resolve() reports. `rootName` is the grant's own folder name — the thing
// locateIn matches against the sender's path, and the two are independent: a
// grant named "Documents" has base [] and still has a name.
function dirHandle(tree: Record<string, any>, perm = 'granted', base: string[] = [], rootName = 'Decks') {
  return {
    kind: 'directory' as const,
    name: base.at(-1) ?? rootName,
    async queryPermission() { return perm },
    /** The real API: path segments from THIS directory down to `child`, or null. */
    async resolve(child: any) {
      const rel = child?.__rel
      if (!rel) return null
      // only children at or below this directory resolve
      return base.every((seg, i) => rel[i] === seg) ? rel.slice(base.length) : null
    },
    /** Real API: throws NotFoundError when absent, which `backup` relies on. */
    async getDirectoryHandle(name: string) {
      const v = tree[name]
      if (!v || v.kind) throw Object.assign(new Error(name), { name: 'NotFoundError' })
      return dirHandle(v, perm, [...base, name])
    },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      const v = tree[name]
      if (v && v.kind === 'file') return v
      if (!opts?.create) throw Object.assign(new Error(name), { name: 'NotFoundError' })
      const h = fileHandle(name, [...base, name])
      tree[name] = h
      return h
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
  readGrants: async () => [dirHandle(tree, perm)],
  findByName,
})

/** Several granted folders at once, each with its own permission state. */
const multiDeps = (...grants: Array<{ tree: Record<string, any>; perm?: string; name?: string }>) => ({
  readGrants: async () => grants.map((g) => dirHandle(g.tree, g.perm ?? 'granted', g.name ? [g.name] : [])),
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
  // the same name in two subfolders — the case a real Decks folder hits.
  //
  // THIS USED TO DECLINE, and the decline was a limitation, not a safety
  // property: the old code searched by filename, found both, and could not tell
  // which one the sender was. Routing by path reaches exactly one, because only
  // one route leads to it — and the identity check still verifies what it
  // landed on. Anyone with client folders hit this on every save.
  const tree = {
    ClientA: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['ClientA', 'Q3.bento.html']) },
    ClientB: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['ClientB', 'Q3.bento.html']) },
  }
  const a = await resolve(senderFor('/Users/x/Decks/ClientA/Q3.bento.html'), deps(tree))
  ok(a.ok === true && a.within === '/ClientA/Q3.bento.html',
    'two decks sharing a name both save — each to its own file, not declined')
  const b = await resolve(senderFor('/Users/x/Decks/ClientB/Q3.bento.html'), deps(tree))
  ok(b.ok === true && b.within === '/ClientB/Q3.bento.html',
    'and the other one resolves to the other file')
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

// ---- 6. the backup op ------------------------------------------------------
// This is the only op that CREATES a file, so it is the only one where the page
// contributes to a name. Everything below is about keeping that contribution
// from meaning anything: the name must be visibly derived from the sender's own
// file, and an existing file is never replaced.
{
  const own = 'Q3.bento.html'
  ok(backupNameFor(own, 'Q3.v1.0.16-backup.bento.html') === 'Q3.v1.0.16-backup.bento.html',
    'the ordinary backup name is accepted')
  for (const [bad, why] of [
    ['../../../etc/passwd', 'a traversal'],
    ['/etc/Q3.bento.html', 'an absolute path'],
    ['Q3/x.bento.html', 'a subdirectory'],
    ['Q3.bento.html', 'the original itself'],
    ['Other.v1-backup.bento.html', 'a name derived from a DIFFERENT file'],
    ['Q3.v1-backup.txt', 'a non-document extension'],
    ['Q3.v1 backup.bento.html', 'a name with a space'],
    ['Q3.\u0000.bento.html', 'an embedded NUL'],
  ] as const) {
    ok(backupNameFor(own, bad) === null, `${why} is refused (${JSON.stringify(bad)})`)
  }
  ok(backupNameFor(own, `Q3.${'x'.repeat(200)}.bento.html`) === null,
    'an absurdly long name is refused')
  ok(backupNameFor(own, undefined as any) === null, 'a missing name is refused')
}
{
  written.clear()
  const tree: Record<string, any> = { 'Q3.bento.html': fileHandle('Q3.bento.html') }
  const r = await backup(senderFor('/Users/x/Decks/Q3.bento.html'), 'old bytes',
    'Q3.v1.0.16-backup.bento.html', deps(tree))
  ok(r.ok === true, 'a backup beside the sender\'s own file is written')
  ok(written.get('Q3.v1.0.16-backup.bento.html') === 'old bytes', 'and carries the old version')
  ok(written.get('Q3.bento.html') === undefined, 'and the original is untouched')
}
{
  // create-only: the second update of the same version must not clobber
  written.clear()
  const tree: Record<string, any> = {
    'Q3.bento.html': fileHandle('Q3.bento.html'),
    'Q3.v1.0.16-backup.bento.html': fileHandle('Q3.v1.0.16-backup.bento.html'),
  }
  const r = await backup(senderFor('/Users/x/Decks/Q3.bento.html'), 'new bytes',
    'Q3.v1.0.16-backup.bento.html', deps(tree))
  ok(r.ok === false && /already exists/.test(r.reason!),
    'an existing file is never overwritten by a backup')
  ok(written.size === 0, 'and nothing was written')
}
{
  // the backup lands in the sender's OWN subfolder, not the grant root
  written.clear()
  const tree: Record<string, any> = {
    Clients: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Clients', 'Q3.bento.html']) },
  }
  const r = await backup(senderFor('/Users/x/Decks/Clients/Q3.bento.html'), 'old bytes',
    'Q3.v1.0.16-backup.bento.html', deps(tree))
  ok(r.ok === true, 'a nested document backs up successfully')
  ok(tree.Clients['Q3.v1.0.16-backup.bento.html'] !== undefined,
    'and the backup sits beside it, not at the grant root')
  ok(tree['Q3.v1.0.16-backup.bento.html'] === undefined, 'the grant root is untouched')
}
{
  // every refusal that applies to a write applies here too — this op resolves
  // through exactly the same gate, and must not have grown a way around it
  written.clear()
  const tree: Record<string, any> = {
    Clients: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Clients', 'Q3.bento.html']) },
  }
  const r = await backup(senderFor('/Users/x/Desktop/Q3.bento.html'), 'attacker bytes',
    'Q3.v1-backup.bento.html', deps(tree))
  ok(r.ok === false, 'a backup from a same-named file elsewhere is refused')
  ok(written.size === 0, 'and nothing was written')
}
{
  written.clear()
  const r = await backup({ url: 'https://evil.example/Q3.bento.html' }, 'x',
    'Q3.v1-backup.bento.html', deps({ 'Q3.bento.html': fileHandle('Q3.bento.html') }))
  ok(r.ok === false && /not a local file/.test(r.reason!), 'an http page cannot create a backup')
  ok(written.size === 0, 'and nothing was written')
}

// ---- 7. several granted folders --------------------------------------------
// One folder was never the shape of anyone's work: decks live under clients,
// under projects, on the Desktop. What matters is that adding folders does not
// weaken the identity guarantee — every grant is tried, and the winner is still
// verified against the sender's own path.
{
  const decks = { 'Q3.bento.html': fileHandle('Q3.bento.html') }
  const work = { 'Plan.bento.html': fileHandle('Plan.bento.html') }
  const r = await resolve(senderFor('/Users/x/Decks/Q3.bento.html'),
    multiDeps({ tree: decks }, { tree: work }))
  ok(r.ok === true && r.name === 'Q3.bento.html', 'a file in the FIRST granted folder resolves')
}
{
  // a second folder with its own name — the ordinary two-folder case
  const decks = { 'Q3.bento.html': fileHandle('Q3.bento.html') }
  const work = { 'Plan.bento.html': fileHandle('Plan.bento.html') }
  const grants = {
    readGrants: async () => [dirHandle(decks, 'granted', [], 'Decks'), dirHandle(work, 'granted', [], 'Work')],
    findByName,
  }
  const r = await resolve(senderFor('/Users/x/Work/Plan.bento.html'), grants)
  ok(r.ok === true && r.name === 'Plan.bento.html', 'a file in the SECOND granted folder resolves')
  const miss = await resolve(senderFor('/Users/x/Elsewhere/Other.bento.html'), grants)
  ok(miss.ok === false && /not in the granted folder/.test(miss.reason!),
    'a file in neither folder is still declined')
}
{
  // ONE lapsed grant must not mask the others — the failure that would make
  // adding a folder look like breaking the extension
  const decks = { 'Q3.bento.html': fileHandle('Q3.bento.html') }
  const work = { 'Plan.bento.html': fileHandle('Plan.bento.html') }
  const grants = {
    readGrants: async () => [dirHandle(decks, 'prompt', [], 'Decks'), dirHandle(work, 'granted', [], 'Work')],
    findByName,
  }
  const good = await resolve(senderFor('/Users/x/Work/Plan.bento.html'), grants)
  ok(good.ok === true, 'a healthy grant still serves while another has lapsed')
  const bad = await resolve(senderFor('/Users/x/Decks/Q3.bento.html'), grants)
  ok(bad.ok === false && /renewing/.test(bad.reason!),
    'and a file in the lapsed one reports that it needs renewing, not that it is missing')
}
{
  // nested grants: the same file reached by two routes is ONE file, not an
  // ambiguity. isSameEntry is the only thing that can tell those apart.
  // ONE file on disk, seen through two grants — so it presents as two handles
  // with different relative paths but the same identity, which is exactly what
  // Chrome does here.
  const viaOuter = fileHandle('Q3.bento.html', ['Decks', 'Q3.bento.html'])
  ;(viaOuter as any).__id = 'same-file'
  const viaInner = fileHandle('Q3.bento.html')
  ;(viaInner as any).__id = 'same-file'
  const grants = {
    readGrants: async () => [
      dirHandle({ Decks: { 'Q3.bento.html': viaOuter } }, 'granted', [], 'Documents'),
      dirHandle({ 'Q3.bento.html': viaInner }, 'granted', [], 'Decks'),
    ],
    findByName,
  }
  const r = await resolve(senderFor('/Users/x/Documents/Decks/Q3.bento.html'), grants)
  ok(r.ok === true, 'a file inside two nested grants resolves rather than being called ambiguous')
}
{
  // and two genuinely DIFFERENT files reachable at the same path is the case
  // that must still decline
  const a = fileHandle('Q3.bento.html'); (a as any).__id = 'A'
  const b = fileHandle('Q3.bento.html'); (b as any).__id = 'B'
  const grants = {
    readGrants: async () => [
      dirHandle({ 'Q3.bento.html': a }, 'granted', [], 'Decks'),
      dirHandle({ 'Q3.bento.html': b }, 'granted', [], 'Decks'),
    ],
    findByName,
  }
  const r = await resolve(senderFor('/Users/x/Decks/Q3.bento.html'), grants)
  ok(r.ok === false && /ambiguous/.test(r.reason!),
    'two different files reachable by the same route are declined, not guessed at')
}
{
  // a grant with no folders at all
  const r = await resolve(senderFor('/Users/x/Decks/Q3.bento.html'), { readGrants: async () => [], findByName })
  ok(r.ok === false && /no folder granted/.test(r.reason!), 'no grants at all is reported as such')
}

// ---- 8. a big grant costs nothing to search --------------------------------
// The point of routing rather than walking: granting a home directory has to be
// as cheap as granting a decks folder, or "everywhere" is not offerable. This
// counts DIRECTORY ENUMERATIONS — the thing that made a large grant unusable.
{
  let enumerations = 0
  const wide: Record<string, any> = { Decks: { 'Q3.bento.html': fileHandle('Q3.bento.html', ['Decks', 'Q3.bento.html']) } }
  for (let i = 0; i < 500; i++) wide[`junk${i}`] = { [`f${i}.txt`]: fileHandle(`f${i}.txt`) }
  const counting = dirHandle(wide, 'granted', [], 'home')
  const origEntries = counting.entries.bind(counting)
  ;(counting as any).entries = async function* (...a: any[]) { enumerations++; yield* origEntries(...a) }
  const r = await resolve(senderFor('/Users/x/home/Decks/Q3.bento.html'),
    { readGrants: async () => [counting], findByName })
  ok(r.ok === true, 'a file inside a 500-entry grant resolves')
  ok(enumerations === 0, `and nothing was enumerated to find it (${enumerations} directory scans)`)
}

// ---- 9. the worker and the options page read the SAME store ----------------
// They open IndexedDB independently — the service worker cannot import the
// options page's module and vice versa — so the store name, the database name
// and the KEYS are duplicated in two files. If they drift, the options page
// writes grants the worker never sees: the UI says the folder is granted, every
// save falls back to a picker, and nothing anywhere reports a problem.
//
// Source-level, because the two halves cannot be loaded into one realm to be
// compared at runtime. A weak check on the real constants beats none.
{
  const read = (f: string) => readFileSync(new URL(`../home/webext/src/${f}`, import.meta.url), 'utf8')
  /** Source with comments removed, for gates that must not match documentation
   *  about the very thing they forbid. */
  const codeOf = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const bg = read('background.js')
  const st = read('status.js')
  const constOf = (src: string, name: string) => src.match(new RegExp(`const ${name} = '([^']+)'`))?.[1]

  // This used to compare duplicated DB/STORE constants between the two files.
  // They are gone: db.js owns the store and both halves import it. So the gate
  // becomes the stronger statement — the duplication must not come BACK.
  // A second `indexedDB.open` is how the split-brain returns, and its symptom
  // is the options page writing grants the worker never reads: UI green, every
  // save prompting, nothing reporting a fault.
  const db = read('db.js')
  ok(/indexedDB\.open/.test(db), 'db.js opens the database')
  ok(!/indexedDB\.open/.test(bg) && !/indexedDB\.open/.test(st),
    'and nothing else does — one module owns the store')
  ok(/from '\.\/db\.js'/.test(st), 'status.js reads the store through it')
  ok(constOf(db, 'DB') === 'bento-tray', `the database name is stable (${constOf(db, 'DB')})`)
  // Each key is named in the module that owns its meaning, not scattered:
  // the grant list is status.js's business, the path prefixes are db.js's.
  ok(st.includes("'dirs'") && st.includes("'dir'"),
    "status.js owns the grant keys, including the legacy 'dir' still migrated")
  ok(db.includes("'prefixes'"), "db.js owns the learned path prefixes")
  ok(/VERSION = 2/.test(db) && /objectStoreNames\.contains/.test(db),
    'the version bump for the cache store is guarded, so a v1 install upgrades rather than throwing')
}

// ---- 10. the lapsed-grant badge stays wired --------------------------------
// The badge is the only thing that reports a lapsed grant BEFORE a save falls
// back to a picker. It is pure wiring — no return value, nothing downstream
// reads it — so if the call is dropped nothing fails, and the symptom is
// silence: saves start prompting again with no indication why. Source-level,
// because chrome.action does not exist here.
{
  const read = (f: string) => readFileSync(new URL(`../home/webext/src/${f}`, import.meta.url), 'utf8')
  /** Source with comments stripped, for gates that must not match documentation
   *  about the very thing they forbid. */
  const codeOf = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const bg = read('background.js')
  const st = read('status.js')
  const pop = read('panel.js')

  ok(/export async function setLapsedBadge/.test(st), 'status.js owns the badge rule')
  ok(/setBadgeText/.test(st), 'and actually sets a badge')
  ok(bg.includes('setLapsedBadge'), 'the worker refreshes the badge after handling a message')
  ok(/onStartup/.test(bg), 'and on browser startup — where a dropped grant would first show')
  ok(!/setBadgeText/.test(bg) && !/setBadgeText/.test(pop),
    'only status.js decides what "lapsed" means — the icon and the panel cannot disagree')
  ok(/requestPermission/.test(pop),
    'the panel can raise the permission dialog itself, without a trip to settings')

  // The chicken-and-egg that shipped: the tray lists documents by walking
  // grants, but needs an absolute path to OPEN one, and that path was learned
  // only during a save. So a fresh install listed everything and could open
  // nothing. Opening a document is the natural moment to learn its folder.
  const relay = read('relay.js')
  ok(/op: 'hello'/.test(relay), 'the content script announces itself on load')
  ok(/'hello'/.test(bg) && /learnPrefix/.test(bg),
    'and the worker resolves it, which is what records where that folder lives')
  // The call itself, not the comment above it: the announcement must send only
  // an op. A payload here would be page-controlled data arriving at the code
  // that decides which file to write, which is the one thing this architecture
  // refuses — the path comes from sender.url, stamped by the browser.
  ok(/sendMessage\(\{\s*op:\s*'hello'\s*\}\)/.test(relay),
    'the announcement sends an op and nothing else — no page-controlled payload reaches the resolver')

  // The notification is the ACTIVE half of reporting a lapse — the badge only
  // reports to someone already looking at the toolbar. Same wiring risk: no
  // return value, nothing reads it, so a dropped call is silent.
  ok(/chrome\.notifications\?\.\.?create|chrome\.notifications\?\.create/.test(st)
    || /notifications\.create/.test(st), 'status.js can raise a notification')
  ok(bg.includes('reportLapsed') && /onStartup/.test(bg),
    'the worker reports a lapse on browser startup — before any save has failed')
  ok(/storage\?\.session|storage\.session/.test(st),
    'and only once per browser session, which is the lifetime of a lapse')
  ok(/onButtonClicked/.test(bg) && /onClicked/.test(bg),
    'both the notification body and its button lead somewhere')
  // There is no popup any more: the toolbar opens the library and the tray is a
  // side panel. A notification is handled after an await, which loses the user
  // gesture sidePanel.open() requires, so it leads to the library instead —
  // silently refused is the worst of both.
  // Against CODE, not prose. The comment above the function explains why the
  // call is gone and names it in full, so both "the word" and "call-shaped"
  // match the documentation — a gate that trips on its own explanation gets
  // deleted rather than fixed.
  ok(!/\.openPopup\s*\(/.test(codeOf(st)), 'nothing still calls chrome.action.openPopup')
  ok(/home\.html/.test(st), 'the notification leads to the library, which carries the same repair')

  const manifest = JSON.parse(readFileSync(new URL('../home/webext/manifest.json', import.meta.url), 'utf8'))
  ok(manifest.permissions?.includes('notifications'),
    'the manifest asks for the notifications permission the code depends on')
  // default_popup and onClicked are mutually exclusive: declaring a popup means
  // the click opens it and the listener never runs. The click must open the
  // library, so there must be no popup.
  ok(!manifest.action?.default_popup,
    'no default_popup, or chrome.action.onClicked would never fire')
  ok(manifest.side_panel?.default_path === 'src/panel.html',
    'the tray is declared as a side panel')
  ok(!!manifest.commands?.['open-panel']?.suggested_key,
    'and has a keyboard shortcut, which is the gesture sidePanel.open() needs')
  for (const perm of ['sidePanel', 'contextMenus']) {
    ok(manifest.permissions?.includes(perm), `the manifest asks for "${perm}"`)
  }
  ok(/onClicked/.test(bg) && /sidePanel\.open/.test(bg),
    'the worker opens the library on click and the panel on its own gestures')
  // sidePanel.open() must be called SYNCHRONOUSLY inside the gesture. An await
  // before it loses the gesture and Chrome refuses, without saying so.
  const cmd = bg.slice(bg.indexOf("command !== 'open-panel'"), bg.indexOf("command !== 'open-panel'") + 320)
  ok(!/await/.test(cmd), 'and does it synchronously — an await first loses the user gesture')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
