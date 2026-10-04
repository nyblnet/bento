// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Only a copy that can write gets write chrome — however it reached the editor.
//
//   npm run build:single --prefix slides && node scripts/test-slides-audience-gate-browser.mjs
//
// WHAT THIS PROVES, in the packaged document. An audience copy (the live
// broadcast's ticket, role 'audience') boots straight into the show and never
// the editor — but it can still ARRIVE in a running editor: dropped onto it,
// or handed to window.bento.loadDoc. There, the write chrome was gated on
// `role !== 'reader'`, a denylist that answered yes for 'audience': the Share
// panel offered "Invite to edit…", "Go live" and "Reset access…", the People
// row said Editor, and nothing locked editing. (Measured on 1.2.5, both routes.)
// Now `canWriteDeck` is an allowlist that fails closed — no collab, no role, or
// 'writer' — and the read-only lock follows a document that arrives, not only
// one that boots (which also covers a plain READER copy dropped onto an editor).
//   1. audience copy dropped: no write actions, Viewer, locked. By loadDoc it
//      no longer arrives at all — loadDoc keeps the OPEN deck's identity (the
//      document gate), so the pasted audience collab is never adopted;
//   2. reader copy dropped: locked (was not — the lock ran at build only);
//   3. a role this version does not know: read-only (fails closed);
//   4. controls: an owner copy (no role) and a 'writer' copy keep every action,
//      stay editable, and say Owner/Editor.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const WRITE_ACTIONS = ['Invite to edit…', 'Go live', 'Reset access…']
const base = { v: 2, on: false, room: 'wROOM', key: 'room-key', owner: 'OWNERPUB' }
const COPIES = {
  audience: { ...base, role: 'audience', key: 'show-key', invite: { pub: 'INVPUB', priv: 'INVPRIV', role: 'audience', sig: 'SIG' } },
  reader: { ...base, role: 'reader' },
  future: { ...base, role: 'some-later-role', invite: { pub: 'INVPUB', priv: 'INVPRIV', role: 'writer', sig: 'SIG' } },
  owner: { ...base, ownerPriv: 'OWNERPRIV' },
  writer: { ...base, role: 'writer', invite: { pub: 'INVPUB', priv: 'INVPRIV', role: 'writer', sig: 'SIG' } },
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
async function arrive(kind, route) {
  const p = await browser.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('dialog', (d) => d.dismiss())
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto(SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-btn-share'))
  await p.evaluate(async ({ collab, route }) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc)); d.collab = collab
    if (route === 'loadDoc') { window.bento.loadDoc(JSON.stringify(d)); return }
    // a saved copy dropped onto the running editor
    const html = `<!doctype html><html><body><script type="application/bento+json" id="bento-doc">${JSON.stringify(d).replace(/</g, '\\u003c')}<` + `/script></body></html>`
    const dt = new DataTransfer()
    dt.items.add(new File([html], 'copy.bento.html', { type: 'text/html' }))
    const target = document.querySelector('.ed-canvas-wrap') ?? document.body
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await new Promise((r) => setTimeout(r, 600))
  }, { collab: COPIES[kind], route })
  await p.waitForTimeout(300)
  const r = await p.evaluate(() => {
    const btn = document.querySelector('.ed-btn-share'); btn.click()
    const pop = document.querySelector('.ed-share-pop')
    const actions = [...pop.querySelectorAll('.ed-share-btn')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim())
    const me = pop.querySelector('.ed-share-me')?.textContent ?? ''
    btn.click()
    return { role: window.bento.doc.collab?.role, actions, me, locked: document.body.classList.contains('ed-reader'), banners: document.querySelectorAll('.ed-reader-banner').length }
  })
  await p.close()
  return { ...r, errors }
}

try {
  console.log('\naudience copy, by drop\n')
  {
    // a FILE keeps its own identity when opened, so the audience role arrives
    const r = await arrive('audience', 'drop')
    ok(r.role === 'audience', `it arrived in the editor (role ${r.role})`)
    ok(!WRITE_ACTIONS.some((a) => r.actions.includes(a)), `no write actions (${r.actions.join(', ') || 'none'})`)
    ok(/Viewer/.test(r.me) && !/Editor|Owner/.test(r.me), `the People row says Viewer ("${r.me}")`)
    ok(r.locked && r.banners === 1, `editing is locked, one banner (${r.banners})`)
    ok(r.errors.length === 0, `no page errors${r.errors.length ? ': ' + r.errors.join('; ') : ''}`)
  }
  console.log('\naudience copy, by loadDoc\n')
  {
    // loadDoc REPLACES the open deck's content and keeps the open deck's
    // identity (the document gate, restoregate.ts sanitizeDoc with live): the
    // pasted audience collab is never adopted, so there is nothing to lock —
    // the deck is still the owner's, with the owner's actions
    const r = await arrive('audience', 'loadDoc')
    ok(r.role !== 'audience', `the pasted audience identity is not adopted (role ${r.role ?? 'none'})`)
    ok(!r.locked && r.banners === 0 && WRITE_ACTIONS.every((a) => r.actions.includes(a)), 'the open deck stays the open deck: unlocked, its own actions')
    ok(r.errors.length === 0, `no page errors${r.errors.length ? ': ' + r.errors.join('; ') : ''}`)
  }
  console.log('\nreader copy dropped onto the editor\n')
  {
    const r = await arrive('reader', 'drop')
    ok(r.locked && !WRITE_ACTIONS.some((a) => r.actions.includes(a)), `locked, no write actions (locked ${r.locked})`)
  }
  console.log('\na role this version does not know\n')
  {
    const r = await arrive('future', 'drop')
    ok(r.locked && !WRITE_ACTIONS.some((a) => r.actions.includes(a)), `fails closed: locked, no write actions (${r.actions.join(', ') || 'none'})`)
  }
  for (const kind of ['owner', 'writer']) {
    console.log(`\ncontrol: ${kind} copy\n`)
    const r = await arrive(kind, 'drop') // a file keeps its own identity
    ok(WRITE_ACTIONS.every((a) => r.actions.includes(a)), `every write action is offered`)
    ok(!r.locked && r.banners === 0, 'editing is not locked')
    ok(kind === 'owner' ? /Owner/.test(r.me) : /Editor/.test(r.me), `the People row says ${kind === 'owner' ? 'Owner' : 'Editor'} ("${r.me}")`)
  }
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
