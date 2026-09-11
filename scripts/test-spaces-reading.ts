#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces reading-copy rig — what a published file carries, and what it must not.
//
//   node scripts/test-spaces.mjs reading      # or just: node scripts/test-spaces.mjs
//
// (Bundled, not run directly, for the same reason the invite rig is: the kernel
// transport reached through share.ts uses TypeScript parameter properties, which
// node's strip-only loader refuses. The runner above bundles it the way CI does.)
//
// WHAT THIS PROVES. "Save a reading copy…" is the button you press to hand a
// space to somebody who is not going to edit it — a colleague, a customer, the
// internet. The whole value of that button is in what the file does NOT contain,
// and every part of that is invisible in the product: the copy opens, reads and
// prints identically whether or not it still carries the owner key to the live
// room and every comment anyone left on the draft.
//
// So the assertions here are over the BYTES, never over "the strip function was
// called". `JSON.stringify(copy)` is not a proxy for the file: it is literally
// what `serializeAuto` writes into the `#bento-doc` block, so a full-text scan
// of it is a scan of the document a recipient opens in a text editor.
//
// THREE CATEGORIES, and the rig keeps them apart on purpose (reading.ts says
// why at length):
//
//   CRYPTOGRAPHIC — `doc.collab` is gone, so the room, the symmetric read key
//     and every private signing key are gone. The recipient cannot read the
//     room's history, cannot write to it and cannot join it, because the
//     material a socket must present is not in the file.
//   FORMAT-LEVEL  — comment threads are gone from the bytes.
//   COSMETIC      — `doc.readonly` itself. It is checked here as a FLAG that is
//     set, and nothing in this file pretends it is a lock. Anyone can flip it.
//
// The last one is why the first two are asserted the way they are: a guarantee
// that survives someone editing the JSON is a guarantee about absent bytes, and
// only that.

// --- a browser, reduced to what the module graph touches at import time -----
// share.ts reaches the kernel's online transport, which reads localStorage for
// the relay-host override and the device key. Nothing here connects.
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
// node HAS a navigator (getter-only, no setter), so nothing is installed here:
// i18n reads `navigator.language` at import time and node's answers it. The
// reading copy's contents do not depend on a locale — English-as-key is the
// right answer in a rig — but the read must not throw.

const { readingCopy, isReadingCopy, readingNeighbours, stripComments } =
  await import('../spaces/src/reading.ts')
const { readerCopy, inviteCopy } = await import('../spaces/src/share.ts')
const { mintCollab } = await import('../kernel/src/sync/online.ts')
import type { SpacesDoc } from '../spaces/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.error(`  ✗ ${msg}`) }
}

/** Text that could only have come from a comment thread. */
// Values chosen so the assertion can scan the WHOLE serialized copy for them.
const TRAIL_CANARY = 987654
const PERIOD_NOTE = 'TRAIL-PERIOD-LABEL-CANARY'
const PAGE_NOTE = 'PAGE-COMMENT-CANARY-do-not-publish'
const BLOCK_NOTE = 'BLOCK-COMMENT-CANARY-do-not-publish'
const REPLY_NOTE = 'REPLY-COMMENT-CANARY-do-not-publish'

/** A space with real credentials, real comments, and a bit of everything else. */
async function freshDoc(): Promise<SpacesDoc> {
  const collab = await mintCollab()
  return {
    format: 'bento/spaces',
    version: 1,
    docId: 'doc-under-test',
    title: 'Handbook',
    home: 'p1',
    theme: { background: '#fff', color: '#111', accent: '#F7A600', fontFamily: 'serif', measure: 720 },
    assets: { 'a1': 'data:image/png;base64,AAAA' },
    pages: [
      {
        id: 'p1',
        title: 'Home',
        blocks: [
          { id: 'b1', type: 'p', html: 'The onboarding process starts here.' },
          {
            id: 'b2', type: 'p', html: 'Second paragraph.',
            comments: [{
              id: 'c2', author: 'Dana', at: '2026-01-02T00:00:00Z', text: BLOCK_NOTE,
              replies: [{ id: 'c3', author: 'Sam', at: '2026-01-03T00:00:00Z', text: REPLY_NOTE }],
            }],
          },
        ],
        comments: [{ id: 'c1', author: 'Ali', at: '2026-01-01T00:00:00Z', text: PAGE_NOTE }],
      },
      { id: 'p2', title: 'Policies', parent: 'p1', blocks: [{ id: 'b3', type: 'p', html: 'Expenses.' }] },
      { id: 'p3', title: 'Travel', blocks: [{ id: 'b4', type: 'p', html: 'Book early.' }] },
    ],
    collab,
    // THE WORKING RECORD. In the fixture because a reading copy that carries it
    // is the bug this rig did not catch for the whole of its first life: what
    // `doc.trail` discloses is CADENCE — which days the file was touched, which
    // weeks nothing moved — and the reading copy is the file most likely to go
    // to somebody outside the room. A canon value, so the assertion is a scan
    // of the whole serialized copy rather than a check that one key is gone.
    trail: { '2026-09-07': { n: { todo: 2, done: TRAIL_CANARY } } },
    periods: { s1: { label: PERIOD_NOTE, from: '2026-09-07', to: '2026-09-18' } },
    // A field this build has never heard of. Format additivity (PLATFORM §4):
    // a round trip through any export must leave it exactly as it arrived.
    somethingFromTheFuture: { keep: 'me' },
  } as unknown as SpacesDoc
}

// ---------------------------------------------------------------------------
console.log('\nthe premise: the OPEN document really does hold all of it')

const doc = await freshDoc()
const c = doc.collab!
const openText = JSON.stringify(doc)
ok(!!c.ownerPriv && !!c.key && !!c.room, 'a fresh space is minted with an owner key, a read key and a room')
ok(openText.includes(c.ownerPriv!) && openText.includes(c.key!) && openText.includes(c.room!),
   'serializing the open document carries the owner key, the read key and the room id')
ok(openText.includes(PAGE_NOTE) && openText.includes(BLOCK_NOTE) && openText.includes(REPLY_NOTE),
   'and it carries every comment, page-level, block-level and reply')

// ---------------------------------------------------------------------------
console.log('\na reading copy — CRYPTOGRAPHIC: none of the room material survives')

const copy = readingCopy(doc)
const text = JSON.stringify(copy)

// THE ASSERTIONS THIS RIG EXISTS FOR. Not "collab is undefined" — the whole
// serialized copy is scanned, so key material smuggled anywhere in the document
// (a stray backup under another name, a stamped sync blob that embeds it) fails
// too. That is the indirection hole this repo has shipped twice.
ok(!text.includes(c.ownerPriv!), 'the OWNER PRIVATE key appears NOWHERE in the bytes')
ok(!text.includes(c.owner!), 'nor the owner public key — the room id commits to it')
ok(!text.includes(c.key!), 'nor the symmetric READ key, which decrypts every frame the relay holds')
ok(!text.includes(c.room!), 'nor the room id, so there is nothing to connect to')
ok(copy.collab === undefined, 'doc.collab is absent outright, not emptied')

const withWriter = await freshDoc()
;(withWriter.collab as Record<string, unknown>).writerPriv = 'LEGACY-WRITER-PRIV-CANARY'
ok(!JSON.stringify(readingCopy(withWriter)).includes('LEGACY-WRITER-PRIV-CANARY'),
   'a pre-v2 room-wide writerPriv goes too — deleting collab covers fields nobody remembered')

const invited = await inviteCopy(doc)
ok(!!invited?.collab?.invite?.priv, 'premise: an invite copy really does carry a delegation private key')
ok(!JSON.stringify(readingCopy(invited!)).includes(invited!.collab!.invite!.priv!),
   'a reading copy taken FROM an invite copy carries no invite key either')

const viewer = readerCopy(doc)
ok(!!viewer?.collab?.key, 'premise: a view-only copy still holds the read key (it follows the room)')
const fromViewer = JSON.stringify(readingCopy(viewer!))
ok(!fromViewer.includes(viewer!.collab!.key!) && !fromViewer.includes(viewer!.collab!.room!),
   'a reading copy taken FROM a view-only copy strips the room and the read key')

// ---------------------------------------------------------------------------
console.log('\na reading copy — FORMAT-LEVEL: the comments are not in the file')

ok(!text.includes(PAGE_NOTE), 'a page-level comment is absent from the bytes')
ok(!text.includes(BLOCK_NOTE), 'a block-level comment is absent from the bytes')
ok(!text.includes(REPLY_NOTE), 'a REPLY inside a thread is absent too — the whole thread goes')
ok(copy.pages[0].comments === undefined, 'Page.comments is deleted, not set to an empty array')
ok(copy.pages[0].blocks[1].comments === undefined, 'Block.comments is deleted, not emptied')

// ---------------------------------------------------------------------------
console.log('\na reading copy — FORMAT-LEVEL: the working record is not in the file')

// WHY THIS BLOCK EXISTS. trail.ts has said since the trail landed that "a
// reading copy carries none of it (`stripRecord`)" — and until 2026-09-11
// `stripRecord` had exactly ONE call site, in portable.ts's page extract. Every
// reading copy ever written carried `doc.trail` and `doc.periods`. A comment in
// one file asserting what a function in another file does is not a guarantee;
// this is. Scanned over the whole serialized copy, the way the key material
// above is, because a record smuggled under a second name must fail too.
ok(!text.includes(String(TRAIL_CANARY)), 'no day of the trail survives in the bytes')
ok(!text.includes(PERIOD_NOTE), "nor a period's label — the sprint the numbers were about")
ok(copy.trail === undefined, 'doc.trail is absent outright, not emptied to {}')
ok(copy.periods === undefined, 'doc.periods too — DOC_MAPS is the list, not a hand-written pair')

// ---------------------------------------------------------------------------
console.log('\na reading copy — COSMETIC: the flag, which protects nothing')

ok(copy.readonly === true, 'doc.readonly is set, so the app opens it as a document')
ok(isReadingCopy(copy) && !isReadingCopy(doc), 'isReadingCopy answers for the copy and not the original')
// Said out loud so nobody later reads this rig as proving a lock exists.
const unsealed = JSON.parse(text) as SpacesDoc
delete unsealed.readonly
ok(unsealed.readonly === undefined && JSON.stringify(unsealed).length < text.length,
   'and a recipient can delete that flag from the JSON — it is intent, never enforcement')

// ---------------------------------------------------------------------------
console.log('\nthe document itself is all still there')

ok(copy.pages.length === 3, 'every page survives')
ok(text.includes('The onboarding process starts here.'), 'block content survives')
ok(text.includes('Second paragraph.'), 'a block that HAD a comment keeps its content')
ok(copy.title === 'Handbook' && copy.docId === doc.docId, 'title and docId are untouched (PLATFORM §3)')
ok(JSON.stringify(copy.theme) === JSON.stringify(doc.theme), 'the theme, measure included, is untouched')
ok(JSON.stringify(copy.assets) === JSON.stringify(doc.assets), 'assets ride along — a reading copy is self-contained')
ok(JSON.stringify((copy as Record<string, unknown>).somethingFromTheFuture) === '{"keep":"me"}',
   'an unknown top-level field survives byte-identical (format additivity)')

const before = new Set(Object.keys(doc))
const after = new Set(Object.keys(copy))
const added = [...after].filter((k) => !before.has(k))
const removed = [...before].filter((k) => !after.has(k))
ok(added.length === 1 && added[0] === 'readonly',
   `exactly one top-level key is ADDED, and it is the flag (added: ${JSON.stringify(added)})`)
ok(removed.length === 3 && ['collab', 'periods', 'trail'].every((k) => removed.includes(k)),
   `exactly three top-level keys are removed — collab and the working record (removed: ${JSON.stringify(removed.slice().sort())})`)

// ---------------------------------------------------------------------------
console.log('\nit is a copy, and it is idempotent')

ok(doc.collab !== undefined, 'the OPEN document still has its credentials afterwards')
ok(JSON.stringify(doc).includes(PAGE_NOTE), 'and still has its comments — nothing was mutated in place')
ok(JSON.stringify(readingCopy(copy)) === text, 'a reading copy of a reading copy is byte-identical')

// ---------------------------------------------------------------------------
console.log('\nreader navigation follows the tree, because doc.pages IS pre-order')

const n1 = readingNeighbours(copy, 'p1')
ok(n1.prev === undefined && n1.next?.id === 'p2', 'the first page has no previous, and p2 next')
const n2 = readingNeighbours(copy, 'p2')
ok(n2.prev?.id === 'p1' && n2.next?.id === 'p3', 'a child sits between its parent and the next root')
const n3 = readingNeighbours(copy, 'p3')
ok(n3.prev?.id === 'p2' && n3.next === undefined, 'the last page has no next')
ok(Object.keys(readingNeighbours(copy, 'nope')).length === 0, 'an unknown page id yields neither end')
ok(Object.keys(readingNeighbours({ ...copy, pages: [copy.pages[0]] }, 'p1')).every((k) =>
   (readingNeighbours({ ...copy, pages: [copy.pages[0]] }, 'p1') as Record<string, unknown>)[k] === undefined),
   'a one-page space has no navigation at all')

// ---------------------------------------------------------------------------
console.log('\nhand-written and half-built documents do not throw')

ok(JSON.stringify(readingCopy({ title: 'x' } as unknown as SpacesDoc)) === '{"title":"x","readonly":true}',
   'a document with no pages array is sealed rather than crashed')
const noBlocks = { pages: [{ id: 'p', title: 'p' }] } as unknown as SpacesDoc
stripComments(noBlocks)
ok(true, 'a page with no blocks array survives stripComments')

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
