#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for link v1 (kernel/src/link.ts, security §39.1).
//
//   node scripts/test-link-mutants.ts
//
// Each mutant below reintroduces one lenient path into a COPY of kernel/src
// (the code left out of the key salt, an AAD without the message number, a
// late spend, a frozen binding that still releases, an N that stores a dev. it
// never asked for...), and scripts/test-link.ts must then fail. The unmutated
// copy must pass first (positive control), and every mutant must apply to
// exactly one place in the source, so a refactor that moves the code makes this
// rig fail rather than pass vacuously.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Mutant = { name: string; file: 'link.ts' | 'recovery.ts' | 'statements.ts'; from: string; to: string }
const MUTANTS: Mutant[] = [
  { name: 'the code is left out of the key salt', file: 'link.ts',
    from: "    h2n: await hkdf(z, salt, `bento/id/link/v1/h2n.${t}`),",
    to: "    h2n: await hkdf(z, EMPTY, `bento/id/link/v1/h2n.${t}`)," },
  { name: 'the SAS is derived without the code', file: 'link.ts',
    from: "  const sasKey = await hkdf(z, salt, `bento/id/link/v1/sas.${t}`)",
    to: "  const sasKey = await hkdf(z, EMPTY, `bento/id/link/v1/sas.${t}`)" },
  { name: 'the transcript omits the displayer role', file: 'link.ts',
    from: "  return sha256b64u(`lnkt.v1.${id}.${eD}.${eS}.${roleD}`)",
    to: "  return sha256b64u(`lnkt.v1.${id}.${eD}.${eS}`)" },
  { name: 'a reflected ephemeral gets a transcript', file: 'link.ts',
    from: "  if (eD === eS || (roleD !== 'H' && roleD !== 'N')) return null",
    to: "  if (roleD !== 'H' && roleD !== 'N') return null" },
  { name: 'the AAD drops the message number', file: 'link.ts',
    from: "export const linkAad = (t: string, n: LinkMsgNo): string => `lnka.v1.${t}.${n}`",
    to: "export const linkAad = (t: string, n: LinkMsgNo): string => `lnka.v1.${t}`" },
  { name: 'one key seals both directions', file: 'link.ts',
    from: "const keyFor = (keys: LinkKeys, n: LinkMsgNo) => (n === 2 ? keys.n2h : keys.h2n)",
    to: "const keyFor = (keys: LinkKeys, n: LinkMsgNo) => keys.h2n" },
  { name: 'the scanner trusts the claimed role', file: 'link.ts',
    from: "  return roleD === 'H' ? !scannerHoldsAccount : roleD === 'N' && scannerHoldsAccount",
    to: "  return roleD === 'H' || roleD === 'N'" },
  { name: 'the consent PoP is never checked', file: 'link.ts',
    from: "  if (consentPub !== null && !(await verifyStatementSig(consentPub, popConsentF, pop))) return no('pop-consent')\n",
    to: "" },
  { name: 'the directory spends the challenge late', file: 'link.ts',
    from: "  if (!opts.spend(opts.challenge)) return no('replay')\n  if (opts.state !== 'active') return no('state')",
    to: "  if (opts.state !== 'active') return no('state')\n  if (!opts.spend(opts.challenge)) return no('replay')" },
  { name: 'a frozen or pending binding still releases', file: 'link.ts',
    from: "  if (opts.state !== 'active') return no('state')\n",
    to: "" },
  { name: 'H may be a device of another account', file: 'link.ts',
    from: "  if (h.value.accountPub !== bind.value.accountPub) return no('h-account')\n",
    to: "" },
  { name: "N's dev. may name another account", file: 'link.ts',
    from: "  if (n.value.accountPub !== bind.value.accountPub) return no('n-account')\n",
    to: "" },
  { name: 'N stores a dev. naming another devicePub', file: 'link.ts',
    from: "  if (n.value.devicePub !== opts.offer.devicePub) return no('device-mismatch')\n",
    to: "" },
  { name: 'N stores a dev. naming another consentPub', file: 'link.ts',
    from: "  if (n.value.consentPub !== opts.offer.consentPub) return no('consent-mismatch')\n",
    to: "" },
  { name: 'a malformed served binding is used anyway', file: 'link.ts',
    from: "  if (!bind.ok) return no('bind')\n",
    to: "" },
  { name: 'msg1 takes any field as a point', file: 'link.ts',
    from: "  if (!p) return no('grammar')\n  if (!(await isKxKey(p[1]))) return no('key')\n  return { ok: true, value: { eS: p[1] } }",
    to: "  if (!p) return no('grammar')\n  return { ok: true, value: { eS: p[1] } }" },
  { name: 'msg3 lines skip the printable gate', file: 'link.ts',
    from: "  if (l.length !== 8 || l[0] !== 'lnk3' || !l.every(printable)) return null",
    to: "  if (l.length !== 8 || l[0] !== 'lnk3') return null" },
  { name: 'the printable gate admits space and controls', file: 'link.ts',
    from: "    if (c < 0x21 || c > 0x7e) return false",
    to: "    if (c > 0x7e) return false" },
  { name: "N's dev. may re-issue H's own device key", file: 'link.ts',
    from: "  if (n.value.devicePub === h.value.devicePub) return no('n-device-is-h')\n",
    to: "" },
  { name: 'N stores a dev. naming another kx', file: 'link.ts',
    from: "  if (n.value.kx !== opts.offer.kx) return no('kx-mismatch')\n",
    to: "" },
  // security §26c.4: SEALED is the account scalar and the address, never account ‖ recovery kx
  { name: 'a SEALED with no address is accepted', file: 'link.ts',
    from: "export const SEALED_MIN_LEN = 12 + LINK_SCALAR_LEN + 1 + 16",
    to: "export const SEALED_MIN_LEN = 12 + LINK_SCALAR_LEN + 16" },
  { name: 'SEALED has no lower bound', file: 'link.ts',
    from: "sealedLen < SEALED_MIN_LEN || sealedLen > SEALED_MAX_LEN) return null",
    to: "sealedLen > SEALED_MAX_LEN) return null" },
  { name: 'SEALED has no upper bound', file: 'link.ts',
    from: "sealedLen < SEALED_MIN_LEN || sealedLen > SEALED_MAX_LEN) return null",
    to: "sealedLen < SEALED_MIN_LEN) return null" },
  { name: "openFinal accepts an address whose binding's accountPub is not the scalar's", file: 'link.ts',
    from: "  const u = await unpackAccountScalar(pt.subarray(0, LINK_SCALAR_LEN), b.value.accountPub)\n  if (!u.ok) return u\n  if (n.value.accountPub !== b.value.accountPub) return no('account')\n",
    to: "  const u = await unpackAccountScalar(pt.subarray(0, LINK_SCALAR_LEN), n.value.accountPub)\n  if (!u.ok) return u\n" },
  { name: 'N stores a dev. under another account than the binding', file: 'link.ts',
    from: "  if (n.value.accountPub !== b.value.accountPub) return no('account')\n",
    to: "" },
  { name: 'an address that is not normal is accepted', file: 'link.ts',
    from: "  return isNormalAddress(address) ? address : null\n",
    to: "  return address\n" },
  { name: 'SEALED address bytes decode leniently', file: 'link.ts',
    from: "  try { address = strictUtf8.decode(pt.subarray(LINK_SCALAR_LEN)) } catch { return null }\n",
    to: "  address = new TextDecoder().decode(pt.subarray(LINK_SCALAR_LEN))\n" },
  { name: 'a byte-order mark is swallowed', file: 'link.ts',
    from: "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })",
    to: "new TextDecoder('utf-8', { fatal: true })" },
  { name: 'a binding for another address is used', file: 'link.ts',
    from: "  if (b.value.address !== address) return no('address-mismatch')\n",
    to: "" },
  { name: 'the binding signature is not checked', file: 'link.ts',
    from: "  const b = await verifyBind(a.bindText, a.bindSig, { now: opts.now })\n",
    to: "  const b = await parseBind(a.bindText)\n" },
  { name: 'the directory attestation is not checked (no pinned key)', file: 'link.ts',
    from: "  if (!att.ok) return no(`att-${att.reason}`)\n  if (att.value.state !== 'active') return no('state')\n",
    to: "" },
  { name: 'a frozen or pending binding is stored', file: 'link.ts',
    from: "  if (att.value.state !== 'active') return no('state')\n",
    to: "" },
  { name: 'unpackAccountScalar takes any length', file: 'recovery.ts',
    from: "  if (pt.length !== 32) return no('length')\n  if (!scalarInRange(pt)) return no('scalar-range')\n  if (typeof accountPub",
    to: "  if (!scalarInRange(pt)) return no('scalar-range')\n  if (typeof accountPub" },
  { name: "N takes a scalar the binding's accountPub does not name", file: 'recovery.ts',
    from: "  if (typeof accountPub !== 'string' || !(await scalarMatches(pt, accountPub, subtle))) return no('key-mismatch')\n",
    to: "" },
  // the slot wire
  { name: 'msg0/msg1 accept padded base64url', file: 'link.ts',
    from: "    const b = b64uDec(wire)\n    if (!b || b.length > MAX_SLOT_MSG) return no('grammar')",
    to: "    const b = b64uDec(wire.replace(/=+$/, ''))\n    if (!b || b.length > MAX_SLOT_MSG) return no('grammar')" },
  { name: 'base64url decoding ignores trailing bits', file: 'statements.ts',
    from: "  return b64uEnc(out) === s ? out : null",
    to: "  return out" },
  { name: 'msg0/msg1 decode as lenient UTF-8', file: 'link.ts',
    from: "    try { text = strictUtf8.decode(b) } catch { return no('grammar') } // a byte-order mark stays, and fails the prefix\n  } else text = wire",
    to: "    text = new TextDecoder().decode(b)\n  } else text = wire" },
  { name: 'a raw msg0/msg1 is taken as sent', file: 'link.ts',
    from: "  if (n === 0 || n === 1) {\n    const b = b64uDec(wire)",
    to: "  if ((n === 0 || n === 1) && !wire.startsWith('lnk')) {\n    const b = b64uDec(wire)" },
  { name: 'the 4 KB limit is not applied to the decoded text', file: 'link.ts',
    from: "  if (te.encode(text).length > MAX_SLOT_MSG) return false\n",
    to: "  if (te.encode(text).length > 2 * MAX_SLOT_MSG) return false\n" },
  { name: 'msg2 is measured as its wire text', file: 'link.ts',
    from: "return !!b && b.length >= 12 + 16 && b.length <= MAX_SLOT_MSG }",
    to: "return !!b && b.length >= 12 + 16 && text.length <= MAX_SLOT_MSG }" },
  { name: 'msg2 has no upper limit', file: 'link.ts',
    from: "return !!b && b.length >= 12 + 16 && b.length <= MAX_SLOT_MSG }",
    to: "return !!b && b.length >= 12 + 16 }" },
  { name: 'msg2 may be shorter than an iv and a tag', file: 'link.ts',
    from: "return !!b && b.length >= 12 + 16 && b.length <= MAX_SLOT_MSG }",
    to: "return !!b && b.length <= MAX_SLOT_MSG }" },
  { name: 'msg3 needs no line feed', file: 'link.ts',
    from: "  if (n === 3) return text.startsWith('lnk3\\n')\n",
    to: "  if (n === 3) return text.startsWith('lnk3')\n" },
  { name: 'a msg0 passes under number 1', file: 'link.ts',
    from: "  if (n === 1) return text.startsWith('lnk1.')\n",
    to: "  if (n === 1) return text.startsWith('lnk')\n" },
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'link-mutant-'))
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  cpSync(join(root, 'kernel/fixtures'), join(d, 'kernel/fixtures'), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  for (const f of ['test-link.ts']) cpSync(join(root, 'scripts', f), join(d, 'scripts', f))
  return d
}
/** Run the rig in a tree; returns its exit status and its printed count line. */
function run(d: string) {
  return ['test-link.ts'].map((f) => {
    const r = spawnSync(process.execPath, [join(d, 'scripts', f)], { encoding: 'utf8' })
    const tail = (r.stdout.match(/\d+\/\d+ checks passed|\d+ of \d+ checks FAILED|\d+\/\d+[^\n]*/g) ?? []).pop() ?? `(no count; exit ${r.status})`
    return { f, status: r.status, tail, fails: (r.stdout.match(/^ {2}FAIL/gm) ?? []).length }
  })
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  for (const r of run(d)) ok(r.status === 0 && r.fails === 0, `${r.f}: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants, each a lenient path link v1 forbids: every one must turn the rig red`)
for (const m of MUTANTS) {
  const d = tree()
  const p = join(d, 'kernel/src', m.file)
  const src = readFileSync(p, 'utf8')
  const n = src.split(m.from).length - 1
  ok(n === 1, `applies exactly once: ${m.name} (found ${n})`)
  if (n === 1) {
    writeFileSync(p, src.replace(m.from, () => m.to))
    const rs = run(d)
    const killedBy = rs.filter((r) => r.status !== 0 && r.fails > 0)
    ok(killedBy.length > 0, `killed: ${m.name} — ${rs.map((r) => `${r.f} ${r.status === 0 ? 'green' : `${r.fails} FAIL`}`).join(', ')}`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
