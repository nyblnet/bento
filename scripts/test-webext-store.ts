#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext DocStore rig.
//
//   node scripts/test-webext-store.ts
//
// WHAT THIS PROVES. A document's sidecar data (crash recovery and the collab
// member key — nothing else; version history lives in the file) is kept in the
// extension's origin, partitioned by the file path the BROWSER reports for the
// sender. One document can never read, list, overwrite or delete another's
// entries; nothing in the payload can name a different partition; bytes
// survive the base64 hop and the chunked path intact; a half-sent value is
// never visible. And for a MOVED file (security ruling 2026-10-10): its
// recovery follows only when the old path is gone as a grant sees it, the new
// file's #bento-doc hashes to what the extension last wrote, and the recovery
// is under a week old; it moves once; the member key never follows. Includes
// the ruling's two required mutations (drop the hash check; carry the member
// key), both red.
// The real store.js, background.js and relay.js run here.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { createHash } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'home/webext')
const st = await import('../home/webext/src/store.js')
const bg = await import('../home/webext/src/background.js')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** An ordered in-memory key/value store with the adapter's shape. */
function memory() {
  const m = new Map<string, any>()
  return {
    m,
    get: async (k: string) => (m.has(k) ? m.get(k) : null),
    put: async (k: string, v: any) => { m.set(k, v) },
    del: async (k: string) => { m.delete(k) },
    range: async (lo: string, hi: string) => [...m.entries()].filter(([k]) => k >= lo && k <= hi).sort(([a], [b]) => (a < b ? -1 : 1)),
  }
}
let clock = Date.UTC(2026, 9, 4)
let txn = 0
const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/** A store with no grants (nothing is ever "gone") and no readable files, unless a test says otherwise. */
const deps = (db = memory(), over: any = {}) => ({ db, now: () => clock, txid: () => `tx-${String(++txn).padStart(8, '0')}`, sha256, gone: async (_p: string) => 'unknown', fileBlockHash: async (_p: string) => null, ...over })

const A = { url: 'file:///Users/you/Decks/Q3.bento.html', frameId: 0 }
const B = { url: 'file:///Users/you/Decks/Other.bento.html', frameId: 0 }
const enc = (s: string) => st.toB64(new TextEncoder().encode(s))
const dec = (b: string) => new TextDecoder().decode(st.fromB64(b))

console.log('\n— partitions: the sender\'s path, never the payload\'s')
{
  const d = deps()
  ok((await bg.storeOp('store.set', A, { name: 'recovery', data: enc('A-recovery') }, d)).ok, 'set from A')
  ok((await bg.storeOp('store.set', B, { name: 'recovery', data: enc('B-recovery') }, d)).ok, 'set from B, same name')
  const ga = await bg.storeOp('store.get', A, { name: 'recovery' }, d)
  const gb = await bg.storeOp('store.get', B, { name: 'recovery' }, d)
  ok(dec(ga.inline) === 'A-recovery' && dec(gb.inline) === 'B-recovery', 'each document reads only its own value under the same name')
  ok((await bg.storeOp('store.list', A, { prefix: '' }, d)).names.join() === 'recovery', 'list sees only the sender\'s partition')
  // the payload cannot redirect: extra fields naming a path are ignored
  await bg.storeOp('store.set', A, { name: 'recovery', data: enc('evil'), path: '/Users/you/Decks/Other.bento.html', url: B.url }, d)
  ok(dec((await bg.storeOp('store.get', B, { name: 'recovery' }, d)).inline) === 'B-recovery', 'a payload naming another path changes nothing there')
  await bg.storeOp('store.delete', A, { name: 'recovery' }, d)
  ok((await bg.storeOp('store.get', B, { name: 'recovery' }, d)).found === true, 'A deleting its entry leaves B\'s')
  for (const [label, s] of [['a sub-frame', { ...A, frameId: 2 }], ['an https page', { url: 'https://bento.page/slides/', frameId: 0 }], ['no sender', undefined]] as const) {
    const r = await bg.storeOp('store.get', s, { name: 'recovery' }, d)
    ok(!r.ok && r.reason === 'not a document', `${label} has no partition`)
  }
  for (const n of ['../x', 'a\u0000b', 'ver/0001', 'recovery/x', 'Recovery', 'other'])
    ok((await bg.storeOp('store.set', A, { name: n, data: enc('x') }, d)).reason === 'bad request' && (await bg.storeOp('store.get', A, { name: n }, d)).reason === 'bad name', `name ${JSON.stringify(n)} refused — only ${st.NAMES.join(' and ')} (version history lives in the file)`)
  ok((await bg.storeOp('store.list', A, { prefix: 'x\u0000' }, d)).reason === 'bad prefix', 'a list prefix cannot carry the key separator')
  ok((await bg.storeOp('store.nope', A, {}, d)).ok === false, 'an unknown store op is refused')
}

console.log('\n— chunked values: committed whole or not at all')
{
  const d = deps()
  const tx = 'tx-chunked-1'
  await bg.storeOp('store.put', A, { name: 'recovery', tx, i: 0, data: enc('part0-') }, d)
  ok((await bg.storeOp('store.get', A, { name: 'recovery' }, d)).found === false, 'before commit, nothing is visible')
  ok((await bg.storeOp('store.commit', A, { name: 'recovery', tx, n: 2 }, d)).reason === 'incomplete', 'a commit with a chunk missing is refused')
  await bg.storeOp('store.put', A, { name: 'recovery', tx, i: 1, data: enc('part1') }, d)
  ok((await bg.storeOp('store.commit', A, { name: 'recovery', tx, n: 2 }, d)).ok, 'all chunks present → committed')
  const m = await bg.storeOp('store.get', A, { name: 'recovery' }, d)
  const parts = [await bg.storeOp('store.chunk', A, { name: 'recovery', tx: m.tx, i: 0 }, d), await bg.storeOp('store.chunk', A, { name: 'recovery', tx: m.tx, i: 1 }, d)]
  ok(m.n === 2 && m.size === 11 && parts.map((p: any) => dec(p.data)).join('') === 'part0-part1', 'read back chunk by chunk, size exact')
  ok((await bg.storeOp('store.chunk', B, { name: 'recovery', tx: m.tx, i: 0 }, d)).reason === 'gone', 'another document cannot read A\'s chunks even with the tx id')
  // replacing the value retires the old chunks
  await bg.storeOp('store.set', A, { name: 'recovery', data: enc('new') }, d)
  ok(![...d.db.m.keys()].some((k) => k.includes(m.tx)), 'a replaced value leaves no chunks behind')
  ok((await bg.storeOp('store.put', A, { name: 'memberkey', tx, i: 0, data: st.toB64(new Uint8Array(st.CHUNK + 1)) }, d)).reason === 'chunk too large', 'a chunk over CHUNK is refused')
}

console.log('\n— the sweep')
{
  const DAY = 24 * 3600 * 1000
  const d = deps(memory(), { gone: async (p: string) => (p.endsWith('Other.bento.html') || p.endsWith('Recent.bento.html') ? 'gone' : 'unknown') })
  await bg.storeOp('store.set', A, { name: 'recovery', data: enc('r') }, d)
  clock -= 10 * DAY
  await bg.storeOp('store.set', B, { name: 'recovery', data: enc('b') }, d)           // gone, recovery 10 days old
  clock += 8 * DAY
  const R = { url: 'file:///Users/you/Decks/Recent.bento.html', frameId: 0 }
  await bg.storeOp('store.set', R, { name: 'recovery', data: enc('r2') }, d)          // gone, recovery 2 days old
  const C = { url: 'file:///Users/you/Old/C.bento.html', frameId: 0 }
  clock -= 40 * DAY
  await bg.storeOp('store.set', C, { name: 'recovery', data: enc('c') }, d)           // untouched 40 days
  await bg.storeOp('store.put', A, { name: 'recovery', tx: 'tx-abandoned', i: 0, data: enc('half') }, d)
  clock += 42 * DAY
  const dropped = await st.gc(d)
  ok(dropped.some((x: any) => x.path.endsWith('Other.bento.html') && x.why === 'gone'), 'a gone file whose recovery is too old to carry is dropped')
  ok(!dropped.some((x: any) => x.path.endsWith('Recent.bento.html')), `a gone file whose recovery could still carry (< ${st.CARRY_DAYS} days) is kept`)
  ok(dropped.some((x: any) => x.path.endsWith('C.bento.html') && x.why === 'age'), `a partition untouched for ${st.MAX_AGE_DAYS} days is dropped`)
  ok(!dropped.some((x: any) => x.path.endsWith('Q3.bento.html')), '"unknown" (no grant covers it) is never treated as gone')
  ok(![...d.db.m.keys()].some((k) => k.includes('tx-abandoned')), 'a transfer that never committed is swept')
}

console.log('\n— a moved file: what follows it, and what never does (security ruling 2026-10-10)')
{
  const DAY = 24 * 3600 * 1000
  const OLD = '/Users/you/Decks/Q3.bento.html'
  const NEW = '/Users/you/Archive/Q3 final.bento.html'
  const NEWs = { url: 'file:///Users/you/Archive/Q3%20final.bento.html', frameId: 0 }
  const saved = '<!doctype html><script type="application/json" id="bento-doc">{"docId":"V",\n"title":"Q3"}</' + 'script><p>shell</p>'
  // the same document with CRLF line endings INSIDE the block (where trim cannot hide them)
  const savedCRLF = saved.replace(',\n"title"', ',\r\n"title"')
  /** V: saved once by the extension, then edited (recovery), with a member key; a world where OLD is `oldState`. */
  const world = async (opts: { oldState?: string; newFile?: string; recoveryAge?: number } = {}) => {
    const files: Record<string, string> = { [NEW]: opts.newFile ?? saved }
    const d = deps(memory(), {
      gone: async (p: string) => (p === OLD ? (opts.oldState ?? 'gone') : 'unknown'),
      fileBlockHash: async (p: string) => (files[p] ? st.blockHash(files[p], { sha256 }) : null),
    })
    clock -= (opts.recoveryAge ?? 1) * DAY
    await st.recordSaved(OLD, saved, d)
    await bg.storeOp('store.set', A, { name: 'recovery', data: enc('UNSAVED DELTA') }, d)
    await bg.storeOp('store.set', A, { name: 'memberkey', data: enc('V-MEMBER-KEY') }, d)
    clock += (opts.recoveryAge ?? 1) * DAY
    return d
  }
  const at = async (d: any, s: any, name: string) => { const r = await bg.storeOp('store.get', s, { name }, d); return r.found ? dec(r.inline) : null }

  {
    const d = await world()
    ok(await at(d, NEWs, 'recovery') === 'UNSAVED DELTA', 'the same saved file, moved (old path gone, block hash equal): its recovery follows')
    ok(await at(d, NEWs, 'memberkey') === null, 'the member key does NOT follow — the moved file re-enrols through its own invite chain')
    ok(!(await d.db.get(`m\u0000${OLD}\u0000recovery`)) && !(await d.db.get(`h\u0000${OLD}`)), 'carried once: the old record itself is gone (moved, not copied), so two files can never both claim it')
    ok((await d.db.get(`x\u0000${NEW}`))?.from === OLD, 'the carry is noted against the new path (for the restore prompt)')
  }
  {
    const d = await world({ newFile: saved.replace('"title":"Q3"', '"title":"Q3, edited elsewhere"') })
    ok(await at(d, NEWs, 'recovery') === null && await at(d, A, 'recovery') === 'UNSAVED DELTA', 'a hostile or edited file with the same docId, old path gone, different content: nothing carries')
    ok(await at(d, NEWs, 'memberkey') === null, 'and the member key never moves')
  }
  {
    const d = await world({ oldState: 'present' })
    ok(await at(d, NEWs, 'recovery') === null, 'old path still present (a copy, not a move): nothing carries')
  }
  {
    const d = await world({ oldState: 'unknown' })
    ok(await at(d, NEWs, 'recovery') === null, 'old path not checkable through a grant: nothing carries')
  }
  {
    const d = await world({ recoveryAge: st.CARRY_DAYS + 1 })
    ok(await at(d, NEWs, 'recovery') === null, `a recovery older than ${st.CARRY_DAYS} days never carries`)
  }
  {
    const d = await world({ newFile: savedCRLF })
    ok(await at(d, NEWs, 'recovery') === 'UNSAVED DELTA', 'CRLF line endings do not make it a different document (kernel embeddedDocBlock rule)')
  }
  {
    // two gone partitions both match: ambiguous, so neither carries
    const d = await world()
    const OLD2 = '/Users/you/Decks/Q3 copy.bento.html'
    await st.recordSaved(OLD2, saved, d)
    await bg.storeOp('store.set', { url: 'file:///Users/you/Decks/Q3%20copy.bento.html', frameId: 0 }, { name: 'recovery', data: enc('OTHER') }, d)
    d.gone = async (p: string) => (p === OLD || p === OLD2 ? 'gone' : 'unknown')
    ok(await at(d, NEWs, 'recovery') === null, 'two moved copies both match: neither carries')
  }
  {
    // the page cannot vouch for its own content: only the extension's read of the file counts
    // everything else would carry; the new path already has an entry of its own
    const d = await world()
    await st.set(NEW, { name: 'memberkey', data: enc('NEW-OWN') }, d)
    ok(await at(d, NEWs, 'recovery') === null && await at(d, NEWs, 'memberkey') === 'NEW-OWN', 'a partition that already has entries never receives a carry')
  }
  {
    // the hash recorded is the bytes the extension WROTE
    const d = deps()
    await st.recordSaved(OLD, saved, d)
    ok((await d.db.get(`h\u0000${OLD}`))?.hash === createHash('sha256').update(st.docBlock(saved)!).digest('hex'), 'recordSaved stores sha-256 of the #bento-doc block of the bytes written')
    await st.recordSaved(OLD, '<p>no block</p>', d)
    ok(!(await d.db.get(`h\u0000${OLD}`)), 'a write with no block clears the record')
  }
  {
    // gone, as only a grant can see it
    const dir = (tree: any): any => ({ name: 'Decks', queryPermission: async () => 'granted',
      getDirectoryHandle: async (n: string) => { if (!tree[n] || typeof tree[n] !== 'object') { const e: any = new Error(); e.name = 'NotFoundError'; throw e } return dir(tree[n]) },
      getFileHandle: async (n: string) => { if (tree[n] !== 1) { const e: any = new Error(); e.name = 'NotFoundError'; throw e } return {} } })
    const g = [{ dir: dir({ 'Q3.bento.html': 1, Sub: {} }), prefix: '/Users/you/Decks' }]
    ok(await st.goneVia('/Users/you/Decks/Q3.bento.html', g) === 'present', 'goneVia: a file the grant reaches is present')
    ok(await st.goneVia('/Users/you/Decks/Old.bento.html', g) === 'gone' && await st.goneVia('/Users/you/Decks/Nope/x.bento.html', g) === 'gone', 'goneVia: a definite NotFound is gone')
    ok(await st.goneVia('/Users/you/Elsewhere/Q3.bento.html', g) === 'unknown', 'goneVia: outside every grant is unknown')
    const lapsed = [{ dir: { ...g[0].dir, queryPermission: async () => 'prompt' }, prefix: '/Users/you/Decks' }]
    ok(await st.goneVia('/Users/you/Decks/Old.bento.html', lapsed) === 'unknown', 'goneVia: a lapsed grant is unknown, not gone')
    const denied = [{ dir: { ...g[0].dir, getFileHandle: async () => { const e: any = new Error(); e.name = 'NotAllowedError'; throw e } }, prefix: '/Users/you/Decks' }]
    ok(await st.goneVia('/Users/you/Decks/Old.bento.html', denied) === 'unknown', 'goneVia: any error but NotFound is unknown')
  }
}

console.log('\n— the relay: bytes in, bytes out, chunked above CHUNK')
{
  const d = deps()
  const posted: any[] = []
  const listeners: any[] = []
  const win: any = { addEventListener: (_: string, f: any) => listeners.push(f), postMessage: (m: any) => posted.push(m) }
  let sent = 0
  const chrome = { runtime: { sendMessage: async (m: any) => { if (m.op === 'hello') return {}; sent++; return bg.storeOp(m.op, A, m.payload, d) } } }
  const ctx: any = createContext({ window: win, chrome, btoa, atob, crypto: { randomUUID: () => 'relay-tx-0001' }, Uint8Array, String, console })
  runInContext(readFileSync(join(SRC, 'src/relay.js'), 'utf8'), ctx)
  const CH = '__bento_tray__'
  const call = async (op: string, payload: any) => {
    const id = `s-${posted.length}-${Math.random()}`
    for (const f of listeners) f({ data: { [CH]: true, dir: 'req', id, op, payload }, source: win })
    for (let i = 0; i < 500 && !posted.some((p) => p.id === id); i++) await new Promise((r) => setTimeout(r, 0))
    return posted.find((p) => p.id === id).result
  }
  const small = new Uint8Array([0, 1, 2, 250, 255])
  ok((await call('store.set', { name: 'memberkey', bytes: new ctx.Uint8Array(small) })).ok, 'set small bytes through the relay')
  const back = await call('store.get', { name: 'memberkey' })
  ok(back.ok && back.bytes.length === 5 && [...back.bytes].join() === '0,1,2,250,255', 'get returns the exact bytes (binary-safe base64 hop)')
  const big = new ctx.Uint8Array(7 * 1024 * 1024 + 123)
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255
  sent = 0
  ok((await call('store.set', { name: 'recovery', bytes: big })).ok && sent === 4, `a 7 MB value travels as 3 chunks + a commit (${sent} messages)`)
  const bigBack = await call('store.get', { name: 'recovery' })
  let same = bigBack.ok && bigBack.bytes.length === big.length
  for (let i = 0; same && i < big.length; i += 4099) same = bigBack.bytes[i] === big[i]
  ok(same, 'and comes back whole, byte for byte')
  ok((await call('store.get', { name: 'nothing' })).reason === 'bad name', 'a name outside NAMES is refused through the relay too')
  ok((await call('store.set', { name: 'recovery', bytes: 'not bytes' })).reason === 'bytes must be a Uint8Array', 'non-bytes refused at the relay')
  ok((await call('store.list', { prefix: 'rec' })).names.join() === 'recovery', 'list through the relay')
  ok((await call('store.delete', { name: 'memberkey' })).ok && (await call('store.get', { name: 'memberkey' })).bytes === null, 'delete through the relay')
  for (const f of listeners) f({ data: { [CH]: true, dir: 'req', id: 'frame', op: 'store.get', payload: { name: 'recovery' } }, source: { other: true } })
  await new Promise((r) => setTimeout(r, 5))
  ok(!posted.some((p) => p.id === 'frame'), 'a request posted from another window (an iframe) is dropped')
}
{
  const bgSrc = readFileSync(join(SRC, 'src/background.js'), 'utf8')
  ok(/op === 'write' \? write\(sender, msg\.payload\?\.text \?\? ''\)\.then\(\(r\) => \{ if \(r\?\.ok\) noteSaved\(sender/.test(bgSrc), 'the saved hash is recorded after a SUCCESSFUL extension write, from the bytes written')
  ok((bgSrc.match(/recordSaved\(/g) ?? []).length === 1 && !/'store\.[a-z]+': docstore\.recordSaved/.test(bgSrc), 'and from nowhere else: no store op lets a page set it')
  ok(/if \(path\) await ensureCarried\(path, deps\)\s*\n\s*return fn\(path/.test(bgSrc), 'the carry is decided before the page\'s first store op is answered')
  ok(/fileBlockHash: async \(path\) => \{\s*\n\s*const r = await fetch\(`file:\/\//.test(bgSrc), 'the new file\'s hash is read by the extension from disk, not reported by the page')
  ok(/'store'/.test(readFileSync(join(SRC, 'src/page-bridge.js'), 'utf8')), 'page-bridge.js announces the store capability')
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
  ok(manifest.content_scripts.every((cs: any) => cs.all_frames === false || cs.all_frames === undefined), 'content scripts stay top-frame only')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
