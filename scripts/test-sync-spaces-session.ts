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
// A SAVED FILE REJOINS AS A FORK.
//
// Slides stamps `doc.collab.sync` (the session's CRDT state) into every save of
// a shared deck; spaces did not, so an offline-edited copy of a shared space
// reopened as a FRESH ADOPT. Its offline edits were already in the document it
// adopted — the shadow — so no op was ever minted for them and no peer ever
// received them. Everything below drives the code ⌘S runs: share.ts stampSync
// at the moment the document is taken, then the file's JSON through parseDoc,
// a new Store and a new SyncSession, which is exactly what boot() does with a
// file. Each phase is a REAL tab on a REAL BroadcastChannel; "offline" closes
// that tab's transports while its session keeps diffing, which is what a lost
// connection looks like to the session.
const { stampSync, duplicateAsNew } = await import('../spaces/src/share.ts')
const { parseDoc } = await import('../spaces/src/model.ts')
type AnySession = InstanceType<typeof SyncSession>
const priv = (s: AnySession) => s as unknown as {
  transports: Array<{ close(): void }>
  heartbeat: ReturnType<typeof setInterval> | null
  state: { lamport: number; vv: Record<string, number> }
  forkPending: boolean
}
/** the connection drops; the session keeps diffing local edits */
function goOffline(s: AnySession): void {
  for (const tr of priv(s).transports) tr.close()
  priv(s).transports = []
}
/** the tab is closed */
function closeTab(s: AnySession): void {
  goOffline(s)
  if (priv(s).heartbeat) clearInterval(priv(s).heartbeat!)
}
/** ⌘S: stamp, then the bytes that reach the file (the doc JSON) */
function save(store: AnyStore, session: AnySession): string {
  stampSync(store, session)
  return JSON.stringify(store.doc)
}
/** open a saved file in a new tab, as boot() does */
function reopen(file: string): { store: AnyStore; session: AnySession } {
  const r = parseDoc(file)
  if (!r.ok) throw new Error('saved file did not parse')
  const store = new Store(r.doc)
  return { store, session: new SyncSession(store) }
}
const html = (s: AnyStore, id: string) => s.block(id)?.html
const pagesKey = (s: AnyStore) => JSON.stringify(s.doc.pages)

H('a saved file rejoins as a fork: A edits offline, B edits meanwhile, both survive')
{
  const a = space('fork'), b = space('fork')
  const sa = new SyncSession(a), sb = new SyncSession(b)
  await settle()
  a.commit(() => { a.doc.pages[0].blocks.push({ id: 'shared', type: 'p', html: 'written live' }) }, { structure: true })
  await settle()
  ok(html(b, 'shared') === 'written live', 'live: A’s block reached B before anyone went offline')

  // A saves while live — the stamp is the CURRENT state, and only shared
  // documents carry it
  const first = save(a, sa)
  const stamped = JSON.parse(first).collab?.sync
  ok(!!stamped && stamped.v === 2 && stamped.lamport > 0,
    `⌘S stamps collab.sync (v=${stamped?.v}, lamport=${stamped?.lamport})`)

  // A drops offline, edits, saves, closes
  goOffline(sa)
  a.commit(() => { a.doc.pages[0].blocks.push({ id: 'off-a', type: 'p', html: 'written offline in A' }) }, { structure: true })
  a.commit(() => { a.doc.pages[1].title = 'Renamed offline in A' })
  await settle()
  const file = save(a, sa)
  closeTab(sa)
  ok((JSON.parse(file).collab?.sync?.lamport ?? 0) > (stamped?.lamport ?? 0),
    'the offline save stamps the NEWER state — the one that knows about the offline edits')

  // meanwhile B keeps working
  b.commit(() => { b.doc.pages[0].blocks.push({ id: 'on-b', type: 'p', html: 'written by B meanwhile' }) }, { structure: true })
  b.commit(() => { b.doc.pages[2].title = 'Renamed by B meanwhile' })
  await settle()
  ok(!b.block('off-a'), 'while A is away B has not seen its edit (the partition is real)')

  // A reopens the saved file and rejoins
  const { store: a2, session: sa2 } = reopen(file)
  ok(priv(sa2).forkPending === true && priv(sa2).state.lamport > 0,
    'the reopened file restored its CRDT state (a fork, not a fresh adopt)')
  await settle(600)

  ok(html(b, 'off-a') === 'written offline in A', 'B received A’s offline block')
  ok(b.doc.pages[1].title === 'Renamed offline in A', 'B received A’s offline rename')
  ok(html(a2, 'on-b') === 'written by B meanwhile', 'A received B’s block from the time it was away')
  ok(a2.doc.pages[2].title === 'Renamed by B meanwhile', 'A received B’s rename')
  ok(html(a2, 'off-a') === 'written offline in A' && a2.doc.pages[1].title === 'Renamed offline in A',
    'replay did NOT overwrite A’s offline edits on A')
  ok(pagesKey(a2) === pagesKey(b), 'A and B converged on the same pages')
  closeTab(sa2); closeTab(sb)
}

H('a saved file rejoins as a fork: concurrent edits to the SAME block')
{
  const a = space('same'), b = space('same')
  const sa = new SyncSession(a), sb = new SyncSession(b)
  await settle()
  goOffline(sa)
  // both rewrite b1 ("hello") while partitioned — A on its side, B on its own
  a.commit(() => { a.doc.pages[0].blocks[0].html = 'hello from A offline' })
  b.commit(() => { b.doc.pages[0].blocks[0].html = 'B says hello' })
  // and both edit the same page's title, a plain LWW register
  a.commit(() => { a.doc.pages[0].title = 'Home (A)' })
  await settle()
  b.commit(() => { b.doc.pages[0].title = 'Home (B)' })
  await settle()
  const file = save(a, sa)
  closeTab(sa)
  const { store: a2, session: sa2 } = reopen(file)
  await settle(600)
  const merged = html(a2, 'b1') ?? ''
  ok(merged === html(b, 'b1'), `the block's text converged on both sides ("${merged}")`)
  ok(merged.includes('from A offline') && merged.includes('B says'),
    'the text merge kept BOTH sides’ words — neither edit was thrown away')
  ok(a2.doc.pages[0].title === b.doc.pages[0].title,
    `the title (a register) converged on one winner ("${a2.doc.pages[0].title}")`)
  ok(pagesKey(a2) === pagesKey(b), 'A and B converged on the same pages')
  closeTab(sa2); closeTab(sb)
}

H('a stamped file reopened with no peers keeps its edits and its state')
{
  const a = space('alone')
  const sa = new SyncSession(a)
  a.commit(() => { a.doc.pages[0].blocks.push({ id: 'solo', type: 'p', html: 'mine' }) }, { structure: true })
  await settle()
  const file = save(a, sa)
  closeTab(sa)
  const before = JSON.parse(file)
  const { store: a2, session: sa2 } = reopen(file)
  await settle()
  ok(pagesKey(a2) === JSON.stringify(before.pages), 'nothing in the document moved on reopen with nobody there')
  ok(priv(sa2).forkPending && priv(sa2).state.vv[Object.keys(before.collab?.sync?.vv ?? {})[0]] > 0,
    'the restored version vector still knows the earlier tab’s ops')
  a2.commit(() => { a2.doc.pages[0].blocks.push({ id: 'solo-2', type: 'p', html: 'more' }) }, { structure: true })
  await settle()
  const again = JSON.parse(save(a2, sa2))
  ok((again.collab?.sync?.lamport ?? 0) > (before.collab?.sync?.lamport ?? 0), 'and saving again stamps a state that has moved on')
  closeTab(sa2)

  // The next time the file is opened with somebody there, they get
  // everything the lone tab wrote. The colleague's tab is open FIRST: a fork
  // announces itself with one `snap` at its own hello, so over the
  // same-machine channel a peer that opens AFTER the fork never hears it (the
  // relay covers that case by persisting the fork's snapshot — onRelayReady).
  // That gap is the kernel session's, shared with slides, and not this rig's.
  const colleague = space('alone')
  const sl = new SyncSession(colleague)
  await settle()
  const { store: a3, session: sa3 } = reopen(JSON.stringify(again))
  await settle(600)
  ok(html(colleague, 'solo') === 'mine' && html(colleague, 'solo-2') === 'more',
    'reopened later with a colleague there, the edits made with nobody there reach them')
  ok(pagesKey(colleague) === pagesKey(a3), 'and the two converge')
  closeTab(sa3); closeTab(sl)

  // pre-v2 state (bare-id keys) is DISCARDED, as in slides: the file joins as
  // a never-synced adopt rather than restoring registers it cannot read
  const legacy = JSON.parse(file)
  legacy.collab.sync = { v: 1, lamport: 99, regs: { x: [99, 'z'] } }
  const { session: sv1 } = reopen(JSON.stringify(legacy))
  ok(priv(sv1).state.lamport === 0 && priv(sv1).forkPending === false,
    'a pre-v2 stamp is discarded — fresh adopt, not a restore')
  closeTab(sv1)
}

H('what each write carries: the rules per path')
{
  const a = space('rules')
  const sa = new SyncSession(a)
  a.commit(() => { a.doc.pages[0].blocks.push({ id: 'r1', type: 'p', html: 'x' }) }, { structure: true })
  await settle()

  // a never-shared space stays clean
  const solo = space('rules-solo')
  delete (solo.doc as { collab?: unknown }).collab
  const ss = new SyncSession(solo)
  stampSync(solo, ss)
  ok(!(solo.doc as { collab?: { sync?: unknown } }).collab?.sync, 'a space with no session gets no stamp')
  closeTab(ss)

  // a read-only store never rewrites what the file carries
  const ro = space('rules-ro')
  const foreign = { v: 3, lamport: 7, future: true }
  ;(ro.doc.collab as { sync?: unknown }).sync = foreign
  ro.readOnly = true
  const sro = new SyncSession(ro)
  stampSync(ro, sro)
  ok(JSON.stringify((ro.doc.collab as { sync?: unknown }).sync) === JSON.stringify(foreign),
    'a read-only (frozen / reader / reading-copy) store leaves an unknown-version stamp untouched')
  closeTab(sro)

  // an older build round-trips the stamp byte-for-byte: parseDoc keeps unknown
  // and known collab fields exactly as written
  const file = save(a, sa)
  const r = parseDoc(file)
  ok(r.ok && JSON.stringify(r.doc.collab?.sync) === JSON.stringify(JSON.parse(file).collab?.sync) && !!r.doc.collab?.sync,
    'parseDoc carries collab.sync through untouched')

  // Duplicate as a new space: new identity, no credentials, no state
  const dup = duplicateAsNew(a.doc, 'doc-dup', '2026-10-04T00:00:00.000Z')
  ok(dup.docId === 'doc-dup' && !('collab' in dup), 'Duplicate drops collab — and with it the stamped sync')
  ok(!!(a.doc.collab as { sync?: unknown }).sync, '…without touching the original, which keeps its own')
  closeTab(sa)
}

H('Duplicate as a new space never syncs with its ancestor')
{
  const a = space('ancestor'), b = space('ancestor')
  const sa = new SyncSession(a), sb = new SyncSession(b)
  await settle()
  stampSync(a, sa)
  const dupStore = new Store(parseDoc(JSON.stringify(duplicateAsNew(a.doc, 'doc-dup-2'))).doc)
  const sd = new SyncSession(dupStore)
  await settle()
  ok(priv(sd).forkPending === false && priv(sd).state.lamport === 0,
    'the duplicate starts from no state — it is not a fork of anything')
  dupStore.commit(() => { dupStore.doc.pages[0].blocks.push({ id: 'in-dup', type: 'p', html: 'only in the duplicate' }) }, { structure: true })
  a.commit(() => { a.doc.pages[0].blocks.push({ id: 'in-anc', type: 'p', html: 'only in the ancestor' }) }, { structure: true })
  await settle(600)
  ok(!a.block('in-dup') && !b.block('in-dup'), 'an edit in the duplicate never reaches the ancestor’s tabs')
  ok(!dupStore.block('in-anc'), 'and an edit in the ancestor never reaches the duplicate')
  ok(html(b, 'in-anc') === 'only in the ancestor', '(while the ancestor’s own tabs still sync — the channel is live)')
  const room = (dupStore.doc.collab as { room?: string } | undefined)?.room
  ok(!room || room !== (a.doc.collab as { room?: string }).room,
    `the duplicate is in no room of the ancestor's (room ${room ?? 'none yet'})`)
  closeTab(sa); closeTab(sb); closeTab(sd)
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
