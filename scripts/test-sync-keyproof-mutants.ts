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
const KP = 'kernel/src/sync/keyproof.ts', SS = 'kernel/src/sync/session.ts', ID = 'kernel/src/sync/idproof.ts'
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
    from: "      case 'p':\n        this.notePresence(f.a, f.p, f.kp, f)",
    to: "      case 'p':\n        this.notePresence(f.a, f.p, f.kp ?? (f.p as { kp?: unknown }).kp, f)" }] },
  { name: 'the peer record keeps a nested proof field', edits: [{ file: SS,
    from: '    this.peersMap.set(actor, { ...rest, actor, at: Date.now() })', to: '    this.peersMap.set(actor, { ...p, actor, at: Date.now() })' }] },
  { name: 'the relay revoked note is not passed on', edits: [{ file: 'kernel/src/sync/online.ts',
    from: "      if (typeof env.p === 'string' && env.p) this.hooks.onRevoked?.(env.p)\n", to: '' }] },
  { name: 'joinFromDoc does not wire revocations to the session', edits: [{ file: 'kernel/src/sync/online.ts',
    from: '      onRevoked: (pub) => session.noteRevoked(pub),\n', to: '' }] },
  { name: 'the sender never attaches a proof', edits: [{ file: SS,
    from: '          out = { ...frame, kp: await signProof(key, room!, this.actor, s!.pub, t) }', to: '          out = frame' }] },
  // ---- K-ID3b: the identity proof in presence (idproof.ts)
  { name: 'A4: resolve unproven pubs (the claimed key and any held proof)', edits: [{ file: SS,
    from: "    const id = this.peerIdentity(actor)\n    if (!id) return 'unproven'",
    to: "    const id = this.peerIdentity(actor) ?? (this as any).ids.claimed(actor)\n    if (!id) return 'unproven'" }, { file: ID,
    from: '  /** Has `actor` proven, in this session, that it holds the identity key `pub`? */',
    to: '  claimed(actor: string) { const st = this.actors.get(actor); const pr = st?.idh ? st.proofs.get(st.idh) : undefined; return st?.idk && pr ? { pub: st.idk, proof: pr } : null }\n  /** Has `actor` proven, in this session, that it holds the identity key `pub`? */' }] },
  { name: 'peerIdentity ignores whether the actor proved its key', edits: [{ file: ID,
    from: '    if (!st || !st.proven || !st.idk || !st.idh) return null', to: '    if (!st || !st.idk || !st.idh) return null' }] },
  { name: 'the possession proof is not verified', edits: [{ file: ID,
    from: '    return await crypto.subtle.verify(ALG, key, sig as BufferSource, te.encode(text))', to: '    return true || await crypto.subtle.verify(ALG, key, sig as BufferSource, te.encode(text))' }] },
  { name: 'the nonce leaves out the actor', edits: [{ file: ID,
    from: '`idpres.v1.${roomId}.${actor}.${idk}.${idh}.${t}`', to: '`idpres.v1.${roomId}.${idk}.${idh}.${t}`' }] },
  { name: 'the nonce leaves out the proof hash', edits: [{ file: ID,
    from: '`idpres.v1.${roomId}.${actor}.${idk}.${idh}.${t}`', to: '`idpres.v1.${roomId}.${actor}.${idk}.${t}`' }] },
  { name: "a proof is kept whatever the frame's idh says", edits: [{ file: ID,
    from: '        if (h !== null && h === idh) this.keep(actor, st, h, f.idp)', to: '        if (h !== null) this.keep(actor, st, idh, f.idp)' }] },
  { name: 'no freshness window for the identity proof', edits: [{ file: ID,
    from: "        if (typeof t !== 'number' || Math.abs(now - t) > PROOF_SKEW_MS) return", to: "        if (typeof t !== 'number') return" }] },
  { name: 'an older identity proof is accepted', edits: [{ file: ID,
    from: '        if (t < lastT || (st0?.strict && t === lastT)) return', to: '        if (st0?.strict && t === lastT) return' }] },
  { name: 'the same t with another signature is accepted', edits: [{ file: ID,
    from: '        if (t === lastT && !resent) return\n', to: '' }] },
  { name: 'a beat without ik keeps an earlier identity proof', edits: [{ file: ID,
    from: '        if (st0) st0.proven = false // until THIS beat proves it\n', to: '' }] },
  { name: 'a beat with no identity fields keeps an earlier identity proof', edits: [{ file: ID,
    from: '      if (st) { st.proven = false; st.idk = undefined; st.idh = undefined }', to: '      if (st) { st.idk = st.idk }' }] },
  { name: 'a peer that left keeps its identity (and its last ik replays)', edits: [
    { file: SS, from: '    return this.peersMap.has(actor) ? this.ids.peer(actor) : null', to: '    return this.ids.peer(actor)' },
    { file: SS, from: '          void this.ids.drop(f.a)\n', to: '' }] },
  { name: 'identity fields nested in presence are used', edits: [{ file: SS,
    from: "      case 'p':\n        this.notePresence(f.a, f.p, f.kp, f)", to: "      case 'p':\n        this.notePresence(f.a, f.p, f.kp, { ...(f.p as object), ...f })" }] },
  { name: 'the peer record keeps nested identity fields', edits: [{ file: SS,
    from: '    const { kp: _kp, idk: _k, idh: _h, ik: _i, idp: _p, ...rest }', to: '    const { kp: _kp, ...rest }' }] },
  { name: 'every beat carries the whole proof', edits: [{ file: SS,
    from: '    if (hello || this.idSendFull) { out.idp = me.proof; this.idSendFull = false }', to: '    { out.idp = me.proof; this.idSendFull = false }' }] },
  { name: 'useIdentity(null) keeps the earlier identity', edits: [{ file: SS,
    from: '    const gen = ++this.idGen\n    this.clearIdentity(false)\n', to: '    const gen = ++this.idGen\n' }] },
  { name: 'the signing key is not checked against the certified key', edits: [{ file: SS,
    from: '    if (!res || res.ok !== true || res.pub !== me.pub || typeof res.sig', to: '    if (!res || res.ok !== true || typeof res.sig' }] },
  { name: 'a hanging agent signature is not timed out', edits: [{ file: SS,
    from: '      new Promise<null>((r) => { timer = setTimeout(() => r(null), SyncSession.ID_SIGN_TIMEOUT_MS) }),\n', to: '' }] },
  { name: 'a new document keeps the old open\'s identities', edits: [{ file: SS,
    from: '    this.ids.reset()\n    this.clearIdentity()\n', to: '' }] },
  { name: 'asks repeat on every beat', edits: [{ file: ID,
    from: '          if (at === undefined || now - at >= ID_ASK_RETRY_MS) {', to: '          if (true) {' }] },
  { name: 'asks are answered without a cooldown', edits: [{ file: SS,
    from: '    if (wait <= 0) answer()', to: '    if (true) answer()' }] },
  { name: 'an ask for another hash is answered', edits: [{ file: SS,
    from: '    if (!me || f.to !== this.actor || f.h !== me.hash) return', to: '    if (!me) return' }] },
  // ---- security-review-1007
  { name: 'F1: a capped actor map evicts the oldest state, and unproven frames create state', edits: [{ file: ID,
    from: "        const st0 = this.actors.get(actor)\n        if (st0) st0.proven = false // until THIS beat proves it",
    to: "        if (!this.actors.has(actor)) { if (this.actors.size >= 256) this.actors.delete(this.actors.keys().next().value!); this.actors.set(actor, fresh()) }\n        const st0 = this.actors.get(actor)\n        if (st0) st0.proven = false // until THIS beat proves it" }] },
  { name: 'F2: the drop is applied at once, not behind a beat still verifying', edits: [{ file: ID,
    from: "    return this.enqueue(actor, () => {\n      const st = this.actors.get(actor)\n      if (st) { st.proven = false; st.strict = true }\n    })",
    to: "    const st = this.actors.get(actor)\n    if (st) { st.proven = false; st.strict = true }\n    return Promise.resolve()" }] },
  { name: 'F2: peerIdentity ignores presence', edits: [{ file: SS,
    from: '    return this.peersMap.has(actor) ? this.ids.peer(actor) : null', to: '    return this.ids.peer(actor)' }] },
  { name: 'F3: a stale whoami lands after useIdentity(null)', edits: [{ file: SS,
    from: "    try { me = await agent.whoami() } catch { me = null }\n    if (gen !== this.idGen) return me\n", to: "    try { me = await agent.whoami() } catch { me = null }\n" },
    { file: SS, from: "    const hash = me && typeof me.devicePub === 'string' && me.proof ? await proofHash(me.proof) : null\n    if (gen !== this.idGen) return me\n",
      to: "    const hash = me && typeof me.devicePub === 'string' && me.proof ? await proofHash(me.proof) : null\n" }] },
  { name: 'R1: only the check after the proof hash is dropped', edits: [{ file: SS,
    from: "    const hash = me && typeof me.devicePub === 'string' && me.proof ? await proofHash(me.proof) : null\n    if (gen !== this.idGen) return me\n",
      to: "    const hash = me && typeof me.devicePub === 'string' && me.proof ? await proofHash(me.proof) : null\n" }] },
  { name: 'F3: a signature finishing after withdrawal rides the beat', edits: [{ file: SS,
    from: "      ik = await this.signIdKey(me, room)\n      if (gen !== this.idGen) return {}\n", to: "      ik = await this.signIdKey(me, room)\n" }] },
  { name: 'F4: an unproven beat makes the receiver ask', edits: [{ file: ID,
    from: "        if (!roomId || !f.ik || typeof f.ik !== 'object') return\n", to: "        if (!roomId || !f.ik || typeof f.ik !== 'object') { ask = idh; return }\n" }] },
  { name: 'resend: the same ik is taken again however long ago it was first accepted', edits: [{ file: ID,
    from: '        if (resent && now - st0!.lastKeyAt > ID_RESEND_WINDOW_MS) return\n', to: '' }] },
  { name: 'n1: a verdict begun before reset lands in the new open', edits: [{ file: ID,
    from: "        const h = f.idp === undefined ? null : await proofHash(f.idp)\n        if (ep !== this.epoch) return\n", to: "        const h = f.idp === undefined ? null : await proofHash(f.idp)\n" },
    { file: ID, from: "    const next = (this.queues.get(actor) ?? Promise.resolve()).then(() => (ep === this.epoch ? fn() : undefined))", to: "    const next = (this.queues.get(actor) ?? Promise.resolve()).then(() => fn())" }] },
  { name: 'n2: a proof on an unproven beat is kept', edits: [{ file: ID,
    from: "        if (st0) st0.proven = false // until THIS beat proves it\n", to: "        if (st0) st0.proven = false // until THIS beat proves it\n        if (f.idp !== undefined && typeof f.idh === 'string') { const hh = await proofHash(f.idp); if (hh === f.idh) { let s2 = this.actors.get(actor); if (!s2) this.actors.set(actor, s2 = fresh()); this.keep(actor, s2, hh, f.idp) } }\n" }] },
  { name: 'n2: no cap on proofs held', edits: [{ file: ID,
    from: '    while (this.held.length > ID_MAX_PROOFS) {', to: '    while (false) {' }] },
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
