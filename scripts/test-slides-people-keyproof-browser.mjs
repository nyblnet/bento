// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// People panel: a presence key is shown as proven only when the session says so.
//
//   npm run build:single --prefix slides && node scripts/test-slides-people-keyproof-browser.mjs
//
// In the packaged editor, as the OWNER of a v2 room, rows are sent on the
// same-machine channel:
//   proven   - a peer that proves its own key: "Key-verified identity" and a
//              remove control;
//   unproven - a peer naming that same key without a proof: "Claimed key", no
//              remove control, a hint pointing at "Reset access…";
//   a legacy room (no v:2) shows no key wording and no per-key remove at all.
// Set RIG_MUTANT=1 to rebuild the shell with the panel treating every named key
// as proven (always-proven); the rig must then go red. The rig edits
// slides/src/editor/editor.ts, runs build:single, and restores the file.
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
const shell = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)
if (process.env.RIG_MUTANT === '1') {
  const src = new URL('../slides/src/editor/editor.ts', import.meta.url)
  const orig = readFileSync(src, 'utf8')
  const needle = 'this.session?.keyProven(peer.actor, peer.pub)'
  if (orig.split(needle).length !== 2) { console.log('  FAIL  mutant: expected exactly one keyProven call'); process.exit(1) }
  writeFileSync(src, orig.replace(needle, 'true'))
  try {
    execFileSync('npm', ['run', 'build:single', '--prefix', 'slides'], { cwd: new URL('..', import.meta.url), stdio: 'inherit', env: { ...process.env, ZOPFLI: '0' } })
  } finally { writeFileSync(src, orig) }
  console.log('  (mutant build: every named key reads as proven)')
}
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kp-rig-')))
const file = join(dir, `people-${Date.now()}.bento.html`)
writeFileSync(file, readFileSync(shell))

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + file)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-title'))
  const info = await p.evaluate(() => {
    const c = window.bento.doc.collab
    return { v: c?.v, hasPriv: !!c?.ownerPriv, room: c?.room, docId: window.bento.doc.docId }
  })
  ok(info.v === 2 && info.hasPriv, 'the fresh deck is a v2 owner copy')

  const panelOpen = () => p.evaluate(() => !!document.querySelector('.ed-dropdown.open .ed-share-pop'))
  const toggle = () => p.evaluate(() => document.querySelector('.ed-btn-share').click())
  const ensureOpen = async () => { if (!(await panelOpen())) await toggle() }
  const closePanel = async () => { if (await panelOpen()) await toggle() }

  // go live: same-machine channel only (the network is blocked)
  await ensureOpen()
  const gl = p.getByRole('button', { name: /Go live/ })
  if (await gl.count()) await gl.click({ timeout: 5000 })
  await p.waitForTimeout(500)
  await closePanel()

  // a raw sender on the document's channel; the wire version comes from a frame the editor sent
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
  await p.waitForFunction(() => window.__pv !== undefined, null, { timeout: 8000 })

  const rows = () => p.evaluate(() => [...document.querySelectorAll('.ed-share-peers .ed-share-peer')].map((r) => ({
    name: r.querySelector('.who')?.textContent || '', who: r.querySelector('.who')?.title || '',
    kick: !!r.querySelector('.kick'), hint: r.querySelector('.kick-unproven')?.title || '',
  })))

  await p.evaluate(async () => { window.__k = await window.__peer.key() })
  const kpub = await p.evaluate(() => window.__k.pub)
  await p.evaluate(async () => {
    await window.__peer.beat('rig-proven', 'Proven', window.__k.pub, window.__k.key)
    await window.__peer.beat('rig-unproven', 'Unproven', window.__k.pub, null)
  })
  await p.waitForTimeout(600)
  await ensureOpen()
  await p.waitForSelector('.ed-share-peers .ed-share-peer', { timeout: 5000 })
  let r = await rows()
  const pro = r.find((x) => x.name.startsWith('Proven'))
  const unp = r.find((x) => x.name.startsWith('Unproven'))
  ok(!!pro && !!unp, 'both rows are listed')
  ok(pro?.who.startsWith('Key-verified identity'), 'control: the peer that proved its key reads "Key-verified identity"')
  ok(pro?.kick, 'control: the proven peer offers a remove control')
  ok(unp?.who.startsWith('Claimed key') && !/verified/i.test(unp.who), 'the unproven row reads "Claimed key", never "verified"')
  ok(unp && !unp.kick, 'the unproven row offers no remove control')
  ok(/Reset access/.test(unp?.hint || ''), 'the unproven row points at "Reset access…"')

  // legacy room: no v:2 -> no key wording, no per-key remove
  await closePanel()
  await p.evaluate(() => { window.bento.doc.collab.v = undefined })
  await p.evaluate(async () => { await window.__peer.beat('rig-proven', 'Proven', window.__k.pub, window.__k.key) })
  await p.waitForTimeout(400)
  await ensureOpen()
  r = await rows()
  ok(r.length > 0 && r.every((x) => !x.kick && !x.hint && !/key/i.test(x.who)), 'legacy room: no identity wording and no per-key remove')
  ok(errors.length === 0, `no page errors ${errors.join('|')}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
