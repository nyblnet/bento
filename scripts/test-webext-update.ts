#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext update-notice rig.
//
//   node scripts/test-webext-update.ts
//
// WHAT THIS PROVES. Store installs update themselves; an extension loaded
// unpacked NEVER does — Chrome ignores `update_url` for a development install.
// So the GitHub route needs telling, and the telling has to be exactly right in
// both directions:
//
//   · a STORE user must never see it. They cannot act on it, the browser has
//     already handled it, and a notice about a version they already have is the
//     kind of thing that gets an extension uninstalled.
//   · an UNPACKED user must see it, because nothing else will ever say so.
//
// Everything here is a silent failure by nature: a comparison that goes the
// wrong way, a fetch that throws, an install type that cannot be read. None of
// it breaks anything visible, which is exactly why it needs a rig.

import { compareVersions, isSelfManaged, checkForUpdate, autoCheckEnabled } from '../home/webext/src/update.js'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ---- version comparison -----------------------------------------------------
{
  ok(compareVersions('1.0.1', '1.0.0') > 0, '1.0.1 is newer than 1.0.0')
  ok(compareVersions('1.0.0', '1.0.1') < 0, 'and the reverse holds')
  ok(compareVersions('1.0.0', '1.0.0') === 0, 'equal versions compare equal')
  // The one that bites: string comparison puts "1.0.10" before "1.0.9".
  ok(compareVersions('1.0.10', '1.0.9') > 0,
    '1.0.10 is newer than 1.0.9 — compared as numbers, not as text')
  ok(compareVersions('1.1', '1.0.9') > 0, 'a shorter version still compares by significance')
  ok(compareVersions('2.0', '1.9.9') > 0, 'a major bump wins over everything below it')
}

// ---- who gets asked ---------------------------------------------------------
{
  ok(await isSelfManaged({ getSelf: async () => ({ installType: 'development' }) }),
    'an unpacked install is one that must be told')
  ok(!(await isSelfManaged({ getSelf: async () => ({ installType: 'normal' }) })),
    'a store install is NOT — the browser already updates it')
  for (const t of ['sideload', 'admin', 'other']) {
    ok(await isSelfManaged({ getSelf: async () => ({ installType: t }) }),
      `${t} is told too — it also arrives outside the store's update mechanism`)
  }
  ok(!(await isSelfManaged({ getSelf: async () => { throw new Error('no API') } })),
    'and an install type that cannot be read stays silent rather than guessing')
}

// ---- the check --------------------------------------------------------------
const dev = async () => ({ installType: 'development' })
const store = async () => ({ installType: 'normal' })
const serving = (body: any, okFlag = true) => async () => ({
  ok: okFlag, async json() { return body },
})

{
  let saved: any = 'untouched'
  const found = await checkForUpdate({
    getSelf: dev, currentVersion: '1.0.0',
    fetch: serving({ version: '1.1.0', url: 'https://example/rel', sha256: 'abc' }),
    put: async (v: any) => { saved = v },
  })
  ok(found?.version === '1.1.0', `a newer release is reported (${found?.version})`)
  ok(found?.url === 'https://example/rel', 'with where to get it')
  ok(found?.sha256 === 'abc',
    'and the digest, which the person installing can check because the package is reproducible')
  ok(saved?.version === '1.1.0', 'and it is stored, so the surfaces need no network of their own')
}
{
  let saved: any = 'untouched'
  const found = await checkForUpdate({
    getSelf: dev, currentVersion: '1.1.0',
    fetch: serving({ version: '1.1.0' }),
    put: async (v: any) => { saved = v },
  })
  ok(found === null && saved === null, 'the same version reports nothing, and clears any old notice')
}
{
  let saved: any = 'untouched'
  const found = await checkForUpdate({
    getSelf: dev, currentVersion: '1.2.0',
    fetch: serving({ version: '1.1.0' }),
    put: async (v: any) => { saved = v },
  })
  ok(found === null && saved === null,
    'a server BEHIND this copy reports nothing — a downgrade is not an update')
}
{
  // The case that matters most: a store user must never be nagged, and must not
  // cost a network request either.
  let fetched = false
  let saved: any = 'untouched'
  const found = await checkForUpdate({
    getSelf: store, currentVersion: '1.0.0',
    fetch: async () => { fetched = true; return serving({ version: '9.9.9' })() },
    put: async (v: any) => { saved = v },
  })
  ok(found === null, 'a store install is never told about a newer version')
  ok(fetched === false, 'and never even asks — no request for the majority of users')
  ok(saved === null, 'any notice from a previous unpacked life is cleared')
}
{
  const found = await checkForUpdate({
    getSelf: dev, currentVersion: '1.0.0',
    fetch: async () => { throw new Error('offline') },
    put: async () => {},
  })
  ok(found === null, 'being offline is silent — a broken courtesy must not look like a broken product')
}
{
  const found = await checkForUpdate({
    getSelf: dev, currentVersion: '1.0.0',
    fetch: serving({ version: '2.0.0' }, false), // 404
    put: async () => {},
  })
  ok(found === null, 'a non-200 is silent too')
}
{
  const found = await checkForUpdate({
    getSelf: dev, currentVersion: '1.0.0',
    fetch: serving({ notes: 'nothing useful' }),
    put: async () => {},
  })
  ok(found === null, 'a manifest with no version is ignored rather than half-believed')
}
{
  // No identifiers, no query string, no version reported upward. The app's own
  // update check promises this; the extension must not be quietly weaker.
  let seen = ''
  await checkForUpdate({
    getSelf: dev, currentVersion: '1.0.0',
    fetch: async (url: string) => { seen = url; return serving({ version: '1.0.0' })() },
    put: async () => {},
  })
  ok(!seen.includes('?'), `the request carries no query string (${seen})`)
  ok(!seen.includes('1.0.0'), 'and does not report which version is asking')
  ok(seen.startsWith('https://'), 'over https')
}

// ---- the preference --------------------------------------------------------
// Default ON, because an unpacked install has no other way to learn it is
// behind and the app checks at launch by default too. Switchable, because this
// repo has form on the other side — the v0.9.1 fix existed so an anonymous
// visitor never phones home — and the audience that installs from GitHub is
// exactly the one entitled to say no.
{
  ok(await autoCheckEnabled({ get: async () => undefined }),
    'absent means ON — a fresh install checks, which is the whole point')
  ok(await autoCheckEnabled({ get: async () => true }), 'true is on')
  ok(!(await autoCheckEnabled({ get: async () => false })), 'and false is off')
}
{
  // OFF must mean nothing leaves the machine. Not "checks and hides the
  // result" — that would be the same request with a quieter UI.
  let fetched = false
  const found = await checkForUpdate({
    getSelf: dev, currentVersion: '1.0.0',
    get: async () => false,
    fetch: async () => { fetched = true; return serving({ version: '9.9.9' })() },
    put: async () => {},
  })
  ok(found === null, 'with the preference off, nothing is reported')
  ok(fetched === false, 'and NOTHING is requested — off means no traffic, not a hidden result')
}
{
  // Pressing a button is consent, whatever the preference says. Otherwise the
  // manual check silently does nothing and looks broken.
  let fetched = false
  const found = await checkForUpdate({
    getSelf: dev, currentVersion: '1.0.0', force: true,
    get: async () => false,
    fetch: async () => { fetched = true; return serving({ version: '1.1.0' })() },
    put: async () => {},
  })
  ok(fetched === true && found?.version === '1.1.0',
    '"Check now" works with the preference off — pressing it IS the consent')
}
{
  // And the preference must never override the install-type rule: a store user
  // with the preference on still makes no request.
  let fetched = false
  await checkForUpdate({
    getSelf: store, currentVersion: '1.0.0',
    get: async () => true,
    fetch: async () => { fetched = true; return serving({ version: '9.9.9' })() },
    put: async () => {},
  })
  ok(fetched === false, 'a store install makes no request even with checking enabled')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
