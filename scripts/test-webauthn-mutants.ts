#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the offline WebAuthn assertion verifier (kernel/src/webauthn.ts).
//
//   node scripts/test-webauthn-mutants.ts
//
// Each mutant below removes or loosens ONE check in a COPY of kernel/src, and
// scripts/test-webauthn.ts must then fail. The unmutated copy must pass first
// (positive control), and every mutant must apply to exactly one place in the
// source, so a refactor that moves the code makes this rig fail rather than
// pass vacuously.
//
// One check has no mutant here on purpose: high-S NORMALISATION. WebCrypto (in
// Node and in browsers) already accepts a high-S signature, so removing the
// normalisation changes nothing in JS. It is there for ports whose ECDSA
// libraries refuse high-S; the real high-S rows are what those ports must pass.
// The opposite mutant (REFUSING high-S, the rule bento's own statements use)
// is below and must go red. Likewise the r, s < n range check in derToRaw:
// WebCrypto refuses an out-of-range r or s by itself, so in JS the check is
// redundant (the der-r-is-n row is refused either way); it stays for ports.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Mutant = { name: string; file: 'webauthn.ts' | 'statements.ts'; from: string; to: string }
const MUTANTS: Mutant[] = [
  { name: 'duplicate keys are not detected (JSON.parse behaviour)', file: 'webauthn.ts',
    from: '        if (obj.has(k)) throw new Dup()\n', to: '' },
  { name: 'a byte-order mark is swallowed', file: 'webauthn.ts',
    from: "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })", to: "new TextDecoder('utf-8', { fatal: true })" },
  { name: 'clientDataJSON decodes leniently', file: 'webauthn.ts',
    from: "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })", to: "new TextDecoder('utf-8', { ignoreBOM: true })" },
  { name: 'trailing text after the JSON is ignored', file: 'webauthn.ts',
    from: '    return i === text.length ? v : null\n', to: '    return v\n' },
  { name: 'a top-level array is read', file: 'webauthn.ts',
    from: '  const cd = parseStrictJson(cdText)\n',
    to: '  const cd = ((x) => (Array.isArray(x) ? x[0] : x))(parseStrictJson(cdText))\n' },
  { name: 'type is not checked', file: 'webauthn.ts',
    from: "  if (cd.get('type') !== 'webauthn.get') return no('type')\n", to: '' },
  { name: 'webauthn.create is accepted as a type', file: 'webauthn.ts',
    from: "  if (cd.get('type') !== 'webauthn.get') return no('type')\n",
    to: "  if (cd.get('type') !== 'webauthn.get' && cd.get('type') !== 'webauthn.create') return no('type')\n" },
  { name: 'challenge is not checked', file: 'webauthn.ts',
    from: "  if (!chBytes || !same(chBytes, opts.challenge)) return no('challenge')\n", to: '' },
  { name: 'challenge decodes leniently (padding, trailing bits)', file: 'webauthn.ts',
    from: "  const chBytes = typeof ch === 'string' ? b64uDec(ch) : null\n",
    to: "  const chBytes = typeof ch === 'string' ? new Uint8Array(Buffer.from(ch, 'base64url')) : null\n" },
  { name: 'challenge compared as a prefix', file: 'webauthn.ts',
    from: "  if (!chBytes || !same(chBytes, opts.challenge)) return no('challenge')\n",
    to: "  if (!chBytes || !same(chBytes.subarray(0, opts.challenge.length), opts.challenge.subarray(0, chBytes.length))) return no('challenge')\n" },
  { name: 'origin is not checked', file: 'webauthn.ts',
    from: "  if (typeof origin !== 'string' || !opts.origins.includes(origin)) return no('origin')\n", to: '' },
  { name: 'origin accepts subdomains of a listed host', file: 'webauthn.ts',
    from: "  if (typeof origin !== 'string' || !opts.origins.includes(origin)) return no('origin')\n",
    to: "  if (typeof origin !== 'string' || !opts.origins.some((o) => origin === o || origin.endsWith('.' + o.slice(8)))) return no('origin')\n" },
  { name: 'origin accepts the parent of a listed host', file: 'webauthn.ts',
    from: "  if (typeof origin !== 'string' || !opts.origins.includes(origin)) return no('origin')\n",
    to: "  if (typeof origin !== 'string' || !opts.origins.some((o) => origin === o || o.endsWith('.' + origin.slice(8)))) return no('origin')\n" },
  { name: 'origin compared case-insensitively and without a trailing slash', file: 'webauthn.ts',
    from: "  if (typeof origin !== 'string' || !opts.origins.includes(origin)) return no('origin')\n",
    to: "  if (typeof origin !== 'string' || !opts.origins.includes(origin.toLowerCase().replace(/\\/$/, ''))) return no('origin')\n" },
  { name: 'crossOrigin is not checked', file: 'webauthn.ts',
    from: "  if (cd.has('crossOrigin') && cd.get('crossOrigin') !== false) return no('cross-origin')\n", to: '' },
  { name: 'crossOrigin "false" (a string) passes', file: 'webauthn.ts',
    from: "cd.get('crossOrigin') !== false) return no('cross-origin')",
    to: "cd.get('crossOrigin') !== false && cd.get('crossOrigin') !== 'false') return no('cross-origin')" },
  { name: 'crossOrigin checked only when truthy', file: 'webauthn.ts',
    from: "cd.get('crossOrigin') !== false) return no('cross-origin')",
    to: "cd.get('crossOrigin') === true) return no('cross-origin')" },
  { name: 'topOrigin is allowed', file: 'webauthn.ts',
    from: "  if (cd.has('topOrigin')) return no('cross-origin')\n", to: '' },
  { name: 'rpIdHash is not checked', file: 'webauthn.ts',
    from: "  if (!same(ad.subarray(0, 32), await sha256(te.encode(opts.rpId)))) return no('rp')\n", to: '' },
  { name: 'rpIdHash may be the parent domain', file: 'webauthn.ts',
    from: "  if (!same(ad.subarray(0, 32), await sha256(te.encode(opts.rpId)))) return no('rp')\n",
    to: "  if (!same(ad.subarray(0, 32), await sha256(te.encode(opts.rpId))) && !same(ad.subarray(0, 32), await sha256(te.encode(opts.rpId.split('.').slice(1).join('.'))))) return no('rp')\n" },
  { name: 'UP is not required', file: 'webauthn.ts',
    from: "  if (!(flags & FLAG_UP)) return no('up')\n", to: '' },
  { name: 'UV is not required', file: 'webauthn.ts',
    from: "  if (!(flags & FLAG_UV)) return no('uv')\n", to: '' },
  { name: 'the AT flag is allowed on an assertion', file: 'webauthn.ts',
    from: "  if (flags & FLAG_AT) return no('grammar')\n", to: '' },
  { name: 'trailing authenticatorData without ED', file: 'webauthn.ts',
    from: "  if (!(flags & FLAG_ED) && ad.length !== 37) return no('grammar')\n", to: '' },
  { name: 'ED set with no extension bytes', file: 'webauthn.ts',
    from: "  if ((flags & FLAG_ED) && ad.length === 37) return no('grammar')\n", to: '' },
  { name: 'BS without BE', file: 'webauthn.ts',
    from: "  if ((flags & FLAG_BS) && !(flags & FLAG_BE)) return no('grammar')\n", to: '' },
  { name: 'high-S is REFUSED (the statements rule, wrong for this encoding)', file: 'webauthn.ts',
    from: '  const raw = normaliseS(raw0)\n', to: "  if (isHighS(raw0)) return no('signature')\n  const raw = raw0\n" },
  { name: 'the signature is not verified', file: 'webauthn.ts',
    from: "  if (!(await crypto.subtle.verify(SIGN_ALG, key, raw as BufferSource, signed as BufferSource))) return no('signature')\n", to: '' },
  { name: 'the signature does not cover clientDataJSON', file: 'webauthn.ts',
    from: '  signed.set(await sha256(cdj), ad.length)\n', to: '' },
  { name: 'DER integers need not be minimal', file: 'webauthn.ts',
    from: '    if (len > 1 && v[0] === 0 && !(v[1] & 0x80)) return null // not minimal\n', to: '' },
  { name: 'DER may carry trailing bytes', file: 'webauthn.ts',
    from: '  return i === der.length ? out : null\n', to: '  return out\n' },
  { name: 'DER sequence length is not checked', file: 'webauthn.ts',
    from: "der[0] !== 0x30 || der[1] !== der.length - 2) return null", to: "der[0] !== 0x30) return null" },
  { name: 'a raw 64-byte signature is taken as is', file: 'webauthn.ts',
    from: '  const raw0 = derToRaw(der)\n', to: '  const raw0 = der.length === 64 ? der : derToRaw(der)\n' },
  { name: 'the signature counter is not checked', file: 'webauthn.ts',
    from: "    if ((signCount !== 0 || stored !== 0) && signCount <= stored) return no('sign-count')\n", to: '' },
  { name: 'an equal counter passes', file: 'webauthn.ts',
    from: "    if ((signCount !== 0 || stored !== 0) && signCount <= stored) return no('sign-count')\n",
    to: "    if ((signCount !== 0 || stored !== 0) && signCount < stored) return no('sign-count')\n" },
  { name: 'a zero counter after a nonzero stored one passes', file: 'webauthn.ts',
    from: "    if ((signCount !== 0 || stored !== 0) && signCount <= stored) return no('sign-count')\n",
    to: "    if (signCount !== 0 && signCount <= stored) return no('sign-count')\n" },
  { name: 'an empty origin list is not refused', file: 'webauthn.ts',
    from: "!Array.isArray(opts.origins) || opts.origins.length === 0 ||", to: "!Array.isArray(opts.origins) ||" },
  { name: 'base64url decoding ignores trailing bits', file: 'statements.ts',
    from: '  return b64uEnc(out) === s ? out : null', to: '  return out' },
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'webauthn-mutant-'))
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  cpSync(join(root, 'kernel/fixtures'), join(d, 'kernel/fixtures'), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  cpSync(join(root, 'scripts/test-webauthn.ts'), join(d, 'scripts/test-webauthn.ts'))
  return d
}
function run(d: string) {
  const r = spawnSync(process.execPath, [join(d, 'scripts/test-webauthn.ts')], { encoding: 'utf8' })
  const tail = (r.stdout.match(/\d+\/\d+ checks passed/g) ?? []).pop() ?? `(no count; exit ${r.status})`
  return { status: r.status, tail, fails: (r.stdout.match(/^ {2}FAIL/gm) ?? []).length }
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  const r = run(d)
  ok(r.status === 0 && r.fails === 0, `test-webauthn.ts: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants, each one loosened check: every one must turn the rig red`)
for (const m of MUTANTS) {
  const d = tree()
  const p = join(d, 'kernel/src', m.file)
  const src = readFileSync(p, 'utf8')
  const n = src.split(m.from).length - 1
  ok(n === 1, `applies exactly once: ${m.name} (found ${n})`)
  if (n === 1) {
    writeFileSync(p, src.replace(m.from, () => m.to))
    const r = run(d)
    ok(r.status !== 0 && r.fails > 0, `killed: ${m.name} — ${r.status === 0 ? 'green' : `${r.fails} FAIL`}`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
