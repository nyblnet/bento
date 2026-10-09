#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The app payload fingerprint the publish gates compare (scripts/lib/apphash.mjs):
//
//   node scripts/test-apphash.ts
//
// WHAT THIS PROVES. appHash reads both payload encodings — `deflate-b86`
// (1.2.0 on) and `deflate-b64` (older shells) — and returns null ONLY for a
// file with no payload blocks; sameApp never treats two nulls as a match.
// That last rule is the point: run from a checkout older than the b86 switch,
// publish-site's shell-consistency gate hashed the shell and every deck to
// null and passed with null === null, checking nothing, while
// reseed-guestbook crashed on null.slice. Both scripts now use this one
// helper (no private copies, which is how one of them went stale), and both
// REFUSE a payload-less shell instead of comparing it.

import { readFileSync } from 'node:fs'
import { appHash, sameApp } from './lib/apphash.mjs'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

const shell = (type: string, payloads: string[]) =>
  `<!doctype html><html><head><script type="application/json" id="bento-doc">{}</script></head><body>` +
  payloads.map((p) => `<script type="bento/${type}" data-kind="js">${p}</script>`).join('') + `</body></html>`
// base86 text carries characters base64 never does (the old matcher's
// [A-Za-z0-9+/=] class stopped at the first of them)
const B86 = ['k#9$Qz!r*~^;`(a)', 'Zp%&-_.{}|:?@[]']

console.log('\nappHash')
const h86 = appHash(shell('deflate-b86', B86))
ok(typeof h86 === 'string' && /^[0-9a-f]{64}$/.test(h86), 'a deflate-b86 shell hashes')
ok(typeof appHash(shell('deflate-b64', ['QUJD', 'REVG'])) === 'string', 'a deflate-b64 shell (pre-1.2.0) hashes')
ok(appHash(shell('deflate-b86', B86)) === h86, 'deterministic')
ok(appHash(shell('deflate-b86', [B86[0], B86[1] + 'x'])) !== h86, 'any payload byte changes it')
ok(appHash(shell('deflate-b86', [B86[0] + B86[1].slice(0, 3), B86[1].slice(3)])) === h86, 'the payload, not how it is split across blocks, is what is hashed')
ok(appHash('<!doctype html><html><body><p>no runtime</p></body></html>') === null, 'a file with no payload blocks is null')
// the old matcher, run on today's shell: the vacuous-gate scenario, reproduced
const oldMatcher = (html: string) => [...html.matchAll(/type="bento\/deflate-b64"[^>]*>([A-Za-z0-9+/=]+)</g)].length
ok(oldMatcher(shell('deflate-b86', B86)) === 0 && appHash(shell('deflate-b86', B86)) !== null,
  'the pre-#495 matcher finds nothing in a b86 shell; appHash finds it')

console.log('\nsameApp')
ok(sameApp(h86, h86), 'the same payload matches')
ok(!sameApp(h86, appHash(shell('deflate-b64', ['QUJD']))), 'a different payload does not')
ok(!sameApp(null, null), 'null never matches null — "cannot tell" is not "the same"')
ok(!sameApp(null, h86) && !sameApp(h86, null), 'null never matches a hash')

console.log('\nthe scripts use it, and refuse a payload-less shell')
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '')
for (const f of ['scripts/publish-site.mjs', 'scripts/reseed-guestbook.mjs']) {
  const src = strip(readFileSync(f, 'utf8'))
  ok(/import \{ appHash, sameApp \} from '\.\/lib\/apphash\.mjs'/.test(src) && !/deflate-b/.test(src) && !/createHash/.test(src),
    `${f}: imports the shared helper, keeps no private matcher`)
  ok(!/appHash\([^)]*\)\s*[!=]==/.test(src) && !/[!=]==\s*(shellHash|freshHash|curHash)\b(?!\s*===?\s*null)/.test(src.replace(/(shellHash|freshHash) === null/g, '')),
    `${f}: compares hashes only through sameApp`)
}
const ps = strip(readFileSync('scripts/publish-site.mjs', 'utf8'))
ok(/if \(shellHash === null\) die\(/.test(ps), 'publish-site: a release shell with no payload is a refusal')
const rs = strip(readFileSync('scripts/reseed-guestbook.mjs', 'utf8'))
const guard = rs.indexOf('if (freshHash === null)'), firstUse = rs.indexOf('freshHash.slice')
ok(guard >= 0 && firstUse > guard, 'reseed-guestbook: stops on a payload-less shell before any freshHash.slice')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
