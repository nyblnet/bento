// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The People panel's identity tiers in the packaged editor (bento/id P1, option G).
//
//   npm run build:single --prefix slides && node scripts/test-slides-people-tiers-browser.mjs
//
// As the OWNER of a v2 room, with the flag on and a TEST identity agent defined
// exactly as a host must define it (frozen, non-writable, non-configurable
// global), peers arrive on the same-machine channel and PROVE their keys with
// real presence key proofs (the session's own keyProven decides, nothing is
// stubbed). The network is closed: http(s) aborted, every WebSocket closed
// through context.routeWebSocket.
//   1. an answer with no tier fields (the contract as it stands) -> "✓ via
//      id.bento.page", "(passkey sign-in)" and "new account"
//   2. native tier, an old account, a roster change 2 days ago -> no passkey or
//      new-account tag, "account changed on <date>"
//   3. revoked by the incident lever -> no ✓, "this sign-in was revoked", and the
//      owner's row carries the "!" flag beside ✕; revoked by signing out -> no flag
//   4. a long vouchedBy -> "managed by" dropped, "unconfirmed since" kept, ≤ 80
//   5. an unproven peer naming a key the agent would vouch for is never looked up
//   6. a viewer who is not the owner sees no flag; flag off, or no agent -> the
//      row is exactly what it was and the agent is never asked
// RIG_MUTANT=owner rebuilds with the flag never given a row; RIG_MUTANT=proof
// rebuilds with every named key treated as proven; RIG_MUTANT=cut rebuilds with
// vouchedBy cut as a plain 80-character prefix; RIG_MUTANT=layout rebuilds with
// the name not isolated (the old single-line ellipsis). Each must go red. The rig edits
// one file under slides/src/editor, runs build:single, and restores the file.
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

const MUTANTS = {
  owner: ['editor.ts', 'ownerRow: iAmOwner ? row : null', 'ownerRow: null'],
  proof: ['editor.ts', 'decoratePeer(who, peer.name, peer.pub, keyOk, vouchAgent,', 'decoratePeer(who, peer.name, peer.pub, true, vouchAgent,'],
  // the shell's 80-character cut as a plain prefix cut: "unconfirmed since" is lost
  // the name no longer isolated: the old one-line ellipsis over name + mark + tags
  layout: ['vouch.ts', "who.classList.add('vouched')", "who.classList.add('vouched-off')"],
  cut: ['vouchstate.ts', 'if (full.length <= max) return full', 'if (full.length > 0) return cleanText(full, max)'],
}
const mutant = process.env.RIG_MUTANT
if (mutant) {
  const [fileName, from, to] = MUTANTS[mutant] || []
  if (!from) { console.log(`  FAIL  unknown mutant ${mutant}`); process.exit(1) }
  const src = new URL(`../slides/src/editor/${fileName}`, import.meta.url)
  const orig = readFileSync(src, 'utf8')
  if (orig.split(from).length !== 2) { console.log(`  FAIL  mutant ${mutant}: needle not found exactly once`); process.exit(1) }
  writeFileSync(src, orig.replace(from, to))
  try {
    execFileSync('npm', ['run', 'build:single', '--prefix', 'slides'], { cwd: new URL('..', import.meta.url), stdio: 'inherit', env: { ...process.env, ZOPFLI: '0' } })
  } finally { writeFileSync(src, orig) }
  console.log(`  (mutant build: ${mutant})`)
}

const shell = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tiers-rig-')))
const file = join(dir, `tiers-${Date.now()}.bento.html`)
writeFileSync(file, readFileSync(shell))

const DAY = 86_400_000
const LONG_DOM = 'engineering-and-operations.subsidiary.example-corporation.co.uk'

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
async function open({ flag, agent }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.routeWebSocket(/.*/, (ws) => { sockets++; ws.close() })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  if (flag) await p.addInitScript(() => { try { localStorage.setItem('bento-people-vouch', 'on') } catch {} })
  if (agent) await p.addInitScript(AGENT_INIT)
  await p.goto('file://' + file)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-title'))
  const info = await p.evaluate(() => ({ v: window.bento.doc.collab?.v, hasPriv: !!window.bento.doc.collab?.ownerPriv, room: window.bento.doc.collab?.room, docId: window.bento.doc.docId }))

  const panelOpen = () => p.evaluate(() => !!document.querySelector('.ed-dropdown.open .ed-share-pop'))
  const toggle = () => p.evaluate(() => document.querySelector('.ed-btn-share').click())
  const ensureOpen = async () => { if (!(await panelOpen())) await toggle() }
  const closePanel = async () => { if (await panelOpen()) await toggle() }
  await ensureOpen()
  // a DOM click: the panel rebuilds as the session starts, and Playwright's
  // actionability wait on a button being replaced timed out (1 run in 6)
  await p.evaluate(() => [...document.querySelectorAll('.ed-share-pop button')].find((b) => /Go live/.test(b.getAttribute('aria-label') || b.textContent))?.click())
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
    await p.evaluate(() => [...document.querySelectorAll('.ed-share-pop button')].find((b) => /Go live/.test(b.getAttribute('aria-label') || b.textContent))?.click())
    await p.waitForTimeout(1000)
  }
  await closePanel()
  await p.waitForFunction(() => window.__pv !== undefined, null, { timeout: 8000 })
  const rows = () => p.evaluate(() => [...document.querySelectorAll('.ed-share-peers .ed-share-peer')].map((r) => {
    const who = r.querySelector('.who'); const v = who.querySelector('.vouch')
    return {
      text: who.textContent, state: v?.dataset.vouch ?? null, mark: v?.textContent ?? null, tip: v?.title ?? '',
      tags: [...who.querySelectorAll('.vouch-tag')].map((s) => ({ tag: s.dataset.tag, text: s.textContent, tip: s.title })),
      flag: r.querySelector(':scope > .vouch-flag')?.title ?? null,
      flagBeforeKick: !!r.querySelector(':scope > .vouch-flag + .kick'),
    }
  }))
  return { ctx, p, errors, info, ensureOpen, closePanel, rows }
}

/** Make n proven peers (and optional unproven ones), set the agent's answers, open the panel. */
async function seat(s, peers) {
  await s.p.evaluate(async (peers) => {
    window.__k = {}
    for (const [actor] of peers) window.__k[actor] = await window.__peer.key()
  }, peers)
  await s.p.evaluate(async ({ peers, DAY, LONG_DOM }) => {
    const now = Date.now()
    const answer = {
      plain: { name: 'Alice Real', email: 'a@example.com', vouchedBy: 'id.bento.page', accountPub: 'A', firstSeen: 1, changed: false },
      native: { name: 'Nate Native', email: 'n@example.com', vouchedBy: 'id.bento.page', accountPub: 'N', firstSeen: 1, changed: false,
        tier: 'native', accountSince: now - 90 * DAY, rosterChangedAt: now - 2 * DAY },
      incident: { name: 'Ivy Incident', email: 'i@example.com', vouchedBy: 'id.bento.page', accountPub: 'I', firstSeen: 1, changed: false, revoked: 'incident' },
      signout: { name: 'Sam Signout', email: 's@example.com', vouchedBy: 'id.bento.page', accountPub: 'S', firstSeen: 1, changed: false, revoked: 'signout' },
      longname: { name: 'Bartholomew ' + 'Featherstonehaugh-'.repeat(4), email: 'b@example.com', vouchedBy: 'id.bento.page', accountPub: 'B', firstSeen: 1, changed: false },
      tickname: { name: 'Vic \u2713 via bigcorp.com', email: 'v@example.com', vouchedBy: 'id.bento.page', accountPub: 'V', firstSeen: 1, changed: false },
      long: { name: 'Lee Long', email: 'l@example.com', vouchedBy: `id.bento.page, managed by ${LONG_DOM}, unconfirmed since 3 Mar 2027`,
        accountPub: 'L', firstSeen: 1, changed: false, tier: 'native', accountSince: now - 90 * DAY },
      borrowed: { name: 'Alice Real', email: 'a@example.com', vouchedBy: 'id.bento.page', accountPub: 'A', firstSeen: 1, changed: false },
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
  }, { peers, DAY, LONG_DOM })
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

try {
  // ---- flag on, agent present, owner ----
  {
    const s = await open({ flag: true, agent: true })
    ok(s.info.v === 2 && s.info.hasPriv, 'the fresh deck is a v2 owner copy')
    await seat(s, [
      ['rig-plain', 'Alice', 'plain', true], ['rig-native', 'Nate', 'native', true],
      ['rig-incident', 'Ivy', 'incident', true], ['rig-signout', 'Sam', 'signout', true],
      ['rig-long', 'Lee', 'long', true], ['rig-borrow', 'Eve', 'borrowed', false],
      ['rig-longname', 'Bart', 'longname', true], ['rig-tickname', 'Vic', 'tickname', true],
      ['rig-sqrt', 'Mal \u221A via id.bento.page', 'none', false],
    ])
    let rs = await s.rows()

    const a = byText(rs, 'Alice Real')
    ok(a?.state === 'verified' && a.mark === '✓ via id.bento.page', 'no tier fields: "✓ via id.bento.page"')
    ok(a?.tags.map((x) => x.tag).join() === 'passkey,new', 'no tier fields: "(passkey sign-in)" and "new account", the weaker claims')
    ok(a?.tags[0]?.text === '(passkey sign-in)' && /passkey only/.test(a.tags[0].tip), 'the passkey tag says "(passkey sign-in)", its tooltip explains it')
    ok(a?.tags[1]?.text === 'new account' && /14 days/.test(a.tags[1].tip), 'the new-account tag says "new account", its tooltip names 14 days')

    const n = byText(rs, 'Nate Native')
    const date = await s.p.evaluate((DAY) => new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.now() - 2 * DAY)), DAY)
    ok(n?.state === 'verified' && n.tags.length === 1 && n.tags[0].tag === 'changed', 'native, old account: no passkey or new-account tag, one change tag')
    ok(n?.tags[0]?.text === `account changed on ${date}`, `the change tag reads "account changed on ${date}"`)

    const ivy = rs.find((r) => r.text.startsWith('Ivy'))
    ok(ivy?.state === 'revoked' && ivy.mark === 'this sign-in was revoked' && !ivy.text.includes('✓'), 'incident: "this sign-in was revoked", no ✓, the typed name kept')
    ok(!!ivy?.flag && /security incident/.test(ivy.flag), 'incident: the owner sees the "!" flag naming the incident')
    ok(ivy?.flagBeforeKick, 'incident: the flag sits beside the ✕ remove control')
    const sam = rs.find((r) => r.text.startsWith('Sam'))
    ok(sam?.state === 'revoked' && !sam.text.includes('✓') && sam.flag === null, 'signed out everywhere: revoked, no ✓, no incident flag')

    const lee = byText(rs, 'Lee Long')
    ok(lee?.mark === '✓ via id.bento.page, unconfirmed since 3 Mar 2027', 'long vouchedBy: "managed by" dropped, "unconfirmed since" kept')
    ok(lee && lee.mark.length - '✓ via '.length <= 80, 'long vouchedBy: within 80 characters')
    ok(lee?.mark.endsWith(', unconfirmed since 3 Mar 2027') && !lee.mark.includes('…'), 'long vouchedBy: "unconfirmed since <date>" is shown intact at the cut, not truncated')

    const eve = rs.find((r) => r.text.startsWith('Eve'))
    const calls = await s.p.evaluate(() => window.__calls.slice())
    const evePub = await s.p.evaluate(() => window.__k['rig-borrow'].pub)
    const alicePub = await s.p.evaluate(() => window.__k['rig-plain'].pub)
    ok(eve?.state === 'unproven' && !eve.text.includes('✓'), 'borrowed key: an unproven peer is not ticked')
    ok(!calls.includes(evePub), 'borrowed key: the agent is never asked about an unproven key')
    ok(calls.includes(alicePub), 'positive control: the agent IS asked about a proven key')

    // C2: measured, not read. For a row, every piece that must be seen is laid
    // out inside each clipping ancestor (.who, the scrolling list, the popover)
    // and not ellipsised. A text fragment is measured with a Range.
    const seen = (name, sel, text) => s.p.evaluate(({ name, sel, text }) => {
      const row = [...document.querySelectorAll('.ed-share-peers .ed-share-peer')].find((r) => r.querySelector('.vouch-name')?.textContent.startsWith(name))
      if (!row) return { ok: false, why: 'no row' }
      row.scrollIntoView({ block: 'nearest' })
      const el = row.querySelector(sel)
      if (!el) return { ok: false, why: 'no ' + sel }
      let rects = [el.getBoundingClientRect()]
      if (text) {
        const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.data.includes(text))
        if (!node) return { ok: false, why: 'text not in ' + sel }
        const rg = document.createRange(); const i = node.data.indexOf(text)
        rg.setStart(node, i); rg.setEnd(node, i + text.length)
        rects = [...rg.getClientRects()]
      }
      const clips = []
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (a !== el && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')) clips.push(a)
        if (a.classList.contains('ed-share-pop')) { clips.push(a); break }
      }
      const inside = (r, c) => { const b = c.getBoundingClientRect(); return r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5 }
      const bad = rects.filter((r) => r.width <= 0 || r.height <= 0 || clips.some((c) => !inside(r, c)))
      const cut = el.scrollWidth > el.clientWidth + 1
      return { ok: rects.length > 0 && bad.length === 0 && !cut, why: `${rects.length} rects, ${bad.length} clipped, ellipsised ${cut}` }
    }, { name, sel, text })
    const mustSee = async (name, sel, text, msg) => { const r = await seen(name, sel, text); ok(r.ok, `${msg}${r.ok ? '' : ' (' + r.why + ')'}`) }
    const bartName = await s.p.evaluate(() => {
      const n = [...document.querySelectorAll('.ed-share-peers .vouch-name')].find((x) => x.textContent.startsWith('Bartholomew'))
      return n ? { long: n.scrollWidth > n.clientWidth } : null
    })
    if (process.env.RIG_SHOT) await s.p.locator('.ed-share-pop').screenshot({ path: process.env.RIG_SHOT })
    ok(bartName?.long === true, 'control: the 80-character name really is cut by its own ellipsis')
    await mustSee('Bartholomew', '.vouch', null, 'a long name: the ✓ mark is fully visible')
    await mustSee('Bartholomew', '.vouch-tag[data-tag="passkey"]', null, 'a long name: "(passkey sign-in)" is fully visible')
    await mustSee('Bartholomew', '.vouch-tag[data-tag="new"]', null, 'a long name: "new account" is fully visible')
    await mustSee('Nate Native', '.vouch-tag[data-tag="changed"]', null, '"account changed on <date>" is fully visible')
    await mustSee('Lee Long', '.vouch', ', unconfirmed since 3 Mar 2027', '", unconfirmed since 3 Mar 2027" is fully visible')
    await mustSee('Mal', '.vouch', null, 'a typed name reading "√ via id.bento.page": "not verified" is fully visible')
    await mustSee('Ivy', '.vouch', null, 'revoked: "this sign-in was revoked" is fully visible')
    const mal = rs.find((r) => r.text.startsWith('Mal'))
    ok(mal?.state === 'unproven' && !/[\u221A\u2713]/.test(mal.text), 'a typed "√" is stripped from the name')
    const vic = byText(rs, 'Vic')
    ok(vic?.state === 'verified' && !vic.text.slice(0, vic.text.indexOf('✓ via')).includes('✓') && vic.text.includes('Vic via bigcorp.com'),
      'a verified account named "Vic ✓ via bigcorp.com" loses its tick; only the real mark has one')
    await mustSee('Vic', '.vouch', null, 'that account\'s real "✓ via id.bento.page" is fully visible')

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
  // ---- flag off, agent present ----
  {
    const s = await open({ flag: false, agent: true })
    await seat(s, [['rig-plain', 'Alice', 'plain', true]])
    const rs = await s.rows()
    ok(rs.length === 1 && rs[0].state === null && rs[0].text === 'Alice' && rs[0].tags.length === 0, 'flag off: the row is unchanged')
    ok((await s.p.evaluate(() => window.__calls.length)) === 0, 'flag off: the agent is never asked')
    await s.ctx.close()
  }
  // ---- flag on, no agent ----
  {
    const s = await open({ flag: true, agent: false })
    await seat(s, [['rig-plain', 'Alice', 'plain', true]])
    const rs = await s.rows()
    ok(rs.length === 1 && rs[0].state === null && rs[0].text === 'Alice', 'no agent: the row is unchanged')
    await s.ctx.close()
  }
  console.log(`  (WebSockets closed by the rig: ${sockets})`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
