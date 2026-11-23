// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The REAL relay (server/sync-worker's `Room`, driven through
// scripts/lib/relay-harness.ts) served to a Playwright browser context over
// `context.routeWebSocket`, so a browser rig can run live sessions with no
// network and no wrangler. One Room per room name, as the worker's
// idFromName does; frames in and out are recorded for the rig to inspect.
//
// What this is NOT: the worker's outer fetch (blob routes, CORS) and the DO
// runtime's input gates. Each room handles one message at a time, in
// arrival order, which is the property the gates give the code under test.
//
// Importing relay-harness installs its globals (a Response shim the DO's 101
// needs); rigs that use undici's Response directly should not import this.

import { mkState, Room, req, lastServer } from './relay-harness.ts'

/**
 * One relay; `attach(ctx, tag)` routes a browser context's sockets to it
 * (several contexts share its rooms, as peers on two machines would).
 * @param {{ origin?: string, onOther?: (url: string) => void }} [opts]
 *   origin: the relay origin to serve (default the shipped one). Every OTHER
 *   socket is closed and reported to onOther: a rig counts those.
 */
export function relayWorld(opts = {}) {
  const origin = (opts.origin ?? 'wss://sync.bento.page').replace(/\/$/, '')
  const rooms = new Map()
  const log = { sockets: [], frames: [], other: [], refused: [] }
  let gate = Promise.resolve()
  // WebSocketPair is a module global in the harness: one upgrade at a time,
  // so `lastServer()` is this upgrade's server half
  const serial = (fn) => { const p = gate.then(fn); gate = p.catch(() => {}); return p }

  const roomOf = (name) => {
    let r = rooms.get(name)
    if (!r) { const state = mkState(); r = { state, room: new Room(state, {}), queue: Promise.resolve() }; rooms.set(name, r) }
    return r
  }

  const attach = (ctx, tag = '') => ctx.routeWebSocket(/.*/, async (ws) => {
    const url = ws.url()
    if (!url.startsWith(origin + '/')) { log.other.push(url); opts.onOther?.(url); ws.close(); return }
    const name = new URL(url).pathname.match(/^\/d\/([A-Za-z0-9._-]{1,80})$/)?.[1]
    if (!name) { log.refused.push(url); ws.close({ code: 1008, reason: 'no room' }); return }
    const r = roomOf(name)
    const entry = { url, name, tag, open: true, closedBy: null, server: null }
    log.sockets.push(entry)
    const run = (fn) => { const p = r.queue.then(fn); r.queue = p.catch(() => {}); return p }
    // messages that arrive while the upgrade is in flight wait for it
    let upgraded
    const ready = new Promise((res) => { upgraded = res })
    ws.onMessage((m) => {
      const text = typeof m === 'string' ? m : Buffer.from(m).toString('utf8')
      log.frames.push({ dir: 'in', name, text })
      void ready.then((server) => server && run(() => r.room.webSocketMessage(server, text)))
    })
    ws.onClose(() => {
      entry.open = false
      entry.closedBy = entry.closedBy ?? 'client'
      void ready.then((server) => server && run(() => r.room.webSocketClose(server)))
    })
    const server = await serial(async () => {
      const res = await run(() => r.room.fetch(req(url.replace(/^ws/, 'http'), { upgrade: 'websocket' })))
      return res.status === 101 ? lastServer() : (log.refused.push(`${url} ${res.status}`), null)
    })
    if (!server) { upgraded(null); ws.close({ code: 1008, reason: 'refused' }); entry.open = false; return }
    entry.server = server
    const send = (t) => { log.frames.push({ dir: 'out', name, text: t }); try { ws.send(t) } catch { /* closed */ } }
    for (const t of server.sent) send(t) // the ready frame, sent during the upgrade
    server.send = function (t) { this.sent.push(t); send(t) }
    server.close = function (code, reason) {
      this.closed = true; this.closeCode = code ?? null; this.closeReason = reason ?? null
      entry.closedBy = entry.closedBy ?? 'relay'
      try { ws.close({ code: code ?? 1000, reason: reason ?? '' }) } catch { /* already closed */ }
    }
    upgraded(server)
  })
  return { origin, rooms, log, attach, open: () => log.sockets.filter((s) => s.open) }
}
