#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id: the offline WebAuthn assertion verifier (kernel/src/webauthn.ts)
// against kernel/fixtures/webauthn-v1.json.
//
//   node scripts/test-webauthn.ts   [WEBAUTHN_FIXTURE=<file>]
//
// WHAT THIS PROVES. Every row reaches its stated verdict for its stated reason:
// real assertions from browsers (high-S and low-S, with and without Chromium's
// extra clientDataJSON key) all verify, and every refusal (another origin, a
// sibling host, a subdomain, the parent rp id, a framed or crossOrigin
// assertion, UV or UP clear, tampering, another key, duplicate keys...) is
// refused for its own reason. The rows the contract depends on must EXIST, so
// deleting one cannot quietly shrink it, and the real rows must actually
// contain both halves of S and the extra key. The strict JSON parser is also
// checked against JSON.parse on valid input, so it is not refusing what it
// should read. scripts/test-webauthn-mutants.ts proves each check is needed.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyAssertion, parseStrictJson, statementChallenge, type Json } from '../kernel/src/webauthn.ts'
import { b64uDec, b64uEnc } from '../kernel/src/statements.ts'

let failures = 0, checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// WEBAUTHN_FIXTURE: check a fixture generated for another rp id (gen-webauthn-vectors.mjs --rp … --out …)
const F = JSON.parse(readFileSync(process.env.WEBAUTHN_FIXTURE || join(root, 'kernel/fixtures/webauthn-v1.json'), 'utf8'))

type Row = { name: string; key: string; challenge: string; text: string | null; assertion: { authenticatorData: string; clientDataJSON: string; signature: string };
  storedSignCount?: number; expect: 'accept' | 'reject'; reason?: string; highS?: boolean; extraKeys?: boolean; be?: boolean; bs?: boolean }
const rows: Row[] = F.rows

console.log(`fixture: rp id ${F.rpId}, origins ${JSON.stringify(F.origins)}, ${rows.length} rows`)
ok(typeof F.rpId === 'string' && Array.isArray(F.origins) && F.origins.length > 0, 'fixture names its rp id and origin list')

console.log('\nevery row reaches its verdict for its reason')
for (const r of rows) {
  let v: { ok: boolean; reason?: string; value?: { highS: boolean; be: boolean; bs: boolean; signCount: number } }
  try {
    const ch = b64uDec(r.challenge)!
    // text null: the row pins the caller's challenge bytes directly (the length rows)
    if (r.text !== null) ok(b64uEnc(await statementChallenge(r.text)) === r.challenge, `${r.name}: challenge is SHA-256 of its text`)
    v = await verifyAssertion(r.assertion, { publicKey: F.keys[r.key], challenge: ch, rpId: F.rpId, origins: F.origins,
      ...(r.storedSignCount !== undefined ? { storedSignCount: r.storedSignCount } : {}) }) as typeof v
  } catch (e) { v = { ok: false, reason: `threw: ${(e as Error).message}` } }
  const got = v.ok ? 'accept' : `reject (${v.reason})`
  const want = r.expect === 'accept' ? 'accept' : `reject (${r.reason})`
  ok(got === want, `${r.name}: ${got}${got === want ? '' : `, want ${want}`}`)
  if (v.ok && v.value && r.highS !== undefined) ok(v.value.highS === r.highS, `${r.name}: reports highS ${r.highS}`)
  if (v.ok && v.value && r.be !== undefined) ok(v.value.be === r.be && v.value.bs === r.bs, `${r.name}: carries BE/BS`)
}

console.log('\nthe rows the contract depends on exist')
const byName = new Map(rows.map((r) => [r.name, r]))
const REQUIRED: Array<[string, string]> = [
  ['real/high-s-made-low', 'accept'], ['real/low-s-made-high', 'accept'],
  ['real/other-statement', 'challenge'], ['real/registration-client-data', 'type'], ['real/authenticator-data-tampered', 'signature'],
  ['real/parent-rp-id', 'rp'], ['real/child-rp-id', 'rp'], ['real/subdomain-origin', 'origin'], ['real/rp-host-origin', 'origin'], ['real/sibling-under-rp-origin', 'origin'], ['real/framed-by-parent', 'cross-origin'],
  ['real/sign-count-advances', 'accept'], ['real/sign-count-replayed', 'sign-count'],
  ['sw/control', 'accept'], ['sw/extra-keys', 'accept'], ['sw/fields-in-another-order', 'accept'], ['sw/high-s', 'accept'], ['sw/low-s', 'accept'],
  ['sw/duplicate-origin-last-wins', 'duplicate-key'], ['sw/duplicate-origin-first-wins', 'duplicate-key'],
  ['sw/duplicate-origin-escaped', 'duplicate-key'], ['sw/duplicate-nested', 'duplicate-key'],
  ['sw/origin-parent', 'origin'], ['sw/origin-rp-host', 'origin'], ['sw/origin-sibling-under-rp', 'origin'], ['sw/origin-sibling-host', 'origin'], ['sw/origin-subdomain', 'origin'], ['sw/origin-foreign', 'origin'],
  ['sw/origin-http', 'origin'], ['sw/origin-trailing-slash', 'origin'], ['sw/origin-explicit-port', 'origin'], ['sw/origin-uppercase', 'origin'],
  ['sw/cross-origin-true', 'cross-origin'], ['sw/cross-origin-string-false', 'cross-origin'], ['sw/top-origin-present', 'cross-origin'],
  ['sw/rp-parent', 'rp'], ['sw/up-clear', 'up'], ['sw/uv-clear', 'uv'], ['sw/type-create', 'type'],
  ['sw/challenge-other', 'challenge'], ['sw/challenge-noncanonical', 'challenge'], ['sw/challenge-padded', 'challenge'],
  ['sw/attested-data-flag', 'grammar'], ['sw/trailing-bytes-without-ed', 'grammar'], ['sw/backed-up-not-eligible', 'grammar'], ['sw/byte-order-mark', 'grammar'],
  ['sw/der-negative', 'signature'], ['sw/der-s-zero', 'signature'], ['sw/der-r-s-zero', 'signature'],
  ['sw/challenge-empty', 'grammar'], ['sw/challenge-15-bytes', 'grammar'], ['sw/challenge-16-bytes', 'accept'],
  ['sw/der-non-minimal', 'signature'], ['sw/der-trailing-byte', 'signature'], ['sw/der-sequence-length', 'signature'], ['sw/invalid-utf8', 'grammar'], ['sw/raw-not-der', 'signature'], ['sw/der-r-is-n', 'signature'],
  ['sw/client-data-tampered', 'signature'], ['sw/another-key', 'signature'], ['sw/key-off-curve', 'key'],
  ['sw/sign-count-0-stored-0', 'accept'], ['sw/sign-count-5-stored-5', 'sign-count'], ['sw/sign-count-0-stored-3', 'sign-count'],
]
for (const [n, want] of REQUIRED) {
  const r = byName.get(n)
  ok(!!r && (want === 'accept' ? r.expect === 'accept' : r.expect === 'reject' && r.reason === want), `required row ${n} (${want})`)
}
const realGets = rows.filter((r) => /^(real|imported\/[a-z]+)\/get-\d+$/.test(r.name))
ok(realGets.length >= 24 && realGets.every((r) => r.expect === 'accept'), `${realGets.length} real assertions, all accepted rows`)
ok(realGets.some((r) => r.highS === true) && realGets.some((r) => r.highS === false), `real assertions include high-S (${realGets.filter((r) => r.highS).length}) and low-S`)
ok(realGets.some((r) => r.extraKeys === true), `real assertions include Chromium's extra clientDataJSON key (${realGets.filter((r) => r.extraKeys).length})`)

console.log('\nthe strict JSON parser reads what JSON.parse reads, and refuses what it must')
const toPlain = (j: Json): unknown => j instanceof Map ? Object.fromEntries([...j].map(([k, v]) => [k, toPlain(v)])) : Array.isArray(j) ? j.map(toPlain) : j
const VALID = ['{}', '[]', '{"a":[1,-2.5e3,0,true,false,null,"x\\n\\u00e9\\ud83d\\ude00"]}', ' { "a" : { "b" : [ ] } } ', '"s"', '0', '-0.5',
  '{"__proto__":1,"constructor":2}', '{"a":"\\/\\b\\f\\r\\t\\"\\\\"}']
for (const t of VALID) ok(JSON.stringify(toPlain(parseStrictJson(t) as Json)) === JSON.stringify(JSON.parse(t)), `reads ${t}`)
const INVALID = ['', '{', '{"a":1,}', '[1,]', '01', '1.', '.5', '+1', "{'a':1}", '{"a":1}x', '{"a" :1}', '"\\x"', '"\\ud800"', '"\\udc00"', 'NaN', 'tru', '{"a":1 "b":2}', '"a\u0001"', '[' .repeat(40) + ']'.repeat(40)]
for (const t of INVALID) ok(parseStrictJson(t) === null, `refuses ${JSON.stringify(t).slice(0, 40)}`)
for (const t of ['{"a":1,"a":1}', '{"a":1,"\\u0061":2}', '[{"x":{"k":0,"k":0}}]', '{"__proto__":1,"__proto__":2}'])
  ok(parseStrictJson(t) === 'duplicate', `duplicate in ${t}`)

console.log('\nparameters are required, never defaulted')
{
  const r = byName.get('sw/control')!
  const base = { publicKey: F.keys[r.key], challenge: b64uDec(r.challenge)!, rpId: F.rpId, origins: F.origins }
  ok((await verifyAssertion(r.assertion, base)).ok, 'control accepts with the fixture parameters')
  const empty = await verifyAssertion(r.assertion, { ...base, origins: [] })
  ok(!empty.ok && empty.reason === 'grammar', 'an empty origin list is refused as a caller error (grammar)')
  const noRp = await verifyAssertion(r.assertion, { ...base, rpId: '' })
  ok(!noRp.ok && noRp.reason === 'grammar', 'an empty rp id is refused as a caller error (grammar)')
  const other = await verifyAssertion(r.assertion, { ...base, rpId: 'other.example' })
  ok(!other.ok && other.reason === 'rp', 'another rp id parameter refuses with rp')
  const wider = await verifyAssertion(byName.get('sw/origin-parent')!.assertion, { ...base, origins: [...F.origins, `https://${F.rpId.split('.').slice(1).join('.')}`] })
  ok(wider.ok, 'positive control: the parent-origin row passes once the caller lists the parent (the list decides)')
  const neg = await verifyAssertion(r.assertion, { ...base, storedSignCount: -1 })
  ok(!neg.ok, 'a negative stored count is refused')
  const junk = await verifyAssertion(null as never, base)
  ok(!junk.ok && junk.reason === 'grammar', 'a missing assertion is grammar, not a throw')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
