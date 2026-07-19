// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// bento-guestbook-daemon — the sustainable home of the public guestbook.
// Storage: Workers KV (R2 is not enabled on this account; KV fits — values
// are ~500 KB against a 25 MB limit, archives pruned to the newest 90).
//
//   · serves bento.page/guestbook.bento.html from KV (current epoch)
//   · cron: daily read-only archivist snapshot of the room → KV archives/
//   · rolls epochs (fresh room+key, seeded deck) on demand or on cadence
//   · admin surface under /guestbook-admin/* (Authorization: Bearer ADMIN_KEY)
//
// The daemon joins the relay room exactly like any client (WebSocket +
// AES-GCM with the key from the file) and replays ops through the real CRDT
// engine — bundled from slides/src/sync/crdt.ts. It holds the room key, but
// so does everyone with the file: the guestbook's key is public by design.

import { SyncState } from '../../../slides/src/sync/crdt.ts'
import { buildGuestbookDoc, spliceDoc, extractDoc } from '../../../scripts/guestbook-deck.mjs'

const CURRENT = 'current.bento.html'
const META = 'meta.json'

const b64u = {
  enc(bytes) {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  dec(s) {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  },
}

const meta = async (env) => JSON.parse((await env.STORE.get(META, 'text')) ?? '{}')
const putMeta = (env, m) => env.STORE.put(META, JSON.stringify(m, null, 2))

// ——— archivist: read-only join, replay, return the room's real doc ———————
async function captureRoom(env) {
  const shellText = await env.STORE.get(CURRENT, 'text')
  if (!shellText) throw new Error('no current guestbook in KV')
  const doc = extractDoc(shellText)
  const { room, key: keyB64 } = doc.collab ?? {}
  if (!room || !keyB64) throw new Error('current file has no collab creds')

  const raw = b64u.dec(keyB64)
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  const tok = b64u.enc(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)).slice(0, 18))

  const httpsUrl = room.replace(/^wss:/, 'https:') + `?tok=${tok}&since=0`
  const resp = await fetch(httpsUrl, { headers: { Upgrade: 'websocket' } })
  const ws = resp.webSocket
  if (!ws) throw new Error('relay refused websocket upgrade (' + resp.status + ')')
  ws.accept()

  const state = new SyncState('daemon-' + Math.random().toString(36).slice(2, 8))
  state.adopt(doc)
  const seedCount = doc.slides.reduce((n, s) => n + (s.elements?.length ?? 0), 0)
  let opsApplied = 0
  let gotSnap = false

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), 20000)
    let graceTimer = null
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')) })
    ws.addEventListener('message', async (ev) => {
      let env2
      try { env2 = JSON.parse(String(ev.data)) } catch { return }
      if (env2.ctl === 'ready') {
        graceTimer = setTimeout(() => { clearTimeout(timer); resolve('ready') }, 2000)
        return
      }
      if (env2.ctl === 'ack' || !env2.i || !env2.d) return
      let payload
      try {
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(env2.i) }, key, b64u.dec(env2.d))
        payload = JSON.parse(new TextDecoder().decode(pt))
      } catch { return }
      if (env2.snap === 1 || (payload?.t === 'snap' && payload.doc)) {
        const p = env2.snap === 1 ? payload : payload
        if (p?.doc && p?.state) { state.mergeSnapshot(doc, p.doc, p.state); gotSnap = true }
        return
      }
      if (payload?.t === 'ops' && Array.isArray(payload.ops)) {
        state.apply(doc, payload.ops)
        opsApplied += payload.ops.length
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = setTimeout(() => { clearTimeout(timer); resolve('ready') }, 1500) }
      }
    })
  })
  try { ws.close() } catch { /* fine */ }

  const total = doc.slides.reduce((n, s) => n + (s.elements?.length ?? 0), 0)
  return { doc, shellText, stats: { epoch: doc.guestbookEpoch ?? 0, seedCount, total, signed: total - seedCount, opsApplied, gotSnap } }
}

async function snapshot(env) {
  const { doc, shellText, stats } = await captureRoom(env)
  const frozen = JSON.parse(JSON.stringify(doc))
  if (frozen.collab) frozen.collab.on = false
  frozen.title = `The Guestbook — epoch ${stats.epoch} (archived)`
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const name = `archives/epoch-${stats.epoch}-${stamp}.bento.html`
  await env.STORE.put(name, spliceDoc(shellText, frozen))
  // prune: keep the newest 90 archives (KV free tier is 1 GB)
  const list = await env.STORE.list({ prefix: 'archives/' })
  const names = list.keys.map((k) => k.name).sort()
  for (const old of names.slice(0, Math.max(0, names.length - 90))) await env.STORE.delete(old)
  const m = await meta(env)
  m.lastSnapshot = { at: new Date().toISOString(), name, ...stats }
  await putMeta(env, m)
  return { name, ...stats }
}

async function roll(env) {
  // 1 · archive what the room holds right now
  let archived = null
  try { archived = await snapshot(env) } catch (e) { archived = { error: String(e) } }

  // 2 · mint the next epoch; fonts carry forward from the current file's doc
  const curText = await env.STORE.get(CURRENT, 'text')
  if (!curText) throw new Error('no current guestbook in KV')
  const prevDoc = extractDoc(curText)
  const epoch = (prevDoc.guestbookEpoch ?? 0) + 1
  const fonts = { fraunces: prevDoc.assets['font-fraunces'], instrument: prevDoc.assets['font-instrument'] }
  const rnd = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b }
  const collab = { room: `${env.SYNC_HOST}/d/r${b64u.enc(rnd(12))}`, key: b64u.enc(rnd(32)), on: true }
  const doc = buildGuestbookDoc({ epoch, docId: crypto.randomUUID(), collab, fonts })

  // 3 · splice into a FRESH shell (so epochs pick up app releases too)
  const shellResp = await fetch(env.SHELL_URL)
  if (!shellResp.ok) throw new Error('shell fetch failed: ' + shellResp.status)
  const spliced = spliceDoc(await shellResp.text(), doc)
  await env.STORE.put(CURRENT, spliced)

  const m = await meta(env)
  m.epoch = epoch
  m.lastRoll = new Date().toISOString()
  m.killed = false
  await putMeta(env, m)
  return { epoch, archived, size: spliced.length }
}

// ——— entrypoints ————————————————————————————————————————————————————
export default {
  async fetch(req, env) {
    const url = new URL(req.url)

    if (url.pathname === '/guestbook.bento.html') {
      const m = await meta(env)
      if (m.killed) return Response.redirect(url.origin + '/404.html', 302)
      const cur = await env.STORE.get(CURRENT, 'stream')
      if (cur) {
        return new Response(cur, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache', // epochs must propagate immediately
          },
        })
      }
      // KV empty: fall through to the static copy on GitHub Pages
      return fetch(env.ORIGIN_FALLBACK + '/guestbook.bento.html')
    }

    if (url.pathname.startsWith('/guestbook-admin/')) {
      const auth = req.headers.get('authorization') ?? ''
      if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response('unauthorized', { status: 401 })
      }
      const action = url.pathname.slice('/guestbook-admin/'.length)
      const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { 'content-type': 'application/json' } })
      try {
        if (action === 'status') {
          const m = await meta(env)
          const list = await env.STORE.list({ prefix: 'archives/' })
          return json({ ...m, archives: list.keys.map((k) => k.name) })
        }
        if (action === 'snapshot' && req.method === 'POST') return json(await snapshot(env))
        if (action === 'roll' && req.method === 'POST') return json(await roll(env))
        if (action === 'kill' && req.method === 'POST') {
          const m = await meta(env)
          m.killed = true
          await putMeta(env, m)
          return json({ killed: true })
        }
        if (action === 'seed' && req.method === 'PUT') {
          // initial arming: PUT the current epoch file built locally
          const body = await req.text()
          const doc = extractDoc(body) // validates
          await env.STORE.put(CURRENT, body)
          const m = await meta(env)
          m.epoch = doc.guestbookEpoch ?? 0
          m.killed = false
          m.seededAt = new Date().toISOString()
          // Anchor the roll clock on first seed so ROLL_HOURS is measured from
          // now, not from epoch 0 — otherwise a freshly-seeded guestbook (no
          // lastRoll) rolls on the very next cron tick, wiping the seeded room.
          // Only set it if absent: re-seeds (every publish) must NOT reset the
          // cadence, and a real roll() sets its own lastRoll.
          if (!m.lastRoll) m.lastRoll = new Date().toISOString()
          await putMeta(env, m)
          return json({ seeded: true, epoch: m.epoch, bytes: body.length })
        }
        if (action.startsWith('archives/')) {
          const obj = await env.STORE.get(action, 'stream')
          if (!obj) return json({ error: 'not found' }, 404)
          return new Response(obj, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
        return json({ error: 'unknown action', actions: ['status', 'POST snapshot', 'POST roll', 'POST kill', 'PUT seed', 'archives/<key>'] }, 404)
      } catch (e) {
        return json({ error: String(e) }, 500)
      }
    }

    return new Response('bento-guestbook-daemon', { status: 200 })
  },

  async scheduled(_ctrl, env, ctx) {
    ctx.waitUntil((async () => {
      const m = await meta(env)
      if (m.killed) return
      try { await snapshot(env) } catch (e) { console.log('snapshot failed:', String(e)) }
      const rollHours = Number(env.ROLL_HOURS || '0')
      if (rollHours > 0) {
        const last = m.lastRoll ? Date.parse(m.lastRoll) : 0
        if (Date.now() - last >= rollHours * 3600_000) {
          try { await roll(env) } catch (e) { console.log('roll failed:', String(e)) }
        }
      }
    })())
  },
}
