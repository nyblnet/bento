#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// DocStore over a MessagePort (kernel/src/docstoreport.ts): the protocol a
// document in a host's sandboxed frame speaks to the host that framed it.
//
//   node scripts/test-docstore-port.ts
//
// Real MessageChannels (node's, structured clone like a browser's), the real
// host (serveDocStore) and the real client (PortBackend, via docStore()).
// Rows, each with a name the mutant rig (test-docstore-port-mutants.ts) aims at:
//   [round trip]  positive control: set, get, list, delete through docStore()
//   [compat]      no port offered: docStore() is what it was (null, or the
//                 extension's window protocol); the offer is taken once
//   [schema]      every malformed or unknown message is dropped, not answered,
//                 and counted by reason; the session still serves afterwards
//   [ids]         an id at or below the highest accepted is dropped
//   [caps]        a value over its name's cap is refused; an entry's total is
//                 capped; a view over a big buffer is dropped
//   [binding]     the partition is the host's entry, never the docId; a record
//                 is returned only to a session bound to its docId; no docId,
//                 no store
//   [teardown]    a closed session answers nothing on its old port; a new
//                 session is a new channel; too many drops close it
//   [flow]        in-flight and rate caps
//   [client]      the client takes only well-formed answers to its own ids
//   [channel]     the protocol source never reads an origin or posts to a window

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const K = process.env.BENTO_KERNEL_SRC || join(ROOT, 'kernel/src')
const P = await import(join(K, 'docstoreport.ts'))
const D = await import(join(K, 'docstore.ts'))

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
// a throw anywhere (a host listener included) is a FAIL line, never a silent exit
let current = '[start]'
const crash = (e: unknown) => { ok(false, `${current} threw: ${String((e as Error)?.message ?? e).slice(0, 120)}`); console.log(`\n${checks - failures}/${checks} checks passed`); process.exit(1) }
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)
const section = (m: string) => { current = m.split(' ')[0]; console.log(`\n=== ${m}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)

type Port = MessagePort
/** A host session on a fresh channel; returns the document's end. */
function open(o: Partial<{ entry: string; docId: string | null; backend: unknown; limits: unknown; now: () => number }> = {}) {
  const ch = new MessageChannel()
  const backend = o.backend ?? P.memoryBackend()
  const s = P.serveDocStore(ch.port1, { entry: o.entry ?? 'entry-' + Math.random().toString(36).slice(2), docId: o.docId === undefined ? 'doc-1' : o.docId, backend, limits: o.limits, now: o.now })
  return { s, port: ch.port2 as Port, backend, close: () => { s.close(); ch.port2.close() } }
}
/** Raw: post a message on the document's end and collect what comes back within `ms`. */
async function raw(port: Port, msgs: unknown[], ms = 60): Promise<unknown[]> {
  const got: unknown[] = []
  const fn = (e: MessageEvent) => got.push(e.data)
  port.addEventListener('message', fn)
  port.start()
  for (const m of msgs) port.postMessage(m)
  await sleep(ms)
  port.removeEventListener('message', fn)
  return got
}
const req = (id: number, op: string, extra: Record<string, unknown> = {}) => ({ t: 'bento-store', v: 1, id, op, ...extra })
const close = (ports: Array<{ close: () => void }>) => { for (const p of ports) p.close() }

// ---------------------------------------------------------------------------
section('[round trip] positive control: the client and the host over a real channel')
{
  const h = open()
  ;(globalThis as { __bentoDocStore?: unknown }).__bentoDocStore = { take: () => h.port }
  D.resetDocStoreForTest(undefined)
  const ds = D.docStore()
  ok(ds instanceof P.PortBackend, '[round trip] docStore() speaks over the offered port')
  ok(await ds.set('memberkey', enc('k1')) === 'stored', '[round trip] set answers stored')
  const got = await ds.get('memberkey')
  ok(got instanceof Uint8Array && dec(got) === 'k1', `[round trip] get returns the bytes (${dec(got)})`)
  ok(JSON.stringify(await ds.list()) === '["memberkey"]', '[round trip] list names what is held')
  ok(await D.setJSON(ds, 'recovery', { docId: 'doc-1', n: 1 }) === 'stored' && (await D.getJSON(ds, 'recovery') as { n: number })?.n === 1, '[round trip] JSON helpers ride on it')
  ok(await ds.delete('memberkey') === true && (await ds.get('memberkey')) === null, '[round trip] delete removes it; a missing value reads null')
  ok(JSON.stringify(await ds.list()) === '["recovery"]', '[round trip] list after delete')
  ok(h.s.stats.served === 8 && h.s.stats.dropped === 0, `[round trip] the host served every request and dropped none (${h.s.stats.served}/${h.s.stats.dropped})`)
  close([h])
  delete (globalThis as { __bentoDocStore?: unknown }).__bentoDocStore
}

section('[compat] without the port, docStore() is what it always was')
{
  D.resetDocStoreForTest(undefined)
  ok(D.docStore() === null, '[compat] no host, no offer: null (the page keeps its own storage)')
  ;(globalThis as { window?: unknown }).window = globalThis
  ;(globalThis as { postMessage?: unknown }).postMessage = () => {}
  ;(globalThis as { __bentoHost?: unknown }).__bentoHost = { ops: ['store'] }
  D.resetDocStoreForTest(undefined)
  ok(D.docStore() instanceof D.ExtensionBackend, '[compat] a host announcing store on __bentoHost: the window protocol, as before')
  let takes = 0
  ;(globalThis as { __bentoDocStore?: unknown }).__bentoDocStore = { take: () => { takes++; return 'not a port' } }
  D.resetDocStoreForTest(undefined)
  ok(D.docStore() instanceof D.ExtensionBackend, '[compat] an offer that yields no port changes nothing')
  delete (globalThis as { __bentoHost?: unknown }).__bentoHost
  const h = open()
  let given = 0
  ;(globalThis as { __bentoDocStore?: unknown }).__bentoDocStore = { take: () => (given++ === 0 ? h.port : null) }
  D.resetDocStoreForTest(undefined)
  const a = D.docStore(), b = D.docStore()
  ok(a instanceof P.PortBackend && a === b && given === 1, `[compat] decided once per page: take() called ${given} time(s)`)
  close([h])
  delete (globalThis as { __bentoDocStore?: unknown }).__bentoDocStore
  delete (globalThis as { window?: unknown }).window
  D.resetDocStoreForTest(undefined)
}

section('[schema] malformed and unknown messages are dropped, counted, never answered')
{
  const h = open()
  const proto = (() => { const o: Record<string, unknown> = req(1, 'list'); Object.defineProperty(o, '__proto__', { value: { x: 1 }, enumerable: true }); return o })()
  const forged: Array<[string, unknown, string]> = [
    ['a string', 'store.get', 'shape'],
    ['null', null, 'shape'],
    ['an array', [req(1, 'list')], 'shape'],
    ['another tag', { ...req(1, 'list'), t: '__bento_tray__' }, 'shape'],
    ['the extension\'s window wire', { __bento_tray__: true, dir: 'req', id: 1, op: 'store.get', payload: { name: 'memberkey' } }, 'shape'],
    ['version 2', { ...req(1, 'list'), v: 2 }, 'version'],
    ['an unknown op', req(1, 'clear'), 'op'],
    ['the extension\'s op name', req(1, 'store.get', { name: 'memberkey' }), 'op'],
    ['a write op', req(1, 'write', { name: 'recovery', bytes: enc('<html>') }), 'op'],
    ['a save op', req(1, 'save', { html: '<html>' }), 'op'],
    ['another docId', req(1, 'get', { name: 'memberkey', docId: 'victim' }), 'keys'],
    ['an entry', req(1, 'get', { name: 'memberkey', entry: 'other-entry' }), 'keys'],
    ['a partition', req(1, 'list', { partition: 'x' }), 'keys'],
    ['an own __proto__ key', proto, 'keys'],
    ['list with a name', req(1, 'list', { name: 'recovery' }), 'keys'],
    ['get without a name', req(1, 'get'), 'keys'],
    ['set without bytes', req(1, 'set', { name: 'recovery' }), 'keys'],
    ['a name outside the two', req(1, 'get', { name: 'bento-member-victim' }), 'name'],
    ['the name __proto__', req(1, 'get', { name: '__proto__' }), 'name'],
    ['a name that is not a string', req(1, 'get', { name: ['memberkey'] }), 'name'],
    ['bytes as a string', req(1, 'set', { name: 'recovery', bytes: 'abc' }), 'bytes'],
    ['bytes as an array', req(1, 'set', { name: 'recovery', bytes: [1, 2, 3] }), 'bytes'],
    ['bytes as an ArrayBuffer', req(1, 'set', { name: 'recovery', bytes: new ArrayBuffer(3) }), 'bytes'],
    ['bytes as a DataView', req(1, 'set', { name: 'recovery', bytes: new DataView(new ArrayBuffer(3)) }), 'bytes'],
    ['bytes as a Uint16Array', req(1, 'set', { name: 'recovery', bytes: new Uint16Array(3) }), 'bytes'],
    ['an id that is a string', { ...req(1, 'list'), id: '1' }, 'id'],
    ['an id that is fractional', { ...req(1, 'list'), id: 1.5 }, 'id'],
    ['an id of zero', { ...req(1, 'list'), id: 0 }, 'id'],
    ['an id past 2^53', { ...req(1, 'list'), id: 2 ** 60 }, 'id'],
  ]
  for (const [what, m, reason] of forged) {
    const before = h.s.stats.byReason[reason] ?? 0
    const got = await raw(h.port, [m], 25)
    ok(got.length === 0 && (h.s.stats.byReason[reason] ?? 0) === before + 1, `[schema] ${what}: dropped as '${reason}', no answer (${got.length} answers)`)
  }
  ok(h.s.stats.dropped === forged.length && h.s.stats.served === 0, `[schema] every drop counted (${h.s.stats.dropped}/${forged.length}), nothing served`)
  // parse directly: a non-plain object (a port only delivers plain ones, but the parser does not rely on that)
  ok(P.parseStoreRequest(Object.assign(Object.create({ inherited: 1 }), req(1, 'list')), 0) === 'shape', '[schema] an object with a foreign prototype is not a request')
  ok(P.parseStoreRequest(Object.assign(Object.create(null), req(1, 'list')), 0) !== 'shape', '[schema] a null-prototype plain object is (structured clone may make one)')
  const after = await raw(h.port, [req(5, 'list')])
  ok(after.length === 1 && (after[0] as { ok: boolean }).ok === true, '[schema] positive control: after the drops, a well-formed request is answered')
  close([h])
}

section('[ids] request ids only go up')
{
  const h = open()
  const got = await raw(h.port, [req(3, 'list'), req(3, 'list'), req(2, 'list'), req(4, 'list')])
  const ids = got.map((g) => (g as { id: number }).id)
  ok(JSON.stringify(ids) === '[3,4]' && h.s.stats.byReason.id === 2, `[ids] a repeated and a lower id are dropped (answered ${JSON.stringify(ids)}, dropped ${h.s.stats.byReason.id ?? 0})`)
  close([h])
}

section('[caps] sizes')
{
  const limits = { maxBytes: { recovery: 1000, memberkey: 100 }, maxEntryBytes: 1050 }
  const h = open({ limits })
  let got = await raw(h.port, [req(1, 'set', { name: 'memberkey', bytes: new Uint8Array(101) })])
  ok((got[0] as { reason?: string })?.reason === 'too-large', `[caps] a value over its name's cap is refused 'too-large' (${JSON.stringify(got[0])?.slice(0, 80)})`)
  got = await raw(h.port, [req(2, 'set', { name: 'memberkey', bytes: new Uint8Array(100) }), req(3, 'set', { name: 'recovery', bytes: new Uint8Array(951) })])
  ok((got[0] as { ok: boolean }).ok === true && (got[1] as { reason?: string }).reason === 'quota', `[caps] the entry's total is capped: 100 + 951 > 1050 refused 'quota' (${(got[1] as { reason?: string })?.reason})`)
  got = await raw(h.port, [req(4, 'set', { name: 'recovery', bytes: new Uint8Array(950) })])
  ok((got[0] as { ok: boolean }).ok === true, '[caps] positive control: 100 + 950 fits')
  got = await raw(h.port, [req(5, 'get', { name: 'recovery' })])
  ok((got[0] as { bytes?: Uint8Array }).bytes?.length === 950, '[caps] the refused writes changed nothing (950 bytes held)')
  const big = new Uint8Array(new ArrayBuffer(P.BUFFER_SLACK + 200), 0, 10)
  got = await raw(h.port, [req(6, 'set', { name: 'memberkey', bytes: big })])
  ok(got.length === 0 && h.s.stats.byReason.bytes === 1, '[caps] a 10-byte view over a big buffer is dropped')
  close([h])
}

section('[binding] the partition is the host\'s entry; a record answers only to its docId')
{
  const backend = P.memoryBackend()
  // the victim's document, and a hostile file claiming the victim's docId, opened as two entries
  const victim = open({ backend, entry: 'entry-victim', docId: 'doc-victim' })
  await raw(victim.port, [req(1, 'set', { name: 'memberkey', bytes: enc('victim-private-key') })])
  const hostile = open({ backend, entry: 'entry-hostile', docId: 'doc-victim' })
  const got = await raw(hostile.port, [req(1, 'get', { name: 'memberkey' }), req(2, 'list'), req(3, 'delete', { name: 'memberkey' })])
  ok((got[0] as { bytes?: unknown }).bytes === null && JSON.stringify((got[1] as { names?: unknown }).names) === '[]',
    `[binding] a file claiming another's docId, in its own entry, sees nothing of it (${JSON.stringify(got[0])?.slice(0, 70)})`)
  const still = await raw(victim.port, [req(2, 'get', { name: 'memberkey' })])
  ok(dec((still[0] as { bytes?: Uint8Array }).bytes ?? null) === 'victim-private-key', '[binding] and its delete did not touch the victim\'s')
  // the same entry rebound to a different docId (a host bug): the record is not handed over
  const rebound = open({ backend, entry: 'entry-victim', docId: 'doc-other' })
  const r2 = await raw(rebound.port, [req(1, 'get', { name: 'memberkey' }), req(2, 'list')])
  ok((r2[0] as { bytes?: unknown }).bytes === null && JSON.stringify((r2[1] as { names?: unknown }).names) === '[]', '[binding] an entry rebound to another docId does not hand over the record')
  // no verified docId: no store
  const none = open({ backend, entry: 'entry-none', docId: null })
  const r3 = await raw(none.port, [req(1, 'set', { name: 'memberkey', bytes: enc('x') }), req(2, 'get', { name: 'memberkey' }), req(3, 'list')])
  ok(r3.length === 3 && r3.every((x) => (x as { reason?: string }).reason === 'unavailable') && backend.size() === 1, '[binding] a session with no verified docId is answered unavailable, and stores nothing')
  ok((() => { try { P.serveDocStore(new MessageChannel().port1, { entry: '', docId: 'd', backend }); return false } catch { return true } })(), '[binding] a session needs a host-minted entry')
  close([victim, hostile, rebound, none])
}

section('[teardown] a closed session is gone; a stashed port reaches nothing')
{
  const backend = P.memoryBackend()
  const one = open({ backend, entry: 'entry-1' })
  await raw(one.port, [req(1, 'set', { name: 'memberkey', bytes: enc('one') })])
  one.s.close()
  const stale = await raw(one.port, [req(2, 'set', { name: 'memberkey', bytes: enc('stale write') }), req(3, 'get', { name: 'memberkey' })], 80)
  const rec = await backend.get(P.entryKey('entry-1', 'memberkey'))
  ok(stale.length === 0 && dec(rec?.bytes ?? null) === 'one', `[teardown] after close, the old port is answered nothing and writes nothing (${stale.length} answers, held "${dec(rec?.bytes ?? null)}")`)
  ok(one.s.closed, '[teardown] the session reports closed')
  const two = open({ backend, entry: 'entry-2' })
  const fresh = await raw(two.port, [req(1, 'list')])
  ok(JSON.stringify((fresh[0] as { names?: unknown })?.names) === '[]', '[teardown] a new session is a new channel and a new entry: it sees nothing of the old')
  close([one, two])
  // too many drops: the host closes the session itself
  const noisy = open({ limits: { maxDrops: 5 } })
  await raw(noisy.port, Array.from({ length: 5 }, () => 'junk'))
  const after = await raw(noisy.port, [req(1, 'list')])
  ok(noisy.s.closed && after.length === 0, `[teardown] ${5} drops close the session; nothing is answered after (${after.length})`)
  close([noisy])
}

section('[flow] requests in flight, and the rate')
{
  // a slow backend: every get takes 40 ms
  const slow = P.memoryBackend()
  const g = slow.get
  slow.get = async (k: string) => { await sleep(40); return g(k) }
  const h = open({ backend: slow, limits: { maxInFlight: 3 } })
  const got = await raw(h.port, [1, 2, 3, 4, 5].map((i) => req(i, 'get', { name: 'memberkey' })), 300)
  ok(got.length === 3 && h.s.stats.byReason['in-flight'] === 2, `[flow] past 3 in flight, requests are dropped (${got.length} answered, ${h.s.stats.byReason['in-flight'] ?? 0} dropped)`)
  const later = await raw(h.port, [req(6, 'list')], 300)
  ok(later.length === 1, '[flow] positive control: once answered, there is room again')
  close([h])
  let t = 0
  const r = open({ now: () => t, limits: { rateMax: 4, rateWindowMs: 1000 } })
  const burst = await raw(r.port, [1, 2, 3, 4, 5, 6].map((i) => req(i, 'list')))
  ok(burst.length === 4 && r.s.stats.byReason.rate === 2, `[flow] past 4 in the window, requests are dropped (${burst.length} answered, ${r.s.stats.byReason.rate ?? 0} dropped)`)
  t = 1000
  const next = await raw(r.port, [req(7, 'list')])
  ok(next.length === 1, '[flow] the next window serves again')
  close([r])
}

section('[client] the document side takes only well-formed answers to its own ids')
{
  const ch = new MessageChannel()
  const c = new P.PortBackend(ch.port2, { get: 300, set: 300, small: 300 })
  // a fake host: answers with noise first, then the right answer
  ch.port1.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { id: number; op: string }
    ch.port1.postMessage({ t: 'bento-store', v: 1, id: m.id + 100, ok: true, bytes: enc('wrong id') })
    ch.port1.postMessage({ t: 'other', v: 1, id: m.id, ok: true, bytes: enc('wrong tag') })
    ch.port1.postMessage({ t: 'bento-store', v: 2, id: m.id, ok: true, bytes: enc('wrong version') })
    if (m.op === 'get') ch.port1.postMessage({ t: 'bento-store', v: 1, id: m.id, ok: true, bytes: enc('right') })
    if (m.op === 'set') ch.port1.postMessage({ t: 'bento-store', v: 1, id: m.id, ok: false, reason: 'too-large' })
  })
  ch.port1.start()
  ok(dec(await c.get('recovery')) === 'right', '[client] answers with another id, tag or version are ignored')
  ok(await c.set('recovery', enc('x')) === 'refused', '[client] a refusal is refused')
  ok(await c.list().then(() => 'answered', () => 'threw') === 'threw', '[client] no answer: list throws, after its timeout')
  ok(await c.delete('memberkey') === false, '[client] no answer: delete is false')
  ch.port1.close()
  const ch2 = new MessageChannel()
  const c2 = new P.PortBackend(ch2.port2, { set: 100 })
  ok(await c2.set('memberkey', enc('x')) === 'unanswered', '[client] no answer: a write is unanswered, not refused')
  ch2.port1.close(); ch2.port2.close()
}

section('[channel] the port is the only channel')
{
  const src = readFileSync(join(K, 'docstoreport.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  ok(!/\.origin\b/.test(src), '[channel] the protocol never reads an origin')
  ok(!/\bwindow\b|\bparent\b|\btop\b|\bopener\b|'\*'/.test(src), '[channel] the protocol never names a window or posts to one')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
