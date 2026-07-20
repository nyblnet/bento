// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
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
// Envelope (JSON text frames, ≤ 1 MB):
//   client → server:  { i, d }            ephemeral (presence, hello, need)
//                     { p:1, i, d }       persist an op batch
//                     { snap:1, q, i, d } encrypted snapshot covering seq ≤ q
//   server → clients: same frames fanned out, ops stamped with { q: seq };
//                     on join: snapshot (if any) + ops since ?since= then
//                     { ctl:'ready', q: latest }

const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_FRAME = 1_000_000
const RATE_BURST = 200 // frames per window per socket
const RATE_WINDOW_MS = 10_000
const OP_KEY = (seq) => `op:${String(seq).padStart(10, '0')}`

// --- signed writes (see docs/collab-design.md) ------------------------------
// A room whose name starts with 'w' is SIGNED: the name commits to an ECDSA
// P-256 writer pubkey ('w' + base64url(SHA-256(pubRaw))). Clients present the
// raw pubkey as ?w=; the relay pins it (commitment-checked, so a viewer can't
// substitute their own) and thereafter requires a valid signature `g` over
// `${i}.${d}` on every persisted frame (op batch / snapshot). Viewers hold the
// pubkey but not the private half — their writes are dropped, so read-only is
// ENFORCED here while the relay stays blind to content. 'r' rooms are legacy
// and stay permissive.
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
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

export class Room {
  constructor(state) {
    this.state = state
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
  async verifySig(f) {
    if (typeof f.g !== 'string') return false
    if (!this.verifyKey) {
      const w = await this.state.storage.get('w')
      if (!w) return false
      try {
        this.verifyKey = await crypto.subtle.importKey('raw', b64uDec(w), EC_VERIFY, false, ['verify'])
      } catch { return false }
    }
    try {
      return await crypto.subtle.verify(
        SIG_ALG, this.verifyKey, b64uDec(f.g), new TextEncoder().encode(`${f.i}.${f.d}`),
      )
    } catch { return false }
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const url = new URL(req.url)
    const tok = url.searchParams.get('tok') || ''
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(tok)) return new Response('bad token', { status: 400 })
    const saved = await this.state.storage.get('tok')
    if (saved === undefined) await this.state.storage.put('tok', tok)
    else if (saved !== tok) return new Response('forbidden', { status: 403 })

    // Signed rooms: the room name commits to the writer pubkey. Verify the
    // presented ?w= against the commitment before pinning it, so the pinned
    // key can't be substituted by a viewer.
    const name = url.pathname.match(/^\/d\/([A-Za-z0-9._-]{1,80})$/)?.[1] || ''
    const signed = name[0] === 'w'
    if (signed) {
      const w = url.searchParams.get('w') || ''
      if (!/^[A-Za-z0-9_-]{80,200}$/.test(w)) return new Response('bad writer key', { status: 400 })
      if ('w' + (await sha256b64u(b64uDec(w))) !== name) {
        return new Response('writer key does not match room', { status: 403 })
      }
      const savedW = await this.state.storage.get('w')
      if (savedW === undefined) await this.state.storage.put('w', w)
      else if (savedW !== w) return new Response('forbidden', { status: 403 })
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
    server.serializeAttachment({ count: 0, windowStart: Date.now(), signed })

    await this.replay(server, since)
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

  async replay(ws, since) {
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
      ws.send(JSON.stringify({ ctl: 'ready', q: seq }))
    } catch {
      /* socket died mid-replay */
    }
  }

  async onMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_FRAME) return
    // keepalive fallback: if the runtime auto-response isn't active this reaches
    // us — reply "pong" so a pinging client never mistakes a live socket for dead.
    if (data === 'ping') { try { ws.send('pong') } catch { /* gone */ } return }
    // rate-limit window lives on the socket attachment (survives hibernation)
    const meta = ws.deserializeAttachment() || { count: 0, windowStart: Date.now() }
    const now = Date.now()
    if (now - meta.windowStart > RATE_WINDOW_MS) {
      meta.windowStart = now
      meta.count = 0
    }
    meta.count++
    ws.serializeAttachment(meta)
    if (meta.count > RATE_BURST) return
    let f
    try {
      f = JSON.parse(data)
    } catch {
      return
    }
    if (typeof f.i !== 'string' || typeof f.d !== 'string') return

    // Signed rooms: a persisted frame (op batch / snapshot) must carry a valid
    // writer signature, else DROP it — this is what enforces read-only. A
    // reader (no private key) can still send ephemeral frames (presence).
    if (meta.signed && (f.p === 1 || f.snap === 1)) {
      if (!(await this.verifySig(f))) return
    }

    const out = { i: f.i, d: f.d }
    if (f.p === 1) {
      const seq = ((await this.state.storage.get('seq')) || 0) + 1
      await this.state.storage.put('seq', seq)
      await this.state.storage.put(OP_KEY(seq), { i: f.i, d: f.d })
      out.q = seq
      // the sender needs its ack too (snapshot cadence keys off q)
      try {
        ws.send(JSON.stringify({ ctl: 'ack', q: seq }))
      } catch {
        /* gone */
      }
    } else if (f.snap === 1 && typeof f.q === 'number') {
      // client-produced encrypted snapshot: keep the newest, prune covered ops
      const cur = await this.state.storage.get('snap')
      if (!cur || f.q > cur.q) {
        await this.state.storage.put('snap', { q: f.q, i: f.i, d: f.d })
        const dead = await this.state.storage.list({ start: OP_KEY(1), end: OP_KEY(f.q + 1) })
        await this.state.storage.delete([...dead.keys()])
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
    await this.state.storage.deleteAll()
  }
}
