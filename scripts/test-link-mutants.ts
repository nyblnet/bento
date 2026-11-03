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

type Mutant = { name: string; file: 'link.ts'; from: string; to: string }
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
  { name: 'N stores a dev. naming another kx', file: 'link.ts',
    from: "  if (n.value.kx !== opts.offer.kx) return no('kx-mismatch')\n",
    to: "" },
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
