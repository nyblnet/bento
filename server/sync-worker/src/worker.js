// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync relay — the first (and only) Bento server code. One Durable
// Object per docId room. The relay is BLIND by design:
//
//   - every frame body is AES-GCM ciphertext produced by the clients; the
//     room key lives in the document file and never reaches this server
//   - auth is possession-proof: ?tok= is a hash of the room key. The first
//     client to open a room sets its token; everyone else must match it
//   - persisted state is an append-only list of encrypted op frames plus
//     the latest client-produced encrypted snapshot (the server cannot make
//     one — it can't read anything)
//   - rooms expire after ~30 idle days (the FILE is the durable artifact;
//     expiry costs convenience, never data)
//
// Envelope (JSON text frames, ≤ MAX_FRAME):
//   client → server:  { k? }               OPTIONAL client frame id, emitted FIRST
//                                         so it is recoverable from an oversize
//                                         frame without parsing; echoed on refusal
//                     { i, d }            ephemeral (presence, hello, need)
//                     { p:1, i, d }       persist an op batch
//                     { snap:1, q, i, d } encrypted snapshot covering seq ≤ q
//   server → clients: same frames fanned out, ops stamped with { q: seq } and
//                     signed frames re-stamped with the { g } this relay
//                     VERIFIED (never one it didn't — that stamp is what tells
//                     a peer the sender was allowed to write);
//                     on join: snapshot (if any) + ops since ?since= then
//                     { ctl:'ready', q: latest, wt? } — wt is the blob write
//                     ticket, issued only to certified writer sockets

const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000
// The binding constraint is DURABLE OBJECT STORAGE, not the WebSocket message
// size. The platform raised WS messages to 32 MiB (2025-10-31), but a single
// stored value still caps around 2 MB — measured against workerd: 2 MB stores,
// 2.5 MB throws inside storage.put(). So a frame larger than the storage limit
// is worse than useless: it passes every check, then disappears.
//
// 1.9 MB keeps "accepted" and "storable" the same thing, and still nearly
// doubles the old 1 MB. An asset costs ~1.78x its binary size on the wire
// (base64 twice — data URI, then the ciphertext), so this carries roughly
// 1.05 MB of binary — photos, not video.
//
// MEDIA_EMBED_BUDGET is 8 MB, so media collaboration is NOT fixed by this
// constant and cannot be: it needs chunked ops or content-addressed blobs
// (docs/relay-design.md, "Wire efficiency").
const MAX_FRAME = 1_900_000
const RATE_BURST = 200 // frames per window per socket
const RATE_WINDOW_MS = 10_000
// Bytes a single socket may persist per window. Frame COUNT alone is not a
// budget when a single frame can approach 2 MB.
const RATE_BYTES = 8 * 1024 * 1024
// Hard ceiling on persisted bytes per room (ops + snapshot). Bounds the cost
// of any one room regardless of frame size — the actual protection against an
// unbounded bill, since room creation is unauthenticated by design.
const ROOM_BYTE_CAP = 96 * 1024 * 1024
// Ceiling for one uploaded blob. Clients chunk above this: WebCrypto has NO
// streaming AES-GCM (one-shot only) and a round trip costs ~5x the payload in
// memory, so a browser encrypting a 64MB asset in one call would need ~320MB.
// Chunking is a MEMORY requirement, not just resumability.
const MAX_BLOB = 8 * 1024 * 1024
// Total blob bytes one room may hold. Frames have ROOM_BYTE_CAP; without the
// equivalent here, blob storage is an unmetered write endpoint behind nothing
// but a trust-on-first-use token — the same unbounded-bill shape we closed for
// frames. Counted in the DO, which is the only component that knows the room.
const ROOM_BLOB_CAP = 256 * 1024 * 1024
const BKEY = (k) => `b:${k}`
const OP_KEY = (seq) => `op:${String(seq).padStart(10, '0')}`

/** Tell the sender why a frame was refused, ECHOING its client-supplied id
 *  (`k`) so the sender knows exactly WHICH frame died. Without the echo a
 *  client has to infer it from ack ordering and the reported size — workable
 *  but inferential, and guessing wrong means dropping the wrong op from the
 *  resend log, i.e. silent permanent divergence.
 *
 *  Clients MUST stop re-queueing an op refused as 'too-large' / 'room-full' /
 *  'storage-failed'; silently dropping is what turned an oversize asset into a
 *  permanent resend loop. 'rate-limited' is transient — retry it. */
function refuse(ws, code, detail) {
  try { ws.send(JSON.stringify({ ctl: 'refused', code, ...detail })) } catch { /* gone */ }
}

/** Recover a frame id from a RAW frame without parsing it. The size check
 *  deliberately runs before JSON.parse — parsing an attacker-supplied 32 MB
 *  string is itself a CPU abuse vector — so for oversize frames this bounded
 *  regex over the head is the only way to name the frame. Clients emit "k"
 *  first for exactly this reason. Absent/!matching = undefined, and the client
 *  falls back to its own heuristic. */
const rawFrameId = (raw) =>
  raw.slice(0, 160).match(/"k"\s*:\s*"([A-Za-z0-9_-]{1,32})"/)?.[1]

// --- signed writes (see docs/collab-design.md) ------------------------------
// A room whose name starts with 'w' is SIGNED: the name commits to an ECDSA
// P-256 writer pubkey ('w' + base64url(SHA-256(pubRaw))). Clients present the
// raw pubkey as ?w=; the relay pins it (commitment-checked, so a viewer can't
// substitute their own) and thereafter requires a valid signature `g` over
// `${i}.${d}` on every persisted frame (op batch / snapshot). Viewers hold the
// pubkey but not the private half — their writes are dropped, so read-only is
// ENFORCED here while the relay stays blind to content. 'r' rooms are legacy
// and stay permissive.
//
// Blindness has a cost the enforcement above does not cover: the relay cannot
// tell an op batch from a presence beat, because both are opaque {i,d}. So it
// cannot refuse to FAN OUT a reader's frame — a read-only copy holds the room
// key and can encrypt anything. What the relay can do is say what it checked:
// `q` on a frame it persisted (signature-verified before storage) and the
// echoed `g` on a signed frame it fanned out. A client refuses content-bearing
// frames (op batches, whole-document fork snapshots) that carry neither, so
// read-only holds for live peers too and not merely for the stored log.
const b64uDec = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}
const b64uEnc = (bytes) => {
  let s = ''
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const EC_VERIFY = { name: 'ECDSA', namedCurve: 'P-256' }
const SIG_ALG = { name: 'ECDSA', hash: 'SHA-256' }
async function sha256b64u(bytes) {
  return b64uEnc(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

/** CORS for the blob routes. A PUT with a content-type is not a "simple"
 *  request, so browsers preflight it — OPTIONS must answer before any upload
 *  can start. max-age keeps the preflight off the hot path for repeat uploads. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    // --- encrypted asset blobs (docs/blob-offload.md) ----------------------
    // Assets are too big for the op log: a DO storage value caps near 2MB, so
    // an 8MB video can never travel as an op. They go here instead, and the op
    // carries only a reference. The relay pipes ciphertext straight through —
    // it never buffers a blob (verified: 32MB streams with no memory growth)
    // and cannot read one. Keys are opaque to us: the client derives them as
    // HMAC(roomKey, sha256(plaintext)), so the same image in two rooms yields
    // different keys and nothing correlates.
    const b = url.pathname.match(/^\/b\/([A-Za-z0-9._-]{1,80})\/([A-Za-z0-9_-]{16,64})$/)
    if (b) {
      // A .bento.html runs from file:// or from ANY origin someone serves it
      // on, so blob fetches are always cross-origin and need CORS — without it
      // the browser rejects them before the request is even sent, and the
      // offload silently never happens. (WebSockets aren't subject to CORS,
      // which is why live sync worked while only blobs failed.)
      // Allowing any origin is safe here: the token is the capability, the
      // bytes are ciphertext, and there are no cookies or credentials to ride
      // along on a fetch the relay never treats as authenticated by origin.
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
      const res = await blob(req, env, b[1], b[2])
      const h = new Headers(res.headers)
      for (const [k, v] of Object.entries(CORS)) h.set(k, v)
      return new Response(res.body, { status: res.status, headers: h })
    }

    const m = url.pathname.match(/^\/d\/([A-Za-z0-9._-]{1,80})$/)
    if (!m) {
      return new Response('bento-sync relay — see https://bento.page', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    }
    const id = env.ROOM.idFromName(m[1])
    // Surface DO failures as a readable body instead of an opaque CF 1101
    // ("Worker threw exception") — the room path needs the SQLite storage
    // backend, so a mis-provisioned migration shows up right here.
    try {
      return await env.ROOM.get(id).fetch(req)
    } catch (e) {
      return new Response('room error: ' + (e && e.stack ? e.stack : String(e)), {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    }
  },
}

/** Blob store: PUT to upload, GET to fetch, HEAD to test existence (which is
 *  how a client skips re-uploading an asset a peer already sent — content
 *  addressing means an identical asset has an identical key).
 *
 *  READS take the room token, same possession proof as the socket. That is
 *  deliberately no stronger than the room itself: anyone who can read the
 *  room's frames can already read its assets, and the bytes are ciphertext
 *  either way.
 *
 *  WRITES take the room's write ticket instead (Room.writeTicket) — the token
 *  is the READ capability, and authorizing an upload with it let a read-only
 *  copy burn the room's ROOM_BLOB_CAP. Same field, so the wire is unchanged:
 *  the DO decides which credential a request satisfied.
 *
 *  R2 is OPTIONAL. Without the binding these routes answer 501 and clients
 *  keep inlining small assets, so a self-hoster who hasn't set up a bucket
 *  still has a working relay. */
async function blob(req, env, room, key) {
  if (!env.BLOBS) {
    return new Response('blob storage not configured on this relay', { status: 501 })
  }
  const tok = new URL(req.url).searchParams.get('tok') || ''
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(tok)) return new Response('bad token', { status: 400 })
  // The DO owns the room's token; ask it rather than duplicating the check.
  const idc = env.ROOM.idFromName(room)
  const authzUrl = (extra = '') => `https://do/authz?tok=${encodeURIComponent(tok)}${extra}`

  const path = `${room}/${key}`
  // reads: token only
  if (req.method !== 'PUT') {
    const ok = await env.ROOM.get(idc).fetch(new Request(authzUrl()))
    if (ok.status !== 200) return new Response('forbidden', { status: 403 })
  }
  if (req.method === 'HEAD') {
    const head = await env.BLOBS.head(path)
    return new Response(null, { status: head ? 200 : 404, headers: head ? { 'content-length': String(head.size) } : {} })
  }
  if (req.method === 'GET') {
    const obj = await env.BLOBS.get(path)
    if (!obj) return new Response('not found', { status: 404 })
    // streamed, never materialised in the worker
    return new Response(obj.body, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' },
    })
  }
  if (req.method === 'PUT') {
    const len = parseInt(req.headers.get('content-length') || '0', 10)
    if (!len || len > MAX_BLOB) {
      return new Response(JSON.stringify({ error: 'too-large', max: MAX_BLOB, got: len }), {
        status: 413, headers: { 'content-type': 'application/json' },
      })
    }
    // Reserve quota BEFORE writing — the DO checks the token and meters in one
    // call, so a full room cannot be filled further even by a valid writer.
    const res0 = await env.ROOM.get(idc).fetch(
      new Request(authzUrl(`&size=${len}&bkey=${encodeURIComponent(key)}`)),
    )
    if (res0.status === 403) return new Response('forbidden', { status: 403 })
    if (res0.status === 507) {
      return new Response(await res0.text(), { status: 507, headers: { 'content-type': 'application/json' } })
    }
    if (res0.status !== 200) return new Response('room error', { status: 500 })
    // Content-addressed, so an existing key is the same bytes — skip the write
    // and let the client move on. This is the dedupe path.
    const existing = await env.BLOBS.head(path)
    if (existing) return new Response(JSON.stringify({ deduped: true, size: existing.size }), { headers: { 'content-type': 'application/json' } })
    await env.BLOBS.put(path, req.body, {
      httpMetadata: { cacheControl: 'private, max-age=31536000, immutable' },
    })
    return new Response(JSON.stringify({ stored: len }), { headers: { 'content-type': 'application/json' } })
  }
  return new Response('method not allowed', { status: 405 })
}

export class Room {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.verifyKey = null // imported writer pubkey, cached for this wake
    // Keepalive: auto-reply "pong" to a client "ping" WITHOUT waking the DO, so
    // idle connections aren't reaped by edge/proxy idle timeouts — the usual
    // cause of "connects and drops" on hibernated WebSockets. Costs no active
    // duration; retained across hibernation. Set here so every wake re-applies it.
    try {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    } catch { /* older runtime without auto-response — clients still reconnect */ }
  }

  /** Valid writer signature over `${i}.${d}` for a signed room? */
  /** Import-and-cache a raw P-256 pubkey (b64url) for this wake. */
  async pubKey(pubB64) {
    this.keyCache ??= new Map()
    let k = this.keyCache.get(pubB64)
    if (!k) {
      k = await crypto.subtle.importKey('raw', b64uDec(pubB64), EC_VERIFY, false, ['verify'])
      this.keyCache.set(pubB64, k)
    }
    return k
  }

  async verifyWith(pubB64, sigB64, text) {
    try {
      return await crypto.subtle.verify(
        SIG_ALG, await this.pubKey(pubB64), b64uDec(sigB64), new TextEncoder().encode(text),
      )
    } catch { return false }
  }

  /** Frame signature against THIS SOCKET's certified key (v1.0.3: the verify
   *  key is per-socket — owner, legacy shared writer, or a chain-certified
   *  member all pin their own key at connect). */
  async verifySig(f, ws) {
    if (typeof f.g !== 'string') return false
    const meta = ws.deserializeAttachment() || {}
    if (!meta.w) return false
    return this.verifyWith(meta.w, f.g, `${f.i}.${f.d}`)
  }

  /** The room's blob WRITE ticket — a capability handed out over the socket,
   *  and only to a socket whose writer key this room certified. Blob PUTs are
   *  otherwise authorized by the room token alone, which every copy carries
   *  including read-only ones, so a viewer could fill the room's ROOM_BLOB_CAP
   *  and squat the content-addressed keys real assets will land on.
   *
   *  Minted lazily and stable thereafter; a revocation re-mints it, because a
   *  removed member's held ticket would otherwise outlive their access. */
  async writeTicket() {
    let t = await this.state.storage.get('wt')
    if (!t) {
      const b = new Uint8Array(24)
      crypto.getRandomValues(b)
      t = b64uEnc(b) // 32 chars — inside the blob route's token charset/length
      await this.state.storage.put('wt', t)
    }
    return t
  }

  async fetch(req) {
    // Token check for the blob routes — the DO is the only holder of the
    // room's token, so blob auth asks it rather than duplicating the rule.
    // Never CREATES a room: an unknown room 403s instead of claiming a token,
    // otherwise blob PUTs would become a way to squat room names.
    const u0 = new URL(req.url)
    if (u0.pathname === '/authz') {
      const saved = await this.state.storage.get('tok')
      const given = u0.searchParams.get('tok') || ''
      const ticket = await this.state.storage.get('wt')
      const byTok = saved !== undefined && saved === given
      const byTicket = !!ticket && given === ticket
      if (!byTok && !byTicket) return new Response(null, { status: 403 })
      // Blob accounting rides on the same call the blob route already makes.
      // `size` present = a PUT asking to reserve quota; absent = a read.
      const size = parseInt(u0.searchParams.get('size') || '0', 10) || 0
      const bkey = u0.searchParams.get('bkey') || ''
      if (!size || !bkey) return new Response(null, { status: 200 })
      // A WRITE needs the write ticket — but only once this room has actually
      // seen a ticket-capable writer (?bt=1). Shipped clients PUT with the room
      // token and know nothing about tickets, so without that latch this relay
      // could not be deployed ahead of them: every existing file's asset
      // offload would start 403ing the moment it went live.
      if (!byTicket && (await this.state.storage.get('wtReq'))) {
        return new Response(null, { status: 403 })
      }
      // Already counted? Then this is a re-upload of identical content
      // (content-addressed keys) — admit it without double-charging.
      if (await this.state.storage.get(BKEY(bkey))) {
        return new Response(JSON.stringify({ deduped: true }), { status: 200 })
      }
      const used = (await this.state.storage.get('blobBytes')) || 0
      if (used + size > ROOM_BLOB_CAP) {
        return new Response(JSON.stringify({ error: 'room-blobs-full', cap: ROOM_BLOB_CAP, used }), {
          status: 507, headers: { 'content-type': 'application/json' },
        })
      }
      await this.state.storage.put(BKEY(bkey), size)
      await this.state.storage.put('blobBytes', used + size)
      // touch the expiry clock: blobs keep a room alive the same way ops do
      await this.state.storage.setAlarm(Date.now() + IDLE_TTL_MS)
      return new Response(JSON.stringify({ reserved: size }), { status: 200 })
    }
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const url = new URL(req.url)
    const tok = url.searchParams.get('tok') || ''
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(tok)) return new Response('bad token', { status: 400 })
    const saved = await this.state.storage.get('tok')
    if (saved === undefined) await this.state.storage.put('tok', tok)
    else if (saved !== tok) return new Response('forbidden', { status: 403 })

    // Signed rooms: the room name commits to a pubkey (v1.0.2: the shared
    // writer key; v1.0.3: the OWNER key). A writer socket presents ?w= (the key
    // it will sign frames with) and proves it either DIRECTLY (hash matches the
    // commitment — owner / legacy shared writer) or via a CHAIN (member: the
    // owner-signed invite + the invite-signed delegation of the member key).
    // The verified key is pinned PER SOCKET; no ?w= at all = read-only socket.
    const name = url.pathname.match(/^\/d\/([A-Za-z0-9._-]{1,80})$/)?.[1] || ''
    if ((await this.state.storage.get('name')) === undefined) await this.state.storage.put('name', name)
    const signed = name[0] === 'w'
    let sockW = null
    if (signed) {
      const w = url.searchParams.get('w') || ''
      if (w) {
        if (!/^[A-Za-z0-9_-]{80,200}$/.test(w)) return new Response('bad writer key', { status: 400 })
        const rev = (await this.state.storage.get('rev')) || []
        let ok = 'w' + (await sha256b64u(b64uDec(w))) === name
        if (!ok) {
          // chain: o (owner pub) must match the commitment; ivs = owner's sig
          // over the invite; dg = invite's sig over this member key. Expired or
          // revoked links (member key OR invite key) are refused.
          const o = url.searchParams.get('o') || ''
          const ivp = url.searchParams.get('ivp') || ''
          const ivr = url.searchParams.get('ivr') || ''
          const ive = parseInt(url.searchParams.get('ive') || '0', 10) || 0
          const ivs = url.searchParams.get('ivs') || ''
          const dg = url.searchParams.get('dg') || ''
          ok = !!(o && ivp && ivs && dg)
            && ivr === 'writer'
            && (!ive || Date.now() < ive)
            && !rev.includes(ivp)
            && 'w' + (await sha256b64u(b64uDec(o))) === name
            && (await this.verifyWith(o, ivs, `inv.${ivp}.${ivr}.${ive}`))
            && (await this.verifyWith(ivp, dg, `dlg.${w}`))
        }
        if (!ok || rev.includes(w)) return new Response('forbidden', { status: 403 })
        sockW = w
      }
    }

    const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0)
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // WebSocket Hibernation: the runtime owns the socket, so the Durable Object
    // can be evicted from memory while connections stay open — it accrues no
    // active duration while idle. This is what keeps a live relay within the DO
    // free-tier duration limit (plain server.accept() keeps the invocation
    // running for the whole connection and throws "Exceeded allowed duration").
    // Per-socket rate-limit state rides on the socket's serialized attachment
    // (in-memory Maps don't survive hibernation).
    this.state.acceptWebSocket(server)

    // CERTIFIED IS NOT PROVEN. The direct path above accepts a socket whose
    // `?w=` hash-matches the room name — and that key is the owner's PUBLIC
    // key, which every copy of the file carries, read-only copies included. A
    // hash-match therefore says "this socket knows the owner's public key",
    // which every reader does. It does NOT say the socket holds the private
    // half. The op channel never needed it to: every persisted frame carries
    // its own signature and is verified against `w` before storage, so a
    // reader presenting `?w=` can be certified all day and still write nothing.
    //
    // The blob write TICKET is different. It is a bearer capability issued over
    // the socket, and issuing it on the hash-match alone handed it to any reader
    // — who could then fill ROOM_BLOB_CAP, squat content-addressed keys, and
    // (via `bt=1`) latch the room so every older client's upload 403s. So the
    // ticket, and the latch, wait for PROOF: `ready` carries a per-socket nonce,
    // the client signs `prove.<nonce>.<name>` with the private key, and only a
    // socket that answers is marked `proven` and handed a ticket (on its own
    // `wt` frame). The chain path is proof already (`dg` needs the invite's
    // private key) but is challenged the same way — one rule, no exceptions.
    let nonce = null
    let wantsTicket = false
    if (sockW) {
      const b = new Uint8Array(16)
      crypto.getRandomValues(b)
      nonce = b64uEnc(b)
      wantsTicket = url.searchParams.get('bt') === '1'
    }
    server.serializeAttachment({
      count: 0, windowStart: Date.now(), signed, w: sockW,
      nonce, bt: wantsTicket, proven: false,
    })
    await this.replay(server, since, nonce)
    await this.state.storage.setAlarm(Date.now() + IDLE_TTL_MS)
    return new Response(null, { status: 101, webSocket: client })
  }

  // --- hibernation handlers (fire on wake; replace addEventListener) ---------
  async webSocketMessage(ws, data) {
    await this.onMessage(ws, data).catch(() => {})
  }
  webSocketClose(ws) {
    try { ws.close() } catch { /* already closed */ }
  }
  webSocketError() { /* the runtime drops the socket; nothing to clean up */ }

  /** `nonce` is the possession challenge for a certified socket — sent on
   *  `ready` as `c`; the ticket itself never rides here (see `prove`). */
  async replay(ws, since, nonce = null) {
    const seq = (await this.state.storage.get('seq')) || 0
    const snap = await this.state.storage.get('snap')
    let from = since
    try {
      if (snap && (since === 0 || snap.q >= since)) {
        ws.send(JSON.stringify({ snap: 1, q: snap.q, i: snap.i, d: snap.d }))
        from = snap.q
      }
      if (seq > from) {
        const ops = await this.state.storage.list({
          start: OP_KEY(from + 1),
          end: OP_KEY(seq + 1),
        })
        for (const [key, f] of ops) {
          ws.send(JSON.stringify({ q: parseInt(key.slice(3), 10), i: f.i, d: f.d }))
        }
      }
      ws.send(JSON.stringify(nonce ? { ctl: 'ready', q: seq, c: nonce } : { ctl: 'ready', q: seq }))
    } catch {
      /* socket died mid-replay */
    }
  }

  async onMessage(ws, data) {
    if (typeof data !== 'string') return
    // Oversize is REFUSED, not dropped: a silent drop leaves the sender with no
    // ack, the peer permanently behind, and the need/vv catch-up re-sending the
    // same doomed frame forever.
    if (data.length > MAX_FRAME) {
      return refuse(ws, 'too-large', { max: MAX_FRAME, got: data.length, k: rawFrameId(data) })
    }
    // keepalive fallback: if the runtime auto-response isn't active this reaches
    // us — reply "pong" so a pinging client never mistakes a live socket for dead.
    if (data === 'ping') { try { ws.send('pong') } catch { /* gone */ } return }
    // rate-limit window lives on the socket attachment (survives hibernation)
    const meta = ws.deserializeAttachment() || { count: 0, windowStart: Date.now(), bytes: 0 }
    const now = Date.now()
    if (now - meta.windowStart > RATE_WINDOW_MS) {
      meta.windowStart = now
      meta.count = 0
      meta.bytes = 0
    }
    meta.count++
    meta.bytes = (meta.bytes || 0) + data.length
    ws.serializeAttachment(meta)
    if (meta.count > RATE_BURST) return
    if (meta.bytes > RATE_BYTES) {
      return refuse(ws, 'rate-limited', { retryInMs: RATE_WINDOW_MS, k: rawFrameId(data) })
    }
    let f
    try {
      f = JSON.parse(data)
    } catch {
      return
    }
    // Possession proof (see the connect path for why a hash-match is not one).
    // A certified socket signs `prove.<nonce>.<name>` with the private half of
    // the key it presented; the name is in the text so the signature cannot be
    // replayed into another room, and the nonce is consumed on first use so it
    // cannot be replayed into this one. Only a proven socket is handed the
    // blob write ticket, and only a proven socket that asked (`bt=1`) latches
    // the room into requiring it.
    if (f.ctl === 'prove') {
      if (!meta.w || !meta.nonce || meta.proven || typeof f.g !== 'string') return
      const name = (await this.state.storage.get('name')) || ''
      const ok = await this.verifyWith(meta.w, f.g, `prove.${meta.nonce}.${name}`)
      // consumed either way — a wrong answer does not get a second try
      meta.nonce = null
      if (!ok) { ws.serializeAttachment(meta); return }
      meta.proven = true
      ws.serializeAttachment(meta)
      const ticket = await this.writeTicket()
      if (meta.bt && !(await this.state.storage.get('wtReq'))) {
        await this.state.storage.put('wtReq', 1)
      }
      try { ws.send(JSON.stringify({ ctl: 'wt', wt: ticket })) } catch { /* gone */ }
      return
    }
    // owner-signed revocation: cut off ONE member key (or a whole invite
    // lineage) without re-keying the room. Plaintext control frame — it names
    // only pubkeys, never content. Live sockets on the revoked key are closed.
    if (f.ctl === 'revoke' && typeof f.p === 'string' && typeof f.o === 'string' && typeof f.g === 'string') {
      const name = (await this.state.storage.get('name')) || ''
      if ('w' + (await sha256b64u(b64uDec(f.o))) !== name) return
      if (!(await this.verifyWith(f.o, f.g, `rev.${f.p}`))) return
      const rev = (await this.state.storage.get('rev')) || []
      if (!rev.includes(f.p)) await this.state.storage.put('rev', [...rev, f.p])
      // Closing the socket and refusing reconnects revokes the OP channel; the
      // blob write ticket is a bearer capability the removed member already
      // holds, so it has to be re-minted or removal leaks a write path. The
      // fresh one goes only to sockets that are still certified — sending it
      // in the note everyone gets would hand it to every reader in the room.
      await this.state.storage.delete('wt')
      const fresh = await this.writeTicket()
      const note = JSON.stringify({ ctl: 'revoked', p: f.p })
      const noteW = JSON.stringify({ ctl: 'revoked', p: f.p, wt: fresh })
      for (const peer of this.state.getWebSockets()) {
        const m = peer.deserializeAttachment() || {}
        if (m.w === f.p) {
          try { peer.send(note) } catch { /* gone */ }
          try { peer.close(1008, 'revoked') } catch { /* gone */ }
          continue
        }
        // PROVEN, not merely certified: a reader that presented the owner's
        // public key has a pinned `w` too, and must not receive the fresh ticket
        try { peer.send(m.proven ? noteW : note) } catch { /* gone */ }
      }
      return
    }
    if (typeof f.i !== 'string' || typeof f.d !== 'string') return
    // defense in depth: a revoked key's socket may outlive the close (or the
    // revocation may land on another wake) — its writes must still die here.
    if (meta.w && (f.p === 1 || f.snap === 1)) {
      const rev = (await this.state.storage.get('rev')) || []
      if (rev.includes(meta.w)) return
    }

    // Signed rooms: a persisted frame (op batch / snapshot) must carry a valid
    // writer signature, else DROP it — this is what enforces read-only. A
    // reader (no private key) can still send ephemeral frames (presence).
    //
    // A frame that merely fans out is verified too WHEN IT CLAIMS a signature:
    // the fork snapshot is ephemeral yet replaces a peer's whole document, so
    // it signs itself, and the echo below must never carry a `g` this relay
    // did not check — a stamp you don't verify is worse than no stamp.
    const claimed = typeof f.g === 'string'
    if (meta.signed && (f.p === 1 || f.snap === 1 || claimed)) {
      if (!(await this.verifySig(f, ws))) return
    }

    const out = { i: f.i, d: f.d }
    if (meta.signed && claimed) out.g = f.g
    const weight = (f.i?.length || 0) + (f.d?.length || 0)
    if (f.p === 1) {
      // Per-room storage ceiling. Room creation is unauthenticated by design
      // (the token is trust-on-first-use), so this — not the frame size — is
      // what bounds what one room can cost. Refuse loudly: a client that keeps
      // retrying into a full room is the resend loop all over again.
      const used = (await this.state.storage.get('bytes')) || 0
      if (used + weight > ROOM_BYTE_CAP) {
        return refuse(ws, 'room-full', { cap: ROOM_BYTE_CAP, used, k: f.k })
      }
      const seq = ((await this.state.storage.get('seq')) || 0) + 1
      // Storage can still refuse (platform value limits move); surface it
      // instead of letting webSocketMessage's catch swallow it into a frame
      // the sender believes was accepted.
      try {
        await this.state.storage.put(OP_KEY(seq), { i: f.i, d: f.d })
      } catch (e) {
        return refuse(ws, 'storage-failed', { bytes: weight, k: f.k, detail: String(e && e.message || e).slice(0, 120) })
      }
      await this.state.storage.put('seq', seq)
      await this.state.storage.put('bytes', used + weight)
      out.q = seq
      // the sender needs its ack too (snapshot cadence keys off q)
      try {
        ws.send(JSON.stringify({ ctl: 'ack', q: seq }))
      } catch {
        /* gone */
      }
    } else if (f.snap === 1 && typeof f.q === 'number') {
      // client-produced encrypted snapshot: keep the newest, prune covered ops.
      //
      // CLAMPED to the room's own seq. `q` is the client's claim of what the
      // snapshot covers, and the prune below deletes every op up to it — so a
      // snapshot claiming q = 10^9 would wipe the whole log with one frame and
      // leave every later joiner with a snapshot and no ops. A writer is
      // trusted to edit, not to destroy the log. Refused with a code, not
      // silently dropped: a client that produces one has a drifted counter,
      // and silence is how that kind of bug stays hidden.
      const seq = (await this.state.storage.get('seq')) || 0
      if (f.q > seq) {
        return refuse(ws, 'snap-ahead', { q: f.q, seq, k: f.k })
      }
      const cur = await this.state.storage.get('snap')
      if (!cur || f.q > cur.q) {
        // A snapshot supersedes every op it covers, so it RELIEVES pressure —
        // admit it even in a full room (bounded: one snapshot ≤ MAX_FRAME),
        // otherwise a room that fills up can never prune its way out.
        try {
          await this.state.storage.put('snap', { q: f.q, i: f.i, d: f.d })
        } catch (e) {
          return refuse(ws, 'storage-failed', { bytes: weight, k: f.k, detail: String(e && e.message || e).slice(0, 120) })
        }
        const dead = await this.state.storage.list({ start: OP_KEY(1), end: OP_KEY(f.q + 1) })
        // Give the pruned bytes back, or the cap becomes a one-way ratchet and
        // a long-lived healthy room eventually wedges itself shut.
        let freed = 0
        for (const [, v] of dead) freed += (v?.i?.length || 0) + (v?.d?.length || 0)
        await this.state.storage.delete([...dead.keys()])
        const used = (await this.state.storage.get('bytes')) || 0
        await this.state.storage.put('bytes', Math.max(0, used - freed))
      }
      return // snapshots are storage-only, never fanned out
    }

    const text = JSON.stringify(out)
    for (const peer of this.state.getWebSockets()) {
      if (peer === ws) continue
      try {
        peer.send(text)
      } catch { /* runtime reaps dead sockets */ }
    }
    await this.state.storage.setAlarm(Date.now() + IDLE_TTL_MS)
  }

  async alarm() {
    // ~30 days idle: the room evaporates. Files reopen fine — the document
    // itself is the durable artifact; a fresh room re-forms on next join.
    //
    // Delete this room's BLOBS too. The DO is the only thing that knows which
    // R2 objects belong to this room, so if it wipes its own state without
    // clearing them, they are orphaned in the bucket forever and nobody is
    // ever billed less. Best effort: if R2 errors we still wipe the DO rather
    // than wedge the room, and the bucket lifecycle rule is the backstop.
    try {
      const name = await this.state.storage.get('name')
      if (name && this.env?.BLOBS) {
        const keys = [...(await this.state.storage.list({ prefix: 'b:' })).keys()]
        for (const k of keys) {
          try { await this.env.BLOBS.delete(`${name}/${k.slice(2)}`) } catch { /* best effort */ }
        }
      }
    } catch { /* fall through to the wipe */ }
    await this.state.storage.deleteAll()
  }
}
