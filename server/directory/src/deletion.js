// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// ACCOUNT DELETION, in the address's Roster object (roster.js hands these ops
// here, as it does the browser ones).
//
// A member asks with `adel.` (kernel/src/roster.ts), an assertion for a
// passkey, a raw signature for the recovery key, a `roster` co-sign for a
// consent key, over a single-use challenge of its own audience (`adel`). The
// deletion is QUEUED like any change: one at a time, 72 hours on the
// directory's clock (DELETE_WAIT_MS), and only once its waiting notice was
// accepted by the mailer, because that notice carries the void link that stops
// it. The rules security set for it (security's review of the kernel layout,
// D-A1 to D-A4):
//
// - D-A1. Cancel on the void page bars the member that asked from asking for
//   anything for 72 hours, whatever its kind (roster.js's void op), so a stolen
//   key cannot re-file the moment it is voided and keep the owner's removal of
//   it out of the one-change queue. Remove (offered only while another live
//   member stays) suspends the asker at once with a `q` link that carries the
//   adel. text and its proof, and queues its removal, as for a member change.
// - D-A2. A reset request DROPS a waiting deletion: never set aside, never
//   brought back by a stopped reset (roster.js's reset op; only a waiting
//   removal is set aside).
// - D-A3. No deletion while anything else waits, an undo window included
//   (the single-pend rule). The way without a passkey is NOT built: whether it
//   is a mailed-link deletion (which would need a member's stop statement so it
//   is no faster or less stoppable than a reset) or "reset, then delete" is the
//   maintainer's call. Until then only a member can ask.
// - D-A4. When the wait ends the deletion is carried out only if it is still
//   the waiting change, the hold is off, and the head is still the one the
//   adel. named. The directory then signs the deletion record (`rdel.`, kernel)
//   FIRST: without the key nothing is removed. It then removes everything the
//   object holds for the account (the chain, the passkeys, the browser
//   certificates, the challenges, the tokens and the event log) and keeps only
//   the record, which it serves where peers fetch the chain: GET /v1/roster,
//   the browser head and check-in, and the certificate status all answer
//   "deleted" with it, never "unknown". A later setup at the address works; the
//   record stays beside the new chain.
// - An opener can never cause a deletion: a request that names one (`rq`) is
//   refused, and the sign-in host never sends one.
//
// How long the record (and anything else) is kept after a deletion is the
// maintainer's to decide; today the record is kept and everything else goes.

import { b64uEnc, sha256b64u, signStatement } from '../../../kernel/src/statements.ts'
import { accountNameOf, buildRdel, parseAdel, parseRos, verifyAdel, DELETE_WAIT_MS } from '../../../kernel/src/roster.ts'
import { PASSKEY } from './passkey.js'

export const DELETION_OPS = Object.freeze(['deleteRequest'])

/** The kinds of void link a deletion's waiting notice carries (links.js): with Remove, or Cancel only. */
export const DELETION_VOID_KINDS = Object.freeze({ remove: 'd', cancelOnly: 'e' })

const when = (t) => new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
const HOW = { setup: 'at setup', browser: 'from a browser', app: 'from an app' }
const hostClass = (origin) => PASSKEY.origins[origin] ?? 'browser'
const KIND_WORD = { pk: 'passkey', rk: 'recovery key', ck: 'app consent key' }

/** A passkey's signature counter, from its authenticatorData (bytes 33..36). */
function counterOf(ad) {
  if (typeof ad !== 'string') return null
  let b
  try { b = Uint8Array.from(atob(ad.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((ad.length + 3) % 4)), (c) => c.charCodeAt(0)) } catch { return null }
  return b.length >= 37 ? ((b[33] << 24) >>> 0) + (b[34] << 16) + (b[35] << 8) + b[36] : null
}

let dirSigner = null
/** The directory's signature over the rdel. text, with its online key; throws when it is not configured. */
async function signRecord(env, rec) {
  if (typeof env.DIR_KEY_JWK !== 'string' || typeof env.DIR_KID !== 'string') throw new Error('DIR_KEY_JWK and DIR_KID are not configured')
  if (!dirSigner || dirSigner.jwk !== env.DIR_KEY_JWK) {
    dirSigner = { jwk: env.DIR_KEY_JWK, key: await crypto.subtle.importKey('jwk', JSON.parse(env.DIR_KEY_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) }
  }
  const text = buildRdel({ ...rec, kid: env.DIR_KID })
  return { text, sig: await signStatement(dirSigner.key, text) }
}

/** The stored deletion record, as peers get it: { text, sig }, or null. */
export async function deletionRecord(s) {
  const r = await s.get('rdel')
  return r && typeof r.text === 'string' && typeof r.sig === 'string' ? { text: r.text, sig: r.sig } : null
}

/**
 * The answers that say "deleted" instead of "unknown" (D-A4), for the browser
 * ops roster.js would otherwise hand to browsers.js. Null when the op should
 * run as usual. Only when the account (or the certificate asked about) is gone
 * and a deletion record stands.
 */
export async function deletedAnswer(obj, a, h) {
  const s = obj.state.storage
  const rec = await deletionRecord(s)
  if (!rec) return null
  if (a.op === 'browserHead') return (await s.get('head')) ? null : h.out(410, { error: 'deleted', deleted: rec })
  if (a.op === 'browserStatus') {
    const pub = typeof a.certHash === 'string' ? await s.get(`wh:${a.certHash}`) : undefined
    return pub ? null : h.out(200, { state: 'deleted', deleted: rec })
  }
  if (a.op === 'browserCheckin') {
    if (typeof a.devicePub === 'string' && (await s.get(`wd:${a.devicePub}`))) return null
    if (!(await h.spend())) return h.out(400, { error: 'nonce' }) // spent first, as every check-in
    return h.out(403, { error: 'deleted', deleted: rec })
  }
  return null
}

/** The roster state the kernel's verifyAdel reads: the stored head (the directory holds the whole chain). */
async function stateOf(obj, cur) {
  const address = (await parseRos(cur.ros)).value.address
  return {
    address, seq: cur.seq, headHash: cur.hash, ripenedAt: cur.ripenedAt, createdAt: await obj.createdAt(cur), lastResetAt: null, sinceExact: false, heads: [],
    members: cur.members.map((m) => ({ ...m, since: cur.ripenedAt })),
  }
}

/**
 * One deletion op on the Roster object `obj`. `h` carries roster.js's own
 * helpers: spend, out, origin, notify, fingerprint, named, rosterLines,
 * voidLines, mintToken.
 */
export async function deletionOp(obj, a, now, h) {
  const s = obj.state.storage
  const { spend, out } = h

  if (a.op === 'deleteRequest') {
    // a text that is not an adel. at all never spends the challenge (the kernel's grammar rule);
    // everything after it is checked only once the challenge is spent
    if (typeof a.text !== 'string' || !parseAdel(a.text)) return out(400, { error: 'grammar' })
    if (!(await spend())) return out(400, { error: 'nonce' })
    if (a.rq !== undefined && a.rq !== '') return out(400, { error: 'rq' }) // an opener never causes a deletion
    await obj.ripen(now)
    const cur = await s.get('head')
    if (!cur) return (await deletionRecord(s)) ? out(410, { error: 'deleted' }) : out(404, { error: 'not-found' })
    // one change at a time: nothing while a change, a reset, a removal (its undo window) or another deletion waits
    if (await s.get('pend')) return out(409, { error: 'pending' })
    if (await obj.held(now)) return out(409, { error: 'pending' })

    // the member who asked: a passkey by its credential, a recovery or consent key by its key
    const byCred = typeof a.credId === 'string' ? await s.get(`cid:${a.credId}`) : undefined
    const signerPub = byCred ?? (typeof a.signer === 'string' ? a.signer : undefined)
    const member = signerPub ? cur.members.find((m) => m.pub === signerPub) : undefined
    if (!member) return out(400, { error: 'signer' })
    if (member.kind === 'pk' && !byCred) return out(400, { error: 'signer' }) // a passkey is named by its credential
    // G4b, for every kind (D-A1): a member whose last request was cancelled from the void page waits 72 hours
    const coolUntil = await s.get(`cool:${member.pub}`)
    if (coolUntil && coolUntil > now) return out(403, { error: 'cooldown', until: coolUntil })
    const proof = member.kind === 'pk' ? { assertion: a.assertion } : member.kind === 'rk' ? { sig: a.sig } : { cns: a.cns, sig: a.sig }

    // the kernel's one verifier (the challenge is already spent: spend() => true)
    const v = await verifyAdel(a.text, member.pub, proof, {
      roster: await stateOf(obj, cur), challenge: a.challenge, spend: () => true, rpId: PASSKEY.rpId, origins: Object.keys(PASSKEY.origins),
      consentRp: 'bento', now,
    })
    if (!v.ok) return out(v.reason === 'roster-head' ? 409 : v.reason === 'quarantined' ? 403 : 400, { error: v.reason })
    // a passkey's counter, in order per credential (the kernel checks the signature, not the count)
    let co = ''
    if (member.kind === 'pk') {
      const rec = await s.get(`pk:${member.pub}`)
      const count = counterOf(a.assertion?.authenticatorData)
      if (!rec || count === null) return out(400, { error: 'assertion' })
      if ((count !== 0 || rec.signCount !== 0) && count <= rec.signCount) return out(400, { error: 'assertion-sign-count' })
      await s.put(`pk:${member.pub}`, { ...rec, signCount: count })
      try { co = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(a.assertion.clientDataJSON.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((a.assertion.clientDataJSON.length + 3) % 4)), (c) => c.charCodeAt(0)))).origin ?? '' } catch { co = '' }
    }

    const address = v.value.address
    const how = member.kind === 'pk' ? hostClass(co) : 'app'
    const vt = await h.mintToken('void')
    // Remove only while another live member would stay once the asker is suspended (G4c)
    const others = cur.members.some((m) => !m.quarantined && m.pub !== member.pub)
    const vk = others ? DELETION_VOID_KINDS.remove : DELETION_VOID_KINDS.cancelOnly
    const p = {
      kind: 'deletion', ros: a.text, hash: await sha256b64u(a.text), headHash: v.value.headHash, change: { op: 'delete', pub: member.pub },
      signer: member.pub, signerKind: member.kind, credId: byCred ? a.credId : null, assertion: proof.assertion, proof,
      requestedAt: now, ripensAt: now + DELETE_WAIT_MS, voidTok: vt.h, voidKind: vk, os: h.origin, rq: '', co, how,
    }
    // the slot first, marked unsent; the notice; then queued only if the mailer took it (D1, D1a)
    await s.put('pend', { ...p, mailed: false })
    const ours = async () => {
      const q = await s.get('pend')
      return !!q && q.mailed === false && q.ros === p.ros && q.requestedAt === p.requestedAt
    }
    const records = await obj.records(cur.members)
    const asker = member.kind === 'pk' ? await h.named(member.pub, records[member.pub])
      : `the ${KIND_WORD[member.kind]} ${await h.fingerprint(member.pub)}`
    const sent = await h.notify(address, 'Your bento/id account is about to be DELETED', [
      `At ${when(now)} someone asked to DELETE this bento/id account, ${HOW[how]}.`,
      `It was asked for by ${asker}.`,
      `The account will be deleted at ${when(p.ripensAt)}, 72 hours after it was asked for. Then every passkey on it stops working, and people can no longer check new work against it.`,
      '',
      'The passkeys on this account now:',
      ...(await h.rosterLines(cur.members, records, null)),
      '',
      ...h.voidLines(address, vt.token, vk, p.ripensAt),
    ], 'roster')
    if (!sent) {
      if (await ours()) await s.delete('pend')
      return out(503, { error: 'mail' })
    }
    if (!(await ours())) return out(409, { error: 'superseded' })
    await s.put('pend', { ...p, mailed: true })
    await obj.schedule(p.ripensAt)
    await obj.log({ k: 'delete-request', at: now, seq: cur.seq, op: 'delete', pub: member.pub, by: member.pub, os: h.origin, rq: '', co })
    return out(202, { requestedAt: now, ripensAt: p.ripensAt })
  }

  return out(400, { error: 'bad-op' })
}

/**
 * The waiting deletion `p` is due (roster.js apply, from ripen: the hold is
 * off and it is the waiting change). Carried out only if the head is still the
 * one it named; otherwise it is dropped and the address is told why.
 */
export async function executeDeletion(obj, p, now, h) {
  const s = obj.state.storage
  // never on a clock read from a missing field: a deletion with no times, or one
  // that claims to be due before its 72 hours, is not carried out (it stays, so
  // a Cancel still finds it)
  if (!Number.isSafeInteger(p.ripensAt) || !Number.isSafeInteger(p.requestedAt) || now < p.ripensAt || now - p.requestedAt < DELETE_WAIT_MS) return false
  const cur = await s.get('head')
  const address = cur ? (await parseRos(cur.ros)).value.address : null
  if (!cur || cur.hash !== p.headHash) {
    // the account changed under it (a revert, any immediate link): it is not carried out
    await s.delete('pend')
    await obj.ended(p.voidTok, 'preempted', now)
    await obj.log({ k: 'delete-dropped', at: now, seq: cur?.seq ?? -1, op: 'delete', pub: p.signer, by: p.signer, why: 'head' })
    if (address) {
      await h.notify(address, 'Your bento/id account was NOT deleted', [
        `The deletion of this account asked for at ${when(p.requestedAt)} was not carried out: the account's passkeys changed while it waited.`,
        'Nothing was deleted. Ask again if you still want the account deleted.',
      ])
    }
    return false
  }
  const name = await accountNameOf(address)
  if (!name) throw new Error('an address with no storage name') // never: the head parsed
  // the record FIRST: without the key nothing is removed
  const rec = await signRecord(obj.env, {
    accountName: b64uEnc(name), lastHeadHash: cur.hash, lastSeq: cur.seq, requestedAt: p.requestedAt, deletedAt: now, by: 'm',
  })
  // everything else the object holds for the account goes
  const keep = new Set(['rdel'])
  for (;;) {
    const keys = [...(await s.list({ limit: 128 })).keys()].filter((k) => !keep.has(k))
    if (!keys.length) break
    await s.delete(keys)
  }
  await s.put('rdel', { ...rec, deletedAt: now })
  // the deletion's own void link answers "deleted", not "unknown" (F2)
  await s.put('ended', [{ h: p.voidTok, why: 'deleted', at: now }])
  if (typeof s.deleteAlarm === 'function') await s.deleteAlarm()
  await h.notify(address, 'Your bento/id account was deleted', [
    `At ${when(now)} this bento/id account was deleted, as asked for at ${when(p.requestedAt)}.`,
    'Its passkeys no longer work, and people can no longer check new work against it. Work signed before now still shows who signed it, marked "account deleted".',
    'You can set up a new account for this address at any time. It starts new: people who knew the old one see that it changed.',
  ])
  return true
}
