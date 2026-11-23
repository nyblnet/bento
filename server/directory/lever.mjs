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
//   node server/directory/lever.mjs --drill --directory http://127.0.0.1:8787 --key drill-key.jwk
//
// <time> is epoch milliseconds or an ISO time (2026-11-20T09:00:00Z), the
// directory's clock. `run` pages through the day index until it is done; an
// interrupted run is resumed with the last printed --cursor (or simply run
// again: every account is done once per incident id).
//
// --drill runs open, plan, run and close on a LOCAL directory only (loopback:
// 127.0.0.1, localhost or [::1]; `npx wrangler dev --port 8787 --var DEV:1
// --var MAILER:log --var LEVER_PUBKEY:<the drill key's value>`) and checks
// each answer. It refuses any other host before it sends anything. CI runs
// the same drill in process against the in-memory directory
// (scripts/test-directory-lever.ts), with seeded accounts.

import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { b64uEnc, signStatement } from '../../kernel/src/statements.ts'
import { verifyInc } from '../../kernel/src/devices.ts'
import { buildLever, LEVER_ROUTE, LEVER_LIMITS } from './src/lever.js'

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
  io = { fetch: globalThis.fetch, log: console.log, now: Date.now, readFile, writeFile, ...io }
  const o = args(argv)
  const say = io.log

  if (o._[0] === 'keygen') {
    if (!o.out) { say('keygen needs --out <path>'); return { code: 2 } }
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    await io.writeFile(o.out, JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)), { mode: 0o600 })
    say(`wrote ${o.out}; LEVER_PUBKEY = ${b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))}`)
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

  if (o.drill) return drill({ send, sweep, show, say, io, base })

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

/** The drill: open, plan, run, run again, close, and read the record back, each checked. */
async function drill({ send, sweep, show, say, io, base }) {
  const fails = []
  const check = (c, what) => { say(`${c ? 'ok  ' : 'FAIL'} ${what}`); if (!c) fails.push(what) }
  const id = `drill-${b64uEnc(crypto.getRandomValues(new Uint8Array(6))).toLowerCase().replace(/[^a-z0-9]/g, '0')}`
  const now = io.now(), t0 = now - 60 * 60_000
  const o = await send({ op: 'open', id, t0, t1: null })
  check(o.status === 200 && o.body.record?.to === null, `open ${id} (${o.status})`)
  const plan = await sweep('plan', id, t0, io.now(), '')
  check(plan.ok, 'plan')
  show('plan', plan.totals)
  const run = await sweep('run', id, t0, io.now(), '')
  check(run.ok && run.totals.accounts === plan.totals.accounts && run.totals.certificates === plan.totals.certificates, 'run did what the plan counted')
  show('run', run.totals)
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
  return { code: fails.length ? 1 : 0, totals: run.totals, plan: plan.totals }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit((await main(process.argv.slice(2))).code)
}
