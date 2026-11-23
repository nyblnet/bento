#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The incident lever's command line (src/lever.js). The MAINTAINER runs it,
// with the offline lever key whose public half the directory holds as
// LEVER_PUBKEY. It is a DRY RUN unless --apply is given: a dry run sends only
// `plan` commands, which change nothing and spend no nonce. It prints counts,
// never an address or a key (the directory never answers with one).
//
//   node server/directory/lever.mjs keygen --out lever-key.jwk
//       a fresh P-256 key (keep it offline); prints the LEVER_PUBKEY value
//   node server/directory/lever.mjs --directory https://id.bento.page --key lever-key.jwk --id <id> open  --t0 <time> [--apply]
//   node server/directory/lever.mjs --directory https://id.bento.page --key lever-key.jwk --id <id> run   --t0 <time> --t1 <time> [--page 25] [--cursor c] [--apply]
//   node server/directory/lever.mjs --directory https://id.bento.page --key lever-key.jwk --id <id> close --t0 <time> --t1 <time> [--apply]
//   node server/directory/lever.mjs devvars --out server/directory/.dev.vars --key <scratch path>/drill-key.jwk
//       a local directory's test configuration, with fresh TEST keys (see --drill); refuses if either file exists
//   node server/directory/lever.mjs --drill --directory http://127.0.0.1:8787 --key <scratch path>/drill-key.jwk
//
// <time> is epoch milliseconds or an ISO time (2026-11-20T09:00:00Z), the
// directory's clock. `run` pages through the day index until it is done; an
// interrupted run is resumed with the last printed --cursor (or simply run
// again: every account is done once per incident id).
//
// --drill runs on a LOCAL directory only (loopback: 127.0.0.1, localhost or
// [::1]) and refuses any other host before it sends anything. Start one with
// test keys, from server/directory:
//
//   node lever.mjs devvars --out .dev.vars --key <scratch path>/drill-key.jwk
//   npx wrangler dev --port 8787 --ip 127.0.0.1
//
// (`devvars` writes DEV=1, MAILER=log, a fresh test DIR_KEY_JWK with its
// DIR_KID and DIR_PUBKEYS, a CHALLENGE_KEY, and LEVER_PUBKEY for the drill key
// it writes beside it; wrangler dev reads .dev.vars, which git ignores.) The
// drill first seeds a VICTIM through the public routes (drill.mjs): a browser
// enrolled at bento/home's request and a waiting change asked for there. It
// then opens an incident, plans, runs, runs again and closes, and fails unless
// the run revoked at least one certificate and voided at least one change, and
// the victim reads back revoked by the incident (naming its id), with no
// waiting change and an incident mail. The drill reads the local directory's
// logged mail through POST /v1/dev/mail, each request signed by the drill key
// (src/devdrill.js). CI runs the same drill in process
// against the in-memory directory (scripts/test-directory-lever.ts).

import { access, readFile, unlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { b64uEnc, signStatement } from '../../kernel/src/statements.ts'
import { verifyInc } from '../../kernel/src/devices.ts'
import { buildLever, LEVER_ROUTE, LEVER_LIMITS } from './src/lever.js'
import { seedVictim, readBack } from './drill.mjs'

const COUNTS = ['visited', 'accounts', 'certificates', 'voids', 'reverts', 'words', 'mails', 'held', 'already', 'skipped', 'mailFailed']
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Is `url` a local directory the drill may touch? Exactly a loopback host, http or https, nothing else in it. */
export function loopback(url) {
  let u
  try { u = new URL(url) } catch { return false }
  return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname) && !u.username && !u.password
}

function args(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply' || a === '--drill') o[a.slice(2)] = true
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i]
    else o._.push(a)
  }
  return o
}
const time = (v) => (v === undefined ? null : /^[0-9]+$/.test(v) ? Number(v) : Date.parse(v))
const nonce = () => b64uEnc(crypto.getRandomValues(new Uint8Array(18)))

async function keyFrom(path, io) {
  const jwk = JSON.parse(await io.readFile(path, 'utf8'))
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

/**
 * The command line. `io` = { fetch, log, now, readFile, writeFile }, for the
 * rig. Returns { code, totals, steps } (code 0 = success; 3 = a run left accounts to finish, so run it again).
 */
export async function main(argv, io = {}) {
  const exists = (path) => access(path).then(() => true, () => false)
  io = { fetch: globalThis.fetch, log: console.log, now: Date.now, readFile, writeFile, unlink, exists, ...io }
  const o = args(argv)
  const say = io.log

  if (o._[0] === 'keygen') {
    if (!o.out) { say('keygen needs --out <path>'); return { code: 2 } }
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    await io.writeFile(o.out, JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)), { mode: 0o600 })
    say(`wrote ${o.out}; LEVER_PUBKEY = ${b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))}`)
    return { code: 0 }
  }

  if (o._[0] === 'devvars') {
    // a LOCAL directory's configuration: every key in it is a fresh test key, never a real one
    if (!o.out || !o.key) { say('devvars needs --out <path for .dev.vars> --key <path for the drill key>'); return { code: 2 } }
    const p256 = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const raw = async (kp) => b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
    const dir = await p256(), lev = await p256()
    const vars = {
      DEV: '1', MAILER: 'log', DIR_KID: 'dev-1',
      DIR_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', dir.privateKey)),
      DIR_PUBKEYS: JSON.stringify([{ kid: 'dev-1', pub: await raw(dir) }]),
      CHALLENGE_KEY: b64uEnc(crypto.getRandomValues(new Uint8Array(32))),
      LEVER_PUBKEY: await raw(lev),
    }
    // never over an existing file: it may be someone's real local configuration. Both are checked before
    // either is written, so a refusal leaves nothing behind ('wx' still refuses a file that appears meanwhile)
    const taken = []
    for (const f of [o.key, o.out]) if (await io.exists(f)) taken.push(f)
    if (taken.length) { say(`devvars refuses to write over ${taken.join(' and ')}: remove it, or choose another path`); return { code: 2 } }
    let wroteKey = false
    try {
      await io.writeFile(o.key, JSON.stringify(await crypto.subtle.exportKey('jwk', lev.privateKey)), { mode: 0o600, flag: 'wx' })
      wroteKey = true
      await io.writeFile(o.out, Object.entries(vars).map(([k, v]) => `${k}=${/^[A-Za-z0-9_-]*$/.test(v) ? v : `'${v}'`}\n`).join(''), { mode: 0o600, flag: 'wx' })
    } catch (e) {
      if (wroteKey) await io.unlink(o.key).catch(() => {}) // a key without its .dev.vars is an orphan
      if (e?.code !== 'EEXIST') throw e
      say(`devvars refuses to write over ${e.path ?? 'an existing file'}: it appeared while devvars ran`); return { code: 2 }
    }
    say(`wrote ${o.out} (test keys, local only) and the drill key ${o.key}`)
    return { code: 0 }
  }

  if (typeof o.directory !== 'string') { say('needs --directory <url>'); return { code: 2 } }
  // the drill touches a local directory only: refused here, before anything is sent anywhere
  if (o.drill && !loopback(o.directory)) { say(`--drill runs against a local directory only (127.0.0.1, localhost or [::1]), never ${o.directory}`); return { code: 2 } }
  if (typeof o.key !== 'string') { say('needs --key <path to the lever key (JWK)>'); return { code: 2 } }
  const key = await keyFrom(o.key, io)
  const base = o.directory.replace(/\/+$/, '')

  const send = async (c) => {
    const cmd = buildLever({ ...c, issuedAt: io.now(), nonce: nonce() })
    const r = await io.fetch(base + LEVER_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, sig: await signStatement(key, cmd) }) })
    let body = {}
    try { body = await r.json() } catch { /* shown as the status */ }
    return { status: r.status, body }
  }
  const page = Math.min(Number(o.page ?? 25) || 25, LEVER_LIMITS.pageMax)
  /** run or plan to the end, from `cursor`; prints the cursor after each page so an interrupted run can resume */
  const sweep = async (op, id, t0, t1, cursor = '') => {
    const totals = Object.fromEntries(COUNTS.map((k) => [k, 0]))
    for (let calls = 0; ; calls++) {
      if (calls > 100_000) { say('stopped: too many pages'); return { ok: false, totals } }
      const r = await send({ op, id, t0, t1, cursor, n: page })
      if (r.status !== 200) { say(`${op}: ${r.status} ${r.body.error ?? ''}${cursor ? ` (resume with --cursor ${cursor})` : ''}`); return { ok: false, totals } }
      for (const k of COUNTS) totals[k] += Number(r.body.counts?.[k]) || 0
      if (r.body.next === null) return { ok: true, totals }
      // a cursor that does not move would page forever: stop, and say where
      if (typeof r.body.next !== 'string' || r.body.next === cursor) { say(`${op}: the directory's cursor did not move (${cursor || 'start'}); stopped`); return { ok: false, totals } }
      cursor = r.body.next
      if (op === 'run') say(`cursor ${cursor}`)
    }
  }
  const show = (label, t) => say(`${label}: ${COUNTS.map((k) => `${k} ${t[k]}`).join(', ')}`)

  if (o.drill) return drill({ send, sweep, show, say, io, base, key })

  const [op] = o._
  const id = o.id, t0 = time(o.t0), t1 = time(o.t1)
  if (!['open', 'run', 'close'].includes(op) || typeof id !== 'string' || !Number.isSafeInteger(t0) || (op !== 'open' && !Number.isSafeInteger(t1))) {
    say('usage: --directory <url> --key <jwk> --id <id> open|run|close --t0 <time> [--t1 <time>] [--apply]'); return { code: 2 }
  }
  if (op === 'run' || !o.apply) {
    // a dry run of the sweep, always first: what the run would do, counted
    const plan = await sweep('plan', id, t0, t1 ?? io.now(), '')
    if (!plan.ok) return { code: 1 }
    show(`plan ${id} [${t0}, ${t1 ?? 'now'}]`, plan.totals)
    say('(a dry run marks nothing, so an account with events on several days of the window is counted once per day)')
    if (!o.apply) { say(`dry run: nothing was changed. Add --apply to ${op}.`); return { code: 0, totals: plan.totals } }
  }
  if (op === 'open' || op === 'close') {
    const r = await send({ op, id, t0, t1: op === 'close' ? t1 : null })
    say(`${op} ${id}: ${r.status} ${JSON.stringify(r.body.record ?? r.body.error ?? '')}`)
    return { code: r.status === 200 ? 0 : 1 }
  }
  const run = await sweep('run', id, t0, t1, o.cursor ?? '')
  show(`run ${id}`, run.totals)
  // an account a hold stopped, or whose mail failed, is not finished: say so, and do not exit 0
  const left = run.totals.held + run.totals.mailFailed
  if (run.ok && left > 0) say(`${left} account(s) not finished (another mail was going out, or the incident mail failed): run the same command again later; it acts only on what is left.`)
  return { code: run.ok ? (left > 0 ? 3 : 0) : 1, totals: run.totals }
}

/** The drill: seed a victim, open, plan, run, run again, close, and read the victim and the record back, each checked. */
async function drill({ send, sweep, show, say, io, base, key }) {
  const fails = []
  const check = (c, what) => { say(`${c ? 'ok  ' : 'FAIL'} ${what}`); if (!c) fails.push(what) }
  const id = `drill-${b64uEnc(crypto.getRandomValues(new Uint8Array(6))).toLowerCase().replace(/[^a-z0-9]/g, '0')}`
  // the victim first, before the incident opens (an open incident may refuse a new browser, INCIDENT_ENROL)
  const seed = await seedVictim({ fetch: io.fetch, base, now: io.now, key })
  check(seed.ok, seed.ok ? 'seeded a victim: an ob=1 browser and a waiting ob=1 change' : `seeding the victim failed at ${seed.step} (${seed.status} ${seed.error ?? ''})`)
  if (!seed.ok) { say(`drill FAILED: ${fails.length}`); return { code: 1, id } }
  const now = io.now(), t0 = now - 60 * 60_000
  const o = await send({ op: 'open', id, t0, t1: null })
  check(o.status === 200 && o.body.record?.to === null, `open ${id} (${o.status})`)
  const plan = await sweep('plan', id, t0, io.now(), '')
  check(plan.ok, 'plan')
  show('plan', plan.totals)
  const run = await sweep('run', id, t0, io.now(), '')
  check(run.ok && run.totals.accounts === plan.totals.accounts && run.totals.certificates === plan.totals.certificates, 'run did what the plan counted')
  show('run', run.totals)
  // a sweep that does nothing satisfies every equality above: the run must have acted
  check(run.totals.accounts >= 1 && run.totals.certificates >= 1 && run.totals.mails >= 1, 'the run revoked a certificate and mailed')
  check(run.totals.voids >= 1, 'the run voided a waiting change')
  const back = await readBack({ fetch: io.fetch, base, key, now: io.now }, seed.victim)
  check(back.cert.state === 'revoked' && back.cert.by === 'incident' && back.cert.incident === id, `the victim's browser is revoked by ${id} (${back.cert.state}, ${back.cert.by ?? '-'}, ${back.cert.incident ?? '-'})`)
  check(back.pending === null, "the victim's waiting change is gone")
  check(back.incidentMails === 1, `the victim was mailed once about the incident (${back.incidentMails})`)
  const again = await sweep('run', id, t0, io.now(), '')
  check(again.ok && again.totals.mails === 0 && again.totals.certificates === 0 && again.totals.voids === 0, 'a second run changes nothing and mails nobody')
  const t1 = io.now()
  const c = await send({ op: 'close', id, t0, t1 })
  check(c.status === 200 && c.body.record?.to === t1, `close ${id} (${c.status})`)
  const st = await io.fetch(`${base}/v1/device/status?e=${encodeURIComponent('drill@example.invalid')}&c=${'A'.repeat(43)}`)
  const rec = ((await st.json().catch(() => ({}))).incidents ?? []).find((x) => x.id === id)
  check(!!rec && rec.from === t0 && rec.to === t1 && typeof rec.inc === 'string', 'the closed record is served')
  const keys = await (await io.fetch(`${base}/v1/keys`)).json().catch(() => ({}))
  const dk = Object.fromEntries((Array.isArray(keys.keys) ? keys.keys : []).filter((k) => k && typeof k.kid === 'string').map((k) => [k.kid, k.pub]))
  if (Object.keys(dk).length) {
    const v = rec ? await verifyInc(rec.inc, rec.sig, { directoryKeys: dk, now: io.now() }) : { ok: false }
    check(v.ok && v.value.to === t1 && v.value.to <= v.value.issuedAt, 'its inc. verifies under the published directory keys')
  } else say('note: /v1/keys lists no key, so the record\'s signature was not checked here')
  say(fails.length ? `drill FAILED: ${fails.length}` : 'drill passed')
  return { code: fails.length ? 1 : 0, totals: run.totals, plan: plan.totals, id, victim: seed.victim }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit((await main(process.argv.slice(2))).code)
}
