// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Agent-safe reads, in the packaged shell.
//
// A deck that is shared live carries its sharing keys in #bento-doc (`collab`).
// The reads an agent is pointed at — window.bento.read(), compact(), the
// "Copy document JSON" menu items — hand out the document with those keys left
// out, through ONE strip function (slides/src/envelope.ts stripCollabSecrets).
// The raw tooling reads (doc, serialize()) keep them, by contract.
//
// Fixture: a deck whose collab carries every kind of key in real formats (an
// owner and a writer P-256 pair, an owner-signed invite, an audience ticket
// store, a 32-byte room key) plus an embedded document carrying its own
// collab and docId. The positive control proves the booted store holds every
// one of them, so each "none" below is a strip, not a missing input. Every
// stripped read is also checked for its CONTENT, so an empty answer fails.
//
// Then: validate() reports any room key (read-only copy, unsigned room, audience
// store, owner file), sync.share() returns status, and loadDoc / Replace from
// JSON keep the open deck's own session and docId — including a document with
// no collab or docId key at all.
//
// The network is closed: http(s) aborted, WebSockets answered by a closed mock
// (context.routeWebSocket — page.route does not see sockets).
//
// Run: (cd slides && npm run build:single) && node scripts/test-slides-agent-reads-browser.mjs
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// --- fixture -----------------------------------------------------------------
const shellPath = fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))
const { subtle } = globalThis.crypto
const b64u = (b) => Buffer.from(b).toString('base64url')
async function pair() {
  const k = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return { k, pub: b64u(await subtle.exportKey('raw', k.publicKey)), priv: b64u(await subtle.exportKey('pkcs8', k.privateKey)) }
}
const sign = async (key, txt) => b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(txt)))
const owner = await pair(), writer = await pair(), inv = await pair(), aud = await pair()
const commit = b64u(await subtle.digest('SHA-256', Buffer.from(owner.pub, 'base64url')))
const rand32 = () => b64u(crypto.getRandomValues(new Uint8Array(32)))
const roomKey = rand32(), showKey = rand32(), embKey = rand32()
const collab = {
  room: `ws://127.0.0.1:1/d/w${commit}`, key: roomKey, on: true, v: 2, role: 'writer',
  owner: owner.pub, ownerPriv: owner.priv,
  writerPub: writer.pub, writerPriv: writer.priv,
  invite: { pub: inv.pub, priv: inv.priv, role: 'writer', sig: await sign(owner.k.privateKey, `inv.${inv.pub}.writer.0`) },
  audience: { invite: { pub: aud.pub, priv: aud.priv, role: 'audience', sig: await sign(owner.k.privateKey, `inv.${aud.pub}.audience.0`) }, key: showKey },
}
const DOCID = 'fixture-docid-0001'
const doc = {
  format: 'bento/slides', version: 1, title: 'Fixture deck', docId: DOCID,
  size: { width: 1280, height: 720 },
  theme: { background: '#101418', color: '#F2F0EA', accent: '#FF9E8A', fontFamily: 'system-ui, sans-serif' },
  slides: [{ id: 's1', background: '#101418', transition: 'none', notes: 'n', elements: [
    { id: 't1', type: 'text', x: 96, y: 260, w: 1088, h: 160, rotation: 0, opacity: 1, html: 'Hello', fontSize: 88,
      fontFamily: 'system-ui, sans-serif', fontWeight: 800, color: '#F2F0EA', align: 'left', valign: 'top', lineHeight: 1.1 },
    { id: 'e1', type: 'embed', x: 96, y: 450, w: 300, h: 150, rotation: 0, opacity: 1, app: 'bento/dash',
      view: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      doc: { format: 'bento/dash', title: 'Inner sheet', docId: 'emb-docid-0002', collab: { room: 'ws://127.0.0.1:1/d/rEMB', key: embKey } } },
  ] }],
  collab,
}
const SECRETS = {
  roomKey, ownerPriv: owner.priv, writerPriv: writer.priv, invitePriv: inv.priv,
  audienceInvitePriv: aud.priv, showKey, embeddedRoomKey: embKey, room: collab.room,
  embeddedRoom: 'ws://127.0.0.1:1/d/rEMB', embeddedDocId: 'emb-docid-0002',
}
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bento-agent-reads-')))
const fixture = join(scratch, 'fixture.bento.html')
const shell = readFileSync(shellPath, 'utf8')
const re = /(<script type="application\/bento\+json" id="bento-doc">)([\s\S]*?)(<\/script>)/
if (!re.test(shell)) throw new Error('no bento-doc block in ' + shellPath)
writeFileSync(fixture, shell.replace(re, (_, a, _b, c) => a + JSON.stringify(doc).replace(/</g, '\\u003c') + c))

const carried = (text) => {
  const s = typeof text === 'string' ? text : JSON.stringify(text)
  return Object.entries(SECRETS).filter(([, v]) => s && s.includes(v)).map(([k]) => k)
}
const none = (label, text) => {
  const hit = carried(text)
  ok(hit.length === 0, `${label} carries no sharing key${hit.length ? ` (carries: ${hit.join(', ')})` : ''}`)
}
// content check: the stripped read is the deck, not an empty answer
const hasContent = (label, text) => {
  const s = typeof text === 'string' ? text : JSON.stringify(text)
  ok(!!s && s.includes('Fixture deck') && s.includes('Hello') && s.includes('Inner sheet') && s.includes(DOCID),
    `${label} still carries the deck (title, text, embedded content, docId)`)
}

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
let sockets = 0
try {
  const ctx = await browser.newContext()
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.routeWebSocket(/.*/, (ws) => { sockets++; ws.close() })
  await ctx.addInitScript(() => {
    window.__clip = []
    const w = (t) => { window.__clip.push(String(t)); return Promise.resolve() }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: w, readText: () => Promise.resolve(window.__clip.at(-1) ?? ''),
      write: () => Promise.resolve(), read: () => Promise.resolve([]) } })
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('file://' + fixture)
  await page.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar'), null, { timeout: 30000 })
  await page.waitForTimeout(800)

  console.log('\npositive control')
  const live = await page.evaluate(() => JSON.stringify(window.bento.doc))
  const ctl = carried(live)
  const missing = Object.keys(SECRETS).filter((k) => !ctl.includes(k))
  ok(missing.length === 0, `the booted store carries every key in the fixture (${ctl.length}/${Object.keys(SECRETS).length})${missing.length ? ' missing: ' + missing.join(', ') : ''}`)
  const liveCollab = await page.evaluate(() => JSON.stringify(window.bento.doc.collab))
  const sansSync = (c) => { const o = JSON.parse(c ?? 'null'); if (o) delete o.sync; return JSON.stringify(o) }

  console.log('\nagent reads')
  const read = await page.evaluate(() => JSON.stringify(window.bento.read()))
  none('read()', read); hasContent('read()', read)
  ok(!('collab' in JSON.parse(read)), 'read() has no collab key at all')
  const readC = await page.evaluate(() => JSON.stringify(window.bento.read({ compact: true })))
  none('read({ compact: true })', readC)
  ok(JSON.parse(readC).compact === true && readC.includes('Hello'), 'read({ compact: true }) is the compact form of the deck')
  const compact = await page.evaluate(() => window.bento.compact())
  none('compact()', compact); hasContent('compact()', compact)
  ok(await page.evaluate(() => window.bento.read() !== window.bento.doc && window.bento.read().slides !== window.bento.doc.slides),
    'read() is a detached copy, not the live object')
  await page.evaluate(() => { const r = window.bento.read(); r.title = 'changed by caller'; r.slides.length = 0 })
  ok(await page.evaluate(() => window.bento.doc.title === 'Fixture deck' && window.bento.doc.slides.length === 1),
    'changing what read() returned changes nothing in the deck')

  console.log('\nraw reads stay raw (documented: they carry the keys)')
  ok(carried(live).includes('roomKey') && carried(live).includes('ownerPriv'), 'doc carries the keys')
  const ser = await page.evaluate(() => window.bento.serialize())
  ok(carried(ser).includes('roomKey') && carried(ser).includes('ownerPriv'), 'serialize() carries the keys (it is the file)')
  // serialize() stamps collab.sync into the live store; read() still leaves the block out
  const afterSer = await page.evaluate(() => JSON.stringify(window.bento.read()))
  none('read() after serialize() stamped the sync state', afterSer)
  ok(!afterSer.includes('"sync"'), 'and carries no sync state')

  console.log('\nmenu copies (the same strip)')
  // The Save ▾ menu, opened by its own trigger: clicking other topbar buttons
  // in search of it would insert elements and change the deck mid-check.
  const menuItem = (label) => page.evaluate((label) => {
    const menu = document.querySelector('.ed-save-menu')
    const wrap = menu?.closest('.ed-dropdown')
    if (!wrap) return false
    if (!wrap.classList.contains('open')) wrap.querySelector('.ed-split-caret')?.click()
    const el = [...menu.querySelectorAll('button')].find((n) => n.textContent.trim().startsWith(label))
    if (!el) return false
    el.click()
    wrap.classList.remove('open')
    return true
  }, label)
  const clips = {}
  for (const label of ['Copy document JSON', 'Copy compact JSON (for agents)']) {
    const n0 = await page.evaluate(() => window.__clip.length)
    const clicked = await menuItem(label)
    await page.waitForTimeout(300)
    const got = await page.evaluate((n) => window.__clip.slice(n), n0)
    ok(clicked && got.length === 1, `"${label}" wrote the clipboard once (${got.length})`)
    clips[label] = got[0] ?? ''
    none(`"${label}"`, clips[label]); hasContent(`"${label}"`, clips[label])
    await page.keyboard.press('Escape')
  }
  {
    const now = await page.evaluate(() => JSON.stringify(window.bento.read()))
    const diff = Object.keys(JSON.parse(now)).filter((k) => JSON.stringify(JSON.parse(now)[k]) !== JSON.stringify(JSON.parse(clips['Copy document JSON'])[k]))
    ok(diff.length === 0, `read() and "Copy document JSON" are the same copy${diff.length ? ' (differ in: ' + diff.join(', ') + ')' : ''}`)
  }

  console.log('\nvalidate()')
  const v = await page.evaluate(() => JSON.stringify(window.bento.validate()))
  none('validate()', v)
  const shapes = [
    ['owner file', (c) => c],
    ['read-only copy', (c) => ({ room: c.room, key: c.key, on: true, v: 2, owner: c.owner, writerPub: c.writerPub, role: 'reader' })],
    ['unsigned (legacy) room', (c) => ({ room: 'ws://127.0.0.1:1/d/rLEGACY', key: c.key, on: true })],
    ['presenter file (audience store, no private halves)', (c) => ({ room: c.room, key: c.key, on: true, v: 2, owner: c.owner, role: 'writer', audience: c.audience })],
  ]
  for (const [label, fn] of shapes) {
    const msgs = await page.evaluate(({ src }) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      // eslint-disable-next-line no-new-func
      d.collab = (new Function('return ' + src))()(d.collab)
      return window.bento.validate(d).findings.filter((f) => f.code === 'collab-secrets-present').map((f) => f.message)
    }, { src: fn.toString() })
    ok(msgs.length === 1, `validate() reports a ${label}`)
    if (label === 'read-only copy') ok(/read-only copy still carries the room key/.test(msgs[0] ?? ''), '…and says a read-only copy is not key-free')
    if (label.startsWith('unsigned')) ok(/unsigned room[^;]*write/.test(msgs[0] ?? ''), '…and says the key writes to an unsigned room')
    if (label.startsWith('presenter')) ok(/audience/.test(msgs[0] ?? ''), '…and names the audience store')
    none(`validate() message for a ${label}`, msgs.join('\n'))
  }
  ok((await page.evaluate(() => { const d = JSON.parse(JSON.stringify(window.bento.doc)); delete d.collab; return window.bento.validate(d).findings.filter((f) => f.code === 'collab-secrets-present').length })) === 0,
    'validate() is silent on a deck with no collab')

  console.log('\nloadDoc / Replace from JSON keep the open deck\'s session')
  const state = () => page.evaluate(() => ({ collab: JSON.stringify(window.bento.doc.collab ?? null), docId: window.bento.doc.docId, title: window.bento.doc.title }))
  const kept = async (label, title) => {
    const s = await state()
    ok(s.title === title && sansSync(s.collab) === sansSync(liveCollab) && s.docId === DOCID,
      `${label}: content replaced, collab and docId kept (title=${s.title}, docId=${s.docId})`)
  }
  const withTitle = (txt, title) => { const j = JSON.parse(txt); j.title = title; return JSON.stringify(j) }
  ok(await page.evaluate((t) => !!window.bento.loadDoc(t), withTitle(afterSer, 'L1')), 'loadDoc(read()) is accepted')
  await kept('loadDoc(read())', 'L1')
  ok(await page.evaluate((t) => !!window.bento.loadDoc(t), withTitle(compact, 'L2')), 'loadDoc(compact()) is accepted')
  await kept('loadDoc(compact())', 'L2')
  const bare = { format: 'bento/slides', title: 'L3', size: { width: 1280, height: 720 },
    theme: { background: '#000', color: '#fff', accent: '#f80', fontFamily: 'system-ui' }, slides: [{ id: 'z1', elements: [] }] }
  ok(!('collab' in bare) && !('docId' in bare), 'the minimal document has NO collab and NO docId key (absent-field case)')
  ok(await page.evaluate((t) => !!window.bento.loadDoc(t), JSON.stringify(bare)), 'loadDoc(minimal document) is accepted')
  await kept('loadDoc(document with no collab/docId keys)', 'L3')

  async function replaceUI(text) {
    const clicked = await menuItem('Replace from JSON')
    await page.waitForSelector('textarea.ed-about-json', { timeout: 5000 })
    await page.fill('textarea.ed-about-json', text)
    await page.evaluate(() => [...document.querySelectorAll('.ed-about button')].find((b) => b.classList.contains('ed-btn-primary')).click())
    await page.waitForTimeout(400)
    await page.evaluate(() => document.querySelector('.ed-about-overlay')?.remove())
    return clicked
  }
  ok(await replaceUI(withTitle(clips['Copy document JSON'], 'U1')), 'Replace from JSON opened')
  await kept('Replace from JSON with the copied document', 'U1')
  await replaceUI(withTitle(clips['Copy compact JSON (for agents)'], 'U2'))
  await kept('Replace from JSON with the compact copy', 'U2')
  await replaceUI(JSON.stringify({ ...bare, title: 'U3' }))
  await kept('Replace from JSON with a document with no collab/docId keys', 'U3')
  await page.evaluate(() => { for (let i = 0; i < 6; i++) window.bento.undo() })
  const u = await state()
  ok(sansSync(u.collab) === sansSync(liveCollab) && u.docId === DOCID, 'after six undos the deck still has its own session')
  const ser2 = await page.evaluate(() => window.bento.serialize())
  ok(carried(ser2).includes('roomKey') && carried(ser2).includes('ownerPriv'), 'and the saved file still carries its keys (the round-trip orphaned nothing)')

  console.log('\nsync.share()')
  const share = await page.evaluate(() => JSON.stringify(window.bento.sync.share()))
  none('sync.share() return value', share)
  const sh = JSON.parse(share)
  ok(sh && typeof sh.started === 'boolean' && typeof sh.online === 'string' && !('key' in sh) && !('room' in sh),
    `sync.share() returns status only (${share})`)

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`)
} finally {
  await browser.close()
}
console.log(`\nWebSockets attempted (answered by a closed mock): ${sockets}`)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
