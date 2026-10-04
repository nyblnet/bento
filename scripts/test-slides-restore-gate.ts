#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A document kept in this browser is gated before it replaces the open one.
//
// BUNDLED, not run directly — untrusted.ts imports extensionless — and run
// from the repo root (it reads editor.ts from there):
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-restore-gate.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-slides-restore-gate.mjs" \
//     && node "$TMPDIR/test-slides-restore-gate.mjs"
//
// WHAT THIS PROVES. The "Restore your unsaved changes?" snapshot and every
// Version history entry live in IndexedDB under the deck's docId — and on
// file:// that store is shared by every local document. Restore used to hand
// the stored JSON straight to store.replaceDoc. Now (slides/src/restoregate.ts):
//   1. a snapshot never brings identity or capability: docId, collab and
//      readonly are the OPEN FILE's, present or absent, whatever it carries;
//   2. its content passes the untrusted gate a pasted clip does — unknown
//      keys, bad enums and malformed elements are dropped, not kept;
//   3. an honest snapshot of a real deck comes back as it went in, key for
//      key (nothing legitimate is lost to the gate);
//   4. something that is not a document, or has no slide left, is never
//      offered;
//   5. every restore path in the editor goes through the gate — no raw
//      replaceDoc of stored JSON remains.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gateRestored } from '../slides/src/restoregate.ts'
import { starterDoc } from '../slides/src/starterdeck.ts'
import type { BentoDoc } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
// the same document regardless of key order (the gate rebuilds each element
// key by key, type first, as the paste gate does)
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)
const root = process.cwd()

const live = starterDoc()
live.collab = { v: 2, room: 'wLIVEROOM', key: 'live-key', on: true } as unknown as BentoDoc['collab']

console.log('identity and capability are the open file\'s\n')
{
  const snap = clone(live) as unknown as Record<string, unknown>
  snap.docId = 'some-other-deck'
  snap.collab = { v: 2, room: 'wOTHERROOM', key: 'other-key', on: true }
  snap.readonly = true
  const g = gateRestored(JSON.stringify(snap), live)
  ok(!!g && g.doc.docId === live.docId, `docId stays the open file's (${g?.doc.docId})`)
  ok(!!g && JSON.stringify(g.doc.collab) === JSON.stringify(live.collab), 'collab stays the open file\'s room and key')
  ok(!!g && g.doc.readonly === undefined, 'a snapshot cannot turn the deck into a present-only player')
}
{
  const noCollab = clone(live); delete noCollab.collab
  const snap = clone(live) as unknown as Record<string, unknown>
  snap.collab = { v: 2, room: 'wOTHERROOM', key: 'other-key', on: true }
  const g = gateRestored(JSON.stringify(snap), noCollab)
  ok(!!g && g.doc.collab === undefined, 'a deck with no live session does not gain one from a snapshot')
}
{
  // a snapshot that simply OMITS the identity still gets the open file's
  const snap = clone(live) as unknown as Record<string, unknown>
  delete snap.collab
  const g = gateRestored(JSON.stringify(snap), live)
  ok(!!g && JSON.stringify(g.doc.collab) === JSON.stringify(live.collab), 'a snapshot without collab still restores into the open file\'s live session')
}
{
  const snap = clone(live) as unknown as Record<string, unknown>
  snap.template = true
  const g = gateRestored(JSON.stringify(snap), live)
  ok(!!g && g.doc.docId === live.docId && !('template' in g.doc), 'a `template` flag does not re-mint the identity or survive')
}

console.log('\ncontent passes the untrusted gate\n')
{
  const snap = clone(live) as unknown as Record<string, any>
  snap.notAField = 'x'
  const el = snap.slides[0].elements[0]
  el.notAKey = 'x'
  snap.slides[0].transition = 'not-a-transition'
  snap.slides[1].elements.push({ type: 'no-such-type', id: 'junk', x: 0, y: 0, w: 10, h: 10 })
  snap.theme.nested = { deep: { deeper: 1 } }
  const g = gateRestored(JSON.stringify(snap), live)
  const s = g ? JSON.stringify(g.doc) : ''
  ok(!!g && !('notAField' in g.doc), 'an unknown document key is dropped')
  ok(!!g && !('notAKey' in (g.doc.slides[0].elements[0] as object)), 'an unknown element key is dropped')
  ok(!!g && g.doc.slides[0].transition !== 'not-a-transition', 'an enum outside the format\'s literals is dropped')
  ok(!!g && !s.includes('"junk"'), 'an element of an unknown type is dropped')
  ok(!!g && !('deep' in ((g.doc.theme as Record<string, object>).nested ?? {})), 'a settings object keeps plain values, one nested level at most')
  ok(!!g && g.dropped.length >= 5, `the drops are reported (${g?.dropped.length})`)
}

console.log('\nan honest snapshot round-trips\n')
{
  const g = gateRestored(JSON.stringify(live), live)
  ok(!!g && canon(g.doc) === canon(live), 'the starter deck (every feature it shows) comes back identical, key for key')
  ok(!!g && g.dropped.length === 0, `nothing is dropped from it (${g?.dropped.map((d) => d.path).join(', ') || 'none'})`)
}

console.log('\nnot a document → never offered\n')
ok(gateRestored('not json', live) === null, 'unparseable text')
ok(gateRestored('[]', live) === null, 'a JSON array')
ok(gateRestored(JSON.stringify({ format: 'something/else', slides: [{ id: 's' }] }), live) === null, 'another format')
ok(gateRestored(JSON.stringify({ ...clone(live), slides: [{ no: 'id' }] }), live) === null, 'a document with no slide that survives the gate')

console.log('\nevery restore path uses the gate\n')
{
  const src = readFileSync(join(root, 'slides/src/editor/editor.ts'), 'utf8')
  const check = src.slice(src.indexOf('private async checkRecovery()'), src.indexOf('private async checkRecovery()') + 900)
  const banner = src.slice(src.indexOf('private showRecoveryBanner('), src.indexOf('private showRecoveryBanner(') + 1400)
  const history = src.slice(src.indexOf('private async openVersionHistory()'), src.indexOf('private async openVersionHistory()') + 2400)
  ok(/gateRestored\(snap\.json, doc\)/.test(check), 'the recovery check gates before offering')
  ok(/gateRestored\(snap\.json, this\.store\.doc\)[\s\S]*replaceDoc\(gated\.doc\)/.test(banner), 'Restore gates against the CURRENT document, then applies the gated one')
  ok(/gateRestored\(v\.json, this\.store\.doc\)[\s\S]*replaceDoc\(gated\.doc\)/.test(history), 'Version history restore gates the same way')
  ok(!/replaceDoc\((recovered|JSON\.parse\(v\.json\)|JSON\.parse\(snap\.json\))\)/.test(src), 'no raw replaceDoc of stored JSON remains')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
