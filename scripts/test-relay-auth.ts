#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync relay authorization rig.
//
//   node scripts/test-relay-auth.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. `w`-rooms exist so that read-only means read-only: the room
// name commits to the owner pubkey and the relay drops writes it cannot verify.
// That held for STORAGE and only for storage. Two holes followed from it, and
// both are the same mistake — treating the READ capability as if it granted
// writes, because every copy of a file carries it:
//
//   1. Fan-out was unauthenticated. A frame without `p:1` was forwarded to
//      every live peer without a signature check, so a read-only copy (which
//      holds `collab.key`, hence the room token) could encrypt an op batch —
//      or a whole-document `t:'snap'` — and push it into every open editor.
//      Legitimate writers then persisted the injected content over their own
//      signed stream. For the public guestbook, whose key is public BY DESIGN,
//      that was unauthenticated write access to every live viewer.
//   2. Blob PUT was authorized by the room token alone, so the same copy could
//      fill the room's 256 MB blob quota and squat the content-addressed keys
//      real assets were about to land on.
//
// A blind relay cannot fix (1) by itself: an op batch and a presence beat are
// both opaque {i,d}, so it cannot refuse to forward one without silencing
// read-only viewers. What it CAN do is stamp what it verified — `q` on a frame
// it persisted, an echoed `g` on a signed frame it fanned out — and never stamp
// anything else. The client half (online.ts `vouched`) refuses content-bearing
// frames that carry no stamp. This rig pins the relay half.
//
// It drives the real Durable Object class against fake storage/sockets (the
// harness in scripts/lib/relay-harness.ts, shared with the broadcast rig), so the
// assertions are about worker.js's actual control flow. Everything here fails
// against the pre-fix relay except the cases marked as regression guards.


import {
  mkState, mkSocket, Room, mintKeys, chainQuery, connect as hconnect, prove as hprove,
  TOK, IV, CT, parse, ok, finish, b64u, type Sock,
} from './lib/relay-harness.ts'

const owner = await mintKeys()
const stranger = await mintKeys() // a key the room does NOT commit to
void chainQuery

// The harness's connect/prove take the room name; every room here is the owner's.
const connect = (room: InstanceType<typeof Room>, query: string) => hconnect(room, owner.room, query)
const prove = (
  room: InstanceType<typeof Room>,
  c: { server: Sock; ready?: Record<string, unknown> },
  signer: { sign(text: string): Promise<string> },
  opts: { wrongRoom?: boolean } = {},
) => hprove(room, c, signer, opts.wrongRoom ? 'wSOMEOTHERROOM' : owner.room)
const authz = async (room: InstanceType<typeof Room>, tok: string, put?: { size: number; bkey: string }) =>
  (await room.fetch({
    url: `https://do/authz?tok=${tok}` + (put ? `&size=${put.size}&bkey=${put.bkey}` : ''),
    method: 'GET',
    headers: { get: () => null },
  })).status
// ---------------------------------------------------------------------------
// Fan-out authentication (hole 1)
// ---------------------------------------------------------------------------
{
  console.log('signed-room fan-out stamps only what the relay verified…')
  const state = mkState()
  const room = new Room(state, {})
  await state.storage.put('name', owner.room)
  await state.storage.put('tok', TOK)

  const writer = mkSocket({ count: 0, windowStart: Date.now(), signed: true, w: owner.pub })
  const reader = mkSocket({ count: 0, windowStart: Date.now(), signed: true, w: null })
  const peer = mkSocket({ count: 0, windowStart: Date.now(), signed: true, w: null })
  state.sockets.push(writer, reader, peer)

  const g = await owner.sign(`${IV}.${CT}`)

  await room.onMessage(writer, JSON.stringify({ i: IV, d: CT, g }))
  ok(peer.sent.length === 1, 'a signed ephemeral frame reaches peers')
  ok(parse(peer.sent[0]).g === g, 'the verified signature is echoed to peers')

  peer.sent.length = 0
  await room.onMessage(reader, JSON.stringify({ i: IV, d: CT }))
  ok(peer.sent.length === 1, 'a reader’s unsigned frame still fans out (presence must work)')
  const seen = parse(peer.sent[0])
  ok(seen.g === undefined && seen.q === undefined, 'nothing vouches for it — no q, no g')

  peer.sent.length = 0
  await room.onMessage(reader, JSON.stringify({ i: IV, d: CT, g: 'bm90YXNpZ25hdHVyZQ' }))
  ok(peer.sent.length === 0, 'a forged signature drops the frame instead of riding along')

  peer.sent.length = 0
  await room.onMessage(writer, JSON.stringify({ i: IV, d: CT, g: await owner.sign('some.other.frame') }))
  ok(peer.sent.length === 0, 'a signature over other bytes drops the frame')

  peer.sent.length = 0
  await room.onMessage(writer, JSON.stringify({ i: IV, d: CT, g: await stranger.sign(`${IV}.${CT}`) }))
  ok(peer.sent.length === 0, 'a signature from a key this socket did not certify drops the frame')

  // storage-side enforcement, unchanged — the regression guard for the old fix
  peer.sent.length = 0
  await room.onMessage(reader, JSON.stringify({ p: 1, i: IV, d: CT }))
  ok(peer.sent.length === 0 && (await state.storage.get('seq')) === undefined, 'an unsigned op batch is still dropped')

  peer.sent.length = 0
  await room.onMessage(writer, JSON.stringify({ p: 1, i: IV, d: CT, g }))
  const persisted = parse(peer.sent[0] ?? '{}')
  ok((await state.storage.get('seq')) === 1, 'a signed op batch persists')
  ok(persisted.q === 1 && persisted.g === g, 'a persisted frame carries both stamps')
}

{
  console.log('legacy r-rooms stay permissive…')
  const state = mkState()
  const room = new Room(state, {})
  await state.storage.put('name', 'r' + b64u.enc(new Uint8Array([1, 2, 3])))
  const a = mkSocket({ count: 0, windowStart: Date.now(), signed: false, w: null })
  const peer = mkSocket({ count: 0, windowStart: Date.now(), signed: false, w: null })
  state.sockets.push(a, peer)

  await room.onMessage(a, JSON.stringify({ i: IV, d: CT, g: 'bm90YXNpZ25hdHVyZQ' }))
  ok(peer.sent.length === 1, 'an r-room fans out unverifiable frames as it always did')
  ok(parse(peer.sent[0]).g === undefined, 'but never stamps one it could not verify')
}

// ---------------------------------------------------------------------------
// Blob write ticket (hole 2)
// ---------------------------------------------------------------------------

/** the call the blob route makes into the DO: reads omit size/bkey */
// ---------------------------------------------------------------------------
// The write ticket: hash-match certifies, only PROOF issues (review §2.1)
// ---------------------------------------------------------------------------
{
  console.log('the write ticket goes only to sockets that PROVE the key…')
  const state = mkState()
  const room = new Room(state, {})

  const r = await connect(room, '')
  ok(r.status === 101 && !!r.ready, 'a reader connects')
  ok(r.ready!.c === undefined, 'a reader is not challenged')
  ok(r.ready!.wt === undefined, 'a reader is issued no write ticket on ready')

  // THE ATTACK THE RECOVERED CODE MISSED. The owner's public key is in every
  // copy of the file — reader copies too — so a reader can present it as ?w=
  // and hash-match the room. Before this change that socket was handed the
  // write ticket on `ready`; the original rig's "certified writer" check was
  // exactly this socket, and it passed.
  const imp = await connect(room, `&bt=1&w=${owner.pub}`)
  ok(imp.status === 101, 'a reader presenting the owner’s PUBLIC key still connects (the op channel verifies per frame)')
  ok(imp.ready!.wt === undefined, 'but is issued NO ticket on ready')
  ok(typeof imp.ready!.c === 'string', 'it is challenged instead')
  ok((await state.storage.get('wtReq')) === undefined, 'and its bt=1 did not latch the room')
  ok((await state.storage.get('wt')) === undefined, 'no ticket has even been minted yet')

  // it cannot answer the challenge: it has the public key only
  const forged = await prove(room, imp, stranger)
  ok(forged === null, 'a signature from a key that is not the private half earns nothing')
  ok((await state.storage.get('wtReq')) === undefined, 'and still does not latch')
  // and the nonce is consumed — a second attempt with the RIGHT key is refused
  ok(await prove(room, imp, owner) === null, 'the nonce is single-use: a later correct answer on a spent nonce earns nothing')

  const w = await connect(room, `&bt=1&w=${owner.pub}`)
  ok(w.ready!.wt === undefined, 'a real writer is not handed the ticket on ready either')
  const ticket = await prove(room, w, owner)
  ok(typeof ticket === 'string', 'a real writer that proves the key is handed one on its own wt frame')
  ok(ticket === (await state.storage.get('wt')), 'and it is the room’s ticket')
  ok((await state.storage.get('wtReq')) === 1, 'a PROVEN bt=1 writer latches the room')

  // the signed text binds the room name, so a proof for another room is void
  const w2 = await connect(room, `&bt=1&w=${owner.pub}`)
  ok(await prove(room, w2, owner, { wrongRoom: true }) === null, 'a proof signed for a different room name is refused')
}

// ---------------------------------------------------------------------------
// Blob writes behind the ticket, and the latch (review §2.4)
// ---------------------------------------------------------------------------
{
  console.log('blob writes need the ticket once a PROVEN ticket-capable writer has joined…')
  const state = mkState()
  const room = new Room(state, {})

  // Pre-latch: exactly the pre-fix behaviour, which is what makes this relay
  // safe to deploy ahead of the clients — every shipped client PUTs with the
  // room token and has never heard of a ticket.
  const old = await connect(room, `&w=${owner.pub}`) // an older writer: no bt=1
  await prove(room, old, owner)
  ok(await authz(room, TOK, { size: 1000, bkey: 'k1' }) === 200, 'an older client still uploads with the room token')
  ok((await state.storage.get('wtReq')) === undefined, 'a proven writer WITHOUT bt=1 does not latch the room')

  const w = await connect(room, `&bt=1&w=${owner.pub}`)
  const ticket = (await prove(room, w, owner)) as string
  ok(await authz(room, TOK, { size: 1000, bkey: 'k2' }) === 403, 'the room token no longer authorizes an upload')
  ok(await authz(room, ticket, { size: 1000, bkey: 'k2' }) === 200, 'the write ticket does')
  ok(await authz(room, TOK) === 200, 'reads still take the room token — viewers see the assets')
  ok(await authz(room, 'wrongtokenwrong') === 403, 'a stranger gets neither')

  // quota accounting must follow the credential that was accepted, not a
  // second unmetered path
  ok((await state.storage.get('blobBytes')) === 1000 + 1000, 'accepted uploads are metered once each')
}

// ---------------------------------------------------------------------------
// Revocation re-mints the ticket, to PROVEN sockets only (review §2.6)
// ---------------------------------------------------------------------------
{
  console.log('revocation re-mints the ticket…')
  const state = mkState()
  const room = new Room(state, {})
  const member = await mintKeys()

  const w = await connect(room, `&bt=1&w=${owner.pub}`)
  const stale = (await prove(room, w, owner)) as string
  const ownerSock = w.server
  const memberSock = mkSocket({ count: 0, windowStart: Date.now(), signed: true, w: member.pub, proven: true })
  const readerSock = mkSocket({ count: 0, windowStart: Date.now(), signed: true, w: null })
  // a reader that presented the owner's public key: certified (pinned w), NOT proven
  const impSock = mkSocket({ count: 0, windowStart: Date.now(), signed: true, w: owner.pub, proven: false })
  state.sockets.push(memberSock, readerSock, impSock)
  ownerSock.sent.length = 0

  await room.onMessage(ownerSock, JSON.stringify({
    ctl: 'revoke', p: member.pub, o: owner.pub, g: await owner.sign(`rev.${member.pub}`),
  }))

  const fresh = (await state.storage.get('wt')) as string
  ok(fresh !== stale, 'the ticket the removed member holds is replaced')
  ok(await authz(room, stale, { size: 10, bkey: 'k9' }) === 403, 'the stale ticket buys nothing')
  ok(memberSock.closed, 'the removed member’s socket is closed')
  ok(parse(memberSock.sent[0]).wt === undefined, 'and is not handed the replacement')
  ok(parse(readerSock.sent[0]).wt === undefined, 'readers are not handed a write capability either')
  ok(parse(impSock.sent[0]).wt === undefined, 'a CERTIFIED-but-unproven socket (reader with the owner’s pubkey) is not handed one')
  ok(parse(ownerSock.sent[0]).wt === fresh, 'still-proven writers get the replacement without reconnecting')
}

// ---------------------------------------------------------------------------
// Snapshot q is clamped to the room's seq (review §2.2)
// ---------------------------------------------------------------------------
{
  console.log('a snapshot cannot claim to cover ops the room has not seen…')
  const state = mkState()
  const room = new Room(state, {})
  const w = await connect(room, `&w=${owner.pub}`)
  const sock = w.server

  // three real persisted ops
  for (let n = 0; n < 3; n++) {
    const i = IV + n, d = CT + n
    await room.onMessage(sock, JSON.stringify({ p: 1, i, d, g: await owner.sign(`${i}.${d}`) }))
  }
  ok((await state.storage.get('seq')) === 3, 'three ops persisted')
  const opsBefore = (await state.storage.list({ start: 'op:', end: 'op;' })).size
  sock.sent.length = 0

  // a snapshot claiming q far beyond seq — with a valid signature, from a
  // real writer: the trust the writer has is to EDIT, not to wipe the log
  const si = IV + 'snap', sd = CT + 'snap'
  await room.onMessage(sock, JSON.stringify({ snap: 1, q: 1_000_000, k: 'k-snap', i: si, d: sd, g: await owner.sign(`${si}.${sd}`) }))
  const refusal = sock.sent.map(parse).find((f) => f.ctl === 'refused')
  ok(refusal?.code === 'snap-ahead', 'it is refused with a CODE, not silently dropped')
  ok(refusal?.k === 'k-snap', 'and the refusal names the frame')
  ok((await state.storage.get('snap')) === undefined, 'no snapshot was stored')
  ok((await state.storage.list({ start: 'op:', end: 'op;' })).size === opsBefore, 'and no op was pruned')

  // a snapshot at exactly seq is fine and prunes what it covers
  sock.sent.length = 0
  await room.onMessage(sock, JSON.stringify({ snap: 1, q: 3, i: si, d: sd, g: await owner.sign(`${si}.${sd}`) }))
  ok((await state.storage.get('snap'))?.q === 3, 'a snapshot at seq is accepted')
  ok((await state.storage.list({ start: 'op:', end: 'op;' })).size === 0, 'and the ops it covers are pruned')
}


finish('test-relay-auth')
