#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext bento/connect agent rig.
//
//   node scripts/test-webext-id.ts
//
// WHAT THIS PROVES. The extension's bento/connect code IS the kernel reference,
// unaltered: home/webext/src/id/gen/ is a current type-strip of kernel/src
// (statements, address, display table, recovery), with no leftovers, and
// kernel's own rigs, re-pointed at that copy, pass every row of
// kernel/fixtures/identity-v1.json and recovery-v1.json, exactly as many rows
// as on kernel's source.

import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { generate } = await import('./gen-webext-id.mjs')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('\n— the extension runs the kernel reference, unaltered')
const fresh = generate() as Record<string, string>
for (const [name, js] of Object.entries(fresh)) {
  let have = ''
  try { have = readFileSync(join(root, 'home/webext/src/id/gen', name), 'utf8') } catch { /* missing */ }
  ok(have === js, `home/webext/src/id/gen/${name} is the current type-strip of kernel/src (run node scripts/gen-webext-id.mjs if not)`)
}
const extra = readdirSync(join(root, 'home/webext/src/id/gen')).filter((f) => !(f in fresh))
ok(extra.length === 0, `no leftover files in home/webext/src/id/gen${extra.length ? ` (${extra.join(', ')})` : ''}`)
ok(Object.values(fresh).every((js) => !/from '[^']*\.ts'/.test(js)), 'every import in the generated copy resolves to a generated .js sibling')

// Kernel's own rigs, re-pointed at the extension's generated copy: every row
// kernel checks is checked against the code the extension ships, and must pass
// as many rows as on kernel's source, so a stale copy can't pass on old vectors.
const dir = mkdtempSync(join(tmpdir(), 'webext-id-'))
const run = (file: string) => {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  const tail = (r.stdout.trim().split('\n').at(-1) ?? '')
  const m = tail.match(/^(\d+)\/(\d+) checks passed$/)
  return { ok: r.status === 0 && !!m && m[1] === m[2], total: m ? Number(m[2]) : 0, tail: tail || r.stderr.trim().split('\n').slice(-3).join(' | ') }
}
for (const [rig, contract] of [['test-statements.ts', 'kernel/fixtures/identity-v1.json'], ['test-recovery.ts', 'kernel/fixtures/recovery-v1.json']]) {
  console.log(`\n— ${contract}, against the extension's copy (scripts/${rig})`)
  const src = readFileSync(join(root, 'scripts', rig), 'utf8')
  const gen = (f: string) => pathToFileURL(join(root, 'home/webext/src/id/gen', f)).href
  const swapped = src
    .replace(/from '\.\.\/kernel\/src\/(statements|address|recovery)\.ts'/g, (_m, f) => `from '${gen(f + '.js')}'`)
    .replace("from '../kernel/src/identity.ts'", `from '${pathToFileURL(join(root, 'kernel/src/identity.ts')).href}'`)
    .replace(/join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'/g, `join(${JSON.stringify(root)}`)
  ok(swapped !== src && !/from '\.\.\/kernel\/src\/(statements|address|recovery)\.ts'/.test(swapped), `${rig} is re-pointed at the extension's generated files`)
  const f = join(dir, rig)
  writeFileSync(f, swapped)
  const kernel = run(join(root, 'scripts', rig))
  const ext = run(f)
  ok(kernel.ok, `kernel's own ${rig} passes on kernel's source (${kernel.tail})`)
  ok(ext.ok && ext.total === kernel.total, `every row passes on the extension's code, as many as kernel's own run (${ext.tail} vs kernel ${kernel.total})`)
}

// ---------------------------------------------------------------------------
// Argon2id: @noble/hashes 2.4.0, vendored and pinned (security §28 + the
// 2026-10-21 conditions). Every row runs on every change; none is skippable.
{
  const { createHash, argon2: nodeArgon2 } = await import('node:crypto')
  const VDIR = join(root, 'home/webext/src/id/vendor/noble-hashes')
  const V = JSON.parse(readFileSync(join(VDIR, 'VENDOR.json'), 'utf8'))
  console.log('\n— the vendored files are exactly the pinned ones')
  const onDisk = readdirSync(VDIR).filter((f) => f !== 'VENDOR.json').sort()
  ok(JSON.stringify(onDisk) === JSON.stringify(Object.keys(V.files).sort()), `no file added or missing (${onDisk.length} files)`)
  for (const [f, h] of Object.entries(V.files as Record<string, string>)) {
    let got = ''
    try { got = createHash('sha256').update(readFileSync(join(VDIR, f))).digest('hex') } catch { /* missing */ }
    ok(got === h, `${f} matches its pinned sha256`)
  }
  ok(V.package === '@noble/hashes' && V.version === '2.4.0' && /^sha512-/.test(V.integrity), 'the manifest names the package, version and registry integrity')

  const noble = await import('../home/webext/src/id/vendor/noble-hashes/argon2.js')
  const a2 = await import('../home/webext/src/id/argon2.js')
  const rec = await import('../home/webext/src/id/gen/recovery.js')
  const RV = JSON.parse(readFileSync(join(root, 'kernel/fixtures/recovery-v1.json'), 'utf8'))
  const hex = (u: Uint8Array) => Buffer.from(u).toString('hex')
  const un = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'))
  const native = (pw: Uint8Array, salt: Uint8Array, o: { t: number; m: number; p: number; dkLen: number }) =>
    new Promise<string>((res, rej) => nodeArgon2('argon2id', { message: pw, nonce: salt, parallelism: o.p, tagLength: o.dkLen, memory: o.m, passes: o.t }, (e: any, k: any) => (e ? rej(e) : res(hex(new Uint8Array(k))))))

  console.log('\n— the primitive: RFC 9106 §5.3 on the vendored copy')
  const r = RV.rfc9106
  const rfc = (opts = {}) => noble.argon2idAsync(un(r.password), un(r.salt), { t: r.passes, m: r.memoryKiB, p: r.parallelism, dkLen: r.tagLength, key: un(r.secret), personalization: un(r.ad), ...opts })
  ok(hex(await rfc()) === r.tag, 'Argon2id(RFC 9106 §5.3 inputs, with secret and associated data) = the published tag')
  ok(hex(await rfc({ version: 0x10 })) !== r.tag, 'MUTANT version 1.0 (no XOR into the existing block) does not reproduce the tag — the vector detects it')
  ok(hex(await rfc({ p: 2 })) !== r.tag, 'MUTANT a wrong lane count does not reproduce the tag')
  ok(hex(await rfc({ t: 2 })) !== r.tag, 'MUTANT a wrong pass count does not reproduce the tag')

  console.log('\n— the signed parameters, and every recovery-v1 derivation, through the wrapper')
  ok(a2.NOBLE_OPTS.t === 3 && a2.NOBLE_OPTS.m === 65536 && a2.NOBLE_OPTS.p === 1 && a2.NOBLE_OPTS.dkLen === 32 && a2.NOBLE_OPTS.version === 0x13 && Object.isFrozen(a2.NOBLE_OPTS), 'the wrapper is pinned to v0x13, p=1, 64 MiB, t=3, 32 bytes, and frozen')
  const d = RV.derivations
  ok(hex(await a2.argon2id(un(d.code), un(d.salt))) === d.argon2_A, 'A = Argon2id(code bytes, salt) — the fixture\'s value')
  ok(hex(await rec.recoveryWrapKey(un(d.code), un(d.salt), a2.argon2id)) === d.wrapKey, 'wrap key = HKDF(A, empty, "bento/id/rc-wrap/v1") — through the extension\'s own code end to end')
  ok(hex(await rec.recoveryVerifier(un(d.code), un(d.saltV), a2.argon2id)) === d.verifier, 'verifier = Argon2id(code bytes, salt_v)')

  console.log('\n— randomized cross-check against Node\'s native Argon2id')
  let agree = 0, tries = 0
  for (let i = 0; i < 24; i++) {
    const o = { t: 1 + (i % 3), m: 8 * (1 + ((i * 7) % 32)), p: 1, dkLen: 32 }
    const pw = crypto.getRandomValues(new Uint8Array(1 + (i * 5) % 40)), salt = crypto.getRandomValues(new Uint8Array(16))
    tries++
    if (hex(await noble.argon2idAsync(pw, salt, o)) === await native(pw, salt, o)) agree++
  }
  ok(agree === tries, `random inputs at small costs: ${agree}/${tries} equal to native`)
  for (let i = 0; i < 2; i++) {
    const pw = crypto.getRandomValues(new Uint8Array(10)), salt = crypto.getRandomValues(new Uint8Array(16))
    ok(hex(await a2.argon2id(pw, salt)) === await native(pw, salt, { t: 3, m: 65536, p: 1, dkLen: 32 }), `random code at the SIGNED parameters equals native (${i + 1}/2)`)
  }

  console.log('\n— the 64 MiB block array reads zero afterwards (probe)')
  {
    const Orig = globalThis.Uint32Array
    const big: Uint32Array[] = []
    ;(globalThis as any).Uint32Array = new Proxy(Orig, { construct(T, args) { const a = Reflect.construct(T, args); if (a.length >= (64 * 1024 * 1024) / 4) big.push(a); return a } })
    let k: Uint8Array
    try { k = await a2.argon2id(crypto.getRandomValues(new Uint8Array(10)), crypto.getRandomValues(new Uint8Array(16))) } finally { (globalThis as any).Uint32Array = Orig }
    ok(big.length === 1, `the probe saw the derivation's block array (${big.length} array of ≥ 64 MiB)`)
    ok(big.length === 1 && big[0].every((x) => x === 0), 'after the derivation every word of it is zero (noble\'s clean; residual: an engine copy made before zeroing is out of reach)')
    ok(k!.length === 32 && !k!.every((x) => x === 0), 'and the derivation still produced a real 32-byte key')
  }

  console.log('\n— an allocation failure is "recovery unavailable", never a crash or weaker parameters')
  {
    const Orig = globalThis.Uint32Array
    const sizes: number[] = []
    ;(globalThis as any).Uint32Array = new Proxy(Orig, { construct(T, args) { const n = typeof args[0] === 'number' ? args[0] : 0; if (n >= (64 * 1024 * 1024) / 4) { sizes.push(n); throw new RangeError('Array buffer allocation failed') } return Reflect.construct(T, args) } })
    let err: any = null
    try { await a2.argon2id(new Uint8Array(10), new Uint8Array(16)) } catch (e) { err = e } finally { (globalThis as any).Uint32Array = Orig }
    ok(err?.name === 'RecoveryUnavailable' && !(err instanceof RangeError), `the failure surfaces as RecoveryUnavailable (${err?.name})`)
    ok(sizes.length === 1, `exactly one allocation attempt, at full size: no retry, no smaller fallback (${sizes.length})`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
