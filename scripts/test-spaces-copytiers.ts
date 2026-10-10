#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces copy-tier rig — what each copy of a space carries, field by field.
//
//   node scripts/test-spaces.mjs copytiers      # bundled, like the invite rig
//
// (Bundled, not run directly: share.ts imports the kernel transport, which uses
// TypeScript parameter properties that node's strip-only loader refuses.)
//
// WHAT THIS PROVES. Every copy of a space that leaves the open document is built
// by the kernel's copy table (kernel/src/docfields.ts projectForCopy) over this
// app's exhaustive field map (spaces/src/docclass.ts). This rig runs each REAL
// builder — share.ts readerCopy / inviteCopy / duplicateAsNew, reading.ts
// readingCopy (the SEALED reading copy, tier 'package'), portable.ts
// extractSpace, model.ts docForExport (Copy document JSON) and the 'file' tier
// main.ts writes "Save a copy…" through — against ONE source carrying every
// class of field: content, identity, both modes, a full collab with every
// secret, in-file history (`revisions`, `trail`) and a top-level key this build
// has never heard of (`futureField`). It asserts the EXACT top-level key set
// each builder emits, not just the absence of a few names, so a field that
// starts riding a copy by accident fails here.
//
// The rules it holds spaces to (the kernel's, 2026-10-10):
//   · reader / Copy JSON (and audience / link / template, which spaces has no
//     builder for yet): no history, no undeclared key, no capability secret;
//     readonly SET on a reader copy, template dropped from it
//   · sealed reading copy (package): NO collab at all — not even the room and
//     read key a live viewer keeps; readonly SET even on a source with no
//     readonly key (the kernel's package tier sets it, #666); no history, no
//     undeclared key, no template, no comment thread
//   · invite: no undeclared key; history KEPT; the modes dropped
//   · duplicate / file: the undeclared key and the history KEPT
//
// Mutation controls (run by hand, listed in the PR): make readerCopy skip
// projectForCopy (clone + collabForReader, the shape it had before); classify
// `revisions` as content; route docForExport through withoutCaps. Each reds
// named rows below. In-rig, a planted builder of the old shape is run against
// the same expectations and must FAIL them — so the checks are not vacuous.

const store = new Map<string, string>()
const shim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
const g = globalThis as unknown as Record<string, unknown>
g.localStorage = shim
g.window = g.window ?? { localStorage: shim, addEventListener() {}, setTimeout, clearTimeout }

const { inviteCopy, readerCopy, duplicateAsNew } = await import('../spaces/src/share.ts')
const { extractSpace } = await import('../spaces/src/portable.ts')
const { readingCopy, stripComments } = await import('../spaces/src/reading.ts')
const { docForExport, FORMAT } = await import('../spaces/src/model.ts')
const { SPACES_FIELDS } = await import('../spaces/src/docclass.ts')
const { projectForCopy, collabForReader, COLLAB_READER_KEEP, COLLAB_INVITE_KEEP } = await import('../kernel/src/docfields.ts')
const { mintCollab } = await import('../kernel/src/sync/online.ts')
const { recordRevision, revisionsOf, applyRevisions } = await import('../spaces/src/history.ts')
const { validateRevision } = await import('../kernel/src/docfields.ts')
import type { SpacesDoc } from '../spaces/src/model.ts'
import type { Tier } from '../kernel/src/docfields.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.error(`  ✗ ${msg}`) }
}
type Obj = Record<string, unknown>
const keys = (o: object) => Object.keys(o).sort()
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const show = (o: object) => keys(o).join(',')
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

// ---------------------------------------------------------------------------
// ONE source with every class of field. The collab is a REAL owner mint (the
// invite builder signs against ownerPriv), with every other secret planted.
const minted = await mintCollab()
const SECRET = {
  writerPriv: 'WRITERPRIV-SECRET',
  invitePriv: 'SRC-INVITE-PRIV-SECRET',
  audiencePriv: 'AUDIENCE-PRIV-SECRET',
  future: 'COLLAB-FUTURE-SECRET',
}
const collab = {
  ...minted,
  writerPriv: SECRET.writerPriv,
  invite: { pub: 'SRC-INVITE-PUB', priv: SECRET.invitePriv, role: 'writer', sig: 'S', exp: 0 },
  audience: { invite: { priv: SECRET.audiencePriv } },
  links: [{ url: 'https://bento.page/x', id: 'L1' }],
  sync: { v: 2, tag: 'STAMP' },
  futureSecret: SECRET.future,
}
const OWNER_PRIV = (collab as Obj).ownerPriv as string

/** Content fields of the fixture — everything the map classes 'content'. */
const CONTENT = ['format', 'version', 'title', 'home', 'pages', 'theme', 'modified', 'assets', 'footnotes', 'design', 'journalTemplate']
function source(extra: Obj = {}): SpacesDoc {
  return {
    format: FORMAT, version: 1,
    docId: 'doc-source',
    title: 'Handbook',
    home: 'p1',
    modified: '2026-10-10T00:00:00.000Z',
    pages: [
      { id: 'p1', title: 'Home', blocks: [{ id: 'b1', type: 'p', html: 'hello [^1]' }] },
      { id: 'p2', title: 'Child', parent: 'p1', blocks: [{ id: 'b2', type: 'p', html: 'kid' }] },
    ],
    theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'sans-serif', measure: 720 },
    assets: { a1: 'data:image/png;base64,AAAA' },
    footnotes: { 1: 'a note' },
    design: 'almanac',
    journalTemplate: 't1',
    collab: clone(collab),
    revisions: realRevisions(),
    trail: { '2026-10-09': { done: 3 } },
    futureField: 'FROM-A-NEWER-BUILD',
    ...extra,
  } as unknown as SpacesDoc
}

/**
 * REAL in-file history, recorded by history.ts exactly as a save records it:
 * three saves of a space that had a third page, then deleted it. Each entry is
 * the kernel's Revision envelope; the deleted page's text survives only inside
 * the history, which is what makes "does this copy carry it" a real question.
 */
// recorded ONCE (ids and times are minted) and cloned per source, so every
// source() carries the same bytes. `var`: source() runs before this line.
// eslint-disable-next-line no-var
var REAL_REVISIONS: unknown[] | undefined
function realRevisions(): unknown[] {
  if (REAL_REVISIONS) return clone(REAL_REVISIONS)
  const d = {
    format: FORMAT, version: 1, docId: 'doc-source', title: 'Handbook', home: 'p1',
    pages: [
      { id: 'p1', title: 'Home', blocks: [{ id: 'b1', type: 'p', html: 'first draft' }] },
      { id: 'p3', title: 'Gone', blocks: [{ id: 'b3', type: 'p', html: 'THE-WHOLE-SPACE deleted page text' }] },
    ],
    theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'sans-serif', measure: 720 },
    footnotes: { 1: 'an older note' },
  } as unknown as SpacesDoc
  recordRevision(d)
  d.pages[0].blocks[0].html = 'second draft'
  recordRevision(d)
  d.pages.splice(1, 1)
  recordRevision(d)
  REAL_REVISIONS = clone(d.revisions as unknown[])
  return clone(REAL_REVISIONS)
}

/** No capability secret anywhere in the serialized copy — a full-text scan. */
function noSecrets(o: object, label: string, allowFreshInvite = false) {
  const text = JSON.stringify(o)
  ok(!text.includes(OWNER_PRIV), `${label}: the owner private key appears nowhere`)
  ok(!text.includes(SECRET.writerPriv), `${label}: no writerPriv anywhere`)
  ok(!text.includes(SECRET.invitePriv), `${label}: the SOURCE invite's private half appears nowhere`)
  ok(!text.includes(SECRET.audiencePriv) && !text.includes(SECRET.future) && !text.includes('bento.page/x'),
    `${label}: no audience key, link record or unknown collab field`)
  const c = (o as Obj).collab as Obj | undefined
  if (c) {
    const allowed = allowFreshInvite ? [...COLLAB_INVITE_KEEP, 'invite', 'role'] : [...COLLAB_READER_KEEP, 'role']
    ok(keys(c).every((k) => allowed.includes(k)), `${label}: collab holds only allowlisted keys (${show(c)})`)
  }
}

const sorted = (xs: string[]) => [...xs].sort()

// ---------------------------------------------------------------------------
console.log('\nthe source: one field of every class, and every secret')
{
  const s = source() as Obj
  ok(Object.keys(SPACES_FIELDS).every((k) => k in s || ['readonly', 'template', 'policy', 'fonts', 'templates', 'designs'].includes(k)),
    'the fixture carries every declared field except the optional ones exercised separately')
  ok(!('futureField' in SPACES_FIELDS), '`futureField` is undeclared — the case the unknown-key rule exists for')
  ok(SPACES_FIELDS.revisions === 'history' && SPACES_FIELDS.trail === 'history', 'revisions and trail are classed history')
  ok(SPACES_FIELDS.collab === 'capability' && SPACES_FIELDS.docId === 'identity', 'collab is the capability, docId the identity')
  ok(SPACES_FIELDS.readonly === 'mode' && SPACES_FIELDS.template === 'mode', 'readonly and template are the modes')
}

// ---------------------------------------------------------------------------
// REAL REVISIONS, per tier. The fixture's history is three genuine entries
// recorded by history.ts (one of them holding a deleted page's text), so this
// is the copy table applied to what a saved space actually carries — not a
// placeholder. Copies handed to a reader drop it whole; the owner's own copies
// and an invite keep it BYTE-FOR-BYTE, still readable and still restorable.
console.log('\nreal in-file history (history.ts), tier by tier')
{
  const src = source()
  const want = JSON.stringify(src.revisions)
  const revs = src.revisions as unknown[]
  ok(revs.length === 3 && revs.every((r) => validateRevision(r) && !Object.hasOwn(r as Obj, 'label')),
    `the fixture's history is 3 kernel Revision envelopes with no label (${revs.length})`)
  ok(revisionsOf(src).length === 3 && JSON.stringify(applyRevisions(revisionsOf(src), 0)).includes('THE-WHOLE-SPACE'),
    'and it is readable: the oldest entry restores the page that was later deleted')
  const kept: Array<[string, SpacesDoc]> = [
    ['invite', (await inviteCopy(source()))!],
    ['duplicate', duplicateAsNew(source(), 'doc-fresh')],
    ['file', projectForCopy(source(), SPACES_FIELDS, 'file')],
  ]
  for (const [label, o] of kept) {
    ok(JSON.stringify((o as Obj).revisions) === want, `${label}: KEEPS the revisions byte-for-byte`)
    ok(revisionsOf(o).length === 3, `${label}: and they still read as history`)
  }
  const dropped: Array<[string, SpacesDoc]> = [
    ['reader (view-only copy)', readerCopy(source())!],
    ['Copy document JSON', docForExport(source())],
    ['sealed reading copy (reading.ts, tier package)', readingCopy(source())],
    ['link', projectForCopy(source(), SPACES_FIELDS, 'link')],
    ['audience', projectForCopy(source(), SPACES_FIELDS, 'audience', { projectAudience: (c) => ({ ...collabForReader(c), role: 'audience' }) })],
    ['template', projectForCopy(source(), SPACES_FIELDS, 'template')],
    ['extract', extractSpace(source(), 'p1', { subtree: true, docId: 'doc-x' }).doc],
  ]
  for (const [label, o] of dropped) {
    ok(!('revisions' in (o as Obj)), `${label}: DROPS the revisions`)
    ok(!JSON.stringify(o).includes('THE-WHOLE-SPACE'), `${label}: the deleted page's text appears nowhere in it`)
  }
}

// ---------------------------------------------------------------------------
console.log('\nreader — "Share → view-only copy" (share.ts readerCopy)')
const EXPECT_READER = sorted([...CONTENT, 'docId', 'collab', 'readonly'])
// THE ABSENT-FIELD CASE. A space with no `readonly` key at all — almost every
// space — must still get `readonly:true` in a reader copy. This rig found that
// projectForCopy only fired a {set} mode rule when the source already carried
// the field (an editable "reader" copy); the kernel now applies every {set}
// cell for the tier regardless (#666), and this row holds it there.
function checkReader(out: SpacesDoc | null, label: string): boolean {
  const before = failures
  ok(!!out, `${label}: a copy is made`)
  if (!out) return false
  const o = out as Obj
  ok(same(keys(o), EXPECT_READER), `${label}: EXACT top-level keys (${show(o)})`)
  ok(!('revisions' in o) && !('trail' in o), `${label}: no revisions, no trail`)
  ok(!('futureField' in o), `${label}: the undeclared key is dropped`)
  ok(o.readonly === true, `${label}: readonly is SET (the kernel's mode rule)`)
  ok(!('template' in o), `${label}: template is dropped`)
  ok((o.collab as Obj)?.role === 'reader', `${label}: collab.role is reader`)
  ok((o.collab as Obj)?.sync === undefined, `${label}: no sync stamp`)
  noSecrets(o, label)
  return failures === before
}
{
  const src = source({ readonly: false })
  checkReader(readerCopy(src), 'reader')
  checkReader(readerCopy(source({ template: true, readonly: false })), 'reader of a template/editable source')
  {
    const bare = readerCopy(source()) as Obj
    ok(same(keys(bare), EXPECT_READER) && bare.readonly === true && !('template' in bare),
      `reader of a source with NO mode fields: readonly is SET anyway (${show(bare)})`)
    ok(!('revisions' in bare) && !('trail' in bare) && !('futureField' in bare), 'reader of a source with no mode fields: still no history, no undeclared key')
    noSecrets(bare, 'reader of a source with no mode fields')
  }
  ok(((readerCopy(src) as Obj).collab as Obj).on === true, 'reader: the copy is live (collab.on)')
  ok(JSON.stringify(src) === JSON.stringify(source({ readonly: false })), 'reader: the open document is untouched')

  // NOT VACUOUS: the shape readerCopy had before the kernel table — a deep
  // clone with collab re-projected — carries the history and the unknown key,
  // and must fail the same expectations.
  const planted = (d: SpacesDoc): SpacesDoc => {
    const out = clone(d)
    out.collab = { ...collabForReader(d.collab!), on: true } as SpacesDoc['collab']
    return out
  }
  const f0 = failures, c0 = checks
  console.log('    (planted old-shape builder — these rows MUST fail:)')
  const passed = checkReader(planted(src), 'planted')
  const plantedFailed = failures - f0
  failures = f0; checks = c0 // the planted run's own rows are the control, not results
  ok(!passed && plantedFailed >= 3, `a reader builder that skips projectForCopy FAILS these checks (${plantedFailed} rows red)`)
}

// ---------------------------------------------------------------------------
console.log('\nsealed reading copy — "Share → Save a reading copy…" (reading.ts readingCopy, tier package)')
{
  const EXPECT_SEALED = sorted([...CONTENT, 'docId', 'readonly'])
  const ROOM = (collab as Obj).room as string
  const KEY = (collab as Obj).key as string
  // the hostile source, with comment threads planted at both anchors
  const withComments = (d: SpacesDoc): SpacesDoc => {
    const o = clone(d)
    ;(o.pages[0] as Obj).comments = [{ id: 'c1', author: 'A', at: 'x', text: 'PAGE-COMMENT-CANARY' }]
    ;(o.pages[0].blocks[0] as Obj).comments = [{ id: 'c2', author: 'B', at: 'x', text: 'BLOCK-COMMENT-CANARY' }]
    return o
  }
  function checkSealed(out: SpacesDoc, label: string): boolean {
    const before = failures
    const o = out as Obj
    const text = JSON.stringify(o)
    ok(!('collab' in o), `${label}: NO collab key at all — not even the reader subset`)
    ok(!text.includes(ROOM) && !text.includes(KEY), `${label}: neither the room id nor the read key appears anywhere`)
    ok(o.readonly === true, `${label}: readonly:true (opens in the reading view)`)
    ok(!('revisions' in o) && !('trail' in o) && !text.includes('THE-WHOLE-SPACE'), `${label}: no history`)
    ok(!('futureField' in o), `${label}: the undeclared key is dropped`)
    ok(!('template' in o), `${label}: no template`)
    ok(same(keys(o), EXPECT_SEALED), `${label}: EXACT top-level keys (${show(o)})`)
    ok(!text.includes('COMMENT-CANARY'), `${label}: no comment thread, page- or block-level`)
    noSecrets(o, label)
    return failures === before
  }
  // the fixture carries NO readonly key: the package tier must set it anyway
  const bare = source() as Obj
  ok(!('readonly' in bare), 'premise: the hostile source has NO readonly key')
  checkSealed(readingCopy(withComments(source())), 'sealed (source with no readonly key)')
  checkSealed(readingCopy(withComments(source({ template: true }))), 'sealed of a template source')
  checkSealed(readingCopy(withComments(source({ readonly: false }))), 'sealed of a source with readonly:false')
  const src = withComments(source())
  const snap = JSON.stringify(src)
  readingCopy(src)
  ok(JSON.stringify(src) === snap, 'sealed: the open document is untouched')

  // NOT VACUOUS: three planted builders, each one of the ways this could
  // regress, must each FAIL the same checks.
  const planted: Array<[string, (d: SpacesDoc) => SpacesDoc]> = [
    // the app-side step forgotten: comment threads live inside pages, which
    // every tier keeps, so only stripComments takes them out
    ['forgets the comment threads', (d) => projectForCopy(clone(d), SPACES_FIELDS, 'package')],
    // the live viewer's tier: collab survives as collabForReader's room + key
    ['keeps collab (tier reader)', (d) => {
      const o = projectForCopy(clone(d), SPACES_FIELDS, 'reader'); stripComments(o); return o
    }],
    // no table at all: the shape #435 had, minus its collab strip
    ['skips projectForCopy', (d) => {
      const o = clone(d); o.readonly = true; stripComments(o); return o
    }],
  ]
  for (const [name, build] of planted) {
    const f0 = failures, c0 = checks
    console.log(`    (planted builder that ${name} — these rows MUST fail:)`)
    const passed = checkSealed(build(withComments(source())), 'planted')
    const red = failures - f0
    failures = f0; checks = c0
    ok(!passed && red >= 1, `a sealed builder that ${name} FAILS these checks (${red} rows red)`)
  }
}

// ---------------------------------------------------------------------------
console.log('\ninvite — "Share → invite to edit" (share.ts inviteCopy)')
{
  const EXPECT = sorted([...CONTENT, 'docId', 'collab', 'revisions', 'trail'])
  for (const [label, src] of [['invite', source()], ['invite of a template/read-only source', source({ template: true, readonly: true })]] as const) {
    const out = await inviteCopy(src)
    ok(!!out, `${label}: the owner can mint one`)
    const o = out as Obj
    ok(same(keys(o), EXPECT), `${label}: EXACT top-level keys (${show(o)})`)
    ok(!('futureField' in o), `${label}: the undeclared key is dropped`)
    ok('revisions' in o && 'trail' in o, `${label}: history is KEPT (the kernel's invite rule)`)
    ok(!('readonly' in o) && !('template' in o), `${label}: the modes are dropped`)
    const c = o.collab as Obj
    ok(c.role === 'writer' && (c.invite as Obj)?.pub !== 'SRC-INVITE-PUB', `${label}: a FRESH writer invite, never the source's`)
    ok((c.sync as Obj)?.tag === 'STAMP', `${label}: keeps the sync stamp (it contributes)`)
    ok(c.on === true, `${label}: the copy is live (collab.on)`)
    noSecrets(o, label, true)
  }
}

// ---------------------------------------------------------------------------
console.log('\nCopy document JSON (model.ts docForExport, what doccmds copyJson writes)')
{
  const EXPECT = sorted([...CONTENT, 'docId'])
  for (const [label, src] of [['copy JSON', source()], ['copy JSON of a template/read-only source', source({ template: true, readonly: true })]] as const) {
    const o = docForExport(src) as Obj
    ok(same(keys(o), EXPECT), `${label}: EXACT top-level keys (${show(o)})`)
    ok(!('revisions' in o) && !('trail' in o), `${label}: no revisions, no trail`)
    ok(!('futureField' in o), `${label}: the undeclared key is dropped`)
    ok(!('collab' in o), `${label}: no collab at all`)
    ok(!('readonly' in o) && !('template' in o), `${label}: the modes are dropped (the kernel's copyJSON rule)`)
    noSecrets(o, label)
  }
}

// ---------------------------------------------------------------------------
console.log('\nduplicate — "Duplicate as new space…" (share.ts duplicateAsNew)')
{
  const src = source({ readonly: false, template: true })
  const o = duplicateAsNew(src, 'doc-fresh', '2026-10-11T00:00:00.000Z') as Obj
  ok(same(keys(o), sorted([...CONTENT, 'docId', 'readonly', 'template', 'revisions', 'trail', 'futureField'])),
    `duplicate: EXACT top-level keys (${show(o)})`)
  ok(o.futureField === 'FROM-A-NEWER-BUILD', 'duplicate: the undeclared key is KEPT')
  ok('revisions' in o && 'trail' in o, 'duplicate: history is KEPT')
  ok(o.docId === 'doc-fresh' && !('collab' in o), 'duplicate: a NEW docId, and no collab at all (identity + capability reset)')
  ok(o.modified === '2026-10-11T00:00:00.000Z', 'duplicate: stamped modified now')
  noSecrets(o, 'duplicate')
}

// ---------------------------------------------------------------------------
console.log('\nthe page extract — "Export page as a space…" (portable.ts extractSpace)')
{
  const src = source({ readonly: true, template: true })
  const { doc: out } = extractSpace(src, 'p1', { subtree: true, docId: 'doc-extract', now: '2026-10-11T00:00:00.000Z' })
  const o = out as Obj
  // (no page in the fixture references `a1`, so the extract's own asset rule
  // drops the pool — that is portable.ts, not the table)
  ok(same(keys(o), sorted([...CONTENT.filter((k) => k !== 'assets'), 'docId', 'readonly', 'futureField'])), `extract: EXACT top-level keys (${show(o)})`)
  ok(o.futureField === 'FROM-A-NEWER-BUILD', 'extract: the undeclared key is KEPT (a new identity of the owner\'s own, like a duplicate)')
  ok(!('revisions' in o) && !('trail' in o), 'extract: NO history — it records the whole space, the pages left out included')
  ok(!JSON.stringify(o).includes('THE-WHOLE-SPACE'), 'extract: nothing of the history survives anywhere in it')
  ok(o.readonly === true && !('template' in o), 'extract: readonly kept, template dropped (unchanged from before the table)')
  ok(o.docId === 'doc-extract' && !('collab' in o), 'extract: the supplied docId, and no collab at all')
  noSecrets(o, 'extract')
}

// ---------------------------------------------------------------------------
console.log('\nfile — "Save a copy…" (main.ts writes the table\'s \'file\' tier)')
{
  const src = source({ readonly: true, template: true })
  const o = projectForCopy(src, SPACES_FIELDS, 'file') as Obj
  ok(same(keys(o), keys(src)), `file: every field of the source, the undeclared one and the history included (${show(o)})`)
  ok(JSON.stringify(o.collab) === JSON.stringify(src.collab), 'file: the owner\'s collab whole — it is the owner\'s own file')
}

// ---------------------------------------------------------------------------
console.log('\naudience / link / template — no spaces builder yet; the map as the kernel projects it')
{
  // When a builder for one of these lands it inherits exactly this.
  const audience = (c: Obj): Obj => ({ ...collabForReader(c), role: 'audience' })
  const want: Partial<Record<Tier, string[]>> = {
    audience: sorted([...CONTENT, 'docId', 'collab', 'readonly']),
    link: sorted([...CONTENT, 'docId', 'collab', 'readonly']),
    template: sorted([...CONTENT, 'docId', 'template']),
  }
  for (const tier of ['audience', 'link', 'template'] as const) {
    // NEITHER mode field in the source: the tier's {set} cells must fire anyway
    const o = projectForCopy(source(), SPACES_FIELDS, tier, { projectAudience: audience }) as Obj
    ok(same(keys(o), want[tier]!), `${tier}: EXACT top-level keys (${show(o)})`)
    ok(!('revisions' in o) && !('trail' in o) && !('futureField' in o), `${tier}: no history, no undeclared key`)
    ok(tier === 'template' ? o.template === true && !('readonly' in o) : o.readonly === true && !('template' in o),
      `${tier}: the modes are SET as the kernel rules (${tier === 'template' ? 'template:true, readonly dropped' : 'readonly:true, template dropped'})`)
    noSecrets(o, tier)
  }
}

// ---------------------------------------------------------------------------
// SOURCE: every builder goes through the table, with the tier it claims, and
// nothing in spaces/src hand-strips a copy any more. Located from the CWD — the
// rig runs bundled from a temp directory.
console.log('\nevery builder routes through projectForCopy (source)')
{
  const { readFileSync, existsSync, readdirSync } = await import('node:fs')
  const { dirname, join, resolve } = await import('node:path')
  let root = resolve(process.cwd())
  while (!existsSync(join(root, 'spaces/src/docclass.ts')) && dirname(root) !== root) root = dirname(root)
  const rd = (f: string) => readFileSync(join(root, 'spaces/src', f), 'utf8')
  const body = (src: string, name: string) => {
    const i = src.indexOf(`function ${name}(`)
    if (i < 0) return ''
    const j = src.indexOf('\n}\n', i)
    return src.slice(i, j < 0 ? undefined : j)
  }
  const share = rd('share.ts'), model = rd('model.ts'), portable = rd('portable.ts'), main = rd('main.ts'), cmds = rd('doccmds.ts')
  ok(/projectForCopy\(clone\(doc\), SPACES_FIELDS, 'reader'\)/.test(body(share, 'readerCopy')), 'readerCopy → tier reader')
  ok(/projectForCopy\(clone\(doc\), SPACES_FIELDS, 'invite', \{ invite \}\)/.test(body(share, 'inviteCopy')), 'inviteCopy → tier invite, with the freshly minted invite')
  ok(/projectForCopy\(clone\(doc\), SPACES_FIELDS, 'duplicate'\)/.test(body(share, 'duplicateAsNew')), 'duplicateAsNew → tier duplicate')
  ok(/projectForCopy\(clone\(doc\), SPACES_FIELDS, 'package'\)/.test(body(rd('reading.ts'), 'readingCopy')), 'readingCopy → tier package')
  {
    // a METHOD, so located by its own signature rather than body()'s `function`
    const ed = rd('editor.ts')
    const i = ed.indexOf('private async saveReadingCopy(')
    const m = i < 0 ? '' : ed.slice(i, ed.indexOf('\n  }\n', i))
    ok(/const out = readingCopy\(this\.store\.doc\)/.test(m) && /onShareCopy\?\.\(out, 'reading'\)/.test(m),
      '"Save a reading copy…" writes readingCopy\'s output, and nothing else')
  }
  ok(/projectForCopy\(clone\(doc\), SPACES_FIELDS, 'duplicate'\)/.test(body(portable, 'extractSpace')), 'extractSpace → tier duplicate')
  ok(/return projectForCopy\(doc, SPACES_FIELDS, 'copyJSON'\)/.test(body(model, 'docForExport')), 'docForExport → tier copyJSON')
  ok(/docForExport\(h\.store\.doc\)/.test(body(cmds, 'copyJson')), 'Copy document JSON writes docForExport\'s output')
  ok(/projectForCopy\(store\.doc, SPACES_FIELDS, 'file'\)/.test(main), '"Save a copy…" → tier file')
  // nothing rebuilds a copy by hand: no `delete x.collab`, no withoutCaps on a
  // space, no collabFor* re-projection after the table has done it
  const files = readdirSync(join(root, 'spaces/src')).filter((f) => f.endsWith('.ts'))
  const handStrip: string[] = []
  for (const f of files) {
    const s = rd(f)
    if (/delete [\w.]+\.collab\b/.test(s)) handStrip.push(`${f}: delete .collab`)
    if (/collabFor(Reader|Invite)\(/.test(s)) handStrip.push(`${f}: collabFor*`)
    // editor.ts strips a bento/SLIDES deck (pageToDeck), not a space: the one
    // withoutCaps allowed, and it is pinned by name
    const caps = [...s.matchAll(/withoutCaps\(/g)].length
    if (caps && !(f === 'editor.ts' && caps === 1 && /deckForExport = <T extends object>\(deck: T\): T => withoutCaps\(deck\)/.test(s))) handStrip.push(`${f}: withoutCaps`)
  }
  ok(handStrip.length === 0, `no spaces source hand-strips a copy (${handStrip.join('; ') || 'none'})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
