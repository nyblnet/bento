#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// ONE RELAY, ONE WIRE FORMAT, TWO CLIENTS — asserted rather than hoped.
//
// `dash/src/sync/online.ts` says of itself that it is "A PORT of
// slides/src/sync/online.ts, deliberately close to the original". That transport
// has since moved into `kernel/src/sync/online.ts`, so the port's twin now lives
// in the kernel — and the two files are still separate text that nobody diffs.
//
// WHY THEY ARE STILL SEPARATE, so the next person does not "fix" it in an
// afternoon: dash's `OnlineTransport` is parameterised by `DashDoc` and dash's
// `SyncStateJSON` and takes a differently-shaped hooks object, because
// `DashSync` is not a `SyncEngine` subclass — dash runs a different CRDT engine
// on purpose (sparse per-row state, so an untouched row costs nothing in the
// saved file; the kernel engine would put O(rows) in every workbook). Making one
// call the other is a genericisation of the transport over the doc and state
// types, not a facade, and it is the kind of change that breaks relay auth
// quietly.
//
// WHAT MUST NOT FORK IS THE PROTOCOL. A deployed worker verifies these exact
// strings: it pins the room id to a public key, walks an owner→invite→member
// signature chain, and drops any persisted frame without a valid signature. If
// one client's idea of `inv.${pub}.${role}.${exp}` ever drifts from the other's,
// the symptom is not a failing test — it is one app's users silently unable to
// join the other's rooms, discovered in production, on a relay that cannot be
// rolled back independently of the shells already in people's files.
//
// So this rig diffs the two files on the things that go ON THE WIRE, and
// nothing else. Comments, types, field order and structure are free to differ —
// they already do, by design.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DASH = join(root, 'dash/src/sync/online.ts')

/**
 * The twin moves. It was `slides/src/sync/online.ts`; a kernel refactor is
 * lifting it to `kernel/src/sync/online.ts` and leaving slides a facade. This
 * guard follows it rather than pinning one path, so it keeps working across
 * that move instead of going quiet on the exact day the code is most likely to
 * drift. If neither is a real transport (both facades, or the layout changed
 * again), the rig SAYS SO and fails — a protocol guard that silently finds
 * nothing to compare is worse than no guard, because the green tick is a lie.
 */
const TWINS = ['kernel/src/sync/online.ts', 'slides/src/sync/online.ts']
const twin = TWINS.map((p) => join(root, p)).find((p) => {
  if (!existsSync(p)) return false
  // a facade re-exports; a transport has the wire in it
  return readFileSync(p, 'utf8').includes('ECDSA')
})

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

if (!twin) {
  console.log('FAIL  neither kernel/src/sync/online.ts nor slides/src/sync/online.ts')
  console.log('      holds a transport to compare against. The relay protocol is')
  console.log('      now guarded by nothing. Point TWINS at wherever it went.')
  process.exit(1)
}
console.log(`comparing dash against ${twin.slice(root.length + 1)}\n`)
const kernel = readFileSync(twin, 'utf8')
const dash = readFileSync(DASH, 'utf8')

/** Source with comments removed — a wire constant inside a comment is prose. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n')

const kCode = code(kernel)
const dCode = code(dash)

/** Every match of `re`, deduped and sorted — order and count are free to differ. */
const all = (src: string, re: RegExp): string[] =>
  [...new Set([...src.matchAll(re)].map((m) => m[0]))].sort()

const same = (re: RegExp, what: string): void => {
  const k = all(kCode, re)
  const d = all(dCode, re)
  ok(k.length > 0, `${what}: the twin actually contains some (guard is live)`)
  ok(JSON.stringify(k) === JSON.stringify(d),
    `${what} are identical in both clients${JSON.stringify(k) === JSON.stringify(d) ? '' : `\n          twin: ${JSON.stringify(k)}\n          dash:   ${JSON.stringify(d)}`}`)
}

console.log('the signature chain the relay verifies')
// `inv.${pub}.${role}.${exp}` — an owner blessing an invite key.
// `rev.${pub}` — an owner revoking one. `${i}.${d}` — a frame signature.
same(/`(inv|rev|mem|own)\.[^`]*`/g, 'signature texts')

console.log('\nthe crypto')
same(/name: '[A-Za-z-]+'/g, 'algorithm names')
same(/namedCurve: '[^']+'/g, 'curve')
same(/hash: '[^']+'/g, 'hash')

console.log('\nthe wire')
// The possession proof in the query string, and the frame envelope keys.
same(/[?&](tok|room|pub|sig|inv|role|exp)=/g, 'query parameters')
same(/'(ping|pong)'/g, 'keepalive frames')

console.log('\nthe timings a relay and a client have to agree about')
const num = (src: string, name: string): string | null => {
  const m = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(src)
  return m ? m[1].replace(/_/g, '') : null
}
for (const c of ['PING_MS', 'PONG_GRACE_MS', 'MAX_BACKOFF_MS', 'BASE_BACKOFF_MS']) {
  const k = num(kCode, c)
  const d = num(dCode, c)
  if (k === null && d === null) continue
  ok(k === d, `${c} agrees (twin ${k}, dash ${d})`)
}

console.log('\nthe room id, which the relay pins to a key')
// The room URL is built inline: `${syncHost()}/d/w${b64u.enc(commit)}` for a
// key-committed room. Both the PATH SEGMENT and the `w`/`r` letter matter —
// they are what the worker routes and pins on. Get either wrong on one side and
// that client cannot join rooms the other creates.
//
// (An earlier version of this check looked for `'w' +` and found NOTHING in
// either file, because the prefix lives inside a template literal. The
// guard-is-live assertion above is what caught it; without that, this rig would
// have compared two empty lists and reported a confident green.)
same(/room: `[^`]*`/g, 'room URL template')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`
The two clients have drifted on something that goes on the wire. That is not a
style difference: one deployed relay verifies both, so whichever side moved has
locked its users out of rooms created by the other. Reconcile the strings above
before shipping either shell.`)
  process.exit(1)
}
