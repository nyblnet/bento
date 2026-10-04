#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext DocStore rig.
//
//   node scripts/test-webext-store.ts
//
// WHAT THIS PROVES. A document's sidecar data (recovery, version history,
// keys) lives in the extension's origin, partitioned by the file path the
// BROWSER reports for the sender. The properties: one document can never
// read, list, overwrite or delete another's entries; nothing in the payload
// can name a different partition; bytes survive the base64 hop and the
// chunked path intact; a half-sent value is never visible; retention and the
// sweep match the page store; a moved file starts empty rather than failing.
// The real store.js, background.js and relay.js run here.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

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
const deps = (db = memory(), exists = async (_p: string) => true) => ({ db, now: () => clock, txid: () => `tx-${String(++txn).padStart(8, '0')}`, exists })

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
  ok((await bg.storeOp('store.get', A, { name: '../x' }, d)).reason === 'bad name' && (await bg.storeOp('store.get', A, { name: 'a\u0000b' }, d)).reason === 'bad name' && (await bg.storeOp('store.list', A, { prefix: '../' }, d)).reason === 'bad prefix',
    'names and prefixes cannot climb or carry the key separator')
  ok((await bg.storeOp('store.nope', A, {}, d)).ok === false, 'an unknown store op is refused')
}

console.log('\n— chunked values: committed whole or not at all')
{
  const d = deps()
  const tx = 'tx-chunked-1'
  await bg.storeOp('store.put', A, { name: 'ver/1', tx, i: 0, data: enc('part0-') }, d)
  ok((await bg.storeOp('store.get', A, { name: 'ver/1' }, d)).found === false, 'before commit, nothing is visible')
  ok((await bg.storeOp('store.commit', A, { name: 'ver/1', tx, n: 2 }, d)).reason === 'incomplete', 'a commit with a chunk missing is refused')
  await bg.storeOp('store.put', A, { name: 'ver/1', tx, i: 1, data: enc('part1') }, d)
  ok((await bg.storeOp('store.commit', A, { name: 'ver/1', tx, n: 2 }, d)).ok, 'all chunks present → committed')
  const m = await bg.storeOp('store.get', A, { name: 'ver/1' }, d)
  const parts = [await bg.storeOp('store.chunk', A, { name: 'ver/1', tx: m.tx, i: 0 }, d), await bg.storeOp('store.chunk', A, { name: 'ver/1', tx: m.tx, i: 1 }, d)]
  ok(m.n === 2 && m.size === 11 && parts.map((p: any) => dec(p.data)).join('') === 'part0-part1', 'read back chunk by chunk, size exact')
  ok((await bg.storeOp('store.chunk', B, { name: 'ver/1', tx: m.tx, i: 0 }, d)).reason === 'gone', 'another document cannot read A\'s chunks even with the tx id')
  // replacing the value retires the old chunks
  await bg.storeOp('store.set', A, { name: 'ver/1', data: enc('new') }, d)
  ok(![...d.db.m.keys()].some((k) => k.includes(m.tx)), 'a replaced value leaves no chunks behind')
  ok((await bg.storeOp('store.put', A, { name: 'x', tx, i: 0, data: st.toB64(new Uint8Array(st.CHUNK + 1)) }, d)).reason === 'chunk too large', 'a chunk over CHUNK is refused')
}

console.log('\n— retention and the sweep (the page store\'s caps)')
{
  const d = deps()
  for (let i = 0; i < 25; i++) { clock += 1000; await bg.storeOp('store.set', A, { name: `ver/${String(i).padStart(4, '0')}`, data: enc(`v${i}`) }, d) }
  const vers = (await bg.storeOp('store.list', A, { prefix: 'ver/' }, d)).names
  ok(vers.length === st.VERSIONS_MAX && vers[0] === 'ver/0005' && vers.at(-1) === 'ver/0024', `ver/* keeps the newest ${st.VERSIONS_MAX}`)
  clock += 31 * 24 * 3600 * 1000
  await bg.storeOp('store.set', A, { name: 'ver/0100', data: enc('fresh') }, d)
  ok((await bg.storeOp('store.list', A, { prefix: 'ver/' }, d)).names.join() === 'ver/0100', 'versions older than 30 days go when the next one is written')
  await bg.storeOp('store.set', A, { name: 'recovery', data: enc('r') }, d)
  ok((await bg.storeOp('store.list', A, { prefix: '' }, d)).names.includes('recovery'), 'recovery is not subject to the version cap')
  // the sweep: B's file is gone; C untouched for a month; a stale uncommitted transfer
  const gone = new Set(['/Users/you/Decks/Other.bento.html'])
  const d2 = { ...d, exists: async (p: string) => !gone.has(p) }
  await bg.storeOp('store.set', B, { name: 'recovery', data: enc('b') }, d2)
  const C = { url: 'file:///Users/you/Old/C.bento.html', frameId: 0 }
  clock -= 40 * 24 * 3600 * 1000
  await bg.storeOp('store.set', C, { name: 'recovery', data: enc('c') }, d2)
  await bg.storeOp('store.put', A, { name: 'ver/0200', tx: 'tx-abandoned', i: 0, data: enc('half') }, d2)
  clock += 40 * 24 * 3600 * 1000
  const dropped = await st.gc(d2)
  ok(dropped.some((x: any) => x.path.endsWith('Other.bento.html') && x.why === 'gone') && dropped.some((x: any) => x.path.endsWith('C.bento.html') && x.why === 'age'), 'gc drops the partition of a file that is gone, and one untouched for 30 days')
  ok((await bg.storeOp('store.get', A, { name: 'recovery' }, d2)).found === true, 'and keeps a live one')
  ok(![...d.db.m.keys()].some((k) => k.includes('tx-abandoned')), 'gc sweeps a transfer that never committed')
  // a moved file: a fresh, empty partition — not an error
  const moved = { url: 'file:///Users/you/Elsewhere/Q3.bento.html', frameId: 0 }
  const r = await bg.storeOp('store.get', moved, { name: 'recovery' }, d2)
  ok(r.ok === true && r.found === false, 'a moved file reads an empty partition (ok, not found) — history, not content, is what a move costs')
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
  ok((await call('store.set', { name: 'ver/0001', bytes: big })).ok && sent === 4, `a 7 MB value travels as 3 chunks + a commit (${sent} messages)`)
  const bigBack = await call('store.get', { name: 'ver/0001' })
  let same = bigBack.ok && bigBack.bytes.length === big.length
  for (let i = 0; same && i < big.length; i += 4099) same = bigBack.bytes[i] === big[i]
  ok(same, 'and comes back whole, byte for byte')
  ok((await call('store.get', { name: 'nothing' })).bytes === null, 'a missing name is null, not an error')
  ok((await call('store.set', { name: 'x', bytes: 'not bytes' })).reason === 'bytes must be a Uint8Array', 'non-bytes refused at the relay')
  ok((await call('store.list', { prefix: 'ver/' })).names.join() === 'ver/0001', 'list through the relay')
  ok((await call('store.delete', { name: 'memberkey' })).ok && (await call('store.get', { name: 'memberkey' })).bytes === null, 'delete through the relay')
  for (const f of listeners) f({ data: { [CH]: true, dir: 'req', id: 'frame', op: 'store.get', payload: { name: 'ver/0001' } }, source: { other: true } })
  await new Promise((r) => setTimeout(r, 5))
  ok(!posted.some((p) => p.id === 'frame'), 'a request posted from another window (an iframe) is dropped')
}
{
  ok(/'store'/.test(readFileSync(join(SRC, 'src/page-bridge.js'), 'utf8')), 'page-bridge.js announces the store capability')
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
  ok(manifest.content_scripts.every((cs: any) => cs.all_frames === false || cs.all_frames === undefined), 'content scripts stay top-frame only')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
