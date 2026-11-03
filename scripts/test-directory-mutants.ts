#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the directory's rotation grace, rekey retry and young-code
// rules (server/directory/src).
//
//   node scripts/test-directory-mutants.ts
//
// Each mutant below reopens one path into a COPY of the tree, and the two
// directory rigs must then report a failed row. The unmutated copy must pass first
// (positive control), every mutant must apply to exactly one place, so a refactor
// that moves the code turns this rig red rather than letting it pass vacuously, and
// a rig that crashes prints no count, which is not a kill.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RIGS = ['test-directory-keys.ts', 'test-directory.ts']
const TREE = ['kernel/src', 'kernel/fixtures', 'server/directory/src']
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Mutant = { name: string; file: 'worker.js' | 'account.js' | 'consent.js'; from: string; to: string }
const MUTANTS: Mutant[] = [
  { name: "assert: no key compare", file: "worker.js",
    from: "(cred.accountPub !== a.accountPub && !grace)",
    to: "false" },
  { name: "assert: grace for any key", file: "worker.js",
    from: "const grace = !!cred && !!a.graceKey && cred.accountPub === a.graceKey",
    to: "const grace = !!cred && !!a.graceKey" },
  { name: "consent: graceKey not sent to assert", file: "consent.js",
    from: "graceKey: o.graceKey ?? null, ",
    to: "" },
  { name: "grace ops: all consent ops", file: "worker.js",
    from: "const g = GRACE_OPS.includes(subject.op) ? await s.get('grace') : null",
    to: "const g = await s.get('grace')" },
  { name: "grace ops: cred-del added", file: "worker.js",
    from: "Object.freeze(['cred-add'])\n",
    to: "Object.freeze(['cred-add', 'cred-del'])\n" },
  { name: "rotateStart given grace", file: "worker.js",
    from: "scope: a.scope, accountPub: cur.b.key, purpose: 'rotate',",
    to: "scope: a.scope, accountPub: cur.b.key, graceKey: (await s.get('grace'))?.key, purpose: 'rotate'," },
  { name: "grace length 31d", file: "worker.js",
    from: "graceMs: 30 * 86_400_000",
    to: "graceMs: 31 * 86_400_000" },
  { name: "grace from discovery not settle", file: "worker.js",
    from: "until = rot.until + LIMITS.graceMs",
    to: "until = now + LIMITS.graceMs" },
  { name: "lapse off by one", file: "worker.js",
    from: "if (g && now >= g.until) await endGrace(g)",
    to: "if (g && now > g.until) await endGrace(g)" },
  { name: "lapse removed", file: "worker.js",
    from: "if (g && now >= g.until) await endGrace(g)",
    to: "void g" },
  { name: "credLanded does nothing", file: "worker.js",
    from: "      const g = await s.get('grace')\n      if (g) await endGrace(g)\n      return out(200, { ok: true })",
    to: "      return out(200, { ok: true })" },
  { name: "route never calls credLanded", file: "account.js",
    from: "try { await call(addressStub(env, a.scope), 'credLanded', {}) } catch (e) { console.log(`credLanded failed: ${e.message}`) }",
    to: "" },
  { name: "credAdd grace-over removed", file: "account.js",
    from: "      if (a.grace === true && (await holds(a.accountPub))) return refuse('grace-over')\n      const ever = await everKey(a.accountPub)\n      await s.put('creds'",
    to: "      const ever = await everKey(a.accountPub)\n      await s.put('creds'" },
  { name: "credAdd owner not recorded", file: "account.js",
    from: "      await s.put('owners', { ...((await s.get('owners')) || {}), [a.key]: a.accountPub })\n",
    to: "" },
  { name: "credDel keeps owner", file: "account.js",
    from: "      await s.put('owners', owners)\n      return out(200, { ok: true })",
    to: "      return out(200, { ok: true })" },
  { name: "wipe keeps owners", file: "account.js",
    from: "await s.delete(a.keepRc ? ['creds', 'owners', 'led'] : ['creds', 'owners', 'rc',",
    to: "await s.delete(a.keepRc ? ['creds', 'led'] : ['creds', 'rc'," },
  { name: "rekey ignores keep", file: "account.js",
    from: "const stays = creds.filter((k) => keep.includes(owners[k]))",
    to: "const stays = []" },
  { name: "rekey rc always", file: "account.js",
    from: "if (a.rc === true && rc && !keep.includes(rc.accountPub))",
    to: "if (rc && !keep.includes(rc.accountPub))" },
  { name: "rekey rc never", file: "account.js",
    from: "if (a.rc === true && rc && !keep.includes(rc.accountPub))",
    to: "if (false)" },
  { name: "blob: stale check removed", file: "account.js",
    from: "if (st.body.accountPub !== r.body.accountPub) return json(400, { error: 'invalid', reason: 'stale' })",
    to: "" },
  { name: "blob: live check removed", file: "account.js",
    from: "if (!st.body.live) return json(400, { error: 'invalid', reason: 'orphaned' })",
    to: "" },
  { name: "settle: no grace", file: "worker.js",
    from: "await s.put('grace', { key: cur.b.key, next: rot.b.key, until, scope })",
    to: "" },
  { name: "settle: no alarm", file: "worker.js",
    from: "      await s.setAlarm(until)\n",
    to: "" },
  { name: "settle: older key not dropped", file: "worker.js",
    from: "if (was || (await s.get('rekey'))) {",
    to: "if (false) {" },
  { name: "second rotation keeps only next", file: "worker.js",
    from: "await queueRekey(scope, [cur.b.key, rot.b.key], { notice: !!was })",
    to: "await queueRekey(scope, [rot.b.key], { notice: !!was })" },
  { name: "rebound keeps grace", file: "worker.js",
    from: "      if (!this.env.ACCOUNT) return\n      await s.delete('grace')\n",
    to: "      if (!this.env.ACCOUNT) return\n" },
  { name: "freeze keeps grace", file: "worker.js",
    from: "if (g) await endGrace(g) // and any grace",
    to: "// and any grace" },
  { name: "tombstone keeps grace", file: "worker.js",
    from: "'rsv', 'setup', 'grace'])",
    to: "'rsv', 'setup'])" },
  { name: "endGrace no notice", file: "worker.js",
    from: "await queueRekey(g.scope, [g.next], { notice: true })",
    to: "await queueRekey(g.scope, [g.next])" },
  { name: "endGrace drops the code", file: "worker.js",
    from: "await queueRekey(g.scope, [g.next], { notice: true })",
    to: "await queueRekey(g.scope, [g.next], { notice: true, rc: true })" },
  { name: "notice with nothing gone", file: "worker.js",
    from: "if (t.notice && creds.length) await oldCredsGone()",
    to: "if (t.notice) await oldCredsGone()" },
  { name: "notice event not recorded", file: "worker.js",
    from: "await s.put('events', [...((await s.get('events')) || []), { k: 'cred-old-del', at: now, fp: '' }].slice(-LIMITS.events))\n",
    to: "" },
  { name: "rebound drops no rc", file: "worker.js",
    from: "await queueRekey(await addressKey(address), [accountPub], { rc: true })",
    to: "await queueRekey(await addressKey(address), [accountPub])" },
  { name: "rekey: no retry in authorize", file: "worker.js",
    from: "      await runRekey()\n      // old passkeys still here",
    to: "      // old passkeys still here" },
  { name: "rekey: no refusal while pending", file: "worker.js",
    from: "if (dreqNeedsConsent(subject.op) && (await s.get('rekey'))) return refuse('rekey')",
    to: "" },
  { name: "rekey: no alarm on failure", file: "worker.js",
    from: "await s.setAlarm(now + LIMITS.rekeyRetryMs)",
    to: "" },
  { name: "rekey: tick does not retry", file: "worker.js",
    from: "    if (a.op === 'tick') {\n      await runRekey()\n",
    to: "    if (a.op === 'tick') {\n" },
  { name: "rekey: tick loses appointment", file: "worker.js",
    from: "if (g && !(await s.get('rekey'))) await s.setAlarm(g.until)",
    to: "" },
  { name: "rekey: list not kept in record", file: "worker.js",
    from: "        await s.put('rekey', { ...t, creds })\n",
    to: "" },
  { name: "queue forgets owed creds", file: "worker.js",
    from: "creds: t?.creds ?? [] })",
    to: "creds: [] })" },
  { name: "queue forgets rc", file: "worker.js",
    from: "rc: o.rc === true || t?.rc === true,",
    to: "rc: o.rc === true," },
  { name: "queue forgets notice", file: "worker.js",
    from: "notice: o.notice === true || t?.notice === true,",
    to: "notice: o.notice === true," },
  { name: "settle ignores pending rekey", file: "worker.js",
    from: "if (was || (await s.get('rekey'))) {",
    to: "if (was) {" },
  { name: "grace ops: rc-enrol back", file: "worker.js",
    from: "Object.freeze(['cred-add'])\n",
    to: "Object.freeze(['cred-add', 'rc-enrol'])\n" },
  { name: "grace flag lost in consent", file: "consent.js",
    from: "...(r.grace ? { grace: true } : {})",
    to: "" },
  { name: "grace flag lost in authorize", file: "worker.js",
    from: "grace = c.grace === true",
    to: "grace = false" },
  { name: "grace flag not passed to credAdd", file: "account.js",
    from: "accountPub: a.accountPub, setup: a.setup === true, grace: a.grace === true })",
    to: "accountPub: a.accountPub, setup: a.setup === true })" },
  { name: "young: dropped at the route", file: "worker.js",
    from: ", young: rc.body.young === true })",
    to: " })" },
  { name: "young: < to <=", file: "account.js",
    from: "now - rc.at < KEYS.rcYoungMs",
    to: "now - rc.at <= KEYS.rcYoungMs" },
  { name: "young: never reported", file: "account.js",
    from: "...(now - rc.at < KEYS.rcYoungMs ? { young: true } : {})",
    to: "" },
  { name: "young: always reported", file: "account.js",
    from: "...(now - rc.at < KEYS.rcYoungMs ? { young: true } : {})",
    to: "young: true" },
  { name: "young: window 71 h", file: "account.js",
    from: "rcYoungMs: 72 * HOUR",
    to: "rcYoungMs: 71 * HOUR" },
  { name: "young: window 73 h", file: "account.js",
    from: "rcYoungMs: 72 * HOUR",
    to: "rcYoungMs: 73 * HOUR" },
  { name: "young: Address ignores it", file: "worker.js",
    from: "frz.by === 'email' || frz.contested || a.young === true",
    to: "frz.by === 'email' || frz.contested" },
  { name: "young: a pepper upgrade refreshes at", file: "account.js",
    from: "await s.put('rc', { ...rc, v: cur.v,",
    to: "await s.put('rc', { ...rc, at: now, v: cur.v," },
  { name: "young: a pepper upgrade loses at", file: "account.js",
    from: "await s.put('rc', { ...rc, v: cur.v,",
    to: "await s.put('rc', { ...rc, at: undefined, v: cur.v," },
  { name: "young: enrol stores no at", file: "account.js",
    from: "ct: b64uEnc(await pepperSeal(pk.wrapKey, iv, parsed.inner, a.accountPub)), at: now,",
    to: "ct: b64uEnc(await pepperSeal(pk.wrapKey, iv, parsed.inner, a.accountPub))," },
  { name: "young: spends the code on a wait", file: "account.js",
    from: "        await s.put('rcFails', 0)\n        return out(200, { ok: true, ...(now",
    to: "        await s.delete('rc')\n        return out(200, { ok: true, ...(now" },
  { name: "email freeze no longer waits", file: "worker.js",
    from: "frz.by === 'email' || frz.contested || a.young === true",
    to: "frz.contested || a.young === true" },
  { name: "contested freeze no longer waits", file: "worker.js",
    from: "frz.by === 'email' || frz.contested || a.young === true",
    to: "frz.by === 'email' || a.young === true" },
  { name: "a waiting resolve mails the done notice", file: "worker.js",
    from: "r.status === 200 ? 'resolve' : 'resolve-pending'",
    to: "'resolve'" },
  { name: "orphan: not deleted by start", file: "account.js",
    from: "if (rc && rc.accountPub !== a.accountPub) { if (!resolve) await s.delete(['rc', 'rel']); rc = null }",
    to: "if (rc && rc.accountPub !== a.accountPub) { rc = null }" },
  { name: "orphan: deleted by a resolve too", file: "account.js",
    from: "if (rc && rc.accountPub !== a.accountPub) { if (!resolve) await s.delete(['rc', 'rel']); rc = null }",
    to: "if (rc && rc.accountPub !== a.accountPub) { await s.delete(['rc', 'rel']); rc = null }" },
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'directory-mutant-'))
  for (const p of TREE) cpSync(join(root, p), join(d, p), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  for (const f of RIGS) cpSync(join(root, 'scripts', f), join(d, 'scripts', f))
  return d
}
/** Run both rigs in a tree; a rig with no count line crashed, and proves nothing. */
function run(d: string) {
  return RIGS.map((f) => {
    const r = spawnSync(process.execPath, [join(d, 'scripts', f)], { encoding: 'utf8', timeout: 120_000 })
    const m = /^(\d+) passed, (\d+) failed$/m.exec(r.stdout)
    return { f, passed: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : null }
  })
}

console.log('positive control: the unmutated copy passes both rigs')
{
  const d = tree()
  for (const r of run(d)) ok(r.failed === 0 && (r.passed ?? 0) > 0, `${r.f}: ${r.passed} passed, ${r.failed} failed`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants: every one must fail a row`)
for (const m of MUTANTS) {
  const d = tree()
  const p = join(d, 'server/directory/src', m.file)
  const src = readFileSync(p, 'utf8')
  const n = src.split(m.from).length - 1
  ok(n === 1, `applies exactly once: ${m.name} (found ${n})`)
  if (n === 1) {
    writeFileSync(p, src.replace(m.from, () => m.to))
    const rs = run(d)
    ok(rs.every((r) => r.failed !== null) && rs.some((r) => r.failed! > 0), `killed: ${m.name} (${rs.map((r) => `${r.f} ${r.failed === null ? 'CRASHED' : `${r.failed} failed`}`).join(', ')})`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
