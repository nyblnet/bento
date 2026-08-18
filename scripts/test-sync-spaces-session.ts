#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/spaces binding of the kernel sync session.
//
//   node --no-warnings scripts/test-sync-spaces-session.ts
//
// scripts/test-sync-session.ts already drives the kernel session hard, through
// slides and through type. This rig covers only what the SPACES host answers
// differently — because three of the five answers are not slides' answers, and
// each one is a bug that would be invisible until two people were live:
//
//   heal()        a spare blank slide is visible in a deck's sidebar and
//                 deleted in one click; a spare PAGE is a phantom nobody can
//                 explain. So the id must be derived, and two replicas that
//                 heal at the same moment must produce the SAME page.
//   clampView()   a deck clamps an INDEX; a space navigates by page identity,
//                 and when the subtree you are reading is deleted the honest
//                 destination is the nearest surviving ANCESTOR, not home.
//   changeEvents  'doc' means "you edited something" in this app and paints
//                 "Edited". A remote op must not raise it.
//
// It drives the REAL session over the REAL Store through a REAL
// BroadcastChannel: two sessions in one process are two tabs of one file.

const listeners: Record<string, Array<() => void>> = {}
;(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: number) => clearTimeout(h),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: number) => clearInterval(h),
  addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn) },
}

const { register } = await import('node:module')
register('./lib/ts-resolve-hooks.mjs', import.meta.url)

const { Store } = await import('../spaces/src/store.ts')
const { SyncSession } = await import('../spaces/src/sync/session.ts')
const { FORMAT, FORMAT_VERSION, defaultTheme } = await import('../spaces/src/model.ts')

let failures = 0, checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const H = (s: string) => console.log(`\n=== ${s} ===`)
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

type AnyStore = InstanceType<typeof Store>

/** the app-shaped answers, which is all this rig is about */
const host = (s: unknown) => (s as { host: {
  heal(): boolean
  captureView(): unknown
  clampView(v?: unknown): boolean
  presence(): { at: string; sel: string[] }
  carriesMedia(o: unknown[]): boolean
  changeEvents: readonly string[]
  structureEvents: readonly string[]
  presenceEvents: readonly string[]
} }).host

/** a space with a page tree: home, a parent, and a child under it */
/**
 * A space with a page tree: home, a section, and a child under it.
 *
 * `id` keys BOTH the room and the BroadcastChannel, and every section passes
 * its own — because two sessions in one process really are two tabs, and a
 * session left alive by an earlier section is a third tab in the same room
 * broadcasting a different document. That is not hypothetical: it made the
 * first assertion of the end-to-end section fail while the later ones passed.
 */
function space(id = 'doc-fixed'): AnyStore {
  const doc = {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: id,
    title: 'Test space',
    theme: defaultTheme(),
    collab: { room: `room-${id}`, key: 'k' },
    home: 'home',
    pages: [] as unknown[],
  } as never as import('../spaces/src/model.ts').SpacesDoc
  doc.pages = [
    { id: 'home', title: 'Home', blocks: [{ id: 'b1', type: 'p', html: 'hello' }] },
    { id: 'sec', title: 'Section', blocks: [] },
    { id: 'kid', title: 'Child', parent: 'sec', blocks: [{ id: 'b2', type: 'p', html: 'in the child' }] },
  ]
  doc.home = 'home'
  return new Store(doc)
}

// ---------------------------------------------------------------------------
H('heal(): an emptied space repairs to ONE page, not one per replica')
{
  // heal() is driven by the kernel from afterRemoteChange — only a REMOTE
  // change can empty a document under you. The host is exercised directly
  // here, which is also the only way to put two replicas in the same instant.
  const a = space('heal'), b = space('heal')
  a.doc.pages = []
  b.doc.pages = []
  const ha = host(new SyncSession(a)), hb = host(new SyncSession(b))

  ok(ha.heal() === true, 'heal reports it mutated the doc')
  ok(hb.heal() === true, 'on both replicas')
  ok(a.doc.pages.length === 1, `a healed to one page (got ${a.doc.pages.length})`)
  ok(b.doc.pages.length === 1, `b healed to one page (got ${b.doc.pages.length})`)
  ok(a.doc.pages[0].id === b.doc.pages[0].id,
    `two replicas healing concurrently produce the SAME page id (${a.doc.pages[0].id} / ${b.doc.pages[0].id})`)
  ok(a.doc.pages[0].id.startsWith('heal-'),
    `the healed id is derived, not minted (${a.doc.pages[0].id})`)
  ok(a.doc.home === a.doc.pages[0].id, 'home points at the healed page')
  ok(ha.heal() === false, 'a space that already has pages is not repaired again')

  // …and it is derived from the ROOM, not docId: `template: true` re-mints
  // docId on every open, so a docId-derived id would give two readers of one
  // file different pages — the failure model.ts repairId already warns about.
  const t1 = space('tmpl'), t2 = space('tmpl')
  t1.doc.pages = []; t2.doc.pages = []
  t1.doc.docId = 'minted-once'; t2.doc.docId = 'minted-again'
  host(new SyncSession(t1)).heal()
  host(new SyncSession(t2)).heal()
  ok(t1.doc.pages[0].id === t2.doc.pages[0].id,
    'same room + different docId (a template, re-minted on open) still heals to one page')
}

// ---------------------------------------------------------------------------
H('heal(): a dangling home is NOT a repair case')
{
  const s = space('dangling')
  s.doc.home = 'no-such-page'
  const before = s.doc.pages.length
  ok(host(new SyncSession(s)).heal() === false, 'heal declines: a home pointing nowhere is not "empty"')
  ok(s.doc.pages.length === before, 'no page is minted for it')
  ok(s.page?.id === 'home', 'homePage() already falls back to pages[0] on its own')
}

// ---------------------------------------------------------------------------
H('clampView(): a deleted subtree surfaces at the nearest ANCESTOR, not home')
{
  // The capture must happen BEFORE the change lands — afterwards the page you
  // were reading is simply gone and there is nothing left to be near.
  const s = space('clamp')
  s.goToPage('kid')
  ok(s.pageId === 'kid', 'reading the child page')
  const h = host(new SyncSession(s))
  const snap = h.captureView()
  s.doc.pages = s.doc.pages.filter((p: { id: string }) => p.id !== 'kid')
  h.clampView(snap)
  ok(s.pageId === 'sec', `surfaced at the surviving parent, not home (got ${s.pageId})`)

  // reindex() on its own would have sent the reader home — that is the whole
  // reason clampView is not just a call to it.
  const bare = space('bare')
  bare.goToPage('kid')
  bare.doc.pages = bare.doc.pages.filter((p: { id: string }) => p.id !== 'kid')
  bare.reindex()
  ok(bare.pageId === 'home', 'reindex alone falls back to home (the behaviour being improved on)')

  // …and when the whole chain is gone, home IS the honest answer
  const deep = space('deep')
  deep.goToPage('kid')
  const hd = host(new SyncSession(deep))
  const snapd = hd.captureView()
  deep.doc.pages = deep.doc.pages.filter((p: { id: string }) => p.id === 'home')
  hd.clampView(snapd)
  ok(deep.pageId === 'home', `whole chain deleted falls back to home (got ${deep.pageId})`)

  // a page that SURVIVES is never moved
  const stay = space('stay')
  stay.goToPage('kid')
  const hs = host(new SyncSession(stay))
  const snaps = hs.captureView()
  stay.doc.pages = stay.doc.pages.filter((p: { id: string }) => p.id !== 'home')
  hs.clampView(snaps)
  ok(stay.pageId === 'kid', 'deleting a DIFFERENT page leaves the reader where they were')
}

// ---------------------------------------------------------------------------
H('clampView(): blocks somebody else deleted leave the selection')
{
  const s = space('sel')
  s.goToPage('home')
  s.select(['b1'])
  const h = host(new SyncSession(s))
  const snap = h.captureView()
  s.doc.pages[0].blocks = []
  const changed = h.clampView(snap)
  ok(changed === true, 'clampView reports the selection changed')
  ok(s.selection.length === 0, 'the dead block is out of the selection')
}

// ---------------------------------------------------------------------------
H("changeEvents: a remote change must not say 'Edited'")
{
  const s = space('events')
  const h = host(new SyncSession(s))
  ok(h.changeEvents.join(',') === 'page',
    `changeEvents is 'page' — EVERY remote change repaints, not just structural ones (got [${h.changeEvents}])`)
  ok(!h.changeEvents.includes('doc') && !h.structureEvents.includes('doc'),
    "and neither list contains 'doc', which is this app's \"you edited something\" signal")
  ok(h.structureEvents.join(',') === 'tree', `structureEvents is tree (got [${h.structureEvents}])`)
  ok(h.presenceEvents.join(',') === 'page,selection', `presenceEvents is page,selection (got [${h.presenceEvents}])`)

  // the dirty dot still moves, on its OWN event
  let docEvents = 0, dirtyEvents = 0
  s.on('doc', () => { docEvents++ })
  s.on('dirty', () => { dirtyEvents++ })
  s.setDirty(true)
  ok(dirtyEvents === 1 && docEvents === 0, `setDirty raises 'dirty' only (doc=${docEvents}, dirty=${dirtyEvents})`)
  ok(s.dirty === true, 'and the flag is set')
  s.setDirty(true)
  ok(dirtyEvents === 1, 'setting it twice does not re-announce')
}

// ---------------------------------------------------------------------------
H('presence(): the PAGE, never the block')
{
  const s = space('presence')
  s.goToPage('sec')
  s.select(['b2'])
  const h = host(new SyncSession(s))
  const p = h.presence()
  ok(p.at === 'sec', `presence reports the page (got ${p.at})`)
  ok(Array.isArray(p.sel), 'and the selection as an array')
}

// ---------------------------------------------------------------------------
H('carriesMedia(): names an embedded image, ignores ordinary prose')
{
  const s = space('media')
  const h = host(new SyncSession(s))
  const img = { op: 'ins', node: { id: 'x', type: 'image', src: 'data:image/png;base64,AAAA' } }
  const txt = { op: 'ins', node: { id: 'y', type: 'p', html: 'just words' } }
  const setSrc = { op: 'set', v: 'data:image/png;base64,BBBB' }
  const setTxt = { op: 'set', v: 'a sentence' }
  ok(h.carriesMedia([img]) === true, 'an inserted data: image is media')
  ok(h.carriesMedia([txt]) === false, 'a paragraph is not')
  ok(h.carriesMedia([setSrc]) === true, 'a data: URI written to a property is media')
  ok(h.carriesMedia([setTxt]) === false, 'ordinary text is not')
  ok(h.carriesMedia([{ op: 'ins', node: { id: 'p', title: 'P', blocks: [img.node] } }]) === true,
    'a page inserted WITH an embedded image is media')
}

// ---------------------------------------------------------------------------
H('end to end: two tabs of one space converge')
{
  // Two sessions in one process over a real BroadcastChannel ARE two tabs.
  // Everything above tests the five answers; this tests that the binding as a
  // whole actually carries an edit, which is the only claim that matters.
  const a = space('e2e'), b = space('e2e')
  const sa = new SyncSession(a), sb = new SyncSession(b)
  await settle()

  a.commit(() => { a.doc.pages[0].blocks.push({ id: 'new-1', type: 'p', html: 'from tab A' }) },
    { structure: true })
  await settle()
  ok(!!b.block('new-1'), 'a block written in tab A arrives in tab B')
  ok(b.block('new-1')?.html === 'from tab A', '…with its text')

  b.commit(() => { b.doc.pages.push({ id: 'pg-b', title: 'Made in B', blocks: [] }) },
    { structure: true })
  await settle()
  ok(!!a.index.page.get('pg-b'), 'a page made in tab B arrives in tab A')

  // A remote change must not claim to be a local edit — but it MUST still move
  // the unsaved dot. Cleared first, or `dirty` is left true by A's own commit
  // above and the assertion passes for the wrong reason.
  let saidEdited = 0, dot = 0
  a.setDirty(false)
  a.on('doc', () => { saidEdited++ })
  a.on('dirty', () => { dot++ })
  b.commit(() => { b.doc.pages[0].blocks.push({ id: 'new-2', type: 'p', html: 'again' }) },
    { structure: true })
  await settle()
  ok(!!a.block('new-2'), 'a second remote block lands')

  // A remote TEXT edit is not structural. It must still repaint, which is the
  // bug two browser tabs found and this rig had not: the model held the new
  // sentence while the screen kept the old one.
  let repaints = 0
  a.on('page', () => { repaints++ })
  b.commit(() => { b.doc.pages[0].blocks[0].html = 'rewritten in B' })
  await settle()
  ok(a.doc.pages[0].blocks[0].html === 'rewritten in B', 'a remote text edit reaches the model')
  ok(repaints > 0, `…and raises a repaint (page events ${repaints})`)
  ok(saidEdited === 0, `and tab A never said 'doc' — no "Edited" for a colleague's typing (got ${saidEdited})`)
  ok(dot === 1 && a.dirty === true, `but the unsaved dot moved (dirty events ${dot}, flag ${a.dirty})`)

  sa.close?.(); sb.close?.()
}

// ---------------------------------------------------------------------------
H('the people UI: who is on which page')
{
  // Only the pure part. The panel, the dots and the three button states were
  // verified in two real browser windows — a DOM shim deep enough to assert on
  // them would be testing the shim.
  const { peersOnPage, initial } = await import('../spaces/src/collabui.ts')
  const peers = [
    { actor: 'a1', name: 'Ada', color: '#f0a', slide: 'home' },
    { actor: 'a2', name: 'Grace', color: '#0af', slide: 'writing' },
    { actor: 'a3', name: 'Alan', color: '#0fa', slide: 'writing' },
  ]
  ok(peersOnPage(peers, 'writing').length === 2, 'two people on one page')
  ok(peersOnPage(peers, 'home').length === 1, 'one on another')
  ok(peersOnPage(peers, 'nobody-here').length === 0, 'none on a page nobody is reading')
  ok(initial('Ada') === 'A', 'the dot takes the first letter')
  ok(initial('') === '?', 'and says so when there is no name')
  // a name whose first character is not one code unit must not be cut in half
  ok(initial('😀 Zoë') === '😀', 'a multi-byte first character survives')
  ok(initial('Ünal') === 'Ü', '…and so does an accented one')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
