#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for bento/id over a MessagePort and the peer resolver
// (kernel/src/identityport.ts, and the rules it relies on in identity.ts,
// roster.ts and devices.ts).
//
//   node scripts/test-identityport-mutants.ts
//
// Each mutant loosens ONE rule in a COPY of kernel/src; scripts/test-
// identityport.ts must then fail ON THE ROW that guards the rule (a FAIL line
// carrying that row's tag), not merely somewhere. The unmutated copy passes
// first (positive control), every mutant must apply to exactly one place, and
// the mutated text is read back from the copy before the rig runs, so a
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
const PORT = 'identityport.ts', ID = 'identity.ts', ROS = 'roster.ts', DEV = 'devices.ts'
const MUTANTS: Mutant[] = [
  // K1 wire
  { name: 'extra keys accepted', row: '[K1 wire]',
    from: "!KEYS[op as Op].includes(Object.keys(m).sort().join(','))) return 'keys'", to: "false) return 'keys'" },
  { name: 'symbol keys accepted', row: '[K1 wire]',
    from: "  if (Object.getOwnPropertySymbols(m).length || !KEYS[op as Op]", to: "  if (!KEYS[op as Op]" },
  { name: 'any prototype is plain', row: '[K1 wire]', from: '  return p === Object.prototype || p === null\n', to: '  return true\n' },
  { name: 'getters inside a proof accepted', row: '[K1 wire]',
    from: "  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(m, k); if (!d || !('value' in d)) return false }\n", to: '' },
  { name: 'any op name', row: '[K1 wire]', from: "  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return 'op'\n",
    to: "  if (typeof op !== 'string' || !(op in KEYS)) return 'op'\n", and: [["  whoami: ['id,op,t,v'],\n", "  whoami: ['id,op,t,v'],\n  unwrap: ['id,op,t,v'],\n  share: ['id,op,t,v'],\n"]] },
  { name: 'any sign purpose', row: '[K1 wire]',
    from: "    if (typeof m.purpose !== 'string' || !(PURPOSES as readonly string[]).includes(m.purpose)) return 'purpose'\n", to: "    if (typeof m.purpose !== 'string') return 'purpose'\n" },
  { name: 'no payload cap', row: '[K1 wire]', from: " || m.payload.length > SIGN_PAYLOAD_MAX) return 'payload'", to: ") return 'payload'" },
  { name: 'a proof may carry extra keys (directoryKeys)', row: '[K1 wire]',
    from: "    if (!exact(p, ['chain', 'device'])) return null\n", to: "    if (!isPlain(p) || !('chain' in p) || !('device' in p)) return null\n" },
  { name: 'a hole in the chain read as a link', row: '[K1 wire]', from: '      if (!exact(l, LINK_REQUIRED, LINK_OPTIONAL)) return null\n', to: '      if (l === undefined) continue\n      if (!exact(l, LINK_REQUIRED, LINK_OPTIONAL)) return null\n' },
  { name: 'ids may repeat', row: '[K1 wire]', from: ' || id <= lastId) return', to: ' || id < lastId) return' },
  { name: 'no in-flight cap', row: '[K3 limits]', from: "    if (inFlight >= L.maxInFlight) return drop('in-flight')\n", to: '' },
  { name: 'no rate cap', row: '[K3 limits]', from: "    if (++inWindow > L.rateMax) return drop('rate')\n", to: '    ++inWindow\n' },
  { name: 'drops never close the session', row: '[K3 limits]', from: '    if (stats.dropped >= L.maxDrops) session.close()\n', to: '' },
  { name: 'closing leaves the port served', row: '[K3 limits]',
    from: '      closed = true\n      port.removeEventListener', to: '      port.addEventListener',
    and: [['  const onMessage = (e: MessageEvent) => {\n    if (closed) return\n', '  const onMessage = (e: MessageEvent) => {\n'],
      ['  const send = (m: Record<string, unknown>) => { if (!closed) port.postMessage', '  const send = (m: Record<string, unknown>) => { port.postMessage'],
      ['chain = chain.then(() => (closed ? undefined : handle(r)))', 'chain = chain.then(() => handle(r))']] },
  { name: 'a host that reads the origin', row: '[K1 wire]',
    from: '  const onMessage = (e: MessageEvent) => {\n    if (closed) return\n', to: "  const onMessage = (e: MessageEvent) => {\n    if (closed || e.origin === 'x') return\n" },
  // K2 binding
  { name: 'the docId read from the request when present', row: '[K2 binding]',
    from: "  whoami: ['id,op,t,v'],\n", to: "  whoami: ['id,op,t,v', 'docId,id,op,t,v'],\n",
    and: [["  if (op === 'whoami') return { id, op }\n", "  if (op === 'whoami') return (typeof m.docId === 'string' ? { id, op, docId: m.docId } : { id, op }) as IdentityRequest\n"],
      ['      try { a = await agent.whoami(ctx) } catch { a = null }\n', '      try { a = await agent.whoami({ ...ctx, docId: (r as { docId?: string }).docId ?? ctx.docId }) } catch { a = null }\n']] },
  { name: 'the entry is the docId', row: '[K2 binding]', from: '    entry: o.entry,\n', to: '    entry: o.docId ?? o.entry,\n' },
  { name: 'the context is not frozen', row: '[K2 binding]', from: '  const ctx: IdentityContext = Object.freeze({', to: '  const ctx: IdentityContext = ({' },
  // K3 consent
  { name: 'sign before consent reaches the agent', row: '[R3 consent]',
    from: "      if (!consented) { gate('before-consent'); return served({ id: r.id, result: { ok: false, reason: 'declined' } }) }\n", to: '' },
  { name: 'resolve before consent reaches the agent', row: '[R3 consent]',
    from: "    if (!consented) { gate('before-consent'); return served({ id: r.id, identity: null }) }\n", to: '' },
  { name: 'a declined whoami is not final', row: '[R3 consent]',
    from: "      if (declined) { gate('declined-final'); return served({ id: r.id, identity: null }) }\n", to: '' },
  { name: 'a whoami that threw counts as consent', row: '[R3 consent]',
    from: '      try { a = await agent.whoami(ctx) } catch { a = null }\n', to: '      try { a = await agent.whoami(ctx) } catch { a = identityOnThrow }\n',
    and: [['export const IDENTITY_T = ', "const identityOnThrow = { name: 'x@example.com', email: 'x@example.com', vouchedBy: 'id.bento.page', accountPub: 'x', devicePub: 'A'.repeat(87) }\nexport const IDENTITY_T = "]] },
  { name: 'invite/revoke passed to the agent', row: '[R3 consent]',
    from: "      if (PHASE2_PURPOSES.includes(r.purpose)) { gate('phase-2'); return served({ id: r.id, result: { ok: false, reason: 'unavailable' } }) }\n", to: '' },
  { name: 'the purpose matcher skipped', row: '[R3 consent]',
    from: "      if (!payloadMatchesPurpose(r.purpose, r.payload)) { gate('purpose');", to: "      if (false) { gate('purpose');" },
  // K4 filter
  { name: 'resolve answers forwarded unchecked', row: '[K4 filter]', from: '    const res = a === null ? null : checkResolved(a)\n', to: '    const res = a as ResolvedIdentity | null\n' },
  { name: 'sign answers forwarded unchecked', row: '[K4 filter]', from: '      const res = checkSign(a)\n', to: '      const res = (a ?? null) as SignResult | null\n' },
  { name: 'whoami answers forwarded unchecked', row: '[K4 filter]',
    from: '      const c = a === null ? { identity: null, capped: false } : checkPublic(a)\n', to: '      const c = { identity: a as PublicIdentity | null, capped: false }\n' },
  { name: 'a whoami proof over the cap is kept', row: '[K4 filter]',
    from: "    if (p !== null && p !== 'cap') identity.proof = p\n", to: "    if (p !== null) identity.proof = raw as IdentityProof\n" },
  { name: 'resolve with a proof over the cap reaches the agent', row: '[K4 filter]',
    from: "    if (r.proof === 'cap') { gate('proof-cap'); return served({ id: r.id, identity: null }) }\n", to: '' },
  { name: 'checkResolved drops unconfirmedSince', row: '[K4 filter]', file: ID, from: '    for (const f of RESOLVED_G1_FIELDS) {\n', to: "    for (const f of RESOLVED_G1_FIELDS.filter((x) => x !== 'unconfirmedSince')) {\n" },
  // K5 anchor
  { name: 'an anchor from a pin past seq 0', row: '[K5 anchor]', file: ROS,
    from: '  if (!h || h.seq !== 0 || state.createdAt === null || typeof h.hash', to: '  if (!h || typeof h.hash' },
  { name: 'the anchor is the latest head', row: '[K5 anchor]', file: ROS,
    from: '  const h = state && Array.isArray(state.heads) ? state.heads[0] : undefined\n',
    to: '  const h = state && Array.isArray(state.heads) ? state.heads[state.heads.length - 1] : undefined\n',
    and: [['  if (!h || h.seq !== 0 || state.createdAt === null || typeof h.hash', '  if (!h || state.createdAt === null || typeof h.hash']] },
  { name: 'a reset counted as a roster change', row: '[K5 anchor]', file: ROS, from: "    if (r.value.auth === 'r') continue\n", to: '' },
  { name: 'the not-continuity text removed', row: '[K5 anchor]', file: ID, from: ' * THE ANCHOR IS NOT CONTINUITY OF THE PERSON.', to: ' * The anchor.' },
  // K6 g1
  { name: 'a bad G field keeps the marker', row: '[K6 compose]', file: ID, from: '      else whole = false\n', to: '' },
  { name: 'the marker without the anchor shape', row: '[K6 compose]', file: ID, from: ' && whole && ACCOUNT_ANCHOR_RE.test(accountPub)) out.fields = marker', to: ' && whole) out.fields = marker' },
  { name: 'checkResolved adds a missing marker', row: '[K6 compose]', file: ID,
    from: '    if (marker === RESOLVED_FIELDS && whole && ACCOUNT_ANCHOR_RE.test(accountPub)) out.fields = marker\n',
    to: '    if (whole && ACCOUNT_ANCHOR_RE.test(accountPub)) out.fields = RESOLVED_FIELDS\n' },
  { name: 'the marker read through a getter or the prototype', row: '[K6 compose]', file: ID,
    from: "    const marker = own(r, 'fields')\n", to: "    const marker = (r as Record<string, unknown>).fields\n" },
  { name: 'revoked accepts null', row: '[K6 compose]', file: ID, from: "  revoked: (v: unknown) => v === false || v ===", to: "  revoked: (v: unknown) => v === null || v === false || v ===" },
  { name: 'times may be any number', row: '[K6 compose]', file: ID,
    from: "const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_TIME\n",
    to: "const isTime = (v: unknown): v is number => typeof v === 'number'\n" },
  { name: 'unknown keys forwarded', row: '[K6 compose]', file: ID,
    from: '    const out: ResolvedIdentity = { name, email, vouchedBy, accountPub, firstSeen, changed }\n',
    to: '    const out: ResolvedIdentity = { ...(r as ResolvedIdentity), name, email, vouchedBy, accountPub, firstSeen, changed }\n    delete (out as { fields?: string }).fields\n' },
  { name: 'composeResolved accepts a K2 point', row: '[K6 compose]', file: ID,
    from: "  if (!f || typeof f.address !== 'string' || !ACCOUNT_ANCHOR_RE.test(f.anchor)) return null\n", to: "  if (!f || typeof f.address !== 'string') return null\n",
    and: [['  return c && c.fields === RESOLVED_FIELDS ? c : null\n', '  return c\n']] },
  { name: 'an unknown account age left out and the marker kept', row: '[K7 absent]', file: ID,
    from: '  if (f.accountSince === null) return null\n', to: '',
    and: [['    accountSince: f.accountSince,\n', '    ...(f.accountSince === null ? {} : { accountSince: f.accountSince }),\n']] },
  { name: 'unconfirmedSince omitted', row: '[K6 compose]', file: ID, from: '  if (f.mb !== 0) a.unconfirmedSince = f.mb\n', to: '' },
  { name: 'composeResolved writes unconfirmedSince 0', row: '[K6 compose]', file: ID, from: '  if (f.mb !== 0) a.unconfirmedSince = f.mb\n', to: '  a.unconfirmedSince = f.mb\n' },
  { name: 'a second marker setter in the relay', row: '[K6 compose]', file: PORT,
    from: '    const res = a === null ? null : checkResolved(a)\n', to: "    const res = a === null ? null : checkResolved(a)\n    if (res && res.accountPub.startsWith('g:')) res.fields = 'g1'\n" },
  // K7 resolve
  { name: 'the pub binding removed', row: '[R1b resolve]', file: PORT, from: "    if (dv.value.cert.devicePub !== pub) return miss('pub')\n", to: '' },
  { name: 'a chain from a pin anchors', row: '[R1b resolve]', file: PORT,
    from: '    const ch = await verifyRosterChain(proof.chain, common)\n',
    to: '    const ch = await verifyRosterChain(proof.chain, { ...common, pinned: await sha256b64u(proof.chain[0].ros) })\n',
    and: [["import { payloadMatchesPurpose } from './statements.ts'\n", "import { payloadMatchesPurpose, sha256b64u } from './statements.ts'\n"],
      ['  if (!h || h.seq !== 0 || state.createdAt === null || typeof h.hash', '  if (!h || typeof h.hash'],
      // three guards refuse a chain from a pin (no pin given, accountAnchor's seq 0, a null accountSince failing
      // composeResolved): they are redundant on purpose, so this mutant loosens all three together
      ['accountSince: b.state.createdAt,', 'accountSince: b.state.createdAt ?? b.state.ripenedAt,']] },
  { name: 'the proof\'s own keys trusted (any watt. signer)', row: '[R1b resolve]', file: PORT,
    from: '    const dv = await verifyDevice(proof.device as DeviceProof, { ...common, roster: b.state })\n',
    to: '    const dv = await verifyDevice(proof.device as DeviceProof, { ...common, directoryKeys: { ...common.directoryKeys, [(proof.device.watt.split(".")[6])]: "" }, roster: b.state })\n',
    and: [["  if (!(await verifyStatementSig(opts.directoryKeys[watt.kid], proof.wattSig, proof.watt))) return no('watt-signature')\n",
      "  if (opts.directoryKeys[watt.kid] !== '' && !(await verifyStatementSig(opts.directoryKeys[watt.kid], proof.wattSig, proof.watt))) return no('watt-signature')\n"]] },
  { name: 'no proof cap', row: '[R1b resolve]', file: PORT,
    from: "    if (over || new TextEncoder().encode(JSON.stringify(p)).length > PROOF_MAX_BYTES) return 'cap'\n", to: '',
    and: [['      if (over) return \'cap\'\n', '']] },
  { name: 'the cap counts characters', row: '[R1b resolve]', file: PORT,
    from: '    if (over || new TextEncoder().encode(JSON.stringify(p)).length > PROOF_MAX_BYTES)', to: '    if (over || JSON.stringify(p).length > PROOF_MAX_BYTES)' },
  { name: 'a second cap constant', row: '[R1b resolve]', file: PORT, from: "export const SIGN_PAYLOAD_MAX = 4096\n", to: "export const SIGN_PAYLOAD_MAX = 4096\nexport const PROOF_CAP_COPY = 64 * 1024\n" },
  { name: 'the resolver throws', row: '[R1b resolve]', file: PORT, from: "      try { return await run(q) } catch { return miss('error') }\n", to: '      return await run(q)\n' },
  // A3
  { name: 'judged against the presented chain only', row: '[A3 longest]', file: PORT, from: '{ ...common, roster: b.state })', to: '{ ...common, roster: ch.value })' },
  { name: 'first chain wins (no fork detection)', row: '[A3 fork]', file: PORT,
    from: "      else if (!prefix(hashes, b.hashes)) { b.forked = true; stats.forks++; return miss('fork') }\n", to: '' },
  { name: 'a fork poisons only the forked proof', row: '[A3 fork]', file: PORT, from: "    if (b?.forked) return miss('fork')\n", to: '' },
  // A5
  { name: 'name from the certificate label', row: '[A5 name]', file: PORT,
    from: '      address, anchor, tier: dv.value.tier,', to: '      address: dv.value.cert.label ?? address, anchor, tier: dv.value.tier,' },
  { name: 'vouchedBy not the constant', row: '[A5 name]', file: ID, from: "export const G_VOUCHER = 'id.bento.page'", to: "export const G_VOUCHER = 'bento.page'" },
  // A6
  { name: 'the lever ignores ob', row: '[A6 incident]', file: DEV, from: '  if (watt.ob !== 1) return false\n', to: '' },
  { name: 'the lever takes native keys', row: '[A6 incident]', file: DEV,
    from: "  if (!(cert.kind === 'wdev' || (cert.kind === 'dev2' && cert.via === 'passkey'))) return false\n", to: '' },
  { name: 'the window\'s end exclusive', row: '[A6 incident]', file: DEV, from: '(i.to === null || t <= i.to)', to: '(i.to === null || t < i.to)' },
  { name: 'only the ceremony counts', row: '[A6 incident]', file: DEV, from: '  return inWindow(cert.ceremonyAt) || inWindow(watt.loggedAt)\n', to: '  return inWindow(cert.ceremonyAt)\n' },
  { name: 'only the log time counts', row: '[A6 incident]', file: DEV, from: '  return inWindow(cert.ceremonyAt) || inWindow(watt.loggedAt)\n', to: '  return inWindow(watt.loggedAt)\n' },
  { name: 'records taken unverified', row: '[A6 incident]', file: PORT,
    from: '      if (inc.ok && leverCovers(dv.value.cert, dv.value.watt, inc.value as Incident))',
    to: "      const parts = rec.text.split('.'); const raw = { id: parts[1], from: Number(parts[2]), to: parts[3] === '' ? null : Number(parts[3]), issuedAt: 0, kid: '' }\n      if (parts[0] === 'inc' && leverCovers(dv.value.cert, dv.value.watt, inc.ok ? inc.value as Incident : raw))" },
  // A7
  { name: 'own status applied to every anchor', row: '[A7 own]', file: PORT, from: '    if (mine && mine.anchor === anchor && mine.revoked', to: '    if (mine && mine.revoked' },
  // tofu
  { name: 'firstSeen is every resolve', row: '[tofu]', file: PORT, from: '    const firstSeen = prevPub?.firstSeen ?? now\n', to: '    const firstSeen = now\n' },
  { name: 'a new anchor for a pub is not a change', row: '[tofu]', file: PORT,
    from: '    const changed = (prevPub !== undefined && prevPub.anchor !== anchor) || ', to: '    const changed = ' },
]

function tree() {
  const d = mkdtempSync(join(tmpdir(), 'identityport-mut-'))
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  return d
}
function run(d: string) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/test-identityport.ts')], { encoding: 'utf8', env: { ...process.env, BENTO_KERNEL_SRC: join(d, 'kernel/src') }, timeout: 180_000 })
  const out = r.stdout ?? ''
  const tail = (out.match(/\d+\/\d+ checks passed/g) ?? []).pop() ?? `(no count; exit ${r.status}) ${(r.stderr ?? '').split('\n').find((l) => /Error/.test(l)) ?? ''}`
  return { status: r.status, tail, failLines: out.split('\n').filter((l) => /^ {2}FAIL/.test(l)) }
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  const r = run(d)
  ok(r.status === 0 && r.failLines.length === 0 && /^(\d+)\/\1 checks passed$/.test(r.tail), `test-identityport.ts: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

const only = process.env.MUTANT
const list = only ? MUTANTS.filter((m) => m.name.includes(only)) : MUTANTS
console.log(`\n${list.length} mutants, each one loosened rule: every one must turn its own row red`)
for (const m of list) {
  const d = tree()
  const p = join(d, 'kernel/src', m.file ?? PORT)
  const src = readFileSync(p, 'utf8')
  const n = src.split(m.from).length - 1
  ok(n === 1, `applies exactly once: ${m.name} (found ${n})`)
  if (n === 1) {
    let out = src.replace(m.from, () => m.to)
    let applied = true
    for (const [f, t] of m.and ?? []) {
      // an extra edit may land in another file of the copy (named by where it is found)
      const k = out.split(f).length - 1
      if (k === 1) { out = out.replace(f, () => t); continue }
      let placed = false
      for (const other of [PORT, ID, ROS, DEV].filter((x) => x !== (m.file ?? PORT))) {
        const op = join(d, 'kernel/src', other)
        const os = readFileSync(op, 'utf8')
        if (os.split(f).length - 1 === 1) { writeFileSync(op, os.replace(f, () => t)); placed = true; break }
      }
      ok(placed, `  extra edit applies exactly once: ${m.name}`)
      applied &&= placed
    }
    writeFileSync(p, out)
    // the mutated text is really in the copy the rig reads
    ok(readFileSync(p, 'utf8').includes(m.to) && (m.to === '' ? !readFileSync(p, 'utf8').includes(m.from) : true), `  mutated text is in the copy: ${m.name}`)
    if (applied) {
      const r = run(d)
      const onRow = r.failLines.filter((l) => l.includes(m.row))
      ok(r.status !== 0 && onRow.length > 0, `killed on ${m.row}: ${m.name} — ${r.status === 0 ? 'GREEN' : `${onRow.length} FAIL on its row, ${r.failLines.length} in all (${r.tail})`}${onRow[0] ? ` (${onRow[0].trim().slice(6, 100)})` : ''}`)
    }
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
