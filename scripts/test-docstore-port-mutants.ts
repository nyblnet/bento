#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the DocStore port protocol (kernel/src/docstoreport.ts).
//
//   node scripts/test-docstore-port-mutants.ts
//
// Each mutant loosens ONE rule in a COPY of kernel/src; scripts/test-docstore-
// port.ts must then fail ON THE ROW that guards the rule (a FAIL line carrying
// that row's tag), not merely somewhere. The unmutated copy passes first
// (positive control), and every mutant must apply to exactly one place, so a
// refactor that moves the code turns this rig red instead of vacuous.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

type Mutant = { name: string; row: string; from: string; to: string; file?: string; and?: Array<[string, string]> }
const MUTANTS: Mutant[] = [
  { name: 'the partition is the docId, not the host\'s entry', row: '[binding]',
    from: '    const key = (n: DocStoreName) => entryKey(o.entry, n)\n', to: '    const key = (n: DocStoreName) => entryKey(docId, n)\n' },
  { name: 'a record answers to any docId', row: '[binding]',
    from: '(rec && rec.docId === docId ? rec : undefined)', to: '(rec)' },
  { name: 'a session with no verified docId is served', row: '[binding]',
    from: "    if (docId === null) return refuse(r.id, 'unavailable')\n", to: '' },
  { name: 'extra keys are accepted (a docId, an entry)', row: '[schema]',
    from: "  if (Object.keys(m).sort().join(',') !== KEYS[op as Op] || Object.getOwnPropertySymbols(m).length) return 'keys'\n",
    to: "  if (Object.getOwnPropertySymbols(m).length) return 'keys'\n" },
  { name: 'any op name', row: '[schema]',
    from: "  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return 'op'\n", to: "  if (typeof op !== 'string') return 'op'\n" },
  { name: 'any store name', row: '[schema]',
    from: "  if (typeof name !== 'string' || !(NAMES as readonly string[]).includes(name)) return 'name'\n", to: "  if (typeof name !== 'string') return 'name'\n" },
  { name: 'bytes may be any typed view', row: '[schema]',
    from: "    if (!(b instanceof Uint8Array) || Object.getPrototypeOf(b) !== Uint8Array.prototype ||\n",
    to: '    if (!ArrayBuffer.isView(b) ||\n' },
  { name: 'any object is a plain object', row: '[schema]',
    from: '  return p === Object.prototype || p === null\n', to: '  return true\n' },
  { name: 'ids may repeat', row: '[ids]', from: ' || id <= lastId) return', to: ' || id < lastId) return' },
  { name: 'a view over any buffer', row: '[caps]', from: ' || b.buffer.byteLength - b.length > BUFFER_SLACK) return', to: ') return' },
  { name: 'no per-name cap', row: '[caps]', from: "      if (r.bytes.length > L.maxBytes[r.name]) return refuse(r.id, 'too-large')\n", to: '' },
  { name: 'no per-entry cap', row: '[caps]', from: "      if (others + r.bytes.length > L.maxEntryBytes) return refuse(r.id, 'quota')\n", to: '' },
  { name: 'no in-flight cap', row: '[flow]', from: "    if (inFlight >= L.maxInFlight) return drop('in-flight')\n", to: '' },
  { name: 'no rate cap', row: '[flow]', from: "    if (++inWindow > L.rateMax) return drop('rate')\n", to: '    ++inWindow\n' },
  { name: 'closing leaves the port served', row: '[teardown]',
    from: '      closed = true\n      port.removeEventListener', to: '      port.addEventListener',
    and: [['    if (closed) return\n    const t = now()', '    const t = now()'], ["  const send = (m: Record<string, unknown>) => { if (!closed) port.postMessage", '  const send = (m: Record<string, unknown>) => { port.postMessage'], ['      try { port.close?.() } catch', '      try { void 0 } catch']] },
  { name: 'drops never close the session', row: '[teardown]', from: '    if (stats.dropped >= L.maxDrops) session.close()\n', to: '' },
  { name: 'the client takes an answer of any version', row: '[client]', from: " || d.v !== STORE_V || typeof d.id !== 'number'", to: " || typeof d.id !== 'number'" },
  { name: 'docStore() ignores the offered port', row: '[round trip]', file: 'docstore.ts',
    from: '    if (isPortLike(port)) return (cached = new PortBackend(port))\n', to: '' },
  { name: 'a host that reads the origin', row: '[channel]',
    from: '  const onMessage = (e: MessageEvent) => {\n    if (closed) return\n', to: "  const onMessage = (e: MessageEvent) => {\n    if (closed || e.origin === 'x') return\n" },
]

function tree() {
  const d = mkdtempSync(join(tmpdir(), 'docstore-port-mut-'))
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  return d
}
function run(d: string) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/test-docstore-port.ts')], { encoding: 'utf8', env: { ...process.env, BENTO_KERNEL_SRC: join(d, 'kernel/src') }, timeout: 120_000 })
  const out = r.stdout ?? ''
  const tail = (out.match(/\d+\/\d+ checks passed/g) ?? []).pop() ?? `(no count; exit ${r.status}) ${(r.stderr ?? '').split('\n')[0]}`
  return { status: r.status, tail, failLines: out.split('\n').filter((l) => /^ {2}FAIL/.test(l)) }
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  const r = run(d)
  ok(r.status === 0 && r.failLines.length === 0, `test-docstore-port.ts: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants, each one loosened rule: every one must turn its own row red`)
for (const m of MUTANTS) {
  const d = tree()
  const p = join(d, 'kernel/src', m.file ?? 'docstoreport.ts')
  const src = readFileSync(p, 'utf8')
  const n = src.split(m.from).length - 1
  ok(n === 1, `applies exactly once: ${m.name} (found ${n})`)
  if (n === 1) {
    let out = src.replace(m.from, () => m.to)
    for (const [f, t] of m.and ?? []) {
      const k = out.split(f).length - 1
      ok(k === 1, `  extra edit applies exactly once: ${m.name} (found ${k})`)
      out = out.replace(f, () => t)
    }
    writeFileSync(p, out)
    const r = run(d)
    const onRow = r.failLines.filter((l) => l.includes(m.row))
    ok(r.status !== 0 && onRow.length > 0, `killed on ${m.row}: ${m.name} — ${r.status === 0 ? 'GREEN' : `${onRow.length} FAIL on its row, ${r.failLines.length} in all`}${onRow[0] ? ` (${onRow[0].trim().slice(6, 90)})` : ''}`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
