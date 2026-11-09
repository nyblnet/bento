#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the presence key proof (kernel/src/sync/keyproof.ts and
// its use in session.ts).
//
//   node scripts/test-sync-keyproof-mutants.ts
//
// Each mutant weakens one rule in a COPY of the sources; scripts/
// test-sync-keyproof.ts must then fail. The unmutated copy must pass first
// (positive control), and every edit must apply exactly once.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Edit = { file: string; from: string; to: string }
const KP = 'kernel/src/sync/keyproof.ts', SS = 'kernel/src/sync/session.ts'
const MUTANTS: Array<{ name: string; edits: Edit[] }> = [
  { name: 'the signature is not checked', edits: [{ file: KP,
    from: '    return await crypto.subtle.verify(ALG, key,', to: '    return true || await crypto.subtle.verify(ALG, key,' }] },
  { name: 'the proof text leaves out the actor', edits: [{ file: KP,
    from: '  `pres.v1.${roomId}.${actor}.${pub}.${t}`', to: '  `pres.v1.${roomId}.${pub}.${t}`' }] },
  { name: 'the proof text leaves out the room', edits: [{ file: KP,
    from: '  `pres.v1.${roomId}.${actor}.${pub}.${t}`', to: '  `pres.v1.${actor}.${pub}.${t}`' }] },
  { name: 'no freshness window', edits: [{ file: KP,
    from: " || Math.abs(this.now() - t) > PROOF_SKEW_MS) return", to: ') return' }] },
  { name: 'timestamps need not increase', edits: [
    { file: KP, from: "if (typeof t !== 'number' || t <= st.lastT ||", to: "if (typeof t !== 'number' ||" },
    { file: KP, from: ' || st.pub !== pub || t <= st.lastT) return', to: ' || st.pub !== pub) return' }] },
  { name: 'a beat without a valid proof keeps an earlier proof', edits: [{ file: KP,
    from: '      st.proven = false // until THIS beat proves it\n', to: '' }] },
  { name: 'an unproven beat keeps an earlier proof', edits: [{ file: KP,
    from: '      st.proven = false\n      st.pub = typeof pub', to: '      st.pub = typeof pub' }] },
  { name: 'a revocation is not recorded', edits: [{ file: KP,
    from: '    this.revoked.add(pub)\n    for (const st of this.actors.values()) if (st.pub === pub) st.proven = false\n', to: '' }] },
  { name: 'a revoked key can be proven again', edits: [
    { file: KP, from: '      if (!roomId || this.revoked.has(pub) || !kp) return', to: '      if (!roomId || !kp) return' },
    { file: KP, from: '      if (this.revoked.has(pub) || st.pub !== pub', to: '      if (st.pub !== pub' },
    { file: KP, from: ' && st.pub === pub && !this.revoked.has(pub)', to: ' && st.pub === pub' }] },
  { name: 'a revocation during verification is not re-checked', edits: [
    { file: KP, from: '      if (this.revoked.has(pub) || st.pub !== pub', to: '      if (st.pub !== pub' },
    { file: KP, from: ' && st.pub === pub && !this.revoked.has(pub)', to: ' && st.pub === pub' }] },
  { name: 'keyProven ignores which key is asked about', edits: [{ file: KP,
    from: " && typeof pub === 'string' && st.pub === pub && ", to: ' && ' }] },
  { name: 'a peer that left stays proven', edits: [
    { file: SS, from: '    return this.peersMap.has(actor) && this.proofs.proven(actor, pub)', to: '    return this.proofs.proven(actor, pub)' },
    { file: SS, from: '          this.proofs.drop(f.a)\n', to: '' }] },
  { name: 'a proof nested in presence is used', edits: [{ file: SS,
    from: "      case 'p':\n        this.notePresence(f.a, f.p, f.kp)",
    to: "      case 'p':\n        this.notePresence(f.a, f.p, f.kp ?? (f.p as { kp?: unknown }).kp)" }] },
  { name: 'the peer record keeps a nested proof field', edits: [{ file: SS,
    from: '    this.peersMap.set(actor, { ...rest, actor, at: Date.now() })', to: '    this.peersMap.set(actor, { ...p, actor, at: Date.now() })' }] },
  { name: 'the relay revoked note is not passed on', edits: [{ file: 'kernel/src/sync/online.ts',
    from: "      if (typeof env.p === 'string' && env.p) this.hooks.onRevoked?.(env.p)\n", to: '' }] },
  { name: 'joinFromDoc does not wire revocations to the session', edits: [{ file: 'kernel/src/sync/online.ts',
    from: '      onRevoked: (pub) => session.noteRevoked(pub),\n', to: '' }] },
  { name: 'the sender never attaches a proof', edits: [{ file: SS,
    from: '          out = { ...frame, kp: await signProof(key, room!, this.actor, s!.pub, t) }', to: '          out = frame' }] },
  { name: 'a member copy does not prove its device key', edits: [{ file: SS,
    from: '    if (c.v === 2 && c.invite) return cachedMemberIdentity(this.store.doc.docId) ?? null\n', to: '' }] },
]

function tree(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'keyproof-mutant-')))
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  cpSync(join(root, 'slides/src'), join(d, 'slides/src'), { recursive: true })
  for (const f of ['package.json', 'tsconfig.json']) if (existsSync(join(root, 'slides', f))) cpSync(join(root, 'slides', f), join(d, 'slides', f))
  if (existsSync(join(root, 'slides/node_modules'))) symlinkSync(realpathSync(join(root, 'slides/node_modules')), join(d, 'slides/node_modules'))
  mkdirSync(join(d, 'scripts'))
  cpSync(join(root, 'scripts/lib'), join(d, 'scripts/lib'), { recursive: true })
  cpSync(join(root, 'scripts/test-sync-keyproof.ts'), join(d, 'scripts/test-sync-keyproof.ts'))
  return d
}
function run(d: string) {
  const r = spawnSync(process.execPath, [join(d, 'scripts/test-sync-keyproof.ts')], { encoding: 'utf8', timeout: 120_000 })
  const tail = (r.stdout.match(/\d+\/\d+ checks passed/g) ?? []).pop() ?? `(no count; exit ${r.status})`
  return { status: r.status, tail, fails: (r.stdout.match(/^ {2}FAIL/gm) ?? []).length }
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  const r = run(d)
  ok(r.status === 0 && r.fails === 0 && /^(\d+)\/\1 /.test(r.tail), `test-sync-keyproof.ts: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants, each a weaker rule: every one must turn the rig red`)
for (const m of MUTANTS) {
  const d = tree()
  let applied = true
  for (const e of m.edits) {
    const p = join(d, e.file)
    const src = readFileSync(p, 'utf8')
    const n = src.split(e.from).length - 1
    if (n !== 1) { applied = false; ok(false, `applies exactly once: ${m.name} — ${e.file} (found ${n})`); continue }
    writeFileSync(p, src.replace(e.from, () => e.to))
  }
  if (applied) {
    const r = run(d)
    ok(r.status !== 0 && r.fails > 0, `killed: ${m.name} — ${r.status === 0 ? 'green' : `${r.fails} FAIL`}`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
