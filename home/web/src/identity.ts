// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The bento/id agent of bento/home in your browser: the browser device key W
// and its key-agreement key kx, the certificate a passkey gave them, and the
// directory's countersign that keeps it in force.
//
// This page runs NO WebAuthn. The passkeys belong to rp id.bento.page, which
// home.bento.page cannot use, and every ceremony happens on the sign-in host
// (server/signin): this page opens it and sends exactly one request,
// { t: 'enrol', W, kx, label }, and the host answers { t: 'enrolled', wdev, watt }.
// Nor does it ever call the WebAuthn Signal API, with any list.
//
// The rules, each with a rig row and a mutant (scripts/test-home-web-identity.mjs):
//
//   - W (ECDSA P-256) and kx (ECDH P-256) are made non-extractable, and made
//     FRESH at every ceremony: a key this page made yesterday is never
//     certified again. A held key that can be exported is not ours: dropped.
//     There is no account scalar, no PRF output, no key blob and no code.
//   - Nothing is believed until the kernel's verifiers accept it: the roster
//     chain (verifyRosterChain) under the directory keys this build pins, and
//     the certificate with its countersign (verifyDevice), which also enforces
//     the 24-hour countersign and the 7-day cap from the original ceremony.
//     Never a key the network offers.
//   - The certificate must be for exactly the keys and label this page sent,
//     and "Confirm it's you" must not switch accounts.
//   - The countersign is renewed by a check-in signed by W itself (`wren.`),
//     on load and every hour, inside the 7-day cap. A day before the cap the
//     page asks the person to confirm it's them: a fresh ceremony, fresh keys.
//   - An incident record that covers this key's ceremony, or the directory
//     saying the key is revoked, ends the sign-in here: the keys are deleted,
//     and only a new ceremony signs this browser in again.
//   - Replies count only from the window this page opened, at the sign-in
//     host's origin; the request goes only to that literal origin.

import { verifyRosterChain, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, type RosterLink } from '../../../kernel/src/roster.ts'
import { verifyDevice, parseDeviceCert, parseWatt, buildWren, CEREMONY_CAP_MS, type DeviceProof } from '../../../kernel/src/devices.ts'
import { b64uEnc, sha256b64u, signStatement } from '../../../kernel/src/statements.ts'
import type { Assertion } from '../../../kernel/src/webauthn.ts'

declare const __DIRECTORY_KEYS__: Record<string, string>

/** The sign-in host: the only web origin that runs ceremonies (a literal, never from a message or the URL). */
export const SIGNIN_ORIGIN = 'https://signin.id.bento.page'
/** The directory. */
export const DIRECTORY = 'https://id.bento.page'
/** The directory's signing keys, by kid, pinned in this build. */
const DIR_KEYS: Readonly<Record<string, string>> = Object.freeze({ ...__DIRECTORY_KEYS__ })

const HOUR = 3_600_000
/** "Confirm it's you" is asked this long before the 7-day cap, so a sign-in never lapses mid-week. */
export const CONFIRM_BEFORE_MS = 24 * HOUR
/** How often an open page checks in. */
export const CHECKIN_EVERY_MS = HOUR
/** How long a ceremony may take before this page stops waiting for the sign-in window. */
const CEREMONY_MS = 15 * 60_000

export const ROUTES = Object.freeze({
  /** POST { address } → 200 { nonce }: a single-use challenge for a wren. */
  challenge: '/v1/home/challenge',
  /**
   * POST { wren, sig, pin? } → 200 { watt, wattSig, signer, assertion, roster, incidents },
   * or 403 { error: 'revoked' | 'cap' | 'unknown', incidents }.
   */
  checkin: '/v1/home/checkin',
})

// --- what this page holds -----------------------------------------------------------

/** What is kept in this origin's IndexedDB. The private keys cannot be exported. */
export interface Held {
  v: 1
  address: string
  label: string
  W: CryptoKeyPair
  kx: CryptoKeyPair
  Wpub: string
  kxPub: string
  /** the wdev. text, the passkey that asserted, and its assertion */
  cert: string
  signer: string
  assertion: Assertion
  /** the directory's current countersign and its signature */
  watt: string
  wattSig: string
  ceremonyAt: number
  expires: number
  /** the roster links last verified, and the pin they start from (absent: from setup) */
  roster: RosterLink[]
  pin?: string
}

/** Why a sign-in ended (what the page then shows). */
export type Ended = 'expired' | 'revoked' | 'incident' | 'invalid'

/** Remembered after a sign-in ends, so "Confirm it's you" knows whose sign-in it was. */
export interface Last { v: 1; address: string; why: Ended }

/**
 * Every tab of the library shares this store. A write that follows a check-in
 * names the record it was made from (`expect`, its Wpub): it happens only if
 * that record is still the one stored, checked and written in ONE transaction,
 * and answers false otherwise. Without `expect` (a ceremony's result, a
 * person's Sign out) it writes whatever is there.
 */
export interface Store {
  get(): Promise<{ held: Held | null; last: Last | null }>
  put(held: Held, expect?: string): Promise<boolean>
  end(last: Last | null, expect?: string): Promise<boolean>
}

export type Status =
  | { kind: 'none' }
  | { kind: 'signed-in'; address: string; label: string; expires: number; capAt: number; confirm: boolean }
  | { kind: 'ended'; address: string; why: Ended }

export type Outcome = { ok: true } | { ok: false; reason: string }

/** An incident the directory published: every key whose ceremony is not after `to` starts again. */
export interface Incident { id?: unknown; from?: unknown; to?: unknown }

const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'

/**
 * Does an incident record end a key made at `ceremonyAt`? A key made before the
 * window closed sat in this browser's storage while the hostile code may have
 * run, so it starts again. A record this page cannot read ends it too (fail
 * closed: the cost is one "Confirm it's you").
 */
export function covers(i: unknown, ceremonyAt: number): boolean {
  if (!isObj(i)) return true
  if (i.to === null) return true                      // still open
  if (!Number.isSafeInteger(i.to)) return true
  return ceremonyAt <= (i.to as number)
}

/** A short label for this browser, as the certificate carries it ("Chrome on macOS"). At most 40 characters. */
export function browserLabel(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}

const raw = async (k: CryptoKey) => b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', k)))

/** Fresh, non-extractable W and kx. */
async function freshKeys() {
  const W = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) as CryptoKeyPair
  const kx = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair
  return { W, kx, Wpub: await raw(W.publicKey), kxPub: await raw(kx.publicKey) }
}

/** A held record is ours only if its private keys cannot leave this browser and its public halves are what it says. */
async function keysSound(h: Held): Promise<boolean> {
  try {
    const ok = (p: CryptoKeyPair, alg: string, use: string) =>
      p && p.privateKey instanceof CryptoKey && p.publicKey instanceof CryptoKey &&
      p.privateKey.extractable === false && p.privateKey.algorithm.name === alg &&
      (p.privateKey.algorithm as EcKeyAlgorithm).namedCurve === 'P-256' && p.privateKey.usages.length === 1 && p.privateKey.usages[0] === use
    if (!ok(h.W, 'ECDSA', 'sign') || !ok(h.kx, 'ECDH', 'deriveBits')) return false
    return (await raw(h.W.publicKey)) === h.Wpub && (await raw(h.kx.publicKey)) === h.kxPub
  } catch { return false }
}

// --- the network ----------------------------------------------------------------------

type Net = (url: string, init?: RequestInit) => Promise<Response>

async function post(net: Net, route: string, body: unknown): Promise<{ status: number; body: unknown } | null> {
  try {
    const r = await net(DIRECTORY + route, {
      method: 'POST',
      // JSON as text/plain: a simple request, no preflight; the directory parses the body as JSON
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
    let b: unknown = null
    try { b = await r.json() } catch { /* not JSON: no body */ }
    return { status: r.status, body: b }
  } catch { return null }
}

/** What a check-in brought back, before verification. */
interface Answer { watt: string; wattSig: string; signer: string; assertion: Assertion; roster: RosterLink[]; incidents: unknown[] }

function answerOf(b: unknown): Answer | null {
  if (!isObj(b) || !str(b.watt) || !str(b.wattSig) || !str(b.signer) || !isObj(b.assertion) || !Array.isArray(b.roster)) return null
  return { watt: b.watt, wattSig: b.wattSig, signer: b.signer, assertion: b.assertion as unknown as Assertion,
    roster: b.roster as RosterLink[], incidents: Array.isArray(b.incidents) ? b.incidents : [] }
}

// --- the agent --------------------------------------------------------------------------

export class Agent {
  private held: Held | null = null
  private last: Last | null = null
  private busy = false

  constructor(private store: Store, private net: Net, private now: () => number = () => Date.now()) {}

  status(): Status {
    const h = this.held
    if (h) {
      if (this.now() >= h.expires) return { kind: 'ended', address: h.address, why: 'expired' }
      const capAt = h.ceremonyAt + CEREMONY_CAP_MS
      return { kind: 'signed-in', address: h.address, label: h.label, expires: h.expires, capAt, confirm: this.now() >= capAt - CONFIRM_BEFORE_MS }
    }
    if (this.last) return { kind: 'ended', address: this.last.address, why: this.last.why }
    return { kind: 'none' }
  }

  /** Read what this browser holds and check it offline. */
  async load(): Promise<Status> {
    const { held, last } = await this.store.get()
    this.last = last
    this.held = null
    if (held) {
      const v = (await keysSound(held)) ? await this.verify(held.cert, held, held.roster, held.pin) : no('keys')
      if (v.ok || v.reason === 'device-expired') this.held = held      // expired: a check-in may still renew it
      else if (!(await this.end(held.address, 'invalid', held.Wpub))) return this.load()   // another tab replaced it meanwhile
    }
    return this.status()
  }

  /** Forget this browser's sign-in. Nothing else: no Signal API, no directory call. */
  async signOut(): Promise<void> {
    this.held = null
    this.last = null
    await this.store.end(null)
  }

  /** End the sign-in whose key is `expect`. False when the stored record is no longer that one: nothing written. */
  private async end(address: string, why: Ended, expect: string): Promise<boolean> {
    this.held = null
    this.last = { v: 1, address, why }
    if (await this.store.end(this.last, expect)) return true
    this.last = null
    return false
  }

  /** The kernel's verdict on a certificate, its countersign and the roster it names. */
  private async verify(cert: string, a: Pick<Answer, 'watt' | 'wattSig' | 'signer' | 'assertion'>, roster: RosterLink[], pin: string | undefined) {
    const now = this.now()
    const opts = { directoryKeys: DIR_KEYS, rpId: ROSTER_RP_ID, origins: ROSTER_WEB_ORIGINS, now }
    const chain = await verifyRosterChain(roster, pin === undefined ? opts : { ...opts, pinned: pin })
    if (!chain.ok) return no(`roster-${chain.reason}`)
    const proof: DeviceProof = { cert, signer: a.signer, assertion: a.assertion, watt: a.watt, wattSig: a.wattSig }
    const dv = await verifyDevice(proof, { ...opts, roster: chain.value })
    if (!dv.ok) return no(`device-${dv.reason}`)
    return { ok: true as const, value: dv.value }
  }

  /** A check-in signed by W itself: a fresh countersign, the roster from `pin`, and the incident records. */
  private async checkinWith(address: string, W: CryptoKey, Wpub: string, pin: string | undefined) {
    const ch = await post(this.net, ROUTES.challenge, { address })
    if (!ch || ch.status !== 200 || !isObj(ch.body) || !str(ch.body.nonce)) return { net: true as const }
    const wren = buildWren({ devicePub: Wpub, address, challenge: ch.body.nonce })
    const sig = await signStatement(W, wren)
    const r = await post(this.net, ROUTES.checkin, pin === undefined ? { wren, sig } : { wren, sig, pin })
    if (!r) return { net: true as const }
    const incidents = isObj(r.body) && Array.isArray(r.body.incidents) ? r.body.incidents : []
    if (r.status === 200) return { answer: answerOf(r.body), incidents }
    const error = isObj(r.body) && str(r.body.error) ? r.body.error : ''
    return { refused: error, status: r.status, incidents }
  }

  /**
   * Renew the countersign, read the incident records, and re-check the roster.
   * Called on load and every hour. A network failure changes nothing, and
   * neither does a store that fails: the page keeps running and checks in
   * again on the hour.
   */
  async checkIn(): Promise<Status> {
    try { return await this.checkInOnce() } catch { return this.status() }
  }

  /**
   * Another tab may have signed out, or signed in anew, since this one loaded:
   * every write here is made only over the record this check-in started from,
   * and when that record is gone this tab takes what the store now holds.
   */
  private async checkInOnce(): Promise<Status> {
    const h = this.held
    if (!h || this.busy) return this.status()
    const r = await this.checkinWith(h.address, h.W.privateKey, h.Wpub, h.pin)
    if (this.held !== h) return this.status()                  // a ceremony or sign-out replaced it meanwhile
    if ('net' in r) return this.status()
    if (r.incidents.some((i) => covers(i, h.ceremonyAt))) return (await this.end(h.address, 'incident', h.Wpub)) ? this.status() : this.load()
    if ('refused' in r) {
      if (r.refused === 'revoked' || r.refused === 'unknown') return (await this.end(h.address, 'revoked', h.Wpub)) ? this.status() : this.load()
      // 'cap' and anything else: the countersign held runs out on its own
      return this.status()
    }
    const a = r.answer
    if (!a) return this.status()
    const v = await this.verify(h.cert, a, a.roster, h.pin)
    // a sign-out or a new ceremony while the verify ran: what it replaced is never written back
    if (this.held !== h) return this.status()
    if (!v.ok) return (await this.end(h.address, 'invalid', h.Wpub)) ? this.status() : this.load()
    const next: Held = { ...h, watt: a.watt, wattSig: a.wattSig, signer: a.signer, assertion: a.assertion,
      expires: v.value.watt.expires, roster: a.roster }
    // in memory first: a sign-out during the write then deletes after it (IndexedDB runs them in order)
    this.held = next
    // only over the record this check-in renewed: another tab's sign-out or new sign-in stands
    if (!(await this.store.put(next, h.Wpub)) && this.held === next) return this.load()
    return this.status()
  }

  /**
   * A ceremony on the sign-in host, in `win`: the window the caller opened
   * synchronously inside the person's click (a browser blocks a popup opened
   * after an await). `confirm` asks for the account already signed in here:
   * "Confirm it's you" never switches accounts.
   */
  async signIn(win: Window | null, confirm: boolean): Promise<Outcome> {
    if (!win) return no('blocked')
    if (this.busy) return no('busy')
    this.busy = true
    try {
      const expect = confirm ? (this.held?.address ?? this.last?.address ?? null) : null
      // listen before the first await: the host's 'ready' can arrive at once
      const talk = this.talk(win)
      const k = await freshKeys()
      const label = browserLabel()
      const reply = await talk({ t: 'enrol', W: k.Wpub, kx: k.kxPub, label })
      if (reply.t !== 'enrolled') return no(reply.t)

      // a certificate for exactly what was sent
      const c = await parseDeviceCert(reply.wdev)
      if (!c.ok) return no(`cert-${c.reason}`)
      const cert = c.value
      if (cert.kind !== 'wdev' || cert.via !== 'passkey') return no('cert-kind')
      if (cert.devicePub !== k.Wpub || cert.kx !== k.kxPub || cert.label !== label) return no('not-ours')
      if (expect !== null && cert.address !== expect) return no('account')
      const w = parseWatt(reply.watt)
      if (!w.ok || w.value.certHash !== (await sha256b64u(reply.wdev))) return no('watt')

      // the signed countersign, the passkey's assertion and the roster from setup: verified, never believed
      const r = await this.checkinWith(cert.address, k.W.privateKey, k.Wpub, undefined)
      if ('net' in r) return no('network')
      if ('refused' in r) return no(`directory-${r.refused}`)
      if (!r.answer) return no('directory-answer')
      const a = r.answer
      const v = await this.verify(reply.wdev, a, a.roster, undefined)
      if (!v.ok) return no(v.reason)
      if (r.incidents.some((i) => covers(i, cert.ceremonyAt))) return no('incident')

      const held: Held = {
        v: 1, address: cert.address, label, W: k.W, kx: k.kx, Wpub: k.Wpub, kxPub: k.kxPub,
        cert: reply.wdev, signer: a.signer, assertion: a.assertion, watt: a.watt, wattSig: a.wattSig,
        ceremonyAt: cert.ceremonyAt, expires: v.value.watt.expires,
        // from now on the roster is read from the head the certificate names
        roster: a.roster.slice(await indexOfHead(a.roster, cert.rosHash)),
        pin: cert.rosHash,
      }
      await this.store.put(held)          // replaces the old record: the old keys are gone with it
      this.held = held
      this.last = null
      return { ok: true }
    } finally {
      this.busy = false
    }
  }

  /**
   * The conversation with the sign-in window. Messages count only from that
   * window AND the sign-in host's origin; the request goes to that literal
   * origin, once, after the host says it is ready.
   */
  private talk(win: Window) {
    type Reply = { t: 'enrolled'; wdev: string; watt: string } | { t: 'failed' | 'cancelled' | 'closed' | 'timeout' }
    let ready = false
    let request: unknown = null
    let sent = false
    let done: (r: Reply) => void = () => {}
    const result = new Promise<Reply>((resolve) => { done = resolve })
    const send = () => {
      if (ready && request && !sent) { sent = true; win.postMessage(request, SIGNIN_ORIGIN) }
    }
    const onMessage = (e: MessageEvent) => {
      if (e.source !== win || e.origin !== SIGNIN_ORIGIN) return
      const d = e.data
      if (!isObj(d)) return
      if (d.t === 'ready') { ready = true; send(); return }
      if (!sent) return
      if (d.t === 'enrolled' && str(d.wdev) && str(d.watt)) finish({ t: 'enrolled', wdev: d.wdev, watt: d.watt })
      else if (d.t === 'failed' || d.t === 'cancelled') finish({ t: d.t })
    }
    const poll = setInterval(() => { if (win.closed) finish({ t: 'closed' }) }, 500)
    const timer = setTimeout(() => finish({ t: 'timeout' }), CEREMONY_MS)
    const finish = (r: Reply) => {
      removeEventListener('message', onMessage)
      clearInterval(poll)
      clearTimeout(timer)
      done(r)
    }
    addEventListener('message', onMessage)
    return (req: unknown) => { request = req; send(); return result }
  }
}

/** Where the head a certificate names sits in a chain (it was verified to be there). */
async function indexOfHead(links: RosterLink[], rosHash: string): Promise<number> {
  for (let i = 0; i < links.length; i++) if ((await sha256b64u(links[i].ros)) === rosHash) return i
  return 0
}

// --- IndexedDB -------------------------------------------------------------------------

const DB = 'bento-id'
const STORE = 'agent'

function open(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = version === undefined ? indexedDB.open(DB) : indexedDB.open(DB, version)
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE) }
    r.onsuccess = () => {
      const db = r.result
      if (db.objectStoreNames.contains(STORE)) return resolve(db)
      // a database made without the store (by an older page, or anything else on this origin): add it
      const v = db.version + 1
      db.close()
      open(v).then(resolve, reject)
    }
    r.onerror = () => reject(r.error)
  })
}
function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = f(t.objectStore(STORE))
    t.oncomplete = () => resolve(req ? req.result : undefined)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

/** One readwrite transaction: `write` runs only if the stored record's Wpub is `expect` (always when it is undefined). */
async function swap(expect: string | undefined, write: (s: IDBObjectStore) => void): Promise<boolean> {
  const db = await open()
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite')
      const s = t.objectStore(STORE)
      let done = true
      if (expect === undefined) write(s)
      else {
        const g = s.get('held')
        g.onsuccess = () => { if ((g.result as Held | undefined)?.Wpub === expect) write(s); else done = false }
      }
      t.oncomplete = () => resolve(done)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  } finally { db.close() }
}

/** The agent's store: one record for the sign-in held, one for the sign-in that ended. CryptoKeys are stored as keys, never as bytes. */
export const indexedStore: Store = {
  async get() {
    try {
      const db = await open()
      const held = (await tx(db, 'readonly', (s) => s.get('held'))) as Held | undefined
      const last = (await tx(db, 'readonly', (s) => s.get('last'))) as Last | undefined
      db.close()
      return { held: held && held.v === 1 ? held : null, last: last && last.v === 1 && str(last.address) ? last : null }
    } catch { return { held: null, last: null } }
  },
  put(held, expect) {
    return swap(expect, (s) => { s.put(held, 'held'); s.delete('last') })
  },
  end(last, expect) {
    return swap(expect, (s) => { s.delete('held'); if (last) s.put(last, 'last'); else s.delete('last') })
  },
}
