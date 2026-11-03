#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The bento/id calls in home/bridge.js (B1), driven end to end: the REAL
// bridge, the REAL kernel detector (kernel/src/identity.ts), and a fake native
// host that answers the way every host must.
//
//   node scripts/test-home-identity.mjs
//
// What it guards:
// - NO capability, NO agent. A host that has not declared 'identity' (an
//   unverified document, an older host) gets no `__bentoIdentity`, so the
//   kernel does exactly what it did before identity existed. Same in a subframe.
// - With the capability the kernel ACCEPTS the object (a frozen, non-writable,
//   non-configurable data property of closures) and the page cannot replace it.
// - The wire is exactly {id, op, purpose, payload} / {id, op, pub}: nothing
//   names the document or a caller.
// - Every refusal word reaches the caller unchanged; an unknown word, a
//   malformed reply or a transport failure becomes 'unavailable', never a
//   half-trusted object. 'reauth' (past the host's idle or overall timeout,
//   security §2e B) passes through and is NEVER retried or cached over.
// - A bad purpose, a non-string or oversize payload, and an {email} lookup
//   never reach the host.
// - Page script rewriting the global reply hook cannot redirect replies.
//
// The HOST's session timeout is not tested here (this file has no session): it
// is home/desktop/host's sign-timeout rig, which runs the real agent.
//
// Each scenario runs in its own process: the kernel caches the agent it finds.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const BRIDGE = readFileSync(join(root, 'home/bridge.js'), 'utf8')

const WHO = { name: 'Ada Lovelace', email: 'ada@example.org', vouchedBy: 'id.bento.page', accountPub: 'A'.repeat(87), devicePub: 'D'.repeat(87) }
const RES = { name: 'Grace', email: 'grace@example.org', vouchedBy: 'id.bento.page', accountPub: 'G'.repeat(87), firstSeen: 1700000000000, changed: false }
const SIG = { sig: 'S'.repeat(86), pub: 'P'.repeat(87) }

async function scenario(name) {
  const win = globalThis
  win.window = win
  win.top = name === 'subframe' ? {} : win
  win.addEventListener = () => {}
  win.removeEventListener = () => {}

  // the fake host: records every request, answers from a script the case sets
  const seen = []
  let answer = () => [false, 'unavailable']
  const native = {
    onmessage: null,
    postMessage(json) {
      const m = JSON.parse(json)
      seen.push(m)
      const [ok, value] = answer(m)
      if (value === 'NEVER') return
      setTimeout(() => native.onmessage({ data: JSON.stringify({ id: m.id, ok, value }) }), 0)
    },
  }
  win.__bentoTrayNative = native
  if (name !== 'no-caps') win.__bentoHostCaps = name === 'store-only' ? ['store'] : ['identity']

  vm.runInThisContext(BRIDGE, { filename: 'home/bridge.js' })

  const { identityAgent } = await import(pathToFileURL(join(root, 'kernel/src/identity.ts')).href)
  const agent = identityAgent()
  const out = { agent: agent ? 'present' : 'none', capsLeft: win.__bentoHostCaps !== undefined }
  if (!agent) return out

  const d = Object.getOwnPropertyDescriptor(win, '__bentoIdentity')
  out.descriptor = { writable: d.writable, configurable: d.configurable, frozen: Object.isFrozen(d.value), keys: Object.keys(d.value).sort() }
  out.replaceable = (() => { try { win.__bentoIdentity = {}; } catch (_) {} try { Object.defineProperty(win, '__bentoIdentity', { value: {} }); return true } catch (_) { return false } })()
  out.stillSame = Object.getOwnPropertyDescriptor(win, '__bentoIdentity').value === d.value

  // a reply that never arrives is a FAILED check, not a silent exit
  const run = async (f) => {
    try { return { v: await Promise.race([f(), new Promise((_, no) => setTimeout(() => no(new Error('no reply within 3s')), 3000))]) } }
    catch (e) { return { threw: String(e && e.message || e) } }
  }
  const take = () => seen.splice(0)

  // whoami
  answer = () => [true, WHO]; out.who = await run(() => agent.whoami()); out.whoWire = take()
  answer = () => [true, null]; out.whoNull = await run(() => agent.whoami())
  answer = () => [false, 'no-identity']; out.whoNone = await run(() => agent.whoami())
  answer = () => [false, 'declined']; out.whoDeclined = await run(() => agent.whoami())
  answer = () => [false, 'unavailable']; out.whoUnavailable = await run(() => agent.whoami())
  answer = () => [true, { ...WHO, email: 42 }]; out.whoMalformed = await run(() => agent.whoami())
  answer = () => [true, { ...WHO, extra: 'x' }]; out.whoExtra = await run(() => agent.whoami())
  take()

  // sign
  const FRAME = 'AAAAAAAAAAAAAAAA.' + 'B'.repeat(22)
  answer = () => [true, SIG]; out.sign = await run(() => agent.sign('frame', FRAME)); out.signWire = take()
  for (const r of ['declined', 'reauth', 'purpose', 'no-identity', 'unavailable']) {
    answer = () => [false, r]; out['sign_' + r] = await run(() => agent.sign('frame', FRAME))
  }
  answer = () => [false, 'something-new']; out.signUnknownWord = await run(() => agent.sign('frame', FRAME))
  answer = () => [false, 'bad capability']; out.signHostError = await run(() => agent.sign('frame', FRAME))
  answer = () => [true, { sig: 7, pub: 'P' }]; out.signMalformed = await run(() => agent.sign('frame', FRAME))
  answer = () => [true, null]; out.signNullOk = await run(() => agent.sign('frame', FRAME))
  take()
  answer = () => [true, SIG]
  out.badPurpose = await run(() => agent.sign('own-everything', FRAME))
  out.noPurpose = await run(() => agent.sign(undefined, FRAME))
  out.badPayload = await run(() => agent.sign('frame', { toString: () => FRAME }))
  out.hugePayload = await run(() => agent.sign('frame', 'x'.repeat((1 << 20) + 1)))
  out.neverSent = take().length
  // 'reauth' is not sticky and is not retried: the next call is a fresh request
  let n = 0
  answer = () => (n++ === 0 ? [false, 'reauth'] : [true, SIG])
  out.reauthThenOk = [await run(() => agent.sign('frame', FRAME)), await run(() => agent.sign('frame', FRAME))]
  out.reauthRequests = take().length

  // resolve
  answer = () => [true, RES]; out.resolve = await run(() => agent.resolve({ pub: 'G'.repeat(87) })); out.resolveWire = take()
  answer = () => [true, null]; out.resolveNone = await run(() => agent.resolve({ pub: 'G'.repeat(87) }))
  answer = () => [true, { ...RES, changed: 'no' }]; out.resolveMalformed = await run(() => agent.resolve({ pub: 'G'.repeat(87) }))
  answer = () => [false, 'unavailable']; out.resolveErr = await run(() => agent.resolve({ pub: 'G'.repeat(87) }))
  take()
  answer = () => [true, RES]
  out.resolveEmail = await run(() => agent.resolve({ email: 'grace@example.org' }))
  out.resolveJunk = await run(() => agent.resolve(null))
  out.emailNeverSent = take().length

  // phase 2 members are absent
  out.phase2 = { unwrap: agent.unwrap === undefined, share: agent.share === undefined }

  // page script rewriting the global reply hook cannot redirect replies
  win.__bentoNativeReply = () => { out.hookCalled = true }
  answer = () => [true, SIG]
  out.afterHookRewrite = await run(() => agent.sign('frame', FRAME))
  return out
}

if (process.argv[2] === '--scenario') {
  scenario(process.argv[3]).then((r) => { process.stdout.write(JSON.stringify(r)); process.exit(0) },
    (e) => { process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) })); process.exit(0) })
} else {
  let pass = 0, fail = 0
  const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); c ? pass++ : fail++ }
  const run = (n) => {
    const r = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--scenario', n], { encoding: 'utf8' })
    try { return JSON.parse(r.stdout) } catch (_) { return { error: r.stdout + r.stderr } }
  }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  for (const n of ['no-caps', 'store-only', 'subframe']) {
    const r = run(n)
    if (r.error) console.log(r.error)
    ok(r.agent === 'none', n === 'no-caps' ? 'no declared capability: the kernel finds no agent'
      : n === 'store-only' ? "a host that declares only 'store' gets no agent"
        : 'in a subframe: no agent, even with the capability declared')
  }

  const r = run('caps')
  if (r.error) console.log(r.error)
  ok(r.agent === 'present', "declared 'identity': the kernel accepts the agent")
  ok(r.capsLeft === false, 'the capability declaration is consumed, not left on the page')
  ok(eq(r.descriptor, { writable: false, configurable: false, frozen: true, keys: ['contract', 'resolve', 'sign', 'whoami'] }),
    'a non-writable, non-configurable data property holding a frozen object of exactly contract/whoami/sign/resolve')
  ok(r.replaceable === false && r.stillSame === true, 'page script cannot replace or redefine the agent')
  ok(eq(r.phase2, { unwrap: true, share: true }), 'unwrap and share (phase 2) are absent')

  ok(eq(r.who?.v, { name: WHO.name, email: WHO.email, vouchedBy: WHO.vouchedBy, accountPub: WHO.accountPub, devicePub: WHO.devicePub }), 'whoami returns the public identity the host vouched for')
  ok(eq(r.whoWire?.map((m) => Object.keys(m).sort()), [['id', 'op']]) && r.whoWire[0].op === 'id.whoami', 'whoami sends {id, op} and nothing else')
  ok(r.whoNull?.v === null && r.whoNone?.v === null && r.whoDeclined?.v === null, "whoami: null from the host, 'no-identity' and 'declined' all read as no identity")
  ok(r.whoUnavailable?.threw === 'unavailable', "whoami: any other host failure is a rejection ('unavailable'), which the kernel treats as no agent")
  ok(r.whoMalformed?.v === null, 'whoami: a field of the wrong type is no identity, not a half-trusted object')
  ok(r.who?.v && !('extra' in r.whoExtra.v), 'whoami: fields the contract does not name are dropped')

  ok(eq(r.sign?.v, { ok: true, sig: SIG.sig, pub: SIG.pub }), 'sign returns the signature and the signing key')
  ok(eq(r.signWire?.map((m) => Object.keys(m).sort()), [['id', 'op', 'payload', 'purpose']]) && r.signWire[0].op === 'id.sign'
    && r.signWire[0].purpose === 'frame', 'sign sends {id, op, purpose, payload} and nothing else (no docId, no caller)')
  for (const w of ['declined', 'reauth', 'purpose', 'no-identity', 'unavailable']) {
    ok(eq(r['sign_' + w]?.v, { ok: false, reason: w }), `sign: the host's '${w}' reaches the caller unchanged`)
  }
  ok(eq(r.signUnknownWord?.v, { ok: false, reason: 'unavailable' }) && eq(r.signHostError?.v, { ok: false, reason: 'unavailable' }),
    "sign: an unknown refusal word, or the host's own error text, is 'unavailable'")
  ok(eq(r.signMalformed?.v, { ok: false, reason: 'unavailable' }) && eq(r.signNullOk?.v, { ok: false, reason: 'unavailable' }),
    "sign: an ok reply without a signature and key is 'unavailable', never a success")
  ok(eq(r.badPurpose?.v, { ok: false, reason: 'purpose' }) && eq(r.noPurpose?.v, { ok: false, reason: 'purpose' })
    && eq(r.badPayload?.v, { ok: false, reason: 'purpose' }) && eq(r.hugePayload?.v, { ok: false, reason: 'purpose' }),
    "sign: an unknown purpose, a non-string payload and an oversize payload are 'purpose'")
  ok(r.neverSent === 0, 'those refused calls never reached the host')
  ok(eq(r.reauthThenOk?.map((x) => x.v), [{ ok: false, reason: 'reauth' }, { ok: true, sig: SIG.sig, pub: SIG.pub }]) && r.reauthRequests === 2,
    "'reauth' is not cached and not retried: exactly one request each, and the next call is a fresh ask")

  ok(eq(r.resolve?.v, RES) && eq(r.resolveWire?.map((m) => Object.keys(m).sort()), [['id', 'op', 'pub']]) && r.resolveWire[0].op === 'id.resolve',
    'resolve({pub}) returns the binding; the wire is {id, op, pub}')
  ok(r.resolveNone?.v === null && r.resolveMalformed?.v === null && r.resolveErr?.v === null, 'resolve: unknown, malformed and failed lookups are all null')
  ok(r.resolveEmail?.v === null && r.resolveJunk?.v === null && r.emailNeverSent === 0, 'resolve({email}) is phase 2: null, and the address never leaves the page')

  ok(r.afterHookRewrite?.v?.ok === true && r.hookCalled !== true, 'page script rewriting window.__bentoNativeReply cannot redirect or swallow replies')

  console.log(`\n${pass}/${pass + fail} checks passed`)
  process.exit(fail ? 1 : 0)
}
