// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// THE INCIDENT LEVER (SD5). When bento/home's served code may have been
// hostile over a window [t0, t1], the maintainer pulls this lever. For every
// account that had an event asked for at bento/home's request (ob = 1) in the
// window, it:
//
//   1. revokes each browser certificate enrolled at bento/home's request in
//      the window (`loggedAt` in [t0, t1], `ob` exactly 1). The mark is
//      sticky (revokedBy 'incident'): no later undo, re-add or new head brings
//      the certificate back. A peer that is offline still accepts it until
//      its last countersign expires, 24 hours at most;
//   2. voids a waiting member change asked for at bento/home's request in the
//      window, as a Cancel that suspends nobody and sets no cooldown (the
//      passkey that asked may have done nothing wrong: the page that asked
//      did). A reset or a change asked for elsewhere is left alone, and a
//      hold (F1) is respected: that account is done on a later run;
//   2b. offers, for each member change asked for at bento/home's request in
//      the window that has TAKEN EFFECT and added exactly one passkey, a
//      "Revert this change" link (the void page, kind `v`): pressing it
//      suspends the passkey that change ADDED (kernel authority `l`, which
//      cites the change) and queues its removal 72 hours later (`x`), with an
//      undo link (`u`). It never suspends the passkey that asked. A change
//      that removed a passkey cannot be reverted by the directory (no
//      directory word adds a member): the mail states it in words;
//   3. mails the address once: what was revoked (full fingerprints), what
//      was voided, the changes in the window with their revert links, and
//      the whole roster. This mail kind is never held back by any budget;
//   4. publishes the incident record (open, then closed), signed by the
//      directory's online key as the kernel's `inc.` text: every browser
//      check-in and status answer carries it.
//
// The window is chosen by rq = bento/home, which the sign-in host reports.
// It is only as good as the sign-in host is honest (security's ruling on
// option G): a hostile sign-in host could report another opener.
//
// AUTHORITY. Only POST /v1/lever reaches it, with a command signed by the
// maintainer's OFFLINE lever key (LEVER_PUBKEY, a raw P-256 point; never the
// release key, never DIR_KEY). Empty LEVER_PUBKEY: the route is off. A
// command is fresh (issuedAt within 5 minutes) and its nonce is single use
// (a dry run changes nothing and spends none). The text is the directory's
// own, read by nothing else:
//
//   lvr.<op>.<id>.<t0>.<t1|empty>.<cursor|empty>.<n>.<issuedAt>.<nonce>
//
//   op       open | run | plan | close   (plan: a dry run of run)
//   id       the incident id, [a-z0-9-], at most 63
//   t0, t1   the window (ms, the directory's clock); open has no t1
//   cursor   run/plan: where the last page stopped, <YYYY-MM-DD>~<key|empty>
//   n        run/plan: at most this many accounts in this call (1..50)
//
// The answer is counts only: never an address, a key or a fingerprint.
// The route answers no CORS and is in no public list. The Roster object
// takes the lever's op only on its own path (/lever), which the worker's
// generic call never uses.

import { b64uDec, verifyStatementSig, sha256b64u } from '../../../kernel/src/statements.ts'
import { buildRos, parseRos, ROSTER_WAIT_MS } from '../../../kernel/src/roster.ts'
import { HOME_ORIGIN } from './passkey.js'
import { voidLink } from './links.js'
import { dayOf, putIncident, shardPage, signIncident, spendLeverNonce, storedIncidents } from './obindex.js'
import { HOW, fingerprint, mintToken, named, notify, ownNonce, rosterLines, voidLines, when } from './roster.js'

const MIN = 60_000, DAY = 86_400_000

export const LEVER_ROUTE = '/v1/lever'

export const LEVER_LIMITS = Object.freeze({
  /** a command is refused unless issuedAt is this close to the directory's clock */
  skewMs: 5 * MIN,
  /** a spent nonce is kept this long (longer than a command can be fresh) */
  nonceKeepMs: 15 * MIN,
  /** the most accounts one run call visits (subrequest limits) */
  pageMax: 50,
  /** a revert link's life */
  revertTtlMs: 30 * DAY,
})

const OPS = Object.freeze(['open', 'run', 'plan', 'close'])
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const MS = /^(0|[1-9][0-9]{0,15})$/
const CURSOR = /^([0-9]{4}-[0-9]{2}-[0-9]{2})~([0-9a-f]{64})?$/

/** A lever command's text. */
export function buildLever({ op, id, t0, t1 = null, cursor = '', n = 1, issuedAt, nonce }) {
  return ['lvr', op, id, t0, t1 ?? '', cursor, n, issuedAt, nonce].join('.')
}

/** A command, or null. */
export function parseLever(text) {
  if (typeof text !== 'string' || text.length > 400) return null
  const f = text.split('.')
  if (f.length !== 9 || f[0] !== 'lvr' || !OPS.includes(f[1]) || !ID.test(f[2])) return null
  const [, op, id, t0F, t1F, cursor, nF, issuedF, nonce] = f
  if (!MS.test(t0F) || !(t1F === '' || MS.test(t1F)) || !MS.test(issuedF) || !/^[1-9][0-9]?$/.test(nF) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null
  if (!(cursor === '' || CURSOR.test(cursor))) return null
  const t0 = Number(t0F), t1 = t1F === '' ? null : Number(t1F), n = Number(nF)
  if (t0 <= 0 || n > LEVER_LIMITS.pageMax) return null
  if (op === 'open' ? t1 !== null || cursor !== '' : t1 === null || t1 < t0) return null
  if (op === 'close' && cursor !== '') return null
  return { op, id, t0, t1, cursor, n, issuedAt: Number(issuedF), nonce }
}

const nextDay = (day) => dayOf(Date.parse(day) + DAY)
const ZERO = Object.freeze({ visited: 0, accounts: 0, certificates: 0, voids: 0, reverts: 0, words: 0, mails: 0, held: 0, already: 0, skipped: 0, mailFailed: 0 })

/**
 * POST /v1/lever { cmd, sig }. `json(status, body)` answers with the base
 * headers (no CORS). Order: the route is on, the command reads, its signature,
 * its freshness, then its nonce is spent (a dry run spends none), then it acts.
 */
export async function leverRoute(req, env, json) {
  const pub = env.LEVER_PUBKEY
  if (typeof pub !== 'string' || pub.length === 0) return json(403, { error: 'lever-off' })
  let b = null
  try { b = await req.json() } catch { /* refused below */ }
  if (!b || typeof b !== 'object' || typeof b.cmd !== 'string' || typeof b.sig !== 'string') return json(400, { error: 'bad-request' })
  const c = parseLever(b.cmd)
  if (!c) return json(400, { error: 'cmd' })
  if (!(await verifyStatementSig(pub, b.sig, b.cmd))) return json(401, { error: 'sig' })
  const now = Date.now()
  if (Math.abs(now - c.issuedAt) > LEVER_LIMITS.skewMs) return json(401, { error: 'stale' })
  if (c.op !== 'plan' && !(await spendLeverNonce(env, c.nonce, now + LEVER_LIMITS.nonceKeepMs))) return json(403, { error: 'replay' })

  const records = await storedIncidents(env)
  const rec = records.find((r) => r.id === c.id) ?? null

  if (c.op === 'open') {
    if (rec) return rec.from === c.t0 && rec.to === null ? json(200, { ok: true, record: { id: rec.id, from: rec.from, to: rec.to } }) : json(409, { error: 'exists' })
    if (c.t0 > now) return json(400, { error: 'future' })
    const r = await signIncident(env, { id: c.id, from: c.t0, to: null, issuedAt: now })
    await putIncident(env, r)
    return json(200, { ok: true, record: { id: r.id, from: r.from, to: r.to } })
  }
  if (c.op === 'close') {
    if (!rec) return json(404, { error: 'no-incident' })
    if (rec.from !== c.t0 || c.t1 <= rec.from || c.t1 > now) return json(400, { error: 'window' })
    if (rec.to !== null) return rec.to === c.t1 ? json(200, { ok: true, record: { id: rec.id, from: rec.from, to: rec.to } }) : json(409, { error: 'closed' })
    const r = await signIncident(env, { id: c.id, from: rec.from, to: c.t1, issuedAt: now })
    await putIncident(env, r)
    return json(200, { ok: true, record: { id: r.id, from: r.from, to: r.to } })
  }

  // run / plan: one page of accounts, from the cursor
  if (!rec) return json(404, { error: 'no-incident' })
  if (c.t0 < rec.from || c.t1 > now) return json(400, { error: 'window' })
  const last = dayOf(c.t1)
  const m = CURSOR.exec(c.cursor)
  let day = m ? m[1] : dayOf(c.t0), after = m?.[2] ?? ''
  if (day < dayOf(c.t0) || day > last) return json(400, { error: 'cursor' })
  const counts = { ...ZERO }
  let budget = c.n
  while (budget > 0 && day <= last) {
    const page = await shardPage(env, day, after, budget)
    for (const key of page.keys) {
      const r = await env.ROSTER.get(env.ROSTER.idFromName(key)).fetch('https://roster/lever', {
        method: 'POST', body: JSON.stringify({ id: c.id, t0: c.t0, t1: c.t1, op: c.op === 'plan' ? 'leverPlan' : 'lever' }),
      })
      if (!r.ok) throw new Error(`lever: an account answered ${r.status}`) // the cursor does not move: a re-run resumes here
      const got = await r.json()
      for (const k of Object.keys(ZERO)) counts[k] += Number.isSafeInteger(got[k]) ? got[k] : 0
      budget--
      after = key
    }
    if (!page.more) { day = nextDay(day); after = '' }
  }
  const next = day <= last ? `${day}~${after}` : null
  return json(200, { ok: true, dry: c.op === 'plan', next, counts })
}

// --- in the account's Roster object (roster.js hands the /lever path here) ----------

/** A 64-hex SHA-256 over a key's raw point: the FULL fingerprint the incident mail names. */
async function fullPrint(pub) {
  const raw = b64uDec(pub)
  return raw ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map((x) => x.toString(16).padStart(2, '0')).join('') : '?'
}
const pad = (n) => String(n).padStart(8, '0')

/** The member change a link made: { op: 'add'|'remove'|'other', pub }. */
async function diffLink(prevRos, ros) {
  const a = (await parseRos(prevRos)).value, b = (await parseRos(ros)).value
  if (!a || !b) return { op: 'other' }
  const was = new Set(a.members.map((m) => m.pub)), is = new Set(b.members.map((m) => m.pub))
  const added = b.members.filter((m) => !was.has(m.pub)), removed = a.members.filter((m) => !is.has(m.pub))
  if (added.length === 1 && removed.length === 0) return { op: 'add', pub: added[0].pub }
  if (removed.length === 1 && added.length === 0) return { op: 'remove', pub: removed[0].pub }
  return { op: 'other' }
}

/**
 * The lever's op for one account: `lever` acts, `leverPlan` only counts
 * (reads, never ripens, stores nothing). Idempotent per incident id: once an
 * account's mail went, `lever:<id>` marks it done and a re-run does nothing.
 */
export async function leverOp(obj, a, now) {
  const s = obj.state.storage
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (typeof a.id !== 'string' || !ID.test(a.id) || !Number.isSafeInteger(a.t0) || !Number.isSafeInteger(a.t1) || a.t1 < a.t0) return out(400, { error: 'invalid' })
  const dry = a.op === 'leverPlan'
  const counts = { ...ZERO, visited: 1 }
  const inWin = (t) => Number.isSafeInteger(t) && t >= a.t0 && t <= a.t1
  if (!dry) await obj.ripen(now)
  const head = await s.get('head')
  if (!head) return out(200, { ...counts, skipped: 1 }) // no account (or a deleted one): nothing to do, never an error
  if ((await s.get(`lever:${a.id}`))?.done) return out(200, { ...counts, already: 1 })
  const address = (await parseRos(head.ros)).value.address

  // 1. the browser certificates enrolled at bento/home's request in the window
  const hits = []
  for (const [key, rec] of await s.list({ prefix: 'wd:' })) {
    if (rec.ob === 1 && inWin(rec.loggedAt) && !rec.revokedAt) hits.push([key, rec])
  }
  counts.certificates = hits.length

  // 2. a waiting member change asked for at bento/home's request in the window
  const p = await s.get('pend')
  const voidable = p && (p.kind ?? 'member') === 'member' && p.rq === HOME_ORIGIN && inWin(p.requestedAt) ? p : null
  const held = voidable ? await obj.held(now) : null

  // 2b. member changes that took effect, asked for at bento/home's request in the window
  const offers = [], words = []
  for (const [, l] of await s.list({ prefix: 'link:' })) {
    if (l.kind !== 'member' || l.rq !== HOME_ORIGIN || !inWin(l.requestedAt)) continue
    const seq = (await parseRos(l.ros)).value?.seq ?? 0
    const prev = await s.get(`link:${pad(seq - 1)}`)
    const d = prev ? await diffLink(prev.ros, l.ros) : { op: 'other' }
    const entry = { seq, requestedAt: l.requestedAt, ripenedAt: l.ripenedAt, how: l.how, signer: l.signer, ...d }
    if (d.op !== 'add') { words.push({ ...entry, why: 'remove' }); continue }
    const m = head.members.find((x) => x.pub === d.pub)
    if (!m || m.quarantined) words.push({ ...entry, why: 'gone' })
    else if (!head.members.some((x) => !x.quarantined && x.pub !== d.pub)) words.push({ ...entry, why: 'only' })
    else offers.push(entry)
  }
  counts.reverts = offers.length
  counts.words = words.length
  // a run whose mail failed (or that a hold stopped) revoked these already: they are still this run's to mail
  const revokedEarlier = [...(await s.list({ prefix: 'wd:' })).values()].filter((r) => r.incident === a.id)
  const affected = hits.length + revokedEarlier.length > 0 || !!voidable || offers.length > 0 || words.length > 0
  counts.voids = voidable && !held ? 1 : 0
  counts.held = held ? 1 : 0
  counts.accounts = affected ? 1 : 0
  counts.mails = affected && !held ? 1 : 0
  if (dry) return out(200, counts)

  // 1: sticky marks (security's N1 on #957): standing() reads revokedAt before membership
  for (const [key, rec] of hits) await s.put(key, { ...rec, revokedAt: now, revokedBy: 'incident', incident: a.id })
  if (!affected) {
    await s.put(`lever:${a.id}`, { done: true, at: now, mailed: false })
    return out(200, counts)
  }
  // F1: a Remove's or a reset's mail is going out; what it says must stay true. Come back on a later run.
  if (held) return out(200, counts)

  if (voidable) {
    // cancel semantics: nobody suspended, no cooldown, and the link answers how it ended (F2)
    await s.delete('pend')
    await obj.ended(voidable.voidTok, 'incident', now)
    await obj.log({ k: 'void', at: now, seq: head.seq + 1, op: voidable.change.op, pub: voidable.change.pub, by: voidable.signer ?? '', choice: 'incident', incident: a.id, os: '', rq: '' })
  }

  // revert links: minted afresh on every run that mails (a run whose mail failed leaves none behind)
  for (const [k, v] of await s.list({ prefix: 'rv:' })) if (v.id === a.id) await s.delete(k)
  const links = []
  for (const o of offers) {
    const t = await mintToken('void')
    await s.put(`rv:${t.h}`, { id: a.id, seq: o.seq, target: o.pub, exp: now + LEVER_LIMITS.revertTtlMs })
    links.push({ ...o, link: voidLink(address, t.token, 'v'), exp: now + LEVER_LIMITS.revertTtlMs })
  }

  const revoked = [...(await s.list({ prefix: 'wd:' })).entries()].filter(([, r]) => r.incident === a.id)
  const records = await obj.records(head.members)
  const lines = [
    `bento/id found a security problem that may have affected what bento/home did in browsers between ${when(a.t0)} and ${when(a.t1)} (incident ${a.id}).`,
    'Here is what we did on this account, and what you can do.',
  ]
  if (revoked.length) {
    lines.push('', `At ${when(now)} we signed out these browsers, which were signed in through bento/home during that time:`)
    for (const [key, r] of revoked) lines.push(`  - browser key ${await fullPrint(key.slice(3))}, signed in ${when(r.loggedAt)} with the passkey ${await fingerprint(r.signer)}`)
    lines.push('Apps and other browsers keep working. Anything those browsers signed can still be accepted for up to 24 hours.')
  }
  if (voidable) {
    const what = voidable.change.op === 'add' ? `add the passkey ${await fingerprint(voidable.change.pub)}` : `remove the passkey ${await fingerprint(voidable.change.pub)}`
    lines.push('', `We stopped a change that was waiting: ${what}, asked for at ${when(voidable.requestedAt)} through bento/home by ${await named(voidable.signer, records[voidable.signer])}. Nothing changed.`,
      'That passkey is not suspended and can ask for the change again at once, if you want it.')
  }
  if (links.length || words.length) lines.push('', 'These changes were asked for through bento/home during that time and are now in effect:')
  for (const l of links) {
    lines.push(`  - at ${when(l.ripenedAt)}: the passkey ${await fingerprint(l.pub)} was added (asked for at ${when(l.requestedAt)} ${HOW[l.how] ?? 'from a browser'}).`,
      '    If you did not ask for it, open this link to revert it:', '', `    ${l.link}`, '',
      `    It suspends that passkey at once and removes it 72 hours later; the passkey that asked is not touched. It works once, until ${when(l.exp)}.`)
  }
  for (const w of words) {
    const fp = w.pub ? await fingerprint(w.pub) : null
    if (w.why === 'remove') lines.push(`  - at ${when(w.ripenedAt)}: the passkey ${fp} was removed. If you did not ask for that, add it again from a device you trust.`)
    else if (w.why === 'gone') lines.push(`  - at ${when(w.ripenedAt)}: the passkey ${fp} was added. It is no longer on this account, or is suspended, so there is nothing to revert.`)
    else if (w.why === 'only') lines.push(`  - at ${when(w.ripenedAt)}: the passkey ${fp} was added. It is the only usable passkey on this account, so it cannot be removed from here. If you do not recognise it, reset the account.`)
    else lines.push(`  - at ${when(w.ripenedAt)}: a change was made to this account's passkeys.`)
  }
  lines.push('', 'To sign in again, use bento/home or your app: each browser asks for one of your passkeys.',
    '', 'The passkeys on this account now:', ...(await rosterLines(head.members, records, null)))
  // never budgeted (mail.js MAIL_KINDS incident: 'never')
  const sent = await notify(obj.env, address, 'Security incident: what bento/id did on your account', lines, 'incident')
  if (!sent) { counts.mails = 0; counts.mailFailed = 1; return out(200, counts) } // not marked done: a re-run mails again
  await s.put(`lever:${a.id}`, { done: true, at: now, mailed: true })
  await obj.log({ k: 'lever', at: now, seq: head.seq, incident: a.id, n: revoked.length, voided: voidable ? 1 : 0, offers: links.length, os: '', rq: '' })
  return out(200, counts)
}

/**
 * The void page's "Revert this change" (a `v` link from the incident mail).
 * The token is the whole authority, single use, with no count of wrong ones.
 * The passkey the cited change ADDED is suspended at once (an `l` link that
 * carries the change) and its removal queued 72 hours later (`x`), with an
 * undo link; the passkey that asked is never touched.
 */
export async function leverRevert(obj, th, now, origin, out) {
  const s = obj.state.storage
  const rv = await s.get(`rv:${th}`)
  if (!rv) {
    const e = await obj.endedAnswer(th)
    return e ? out(409, e) : out(400, { error: 'invalid' })
  }
  if (now >= rv.exp) {
    await s.delete(`rv:${th}`)
    await obj.ended(th, 'late', rv.exp)
    return out(409, { error: 'late', at: rv.exp })
  }
  if (await obj.held(now)) return out(409, { error: 'busy' })
  const cur = await s.get('head')
  const m = cur.members.find((x) => x.pub === rv.target)
  if (!m || m.quarantined) {
    // already gone or suspended: nothing is written, and the link has ended
    await s.delete(`rv:${th}`)
    await obj.ended(th, 'gone', now)
    return out(409, { error: 'gone', at: now })
  }
  if (await s.get('pend')) return out(409, { error: 'pending' })
  if (!cur.members.some((x) => !x.quarantined && x.pub !== rv.target)) return out(409, { error: 'last-live' }) // never lock the person out (G4c)
  const cited = await s.get(`link:${pad(rv.seq)}`), before = await s.get(`link:${pad(rv.seq - 1)}`)
  if (!cited || !before) return out(409, { error: 'gone', at: now })

  const address = (await parseRos(cur.ros)).value.address
  const records = await obj.records(cur.members)
  const marked = cur.members.map((x) => (x.pub === rv.target ? { ...x, quarantined: true } : x))
  const lRos = buildRos({ address, seq: cur.seq + 1, prev: cur.hash, members: marked, dirNonce: ownNonce(), created: now })
  const lHash = await sha256b64u(lRos)
  const left = marked.filter((x) => x.pub !== rv.target)
  const xRos = buildRos({ address, seq: cur.seq + 2, prev: lHash, members: left, dirNonce: ownNonce(), created: now })
  const removesAt = now + ROSTER_WAIT_MS
  const ut = await mintToken('void')
  // F1: the undo link must reach the person before anything changes, and stay true while it goes
  const hold = await obj.takeHold(now, 'revert')
  const sent = await notify(obj.env, address, 'A passkey on your bento/id account was suspended', [
    `At ${when(now)} the link in the security incident email reverted the change that added ${await named(rv.target, records[rv.target])}.`,
    `That passkey can no longer be used. It will be removed from this account at ${when(removesAt)}. The passkey that asked for the change is not affected.`,
    '',
    'The passkeys on this account once it is removed:',
    ...(await rosterLines(left, records, null)),
    '',
    ...voidLines(address, ut.token, 'u', removesAt),
  ], 'void')
  if (!sent) {
    await obj.dropHold(hold)
    return out(503, { error: 'mail' })
  }
  const atHead = await s.get('head')
  if (atHead.hash !== cur.hash || (await s.get('pend')) || !(await s.get(`rv:${th}`))) { await obj.dropHold(hold); return out(409, (await obj.endedAnswer(th)) ?? { error: 'superseded' }) }
  if ((await s.get('hold'))?.id !== hold) return out(409, { error: 'busy' })
  await obj.link(lRos, { auth: 'l', cause: await sha256b64u(cited.ros), requestedAt: now, now, kind: 'revert',
    extra: { cited: { prevRos: before.ros, ros: cited.ros, rip: cited.rip, ripSig: cited.ripSig }, incident: rv.id } })
  // the removal is requested at the moment the suspension takes effect (the kernel's x rule)
  await s.put('pend', {
    kind: 'removal', ros: xRos, hash: await sha256b64u(xRos), change: { op: 'remove', pub: rv.target }, cause: lHash,
    requestedAt: now, ripensAt: removesAt, mailed: true, voidTok: ut.h, voidKind: 'u',
  })
  await s.delete(`rv:${th}`)
  await obj.ended(th, 'used', now)
  await obj.dropHold(hold)
  await obj.schedule(removesAt)
  await obj.log({ k: 'revert', at: now, seq: cur.seq + 1, pub: rv.target, incident: rv.id, os: origin, rq: '' })
  return out(200, { done: 'reverted', removesAt })
}
