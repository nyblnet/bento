#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What each copy dash's Share popover writes is allowed to carry.
//
//   node scripts/test-dash-share.ts
//
// The popover (dash/src/shareui.ts) offers three copies for SOMEONE ELSE, and
// each is built in dash/src/share.ts through the kernel's copy table with
// dash's field map (dash/src/docclass.ts). A copy is already on another disk by
// the time anyone looks at it, so what it carries is checked here, on the real
// builders:
//
//   reading    read-only, NO collab block at all, nothing this build does not know
//   invite     the room and read key + an owner-signed INVITE; never ownerPriv
//              or a legacy writerPriv; live (on: true); not read-only
//   viewonly   role 'reader', read-only, no private half, no sync stamp, live
//
// and in every one, a top-level field the map does not declare is DROPPED
// (fail closed). Positive control: the same fixture through the 'file' tier —
// the owner's own round trip — still carries ownerPriv and the unknown field,
// so the fixture really holds what the copies are shown not to.

import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { readingCopy, inviteCopy, readerCopy, isOwner } = await import('../dash/src/share.ts')
const { mintCollab } = await import('../dash/src/sync/online.ts')
const { projectForCopy } = await import('../kernel/src/docfields.ts')
const { DASH_FIELDS } = await import('../dash/src/docclass.ts')
const { starterDoc } = await import('../dash/src/starter.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc

let checks = 0
let failures = 0
function ok(cond: unknown, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const base = starterDoc() as DashDoc
const collab = await mintCollab() as Record<string, unknown>
// a legacy writer key and a stamped sync state, as an older shared file has
collab.writerPub = 'legacy-pub'
collab.writerPriv = 'legacy-PRIVATE'
collab.sync = { v: 99, stamped: true }
const doc = { ...base, collab, futureSecret: 'a field this build has never heard of' } as unknown as DashDoc
const before = JSON.stringify(doc)
const json = (x: unknown) => JSON.stringify(x)

console.log('positive control: the fixture really carries what the copies must drop')
{
  const file = projectForCopy(JSON.parse(before), DASH_FIELDS, 'file') as Record<string, unknown>
  ok(json(file).includes('"ownerPriv"') && json(file).includes('legacy-PRIVATE') && 'futureSecret' in file,
    'the owner\'s own file keeps ownerPriv, the legacy writerPriv and the unknown field')
  ok(isOwner(doc), 'and this copy is the room\'s owner')
}

console.log('\nreading copy')
{
  const out = readingCopy(doc) as Record<string, unknown>
  ok(out.readonly === true, 'opens read-only')
  ok(!('collab' in out), 'carries NO collaboration block — it never joins anything')
  ok(!('futureSecret' in out), 'drops a field this build does not declare')
  ok(Array.isArray(out.sheets) && (out.sheets as unknown[]).length === base.sheets.length, 'keeps every sheet')
  ok(!('template' in out), 'is not a template')
}

console.log('\ninvite to edit')
{
  const out = await inviteCopy(doc) as Record<string, unknown> | null
  const c = (out?.collab ?? {}) as Record<string, unknown>
  ok(!!out, 'the owner can mint one')
  ok(!json(out).includes('ownerPriv') && !json(out).includes('legacy-PRIVATE'), 'carries neither ownerPriv nor the legacy writerPriv')
  ok(!!c.invite && typeof (c.invite as Record<string, unknown>).sig === 'string', 'carries an owner-SIGNED invite in their place')
  ok(c.room === collab.room && c.key === collab.key, 'keeps the room and the read key')
  ok(c.on === true, 'is live from the moment it opens')
  ok(out?.readonly !== true && !('template' in (out ?? {})), 'is neither read-only nor a template (a template forks out of the room on open)')
  ok(out?.docId === doc.docId, 'keeps the workbook\'s identity — it is the same workbook')
  ok(!('futureSecret' in (out ?? {})), 'drops a field this build does not declare')
  const member = { ...doc, collab: { ...collab, ownerPriv: undefined } } as unknown as DashDoc
  ok((await inviteCopy(member)) === null, 'a copy that is not the owner cannot mint one (null, never the source)')
}

console.log('\nview-only copy')
{
  const out = readerCopy(doc) as Record<string, unknown> | null
  const c = (out?.collab ?? {}) as Record<string, unknown>
  ok(!!out && c.role === 'reader', 'role is reader')
  ok(out?.readonly === true, 'opens read-only')
  ok(!json(out).includes('Priv') && !('invite' in c) && !('sync' in c), 'no private half, no invite, no sync stamp')
  ok(c.room === collab.room && c.key === collab.key && c.on === true, 'follows the room, live')
  ok(!('futureSecret' in (out ?? {})), 'drops a field this build does not declare')
  ok(readerCopy({ ...base } as DashDoc) === null, 'a workbook with no room has nothing to follow (null)')
}

ok(JSON.stringify(doc) === before, '\nno builder changed the open workbook')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
