#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The relay half of BROADCAST — a show as a special case of collaboration.
//
//   node scripts/test-relay-broadcast.ts        (Node ≥ 23.6 strips types natively)
//
// Drives the real `Room` from server/sync-worker/src/worker.js through the
// harness in scripts/lib/relay-harness.ts. What it proves, and why each one
// would be silent if it regressed:
//
//   1. ADMISSION is the owner-signed `audience` invite, not the room token. An
//      audience copy holds the SHOW key, derives a different `?tok=`, and would
//      be 403'd by the token compare — so that compare is skipped for the
//      role, and ONLY for the role. Admitted only while live (else close 4002),
//      only in `w` rooms, and never on a revoked invite.
//   2. AUDIENCE SOCKETS ARE RECEIVE-ONLY. Every frame from one is dropped —
//      ops, presence, control. The invite is on the same chain as a writer's,
//      so any membership check would let a ticket drive.
//   3. THE `aud` STREAM is writer-only, live-only, NEVER persisted (p:1 is
//      ignored on it), and routed to audience sockets only; the room stream
//      never reaches an audience socket. That routing is the whole isolation.
//   4. CONTROL VERBS verify by ROLE against the socket's pinned writer key.
//      nav/black are signed with the STREAM in the text and retained as latest
//      state; laser is unsigned and never retained.
//   5. A LATE JOINER is served the relay-held show — snapshot, aud ops since,
//      nav/black — and NOT the op log or the persisted room snapshot, which are
//      room-key ciphertext and collaborator metadata.
//   6. THE SHOW STATE IS IN DO STORAGE, not memory. Hibernation evicts the
//      object mid-connection; the rig constructs a SECOND Room over the same
//      storage and serves a joiner from it.
//   7. THE BYTE CAP asks the presenter to checkpoint once, refuses new joiners
//      at twice the cap, and a checkpoint resets both.
//   8. GRACE AND THE SINGLE ALARM. Presenter loss schedules a 60 s grace; a
//      writer's `live` cancels it; when it fires the show ends — and the ROOM
//      SURVIVES. The DO has one alarm, it used to mean "wipe the room", and a
//      grace timer armed the naive way would have evaporated a live room.
//   9. THE COUNT reaches writer sockets only, on a tick, only when changed.
//  10. `ready` advertises `bc:1` so a client can feature-detect the channel.

import {
  mkState, mkSocket, Room, mintKeys, chainQuery, connect, prove,
  TOK, IV, CT, parse, ok, finish, type Sock,
} from './lib/relay-harness.ts'

const owner = await mintKeys()
const NAME = owner.room
const audInvite = await mintKeys()   // the owner-signed `audience` invite keypair
const writerInvite = await mintKeys() // an ordinary `writer` invite, for contrast
const viewerA = await mintKeys()
const viewerB = await mintKeys()
const member = await mintKeys()

/** A fresh room with the owner connected and proven as presenter. */
async function stage() {
  const state = mkState()
  const room = new Room(state, {})
  await state.storage.put('name', NAME)
  await state.storage.put('tok', TOK)
  const p = await connect(room, NAME, `&bt=1&w=${owner.pub}`)
  ok(p.ready?.v === 2 && p.ready?.bc === 1, 'a writer’s ready carries the version and bc:1')
  await prove(room, p, owner, NAME)
  return { state, room, presenter: p.server }
}
const audQuery = (viewer: { pub: string; sign(t: string): Promise<string> }) => chainQuery(owner, audInvite, viewer, 'audience')
const goLive = (room: InstanceType<typeof Room>, sock: Sock) =>
  owner.sign('live').then((g) => room.onMessage(sock, JSON.stringify({ ctl: 'live', g })))
const endIt = (room: InstanceType<typeof Room>, sock: Sock) =>
  owner.sign('end').then((g) => room.onMessage(sock, JSON.stringify({ ctl: 'end', g })))
const frames = (s: Sock) => s.sent.map(parse)

// ---------------------------------------------------------------------------
{
  console.log('admission: the audience invite, not the token; only while live…')
  const { state, room, presenter } = await stage()

  const early = await connect(room, NAME, await audQuery(viewerA), 'notTheRoomToken0')
  ok(early.server.closeCode === 4002 && early.server.closeReason === 'not-live', 'before `live`, an audience socket is closed 4002 not-live')

  await goLive(room, presenter)
  ok((await state.storage.get('show:live')) === 1, 'a writer-signed `live` starts the show')

  const a = await connect(room, NAME, await audQuery(viewerA), 'notTheRoomToken0')
  ok(a.status === 101 && !a.server.closed, 'while live, an audience socket is admitted WITHOUT the room token')
  ok(a.ready?.bc === 1, 'its ready advertises bc:1')
  ok(a.ready?.v === 2, 'and the relay protocol version — the read-only way to tell a deploy apart')
  ok(a.ready?.q === undefined, 'and carries no room sequence — the op log is not its business')
  ok(!!(a.server.deserializeAttachment() as { audience?: boolean }).audience, 'pinned as audience')
  ok((a.server.deserializeAttachment() as { w?: unknown }).w === null, 'with no writer key')

  const r = await connect(room, NAME, '', 'notTheRoomToken0')
  ok(r.status === 403, 'a NON-audience socket with the wrong token is still 403 — the skip is for the role only')

  // a writer invite presented as audience: the owner signed `inv.<pub>.writer.0`,
  // so the audience-text verification fails
  const forged = await chainQuery(owner, writerInvite, viewerB, 'writer')
  const f = await connect(room, NAME, forged.replace('&ivr=writer', '&ivr=audience'))
  ok(f.status === 403, 'a writer invite relabelled `audience` is refused (role is in the signed text)')

  const bad = await connect(room, NAME, forged.replace(`&w=${viewerB.pub}`, `&w=${viewerA.pub}`).replace('&ivr=writer', '&ivr=audience'))
  ok(bad.status === 403, 'a delegation for another key is refused')

  // r-room: no chain, no audience
  const rstate = mkState()
  const rroom = new Room(rstate, {})
  await rstate.storage.put('name', 'rLEGACY')
  await rstate.storage.put('tok', TOK)
  const rr = await connect(rroom, 'rLEGACY', await audQuery(viewerA))
  ok(rr.status === 403, 'a legacy r-room admits no audience')
}

// ---------------------------------------------------------------------------
{
  console.log('audience sockets are receive-only…')
  const { state, room, presenter } = await stage()
  await goLive(room, presenter)
  const a = await connect(room, NAME, await audQuery(viewerA))
  const b = await connect(room, NAME, await audQuery(viewerB))
  presenter.sent.length = 0
  b.server.sent.length = 0
  const seqBefore = await state.storage.get('seq')

  await room.onMessage(a.server, JSON.stringify({ i: IV, d: CT }))                          // presence-shaped
  await room.onMessage(a.server, JSON.stringify({ p: 1, i: IV, d: CT, g: 'x' }))            // op-shaped
  await room.onMessage(a.server, JSON.stringify({ s: 'aud', i: IV, d: CT }))                // aud-shaped
  await room.onMessage(a.server, JSON.stringify({ ctl: 'nav', s: 'aud', i: IV, d: CT, g: await viewerA.sign(`nav.aud.${IV}.${CT}`) }))
  await room.onMessage(a.server, JSON.stringify({ ctl: 'end', g: await viewerA.sign('end') }))

  ok(presenter.sent.length === 0, 'nothing an audience socket sends reaches the presenter')
  ok(b.server.sent.length === 0, 'nothing reaches another audience socket')
  ok((await state.storage.get('seq')) === seqBefore, 'nothing was persisted')
  ok((await state.storage.get('show:nav:aud')) === undefined, 'no control state was retained')
  ok((await state.storage.get('show:live')) === 1, 'and an audience `end` did not end the show')
}

// ---------------------------------------------------------------------------
{
  console.log('the aud stream: writer-only, never persisted, audience-only…')
  const { state, room, presenter } = await stage()
  await goLive(room, presenter)
  const reader = await connect(room, NAME, '')      // a collaborator reader on the room stream
  const a = await connect(room, NAME, await audQuery(viewerA))
  reader.server.sent.length = 0; a.server.sent.length = 0; presenter.sent.length = 0
  const seqBefore = (await state.storage.get('seq')) || 0

  // presenter → aud stream, in the shape the REAL client sends it: the
  // transport's send() marks every ops frame p:1 and signs it, and the aud
  // copy inherits both. So this frame would pass the persist path's signature
  // gate if it ever reached it — which is exactly the regression to catch:
  // show-key ciphertext landing in the room's op log, where the audience's
  // edits would be replayed to every future collaborator as undecryptable
  // noise and the room's byte cap would be spent on a stream that is not
  // supposed to exist after `end`.
  const audG = await owner.sign(`${IV}.${CT}`)
  await room.onMessage(presenter, JSON.stringify({ s: 'aud', p: 1, k: 'k1', i: IV, d: CT, g: audG }))
  ok(((await state.storage.get('seq')) || 0) === seqBefore, 'an aud frame is NOT persisted even when it is p:1 AND validly signed')
  ok((await state.storage.list({ prefix: 'op:' })).size === 0, 'no op: key was written for it')
  ok(!frames(presenter).some((f) => f.ctl === 'ack'), 'and the presenter was not acked for it as if it had been')
  ok(frames(a.server).some((f) => f.s === 'aud' && f.i === IV), 'it reaches the audience')
  ok(reader.server.sent.length === 0, 'it does NOT reach a room-stream reader')
  ok((await state.storage.list({ prefix: 'show:op:' })).size === 1, 'it is held in the show state')

  // presenter → room stream (a signed persisted op): audience must not see it
  a.server.sent.length = 0
  const g = await owner.sign(`${IV}.${CT}`)
  await room.onMessage(presenter, JSON.stringify({ p: 1, i: IV, d: CT, g }))
  ok(frames(reader.server).some((f) => f.q === 1), 'a room-stream op reaches the reader, stamped')
  ok(a.server.sent.length === 0, 'and never reaches the audience')

  // a reader on the room stream cannot feed the audience
  a.server.sent.length = 0
  await room.onMessage(reader.server, JSON.stringify({ s: 'aud', i: IV, d: CT }))
  ok(a.server.sent.length === 0, 'a READER’s aud-tagged frame is dropped')
  ok((await state.storage.list({ prefix: 'show:op:' })).size === 1, 'and not held')

  // not live: aud frames are dropped
  await endIt(room, presenter)
  const a2 = await connect(room, NAME, await audQuery(viewerA))
  ok(a2.server.closeCode === 4002, 'after `end` the audience is not admitted')
}

// ---------------------------------------------------------------------------
{
  console.log('a certified-but-unproven socket is a reader to the show…')
  const { state, room, presenter } = await stage()
  await goLive(room, presenter)
  const a = await connect(room, NAME, await audQuery(viewerA))
  // The socket every reader copy can open: `?w=` is the owner's PUBLIC key,
  // which hash-matches the room name and pins `w` — without the private half
  // it can never answer the nonce, so it is never `proven`.
  const imp = await connect(room, NAME, `&bt=1&w=${owner.pub}`)
  ok(typeof imp.ready?.c === 'string' && !(imp.server.deserializeAttachment() as { proven?: boolean }).proven, 'a reader presenting the owner’s public key is certified and challenged, not proven')
  a.server.sent.length = 0; presenter.sent.length = 0
  const held = (await state.storage.list({ prefix: 'show:op:' })).size

  await room.onMessage(imp.server, JSON.stringify({ s: 'aud', p: 1, i: IV, d: CT }))
  await room.onMessage(imp.server, JSON.stringify({ ctl: 'laser', s: 'aud', i: IV, d: CT }))
  await room.onMessage(imp.server, JSON.stringify({ ctl: 'audsnap', i: IV, d: CT }))
  await room.onMessage(imp.server, JSON.stringify({ ctl: 'end', g: await owner.sign('end') }))
  ok(a.server.sent.length === 0, 'its aud op, laser and audsnap reach no audience socket')
  ok((await state.storage.list({ prefix: 'show:op:' })).size === held, 'nothing it sent is held for late joiners')
  ok((await state.storage.get('show:snap')) === undefined, 'it cannot replace the held snapshot')
  ok((await state.storage.get('show:live')) === 1, 'and it cannot end the show — even carrying the owner’s real `end` signature, on an unproven socket')

  // nor can it fill the show
  const big = 'x'.repeat(300 * 1024)
  await room.onMessage(imp.server, JSON.stringify({ s: 'aud', i: big, d: big }))
  await room.onMessage(imp.server, JSON.stringify({ s: 'aud', i: big, d: big }))
  ok((await state.storage.get('show:full')) === undefined, 'two oversize frames from it do not mark the show full')
  const late = await connect(room, NAME, await audQuery(viewerB))
  ok(late.status === 101 && !late.server.closed, 'and joiners are still admitted')

  // a chain-admitted co-presenter who DOES prove is not locked out
  const co = await connect(room, NAME, await chainQuery(owner, writerInvite, member, 'writer'))
  await prove(room, co, member, NAME)
  a.server.sent.length = 0
  await room.onMessage(co.server, JSON.stringify({ ctl: 'laser', s: 'aud', i: IV, d: CT }))
  ok(frames(a.server).some((f) => f.ctl === 'laser'), 'a proven co-presenter’s laser reaches the audience')
}

// ---------------------------------------------------------------------------
{
  console.log('control verbs verify by role; nav/black retained, laser not…')
  const { state, room, presenter } = await stage()
  const reader = await connect(room, NAME, '')
  // a reader (no pinned key) cannot start a show, however it signs
  await room.onMessage(reader.server, JSON.stringify({ ctl: 'live', g: await owner.sign('live') }))
  ok((await state.storage.get('show:live')) === undefined, 'a socket with no writer key cannot `live`, even with the owner’s signature')
  // a writer with a bad signature cannot either
  await room.onMessage(presenter, JSON.stringify({ ctl: 'live', g: await viewerA.sign('live') }))
  ok((await state.storage.get('show:live')) === undefined, 'a writer socket with a signature from another key cannot `live`')
  await goLive(room, presenter)

  const a = await connect(room, NAME, await audQuery(viewerA))
  a.server.sent.length = 0; reader.server.sent.length = 0

  const navG = await owner.sign(`nav.aud.${IV}.${CT}`)
  await room.onMessage(presenter, JSON.stringify({ ctl: 'nav', s: 'aud', i: IV, d: CT, g: navG }))
  ok(frames(a.server).some((f) => f.ctl === 'nav' && f.s === 'aud' && f.g === navG), 'a signed aud nav reaches the audience with its signature')
  ok(reader.server.sent.length === 0, 'and not the room stream')
  ok((await state.storage.get('show:nav:aud'))?.i === IV, 'it is retained as the latest aud nav')

  // the same ciphertext signed for the ROOM stream, replayed as aud: refused
  a.server.sent.length = 0
  const roomG = await owner.sign(`nav.room.${IV}.${CT}`)
  await room.onMessage(presenter, JSON.stringify({ ctl: 'nav', s: 'aud', i: IV, d: CT, g: roomG }))
  ok(a.server.sent.length === 0, 'a room-stream nav signature cannot be replayed onto the aud stream')

  // room-stream nav goes to collaborators, not the audience
  await room.onMessage(presenter, JSON.stringify({ ctl: 'nav', s: 'room', i: IV, d: CT, g: roomG }))
  ok(frames(reader.server).some((f) => f.ctl === 'nav' && f.s === 'room'), 'a room-stream nav reaches collaborators')
  ok(a.server.sent.length === 0, 'and not the audience')

  // laser: unsigned, fanned, not retained
  a.server.sent.length = 0
  await room.onMessage(presenter, JSON.stringify({ ctl: 'laser', s: 'aud', i: IV, d: CT }))
  ok(frames(a.server).some((f) => f.ctl === 'laser'), 'an unsigned laser from a writer reaches the audience')
  ok((await state.storage.get('show:laser:aud')) === undefined, 'and is not retained')
  a.server.sent.length = 0
  await room.onMessage(reader.server, JSON.stringify({ ctl: 'laser', s: 'aud', i: IV, d: CT }))
  ok(a.server.sent.length === 0, 'a laser from a reader is dropped')

  // black, unsigned: dropped; signed: retained
  await room.onMessage(presenter, JSON.stringify({ ctl: 'black', s: 'aud', i: IV, d: CT }))
  ok((await state.storage.get('show:black:aud')) === undefined, 'an unsigned black is dropped')
  await room.onMessage(presenter, JSON.stringify({ ctl: 'black', s: 'aud', i: IV, d: CT, g: await owner.sign(`black.aud.${IV}.${CT}`) }))
  ok((await state.storage.get('show:black:aud'))?.i === IV, 'a signed black is retained')
}

// ---------------------------------------------------------------------------
{
  console.log('a late joiner is served the show, not the room…')
  const { state, room, presenter } = await stage()
  // some persisted room history the audience must never see
  for (let n = 0; n < 3; n++) {
    const i = IV + n, d = CT + n
    await room.onMessage(presenter, JSON.stringify({ p: 1, i, d, g: await owner.sign(`${i}.${d}`) }))
  }
  const si = IV + 'S', sd = CT + 'S'
  await room.onMessage(presenter, JSON.stringify({ snap: 1, q: 3, i: si, d: sd, g: await owner.sign(`${si}.${sd}`) }))
  ok((await state.storage.get('snap'))?.q === 3, 'the room holds a persisted snapshot')

  await goLive(room, presenter)
  await room.onMessage(presenter, JSON.stringify({ ctl: 'audsnap', i: 'AUDI', d: 'AUDD' }))
  await room.onMessage(presenter, JSON.stringify({ s: 'aud', i: 'OP1I', d: 'OP1D' }))
  await room.onMessage(presenter, JSON.stringify({ s: 'aud', i: 'OP2I', d: 'OP2D' }))
  await room.onMessage(presenter, JSON.stringify({ ctl: 'nav', s: 'aud', i: 'NAVI', d: 'NAVD', g: await owner.sign(`nav.aud.NAVI.NAVD`) }))

  const late = await connect(room, NAME, await audQuery(viewerB))
  const got = frames(late.server)
  ok(got[0]?.ctl === 'audsnap' && got[0].i === 'AUDI', 'first: the held aud snapshot')
  ok(got[1]?.s === 'aud' && got[1].i === 'OP1I' && got[2]?.i === 'OP2I', 'then the aud ops since, in order')
  ok(got.some((f) => f.ctl === 'nav' && f.i === 'NAVI'), 'then the retained nav')
  ok(got[got.length - 1]?.ctl === 'ready' && got[got.length - 1].bc === 1, 'then ready, with bc:1')
  ok(!got.some((f) => f.snap === 1), 'NEVER the room’s persisted snapshot')
  ok(!got.some((f) => typeof f.q === 'number' && f.ctl !== 'ready'), 'NEVER the op log')

  // 6. the show state survives eviction: a fresh Room over the same storage
  const again = new Room(state, {})
  const late2 = await connect(again, NAME, await audQuery(viewerA))
  const got2 = frames(late2.server)
  ok(got2[0]?.ctl === 'audsnap' && got2.some((f) => f.i === 'OP2I') && got2.some((f) => f.ctl === 'nav'), 'a NEW Room over the same storage serves the same show — it lives in storage, not memory')

  // a checkpoint supersedes the ops
  await room.onMessage(presenter, JSON.stringify({ ctl: 'audsnap', i: 'AUD2', d: 'AUD2' }))
  ok((await state.storage.list({ prefix: 'show:op:' })).size === 0, 'a checkpoint drops the aud ops it supersedes')
  ok(frames(late.server).some((f) => f.ctl === 'audsnap' && f.i === 'AUD2'), 'and reaches the audience already present')
}

// ---------------------------------------------------------------------------
{
  console.log('the byte cap: checkpoint asked once, joiners refused at twice…')
  const { state, room, presenter } = await stage()
  await goLive(room, presenter)
  presenter.sent.length = 0
  const big = 'x'.repeat(4096)
  let asked = 0
  let n = 0
  // push until the checkpoint request appears, then keep going
  while (n < 200) {
    await room.onMessage(presenter, JSON.stringify({ s: 'aud', i: big, d: big }))
    n++
    asked = frames(presenter).filter((f) => f.ctl === 'audckpt').length
    if (asked && (await state.storage.get('show:full'))) break
  }
  ok(asked === 1, `the presenter was asked to checkpoint exactly once (after ${n} frames)`)
  ok((await state.storage.get('show:full')) === 1, 'past twice the cap the show is marked full')
  const heldAtCap = await state.storage.get('show:bytes') as number
  presenter.sent.length = 0
  await room.onMessage(presenter, JSON.stringify({ s: 'aud', k: 'k-over', i: big, d: big }))
  ok((await state.storage.get('show:bytes')) === heldAtCap, 'past the hard cap nothing more is appended')
  ok(frames(presenter).some((f) => f.ctl === 'refused' && f.code === 'show-full' && f.k === 'k-over'), 'and the sender is refused with a code naming the frame')
  const refused = await connect(room, NAME, await audQuery(viewerA))
  ok(refused.server.closeCode === 4003 && refused.server.closeReason === 'show-full', 'a joiner is refused 4003 show-full')
  await room.onMessage(presenter, JSON.stringify({ ctl: 'audsnap', i: 'AUDI', d: 'AUDD' }))
  ok((await state.storage.get('show:full')) === undefined && (await state.storage.get('show:bytes')) === 0, 'a checkpoint resets the cap')
  const admitted = await connect(room, NAME, await audQuery(viewerA))
  ok(admitted.status === 101 && !admitted.server.closed, 'and joiners are admitted again')

  // a co-presenter pushing the show over the SOFT line: the request still goes
  // to the socket that sent `live`, not to the sender
  const co = await connect(room, NAME, await chainQuery(owner, writerInvite, member, 'writer'))
  await prove(room, co, member, NAME)
  presenter.sent.length = 0; co.server.sent.length = 0
  for (let i = 0; i < 40; i++) await room.onMessage(co.server, JSON.stringify({ s: 'aud', i: big, d: big }))
  ok(frames(presenter).some((f) => f.ctl === 'audckpt'), 'a co-presenter’s ops ask the PRESENTER to checkpoint')
  ok(!frames(co.server).some((f) => f.ctl === 'audckpt'), 'not the co-presenter')
}

// ---------------------------------------------------------------------------
{
  console.log('grace, and the one alarm the DO has…')
  const { state, room, presenter } = await stage()
  await goLive(room, presenter)
  const a = await connect(room, NAME, await audQuery(viewerA))
  ok((await state.storage.get('al:idle')) !== undefined, 'the idle wipe is scheduled')

  // the presenter's socket dies without `end`
  await room.webSocketClose(presenter)
  const graceAt = await state.storage.get('al:grace') as number | undefined
  ok(typeof graceAt === 'number' && graceAt > Date.now(), 'presenter loss schedules a grace period')
  ok((await state.storage.get('al:idle')) !== undefined, 'and the idle wipe is STILL scheduled beside it')
  const dueTimes = [...(await state.storage.list({ prefix: 'al:' })).values()] as number[]
  ok(state.alarmAt === Math.min(...dueTimes) && dueTimes.length === 3, 'the DO alarm is armed to the EARLIEST of idle, grace and the count tick')

  // a writer's `live` cancels it — here a co-presenter on a member chain
  const co = await connect(room, NAME, await chainQuery(owner, writerInvite, member, 'writer'))
  // unproven, the co-presenter's `live` is nothing — a certified socket is a reader to the show
  await room.onMessage(co.server, JSON.stringify({ ctl: 'live', g: await member.sign('live') }))
  ok((await state.storage.get('al:grace')) !== undefined, 'an UNPROVEN co-presenter’s `live` does not cancel the grace')
  await prove(room, co, member, NAME)
  await room.onMessage(co.server, JSON.stringify({ ctl: 'live', g: await member.sign('live') }))
  ok((await state.storage.get('al:grace')) === undefined, 'a PROVEN writer’s `live` cancels the grace')
  ok((await state.storage.get('show:live')) === 1, 'and the show continues')

  // grace runs out: the show ends and THE ROOM SURVIVES
  await room.webSocketClose(co.server)
  await state.storage.put('al:grace', Date.now() - 1)
  await room.alarm()
  ok(a.server.closeCode === 4001 && a.server.closeReason === 'grace', 'when grace fires, audience sockets are closed 4001')
  ok((await state.storage.get('show:live')) === undefined, 'the show is over')
  ok((await state.storage.get('name')) === NAME && (await state.storage.get('tok')) === TOK, 'and the room was NOT wiped — the grace alarm did not run the idle wipe')
  ok((await state.storage.get('al:idle')) !== undefined && state.alarmAt !== null, 'the idle wipe is still armed')

  // and the idle wipe, when IT fires, still wipes
  await state.storage.put('al:idle', Date.now() - 1)
  await room.alarm()
  ok((await state.storage.get('name')) === undefined, 'the idle alarm still evaporates the room')
}

// ---------------------------------------------------------------------------
{
  console.log('the audience count: writers only, on a tick, when changed…')
  const { state, room, presenter } = await stage()
  const reader = await connect(room, NAME, '')
  await goLive(room, presenter)
  const a = await connect(room, NAME, await audQuery(viewerA))
  const b = await connect(room, NAME, await audQuery(viewerB))
  ok((await state.storage.get('al:count')) !== undefined, 'joins schedule a count tick')
  ok(!frames(presenter).some((f) => f.ctl === 'audcount'), 'but nothing is sent per join')
  presenter.sent.length = 0; reader.server.sent.length = 0; a.server.sent.length = 0

  await room.pushCount()
  ok(frames(presenter).some((f) => f.ctl === 'audcount' && f.n === 2), 'the tick tells the presenter how many are watching')
  ok(reader.server.sent.length === 0, 'a room reader is not told')
  ok(a.server.sent.length === 0, 'the audience is not told')
  presenter.sent.length = 0
  await room.pushCount()
  ok(presenter.sent.length === 0, 'an unchanged count sends nothing')
  await room.webSocketClose(b.server)
  await room.pushCount()
  ok(frames(presenter).some((f) => f.ctl === 'audcount' && f.n === 1), 'a leave shows on the next tick')
}

// ---------------------------------------------------------------------------
{
  console.log('"Issue new tickets": revoking the audience invite…')
  const { state, room, presenter } = await stage()
  await goLive(room, presenter)
  const a = await connect(room, NAME, await audQuery(viewerA))

  // revoking a COLLABORATOR's member key: the audience hears nothing
  a.server.sent.length = 0
  await room.onMessage(presenter, JSON.stringify({
    ctl: 'revoke', p: member.pub, o: owner.pub, g: await owner.sign(`rev.${member.pub}`),
  }))
  ok(a.server.sent.length === 0 && !a.server.closed, 'a collaborator revocation reaches no audience socket')

  // "Issue new tickets": revoking the AUDIENCE invite
  await room.onMessage(presenter, JSON.stringify({
    ctl: 'revoke', p: audInvite.pub, o: owner.pub, g: await owner.sign(`rev.${audInvite.pub}`),
  }))
  ok(a.server.closeCode === 1008 && a.server.closeReason === 'revoked', 'a socket admitted on the old invite is closed')
  const again = await connect(room, NAME, await audQuery(viewerB))
  ok(again.status === 403, 'and the old invite admits nobody hereafter')
  void state
}

finish('test-relay-broadcast')
