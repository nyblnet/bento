#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the directory (server/directory/src): the retired routes
// of the first design, the top-level error answer, and the passkey roster store (the rp and origin
// constant, registration checks, the 72-hour queue, one change at a time,
// self-removal, the signature counter, setup tokens, the waiting notice that
// gates a change, spent challenges, the log, roster mail, and the headers
// id.bento.page sends).
//
//   node scripts/test-directory-mutants.ts [name filter]
//   node scripts/test-directory-mutants.ts --shard 2/3   # every third mutant, from the second (CI runs the shards side by side)
//
// Each mutant below reopens one path into a COPY of the tree, and the directory
// rig must then report a failed row. The unmutated copy must pass first
// (positive control), every mutant must apply to exactly one place, so a refactor
// that moves the code turns this rig red rather than letting it pass vacuously, and
// a rig that crashes prints no count, which is not a kill.

import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RIGS = ['test-directory.ts', 'test-directory-roster.ts', 'test-directory-browsers.ts']
/**
 * Every file under scripts/ the rigs reach through relative imports (the roster
 * rig runs the hosting check, which imports scripts/lib/), found by walking the
 * import graph so a new import cannot leave the copy short. Imports outside
 * scripts/ are TREE's.
 */
function scriptImports(entries: string[]): string[] {
  const scripts = join(root, 'scripts')
  const seen = new Set<string>()
  const walk = (rel: string) => {
    if (seen.has(rel)) return
    seen.add(rel)
    const file = join(scripts, rel)
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1])
      if (!target.startsWith(scripts + sep)) continue
      if (!existsSync(target)) throw new Error(`${rel} imports ${m[1]}, which does not exist`)
      walk(relative(scripts, target))
    }
  }
  for (const e of entries) walk(e)
  return [...seen].filter((f) => !entries.includes(f))
}
const RIG_IMPORTS = scriptImports(RIGS)
const TREE = ['kernel/src', 'kernel/fixtures', 'server/directory/src', 'server/directory/fixtures', 'server/directory/wrangler.toml']
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Edit = { from: string; to: string }
/** `also`: further edits in the same file, for a rule held at two doors */
type Mutant = Edit & { name: string; file: 'worker.js' | 'roster.js' | 'passkey.js' | 'links.js' | 'mail.js' | 'voidpage.js' | 'browsers.js' | 'challenge.js'; also?: Edit[] }
const MUTANTS: Mutant[] = [
  // --- the first design's routes, retired ---
  { name: 'retired routes served again (fall through)', file: 'worker.js',
    from: "  if (RETIRED.includes(url.pathname)) return json(410, { error: 'gone' })\n", to: '' },
  { name: 'retired: a preflight still answers 204', file: 'worker.js',
    from: "  if (RETIRED.includes(url.pathname)) return json(410, { error: 'gone' })\n", to: "  if (req.method !== 'OPTIONS' && RETIRED.includes(url.pathname)) return json(410, { error: 'gone' })\n" },
  { name: 'retired: /v1/lookup left out of the list', file: 'worker.js', from: "'/v1/bind/complete', '/v1/lookup', ", to: "'/v1/bind/complete', " },
  { name: 'retired: /v1/delete/start left out of the list', file: 'worker.js', from: "'/v1/delete', '/v1/delete/start', ", to: "'/v1/delete', " },
  { name: 'D3: no top-level catch', file: 'worker.js',
    from: "    try {\n      return await route(req, env)\n    } catch (e) {\n      console.log(`directory error: ${e && e.message}`)\n      let path = ''\n      try { path = new URL(req.url).pathname } catch { /* the base headers */ }\n      return json(500, { error: 'internal' }, headersFor(path))\n    }",
    to: '    return await route(req, env)' },

  // --- SD3: browser certificates (browsers.js; rows in test-directory-browsers.ts) ---
  { name: 'SD3 challenge: a browser challenge lives 5 minutes', file: 'browsers.js', from: '  challengeTtlMs: 60_000,', to: '  challengeTtlMs: 5 * 60_000,' },
  { name: 'SD3 challenge: the ttl argument ignored', file: 'challenge.js', from: 'now - issued > ttl) return null', to: 'now - issued > CHALLENGE_TTL_MS) return null' },
  { name: 'SD3 challenge: sealed for no address', file: 'browsers.js',
    from: "    const nonce = await issueChallenge(env.CHALLENGE_KEY, web ? 'web' : 'home', scope, at)", to: "    const nonce = await issueChallenge(env.CHALLENGE_KEY, web ? 'web' : 'home', 'browser', at)",
    also: [{ from: '    const c = await openChallenge(env.CHALLENGE_KEY, aud, scope, challenge, now, BROWSER_LIMITS.challengeTtlMs)', to: "    const c = await openChallenge(env.CHALLENGE_KEY, aud, 'browser', challenge, now, BROWSER_LIMITS.challengeTtlMs)" }] },
  { name: 'SD3 challenge: no per-IP lookup charge (the 404 oracle)', file: 'browsers.js', from: "    if (!(await ledger(ip, 'lookup'))) return json(429, { error: 'rate-limited' })\n    const scope", to: '    const scope' },
  { name: 'SD3 challenge: no per-address limit', file: 'browsers.js', from: "    if (!(await ledger(`${ip}\\n${scope}`, web ? 'challengeAddr' : 'challengeAddrHome'))) return json(429, { error: 'rate-limited' })\n", to: '' },
  { name: 'SD3 challenge: the per-address limit shared by every caller', file: 'browsers.js', from: "ledger(`${ip}\\n${scope}`, web ? 'challengeAddr' : 'challengeAddrHome')", to: "ledger(scope, web ? 'challengeAddr' : 'challengeAddrHome')" },
  { name: 'D3 (#957): enrolment and renewal challenges share one count', file: 'browsers.js', from: "web ? 'challengeAddr' : 'challengeAddrHome')", to: "'challengeAddr')" },
  { name: 'D3 (#957): check-ins not counted', file: 'browsers.js', from: "    if (!(await ledger(`${ip}\\n${scope}`, 'checkin'))) return json(429, { error: 'rate-limited' })\n", to: '' },
  { name: 'D3 (#957): check-ins counted per IP before the signature', file: 'browsers.js',
    from: "    const incidents = incidentsOf(env) // first: an unreadable list countersigns nothing\n", to: "    if (!(await ledger(ip, 'checkin'))) return json(429, { error: 'rate-limited' })\n    const incidents = incidentsOf(env)\n",
    also: [{ from: "    if (!(await ledger(`${ip}\\n${scope}`, 'checkin'))) return json(429, { error: 'rate-limited' })\n", to: '' }] },
  { name: 'C2 (#957): check-ins counted before the challenge is opened', file: 'browsers.js',
    from: "    const ch = await openBrowser(env, scope, v.value.challenge, Date.now())\n    if (!ch) return json(400, { error: 'nonce' })\n    if (!(await ledger(`${ip}\\n${scope}`, 'checkin'))) return json(429, { error: 'rate-limited' })\n",
    to: "    if (!(await ledger(`${ip}\\n${scope}`, 'checkin'))) return json(429, { error: 'rate-limited' })\n    const ch = await openBrowser(env, scope, v.value.challenge, Date.now())\n    if (!ch) return json(400, { error: 'nonce' })\n" },
  { name: 'mb: the countersign always says confirmed', file: 'browsers.js', from: '  return Number.isSafeInteger(since) && since > 0 ? since : 0', to: '  return 0' },
  { name: 'mb: the countersign always says unconfirmed', file: 'browsers.js', from: 'mb: Math.min(mb, now), loggedAt: now', to: 'mb: now, loggedAt: now' },
  { name: 'C1 (#957): enrolment never reads the incident list', file: 'browsers.js', from: "    incidentsOf(env) // before the challenge is opened", to: "    // before the challenge is opened" },
  { name: 'N3 (#957): the status route not charged per IP', file: 'browsers.js',
    from: "  if (!email || !/^[A-Za-z0-9_-]{43}$/.test(c)) return json(400, { error: 'invalid' })\n  if (!(await ledger(ip, 'lookup'))) return json(429, { error: 'rate-limited' })\n",
    to: "  if (!email || !/^[A-Za-z0-9_-]{43}$/.test(c)) return json(400, { error: 'invalid' })\n" },
  { name: 'SD3 challenge: the head read without ripening', file: 'browsers.js',
    from: "    await obj.ripen(now)\n    const head = await s.get('head')\n    if (!head) return out(404, { error: 'not-found' })\n    return out(200, { rosHash: head.hash })",
    to: "    const head = await s.get('head')\n    if (!head) return out(404, { error: 'not-found' })\n    return out(200, { rosHash: head.hash })" },
  { name: 'SD3 challenge: no Origin required', file: 'browsers.js', from: "  if (req.headers.get('origin') !== browserOrigin(p)) return json(403, { error: 'origin' })\n", to: '' },
  { name: 'SD3 enrol: the challenge not spent', file: 'browsers.js',
    from: "  if (a.op === 'browserEnrol') {\n    if (!(await spend())) return out(400, { error: 'nonce' })\n", to: "  if (a.op === 'browserEnrol') {\n" },
  { name: 'SD3 enrol: spent only once the assertion verified', file: 'browsers.js',
    from: "  if (a.op === 'browserEnrol') {\n    if (!(await spend())) return out(400, { error: 'nonce' })\n", to: "  if (a.op === 'browserEnrol') {\n",
    also: [{ from: "    if (!v.ok) return out(403, { error: 'assertion' })\n    const certHash", to: "    if (!v.ok) return out(403, { error: 'assertion' })\n    if (!(await spend())) return out(400, { error: 'nonce' })\n    const certHash" }] },
  { name: 'SD3 enrol: a home challenge accepted', file: 'browsers.js', from: "    if (a.aud !== 'web') return out(400, { error: 'nonce' }) // a renewal's challenge, used up here\n", to: '' },
  { name: 'SD3 enrol: the other audience refused before it is spent', file: 'browsers.js',
    from: "    if (!(await spend())) return out(400, { error: 'nonce' })\n    if (a.aud !== 'web') return out(400, { error: 'nonce' }) // a renewal's challenge, used up here\n",
    to: "    if (a.aud !== 'web') return out(400, { error: 'nonce' })\n    if (!(await spend())) return out(400, { error: 'nonce' })\n" },
  { name: 'SD3 checkin: the other audience refused before it is spent', file: 'browsers.js',
    from: "    if (!(await spend())) return out(400, { error: 'nonce' })\n    if (a.aud !== 'home') return out(400, { error: 'nonce' }) // an enrolment's challenge, used up here\n",
    to: "    if (a.aud !== 'home') return out(400, { error: 'nonce' })\n    if (!(await spend())) return out(400, { error: 'nonce' })\n" },
  { name: 'SD3 enrol: any ceremony time', file: 'browsers.js', from: "    if (c.ceremonyAt !== a.issued) return out(400, { error: 'ceremony' })\n", to: '' },
  { name: 'SD3 enrol: any head', file: 'browsers.js', from: "    if (c.rosHash !== head.hash) return out(400, { error: 'head' })\n", to: '' },
  { name: 'SD3 enrol: any opener', file: 'browsers.js', from: "    if (b.rq !== HOME_ORIGIN) return json(400, { error: 'rq' })\n", to: '' },
  { name: 'SD3 enrol: a quarantined passkey may certify', file: 'browsers.js', from: "    if (!m || m.kind !== 'pk' || m.quarantined) return out(403, { error: 'signer' })", to: "    if (!m || m.kind !== 'pk') return out(403, { error: 'signer' })" },
  { name: 'SD3 enrol: the assertion not verified', file: 'browsers.js', from: "    if (!v.ok) return out(403, { error: 'assertion' })\n", to: '' },
  { name: 'SD3 enrol: every listed passkey origin accepted', file: 'browsers.js', from: 'rpId: PASSKEY.rpId, origins: [SIGNIN_ORIGIN], storedSignCount: rec?.signCount,', to: 'rpId: PASSKEY.rpId, origins: [SIGNIN_ORIGIN, HOME_ORIGIN], storedSignCount: rec?.signCount,' },
  { name: 'SD3 enrol: no stored signature counter', file: 'browsers.js', from: 'storedSignCount: rec?.signCount,', to: 'storedSignCount: undefined,' },
  { name: 'SD3 enrol: a device key enrols twice', file: 'browsers.js', from: "    if (await s.get(`wd:${c.devicePub}`)) return out(409, { error: 'device-known' }) // a fresh key per ceremony\n", to: '' },
  { name: 'SD3 enrol: the counter stored before the countersign', file: 'browsers.js',
    from: "    const w = await countersign(obj.env, { certHash, ob, mb: await mailbox(s), ceremonyAt: c.ceremonyAt, now })\n    if (!rec || !(await storeCount(s, pub, rec.signCount, v.value.signCount))) return out(403, { error: 'assertion' })\n",
    to: "    if (!rec || !(await storeCount(s, pub, rec.signCount, v.value.signCount))) return out(403, { error: 'assertion' })\n    const w = await countersign(obj.env, { certHash, ob, mb: await mailbox(s), ceremonyAt: c.ceremonyAt, now })\n" },
  { name: 'SD3 enrol: a dev2. accepted', file: 'browsers.js', from: "    if (!c.ok || c.value.kind !== 'wdev' || c.value.via !== 'passkey') return json(400, { error: 'text' })", to: "    if (!c.ok || c.value.via !== 'passkey') return json(400, { error: 'text' })",
    also: [{ from: "    if (!p.ok || p.value.kind !== 'wdev' || p.value.via !== 'passkey') return out(400, { error: 'text' })", to: "    if (!p.ok || p.value.via !== 'passkey') return out(400, { error: 'text' })" },
      { from: "    if (typeof b.text !== 'string' || !b.text.startsWith('wdev.') || b.text.length > TEXT_MAX)", to: "    if (typeof b.text !== 'string' || b.text.length > TEXT_MAX)" }] },
  { name: 'SD3 enrol: not logged', file: 'browsers.js', from: "    await obj.log({ k: 'wdev',", to: "    if (0) await obj.log({ k: 'wdev'," },
  { name: 'SD3 watt: 48 hours', file: 'browsers.js', from: 'Math.min(now + WATT_MAX_MS, ceremonyAt + CEREMONY_CAP_MS)', to: 'Math.min(now + 2 * WATT_MAX_MS, ceremonyAt + CEREMONY_CAP_MS)' },
  { name: 'SD3 watt: past the 7-day cap', file: 'browsers.js', from: 'Math.min(now + WATT_MAX_MS, ceremonyAt + CEREMONY_CAP_MS)', to: 'now + WATT_MAX_MS' },
  { name: 'SD3 watt: ob read from the Origin', file: 'browsers.js', from: '    const ob = a.rq === HOME_ORIGIN ? 1 : 0\n', to: '    const ob = h.origin === HOME_ORIGIN ? 1 : 0\n' },
  { name: 'SD3 log: ob never set', file: 'roster.js', from: "{ ...entry, ob: entry.rq === HOME_ORIGIN ? 1 : 0 }", to: 'entry' },
  { name: 'SD3 checkin: the challenge not spent', file: 'browsers.js',
    from: "  if (a.op === 'browserCheckin') {\n    if (!(await spend())) return out(400, { error: 'nonce' })\n", to: "  if (a.op === 'browserCheckin') {\n" },
  { name: 'SD3 checkin: a web challenge accepted', file: 'browsers.js', from: "    if (a.aud !== 'home') return out(400, { error: 'nonce' }) // an enrolment's challenge, used up here\n", to: '' },
  { name: 'SD3 checkin: the wren. signature not checked', file: 'browsers.js', from: "    if (!v.ok) return json(400, { error: 'wren' })", to: "    if (!v.ok && v.reason !== 'signature') return json(400, { error: 'wren' })" },
  { name: 'SD3 checkin: past the cap renewed', file: 'browsers.js', from: "  if (now >= rec.ceremonyAt + CEREMONY_CAP_MS) return 'cap'\n", to: '' },
  { name: 'SD3 checkin: a revoked key renewed', file: 'browsers.js', from: "  if (rec.revokedAt) return 'revoked'\n", to: '' },
  // a removed passkey is refused at two doors (not a member of the head; no record): loosen both
  { name: 'SD3 checkin: a removed passkey\'s certificate renewed', file: 'browsers.js', from: "  if (!m || m.kind !== 'pk' || m.quarantined) return 'revoked'", to: "  if (m && m.quarantined) return 'revoked'",
    also: [{ from: "  if (!pk || pk.addedAt > rec.ceremonyAt) return 'revoked'", to: "  if (pk && pk.addedAt > rec.ceremonyAt) return 'revoked'" }] },
  { name: 'SD3 checkin: a suspended passkey\'s certificate renewed', file: 'browsers.js', from: "  if (!m || m.kind !== 'pk' || m.quarantined) return 'revoked'", to: "  if (!m || m.kind !== 'pk') return 'revoked'" },
  { name: 'SD3 checkin: a passkey re-added since the ceremony', file: 'browsers.js', from: '  if (!pk || pk.addedAt > rec.ceremonyAt) return \'revoked\'', to: "  if (!pk) return 'revoked'" },
  { name: 'SD3 checkin: the pin ignored', file: 'browsers.js', from: '  return links.slice(from)', to: '  return links' },
  { name: 'SD3 checkin: no incident records', file: 'browsers.js', from: "r.status === 200 || r.status === 403 ? { ...r.body, incidents } : r.body)", to: "r.status === 200 || r.status === 403 ? { ...r.body, incidents: [] } : r.body)" },
  { name: 'SD3 incidents: a record that does not read is skipped', file: 'browsers.js', from: "    if (!ok) throw new Error('INCIDENTS holds a record that does not read')\n", to: '' },
  { name: 'SD3 incidents: read after the challenge is spent', file: 'browsers.js',
    from: "    const incidents = incidentsOf(env) // first: an unreadable list countersigns nothing\n", to: '',
    also: [{ from: "    return json(r.status, r.status === 200 || r.status === 403 ? { ...r.body, incidents } : r.body)\n  }\n\n  return json(404", to: "    const incidents = incidentsOf(env)\n    return json(r.status, r.status === 200 || r.status === 403 ? { ...r.body, incidents } : r.body)\n  }\n\n  return json(404" }] },
  { name: 'SD3 revoke: sign out everywhere marks nothing', file: 'browsers.js', from: '    await s.put(key, { ...rec, revokedAt: now })\n', to: '',
    also: [{ from: "  await s.put('signoutAt', Math.max(at, (await s.get('signoutAt')) ?? 0))\n", to: '' }] },
  { name: 'SD3 revoke: a ceremony begun before the sign-out finishes after it', file: 'browsers.js',
    from: "    if (so !== undefined && a.issued <= so) return out(403, { error: 'revoked' })\n", to: '' },
  { name: 'SD3 sweep: certificates never deleted', file: 'browsers.js', from: '  if (dead.length) await s.delete(dead)\n}', to: '}' },
  { name: 'SD3 status: always ok', file: 'browsers.js', from: "    return out(200, { state: await standing(s, rec, now) })", to: "    return out(200, { state: 'ok' })" },
  { name: 'SD3 CORS: home routes answer *', file: 'browsers.js', from: '  if (path.startsWith(HOME_ROUTES.prefix)) return HOME_ORIGIN\n', to: '' },
  { name: 'SD3 CORS: a path that is no route answers *', file: 'worker.js', from: "PUBLIC.includes(path) ? ANY : BASE", to: 'ANY' },
  { name: 'SD3 CORS: a preflight on no route answers 204', file: 'worker.js', from: "    if (h === BASE) return json(404, { error: 'not-found' }, BASE) // no route, no CORS\n", to: '' },

  // --- the sign-in host's own pages: sign-in and sign out everywhere (browsers.js) ---
  { name: 'signin: no Origin required', file: 'browsers.js', from: "  if (req.headers.get('origin') !== browserOrigin(p)) return json(403, { error: 'origin' })\n", to: "  if (p !== WEB_ROUTES.signinChallenge && req.headers.get('origin') !== browserOrigin(p)) return json(403, { error: 'origin' })\n" },
  { name: 'signin: the challenge not spent', file: 'browsers.js',
    from: "    // the challenge is spent first, in the object the user handle names\n    if (!(await spend())) return out(400, { error: 'nonce' })\n", to: '' },
  { name: 'signin: spent only once the assertion verified', file: 'browsers.js',
    from: "    // the challenge is spent first, in the object the user handle names\n    if (!(await spend())) return out(400, { error: 'nonce' })\n", to: '',
    also: [{ from: "    if (!(await storeCount(s, who.pub, who.rec.signCount, v.value.signCount))) return out(400, { error: 'assertion-sign-count' })\n    return out(200, { address:", to: "    if (!(await spend())) return out(400, { error: 'nonce' })\n    if (!(await storeCount(s, who.pub, who.rec.signCount, v.value.signCount))) return out(400, { error: 'assertion-sign-count' })\n    return out(200, { address:" }] },
  { name: 'signin: the challenge lives a day', file: 'browsers.js', from: "openChallenge(env.CHALLENGE_KEY, 'signin', SIGNIN_SCOPE, b.nonce, Date.now())", to: "openChallenge(env.CHALLENGE_KEY, 'signin', SIGNIN_SCOPE, b.nonce, Date.now(), 86_400_000)" },
  { name: 'challenge: the seal names no audience', file: 'challenge.js', from: '`${LABEL}\\n${audience}\\n${scope}', to: '`${LABEL}\\n${scope}' },
  { name: 'signin: any user handle length', file: 'browsers.js', from: "    if (!h || h.length !== 48) return json(400, { error: 'assertion' })", to: "    if (!h || h.length < 32) return json(400, { error: 'assertion' })" },
  { name: 'signin: a suspended passkey signs in (and signs out)', file: 'browsers.js', from: "  if (m.quarantined) return { error: 'quarantined' }\n", to: '' },
  // (a credential the account stores is always on its head: a removal and a reset delete it, so the one door is the whole line)
  { name: 'signin: no membership check', file: 'browsers.js', from: "  if (!m || m.kind !== 'pk' || !rec) return { error: 'not-member' }\n", to: '' },
  { name: 'signin: the counter not stored', file: 'browsers.js', from: "    if (!(await storeCount(s, who.pub, who.rec.signCount, v.value.signCount))) return out(400, { error: 'assertion-sign-count' })\n    return out(200, { address:", to: "    return out(200, { address:" },
  { name: 'D6: the counter stored over whatever is there', file: 'browsers.js', from: "  if (!rec || rec.signCount !== before) return false", to: '  if (!rec) return false' },
  { name: 'D2: a handle naming no account spends (and so stores) first', file: 'browsers.js',
    from: "    if (!(await s.get('head'))) return out(403, { error: 'not-member' })\n    // the challenge is spent first, in the object the user handle names\n    if (!(await spend())) return out(400, { error: 'nonce' })\n",
    to: "    // the challenge is spent first, in the object the user handle names\n    if (!(await spend())) return out(400, { error: 'nonce' })\n    if (!(await s.get('head'))) return out(403, { error: 'not-member' })\n" },
  { name: 'D3: the cut-off at the signed time', file: 'browsers.js', from: '  const at = now // the cut-off', to: '  const at = signedAt ?? now // the cut-off' },
  { name: 'D5: the sign-in challenge not limited per IP', file: 'browsers.js', from: "  if (p === WEB_ROUTES.signinChallenge) {\n    if (!(await ledger(ip, 'challenge'))) return json(429, { error: 'rate-limited' })\n", to: "  if (p === WEB_ROUTES.signinChallenge) {\n" },
  { name: 'W3: the sign-out challenge issued before the statement exists', file: 'browsers.js', from: "    if (!WOUT_DEFINED) return json(501, { error: 'not-implemented', reason: 'the kernel sign-out statement is not defined yet' })\n", to: '' },
  { name: 'D1: the sign-out challenge opened as an enrolment\'s', file: 'browsers.js', from: "    const c = await openChallenge(env.CHALLENGE_KEY, 'signout', await addressKey(address), parts[3], Date.now())", to: "    const c = await openChallenge(env.CHALLENGE_KEY, 'web', await addressKey(address), parts[3], Date.now())" },
  { name: 'W1: the sign-out mail promises too much', file: 'browsers.js', from: "    'From now on no browser can renew its sign-in. Anything a browser already signed can still be accepted for up to 24 hours.',\n", to: '' },
  { name: 'signin: no stored counter', file: 'browsers.js', from: "rpId: PASSKEY.rpId, origins: [SIGNIN_ORIGIN], storedSignCount: who.rec.signCount,\n    })\n    if (!v.ok) return out(400, { error: `assertion-${v.reason}` })\n    if (!(await storeCount(s, who.pub, who.rec.signCount, v.value.signCount))) return out(400, { error: 'assertion-sign-count' })\n    return out(200",
    to: "rpId: PASSKEY.rpId, origins: [SIGNIN_ORIGIN], storedSignCount: undefined,\n    })\n    if (!v.ok) return out(400, { error: `assertion-${v.reason}` })\n    if (!(await storeCount(s, who.pub, who.rec.signCount, v.value.signCount))) return out(400, { error: 'assertion-sign-count' })\n    return out(200" },
  { name: 'signin: bento/home a ceremony origin', file: 'browsers.js', from: "challenge: b64uDec(a.challenge) ?? new Uint8Array(0), rpId: PASSKEY.rpId, origins: [SIGNIN_ORIGIN],", to: "challenge: b64uDec(a.challenge) ?? new Uint8Array(0), rpId: PASSKEY.rpId, origins: [SIGNIN_ORIGIN, HOME_ORIGIN]," },
  { name: 'signin: logs the sign-in', file: 'browsers.js', from: "    return out(200, { address: (await parseRos(head.ros)).value.address })", to: "    await obj.log({ k: 'signin', at: now, pub: who.pub })\n    return out(200, { address: (await parseRos(head.ros)).value.address })" },
  { name: 'signout: no per-IP lookup charge on its challenge', file: 'browsers.js',
    from: "    if (!(await ledger(ip, 'lookup'))) return json(429, { error: 'rate-limited' })\n    const r = await roster(email, 'browserHead', {})\n    if (r.status !== 200) return json(r.status, r.body)\n    // until the statement exists",
    to: "    const r = await roster(email, 'browserHead', {})\n    if (r.status !== 200) return json(r.status, r.body)\n    // until the statement exists" },
  { name: 'signout: the challenge not spent', file: 'browsers.js',
    from: "  if (a.op === 'browserSignout') {\n    if (!(await spend())) return out(400, { error: 'nonce' })\n", to: "  if (a.op === 'browserSignout') {\n" },
  { name: 'signout: any time in the text', file: 'browsers.js', from: "    if (a.at !== a.issued) return out(400, { error: 'nonce' }) // the text's time is the challenge's\n", to: '' },
  { name: 'signout: the time checked before the challenge is spent', file: 'browsers.js',
    from: "    if (!(await spend())) return out(400, { error: 'nonce' })\n    if (a.at !== a.issued) return out(400, { error: 'nonce' }) // the text's time is the challenge's\n",
    to: "    if (a.at !== a.issued) return out(400, { error: 'nonce' })\n    if (!(await spend())) return out(400, { error: 'nonce' })\n" },
  { name: 'signout: an address not in normal form', file: 'browsers.js', from: "    if (!address || normalize(address) !== address) return json(400, { error: 'text' })", to: "    if (!address) return json(400, { error: 'text' })" },
  { name: 'signout: a leading zero in the time', file: 'browsers.js', from: "/^[1-9][0-9]{0,15}$/.test(parts[2])", to: "/^[0-9]{1,16}$/.test(parts[2])" },
  { name: 'signout: acts before the kernel defines its statement', file: 'browsers.js', from: 'const WOUT_DEFINED = false', to: 'const WOUT_DEFINED = true' },
  { name: 'signout: the assertion over the raw challenge', file: 'browsers.js', from: "      publicKey: who.pub, challenge: await statementChallenge(a.text),", to: "      publicKey: who.pub, challenge: b64uDec(a.text.split('.')[3]) ?? new Uint8Array(0)," },
  { name: 'signout: no mail', file: 'browsers.js', from: "  await h.notify(address, 'Every browser was signed out of your bento/id account', [", to: "  if (0) await h.notify(address, 'Every browser was signed out of your bento/id account', [" },
  { name: 'N3 (#957): the enrolment counter stored over whatever is there', file: 'browsers.js',
    from: "    if (!rec || !(await storeCount(s, pub, rec.signCount, v.value.signCount))) return out(403, { error: 'assertion' })\n    await s.put(`wd:",
    to: "    if (rec) await s.put(`pk:${pub}`, { ...rec, signCount: v.value.signCount })\n    await s.put(`wd:" },

  // --- the passkey roster ---
  ...['https://bento.page', 'https://home.bento.page', 'https://id.bento.page'].map((o): Mutant => ({
    name: `origins: ${o} accepted`, file: 'passkey.js',
    from: "    [SIGNIN_ORIGIN]: 'browser',\n", to: `    [SIGNIN_ORIGIN]: 'browser',\n    '${o}': 'browser',\n` })),
  { name: 'rp id: the parent bento.page', file: 'passkey.js', from: "  rpId: 'id.bento.page',", to: "  rpId: 'bento.page'," },
  { name: 'registration: any algorithm', file: 'passkey.js', from: "  if (key.get(3) !== ES256) return no('alg')\n", to: '' },
  { name: 'registration: UV not required', file: 'passkey.js', from: "  if (!(flags & FLAG_UV)) return no('uv')\n  if (!(flags & FLAG_AT))", to: "  if (!(flags & FLAG_AT))" },
  { name: 'registration: cross-origin accepted', file: 'passkey.js',
    from: "  if (cd.has('crossOrigin') && cd.get('crossOrigin') !== false) return no('cross-origin')\n  if (cd.has('topOrigin')) return no('cross-origin')\n\n  if (!same(ad.subarray(0, 32)",
    to: "\n  if (!same(ad.subarray(0, 32)" },
  { name: 'registration: JSON.parse (duplicate keys pass)', file: 'passkey.js',
    from: "  const cd = parseStrictJson(text)\n  if (cd === 'duplicate') return no('duplicate-key')\n  if (!(cd instanceof Map)) return no('grammar')\n  if (cd.get('type') !== 'webauthn.create')",
    to: "  const cd = new Map(Object.entries(JSON.parse(text)))\n  if (cd.get('type') !== 'webauthn.create')" },
  { name: 'registration: challenge not compared', file: 'passkey.js',
    from: "  if (!chBytes || !same(chBytes, challenge)) return no('challenge')\n  const origin = cd.get('origin')\n  if (typeof origin !== 'string' || !Object.hasOwn(PASSKEY.origins",
    to: "  if (!chBytes) return no('challenge')\n  const origin = cd.get('origin')\n  if (typeof origin !== 'string' || !Object.hasOwn(PASSKEY.origins" },
  { name: 'request: no stored signature counter', file: 'roster.js', from: 'storedSignCount: rec.signCount', to: 'storedSignCount: undefined' },
  { name: 'request: a second change while one waits', file: 'roster.js', from: "      if (await s.get('pend')) return out(409, { error: 'pending' })\n", to: '' },
  { name: 'request: wait from the requester\'s created', file: 'roster.js', from: 'ripensAt: now + ROSTER_WAIT_MS', to: 'ripensAt: next.created + ROSTER_WAIT_MS' },
  { name: 'request: self-removal immediate while any member stays', file: 'roster.js',
    from: "next.members.some((m) => m.kind === 'pk' && !m.quarantined)", to: 'next.members.length > 0' },
  { name: 'request: a quarantined member may ask', file: 'roster.js', from: "      if (signer.quarantined) return out(403, { error: 'quarantined' })\n", to: '' },
  { name: 'request: the requester may set quarantine marks', file: 'roster.js',
    from: "        if (w ? w.quarantined !== m.quarantined : m.quarantined) return out(400, { error: 'quarantine' })\n", to: '' },
  { name: 'request: an add and a removal in one', file: 'roster.js', from: 'if (added.length + removed.length !== 1)', to: 'if (added.length + removed.length === 0)' },
  { name: 'request: any opener accepted', file: 'roster.js', from: "      if (a.rq !== undefined && a.rq !== '' && !REQUESTERS.includes(a.rq)) return out(400, { error: 'rq' })\n", to: '' },
  { name: 'challenge: never recorded as spent', file: 'roster.js', from: '      await s.put(key, 1)\n', to: '' },
  { name: 'D2: spent challenges never swept by a spend', file: 'roster.js', from: '      if (dead.length) await s.delete(dead)\n      await this.schedule', to: '      await this.schedule' },
  { name: 'D2: spent challenges kept in one growing value', file: 'roster.js',
    from: "      const key = `spent:${String(a.issued).padStart(16, '0')}:${a.nonce}`\n      if (await s.get(key)) return false\n      await s.put(key, 1)\n      const oldest = await s.list({ prefix: 'spent:', limit: ROSTER_LIMITS.spentSweep })\n      const dead = [...oldest.keys()].filter((k) => spentUntil(k) <= now)\n      if (dead.length) await s.delete(dead)\n      await this.schedule(spentUntil(key)) // and the alarm sweeps whatever later spends leave behind\n",
    to: "      const list = ((await s.get('spent')) || []).filter((x) => x.exp > now)\n      if (list.some((x) => x.n === a.nonce)) return false\n      list.push({ n: a.nonce, exp: a.issued + ROSTER_LIMITS.spentKeepMs })\n      await s.put('spent', list)\n" },
  { name: 'D1: the waiting mail\'s failure ignored (202 anyway)', file: 'roster.js',
    from: "      if (!sent) {\n        if (await ours()) await s.delete('pend')\n        return out(503, { error: 'mail' })\n      }\n", to: '' },
  // D1a: what follows a send touches the stored change only if it is still this request's
  { name: 'D1a: the success write is unconditional', file: 'roster.js', from: "      if (!(await ours())) return out(409, { error: 'superseded' })\n", to: '' },
  { name: 'D1a: the failure clean-up is unconditional', file: 'roster.js', from: "        if (await ours()) await s.delete('pend')", to: "        await s.delete('pend')" },
  { name: 'D1a: any stored change counts as ours', file: 'roster.js',
    from: "        return !!q && q.mailed === false && q.ros === p.ros && q.requestedAt === p.requestedAt", to: '        return !!q' },
  { name: 'D1a: no mailer timeout', file: 'mail.js', from: '  return timed(send(env, msg))', to: '  return send(env, msg)' },
  { name: 'D1a: a 10-minute mailer timeout', file: 'mail.js', from: 'export const MAIL_TIMEOUT_MS = 30_000', to: 'export const MAIL_TIMEOUT_MS = 10 * 60_000' },
  // the alarm sweeps spent challenges
  { name: 'sweep: a spend arms no alarm', file: 'roster.js', from: '      await this.schedule(spentUntil(key)) // and the alarm', to: '      // and the alarm' },
  { name: 'sweep: the alarm sweeps nothing', file: 'roster.js', from: '    await this.ripen(now)\n    await this.sweepSpent(now)\n', to: '    await this.ripen(now)\n' },
  { name: 'sweep: one batch only', file: 'roster.js', from: '      if (dead.length < keys.length || keys.length < 128) return', to: '      return' },
  { name: 'Z13: a sooner spend never brings the alarm forward', file: 'roster.js',
    from: '    if (at === null || at === undefined || at > t) await s.setAlarm(t)', to: '    if (at === null || at === undefined) await s.setAlarm(t)' },
  { name: 'alarm: a later time pushes an earlier alarm back', file: 'roster.js', from: '    if (at === null || at === undefined || at > t) await s.setAlarm(t)', to: '    await s.setAlarm(t)' },
  { name: 'D1: an unnotified change ripens', file: 'roster.js',
    from: "    if (p.mailed !== true) {\n      if (now - p.requestedAt >= ROSTER_LIMITS.unsentDropMs) await s.delete('pend')\n      return\n    }\n", to: '' },
  { name: 'D1: an unnotified change never frees its slot', file: 'roster.js',
    from: "      if (now - p.requestedAt >= ROSTER_LIMITS.unsentDropMs) await s.delete('pend')\n", to: '' },
  { name: 'log: the 8-hex fingerprint instead of the full key', file: 'roster.js',
    from: "      await this.log({ k: 'request', at: now, seq: next.seq, op: change.op, pub: change.pub, by: signer.pub,",
    to: "      await this.log({ k: 'request', at: now, seq: next.seq, op: change.op, fp: await fingerprint(change.pub), pub: undefined, by: signer.pub," },
  // setup links (G13), S1, S2
  { name: 'X35 setup start: mails a link while a roster exists', file: 'roster.js',
    from: "      if (await s.get('head')) return out(202, { mailed: false }) // taken", to: '      // taken' },
  { name: 'S1: a full budget holds the mail back with no live link', file: 'roster.js',
    from: "      if (!spent && live.some(holds)) return out(202, { mailed: false })", to: "      if (!spent) return out(202, { mailed: false })" },
  { name: 'S1: an unsent link is not withdrawn', file: 'roster.js', from: ' : after.filter((t) => t.h !== h))', to: ' : after)' },
  // S1′ and the pinned link lives (Y35)
  { name: 'S1′: a link beyond the budget lives 20 minutes', file: 'roster.js',
    from: '      const exp = now + (spent ? ROSTER_LIMITS.setupTtlMs : ROSTER_LIMITS.setupBeyondTtlMs)', to: '      const exp = now + ROSTER_LIMITS.setupTtlMs' },
  { name: 'S1′: every link lives a day', file: 'roster.js',
    from: '      const exp = now + (spent ? ROSTER_LIMITS.setupTtlMs : ROSTER_LIMITS.setupBeyondTtlMs)', to: '      const exp = now + ROSTER_LIMITS.setupBeyondTtlMs' },
  { name: 'S1″: a link still being mailed holds nothing back', file: 'roster.js',
    from: '      const holds = (t) => t.mailed || now - (t.at ?? 0) < ROSTER_LIMITS.setupInFlightMs', to: '      const holds = (t) => t.mailed' },
  { name: 'S1″: any live link holds the next back, even one that never went out', file: 'roster.js',
    from: '      const holds = (t) => t.mailed || now - (t.at ?? 0) < ROSTER_LIMITS.setupInFlightMs', to: '      const holds = () => true' },
  { name: 'S1″: a token minted without its time', file: 'roster.js', from: '{ h, exp, at: now, mailed: false }', to: '{ h, exp, mailed: false }' },
  { name: 'S1″: the in-flight window is 5 minutes', file: 'roster.js', from: '  setupInFlightMs: MAIL_TIMEOUT_MS + 5_000,', to: '  setupInFlightMs: 5 * MIN,' },
  { name: 'Y35: the setup link lives 31 days', file: 'roster.js', from: '  setupTtlMs: 20 * MIN,', to: '  setupTtlMs: 31 * DAY,' },
  { name: 'Y35: the beyond-budget link lives 31 days', file: 'roster.js', from: '  setupBeyondTtlMs: DAY,', to: '  setupBeyondTtlMs: 31 * DAY,' },
  { name: 'S1′: the mail states another expiry', file: 'roster.js', from: '    `The link works once, until ${when(exp)}.`,', to: '    `The link works once, until ${when(now + ROSTER_LIMITS.setupTtlMs)}.`,' },
  // Y16: setup/start's answer says nothing
  { name: 'Y16: setup start passes on the object\'s answer', file: 'worker.js',
    from: "    await call(await rosterStub(env, email), 'setupStart', { address: email })\n    return json(202, SETUP_STARTED)",
    to: "    const r = await call(await rosterStub(env, email), 'setupStart', { address: email })\n    return json(202, { ...SETUP_STARTED, ...r.body })" },
  { name: 'Y16: the per-IP limit answers differently', file: 'worker.js',
    from: "    if (!(await ledger(env, ip, 'setup'))) return json(202, SETUP_STARTED)", to: "    if (!(await ledger(env, ip, 'setup'))) return json(202, { ok: true, limited: true })" },
  { name: 'setup start: no per-IP limit', file: 'worker.js', from: "    if (!(await ledger(env, ip, 'setup'))) return json(202, SETUP_STARTED)\n", to: '' },
  { name: 'link: the token in the query', file: 'links.js',
    from: "  return `${SIGNIN_ORIGIN}${SIGNIN_PATHS.setup}#${f.toString()}`", to: "  return `${SIGNIN_ORIGIN}${SIGNIN_PATHS.setup}?${f.toString()}`" },
  { name: 'link: pointed at the directory', file: 'links.js',
    from: "  return `${SIGNIN_ORIGIN}${SIGNIN_PATHS.setup}#${f.toString()}`", to: "  return `https://id.bento.page${SIGNIN_PATHS.setup}#${f.toString()}`" },
  { name: 'link: parse accepts an extra key', file: 'links.js', from: 'if (keys.length !== names.length || ', to: 'if (' },
  { name: 'S2: the queued-change mail reads the setup budget', file: 'roster.js',
    from: "      const sent = await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [",
    to: "      const sent = (await this.spendSetupBudget(now), true) && await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [" },
  { name: 'S2: reset mail classed as budgeted', file: 'mail.js', from: "  reset: 'never',", to: "  reset: 'budget'," },
  { name: 'S2: an undeclared mail kind delivered', file: 'mail.js',
    from: "  if (!msg || !Object.hasOwn(MAIL_KINDS, msg.kind)) throw new Error(`undeclared mail kind: ${msg && msg.kind}`)\n", to: '' },
  // the sign-in host's routes
  { name: 'worker.js exports a string (the runtime refuses to start)', file: 'worker.js',
    from: 'export const RETIRED = Object.freeze([\n', to: "export const WEB_PREFIX = '/v1/web/'\nexport const RETIRED = Object.freeze([\n" },
  { name: 'Y26: a web-route 500 answers *', file: 'worker.js',
    from: "      return json(500, { error: 'internal' }, headersFor(path))", to: "      return json(500, { error: 'internal' })" },
  { name: 'Y31: enrol not limited per IP', file: 'browsers.js', from: "    if (!(await ledger(ip, 'enrol'))) return json(429, { error: 'rate-limited' })\n", to: '' },
  { name: 'web: CORS * on the web routes', file: 'worker.js', from: 'const WEB = only(SIGNIN_ORIGIN), HOME', to: 'const WEB = ANY, HOME' },
  { name: 'web: any text accepted before the count', file: 'browsers.js', from: "typeof b.text !== 'string' || !b.text.startsWith('wdev.') || b.text.length > TEXT_MAX", to: "typeof b.text !== 'string'" },
  { name: 'web: assertion fields not checked', file: 'browsers.js',
    from: "!['id', 'authenticatorData', 'clientDataJSON', 'signature'].every((f) => field(as[f]))", to: 'false' },
  { name: 'web: the challenge shares the roster audience', file: 'browsers.js',
    from: "issueChallenge(env.CHALLENGE_KEY, web ? 'web' : 'home', scope, at)", to: "issueChallenge(env.CHALLENGE_KEY, web ? 'roster' : 'home', scope, at)",
    also: [{ from: "const AUDIENCES = Object.freeze(['web', 'home'])", to: "const AUDIENCES = Object.freeze(['roster', 'home'])" },
      { from: "    if (a.aud !== 'web') return out(400, { error: 'nonce' }) // a renewal's", to: "    if (a.aud !== 'roster') return out(400, { error: 'nonce' }) // a renewal's" }] },
  // security's C1 (#926 X1, X13, X22, X31)
  { name: 'X1 CBOR: a repeated map key allowed', file: 'passkey.js', from: "        if (out.has(key)) throw new Bad()\n", to: '' },
  { name: 'X13 registration: origin matched by prefix', file: 'passkey.js',
    from: "!Object.hasOwn(PASSKEY.origins, origin)", to: "!Object.keys(PASSKEY.origins).some((o) => origin.startsWith(o))" },
  { name: 'X22 request: the address not checked', file: 'roster.js',
    from: "      if (next.address !== before.value.address) return out(400, { error: 'address' })\n", to: '' },
  { name: 'X31 setup: expired tokens accepted', file: 'roster.js',
    from: "      const live = ((await s.get('setupTok')) || []).filter((t) => t.exp > now)\n      // no attempt",
    to: "      const live = ((await s.get('setupTok')) || [])\n      // no attempt" },
  { name: 'setup: wrong tokens counted and the tokens burned at 5', file: 'roster.js',
    from: "      if (!live.some((t) => same(t.h, h))) return out(400, { error: 'token' })",
    to: "      if (!live.some((t) => same(t.h, h))) { const n = ((await s.get('tokFail')) || 0) + 1; await s.put('tokFail', n); if (n >= 5) await s.delete('setupTok'); return out(400, { error: 'token' }) }" },
  { name: 'setup start: a new token replaces the live ones', file: 'roster.js', from: "await s.put('setupTok', [...live, {", to: "await s.put('setupTok', [{" },
  { name: 'mail: the setup notice spends the stranger budget', file: 'roster.js',
    from: "      await notify(this.env, a.address, 'Your bento/id account was set up', [",
    to: "      await s.put('mail', [...((await s.get('mail')) || []), now])\n      await notify(this.env, a.address, 'Your bento/id account was set up', [" },
  { name: 'mail: a full stranger budget holds back the queued-change mail', file: 'roster.js',
    from: "      const sent = await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [",
    to: "      const sent = ((await s.get('mail')) || []).length >= ROSTER_LIMITS.mailPerDay || await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [" },
  { name: 'mail: the roster is left out', file: 'roster.js', from: '  const out = []\n  for (const m of members) {', to: '  const out = []\n  for (const m of []) {' },
  { name: 'headers: no Permissions-Policy', file: 'worker.js', from: "  'permissions-policy': 'publickey-credentials-get=(), publickey-credentials-create=()',\n", to: '' },
  { name: 'headers: no CSP', file: 'worker.js', from: "  'content-security-policy': \"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\",\n", to: '' },
  { name: 'headers: /.well-known/webauthn served', file: 'worker.js',
    from: "  if (req.method !== 'POST') return json(404, { error: 'not-found' }, headersFor(p))",
    to: "  if (p === '/.well-known/webauthn') return json(200, { origins: ['https://home.bento.page'] })\n  if (req.method !== 'POST') return json(404, { error: 'not-found' }, headersFor(p))" },

  // --- SD2: the countersign (G2, the authority words) ---
  { name: 'rip: the setup head countersigned as a reset', file: 'roster.js',
    from: "      await this.link(ros, { auth: 'm', requestedAt: now, now, kind: 'setup' })", to: "      await this.link(ros, { auth: 'r', requestedAt: now, now, kind: 'setup' })" },
  { name: 'rip: a member change ripens under the reset word', file: 'roster.js',
    from: "      head = await this.link(p.ros, { auth: 'm', requestedAt: p.requestedAt, now, kind: 'member',", to: "      head = await this.link(p.ros, { auth: 'r', requestedAt: p.requestedAt, now, kind: 'member'," },
  { name: 'rip: requestedAt is the ripening time', file: 'roster.js',
    from: "    const { rip, ripSig } = await countersign(this.env, { rosHash: hash, requestedAt, ripenedAt: now, auth, cause })",
    to: "    const { rip, ripSig } = await countersign(this.env, { rosHash: hash, requestedAt: now, ripenedAt: now, auth, cause })" },
  { name: 'rip: no countersign stored with the link', file: 'roster.js',
    from: '    await s.put(`link:${String(head.seq).padStart(8, \'0\')}`, { ros, rip, ripSig, kind, requestedAt, ripenedAt: now, ...extra })',
    to: '    await s.put(`link:${String(head.seq).padStart(8, \'0\')}`, { ros, kind, requestedAt, ripenedAt: now, ...extra })' },

  // --- SD2: the void (G3, G4, G4a-c) ---
  { name: 'G3 void: wrong tokens counted and the change burned at 5', file: 'roster.js',
    from: "      if (!parked && (!p || typeof p.voidTok !== 'string' || !same(p.voidTok, th))) {\n",
    to: "      if (!parked && (!p || typeof p.voidTok !== 'string' || !same(p.voidTok, th))) {\n        { const n = ((await s.get('voidFail')) || 0) + 1; await s.put('voidFail', n); if (n >= 5 && p) await s.put('pend', { ...p, voidTok: 'burned' }) }\n" },
  { name: 'G3 void: no per-IP limit', file: 'worker.js', from: "    if (!(await ledger(env, ip, 'void'))) return json(429, { error: 'rate-limited' })\n", to: '' },
  { name: 'G3 void: a wrong choice spends the token', file: 'roster.js',
    from: "      if (!choices.includes(a.choice)) return out(400, { error: 'choice' })",
    to: "      if (!choices.includes(a.choice)) { await s.put('pend', { ...p, voidTok: 'spent' }); return out(400, { error: 'choice' }) }" },
  { name: 'G3 void: a change already in effect can still be voided', file: 'roster.js',
    from: "      await this.ripen(now) // a change already in effect can no longer be stopped\n", to: '' },
  { name: 'G3 link: the void token in the query', file: 'links.js',
    from: '  return `${DIRECTORY_ORIGIN}${VOID_PATH}#${f.toString()}`', to: '  return `${DIRECTORY_ORIGIN}${VOID_PATH}?${f.toString()}`' },
  { name: 'G3 link: the void link on the sign-in host', file: 'links.js',
    from: '  return `${DIRECTORY_ORIGIN}${VOID_PATH}#${f.toString()}`', to: '  return `${SIGNIN_ORIGIN}${VOID_PATH}#${f.toString()}`' },
  { name: 'G3 mail: the waiting notice carries no void link', file: 'roster.js',
    from: "        '',\n        ...voidLines(next.address, vt.token, vk, p.ripensAt),\n", to: '' },
  { name: 'G4b cancel: no cooldown', file: 'roster.js', from: "        if (until) await s.put(`cool:${p.signer}`, until)\n", to: '' },
  { name: 'G4b request: the cooldown not read', file: 'roster.js', from: "      if (coolUntil && coolUntil > now) return out(403, { error: 'cooldown', until: coolUntil })\n", to: '' },
  { name: 'G4b: the cooldown is an hour', file: 'roster.js', from: '  voidCooldownMs: 72 * 60 * MIN,', to: '  voidCooldownMs: 60 * MIN,' },
  { name: 'G4b: a reset\'s cancel sets a cooldown too', file: 'roster.js',
    from: "        const until = kind === 'member' ? now + ROSTER_LIMITS.voidCooldownMs : null", to: '        const until = now + ROSTER_LIMITS.voidCooldownMs' },
  { name: 'G4 cancel: waits on the mailer', file: 'roster.js',
    from: "        await s.delete('pend')\n        // C3: a stopped reset",
    to: "        if (!(await notify(this.env, address, 'x', [], 'void'))) return out(503, { error: 'mail' })\n        await s.delete('pend')\n        // C3: a stopped reset" },
  { name: 'G4 remove: suspends without queuing the removal', file: 'roster.js',
    from: "      await this.schedule(removesAt)\n", to: "      await s.delete('pend')\n" },
  { name: 'G4 remove: the suspension under the member word', file: 'roster.js',
    from: "      await this.link(qRos, { auth: 'q', cause: p.hash,", to: "      await this.link(qRos, { auth: 'm', cause: p.hash," },
  { name: 'G4 remove: the suspension cites the head, not the voided request', file: 'roster.js',
    from: "      await this.link(qRos, { auth: 'q', cause: p.hash,", to: "      await this.link(qRos, { auth: 'q', cause: cur.hash," },
  { name: 'G4 remove: the voided request left out of the link', file: 'roster.js',
    from: "        extra: { voided: { ros: p.ros, signer: target, assertion: p.assertion } } })", to: '        })' },
  { name: 'G4 remove: acts though its notice was not sent', file: 'roster.js',
    from: "      if (!sent) {\n        await this.dropHold(hold)\n        return out(503, { error: 'mail' })\n      }\n", to: '' },
  { name: 'G4 remove: the removal requested at ripening, not at the suspension', file: 'roster.js',
    from: "      head = await this.link(p.ros, { auth: 'x', cause: p.cause, requestedAt: p.requestedAt, now, kind: 'removal' })",
    to: "      head = await this.link(p.ros, { auth: 'x', cause: p.cause, requestedAt: now, now, kind: 'removal' })" },
  { name: 'G4 remove: the removal waits an hour', file: 'roster.js', from: '      const removesAt = now + ROSTER_WAIT_MS', to: '      const removesAt = now + 60 * MIN' },
  { name: 'G4a: the removal notice carries no undo link', file: 'roster.js',
    from: "        '',\n        ...voidLines(address, ut.token, 'u', removesAt),\n", to: '' },
  { name: 'G4a undo: the removal still ripens', file: 'roster.js',
    from: "        } else {\n          await s.delete('pend')\n        }\n", to: '        }\n' },
  { name: 'G4a undo: under the member word', file: 'roster.js',
    from: "await this.link(uRos, { auth: 'u', cause: cur.hash,", to: "await this.link(uRos, { auth: 'm', cause: cur.hash," },
  { name: 'G4c: Remove offered to the only live member', file: 'roster.js',
    from: "      const vk = cur.members.some((m) => !m.quarantined && m.pub !== signer.pub) ? 'c' : 'o'", to: "      const vk = 'c'",
    also: [{ from: "      if (!cur.members.some((m) => !m.quarantined && m.pub !== target)) return out(400, { error: 'choice' }) // never lock the person out (G4c)\n", to: '' }] },
  { name: 'G4c, C6: the waiting notice calls an unasked change benign again', file: 'roster.js',
    from: "      ? ['The page offers two choices. If you did not ask for this, your passkey was used for something you did not intend. Choose Cancel: it is always safe. Choose Remove only if you do not recognise the passkey that asked (named above).']",
    to: "      ? ['The page offers two choices. If you did not ask for this, the usual cause is a page that used your own passkey: choose Cancel. Choose Remove only if you do not recognise the passkey that asked.']" },
  { name: 'G4c: a reset\'s link offers Remove', file: 'roster.js',
    from: "      const choices = kind === 'reset' ? ['cancel'] :", to: "      const choices = kind === 'reset' ? ['cancel', 'remove'] :" },

  // --- SD2: the reset (G5) ---
  { name: 'G5 reset: does not preempt a waiting change', file: 'roster.js',
    from: "      if (waiting && waiting.kind === 'reset') return out(409, { error: 'pending' })", to: "      if (waiting) return out(409, { error: 'pending' })" },
  { name: 'G5 reset: a member may stop it in the first 14 days', file: 'roster.js',
    from: "      if (now - (await this.createdAt(cur)) < ROSTER_LIMITS.newAccountMs) return out(403, { error: 'new-account' })\n", to: '' },
  { name: 'G5 reset: a suspended member may stop it', file: 'roster.js', from: "      if (who.quarantined) return out(403, { error: 'quarantined' })\n", to: '' },
  { name: 'G5: the new-account window is a day', file: 'roster.js', from: '  newAccountMs: 14 * DAY,', to: '  newAccountMs: DAY,' },
  { name: 'G5: the account\'s age restarts at a reset', file: 'roster.js',
    from: "createdAt: prev?.createdAt ?? now }", to: "createdAt: auth === 'r' ? now : prev?.createdAt ?? now }" },
  { name: 'G5 reset: under the member word', file: 'roster.js',
    from: "      head = await this.link(p.ros, { auth: 'r', requestedAt: p.requestedAt, now, kind: 'reset' })", to: "      head = await this.link(p.ros, { auth: 'm', requestedAt: p.requestedAt, now, kind: 'reset' })" },
  { name: 'G5 reset: the old members\' credentials kept', file: 'roster.js',
    from: "        await s.delete([`pk:${m.pub}`, `cool:${m.pub}`, ...(r ? [`cid:${r.credId}`] : [])])\n      }", to: '      }' },
  { name: 'G5 reset: queued though its notice was not sent', file: 'roster.js',
    from: "      if (!sent) {\n        await this.dropHold(hold)\n        return out(503, { error: 'mail' }) // no notice, no reset: the notice is how it is stopped (D1)\n      }\n", to: '' },
  { name: 'G5 reset: wrong tokens counted and the links burned at 5', file: 'roster.js',
    from: "      if (!rlive.some((t) => same(t.h, rh))) return out(400, { error: 'token' })",
    to: "      if (!rlive.some((t) => same(t.h, rh))) { const n = ((await s.get('rsFail')) || 0) + 1; await s.put('rsFail', n); if (n >= 5) await s.delete('resetTok'); return out(400, { error: 'token' }) }" },
  { name: 'G5 reset: the reset notice carries no void link', file: 'roster.js',
    from: "        '',\n        ...voidLines(a.address, vt.token, 'r', resetAt, waiting ? [] : ['Stopping it changes nothing else: your passkeys stay as they are.']),\n", to: '' },
  { name: 'G5 reset notice: does not say the account is too new for its passkeys', file: 'roster.js',
    from: "        ...(young ? [`This account was set up less than 14 days ago", to: "        ...(false ? [`This account was set up less than 14 days ago" },
  { name: 'S2 reset start: reads the setup budget', file: 'roster.js',
    from: "      if (rlive.some(resetHolds)) return out(202, { mailed: false })", to: "      if (rlive.some(resetHolds) || !(await this.spendSetupBudget(now))) return out(202, { mailed: false })" },
  { name: 'S1 reset start: a live link holds nothing back', file: 'roster.js',
    from: "      if (rlive.some(resetHolds)) return out(202, { mailed: false })\n", to: '' },
  { name: 'S1″ reset start: a link still being mailed holds nothing back', file: 'roster.js',
    from: '      const resetHolds = (t) => t.mailed || now - (t.at ?? 0) < ROSTER_LIMITS.setupInFlightMs', to: '      const resetHolds = (t) => t.mailed' },
  { name: 'reset start: answers differently for an account', file: 'worker.js',
    from: "    await call(await rosterStub(env, email), 'resetStart', { address: email })\n    return json(202, SETUP_STARTED)",
    to: "    const r = await call(await rosterStub(env, email), 'resetStart', { address: email })\n    return json(202, { ...SETUP_STARTED, ...r.body })" },
  { name: 'reset start: the link lives 31 days', file: 'roster.js', from: '  resetTtlMs: DAY,', to: '  resetTtlMs: 31 * DAY,' },

  // --- #944's conditions. F1: the hold before a void's or a reset's mail ---
  { name: 'F1 hold: the alarm ripens a held change', file: 'roster.js',
    from: "    if (await this.held(now)) return\n    await this.apply(p, now, 'ripen')", to: "    await this.apply(p, now, 'ripen')" },
  { name: 'F1 hold: a void during a hold goes ahead', file: 'roster.js',
    from: "      if (await this.held(now)) return out(409, { error: 'busy' })\n      const cur = await s.get('head')", to: "      const cur = await s.get('head')" },
  { name: 'F1 hold: a reset during a hold goes ahead', file: 'roster.js',
    from: "      if (await this.held(now)) return out(409, { error: 'busy' })\n      const reg = await verifyRegistration", to: '      const reg = await verifyRegistration' },
  { name: 'F1 hold: a member request during a hold goes ahead', file: 'roster.js',
    from: "      if (await this.held(now)) return out(409, { error: 'pending' })\n", to: '' },
  { name: 'F1 hold: lapses after a second', file: 'roster.js', from: '  holdMs: MAIL_TIMEOUT_MS + 5_000,', to: '  holdMs: 1_000,' },
  { name: 'F1 hold: kept after the Remove\'s mail fails', file: 'roster.js',
    from: "        await this.dropHold(hold)\n        return out(503, { error: 'mail' })\n      }", to: "        return out(503, { error: 'mail' })\n      }" },
  { name: 'F1 hold: kept after the reset\'s mail fails', file: 'roster.js',
    from: "        await this.dropHold(hold)\n        return out(503, { error: 'mail' }) // no notice", to: "        return out(503, { error: 'mail' }) // no notice" },
  { name: 'F1 hold: the alarm does not wait out a hold', file: 'roster.js',
    from: 'next.push(Math.max(p.ripensAt, h ? h.until : 0))', to: 'next.push(p.ripensAt)' },
  { name: 'F1 hold: anyone may take it off', file: 'roster.js',
    from: "    if (h && h.id === id) await this.state.storage.delete('hold')", to: "    if (h) await this.state.storage.delete('hold')" },
  { name: 'F1 whose hold: a stalled Remove ignores another\'s', file: 'roster.js', from: "      if (!mine) return out(409, { error: 'busy' })\n", to: '' },
  { name: 'F1 whose hold: a stalled reset ignores another\'s', file: 'roster.js',
    from: "      if ((await s.get('hold'))?.id !== hold) return out(409, { error: 'busy' })\n", to: '' },
  // F1b: the post-send re-checks and the single-use reset link
  { name: 'F1b: Remove\'s post-send re-check gone', file: 'roster.js',
    from: "      if (!still || still.voidTok !== p.voidTok || atHead.hash !== cur.hash) { await this.dropHold(hold); return out(409, (await this.endedAnswer(th)) ?? { error: 'superseded' }) }\n", to: '' },
  { name: 'F1b: the reset\'s post-send re-check gone', file: 'roster.js',
    from: "      if ((there?.voidTok ?? null) !== (waiting?.voidTok ?? null) || atHead.hash !== cur.hash) { await this.dropHold(hold); return out(409, { error: 'superseded' }) }\n", to: '' },
  { name: 'F1b: the reset link kept once its reset is queued', file: 'roster.js',
    from: "      await s.delete('resetTok') // a reset under way", to: '      // a reset under way' },
  // F2: an ended link says how it ended
  { name: 'F2: a link whose change took effect is not remembered', file: 'roster.js', from: "      await this.ended(p.voidTok, 'late', now)\n", to: '' },
  { name: 'F2: a set-aside removal\'s link is not remembered at the reset', file: 'roster.js',
    from: "      if (p.parked) await this.ended(p.parked.voidTok, 'late', now, 'reset')\n", to: '' },
  { name: 'F2: a cancel does not mark its link used', file: 'roster.js',
    from: "        await this.ended(p.voidTok, 'used', now)\n        const until", to: '        const until' },
  { name: 'F2: a Remove does not mark its link used', file: 'roster.js',
    from: "      await this.ended(p.voidTok, 'used', now)\n      await this.dropHold(hold)", to: '      await this.dropHold(hold)' },
  { name: 'F2: an undo does not mark its link used', file: 'roster.js', from: "        await this.ended(r.voidTok, 'used', now)\n", to: '' },
  { name: 'F2: a reset does not mark the change it cancelled', file: 'roster.js', from: "        await this.ended(there.voidTok, 'preempted', now)\n", to: '' },
  { name: 'F2: every ended link kept', file: 'roster.js', from: "    await s.put('ended', list.slice(-ROSTER_LIMITS.endedKeep))", to: "    await s.put('ended', list)" },
  { name: 'F2: an ended link answers unknown', file: 'roster.js',
    from: "        return e ? out(409, e) : out(400, { error: 'invalid' })", to: "        return out(400, { error: 'invalid' })" },
  // C3: G4a survives a reset
  { name: 'C3: a reset cancels a waiting removal', file: 'roster.js',
    from: "      const setAside = waiting && waiting.kind === 'removal' ? waiting : null", to: '      const setAside = null' },
  { name: 'C3: the undo link ignores a set-aside removal', file: 'roster.js',
    from: "      const parked = p && p.kind === 'reset' && p.parked && typeof p.parked.voidTok === 'string' && same(p.parked.voidTok, th) ? p.parked : null",
    to: '      const parked = null' },
  { name: 'C3: the reset not asked again after an undo', file: 'roster.js',
    from: "          await s.put('pend', { ...reset, ros, hash: await sha256b64u(ros), requestedAt: now, ripensAt: resetAt })",
    to: "          await s.put('pend', reset)" },
  { name: 'C3: a stopped reset drops the set-aside removal', file: 'roster.js',
    from: "        if (back) {\n          await s.put('pend', back)\n          await this.schedule(back.ripensAt)\n        }\n", to: '' },
  { name: 'C3: a stopped reset gives the removal a new time', file: 'roster.js',
    from: "          await s.put('pend', back)", to: "          await s.put('pend', { ...back, ripensAt: now + ROSTER_WAIT_MS })" },
  // the wording security asked for
  { name: 'ruling 1: the stop mail is silent on the change the reset cancelled', file: 'roster.js',
    from: "          ...(kind === 'reset' && p.preempted ? [", to: '          ...(false ? [' },
  { name: 'ruling 1: the reset notice says stopping it changes nothing, whatever it cancelled', file: 'roster.js',
    from: "waiting ? [] : ['Stopping it changes nothing else: your passkeys stay as they are.']", to: "['Stopping it changes nothing else: your passkeys stay as they are.']" },
  { name: 'C6: the k=o notice says "lock you out"', file: 'roster.js',
    from: "so removing it would leave the account with no usable passkey (only a reset gets back in).'", to: "so removing it would lock you out.'" },

  // --- SD2: the void page (its own headers; the browser rig has the rest) ---
  { name: 'page: inline script allowed', file: 'voidpage.js', from: `  "script-src 'self'",`, to: `  "script-src 'self' 'unsafe-inline'",` },
  { name: 'page: framing allowed', file: 'voidpage.js', from: `  "frame-ancestors 'none'",\n`, to: '', also: [{ from: "  'x-frame-options': 'DENY',\n", to: '' }] },
  { name: 'page: WebAuthn not turned off', file: 'voidpage.js', from: "  'permissions-policy': 'publickey-credentials-get=(), publickey-credentials-create=()',\n", to: '' },
  { name: 'page: cached', file: 'voidpage.js', from: "  'cache-control': 'no-store',\n", to: "  'cache-control': 'max-age=3600',\n" },
  { name: 'page: Trusted Types not required', file: 'voidpage.js', from: `  "require-trusted-types-for 'script'",\n`, to: '' },
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'directory-mutant-'))
  for (const p of TREE) cpSync(join(root, p), join(d, p), { recursive: true })
  for (const f of [...RIGS, ...RIG_IMPORTS]) { mkdirSync(dirname(join(d, 'scripts', f)), { recursive: true }); cpSync(join(root, 'scripts', f), join(d, 'scripts', f)) }
  return d
}
/** One rig in a tree, to its end or 120 s (then killed: no count line, so a crash). */
function rig(d: string, f: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [join(d, 'scripts', f)])
    let stdout = '', stderr = ''
    c.stdout.on('data', (x) => { stdout += x })
    c.stderr.on('data', (x) => { stderr += x })
    const t = setTimeout(() => c.kill('SIGKILL'), 120_000)
    c.on('close', () => { clearTimeout(t); resolve({ stdout, stderr }) })
  })
}
/**
 * Run the rigs in a tree, side by side (each its own process and copy of the
 * clock, so they cannot disturb each other: the job outgrew 30 minutes run one
 * after another). A rig with no count line crashed, and proves nothing.
 */
async function run(d: string) {
  const rs = await Promise.all(RIGS.map((f) => rig(d, f)))
  return RIGS.map((f, i) => {
    const r = rs[i]
    const m = /^(\d+) passed, (\d+) failed$/m.exec(r.stdout)
    // a crash proves nothing, so say where it happened
    if (!m) console.log(`        ${f} crashed: ${(r.stderr || '').split('\n').filter((l) => /Error|at file:/.test(l)).slice(0, 2).join(' | ').slice(0, 300)}`)
    return { f, passed: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : null }
  })
}

console.log('positive control: the unmutated copy passes the rig')
ok(RIG_IMPORTS.includes('check-id-hosting.mjs') && RIG_IMPORTS.includes(join('lib', 'id-hosting-rules.mjs')), `the copy carries the rigs' script imports, found by walking them (${RIG_IMPORTS.join(', ')})`)
{
  const d = tree()
  for (const r of await run(d)) ok(r.failed === 0 && (r.passed ?? 0) > 0, `${r.f}: ${r.passed} passed, ${r.failed} failed`)
  rmSync(d, { recursive: true, force: true })
}

// --shard k/n runs the mutants whose index is k-1 modulo n, so n shards together run every one exactly once
const args = process.argv.slice(2)
const si = args.indexOf('--shard')
const shard = si >= 0 ? /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(args[si + 1] ?? '') : null
if (si >= 0 && (!shard || Number(shard[1]) > Number(shard[2]))) { console.log(`--shard wants k/n with 1 <= k <= n, not ${args[si + 1]}`); process.exit(1) }
const only = args.filter((a, i) => i !== si && i !== si + 1)[0]
const named = only ? MUTANTS.filter((m) => m.name.includes(only)) : MUTANTS
const chosen = shard ? named.filter((_, i) => i % Number(shard[2]) === Number(shard[1]) - 1) : named
console.log(`\n${chosen.length} mutants${shard ? ` (shard ${shard[1]} of ${shard[2]}, of ${named.length})` : ''}: every one must fail a row`)
for (const m of chosen) {
  const d = tree()
  const p = join(d, 'server/directory/src', m.file)
  const src = readFileSync(p, 'utf8')
  const edits: Edit[] = [m, ...(m.also ?? [])]
  const ns = edits.map((e) => src.split(e.from).length - 1)
  const n = ns.every((x) => x === 1) ? 1 : 0
  ok(n === 1, `applies exactly once: ${m.name} (found ${ns.join(', ')})`)
  if (n === 1) {
    writeFileSync(p, edits.reduce((t, e) => t.replace(e.from, () => e.to), src))
    const rs = await run(d)
    ok(rs.every((r) => r.failed !== null) && rs.some((r) => r.failed! > 0), `killed: ${m.name} (${rs.map((r) => `${r.f} ${r.failed === null ? 'CRASHED' : `${r.failed} failed`}`).join(', ')})`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
