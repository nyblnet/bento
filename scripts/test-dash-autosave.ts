#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash file write-back rig — what gets written, and what gets said.
//
//   node scripts/test-dash-autosave.ts     (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Write-back is the one feature in dash whose success is
// invisible and whose failure is also invisible. Nobody watches a file being
// rewritten; they find out weeks later, from the contents. So every branch has
// to be provable without a browser, and there are exactly three families:
//
//   1. THE REFUSALS (`planWriteBack`). Each is a way to destroy a file the user
//      did not point at. A READ-ONLY workbook is open read-only precisely so
//      nothing is lost — writing it is the thing that mode prevents. A TEMPLATE
//      is a source, not a destination: `adoptOpenedDoc` re-mints a template's
//      identity at BOOT only, while `dropopen.ts` adopts a writable handle to
//      whatever was dropped, so a dropped template is a live file with somebody
//      else's data now in memory. NO HANDLE is Safari/Firefox/iOS, where there
//      is no file to write and nothing may be claimed. UNCHANGED is not
//      tidiness either: a workbook can be tens of MB and `doc` events fire for
//      reasons that change nothing, so rewriting the whole shell to store
//      identical bytes is a stall on the grid for no gain.
//      Refusals are ordered on purpose — a read-only workbook on Safari must
//      report the PERMANENT reason, not the incidental one.
//
//   2. THE BOOKKEEPING (`FileWriteBack`). Two mistakes here are silent data
//      loss dressed as a working feature. Recording the content key BEFORE the
//      write means a failed cycle reads as "unchanged" to the next one, so a
//      permanent failure is reported once and then skipped forever while the
//      author is told nothing. Letting two cycles overlap means two writables
//      open on one handle, which is how a file ends up half one document and
//      half another.
//
//   3. THE HONESTY POLICY (`nextNotice`). The reason this is a pure function
//      and not a few `if`s at the call site. Speak on every cycle and a toast
//      fires every 2.5s while someone types, which gets the feature mentally
//      switched off. Speak once per session and a failure that STARTS after ten
//      good minutes — a revoked permission, a removed drive, a full disk — never
//      reaches the person whose file has just stopped being written. Transitions
//      speak; steady states do not; and LEAVING failure speaks, because a
//      warning that is no longer true is its own kind of lie.
//
// NOT PROVED HERE, and said plainly rather than faked: the DOM half (the
// "Saved" tag under the Save button, the dirty dot's title, the failure toast)
// and the real File System Access write need a browser. What is proved is that
// the call site is handed the right decision and the right words to say.

import { registerHooks } from 'node:module'

// writeback.ts reaches kernel/src/save.ts (for the live deps) and recovery.ts
// (for `contentKey`), and recovery.ts imports its own stylesheet. Vite's job;
// Node refuses the extension outright. Same stub test-dash-recovery.ts uses.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { planWriteBack, nextNotice, freshNotice, FileWriteBack } = await import('../dash/src/writeback.ts')
const { contentKey } = await import('../dash/src/recovery.ts')
const { FORMAT, FORMAT_VERSION } = await import('../dash/src/model.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type WriteBackDeps = import('../dash/src/writeback.ts').WriteBackDeps

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

function workbook(extra: Partial<DashDoc> = {}): DashDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: 'doc-1',
    title: 'Q3',
    sheets: [{
      id: 'sheet-1',
      kind: 'table',
      name: 'Data',
      columns: [{ id: 'region', name: 'Region', type: 'text' }],
      rows: [{ id: 'r1', cells: { region: 'North' } }],
    }],
    ...extra,
  } as DashDoc
}

// --- 1. the refusals ---------------------------------------------------------

{
  console.log('\nplanWriteBack — what may be written')

  const base = { doc: workbook(), readOnly: false, hasHandle: true, lastWritten: null }

  const go = planWriteBack(base)
  ok(go.write === true, 'a writable workbook with a handle and no baseline is written')
  ok(go.write === true && go.key === contentKey(base.doc),
    'and the plan carries recovery.ts\'s OWN content key — one definition of "changed", so the banner and the file can never disagree')

  const ro = planWriteBack({ ...base, readOnly: true })
  ok(ro.write === false && ro.why === 'read-only',
    'a store that refuses commits is never written back — read-only exists so nothing is lost')

  const roDoc = planWriteBack({ ...base, doc: workbook({ readonly: true } as Partial<DashDoc>) })
  ok(roDoc.write === false && roDoc.why === 'read-only',
    'the DOCUMENT\'s own readonly flag counts too: swapWorkbook checks the current store, not the incoming doc, so a dropped read-only copy lands with the store still unlocked')

  const tpl = planWriteBack({ ...base, doc: workbook({ template: true } as Partial<DashDoc>) })
  ok(tpl.write === false && tpl.why === 'template',
    'a template is a source, not a destination — dropopen adopts a handle to it while adoptOpenedDoc only re-mints identity at boot')

  const noFs = planWriteBack({ ...base, hasHandle: false })
  ok(noFs.write === false && noFs.why === 'no-handle',
    'no File System Access handle (Safari, Firefox, every browser on iOS) means there is no file to write')

  const same = planWriteBack({ ...base, lastWritten: contentKey(base.doc) })
  ok(same.write === false && same.why === 'unchanged',
    'identical content is not rewritten — a doc event is not proof of an edit, and the shell can be tens of MB')

  const edited = workbook()
  edited.title = 'Q4'
  ok(planWriteBack({ ...base, doc: edited, lastWritten: contentKey(base.doc) }).write === true,
    'a real edit after a baseline IS written')

  // Volatile fields are the whole reason contentKey exists rather than
  // JSON.stringify: `modified` is stamped by a save, so comparing raw JSON
  // would make every cycle after a save look like an edit and rewrite a large
  // file forever, on a loop, with nobody touching the keyboard.
  const stamped = workbook()
  ;(stamped as { modified?: string }).modified = new Date().toISOString()
  ok(planWriteBack({ ...base, doc: stamped, lastWritten: contentKey(base.doc) }).why === 'unchanged',
    'a re-stamped `modified` alone does not trigger a rewrite — otherwise saving would arm an endless write loop')

  // ORDER. A read-only workbook opened in Safari matches two refusals; the one
  // worth reporting is the one that will still be true in Chrome.
  const both = planWriteBack({ ...base, readOnly: true, hasHandle: false })
  ok(both.write === false && both.why === 'read-only',
    'a permanent refusal outranks an incidental one — "read-only", not "no-handle", when both apply')
}

// --- 2. the bookkeeping ------------------------------------------------------

/** A deps double with a switchable outcome and a record of what it wrote. */
function fakeDeps(over: Partial<WriteBackDeps> = {}) {
  const wrote: string[] = []
  let fail: string | null = null
  const deps: WriteBackDeps = {
    hasHandle: () => true,
    serialize: async (d) => `<html>${JSON.stringify(d)}</html>`,
    write: async (html) => {
      if (fail) throw new Error(fail)
      wrote.push(html)
    },
    ...over,
  }
  return { deps, wrote, setFail: (m: string | null) => { fail = m } }
}

{
  console.log('\nFileWriteBack — the bookkeeping')

  const f = fakeDeps()
  const wb = new FileWriteBack(f.deps)
  const doc = workbook()

  ok(wb.everWrote === false, 'a fresh instance claims nothing')

  const first = await wb.run(doc, false)
  ok(first.outcome.kind === 'wrote' && f.wrote.length === 1, 'the first cycle writes')
  ok(wb.everWrote === true, 'and it says so')

  const second = await wb.run(doc, false)
  ok(second.outcome.kind === 'skipped' && f.wrote.length === 1,
    'the second cycle over identical content writes nothing')

  doc.title = 'Changed'
  await wb.run(doc, false)
  ok(f.wrote.length === 2, 'an edit writes again')
  ok(f.wrote[1].includes('Changed'), 'and the bytes are the CURRENT document, not a stale clone')

  // The failure that must not become permanent silence.
  const g = fakeDeps()
  const wb2 = new FileWriteBack(g.deps)
  const d2 = workbook()
  g.setFail('The requested file could not be found.')
  const bad = await wb2.run(d2, false)
  ok(bad.outcome.kind === 'failed', 'a rejected write comes back as a value')
  ok(bad.outcome.kind === 'failed' && bad.outcome.why.includes('could not be found'),
    'carrying the real message — a full disk and a deleted file want different actions from the author')
  ok(wb2.everWrote === false && wb2.isFailing,
    'a failed write is NOT recorded as a baseline: recording the intent would make the next cycle read "unchanged" and the failure would be reported once and then skipped forever')

  const retry = await wb2.run(d2, false)
  ok(retry.outcome.kind === 'failed',
    'so the very next cycle tries the same content again rather than skipping it')

  g.setFail(null)
  const healed = await wb2.run(d2, false)
  ok(healed.outcome.kind === 'wrote' && g.wrote.length === 1, 'and it lands once the file is reachable again')
  ok(wb2.isFailing === false, 'which clears the failing state')

  // Never throws — it runs from a setTimeout with nobody awaiting it, so a
  // rejection would be an unhandled promise rejection in a console the author
  // is not reading. That is the invisibility this module exists to end.
  const h = fakeDeps({ serialize: async () => { throw new Error('serialize blew up') } })
  const wb3 = new FileWriteBack(h.deps)
  let threw = false
  let out
  try { out = await wb3.run(workbook(), false) } catch { threw = true }
  ok(!threw && out?.outcome.kind === 'failed',
    'a throw anywhere in the cycle — serialize included — is reported, never rethrown')

  // Overlap. A 30MB workbook takes long enough for the next debounce to land
  // on top of the write; two writables open on one handle is how a file ends up
  // half one document and half another.
  //
  // Measured as a CONCURRENCY COUNT rather than by awaiting the second cycle:
  // if the guard is ever removed, awaiting it would deadlock against the
  // write this test is deliberately holding open, and a rig that hangs is a
  // rig CI cannot read. It has to go red, not quiet.
  const releases: Array<() => void> = []
  let live = 0
  let mostAtOnce = 0
  const slow = fakeDeps({
    write: () => new Promise<void>((r) => {
      live++
      mostAtOnce = Math.max(mostAtOnce, live)
      releases.push(() => { live--; r() })
    }),
  })
  const wb4 = new FileWriteBack(slow.deps)
  const d4 = workbook()
  const inflight = wb4.run(d4, false)
  await Promise.resolve()
  d4.title = 'While busy'
  const overlapping = wb4.run(d4, false)
  for (let i = 0; i < 4; i++) await Promise.resolve()
  ok(mostAtOnce === 1,
    'a cycle that lands while another is mid-write never opens a second writable on the one handle')
  for (const r of releases.splice(0)) r()
  ok((await overlapping).outcome.kind === 'skipped', 'it stands down and says so')
  await inflight
  ok(true, 'and the in-flight write completes normally')

  // ⌘S adoption.
  const i = fakeDeps()
  const wb5 = new FileWriteBack(i.deps)
  const d5 = workbook()
  wb5.adopt(d5)
  const afterManual = await wb5.run(d5, false)
  ok(afterManual.outcome.kind === 'skipped' && i.wrote.length === 0,
    'after a manual ⌘S the same bytes are not immediately rewritten')
  d5.title = 'Edited after saving'
  await wb5.run(d5, false)
  ok(i.wrote.length === 1, 'but the next real edit is')

  const j = fakeDeps()
  const wb6 = new FileWriteBack(j.deps)
  j.setFail('permission revoked')
  await wb6.run(workbook(), false)
  ok(wb6.isFailing, 'a standing failure is standing')
  wb6.adopt(workbook())
  ok(!wb6.isFailing,
    'and a successful ⌘S through the same handle clears it — the warning would otherwise contradict the "Saved" toast appearing beside it')

  // The refusals, through the runner rather than the planner, because the
  // runner is what main.ts actually calls.
  const k = fakeDeps()
  const wb7 = new FileWriteBack(k.deps)
  await wb7.run(workbook(), true)
  ok(k.wrote.length === 0, 'the runner honours read-only: nothing reached the file')

  const l = fakeDeps({ hasHandle: () => false })
  const wb8 = new FileWriteBack(l.deps)
  const noHandle = await wb8.run(workbook(), false)
  ok(l.wrote.length === 0 && noHandle.outcome.kind === 'skipped' && noHandle.notice === null,
    'and a browser with no handle is told nothing — there is no file to be stale about, and the snapshot warning is main.ts\'s job')

  // Collab stamping, which must happen BEFORE serialization or a copy edited
  // offline cannot rejoin as a fork (PLATFORM §5).
  const order: string[] = []
  const m = fakeDeps({
    stamp: () => order.push('stamp'),
    serialize: async () => { order.push('serialize'); return 'x' },
    write: async () => { order.push('write') },
  })
  await new FileWriteBack(m.deps).run(workbook(), false)
  ok(order.join(',') === 'stamp,serialize,write',
    'sync state is stamped BEFORE serialization — stamping after it would write bytes that predate the stamp')
}

// --- 3. the honesty policy ---------------------------------------------------

{
  console.log('\nnextNotice — when to speak')

  const wrote = { kind: 'wrote', at: 1 } as const
  const fail = (why: string) => ({ kind: 'failed', why }) as const
  const skip = { kind: 'skipped', why: 'unchanged' } as const

  const a = nextNotice(freshNotice(), wrote)
  ok(a.notice?.say === 'saved', 'a normal successful write reports "saved" — the quiet tag, not a toast')
  ok(a.state.failing === false, 'and leaves nothing standing')

  const b = nextNotice(freshNotice(), skip)
  ok(b.notice === null, 'a skipped cycle says nothing at all — this is the common case while typing')

  const c = nextNotice(freshNotice(), fail('disk full'))
  ok(c.notice?.say === 'failed' && c.notice.why === 'disk full',
    'entering failure speaks, and names the cause')
  ok(c.state.failing && c.state.lastError === 'disk full', 'and is remembered')

  const d = nextNotice(c.state, fail('disk full'))
  ok(d.notice === null,
    'the SAME failure repeating is silent — otherwise a toast fires every 2.5s while someone types and the feature is switched off in their head')

  const e = nextNotice(c.state, fail('permission revoked'))
  ok(e.notice?.say === 'failed' && e.notice.why === 'permission revoked',
    'a DIFFERENT failure while already failing is news: the action the author must take has changed')

  const f2 = nextNotice(c.state, wrote)
  ok(f2.notice?.say === 'recovered',
    'leaving failure speaks too — the author is looking at a warning that is no longer true and cannot know it lapsed')
  ok(f2.state.failing === false, 'and the failing state is cleared')

  const g2 = nextNotice(f2.state, wrote)
  ok(g2.notice?.say === 'saved', 'the write after that is ordinary again — "recovered" is a transition, not a mode')

  const h2 = nextNotice(c.state, skip)
  ok(h2.notice === null && h2.state.failing && h2.state.lastError === 'disk full',
    'a skip does not clear a standing failure: nothing was written, so nothing was proved')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
