#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Headless guestbook archivist: joins the room READ-ONLY (sends nothing),
// replays the encrypted op log through the real CRDT engine, and writes an
// archive file containing what people actually signed — not the pristine
// seed. Archives are frozen artifacts: collab.on is set to false in them.
//
//   node scripts/guestbook-archivist.ts [--in <file>] [--out <file>]
//
// Defaults: in  = working/guestbook-live/guestbook.bento.html
//           out = working/guestbook-epochs/epoch-<n>-content-<stamp>.bento.html

import { webcrypto as crypto } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SyncState } from '../slides/src/sync/crdt.ts'
import type { Op } from '../slides/src/sync/crdt.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const inFile = opt('in', join(root, 'working/guestbook-live/guestbook.bento.html'))

const b64u = {
  enc: (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s: string) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
}

const shellText = readFileSync(inFile, 'utf8')
const blockRe = /<script type="application\/bento\+json" id="bento-doc">\s*([\s\S]*?)\s*<\/script>/
const m = shellText.match(blockRe)
if (!m) throw new Error('no #bento-doc block in ' + inFile)
const doc = JSON.parse(m[1])
const { room, key: keyB64 } = doc.collab ?? {}
if (!room || !keyB64) throw new Error('file has no collab credentials')
const epoch = doc.guestbookEpoch ?? 0

const countEls = (d: any) => d.slides.reduce((n: number, s: any) => n + (s.elements?.length ?? 0), 0)
const seedCount = countEls(doc)

const actor = 'archivist-' + Math.random().toString(36).slice(2, 8)
const state = new SyncState(actor)
state.adopt(doc)

const raw = b64u.dec(keyB64)
const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
const tok = b64u.enc(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)).slice(0, 18))

let opsApplied = 0
let gotSnap = false
let done = false

const finish = (reason: string) => {
  if (done) return
  done = true
  try { ws.close() } catch { /* already closed */ }
  const total = countEls(doc)
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const out = opt('out', join(root, `working/guestbook-epochs/epoch-${epoch}-content-${stamp}.bento.html`))
  const frozen = JSON.parse(JSON.stringify(doc))
  if (frozen.collab) frozen.collab.on = false // archives are frozen artifacts
  frozen.title = `The Guestbook — epoch ${epoch} (archived)`
  const json = JSON.stringify(frozen).replace(/</g, '\\u003c')
  const spliced = shellText.replace(blockRe, `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, spliced)
  console.log(`archived epoch ${epoch} → ${out}`)
  console.log(`  ${reason} · snapshot: ${gotSnap} · ops applied: ${opsApplied} · elements: ${seedCount} seed → ${total} now (${total - seedCount} signed)`)
  process.exit(0)
}

setTimeout(() => finish('timeout (30s) — partial capture'), 30000)

const ws = new WebSocket(`${room}?tok=${tok}&since=0`)
ws.onopen = () => console.log('connected (read-only) to', room.slice(0, 48) + '…')
ws.onerror = () => { console.error('websocket error'); process.exit(1) }
ws.onclose = () => { if (!done) { console.error('closed before ready'); process.exit(1) } }
ws.onmessage = async (ev: MessageEvent) => {
  let env: { i?: string; d?: string; q?: number; snap?: number; ctl?: string }
  try { env = JSON.parse(String(ev.data)) } catch { return }
  if (env.ctl === 'ready') {
    // replay complete — linger briefly for in-flight live frames
    setTimeout(() => finish('replay complete'), 2500)
    return
  }
  if (env.ctl === 'ack' || !env.i || !env.d) return
  let payload: any
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(env.i) }, key, b64u.dec(env.d))
    payload = JSON.parse(new TextDecoder().decode(pt))
  } catch { return }
  if (env.snap === 1) {
    if (payload?.doc && payload?.state) {
      state.mergeSnapshot(doc, payload.doc, payload.state)
      gotSnap = true
    }
    return
  }
  if (payload?.t === 'ops' && Array.isArray(payload.ops)) {
    state.apply(doc, payload.ops as Op[])
    opsApplied += payload.ops.length
  }
  if (payload?.t === 'snap' && payload.doc && payload.state) {
    state.mergeSnapshot(doc, payload.doc, payload.state)
    gotSnap = true
  }
}
