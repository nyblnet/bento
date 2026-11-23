// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The incident lever drill's VICTIM (lever.mjs --drill, loopback only). Before
// the drill opens its incident it makes one account through the directory's
// public routes, exactly as a person at bento/home would: a setup with a
// passkey, a browser enrolled at bento/home's request (an ob=1 certificate)
// and a member change asked for at bento/home's request that is still waiting
// (an ob=1 pending change). After the run, the drill reads that account back
// through the same public routes: the certificate's status (revoked, by the
// incident, naming its id), the roster's waiting change (gone), and the
// incident mail. A drill that finds nothing to act on fails.
//
// The passkeys and the browser key are software ones, made fresh per drill and
// never saved. The only route here that is not public is the local mail
// read-back (src/devdrill.js): a local directory logs its mail instead of
// sending it, and the setup link is in the mail. Each read-back is signed by
// the drill key (the one LEVER_PUBKEY holds), over the address it reads.

import { b64uEnc, sha256b64u, signStatement } from '../../kernel/src/statements.ts'
import { buildRos, parseRos } from '../../kernel/src/roster.ts'
import { buildDeviceCert } from '../../kernel/src/devices.ts'
import { parseSetupLink } from './src/links.js'
import { HOME_ORIGIN, SIGNIN_ORIGIN } from './src/passkey.js'
import { STATUS_ROUTE, WEB_ROUTES } from './src/seam.js'
import { DEV_ROUTE, buildDevMail } from './src/devdrill.js'

const RP_ID = 'id.bento.page'
const te = new TextEncoder()
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length } return o }
function rawToDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = cat(new Uint8Array([0]), v); return cat(new Uint8Array([2, v.length]), v) }
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)))
  return cat(new Uint8Array([0x30, body.length]), body)
}

/** A software passkey (ES256, user verified), for the drill's victim only. */
async function passkey() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const credId = crypto.getRandomValues(new Uint8Array(32))
  const rpHash = await sha256(te.encode(RP_ID))
  return {
    pub: b64uEnc(raw),
    cid: b64uEnc(credId),
    /** a registration over a directory challenge: { clientDataJSON, authenticatorData } */
    register(challenge) {
      const cose = cat(new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), raw.slice(1, 33), new Uint8Array([0x22, 0x58, 0x20]), raw.slice(33))
      const ad = cat(rpHash, new Uint8Array([0x45, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cose)
      const cd = { type: 'webauthn.create', challenge, origin: SIGNIN_ORIGIN, crossOrigin: false }
      return { clientDataJSON: b64uEnc(te.encode(JSON.stringify(cd))), authenticatorData: b64uEnc(ad) }
    },
    /** an assertion over `text` (its challenge is sha256(text)) */
    async assert(text) {
      const ad = cat(rpHash, new Uint8Array([0x05, 0, 0, 0, 0]))
      const cdj = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: b64uEnc(await sha256(te.encode(text))), origin: SIGNIN_ORIGIN, crossOrigin: false }))
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, cat(ad, await sha256(cdj))))
      return { authenticatorData: b64uEnc(ad), clientDataJSON: b64uEnc(cdj), signature: b64uEnc(rawToDer(sig)) }
    },
  }
}

/**
 * The logged mails to `address`, through the signed local read-back:
 * { status, mails } (mails null unless the directory answered 200 with a list).
 */
export async function devMail({ fetch, base, key, now }, address) {
  const cmd = buildDevMail({ address, issuedAt: now(), nonce: b64uEnc(crypto.getRandomValues(new Uint8Array(18))) })
  const r = await fetch(base + DEV_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, sig: await signStatement(key, cmd) }) })
  let j = {}
  try { j = await r.json() } catch { /* the status says it */ }
  return { status: r.status, mails: r.status === 200 && Array.isArray(j.mails) ? j.mails : null }
}

/**
 * Make the victim. `io.fetch`, `base` (the local directory), `now()`, `key` (the drill key). Returns
 * { ok: true, victim } or { ok: false, step, status }: the step that failed,
 * never an address. `victim` stays in memory, for readBack.
 */
export async function seedVictim({ fetch, base, now, key }) {
  const address = `drill-${b64uEnc(crypto.getRandomValues(new Uint8Array(9))).toLowerCase().replace(/[^a-z0-9]/g, '0')}@example.invalid`
  const call = async (method, path, body, type = 'application/json') => {
    const r = await fetch(base + path, { method, headers: { 'content-type': type, origin: SIGNIN_ORIGIN }, body: body === undefined ? undefined : JSON.stringify(body) })
    let j = {}
    try { j = await r.json() } catch { /* the status says it */ }
    return { status: r.status, j }
  }
  const fail = (step, r) => ({ ok: false, step, status: r.status, error: r.j?.error ?? '' })
  const challenge = async () => call('POST', '/v1/roster/challenge', { email: address })

  // 1. a setup, from the link in the (logged) setup mail
  let r = await call('POST', '/v1/roster/setup/start', { email: address })
  if (r.status !== 202) return fail('setup/start', r)
  const dm = await devMail({ fetch, base, key, now }, address)
  if (!dm.mails) return fail('the local mail read-back (is the directory running with DEV=1, MAILER=log and LEVER_PUBKEY for this drill key?)', { status: dm.status, j: {} })
  const links = dm.mails.filter((m) => m.kind === 'setup').flatMap((m) => String(m.body).match(/https?:\/\/\S+/g) ?? []).map((u) => parseSetupLink(u)).filter((l) => l && l.address === address)
  if (links.length !== 1) return fail('the setup mail', { status: links.length, j: { error: 'no single setup link' } })
  const first = await passkey()
  let ch = await challenge()
  if (ch.status !== 200) return fail('challenge', ch)
  r = await call('POST', '/v1/roster/setup', { email: address, token: links[0].token, dirNonce: ch.j.challenge, reg: first.register(ch.j.challenge) })
  if (r.status !== 200) return fail('setup', r)

  // 2. a browser enrolled at bento/home's request: an ob=1 certificate
  const W = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const X = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const wc = await call('POST', WEB_ROUTES.challenge, { address }, 'text/plain;charset=UTF-8')
  if (wc.status !== 200) return fail('web challenge', wc)
  const text = buildDeviceCert({
    kind: 'wdev', devicePub: b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', W.publicKey))), consentPub: null,
    kx: b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', X.publicKey))), address, rosHash: wc.j.rosHash, label: 'Drill browser',
    via: 'passkey', ceremonyAt: wc.j.at, dirNonce: wc.j.nonce,
  })
  r = await call('POST', WEB_ROUTES.enrol, { text, rq: HOME_ORIGIN, assertion: { id: first.cid, userHandle: null, ...(await first.assert(text)) } }, 'text/plain;charset=UTF-8')
  if (r.status !== 200) return fail('enrol (an open incident refuses it: close it first)', r)

  // 3. a member change asked for at bento/home's request, still waiting: an ob=1 pending change
  const h = await call('GET', `/v1/roster?e=${encodeURIComponent(address)}`)
  const head = h.status === 200 ? await parseRos(h.j.ros) : { ok: false }
  if (!head.ok) return fail('roster head', h)
  const second = await passkey()
  ch = await challenge()
  if (ch.status !== 200) return fail('challenge', ch)
  const ros = buildRos({
    address, seq: head.value.seq + 1, prev: await sha256b64u(h.j.ros), members: [...head.value.members, { kind: 'pk', pub: second.pub, quarantined: false }],
    dirNonce: ch.j.challenge, created: now(),
  })
  r = await call('POST', '/v1/roster/request', { email: address, ros, credId: first.cid, assertion: await first.assert(ros), reg: second.register(ch.j.challenge), rq: HOME_ORIGIN })
  if (r.status !== 202) return fail('request', r)
  const p = await call('GET', `/v1/roster?e=${encodeURIComponent(address)}`)
  if (!p.j.pending) return fail('the change is waiting', p)
  return { ok: true, victim: { address, certHash: await sha256b64u(text) } }
}

/**
 * What the lever did to the victim, read through the public routes and the
 * signed local mail read-back: { cert: {state, by, incident}, pending, incidentMails }.
 * A read that fails, or an answer without the field, never reads as the lever's
 * work: it comes back as a string naming what went wrong (and incidentMails -1).
 */
export async function readBack({ fetch, base, key, now }, victim) {
  const get = async (path) => { const r = await fetch(base + path); try { return { status: r.status, j: await r.json() } } catch { return { status: r.status, j: {} } } }
  const e = encodeURIComponent(victim.address)
  const st = await get(`${STATUS_ROUTE}?e=${e}&c=${victim.certHash}`)
  const h = await get(`/v1/roster?e=${e}`)
  const m = await devMail({ fetch, base, key, now }, victim.address)
  const has = (j, k) => j !== null && typeof j === 'object' && Object.hasOwn(j, k)
  return {
    cert: st.status === 200 ? { state: st.j.state, by: st.j.by, incident: st.j.incident } : { state: `unread (status ${st.status})` },
    pending: h.status === 200 && has(h.j, 'pending') ? h.j.pending : `unread (status ${h.status})`,
    incidentMails: m.mails ? m.mails.filter((x) => x && x.kind === 'incident').length : -1,
  }
}
