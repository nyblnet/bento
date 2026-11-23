#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the directory's real mail (server/directory/src/ses.js,
// sns.js, and the SES and stop-list parts of mail.js, roster.js, worker.js).
//
//   node scripts/test-directory-ses-mutants.ts [name filter]
//
// Each mutant reopens one path in a COPY of the tree, and
// scripts/test-directory-ses.ts must then report a failed row. The unmutated
// copy must pass first (positive control, its count printed); every edit must
// apply to exactly one place, so a refactor that moves the code turns this rig
// red instead of passing vacuously; and a rig that crashes or prints no count
// is not a kill.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RIG = 'test-directory-ses.ts'
const TREE = ['kernel/src', 'kernel/fixtures', 'server/directory/src', 'server/directory/fixtures']
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Edit = { file: string; from: string; to: string }
type Mutant = { name: string; edits: Edit[] }
const SES = 'server/directory/src/ses.js', SNS = 'server/directory/src/sns.js', MAIL = 'server/directory/src/mail.js'
const ROSTER = 'server/directory/src/roster.js', WORKER = 'server/directory/src/worker.js'
const m = (name: string, ...edits: Edit[]): Mutant => ({ name, edits })

const MUTANTS: Mutant[] = [
  // --- the signer (R1, R2) ---
  m('R1 key derivation skips the region step', { file: SES, from: '  const kService = await hmac(kRegion, service)', to: '  const kService = await hmac(kDate, service)' }),
  m('R2 the canonical request hashes an empty payload', { file: SES, from: 'signedHeaders, await sha256hex(body)]', to: "signedHeaders, await sha256hex('')]" }),
  m('R2 content-type sent but not signed', { file: SES, from: "  const headers = { 'content-type': 'application/json', host, 'x-amz-date': amzDate }", to: "  const headers = { host, 'x-amz-date': amzDate }" }),
  // --- every kind goes through SES (R3) ---
  m("R3 the void kind skips SES (falls to 'no mailer configured')", { file: MAIL, from: "  if (env.MAILER === 'ses') return sesSend(env, msg, MAIL_TIMEOUT_MS)", to: "  if (env.MAILER === 'ses' && msg.kind !== 'void') return sesSend(env, msg, MAIL_TIMEOUT_MS)" }),
  m('R3 the Roster object mails without its stop list', { file: ROSTER, from: 'this.env = mailEnv(env, state.storage) }', to: 'this.env = env }' }),
  // --- outcomes (R4-R7) ---
  m('R4 any 2xx accepted, MessageId or not',
    { file: SES, from: "    if (res.status !== 200) throw refused(`${res.status} ${errorType(res)}`)", to: "    if (!res.ok) throw refused(`${res.status} ${errorType(res)}`)" },
    { file: SES, from: "    if (typeof id !== 'string' || !id) throw refused('200 without a MessageId')\n", to: '' }),
  m('R4 a 200 without a MessageId accepted', { file: SES, from: "    if (typeof id !== 'string' || !id) throw refused('200 without a MessageId')\n", to: '' }),
  m('R5 a 4xx refusal classed as a timeout', { file: SES, from: "    if (res.status !== 200) throw refused(`${res.status} ${errorType(res)}`)", to: "    if (res.status !== 200) throw mayArrive(`${res.status} ${errorType(res)}`)" }),
  m('R5 the hung request is never aborted', { file: SES, from: "        method: 'POST', body, signal: ac.signal,", to: "        method: 'POST', body," }),
  m('R6 a 5xx classed as a plain refusal', { file: SES, from: '    if (res.status >= 500) throw mayArrive(', to: '    if (res.status >= 500) throw refused(' }),
  m('R6 a broken connection classed as a plain refusal', { file: SES, from: "      throw mayArrive(ac.signal.aborted ? 'timed out' : 'connection')", to: "      throw ac.signal.aborted ? mayArrive('timed out') : refused('connection')" }),
  m('R7 a 429 retried once in the sender', { file: SES, from: '    if (res.status >= 500) throw mayArrive(',
    to: "    if (res.status === 429) res = await awsFetch(env)(`https://${host}${SES_PATH}`, { method: 'POST', body, signal: ac.signal, headers: { 'content-type': 'application/json', 'x-amz-date': amzDate, authorization } })\n    if (res.status >= 500) throw mayArrive(" }),
  // --- config and recipient (R8) ---
  m('R8 the region is not pinned to a region name', { file: SES, from: "  if (!SES_REGION_RE.test(v('SES_REGION'))) throw refused('config SES_REGION')", to: "  if (!v('SES_REGION')) throw refused('config SES_REGION')" }),
  m('R8 a missing configuration set defaults to none', { file: SES, from: "  if (!CONFIG_SET_RE.test(v('SES_CONFIGURATION_SET'))) throw refused('config SES_CONFIGURATION_SET')\n", to: '' }),
  m('R8 a missing secret is not checked', { file: SES, from: "  if (!SECRET_RE.test(v('SES_SECRET_ACCESS_KEY'))) throw refused('config SES_SECRET_ACCESS_KEY')\n", to: '' }),
  m('R8 the recipient is not checked', { file: SES, from: "  if (typeof msg.to !== 'string' || normalize(msg.to) !== msg.to || /[\\r\\n,<>\\s]/.test(msg.to)) throw refused('recipient')\n", to: '' }),
  m('R8 a real send with no stop list readable goes ahead', { file: MAIL, from: "    if (env.MAILER === 'ses') throw new Error('mail stop list not readable here')\n", to: '' }),
  // --- logs (R9) ---
  m('R9 a failure logs the response, the request and its Authorization', { file: SES, from: "    if (res.status !== 200) throw refused(`${res.status} ${errorType(res)}`)",
    to: "    if (res.status !== 200) console.log(`ses failed: ${await res.clone().text()} ${body} ${authorization}`)\n    if (res.status !== 200) throw refused(`${res.status} ${errorType(res)}`)" }),
  // --- D1 (R10) ---
  m('R10 notify reports a refused SES send as sent', { file: ROSTER,
    from: '  try { await deliver(env, { to, subject, body, kind }); return true } catch (e) { console.log(`${kind} mail failed: ${e.message}`); return false }',
    to: '  try { await deliver(env, { to, subject, body, kind }); return true } catch (e) { console.log(`${kind} mail failed: ${e.message}`); return true }' }),
  // --- SNS authenticity (R11-R13) ---
  m('R11 the signature is not verified', { file: SNS, from: "  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, te.encode(canonical(m))))) return k.json(403, { error: 'signature' })\n", to: '' }),
  m('R11 SignatureVersion not pinned to 2', { file: SNS, from: "  if (m.SignatureVersion !== '2') return k.json(403, { error: 'signature' })\n", to: '' }),
  m('R11 the Timestamp is not checked', { file: SNS, from: "  if (!Number.isFinite(at) || now - at > SNS_MAX_AGE_MS || at - now > SNS_FUTURE_MS) return k.json(403, { error: 'stale' })\n", to: '' }),
  m('R12 the topic is not pinned', { file: SNS, from: "  if (m.TopicArn !== topic.arn) return k.json(403, { error: 'topic' })\n", to: '' }),
  m('R13 the certificate host matched by suffix',
    { file: SNS, from: "url.hostname === `sns.${region}.amazonaws.com` && url.port", to: "url.hostname.endsWith('.amazonaws.com') && url.port" },
    { file: SNS, from: ' && u === want + url.pathname', to: '' }),
  m('R13 the certificate fetched over http',
    { file: SNS, from: "  return url.protocol === 'https:' && url.hostname", to: "  return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname" },
    { file: SNS, from: '  const want = `https://sns.${region}.amazonaws.com`', to: '  const want = `${url.protocol}//sns.${region}.amazonaws.com`' }),
  m('R13 the certificate URL is not pinned at all', { file: SNS, from: "  if (!certUrlOk(m.SigningCertURL, topic.region)) return k.json(403, { error: 'cert-url' })\n", to: '' }),
  // --- event semantics (R14) ---
  m('R14 a Transient bounce stops the address', { file: SNS, from: "    if (b.bounceType !== 'Permanent') return []\n", to: '' }),
  m('R14 the event address is not normalized', { file: SNS, from: 'normalize(r.emailAddress.trim())', to: 'r.emailAddress' }),
  m('R14 a later event overwrites the first record', { file: MAIL, from: "  if (await storage.get(MAIL_STOP_KEY)) return { status: 200, body: { stopped: true, first: false } }\n", to: '' }),
  m('R14 the Roster object ignores mailStop', { file: ROSTER, from: "    if (a.op === 'mailStop') { const r = await putMailStop(s, a, now); return out(r.status, r.body) }\n", to: '' }),
  // --- a stop is a refusal (R15) ---
  m('R15 a stopped send reports success without calling SES', { file: MAIL, from: '  await refuseStopped(env, msg)', to: '  try { await refuseStopped(env, msg) } catch { return }' }),
  m('R15 the stop list is never read', { file: MAIL, from: '  await refuseStopped(env, msg)', to: '  // refuseStopped' }),
  // --- privacy (R16) ---
  m('R16 the stop record keeps the address',
    { file: WORKER, from: "call(await rosterStub(env, email), 'mailStop', rec)", to: "call(await rosterStub(env, email), 'mailStop', { ...rec, address: email })" },
    { file: MAIL, from: '  await storage.put(MAIL_STOP_KEY, { reason: a.reason, subtype, at: now })', to: '  await storage.put(MAIL_STOP_KEY, { reason: a.reason, subtype, at: now, address: a.address })' }),
  // --- SubscriptionConfirmation (R17) ---
  m('R17 the confirmation is fetched before the topic check', { file: SNS, from: '  const topic = ourTopic(env)\n',
    to: "  if (m.Type === 'SubscriptionConfirmation') await awsFetch(env)(m.SubscribeURL, { method: 'GET' })\n  const topic = ourTopic(env)\n" }),
  m('R17 the SubscribeURL is not pinned', { file: SNS, from: "    if (!subscribeUrlOk(m.SubscribeURL, topic.region, topic.arn)) return k.json(403, { error: 'subscribe-url' })\n", to: '' }),
  // --- the route (R18) ---
  m('R18 no body cap', { file: SNS, from: "  if (text === null) return k.json(413, { error: 'too-large' })\n", to: '' }),
  m('R18 other methods not refused', { file: SNS, from: "  if (req.method !== 'POST') return k.json(405, { error: 'method' })\n", to: '' }),
  m('R18 the route answers with CORS headers', { file: WORKER, from: '      json: (status, b) => json(status, b, BASE),', to: '      json: (status, b) => json(status, b, ANY),' }),
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'directory-ses-mutant-'))
  for (const p of TREE) cpSync(join(root, p), join(d, p), { recursive: true })
  mkdirSync(join(d, 'scripts'), { recursive: true })
  cpSync(join(root, 'scripts', RIG), join(d, 'scripts', RIG))
  return d
}
/** The rig in a tree, to its end or 120 s (then killed: no count line, so a crash). */
function run(d: string): Promise<{ passed: number; failed: number; err?: string } | null> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [join(d, 'scripts', RIG)])
    let out = ''
    c.stdout.on('data', (x) => { out += x })
    let err = ''
    c.stderr.on('data', (x) => { err += x })
    const t = setTimeout(() => c.kill('SIGKILL'), 120_000)
    c.on('close', () => {
      clearTimeout(t)
      const mm = /^(\d+) passed, (\d+) failed$/m.exec(out)
      if (!mm) console.log(`    (crash) ${err.split('\n').filter((l) => /Error|at /.test(l)).slice(0, 4).join(' | ')}`)
      resolve(mm ? { passed: Number(mm[1]), failed: Number(mm[2]) } : null)
    })
  })
}

const filter = process.argv[2]
const chosen = filter ? MUTANTS.filter((x) => x.name.includes(filter)) : MUTANTS
if (filter && !chosen.length) { console.log(`no mutant matches "${filter}"`); process.exit(1) }
ok(new Set(MUTANTS.map((x) => x.name)).size === MUTANTS.length, `mutant names are unique (${MUTANTS.length})`)

// positive control: the unmutated copy passes, with its count
{
  const d = tree()
  const r = await run(d)
  rmSync(d, { recursive: true, force: true })
  ok(!!r && r.failed === 0 && r.passed > 100, `positive control: the unmutated copy passes (${r ? `${r.passed} passed, ${r.failed} failed` : 'no count'})`)
  console.log(`positive control: ${r?.passed ?? 0} rows`)
}

console.log(`\n${chosen.length} mutants: every one must fail a row`)
let killed = 0
for (const mu of chosen) {
  const d = tree()
  let applied = true
  for (const e of mu.edits) {
    const f = join(d, e.file)
    const src = readFileSync(f, 'utf8')
    const n = src.split(e.from).length - 1
    if (n !== 1) { applied = false; ok(false, `${mu.name}: an edit applies exactly once in ${e.file} (found ${n})`); break }
    writeFileSync(f, src.replace(e.from, () => e.to))
  }
  if (applied) {
    ok(true, `${mu.name}: applies exactly once`)
    const r = await run(d)
    const kill = !!r && r.failed > 0
    if (kill) killed++
    ok(kill, `${mu.name}: killed (${r ? `${r.failed} rows red, ${r.passed} passed` : 'the rig crashed: no count, not a kill'})`)
  }
  rmSync(d, { recursive: true, force: true })
}
console.log(`\n${killed}/${chosen.length} mutants killed; ${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
