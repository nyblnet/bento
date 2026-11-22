#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/id's origins are ONE set: scripts/lib/id-origins.mjs. This rig pins
 * every other copy to it, and to the kernel's roster rules (ROSTER_RP_ID,
 * ROSTER_WEB_ORIGINS).
 *
 *   node scripts/test-id-origins.mjs              # the checkout
 *   node scripts/test-id-origins.mjs --root DIR   # another tree (the mutants use it)
 *   node scripts/test-id-origins.mjs --mutants    # each mutant, red on its row
 *
 * Two kinds of copy:
 *   - IMPORTERS (bento/home's library: home/web/src/identity.ts and
 *     home/web/build.mjs) must import the module and write no origin of their
 *     own.
 *   - PINNED literals, where importing is not possible or not wanted: the
 *     sign-in host's static files and worker, the directory worker (AGPL,
 *     deployed alone), the kernel, the release tooling, the hosting rules and
 *     the rigs' stubs. Each named constant must equal the canonical value.
 * Then a sweep: any quoted string in those files that is, in its entirety, an
 * id.bento.page or home.bento.page host or URL must be one of the canonical
 * values (a new constant that drifts is caught even before it has a rule).
 *
 * A copy that is missing, or whose constant cannot be found exactly once, is a
 * FAIL, never a skip: a rule that cannot see its copy has stopped guarding it.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const HERE_ROOT = path.resolve(path.dirname(SELF), '..')
const args = process.argv.slice(2)
const ROOT = args.includes('--root') ? path.resolve(args[args.indexOf('--root') + 1]) : HERE_ROOT
const CANON = 'scripts/lib/id-origins.mjs'

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

// ---- the rules -------------------------------------------------------------------------
// [file, label, regex with ONE capture, canonical key or a function of the canon]
const host = (o) => new URL(o).host
const q = `['"\`]`
const lit = (name) => new RegExp(`(?:export\\s+)?const\\s+${name}(?::[^=]+)?\\s*=\\s*${q}([^'"\`]*)${q}`, 'g')
const PINNED = [
  ['kernel/src/roster.ts', 'ROSTER_RP_ID', lit('ROSTER_RP_ID'), 'RP_ID'],
  ['kernel/src/roster.ts', 'ROSTER_WEB_ORIGINS', /ROSTER_WEB_ORIGINS[^=]*=\s*Object\.freeze\(\[\s*'([^']*)'\s*\]\)/g, 'SIGNIN_ORIGIN'],
  ['scripts/home-web-release.mjs', 'LIBRARY_ORIGIN', lit('LIBRARY_ORIGIN'), 'HOME_ORIGIN'],
  ['scripts/sign-home-web-served.mjs', 'the release library origin', /info\.libraryOrigin !== '([^']*)'/g, 'HOME_ORIGIN'],
  ['scripts/lib/id-hosting-rules.mjs', 'RP', lit('RP'), 'RP_ID'],
  ['scripts/lib/id-hosting-rules.mjs', 'SIGNIN', /export const SIGNIN = (`signin\.\$\{RP\}`)/g, (c) => `\`${host(c.SIGNIN_ORIGIN).replace(`.${c.RP_ID}`, '')}.\${RP}\``],
  ['scripts/lib/id-hosting-rules.mjs', 'HOME', lit('HOME'), (c) => host(c.HOME_ORIGIN)],
  ['scripts/lib/id-hosting-rules.mjs', 'APEX', lit('APEX'), 'APEX'],
  ['scripts/lib/id-web-directory-stub.mjs', 'HOME', lit('HOME'), 'HOME_ORIGIN'],
  ['scripts/lib/id-web-directory-stub.mjs', 'SIGNIN', lit('SIGNIN'), 'SIGNIN_ORIGIN'],
  ['scripts/lib/id-web-directory-stub.mjs', 'the enrol rpId', /rpId: '([^']*)'/g, 'RP_ID'],
  ['scripts/lib/id-signin-directory-stub.mjs', 'SIGNIN_ORIGIN', lit('SIGNIN_ORIGIN'), 'SIGNIN_ORIGIN'],
  ['scripts/lib/id-signin-directory-stub.mjs', 'RP_ID', lit('RP_ID'), 'RP_ID'],
  ['server/signin/public/signin.js', 'HOME', lit('HOME'), 'HOME_ORIGIN'],
  ['server/signin/public/signin.js', 'RP_ID', lit('RP_ID'), 'RP_ID'],
  ['server/signin/public/directory-client.js', 'DIRECTORY', lit('DIRECTORY'), 'DIRECTORY_ORIGIN'],
  ['server/signin/public/account-client.js', 'RP_ID', lit('RP_ID'), 'RP_ID'],
  ['server/signin/src/worker.js', 'DIRECTORY_ORIGIN', lit('DIRECTORY_ORIGIN'), 'DIRECTORY_ORIGIN'],
  ['server/signin/check-hosting.mjs', 'SIGNIN_ORIGIN', lit('SIGNIN_ORIGIN'), 'SIGNIN_ORIGIN'],
  ['server/signin/check-hosting.mjs', 'RP_ORIGIN', lit('RP_ORIGIN'), 'DIRECTORY_ORIGIN'],
  ['server/signin/check-hosting.mjs', 'CONNECT', /export const CONNECT = \[\s*'([^']*)'\s*\]/g, 'DIRECTORY_ORIGIN'],
  ['server/directory/src/passkey.js', 'SIGNIN_ORIGIN', lit('SIGNIN_ORIGIN'), 'SIGNIN_ORIGIN'],
  ['server/directory/src/passkey.js', 'DIRECTORY_ORIGIN', lit('DIRECTORY_ORIGIN'), 'DIRECTORY_ORIGIN'],
  ['server/directory/src/passkey.js', 'HOME_ORIGIN', lit('HOME_ORIGIN'), 'HOME_ORIGIN'],
  ['server/directory/src/passkey.js', 'PASSKEY.rpId', /rpId: '([^']*)'/g, 'RP_ID'],
]
// importers: the module, by these names, and no origin literal of their own
const IMPORTERS = [
  ['home/web/src/identity.ts', /import \* as ID_ORIGINS from '\.\.\/\.\.\/\.\.\/scripts\/lib\/id-origins\.mjs'/,
    [/export const SIGNIN_ORIGIN: string = ID_ORIGINS\.SIGNIN_ORIGIN\n/, /export const DIRECTORY: string = ID_ORIGINS\.DIRECTORY_ORIGIN\n/]],
  ['home/web/build.mjs', /import \{ DIRECTORY_ORIGIN, HOME_ORIGIN \} from '\.\.\/\.\.\/scripts\/lib\/id-origins\.mjs'/,
    [/opt\('library-origin', HOME_ORIGIN\)/, /connect-src \$\{releaseBase\}\$\{identity \? ' ' \+ DIRECTORY_ORIGIN : ''\}/]],
]

const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { return null } }

// ---- the canonical set ------------------------------------------------------------------
console.log(`=== the canonical set (${CANON})`)
let C = null
try { C = { ...(await import(pathToFileURL(path.join(ROOT, CANON)).href)) } } catch (e) { ok(false, `${CANON} cannot be loaded (${e.message})`) }
if (C) {
  const keys = ['APEX', 'RP_ID', 'DIRECTORY_ORIGIN', 'SIGNIN_ORIGIN', 'HOME_ORIGIN']
  ok(keys.every((k) => typeof C[k] === 'string' && C[k]) && Object.keys(C).sort().join() === [...keys].sort().join(), `exactly ${keys.join(', ')}, each a string`)
  const isOrigin = (o) => { try { return new URL(o).origin === o && o.startsWith('https://') } catch { return false } }
  ok(['DIRECTORY_ORIGIN', 'SIGNIN_ORIGIN', 'HOME_ORIGIN'].every((k) => isOrigin(C[k])), 'the three origins are https origins (no path, no trailing slash)')
  ok(C.DIRECTORY_ORIGIN === `https://${C.RP_ID}`, `the directory is the rp id's own origin (${C.DIRECTORY_ORIGIN})`)
  ok(host(C.SIGNIN_ORIGIN).endsWith(`.${C.RP_ID}`) && host(C.SIGNIN_ORIGIN) !== C.RP_ID, `the sign-in host is a subdomain of the rp id (${C.SIGNIN_ORIGIN})`)
  ok([C.RP_ID, host(C.HOME_ORIGIN)].every((h) => h.endsWith(`.${C.APEX}`)) && !host(C.HOME_ORIGIN).endsWith(`.${C.RP_ID}`),
    `every host sits under ${C.APEX}; home is not under the rp id (it runs no ceremony)`)
}

// ---- the pinned literals ----------------------------------------------------------------
console.log('\n=== pinned copies equal the canonical set')
const files = [...new Set([...PINNED.map((r) => r[0]), ...IMPORTERS.map((r) => r[0])])]
for (const [file, label, re, want] of PINNED) {
  const text = read(file)
  if (text === null) { ok(false, `${file} ${label}: the file is MISSING (a copy that cannot be read is a failure, not a skip)`); continue }
  const m = [...text.matchAll(re)]
  if (m.length !== 1) { ok(false, `${file} ${label}: found ${m.length} times (exactly one required)`); continue }
  const expect = !C ? undefined : typeof want === 'function' ? want(C) : C[want]
  ok(m[0][1] === expect, `${file} ${label} = ${m[0][1]}${m[0][1] === expect ? '' : ` (canonical: ${expect})`}`)
}

console.log('\n=== importers take the module and write no origin of their own')
for (const [file, imp, uses] of IMPORTERS) {
  const text = read(file)
  if (text === null) { ok(false, `${file}: the file is MISSING (a failure, not a skip)`); continue }
  ok(imp.test(text), `${file} imports ${CANON}`)
  for (const u of uses) ok((text.match(new RegExp(u.source, 'g')) ?? []).length === 1, `${file} uses the module's value: ${u.source.replace(/\\/g, '').slice(0, 70)}`)
  // any id/home host in CODE (comment lines aside), inside a string or not
  const own = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).flatMap((l) => l.match(/[a-z0-9.-]*\b(?:id|home)\.bento\.page\S*/g) ?? [])
  ok(own.length === 0, `${file} writes no id/home origin literal of its own${own.length ? ` (found ${own.join(', ')})` : ''}`)
}

console.log('\n=== the kernel: ROSTER_RP_ID and ROSTER_WEB_ORIGINS (imported, not read as text)')
try {
  const k = await import(pathToFileURL(path.join(ROOT, 'kernel/src/roster.ts')).href)
  ok(C && k.ROSTER_RP_ID === C.RP_ID, `ROSTER_RP_ID = ${k.ROSTER_RP_ID}`)
  ok(C && Array.isArray(k.ROSTER_WEB_ORIGINS) && k.ROSTER_WEB_ORIGINS.length === 1 && k.ROSTER_WEB_ORIGINS[0] === C.SIGNIN_ORIGIN && Object.isFrozen(k.ROSTER_WEB_ORIGINS),
    `ROSTER_WEB_ORIGINS = ${JSON.stringify(k.ROSTER_WEB_ORIGINS)} (the sign-in host alone, frozen)`)
} catch (e) { ok(false, `kernel/src/roster.ts cannot be loaded (${e.message.split('\n')[0]})`) }

console.log('\n=== sweep: every whole id/home host or URL literal in these files is a canonical value')
if (C) {
  const allowed = new Set([C.RP_ID, C.DIRECTORY_ORIGIN, C.SIGNIN_ORIGIN, C.HOME_ORIGIN, host(C.SIGNIN_ORIGIN), host(C.HOME_ORIGIN)])
  for (const file of files) {
    const text = read(file)
    if (text === null) continue // already a failure above
    const bad = []
    for (const m of text.matchAll(/(['"`])((?:https:\/\/)?[a-z0-9.-]*(?:id|home)\.bento\.page[a-z0-9.\-:/]*)\1/g)) {
      const v = m[2]
      if (allowed.has(v)) continue
      // a URL on an allowed origin with a path (a route) is fine; anything else is a drift
      try { const u = new URL(v); if (allowed.has(u.origin) && u.pathname !== '/') continue } catch { /* not a URL */ }
      bad.push(v)
    }
    ok(bad.length === 0, `${file}${bad.length ? `: ${bad.join(', ')} is not a canonical value` : ''}`)
  }
}

// ---- mutants ------------------------------------------------------------------------------
if (args.includes('--mutants')) {
  console.log('\n=== mutants: each applied in a copy of the files, the rig re-run there')
  const only = args.slice(args.indexOf('--mutants') + 1).filter((a) => !a.startsWith('--'))
  const E = (file, from, to, expect) => ({ file, from, to, expect })
  const MUTANTS = {
    'canon-home': E(CANON, "HOME_ORIGIN = 'https://home.bento.page'", "HOME_ORIGIN = 'https://home.bento.page.evil'", 'LIBRARY_ORIGIN = https://home.bento.page'),
    'canon-extra-key': E(CANON, "export const APEX = 'bento.page'", "export const APEX = 'bento.page'\nexport const EXTRA = 'x'", 'exactly APEX'),
    'kernel-rp': E('kernel/src/roster.ts', "ROSTER_RP_ID = 'id.bento.page'", "ROSTER_RP_ID = 'id.bento.page.evil'", 'ROSTER_RP_ID = id.bento.page.evil'),
    'kernel-origins': E('kernel/src/roster.ts', "Object.freeze(['https://signin.id.bento.page'])", "Object.freeze(['https://signin2.id.bento.page'])", 'ROSTER_WEB_ORIGINS = https://signin2'),
    'release-origin': E('scripts/home-web-release.mjs', "LIBRARY_ORIGIN = 'https://home.bento.page'", "LIBRARY_ORIGIN = 'https://home.bento.page.evil'", 'LIBRARY_ORIGIN = https://home.bento.page.evil'),
    'served-origin': E('scripts/sign-home-web-served.mjs', "info.libraryOrigin !== 'https://home.bento.page'", "info.libraryOrigin !== 'https://home2.bento.page'", 'the release library origin = https://home2'),
    'hosting-rp': E('scripts/lib/id-hosting-rules.mjs', "export const RP = 'id.bento.page'", "export const RP = 'id2.bento.page'", 'id-hosting-rules.mjs RP = id2'),
    'hosting-signin': E('scripts/lib/id-hosting-rules.mjs', 'export const SIGNIN = `signin.${RP}`', 'export const SIGNIN = `login.${RP}`', 'id-hosting-rules.mjs SIGNIN'),
    'hosting-home': E('scripts/lib/id-hosting-rules.mjs', "export const HOME = 'home.bento.page'", "export const HOME = 'home.bento.page.evil'", 'id-hosting-rules.mjs HOME = home.bento.page.evil'),
    'hosting-apex': E('scripts/lib/id-hosting-rules.mjs', "export const APEX = 'bento.page'", "export const APEX = 'bento.pages'", 'id-hosting-rules.mjs APEX = bento.pages'),
    'web-stub-home': E('scripts/lib/id-web-directory-stub.mjs', "export const HOME = 'https://home.bento.page'", "export const HOME = 'https://home.bento.page.evil'", 'id-web-directory-stub.mjs HOME ='),
    'web-stub-signin': E('scripts/lib/id-web-directory-stub.mjs', "export const SIGNIN = 'https://signin.id.bento.page'", "export const SIGNIN = 'https://signin.id.bento.page.evil'", 'id-web-directory-stub.mjs SIGNIN ='),
    'web-stub-rp': E('scripts/lib/id-web-directory-stub.mjs', "rpId: 'id.bento.page'", "rpId: 'id2.bento.page'", 'id-web-directory-stub.mjs the enrol rpId'),
    'signin-stub-origin': E('scripts/lib/id-signin-directory-stub.mjs', "export const SIGNIN_ORIGIN = 'https://signin.id.bento.page'", "export const SIGNIN_ORIGIN = 'https://signin.id.bento.page.evil'", 'id-signin-directory-stub.mjs SIGNIN_ORIGIN ='),
    'signin-stub-rp': E('scripts/lib/id-signin-directory-stub.mjs', "export const RP_ID = 'id.bento.page'", "export const RP_ID = 'id2.bento.page'", 'id-signin-directory-stub.mjs RP_ID ='),
    'signin-home': E('server/signin/public/signin.js', "const HOME = 'https://home.bento.page'", "const HOME = 'https://home.bento.page.evil'", 'signin.js HOME = https://home.bento.page.evil'),
    'signin-rp': E('server/signin/public/signin.js', "const RP_ID = 'id.bento.page'", "const RP_ID = 'id2.bento.page'", 'signin.js RP_ID = id2'),
    'signin-directory': E('server/signin/public/directory-client.js', "DIRECTORY = 'https://id.bento.page'", "DIRECTORY = 'https://id.bento.page.evil'", 'directory-client.js DIRECTORY ='),
    'signin-account-rp': E('server/signin/public/account-client.js', "RP_ID = 'id.bento.page'", "RP_ID = 'id2.bento.page'", 'account-client.js RP_ID ='),
    'signin-worker': E('server/signin/src/worker.js', "DIRECTORY_ORIGIN = 'https://id.bento.page'", "DIRECTORY_ORIGIN = 'https://id.bento.page.evil'", 'worker.js DIRECTORY_ORIGIN ='),
    'signin-hosting-origin': E('server/signin/check-hosting.mjs', "SIGNIN_ORIGIN = 'https://signin.id.bento.page'", "SIGNIN_ORIGIN = 'https://signin2.id.bento.page'", 'check-hosting.mjs SIGNIN_ORIGIN ='),
    'signin-hosting-rp': E('server/signin/check-hosting.mjs', "RP_ORIGIN = 'https://id.bento.page'", "RP_ORIGIN = 'https://id2.bento.page'", 'check-hosting.mjs RP_ORIGIN ='),
    'signin-hosting-connect': E('server/signin/check-hosting.mjs', "CONNECT = ['https://id.bento.page']", "CONNECT = ['https://id2.bento.page']", 'check-hosting.mjs CONNECT ='),
    'directory-signin': E('server/directory/src/passkey.js', "export const SIGNIN_ORIGIN = 'https://signin.id.bento.page'", "export const SIGNIN_ORIGIN = 'https://signin.id.bento.page.evil'", 'passkey.js SIGNIN_ORIGIN ='),
    'directory-self': E('server/directory/src/passkey.js', "export const DIRECTORY_ORIGIN = 'https://id.bento.page'", "export const DIRECTORY_ORIGIN = 'https://id2.bento.page'", 'passkey.js DIRECTORY_ORIGIN ='),
    'directory-home': E('server/directory/src/passkey.js', "export const HOME_ORIGIN = 'https://home.bento.page'", "export const HOME_ORIGIN = 'https://home.bento.page.evil'", 'passkey.js HOME_ORIGIN ='),
    'directory-rp': E('server/directory/src/passkey.js', "  rpId: 'id.bento.page',", "  rpId: 'id2.bento.page',", 'passkey.js PASSKEY.rpId ='),
    'home-own-signin': E('home/web/src/identity.ts', 'export const SIGNIN_ORIGIN: string = ID_ORIGINS.SIGNIN_ORIGIN', "export const SIGNIN_ORIGIN: string = 'https://signin.id.bento.page'", 'identity.ts writes no id/home origin literal'),
    'home-own-directory': E('home/web/src/identity.ts', 'export const DIRECTORY: string = ID_ORIGINS.DIRECTORY_ORIGIN', "export const DIRECTORY: string = 'https://id.bento.page'", 'identity.ts writes no id/home origin literal'),
    'build-own-directory': E('home/web/build.mjs', "${identity ? ' ' + DIRECTORY_ORIGIN : ''}", "${identity ? ' https://id.bento.page' : ''}", 'build.mjs writes no id/home origin literal'),
    'build-own-home': E('home/web/build.mjs', "opt('library-origin', HOME_ORIGIN)", "opt('library-origin', 'https://home.bento.page')", 'build.mjs writes no id/home origin literal'),
    // a new constant that drifts, before any rule names it: the sweep
    'new-drifted-constant': E('server/signin/public/signin.js', "const RP_ID = 'id.bento.page'", "const RP_ID = 'id.bento.page'\nconst HOME2 = 'https://home.bento.page.evil'", 'signin.js: https://home.bento.page.evil is not a canonical value'),
    // a copy that goes missing is a FAIL, never a skip
    'copy-missing': { file: 'server/signin/src/worker.js', remove: true, expect: 'worker.js DIRECTORY_ORIGIN: the file is MISSING' },
  }
  let killed = 0, ran = 0
  for (const [name, m] of Object.entries(MUTANTS).filter(([n]) => !only.length || only.includes(n))) {
    ran++
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-id-origins-'))
    try {
      for (const f of [CANON, ...files, 'kernel/src']) fs.cpSync(path.join(ROOT, f), path.join(tmp, f), { recursive: true })
      const target = path.join(tmp, m.file)
      if (m.remove) fs.rmSync(target)
      else {
        const text = fs.readFileSync(target, 'utf8')
        const n = text.split(m.from).length - 1
        if (n !== 1) { ok(false, `MUTANT ${name}: "${m.from}" occurs ${n} times in ${m.file} (exactly one required)`); continue }
        fs.writeFileSync(target, text.replace(m.from, () => m.to))
        if (!fs.readFileSync(target, 'utf8').includes(m.to)) { ok(false, `MUTANT ${name}: not applied`); continue }
      }
      const r = spawnSync(process.execPath, [SELF, '--root', tmp], { encoding: 'utf8' })
      const fails = r.stdout.split('\n').filter((l) => l.startsWith('  FAIL'))
      const onRow = fails.some((l) => l.includes(m.expect))
      const done = /checks passed/.test(r.stdout)
      if (onRow && r.status === 1 && done) killed++
      ok(onRow && r.status === 1 && done, `MUTANT ${name}: red on its row ("${m.expect}"; ${fails.length} red, exit ${r.status}${done ? '' : ', DID NOT COMPLETE'})`)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }
  console.log(`\n${killed}/${ran} mutants killed`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
