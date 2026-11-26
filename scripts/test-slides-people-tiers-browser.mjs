// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The People panel's identity tiers in the packaged editor (bento/id P1, option G).
//
//   npm run build:single --prefix slides && node scripts/test-slides-people-tiers-browser.mjs
//
// The tiers are ON wherever the host exposes an identity agent; localStorage
// `bento-people-vouch` = 'off' is the viewer's kill switch. As the OWNER of a v2
// room, with a TEST identity agent defined exactly as a host must define it
// (frozen, non-writable, non-configurable global), peers arrive on the
// same-machine channel and PROVE their keys with real presence key proofs (the
// session's own keyProven decides, nothing is stubbed). The network is closed:
// http(s) aborted, every WebSocket closed through context.routeWebSocket (and
// the rig asserts it closed at least one).
//   1. 1440px, kill switch unset: a complete answer (the `fields` marker) with
//      no tier fields -> "\u2713 via id.bento.page", "(passkey sign-in)", "new
//      account"; native + old + a change -> "account changed on <date>";
//      unconfirmedSince -> "unconfirmed since <date>" beside the \u2713, next to a
//      hostile 78-character name; revoked (incident flag for the owner, none
//      for signout); an answer with only the six original fields (what
//      home/bridge.js relays today) and one whose vouchedBy carries a
//      qualifier -> "couldn't check", no \u2713; six fields with changed: true ->
//      "\u26A0 changed" all the same (it only takes the \u2713 away); the
//      unconfirmed tag painted in the warning colour, not the tier tags' grey;
//      a right-to-left 80-character name (Hebrew, RLO, Braille blanks, U+FDFD);
//      an unproven peer is never looked up. Every mark and tag is measured
//      visible (getBoundingClientRect inside each clipping ancestor, no
//      ellipsis) at 1440, 1000 and 760.
//   2. phone widths 390x844 and 320x568 (ed-bar-fold, Share inside ⋯): every
//      mark and tag ("unconfirmed since", "(passkey sign-in)", "new account",
//      "account changed on", "couldn't check", revoked) inside the viewport and
//      hit by elementFromPoint, beside a name of 30 U+FDFD.
//   3. kill switch 'off' with an agent: rows unchanged, 0 resolve calls, 0 reads
//      of the agent's global. The old QA value 'on' still shows the tiers.
//   4. kill switch unset, NO agent (file://, bento.page): rows unchanged and
//      their HTML identical to the kill-switch run, 0 `.vouch` nodes; the agent
//      global WAS probed (the positive control that the default-on path ran).
// RIG_MUTANT=<name> rebuilds with one source edit and restores the file:
//   owner        the incident flag is never given a row
//   proof        every named key treated as proven
//   layout       the name not isolated (the old single-line ellipsis)
//   nomarker     the completeness-marker check short-circuited
//   probe-always the agent asked for even under the kill switch
//   fallback     a stand-in agent where the host has none (no-agent inertness)
//   unconflayout the unconfirmed tag squeezed to one clipped line
//   phonepop     #958's phone CSS removed (the folded popover floats again, uncapped)
//   unconfgrey   the unconfirmed tag painted grey like the tier tags
//   changedmarker a changed binding hidden unless the answer carries the marker
// Each must go red.
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// [file under slides/src, needle (exactly once), replacement], or a list of them
const MUTANTS = {
  owner: ['editor/editor.ts', 'ownerRow: iAmOwner ? row : null', 'ownerRow: null'],
  proof: ['editor/editor.ts', 'decoratePeer(who, peer.name, peer.pub, keyOk, vouchAgent,', 'decoratePeer(who, peer.name, peer.pub, true, vouchAgent,'],
  layout: ['editor/vouch.ts', "who.classList.add('vouched')", "who.classList.add('vouched-off')"],
  nomarker: ['editor/vouchstate.ts', 'if (!ownMarker(a)) return', "if (!ownMarker(a) && a.fields === 'never') return"],
  // the unconfirmed tag painted in the muted grey of the other tags, not the warning amber
  unconfgrey: ['styles.css', ".ed-share-peer .vouch[data-vouch='revoked'],\n.ed-share-peer .vouch-tag[data-tag='unconfirmed'] { color: #b26a00; }",
    ".ed-share-peer .vouch[data-vouch='revoked'] { color: #b26a00; }"],
  // a changed binding hidden unless the answer carries the marker
  changedmarker: ['editor/vouchstate.ts', 'if (a.changed === true) return', 'if (a.changed === true && ownMarker(a)) return'],
  'probe-always': ['editor/vouch.ts', 'return vouchEnabled() ? identityAgent() : null', 'return identityAgent()'],
  fallback: ['editor/vouch.ts', 'return vouchEnabled() ? identityAgent() : null',
    "return vouchEnabled() ? (identityAgent() ?? { contract: 1, whoami: async () => null, sign: async () => ({ ok: false, reason: 'unavailable' }), resolve: async () => null }) : null"],
  unconflayout: ['styles.css', '.ed-share-peer .vouch-flag {\n  flex: none;',
    ".ed-share-peers .ed-share-peer .vouch-tag[data-tag='unconfirmed'] { flex: 1 1 0; white-space: nowrap; overflow: hidden; max-width: 24px; }\n.ed-share-peer .vouch-flag {\n  flex: none;"],
  phonepop: [['styles.css', '.ed-topbar.ed-bar-fold .ed-menu .ed-menu.ed-share-pop { max-width: calc(100vw - 16px); }', ''],
    ['styles.css', '.ed-topbar.ed-bar-fold .ed-menu .ed-dropdown.open > .ed-menu { position: static; }', '']],
}
const mutant = process.env.RIG_MUTANT
if (mutant) {
  const m = MUTANTS[mutant]
  if (!m) { console.log(`  FAIL  unknown mutant ${mutant}`); process.exit(1) }
  const edits = Array.isArray(m[0]) ? m : [m]
  const origs = new Map()
  for (const [fileName, from, to] of edits) {
    const src = new URL(`../slides/src/${fileName}`, import.meta.url)
    if (!origs.has(src.href)) origs.set(src.href, readFileSync(src, 'utf8'))
    const now = readFileSync(src, 'utf8')
    if (now.split(from).length !== 2) {
      for (const [h, o] of origs) writeFileSync(new URL(h), o)
      console.log(`  FAIL  mutant ${mutant}: needle not found exactly once`); process.exit(1)
    }
    writeFileSync(src, now.replace(from, to))
  }
  let out = ''
  try {
    out = execFileSync('npm', ['run', 'build:single', '--prefix', 'slides'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, ZOPFLI: '0' } })
  } finally { for (const [h, o] of origs) writeFileSync(new URL(h), o) }
  // a mutant tsc rejects fails the build, and the rig would run the OLD shell
  if (!/compressed shell/.test(out)) { console.log(`  FAIL  mutant ${mutant}: the build did not finish`); process.exit(1) }
  console.log(`  (mutant build: ${mutant})`)
}

const shell = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tiers-rig-')))
const file = join(dir, `tiers-${Date.now()}.bento.html`)
writeFileSync(file, readFileSync(shell))

const DAY = 86_400_000

// counts every read of the agent's global, before any page script runs
const DESC_INIT = () => {
  window.__desc = 0
  for (const o of [Object, Reflect]) {
    const f = o.getOwnPropertyDescriptor
    o.getOwnPropertyDescriptor = function (t, k) { if (k === '__bentoIdentity') window.__desc++; return f.apply(this, arguments) }
  }
}
// the test agent answers from window.__answers, keyed by pub, filled in once keys exist
const AGENT_INIT = () => {
  window.__answers = {}
  window.__calls = []
  const agent = Object.freeze({
    contract: 1,
    whoami: async () => null,
    sign: async () => ({ ok: false, reason: 'unavailable' }),
    resolve: async (q) => { window.__calls.push(q.pub); return window.__answers[q.pub] ?? null },
  })
  Object.defineProperty(globalThis, '__bentoIdentity', { value: agent, writable: false, configurable: false })
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
let sockets = 0
async function open({ flag, agent, viewport = { width: 1440, height: 900 } }) {
  const ctx = await browser.newContext({ viewport, locale: 'en-US' })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.routeWebSocket(/.*/, (ws) => { sockets++; ws.close() })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.addInitScript(DESC_INIT)
  if (flag !== undefined) await p.addInitScript((v) => { try { localStorage.setItem('bento-people-vouch', v) } catch {} }, flag)
  if (agent) await p.addInitScript(AGENT_INIT)
  await p.goto('file://' + file)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-title'))
  const info = await p.evaluate(() => ({ v: window.bento.doc.collab?.v, hasPriv: !!window.bento.doc.collab?.ownerPriv, room: window.bento.doc.collab?.room, docId: window.bento.doc.docId }))

  const panelOpen = () => p.evaluate(() => !!document.querySelector('.ed-btn-share')?.parentElement?.classList.contains('open'))
  // on a phone Share lives inside ⋯: open that first
  const toggle = () => p.evaluate(() => {
    const sb = document.querySelector('.ed-btn-share')
    const more = sb.parentElement.parentElement.closest('.ed-dropdown')
    if (more && !more.classList.contains('open')) more.querySelector(':scope > button').click()
    sb.click()
  })
  const ensureOpen = async () => { if (!(await panelOpen())) await toggle() }
  const closePanel = async () => { if (await panelOpen()) await toggle() }
  await ensureOpen()
  // a DOM click: the panel rebuilds as the session starts, and Playwright's
  // actionability wait on a button being replaced timed out (1 run in 6)
  const goLive = () => p.evaluate(() => [...document.querySelectorAll('.ed-share-pop button')].find((b) => /Go live/.test(b.getAttribute('aria-label') || b.textContent))?.click())
  await goLive()
  await p.waitForTimeout(500)
  await closePanel()

  await p.evaluate(({ docId, room }) => {
    const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const ch = new BroadcastChannel(`bento-sync-${docId}`)
    const roomId = room.split('/').pop()
    ch.onmessage = (e) => { if (e.data?.pv !== undefined) window.__pv = e.data.pv }
    window.__peer = {
      async key() {
        const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
        return { key: kp.privateKey, pub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))) }
      },
      async beat(actor, name, pub, signWith) {
        const f = { pv: window.__pv, t: 'p', a: actor, p: { name, color: '#8FA3BF', slide: window.bento.doc.slides[0].id, sel: [], pub, role: 'editor' } }
        if (signWith) {
          const t = Date.now()
          const text = `pres.v1.${roomId}.${actor}.${pub}.${t}`
          const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signWith, new TextEncoder().encode(text)))
          f.kp = { t, g: b64u(sig) }
        }
        ch.postMessage(f)
      },
    }
  }, info)
  // the editor's first frame gives the wire version. If "Go live" was clicked
  // while the panel was still rendering, nothing is sent: click it again
  for (let i = 0; i < 15 && !(await p.evaluate(() => window.__pv !== undefined)); i++) {
    await ensureOpen()
    await goLive()
    await p.waitForTimeout(1000)
  }
  await closePanel()
  await p.waitForFunction(() => window.__pv !== undefined, null, { timeout: 8000 })
  const rows = () => p.evaluate(() => [...document.querySelectorAll('.ed-share-peers .ed-share-peer')].map((r) => {
    const who = r.querySelector('.who'); const v = who.querySelector('.vouch')
    return {
      text: who.textContent, state: v?.dataset.vouch ?? null, mark: v?.textContent ?? null, tip: v?.title ?? '', color: v ? getComputedStyle(v).color : null,
      vouched: who.classList.contains('vouched'),
      tags: [...who.querySelectorAll('.vouch-tag')].map((s) => ({ tag: s.dataset.tag, text: s.textContent, tip: s.title, color: getComputedStyle(s).color })),
      flag: r.querySelector(':scope > .vouch-flag')?.title ?? null,
      flagBeforeKick: !!r.querySelector(':scope > .vouch-flag + .kick'),
    }
  }))
  return { ctx, p, errors, info, ensureOpen, closePanel, rows }
}

const HOSTILE78 = 'Ulla ' + 'Unconfirmed-'.repeat(6).slice(0, 73)
const FDFD = '\uFDFD'.repeat(30)
// right-to-left, at the 80-character name limit once cleaned: Hebrew, then an RLO, Braille blanks
// and U+FDFD (the RLO and the blanks are stripped; the rest must not push the
// mark or the tags out of sight)
const RTL80 = ('\u05E8\u05D7\u05DC ' + '\u202E\u2800\uFDFD\u05E9\u05DC\u05D5\u05DD '.repeat(20)).slice(0, 110)

/** Make the peers (proven or not), set the agent's answers, open the panel. */
async function seat(s, peers) {
  await s.p.evaluate(async (peers) => {
    window.__k = {}
    for (const [actor] of peers) window.__k[actor] = await window.__peer.key()
  }, peers)
  await s.p.evaluate(async ({ peers, DAY, HOSTILE78, FDFD, RTL80 }) => {
    const now = Date.now()
    const six = (name, extra = {}) => ({ name, email: 'x@example.com', vouchedBy: 'id.bento.page', accountPub: name.slice(0, 1), firstSeen: 1, changed: false, ...extra })
    const g1 = (name, extra = {}) => six(name, { fields: 'g1', ...extra })
    const answer = {
      plain: g1('Alice Real'),
      native: g1('Nate Native', { tier: 'native', accountSince: now - 90 * DAY, rosterChangedAt: now - 2 * DAY }),
      incident: g1('Ivy Incident', { revoked: 'incident' }),
      signout: g1('Sam Signout', { revoked: 'signout' }),
      unconf: g1(HOSTILE78, { accountSince: now - 90 * DAY, unconfirmedSince: now - 40 * DAY }),
      fdfd: g1(FDFD, { unconfirmedSince: now - 40 * DAY }),
      legacy: six('Leo Legacy'),
      legchanged: six('Lena Legacy', { changed: true }),
      rtl: g1(RTL80, { accountSince: now - 90 * DAY, unconfirmedSince: now - 40 * DAY }),
      qualvia: g1('Quinn Qualified', { vouchedBy: 'id.bento.page, unconfirmed since 3 Mar 2027' }),
      longname: g1('Bartholomew ' + 'Featherstonehaugh-'.repeat(4)),
      tickname: g1('Vic \u2713 via bigcorp.com'),
      borrowed: g1('Alice Real'),
    }
    for (const [actor, , kind] of peers) {
      const k = window.__k[actor]
      if (window.__answers && answer[kind]) window.__answers[k.pub] = answer[kind]
    }
    // a peer beats again, as a real one does every few seconds; a beat can be
    // missed while the session is still starting
    window.__rebeat = async () => {
      for (const [actor, name, , proven] of peers) { const k = window.__k[actor]; await window.__peer.beat(actor, name, k.pub, proven ? k.key : null) }
    }
    await window.__rebeat()
  }, { peers, DAY, HOSTILE78, FDFD, RTL80 })
  await s.p.waitForTimeout(600)
  await s.ensureOpen()
  // presence, not Playwright's visibility check: the panel rebuilds its rows on
  // every peer beat, and a row replaced mid-check timed the selector out (1 run in 4)
  const seated = (n) => s.p.evaluate((n) => document.querySelectorAll('.ed-share-peers .ed-share-peer').length >= n, n)
  for (let i = 0; i < 10 && !(await seated(peers.length)); i++) {
    await s.p.evaluate(() => window.__rebeat())
    await s.p.waitForTimeout(1000)
    await s.ensureOpen()
  }
  await s.p.waitForFunction((n) => document.querySelectorAll('.ed-share-peers .ed-share-peer').length >= n, peers.length, { timeout: 10000 })
  await s.p.waitForTimeout(400)
}
const byText = (rs, t) => rs.find((r) => r.text.includes(t))

// Measured, not read. A piece that must be seen is laid out inside
// each clipping ancestor (.who, the scrolling list, the popover, the menu it
// hangs from) AND the viewport, is not ellipsised, and the point at its centre
// hits it. A text fragment is measured with a Range.
function measure(s, name, sel) {
  return s.p.evaluate(({ name, sel }) => {
    const row = [...document.querySelectorAll('.ed-share-peers .ed-share-peer')].find((r) => r.querySelector('.vouch-name')?.textContent.startsWith(name))
    if (!row) return { ok: false, why: 'no row' }
    row.scrollIntoView({ block: 'nearest' })
    const el = row.querySelector(sel)
    if (!el) return { ok: false, why: 'no ' + sel }
    const r = el.getBoundingClientRect()
    // an overflow box clips what it contains, but not past a position:fixed
    // box (the phone's share popover escapes the scrolling topbar that way)
    const clips = []
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (a !== el && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')) clips.push(a)
      if (cs.position === 'fixed') break
    }
    const vp = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    const inside = (b) => r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5
    const clipped = clips.filter((c) => !inside(c.getBoundingClientRect())).map((c) => c.className || c.tagName)
    const cut = el.scrollWidth > el.clientWidth + 1
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    const hits = !!hit && (hit === el || el.contains(hit))
    const good = r.width > 0 && r.height > 0 && inside(vp) && clipped.length === 0 && !cut && hits
    return { ok: good, why: `rect ${Math.round(r.left)}..${Math.round(r.right)} x ${Math.round(r.top)}..${Math.round(r.bottom)} in ${innerWidth}x${innerHeight}, clipped by [${clipped}], ellipsised ${cut}, hit ${hits ? 'it' : hit?.className}` }
  }, { name, sel })
}
async function mustSee(s, name, sel, msg) {
  const r = await measure(s, name, sel)
  ok(r.ok, `${msg}${r.ok ? '' : ' (' + r.why + ')'}`)
}
const fmtDay = (s, at) => s.p.evaluate((at) => new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(at)), at)

try {
  // ---- 1. kill switch unset, agent present, owner, desktop ----
  {
    const s = await open({ agent: true })
    ok(s.info.v === 2 && s.info.hasPriv, 'the fresh deck is a v2 owner copy')
    await seat(s, [
      ['rig-plain', 'Alice', 'plain', true], ['rig-native', 'Nate', 'native', true],
      ['rig-incident', 'Ivy', 'incident', true], ['rig-signout', 'Sam', 'signout', true],
      ['rig-unconf', 'Ulla', 'unconf', true], ['rig-legacy', 'Leo', 'legacy', true],
      ['rig-qualvia', 'Quinn', 'qualvia', true], ['rig-borrow', 'Eve', 'borrowed', false],
      ['rig-longname', 'Bart', 'longname', true], ['rig-tickname', 'Vic', 'tickname', true],
      ['rig-sqrt', 'Mal \u221A via id.bento.page', 'none', false],
      ['rig-legchanged', 'Lena', 'legchanged', true], ['rig-rtl', 'Rhea', 'rtl', true],
    ])
    let rs = await s.rows()

    const a = byText(rs, 'Alice Real')
    ok(a?.state === 'verified' && a.mark === '\u2713 via id.bento.page', 'kill switch unset, agent present: a complete answer shows "\u2713 via id.bento.page"')
    ok(a?.tags.map((x) => x.tag).join() === 'passkey,new', 'no tier fields: "(passkey sign-in)" and "new account", the weaker claims')
    ok(a?.tags[0]?.text === '(passkey sign-in)' && /passkey only/.test(a.tags[0].tip), 'the passkey tag says "(passkey sign-in)", its tooltip explains it')
    ok(a?.tags[1]?.text === 'new account' && /14 days/.test(a.tags[1].tip), 'the new-account tag says "new account", its tooltip names 14 days')

    const n = byText(rs, 'Nate Native')
    const changed = await fmtDay(s, Date.now() - 2 * DAY)
    ok(n?.state === 'verified' && n.tags.length === 1 && n.tags[0].tag === 'changed', 'native, old account: no passkey or new-account tag, one change tag')
    ok(n?.tags[0]?.text === `account changed on ${changed}`, `the change tag reads "account changed on ${changed}"`)

    const u = byText(rs, 'Ulla')
    const lapsed = await fmtDay(s, Date.now() - 40 * DAY)
    ok(u?.state === 'verified' && u.mark === '\u2713 via id.bento.page', 'unconfirmedSince: the \u2713 stays (the sign-in is verified)')
    ok(u?.tags.map((x) => x.tag).join() === 'unconfirmed,passkey', 'unconfirmedSince: the unconfirmed tag comes first, beside the \u2713')
    ok(u?.tags[0]?.text === `unconfirmed since ${lapsed}` && /hasn’t been confirmed since/.test(u.tags[0].tip),
      `the tag reads "unconfirmed since ${lapsed}", its tooltip says the address may no longer reach them`)

    const leo = rs.find((r) => r.text.startsWith('Leo'))
    ok(leo?.state === 'failed' && leo.mark === 'couldn’t check' && !leo.text.includes('\u2713'),
      'six fields only (what a relay that copies the original six delivers): "couldn’t check", no \u2713')
    ok(/app this file is open in/.test(leo?.tip ?? ''), 'its tooltip says the app did not pass everything on')
    ok(leo?.text.startsWith('Leo') && !leo.text.includes('Legacy'), 'six fields only: the typed name stays; the agent\'s name is not shown')
    // a changed binding only takes the ✓ away, so it is shown without the marker too
    const lena = byText(rs, 'Lena Legacy')
    ok(lena?.state === 'changed' && lena.mark === '\u26A0 changed' && !lena.text.includes('\u2713'),
      'six fields only, changed: true: "\u26A0 changed" all the same, no \u2713')
    // the unconfirmed tag is a warning: the amber of the revoked mark, not the muted grey of the tier tags
    const ivyMark = rs.find((r) => r.text.startsWith('Ivy'))?.color
    ok(!!u?.tags[0]?.color && u.tags[0].color === ivyMark && u.tags[0].color !== u.tags[1]?.color,
      `the unconfirmed tag is painted in the warning colour (${u?.tags[0]?.color}; warning ${ivyMark}, passkey tag ${u?.tags[1]?.color})`)
    const rhea = rs.find((r) => r.text.startsWith('\u05E8\u05D7\u05DC'))
    ok(rhea?.state === 'verified' && rhea.tags.map((x) => x.tag).join() === 'unconfirmed,passkey' && !/[\u202E\u2800]/.test(rhea.text),
      'a right-to-left 80-character name: verified, its tags in order, the RLO and Braille blanks stripped')
    const quinn = rs.find((r) => r.text.startsWith('Quinn'))
    ok(quinn?.state === 'failed' && !quinn.text.includes('\u2713'), 'a qualifier inside vouchedBy: "couldn’t check", no \u2713')

    const ivy = rs.find((r) => r.text.startsWith('Ivy'))
    ok(ivy?.state === 'revoked' && ivy.mark === 'this sign-in was revoked' && !ivy.text.includes('\u2713'), 'incident: "this sign-in was revoked", no \u2713, the typed name kept')
    ok(!!ivy?.flag && /security incident/.test(ivy.flag), 'incident: the owner sees the "!" flag naming the incident')
    ok(ivy?.flagBeforeKick, 'incident: the flag sits beside the ✕ remove control')
    const sam = rs.find((r) => r.text.startsWith('Sam'))
    ok(sam?.state === 'revoked' && !sam.text.includes('\u2713') && sam.flag === null, 'signed out everywhere: revoked, no \u2713, no incident flag')

    const eve = rs.find((r) => r.text.startsWith('Eve'))
    const calls = await s.p.evaluate(() => window.__calls.slice())
    const evePub = await s.p.evaluate(() => window.__k['rig-borrow'].pub)
    const alicePub = await s.p.evaluate(() => window.__k['rig-plain'].pub)
    ok(eve?.state === 'unproven' && !eve.text.includes('\u2713'), 'borrowed key: an unproven peer is not ticked')
    ok(!calls.includes(evePub), 'borrowed key: the agent is never asked about an unproven key')
    ok(calls.includes(alicePub), 'positive control: the agent IS asked about a proven key')

    const bartName = await s.p.evaluate(() => {
      const n = [...document.querySelectorAll('.ed-share-peers .vouch-name')].find((x) => x.textContent.startsWith('Bartholomew'))
      return n ? { long: n.scrollWidth > n.clientWidth } : null
    })
    if (process.env.RIG_SHOT) await s.p.locator('.ed-share-pop').screenshot({ path: process.env.RIG_SHOT })
    ok(bartName?.long === true, 'control: the 80-character name really is cut by its own ellipsis')
    const mal = rs.find((r) => r.text.startsWith('Mal'))
    ok(mal?.state === 'unproven' && !/[\u221A\u2713]/.test(mal.text), 'a typed "\u221A" is stripped from the name')
    const vic = byText(rs, 'Vic')
    ok(vic?.state === 'verified' && !vic.text.slice(0, vic.text.indexOf('\u2713 via')).includes('\u2713') && vic.text.includes('Vic via bigcorp.com'),
      'a verified account named "Vic \u2713 via bigcorp.com" loses its tick; only the real mark has one')

    for (const w of [1440, 1000, 760]) {
      if (w !== 1440) {
        await s.closePanel()
        await s.p.setViewportSize({ width: w, height: 900 })
        await s.p.waitForTimeout(300)
        await s.ensureOpen()
        await s.p.waitForTimeout(300)
      }
      await mustSee(s, 'Bartholomew', '.vouch', `${w}px, a long name: the \u2713 mark is fully visible`)
      await mustSee(s, 'Bartholomew', '.vouch-tag[data-tag="passkey"]', `${w}px, a long name: "(passkey sign-in)" is fully visible`)
      await mustSee(s, 'Bartholomew', '.vouch-tag[data-tag="new"]', `${w}px, a long name: "new account" is fully visible`)
      await mustSee(s, 'Nate Native', '.vouch-tag[data-tag="changed"]', `${w}px, "account changed on <date>" is fully visible`)
      await mustSee(s, 'Ulla', '.vouch', `${w}px, a 78-character name: its \u2713 is fully visible`)
      await mustSee(s, 'Ulla', '.vouch-tag[data-tag="unconfirmed"]', `${w}px, a 78-character name: "unconfirmed since <date>" is fully visible`)
      await mustSee(s, 'Leo', '.vouch', `${w}px, "couldn’t check" is fully visible`)
      await mustSee(s, 'Mal', '.vouch', `${w}px, a typed name reading "\u221A via id.bento.page": "not verified" is fully visible`)
      await mustSee(s, 'Ivy', '.vouch', `${w}px, revoked: "this sign-in was revoked" is fully visible`)
      await mustSee(s, 'Vic', '.vouch', `${w}px, that account's real "\u2713 via id.bento.page" is fully visible`)
      await mustSee(s, '\u05E8\u05D7\u05DC', '.vouch', `${w}px, a right-to-left 80-character name: its \u2713 is fully visible`)
      await mustSee(s, '\u05E8\u05D7\u05DC', '.vouch-tag[data-tag="unconfirmed"]', `${w}px, a right-to-left 80-character name: "unconfirmed since <date>" is fully visible`)
      await mustSee(s, 'Lena', '.vouch', `${w}px, "\u26A0 changed" without the marker is fully visible`)
    }
    await s.p.setViewportSize({ width: 1440, height: 900 })

    // reopened, the rows paint from the cache in the same tick they are built:
    // the flag must still sit beside ✕ (it once landed ahead of the dot)
    await s.closePanel()
    await s.ensureOpen()
    await s.p.waitForTimeout(200)
    const ivyCached = (await s.rows()).find((r) => r.text.startsWith('Ivy'))
    ok(!!ivyCached?.flag && ivyCached.flagBeforeKick, 'reopened from the cache: the incident flag still sits beside ✕')

    // the same deck seen by someone who is not the owner: no flag
    await s.closePanel()
    await s.p.evaluate(() => { delete window.bento.doc.collab.ownerPriv })
    await s.ensureOpen()
    await s.p.waitForTimeout(300)
    rs = await s.rows()
    const ivy2 = rs.find((r) => r.text.startsWith('Ivy'))
    ok(ivy2?.state === 'revoked' && ivy2.flag === null, 'not the owner: revoked is shown, the owner flag is not')
    ok(s.errors.length === 0, `no page errors${s.errors.length ? ': ' + s.errors[0] : ''}`)
    await s.ctx.close()
  }

  // ---- 2. phone widths: Share demoted into ⋯ ----
  for (const vp of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    const s = await open({ agent: true, viewport: vp })
    await seat(s, [
      ['rig-fdfd', 'Fay', 'fdfd', true], ['rig-unconf', 'Ulla', 'unconf', true],
      ['rig-incident', 'Ivy', 'incident', true], ['rig-plain', 'Alice', 'plain', true],
      ['rig-native', 'Nate', 'native', true], ['rig-legacy', 'Leo', 'legacy', true],
    ])
    const where = await s.p.evaluate(() => {
      const sb = document.querySelector('.ed-btn-share')
      const pop = sb.parentElement.querySelector('.ed-share-pop').getBoundingClientRect()
      return {
        fold: !!document.querySelector('.ed-topbar.ed-bar-fold'),
        inMore: !!sb.parentElement.parentElement.closest('.ed-dropdown.ed-phone-only'),
        pop: { left: pop.left, right: pop.right },
      }
    })
    ok(where.fold && where.inMore, `${vp.width}px: the bar is folded and Share sits inside ⋯ (the phone chrome under test)`)
    ok(where.pop.left >= -0.5 && where.pop.right <= vp.width + 0.5, `${vp.width}px: the share popover is inside the screen (${Math.round(where.pop.left)}..${Math.round(where.pop.right)})`)
    const rs = await s.rows()
    ok(byText(rs, 'Alice Real')?.state === 'verified', `${vp.width}px: positive control, a complete answer is verified`)
    await mustSee(s, '\uFDFD', '.vouch', `${vp.width}px, a name of 30 U+FDFD: its \u2713 is on screen and hit`)
    await mustSee(s, '\uFDFD', '.vouch-tag[data-tag="unconfirmed"]', `${vp.width}px, a name of 30 U+FDFD: "unconfirmed since <date>" is on screen and hit`)
    await mustSee(s, '\uFDFD', '.vouch-tag[data-tag="passkey"]', `${vp.width}px, a name of 30 U+FDFD: "(passkey sign-in)" is on screen and hit`)
    await mustSee(s, 'Ulla', '.vouch', `${vp.width}px, a 78-character name: its \u2713 is on screen and hit`)
    await mustSee(s, 'Ulla', '.vouch-tag[data-tag="unconfirmed"]', `${vp.width}px, a 78-character name: "unconfirmed since <date>" is on screen and hit`)
    await mustSee(s, 'Ivy', '.vouch', `${vp.width}px, revoked: "this sign-in was revoked" is on screen and hit`)
    await mustSee(s, 'Alice Real', '.vouch-tag[data-tag="new"]', `${vp.width}px: "new account" is on screen and hit`)
    await mustSee(s, 'Nate Native', '.vouch-tag[data-tag="changed"]', `${vp.width}px: "account changed on <date>" is on screen and hit`)
    await mustSee(s, 'Leo', '.vouch', `${vp.width}px: "couldn’t check" is on screen and hit`)
    ok(s.errors.length === 0, `${vp.width}px: no page errors${s.errors.length ? ': ' + s.errors[0] : ''}`)
    await s.ctx.close()
  }

  // ---- 3. kill switch 'off', agent present; and the old QA value 'on' ----
  const peersHtml = (s) => s.p.evaluate(() => {
    const l = document.querySelector('.ed-share-peers')
    // a key's fingerprint is random per run: compare everything else
    return l ? l.outerHTML.replace(/[A-Za-z0-9_-]{4}·[A-Za-z0-9_-]{4}·[A-Za-z0-9_-]{4}/g, 'FP') : null
  })
  let offHtml = null
  {
    const s = await open({ flag: 'off', agent: true })
    await seat(s, [['rig-plain', 'Alice', 'plain', true]])
    const rs = await s.rows()
    ok(rs.length === 1 && rs[0].state === null && rs[0].text === 'Alice' && rs[0].tags.length === 0 && !rs[0].vouched, 'kill switch off: the row is unchanged')
    ok((await s.p.evaluate(() => window.__calls.length)) === 0, 'kill switch off: the agent is never asked (0 resolve calls)')
    ok((await s.p.evaluate(() => window.__desc)) === 0, 'kill switch off: the agent global is never even read (0 descriptor reads)')
    offHtml = await peersHtml(s)
    await s.ctx.close()
  }
  {
    const s = await open({ flag: 'on', agent: true })
    await seat(s, [['rig-plain', 'Alice', 'plain', true]])
    const rs = await s.rows()
    ok(rs[0]?.state === 'verified', 'the old QA value "on" still shows the tiers')
    await s.ctx.close()
  }

  // ---- 4. kill switch unset, NO agent (file://, bento.page) ----
  {
    const s = await open({ agent: false })
    await seat(s, [['rig-plain', 'Alice', 'plain', true]])
    const rs = await s.rows()
    ok(rs.length === 1 && rs[0].state === null && rs[0].text === 'Alice' && rs[0].tags.length === 0 && !rs[0].vouched, 'no agent: the row is unchanged')
    ok((await s.p.evaluate(() => document.querySelectorAll('.vouch, .vouch-tag, .vouch-flag, .vouched').length)) === 0, 'no agent: 0 vouch nodes anywhere')
    const html = await peersHtml(s)
    ok(html !== null && html === offHtml, 'no agent: the People list HTML is identical to the kill-switch run (fingerprints normalised)')
    ok((await s.p.evaluate(() => window.__desc)) > 0, 'positive control: with the kill switch unset the panel DID look for an agent')
    ok(s.errors.length === 0, `no agent: no page errors${s.errors.length ? ': ' + s.errors[0] : ''}`)
    await s.ctx.close()
  }
  console.log(`  (WebSockets closed by the rig: ${sockets})`)
  ok(sockets > 0, 'positive control: routeWebSocket closed at least one socket')
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
