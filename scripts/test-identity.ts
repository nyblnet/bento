#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id contract rig: kernel/src/identity.ts.
//
//   node scripts/test-identity.ts
//
// WHAT THIS PROVES. `identityAgent()` is how a document finds the host's
// identity agent. It must return the agent ONLY when a host defined a valid one,
// and null in every other case, so the caller falls back to today's behaviour.
// It must never throw into the caller, whatever sits on the global. And once
// found, the agent must not be redirectable: not by swapping the global, not by
// patching the host object, and not through `this` (a method that reaches its
// transport through `this` is called with `this` undefined, so it can't be
// pointed somewhere else after capture). This PR ships the contract only, so the
// rig also pins that nothing in the runtime calls it yet.
//
// Most cases run against a STAND-IN global (detectIdentityAgentForTest): the
// contract requires a non-configurable property, which on the real globalThis
// could never be reset between cases. The real path (identityAgent() over
// globalThis, with its capture-once cache) runs last.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  identityAgent, detectIdentityAgentForTest as detect, IDENTITY_CONTRACT, IDENTITY_GLOBAL, VOUCHED_BY_MAX, isVoucher,
} from '../kernel/src/identity.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** A stand-in global holding `value` the way a host must define it. */
const scopeWith = (value: unknown, d: PropertyDescriptor = { writable: false, configurable: false }) => {
  const s = {}
  Object.defineProperty(s, IDENTITY_GLOBAL, { value, enumerable: true, ...d })
  return s
}

/** A well-formed, FROZEN phase-1 agent whose methods are closures. */
function fakeAgent(tag = 'A', extra: Record<string, unknown> = {}) {
  const calls: string[] = []
  const agent = Object.freeze({
    contract: IDENTITY_CONTRACT,
    async whoami() { calls.push('whoami'); return null },
    async sign(purpose: string, payload: string) { calls.push(`sign:${purpose}:${payload}`); return { ok: true as const, sig: tag, pub: tag } },
    async resolve() { calls.push('resolve'); return null },
    ...extra,
  })
  return { agent, calls }
}

console.log('\nno host → null, the caller keeps today\'s behaviour')
{
  ok(detect({}) === null, 'no property → null')
  for (const [v, label] of [[undefined, 'undefined'], [null, 'null'], ['agent', 'a string'], [() => 0, 'a function']] as const) {
    ok(detect(scopeWith(v)) === null, `${label} → null`)
  }
}

console.log('\nthe global must be a locked data property')
{
  const { agent } = fakeAgent()
  ok(detect(scopeWith(agent)) !== null, 'control: a non-writable, non-configurable data property with a frozen agent → found')
  ok(detect(scopeWith(agent, { writable: true, configurable: false })) === null, 'a WRITABLE property → null (the page could overwrite it)')
  ok(detect(scopeWith(agent, { writable: false, configurable: true })) === null, 'a CONFIGURABLE property → null (the page could redefine it)')
  const getterScope = {}
  Object.defineProperty(getterScope, IDENTITY_GLOBAL, { get: () => agent, configurable: false })
  ok(detect(getterScope) === null, 'a GETTER, even one returning a valid agent → null (it could answer differently each read)')
  const plain = { [IDENTITY_GLOBAL]: agent }
  ok(detect(plain) === null, 'a plain assignment (writable + configurable) → null')
}

console.log('\nthe agent object must be frozen')
{
  const { agent } = fakeAgent()
  const unfrozen = { ...agent }
  ok(detect(scopeWith(unfrozen)) === null, 'an unfrozen agent → null (a member could be swapped after capture)')
  const sealedOnly = Object.seal({ ...agent })
  ok(detect(scopeWith(sealedOnly)) === null, 'a sealed-but-writable agent → null')
}

console.log('\na malformed agent is refused, never half-used')
{
  const base = fakeAgent().agent
  const f = (o: Record<string, unknown>) => detect(scopeWith(Object.freeze(o)))
  ok(f({ ...base, contract: undefined }) === null, 'no contract version → null')
  ok(f({ ...base, contract: IDENTITY_CONTRACT + 1 }) === null, 'a newer, unknown contract → null (not misread)')
  ok(f({ ...base, contract: String(IDENTITY_CONTRACT) }) === null, 'a contract given as a string → null')
  for (const k of ['whoami', 'sign', 'resolve'] as const) {
    const bad: Record<string, unknown> = { ...base }; delete bad[k]
    ok(f(bad) === null, `missing ${k} → null`)
    ok(f({ ...base, [k]: 'not a function' }) === null, `${k} not callable → null`)
  }
  ok(f({ ...base, unwrap: 42 }) === null, 'a phase-2 member present but not callable → null')
  ok(f({ ...base, share: {} }) === null, 'share present but not callable → null')
}

console.log('\nhostile values never throw into the caller')
{
  const tryDetect = (s: object) => { try { return { r: detect(s), threw: false } } catch { return { r: undefined, threw: true } } }
  const trap = new Proxy({}, { get() { throw new Error('trap') }, isExtensible() { throw new Error('trap') } })
  let t = tryDetect(scopeWith(trap))
  ok(!t.threw && t.r === null, 'a trapping proxy → null, no throw')
  const { proxy, revoke } = Proxy.revocable(fakeAgent().agent, {})
  revoke()
  t = tryDetect(scopeWith(proxy))
  ok(!t.threw && t.r === null, 'a revoked proxy → null, no throw')
  const descTrap = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap') } })
  t = tryDetect(descTrap)
  ok(!t.threw && t.r === null, 'a global whose descriptor read throws → null, no throw')
}

console.log('\na valid agent is found, phase-2 members optional')
{
  const { agent, calls } = fakeAgent()
  const a = detect(scopeWith(agent))
  ok(a !== null && a.contract === IDENTITY_CONTRACT, `a phase-1 agent is accepted and reports contract ${IDENTITY_CONTRACT}`)
  ok(a?.unwrap === undefined && a?.share === undefined, 'phase-2 members absent → not invented')
  const r = await a!.sign('frame', '1.abc')
  ok(r.ok === true && calls.includes('sign:frame:1.abc'), 'calls reach the host agent with their arguments')
  const b = detect(scopeWith(fakeAgent('B', { async unwrap() { return null }, async share() { return { ok: true } } }).agent))
  ok(!!b && typeof b.unwrap === 'function' && typeof b.share === 'function', 'an agent with phase-2 members exposes them')
  ok(Object.isFrozen(a), 'the captured agent is itself frozen')
}

console.log('\nno redirect through `this` (security, #759)')
{
  // Methods are called with `this` undefined, so they can only use closures.
  let seenThis: unknown = 'unset'
  const spy = Object.freeze({
    contract: IDENTITY_CONTRACT,
    async whoami() { return null },
    async sign(this: unknown) { seenThis = this; return { ok: true as const, sig: 'S', pub: 'P' } },
    async resolve() { return null },
  })
  await detect(scopeWith(spy))!.sign('frame', '1.x')
  ok(seenThis === undefined, `a host method is called with this === undefined (got ${String(seenThis)})`)

  // The measured attack: a host whose sign reaches its transport through
  // `this.post`. With the host frozen the page cannot rewrite post — and with
  // `this` undefined the method cannot even find it, so it fails CLOSED rather
  // than signing through anything a page could reach.
  const viaThis = Object.freeze({
    contract: IDENTITY_CONTRACT,
    post: (p: string) => ({ ok: true as const, sig: `genuine:${p}`, pub: 'P' }),
    async whoami() { return null },
    async sign(this: { post: (p: string) => unknown }, _purpose: string, payload: string) { return this.post(payload) },
    async resolve() { return null },
  })
  let res: unknown, rejected = false
  try { res = await detect(scopeWith(viaThis))!.sign('frame', '1.x') } catch { rejected = true }
  ok(rejected && res === undefined, 'a `this`-dependent host method fails closed — no signature, never a redirected one')
}

console.log('\nonce found, the agent cannot be reassigned')
{
  const a = detect(scopeWith(fakeAgent('FIRST').agent))!
  const orig = a.sign
  let threw = false
  try { (a as unknown as Record<string, unknown>).sign = () => 0 } catch { threw = true }
  ok(threw && a.sign === orig, 'a write to the captured agent throws (strict mode) and changes nothing')
}

// Pin that nothing CALLS the agent yet, so the contract is provably free of
// behaviour change until the bridge (B1) and the apps add callers. A type-only
// import (`import type`) brings no code, so it does not count: statements.ts
// uses the SignPurpose type to check payloads.
console.log('\ncontract only: nothing calls it yet')
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f === 'node_modules' || f.startsWith('.') || f === 'dist' || f === 'dist-single') continue
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx|js|mjs)$/.test(f) && p !== join(root, 'kernel/src/identity.ts') &&
        /^import(?!\s+type\b)[^\n]*from ['"][^'"]*\/identity(\.ts)?['"]/m.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length + 1))
    }
  }
  for (const d of ['kernel/src', 'slides/src', 'spaces/src', 'type/src', 'dash/src']) walk(join(root, d))
  ok(hits.length === 0, `no runtime module imports kernel/src/identity.ts for its code (${hits.join(', ') || 'none'})`)
}

// The real path, last: identityAgent() over globalThis, with its capture-once
// cache. Once the property is defined non-configurable it can never be removed,
// which is exactly why this runs at the end.
console.log('\nthe real globalThis path')
{
  ok(identityAgent() === null, 'nothing on globalThis yet → null')
  const G = globalThis as Record<string, unknown>
  G[IDENTITY_GLOBAL] = fakeAgent('PLAIN').agent // a plain assignment
  ok(identityAgent() === null, 'a plain assignment on globalThis → still null (absent results are not cached)')
  delete G[IDENTITY_GLOBAL]
  const first = fakeAgent('REAL').agent
  Object.defineProperty(globalThis, IDENTITY_GLOBAL, { value: first, writable: false, configurable: false })
  const a = identityAgent()
  ok(a !== null, 'a host defining it correctly, a moment late → found on the next call')
  ok(identityAgent() === a, 'the same captured agent on every later call')
  const r = await a!.sign('frame', '3.x')
  ok(r.ok === true && r.sig === 'REAL', 'it signs through the host that defined it')
}

console.log('\nvouchedBy is the voucher alone: every qualifier is its own field (security-ruling-951 C5, C7)')
{
  ok(VOUCHED_BY_MAX === 80, 'the cut is 80 characters (what shells render)')
  // what an agent sends, and a document accepts
  for (const v of ['id.bento.page', 'example.com', 'engineering.example-corporation.co.uk', 'vault-acme', 'a'.repeat(80)])
    ok(isVoucher(v), `a voucher: "${v.length > 40 ? v.slice(0, 20) + '…' : v}"`)
  // the forms #949's design wrote into vouchedBy: the tier, the lapse and "managed by" travel as fields now
  for (const v of ['id.bento.page (passkey sign-in)', 'id.bento.page, unconfirmed since 3 Mar 2027', 'id.bento.page (passkey sign-in), unconfirmed since 31 Dec 2027',
    'id.bento.page, managed by example.com', 'id.bento.page ✓', 'Id.Bento.Page', 'id.bento.page.', '.id.bento.page', '', ' id.bento.page', 'a'.repeat(81)])
    ok(!isVoucher(v), `not a voucher: "${v.length > 40 ? v.slice(0, 40) + '…' : v}"`)
  ok(!isVoucher(null) && !isVoucher(42) && !isVoucher(['id.bento.page']), 'a non-string is not a voucher')
  // ResolvedIdentity names each qualifier as its own optional field (one source per fact; ID3 and slides' People panel read them)
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel/src/identity.ts'), 'utf8')
  const body = src.slice(src.indexOf('export interface ResolvedIdentity {'), src.indexOf('}', src.indexOf('export interface ResolvedIdentity {')))
  for (const [f, t] of [['tier', "'passkey' | 'native'"], ['accountSince', 'number'], ['rosterChangedAt', 'number'], ['resetAt', 'number'],
    ['revoked', "false | 'signout' | 'incident'"], ['managedBy', 'string'], ['unconfirmedSince', 'number']] as const)
    ok(body.includes(`\n  ${f}?: ${t}\n`), `ResolvedIdentity.${f}?: ${t}`)
  ok(!/passkey sign-in\)", ", unconfirmed/.test(src), 'identity.ts no longer tells agents to write qualifiers into vouchedBy')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
