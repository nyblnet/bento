// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A fake Durable Object world for driving the REAL `Room` from
// server/sync-worker/src/worker.js in node: transactional storage as a Map,
// sockets that record what they were sent and how they were closed, the
// WebSocketPair the upgrade path constructs, and a Response shim (undici's
// refuses status 101). Shared by test-relay-auth.ts and test-relay-broadcast.ts
// so the two rigs cannot drift on what "the relay" is.
//
// Importing this module installs the globals the worker reaches for. Do it
// BEFORE importing the worker — `Room` below is imported here for that reason
// and re-exported.

// The DO returns a 101 for the WebSocket upgrade; undici's Response refuses any
// status outside 200–599, so the rig supplies a shim before importing.
class FakeResponse {
  status: number
  body: unknown
  webSocket: unknown
  headers: Map<string, string>
  constructor(body: unknown, init: { status?: number; headers?: Record<string, string>; webSocket?: unknown } = {}) {
    this.body = body
    this.status = init.status ?? 200
    this.webSocket = init.webSocket
    this.headers = new Map(Object.entries(init.headers ?? {}))
  }
  async text() {
    return typeof this.body === 'string' ? this.body : ''
  }
}
;(globalThis as Record<string, unknown>).Response = FakeResponse

export type Sock = {
  sent: string[]
  closed: boolean
  /** the code and reason the relay closed with, if it did */
  closeCode: number | null
  closeReason: string | null
  send(t: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(a: unknown): void
  deserializeAttachment(): Record<string, unknown> | null
}

export function mkSocket(att: Record<string, unknown> | null = null): Sock {
  let attachment = att
  return {
    sent: [],
    closed: false,
    closeCode: null,
    closeReason: null,
    send(t) { this.sent.push(t) },
    close(code, reason) { this.closed = true; this.closeCode = code ?? null; this.closeReason = reason ?? null },
    serializeAttachment(a) { attachment = JSON.parse(JSON.stringify(a)) },
    deserializeAttachment() { return attachment },
  }
}

let lastPair: { client: Sock; server: Sock } | null = null
;(globalThis as Record<string, unknown>).WebSocketPair = function () {
  const client = mkSocket()
  const server = mkSocket()
  lastPair = { client, server }
  return { 0: client, 1: server }
}
/** The server half of the most recent upgrade — what the relay talks to. */
export const lastServer = (): Sock => lastPair!.server

/**
 * The DO's `state`: transactional storage over a Map, the hibernation socket
 * list, and a `setAlarm` that RECORDS rather than fires. A rig that wants an
 * alarm to go off calls `room.alarm()` itself after putting the relevant
 * `al:<kind>` key in the past — the worker multiplexes every timer through
 * that one handler, and that dispatch is exactly what is worth testing.
 */
export function mkState() {
  const store = new Map<string, unknown>()
  const sockets: Sock[] = []
  const state = {
    store,
    sockets,
    /** what the DO alarm was last armed to, or null once deleted */
    alarmAt: null as number | null,
    storage: {
      async get(k: string) { return store.get(k) },
      async put(k: string, v: unknown) { store.set(k, v) },
      async delete(k: string | string[]) {
        for (const one of Array.isArray(k) ? k : [k]) store.delete(one)
      },
      async list({ start, end, prefix }: { start?: string; end?: string; prefix?: string } = {}) {
        const out = new Map<string, unknown>()
        for (const [k, v] of [...store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          if (prefix && !k.startsWith(prefix)) continue
          if (start && k < start) continue
          if (end && k >= end) continue
          out.set(k, v)
        }
        return out
      },
      async deleteAll() { store.clear() },
      async setAlarm(at: number) { state.alarmAt = at },
      async deleteAlarm() { state.alarmAt = null },
    },
    acceptWebSocket(ws: Sock) { sockets.push(ws) },
    getWebSockets() { return sockets.filter((s) => !s.closed) },
    setWebSocketAutoResponse() { /* keepalive, not under test */ },
  }
  return state
}

export const req = (url: string, headers: Record<string, string> = {}) => ({
  url,
  method: 'GET',
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
})

export const { Room } = await import('../../server/sync-worker/src/worker.js')

// --- key material -------------------------------------------------------------
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const
export const b64u = {
  enc(bytes: Uint8Array) {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
}

export type Keys = {
  pub: string
  /** the `w` room name this key commits to */
  room: string
  sign(text: string): Promise<string>
}

export async function mintKeys(): Promise<Keys> {
  const kp = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const commit = new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource))
  return {
    pub: b64u.enc(raw),
    room: 'w' + b64u.enc(commit),
    async sign(text: string) {
      return b64u.enc(new Uint8Array(await crypto.subtle.sign(SIGN, kp.privateKey, new TextEncoder().encode(text))))
    },
  }
}

/** Build the query string a CHAIN member sends: owner-signed invite of `role`,
 *  invite-signed delegation of the member key. Exactly what a real client
 *  (kernel/src/sync/online.ts) puts on the wire. */
export async function chainQuery(owner: Keys, invite: Keys, member: Keys, role: string, exp = 0): Promise<string> {
  const ivs = await owner.sign(`inv.${invite.pub}.${role}.${exp}`)
  const dg = await invite.sign(`dlg.${member.pub}`)
  return `&w=${member.pub}&o=${owner.pub}&ivp=${invite.pub}&ivr=${role}&ive=${exp}&ivs=${ivs}&dg=${dg}`
}

export const TOK = 'tok0123456789abcd'
/** a frame body the relay will never read — it only ever sees ciphertext */
export const IV = 'aXZpdmluaXY'
export const CT = 'Y2lwaGVydGV4dA'
export const parse = (s: string) => JSON.parse(s) as Record<string, unknown>

// --- a tiny check counter, shared so the summary line is uniform -------------
export const tally = { failures: 0, checks: 0 }
export function ok(cond: boolean, msg: string) {
  tally.checks++
  if (!cond) {
    tally.failures++
    console.error(`  ✗ ${msg}`)
  }
}
export function finish(name: string): never {
  console.log(tally.failures === 0 ? `\nALL PASS (${tally.checks} checks)` : `\n${tally.failures} FAILURES of ${tally.checks} checks`)
  void name
  process.exit(tally.failures ? 1 : 0)
}

/** Open a socket on `room` with the given query (after `?tok=`). Returns the
 *  server socket and the `ready` frame it was sent, if any. */
export const connect = async (room: InstanceType<typeof Room>, roomName: string, query: string, tok = TOK) => {
  const res = await room.fetch(req(`https://relay/d/${roomName}?tok=${tok}${query}`, { upgrade: 'websocket' }))
  const server = lastServer()
  const ready = server.sent.map(parse).find((f) => f.ctl === 'ready')
  return { status: res.status as number, server, ready }
}

/** Answer the relay's possession challenge and return the ticket, or null. */
export const prove = async (
  room: InstanceType<typeof Room>,
  c: { server: Sock; ready?: Record<string, unknown> },
  signer: { sign(text: string): Promise<string> },
  roomName: string,
) => {
  const nonce = c.ready?.c
  if (typeof nonce !== 'string') return null
  const before = c.server.sent.length
  await room.onMessage(c.server, JSON.stringify({ ctl: 'prove', g: await signer.sign(`prove.${nonce}.${roomName}`) }))
  const wtFrame = c.server.sent.slice(before).map(parse).find((f) => f.ctl === 'wt')
  return (wtFrame?.wt as string | undefined) ?? null
}
