#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The JavaScript reference (kernel/src/gate1.ts) against the gate-1 corpus,
// read from disk exactly as a native host's rig reads it.
//
//   node scripts/test-gate1.ts
//
// Every host's verifier must reach the same verdict on every row:
//   - served: one release matches every block, or UNKNOWN (security §36 and
//     the 2026-10-21 grammar);
//   - strict: the file:// fallback passes both genuine saves and refuses all
//     16 tampers (security §15);
//   - history: anti-rollback.
// The history's signature is checked first with the corpus's TEST key, as a
// host checks the real one with the release key.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicKey, verify } from 'node:crypto'
import { verifyServed, verifyStrict, acceptHistory, hostPolicy, scanBlocks, parseStartTag, parseEndTag, type History, type StrictExpected } from '../kernel/src/gate1.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'home/fixtures/gate1')
const read = (p: string) => readFileSync(join(DIR, p), 'utf8')
const E = JSON.parse(read('expected.json'))

console.log('\nthe signed history (verified with the corpus TEST key, as hosts verify the release key)')
const envelope = JSON.parse(read('history.json'))
const pub = createPublicKey({ key: JSON.parse(read('test-public-key.json')), format: 'jwk' })
const sigOk = verify('sha256', Buffer.from(envelope.payload, 'utf8'), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(envelope.sig, 'base64'))
ok(sigOk, 'history.json verifies')
const tampered = envelope.payload.replace('1.0.0', '1.0.1')
ok(!verify('sha256', Buffer.from(tampered, 'utf8'), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(envelope.sig, 'base64')), 'a tampered payload does not')
const history: History = JSON.parse(envelope.payload)

console.log('\nserved: ONE release must match EVERY block')
for (const row of E.served) {
  const v = await verifyServed(read(row.case), history)
  const got = v.verdict === 'genuine' ? `genuine ${v.release.version}` : 'unknown'
  const want = row.verdict === 'genuine' ? `genuine ${row.release}` : 'unknown'
  ok(got === want, `${row.case.replace('served/', '')}: ${want}${v.verdict === 'unknown' ? ` (${v.reason})` : ''}`)
  if (v.verdict === 'genuine') {
    const p = v.csp
    ok(p.includes(`'${v.release.pins.scriptSrc[0]}'`) && !/unsafe-eval|'unsafe-inline'[^;]*script|script-src[^;]*\*/.test(p) && p.startsWith("default-src 'none'"),
      `  …served under its own pins, with no unsafe-eval or wildcard script source`)
  }
}

console.log('\nambiguous: two entries matching every block is UNKNOWN, never "the first"')
console.log('\nblock offsets: a host can splice a whole element without a second parser (home-webext, W2)')
{
  let blocks = 0, bad: string[] = []
  for (const row of E.served) {
    const html = read(row.case)
    let scanned
    try { scanned = scanBlocks(html) } catch { continue }
    for (const b of scanned) {
      blocks++
      const open = html.slice(b.tagStart, b.start), close = html.slice(b.start + b.text.length, b.end)
      const st = parseStartTag(html, b.tagStart), et = parseEndTag(html, b.start + b.text.length)
      if (open !== b.attrs || st?.end !== b.start || st?.name !== b.tag) bad.push(`${row.case} @${b.tagStart}: open tag`)
      if (et?.end !== b.end || et?.name !== b.tag || !close.endsWith('>')) bad.push(`${row.case} @${b.tagStart}: close tag ${JSON.stringify(close)}`)
    }
  }
  ok(blocks > 100 && bad.length === 0, `on every served row (${blocks} blocks): html.slice(tagStart, start) is the exact start tag and html.slice(start + text.length, end) the exact end tag${bad.length ? ' — ' + bad.slice(0, 3).join('; ') : ''}`)
}

for (const row of E.ambiguous) ok((await verifyServed(read(row.case), row.history)).verdict === row.verdict, `${row.case.replace('served/', '')} under its own history: ${row.verdict} (${row.why})`)

console.log('\nstrict (file://): both genuine saves pass, all 16 tampers refuse')
const expected: StrictExpected = JSON.parse(read('strict-expected.json'))
let tampers = 0
for (const row of E.strict) {
  const v = verifyStrict(read(row.case), expected)
  if (!row.ok) tampers++
  ok(v.ok === row.ok, `${row.case.replace('strict/', '')}: ${row.ok ? 'pass' : `refuse (${v.ok ? 'PASSED' : v.reason})`}`)
}
ok(tampers === 16, 'the corpus carries exactly the 16 tamper rows')

console.log('\nhistory: anti-rollback')
for (const row of E.history) ok(acceptHistory(row.held, row.incoming, E.app).ok === row.ok, `${row.name}: ${row.ok ? 'accept' : 'refuse'} (${row.why})`)

console.log('\nthe CSP a host serves under (security §17 verifies the string)')
{
  const p = hostPolicy(history.releases[0].pins)
  ok(/script-src 'sha256-[A-Za-z0-9+/=]+' 'sha256-[A-Za-z0-9+/=]+' blob:;/.test(p), 'script-src is the two pins plus blob:, nothing else')
  ok(!p.includes('unsafe-eval') && !/script-src[^;]*unsafe-inline/.test(p), 'no unsafe-eval, no unsafe-inline scripts')
  ok(p.includes("object-src 'none'") && p.includes("base-uri 'none'") && p.includes("form-action 'none'"), "object-src, base-uri and form-action are 'none'")
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
