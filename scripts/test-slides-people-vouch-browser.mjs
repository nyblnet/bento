// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The People panel shows who vouched for a collaborator (bento/id P1).
//
//   npm run build:single --prefix slides && node scripts/test-slides-people-vouch-browser.mjs
//
// WHAT THIS PROVES, in the packaged editor, against a TEST identity agent
// defined exactly as a host must define it (frozen, non-writable,
// non-configurable global):
//   1. verified   -> "Alice Real ✓ via id.bento.page", the typed name in the tooltip
//   2. unknown    -> "not verified"; a rejecting agent, a malformed answer and an
//                    agent that never answers -> "couldn't check" (after "checking…")
//   3. changed    -> "⚠ changed", never a ✓
//   4. a peer whose key the session has NOT proven is never looked up and never
//      ticked, even when the agent would vouch for that key (the borrowed-key attack)
//   5. a typed name cannot draw its own tick; bidi/invisible characters from the
//      agent are stripped
//   6. flag off, or no agent -> the panel is exactly what it was
//
// The session's proof (`session.keyProven`) does not exist in the kernel yet; the
// rig supplies it through Object.prototype, which is the only seam the packaged
// bundle leaves, and which exercises the real call site in editor.ts.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href

// pub -> what the test agent answers
const P = { alice: 'PUB-ALICE', bob: 'PUB-BOB', cara: 'PUB-CARA', dan: 'PUB-DAN', erin: 'PUB-ERIN', fay: 'PUB-FAY',
  gus: 'PUB-GUS', eve: 'PUB-EVE', mal: 'PUB-MAL', bidi: 'PUB-BIDI' }
const AGENT_INIT = () => {
  const calls = []
  const bind = (name) => ({ name, email: 'x@example.com', vouchedBy: 'id.bento.page', accountPub: 'A', firstSeen: 1, changed: false })
  const table = {
    'PUB-ALICE': () => bind('Alice Real'),
    'PUB-BOB': () => null,
    'PUB-CARA': () => { throw new Error('agent crashed') },
    'PUB-DAN': () => new Promise(() => {}),
    'PUB-ERIN': () => ({ ...bind('Erin Moved'), changed: true }),
    'PUB-FAY': () => ({ ...bind(''), name: '' }),
    'PUB-EVE': () => bind('Alice Real'), // would be vouched for IF it were ever asked
    'PUB-MAL': () => bind('Mallory'),
    'PUB-BIDI': () => bind('‮evil​ name'),
  }
  const agent = Object.freeze({
    contract: 1,
    whoami: async () => null,
    sign: async () => ({ ok: false, reason: 'unavailable' }),
    resolve: async (q) => { calls.push(q.pub); const f = table[q.pub]; return f ? f() : null },
  })
  Object.defineProperty(globalThis, '__bentoIdentity', { value: agent, writable: false, configurable: false })
  window.__vouchCalls = calls
}
const PROOF_INIT = () => {
  window.__proven = new Set()
  Object.defineProperty(Object.prototype, 'keyProven', {
    configurable: true, enumerable: false,
    value(actor, pub) { return window.__proven.has(pub) },
  })
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
async function open({ flag, agent }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const p = await ctx.newPage()
  await p.route(/^https?:/, (r) => r.abort())
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  if (flag) await p.addInitScript(() => { try { localStorage.setItem('bento-people-vouch', 'on') } catch {} })
  if (agent) await p.addInitScript(AGENT_INIT)
  await p.addInitScript(PROOF_INIT)
  await p.goto(SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
  return { ctx, p, errors }
}
/** Put peers into the session over the same BroadcastChannel a second tab uses. */
async function addPeers(p, peers, proven) {
  await p.evaluate(({ peers, proven }) => {
    for (const x of proven) window.__proven.add(x)
    const ch = new BroadcastChannel(`bento-sync-${window.bento.doc.docId}`)
    peers.forEach(([name, pub], i) => {
      ch.postMessage({ t: 'p', a: `peer-${i}`, pv: 2, p: { name, color: '#8FA3BF', slide: window.bento.doc.slides[0].id, sel: [], pub, role: 'editor' } })
    })
    ch.close()
  }, { peers, proven })
  await p.waitForFunction((n) => window.bento.sync.peers().length >= n, peers.length)
}
const openPanel = async (p) => {
  await p.click('.ed-btn-share')
  await p.waitForSelector('.ed-share-peer .who')
}
const rows = (p) => p.evaluate(() => [...document.querySelectorAll('.ed-share-peers .ed-share-peer')].map((r) => {
  const who = r.querySelector('.who'); const v = who.querySelector('.vouch')
  return { text: who.textContent, state: v?.dataset.vouch ?? null, mark: v?.textContent.trim() ?? null, tip: v?.title ?? '' }
}))
const byName = (rs, s) => rs.find((r) => r.text.includes(s))

try {
  // ---- 1-5: flag on, agent present ----
  {
    const { ctx, p, errors } = await open({ flag: true, agent: true })
    const peers = [
      ['Alice', P.alice], ['Bobby', P.bob], ['Cara', P.cara], ['Dan', P.dan], ['Erin', P.erin], ['Fay', P.fay],
      ['Mallory ✓ via id.bento.page', P.mal], ['Eve', P.eve], ['Bidi', P.bidi], ['Gus', P.gus],
    ]
    // everyone but Eve and Mallory has a proven key; Gus is proven but the agent has no binding
    await addPeers(p, peers, [P.alice, P.bob, P.cara, P.dan, P.erin, P.fay, P.bidi, P.gus])
    await openPanel(p)
    await p.waitForTimeout(300)
    let rs = await rows(p)
    const dan0 = byName(rs, 'Dan')
    ok(dan0?.state === 'checking' && dan0.mark === 'checking…', 'a slow agent shows "checking…" first')

    const alice = byName(rs, 'Alice Real')
    ok(!!alice && alice.state === 'verified' && alice.mark === '✓ via id.bento.page', 'verified: the resolved name and "✓ via id.bento.page"')
    ok(alice?.tip.includes('Verified by id.bento.page') && alice.tip.includes('“Alice”'), 'verified: the tooltip names the voucher and what they typed')
    ok(byName(rs, 'Gus')?.state === 'unverified' && byName(rs, 'Gus').mark === 'not verified', 'no binding -> "not verified"')
    ok(byName(rs, 'Bobby')?.state === 'unverified', 'resolve(null) -> "not verified"')
    ok(byName(rs, 'Cara')?.state === 'failed' && byName(rs, 'Cara').mark === 'couldn’t check', 'a rejecting agent -> "couldn’t check"')
    ok(byName(rs, 'Fay')?.state === 'failed', 'a malformed answer -> "couldn’t check", never a ✓')
    const erin = byName(rs, 'Erin Moved')
    ok(erin?.state === 'changed' && erin.mark === '⚠ changed' && !erin.text.includes('✓'), 'a changed binding -> "⚠ changed", no ✓')

    const eve = byName(rs, 'Eve')
    ok(eve?.state === 'unproven' && !eve.text.includes('✓'), 'borrowed key: an unproven peer is not ticked')
    const calls = await p.evaluate(() => window.__vouchCalls.slice())
    ok(!calls.includes(P.eve) && !calls.includes(P.mal), 'borrowed key: the agent is never asked about an unproven key')
    ok(calls.includes(P.alice), 'positive control: the agent IS asked about a proven key')

    const mal = rs.find((r) => r.text.startsWith('Mallory'))
    ok(!!mal && mal.state === 'unproven' && !mal.text.slice(0, mal.text.length - mal.mark.length).includes('✓'), 'a typed name cannot draw its own ✓')
    const bidi = rs.find((r) => r.text.includes('evil'))
    ok(!!bidi && !/[‮​]/.test(bidi.text) && bidi.state === 'verified', 'bidi/invisible characters from the agent are stripped')

    await p.waitForTimeout(5600)
    rs = await rows(p)
    ok(byName(rs, 'Dan')?.state === 'failed', 'an agent that never answers -> "couldn’t check" after the timeout')
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await ctx.close()
  }
  // ---- 6a: flag off, agent present ----
  {
    const { ctx, p } = await open({ flag: false, agent: true })
    await addPeers(p, [['Alice', P.alice]], [P.alice])
    await openPanel(p)
    await p.waitForTimeout(300)
    const rs = await rows(p)
    ok(rs.length === 1 && rs[0].state === null && rs[0].text === 'Alice', 'flag off: the row is unchanged')
    ok((await p.evaluate(() => window.__vouchCalls.length)) === 0, 'flag off: the agent is never asked')
    await ctx.close()
  }
  // ---- 6b: flag on, no agent ----
  {
    const { ctx, p } = await open({ flag: true, agent: false })
    await addPeers(p, [['Alice', P.alice]], [P.alice])
    await openPanel(p)
    const rs = await rows(p)
    ok(rs.length === 1 && rs[0].state === null && rs[0].text === 'Alice', 'no agent: the row is unchanged')
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks} checks, ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
