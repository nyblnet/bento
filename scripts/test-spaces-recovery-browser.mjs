// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The crash-recovery banner's older-copy warning, and the recovery-off notice,
// in the packaged bento/spaces.
//
//   npm run build:single --prefix spaces && node scripts/test-spaces-recovery-browser.mjs
//
// WHAT THIS PROVES (maintainer rulings 2026-10-15, shared with slides and type;
// slides' test-slides-save-copy-browser.mjs and
// test-slides-recovery-off-browser.mjs are the reference):
//   1. a recovery snapshot OLDER than the open file gets the warning — "This
//      recovered copy looks older than the file you opened. Keep the file
//      unless you know it’s newer." — with "Keep the file" first, primary and
//      FOCUSED, and "Restore anyway" still on offer;
//   2. "Keep the file" keeps the file and deletes nothing; "Restore anyway"
//      restores the snapshot;
//   3. a snapshot that is NOT older gets spaces' plain banner, which claims
//      nothing about "newer" or "safe";
//   4. under a host whose per-document store refuses the recovery copy, the
//      save status says crash recovery is off, ONCE, held long enough to read;
//      a host that keeps it gets no message;
//   5. Portuguese and German show slides' exact words.
//
// THE DATABASE IS PINNED: `bento-spaces-autosave` (kernel autosave.ts:
// `${appId}-autosave`). A legacy shared `bento-autosave` can sit beside it;
// planting there would test nothing.
//
// Served from 127.0.0.1 (the origin a file:// copy does not share), offline.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const DB = 'bento-spaces-autosave'
const OLDER = 'This recovered copy looks older than the file you opened. Keep the file unless you know it’s newer.'
const PLAIN = 'Unsaved changes from a previous session were found.'
const NOTICE = 'Crash recovery is off for this space — it’s too large to keep a backup copy. Save often.'
const shellPath = new URL('../spaces/dist-single/Bento_Spaces.bento.html', import.meta.url)
const shell = readFileSync(shellPath, 'utf8')

// a catalog value, read from the catalog file (slides' for the shared strings)
const catalog = (app, loc, key) => {
  const src = readFileSync(new URL(`../${app}/src/i18n/${loc}.ts`, import.meta.url), 'utf8')
  const line = src.split('\n').find((l) => l.startsWith(`  ${JSON.stringify(key)}: `))
  return line ? JSON.parse(line.slice(line.indexOf(': ') + 2).replace(/,$/, '')) : undefined
}

const routes = new Map([['/blank.html', shell]])
const server = createServer((q, r) => {
  const body = routes.get(new URL(q.url, 'http://x').pathname)
  if (body === undefined) { r.writeHead(404); r.end(); return }
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); r.end(body)
})
await new Promise((res) => server.listen(0, '127.0.0.1', res))
const base = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const newCtx = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.route((u) => !u.href.startsWith(base), (r) => r.abort())
  return ctx
}
try {
  // A saved space with a fixed docId and modified time, spliced into the shell.
  // Relative to now, never a fixed date: the app prunes recovery snapshots older than
  // 30 days on boot (kernel autosave pruneOld), so a fixed date would age the planted
  // snapshot out and the banner checks would fail from a calendar date on.
  const MODIFIED = new Date(Date.now() - 2 * 86_400_000).toISOString()
  const MS = Date.parse(MODIFIED)
  let doc
  {
    const ctx = await newCtx()
    const p = await ctx.newPage()
    await p.goto(base + '/blank.html')
    await p.waitForFunction(() => window.bento?.doc)
    doc = await p.evaluate((m) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.docId = 'rig-recovery-space'; d.modified = m; delete d.collab; return d }, MODIFIED)
    await ctx.close()
  }
  const open = '<script type="application/bento+json" id="bento-doc">'
  const i = shell.indexOf(open) + open.length, j = shell.indexOf('</' + 'script>', i)
  routes.set('/space.html', shell.slice(0, i) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(j))

  /** Open the space with a recovery snapshot taken at `at` planted in SPACES' own database. */
  async function withSnapshot(at, lang) {
    const ctx = await newCtx()
    if (lang) await ctx.addInitScript((l) => { try { localStorage.setItem('bento-lang', l) } catch {} }, lang)
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(base + '/space.html')
    await p.waitForFunction(() => window.bento?.doc)
    await p.evaluate(async ([d, when, name]) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(name, 1)
        // the kernel's own stores, should the app not have opened it yet
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains('recovery')) r.result.createObjectStore('recovery', { keyPath: 'docId' })
          if (!r.result.objectStoreNames.contains('versions')) r.result.createObjectStore('versions', { keyPath: 'id', autoIncrement: true }).createIndex('docId', 'docId', { unique: false })
        }
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
      })
      const snap = JSON.parse(JSON.stringify(d)); snap.title = 'Recovered edits'
      await new Promise((res, rej) => { const tx = db.transaction('recovery', 'readwrite'); tx.objectStore('recovery').put({ docId: d.docId, at: when, title: snap.title, json: JSON.stringify(snap) }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
      db.close()
    }, [doc, at, DB])
    await p.reload()
    await p.waitForFunction(() => window.bento?.doc)
    await p.waitForSelector('.sp-banner', { timeout: 8000 }).catch(() => {})
    await p.waitForTimeout(300)
    return { ctx, p, errors }
  }
  const bannerOf = (p) => p.evaluate(() => {
    const b = [...document.querySelectorAll('.sp-banner')].find((x) => [...x.querySelectorAll('button')].some((y) => y.textContent !== '✕'))
    if (!b) return null
    return {
      text: b.querySelector('span')?.textContent ?? '',
      buttons: [...b.querySelectorAll('button')].map((x) => x.textContent).filter((x) => x !== '✕'),
      primary: [...b.querySelectorAll('button.sp-primary')].map((x) => x.textContent),
      focused: b.contains(document.activeElement) ? document.activeElement.textContent : null,
    }
  })
  const held = (p, name) => p.evaluate(async ([id, db]) => {
    const d = await new Promise((res, rej) => { const r = indexedDB.open(db); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const row = await new Promise((res) => { const tx = d.transaction('recovery', 'readonly'); const g = tx.objectStore('recovery').get(id); g.onsuccess = () => res(g.result ?? null); g.onerror = () => res(null) })
    d.close()
    return row ? { at: row.at, title: row.title } : null
  }, [name, DB])
  const clickBtn = (p, label) => p.evaluate((l) => [...document.querySelectorAll('.sp-banner button')].find((x) => x.textContent === l).click(), label)

  console.log('\nan older snapshot: the warning banner\n')
  {
    const { ctx, p, errors } = await withSnapshot(MS - 3600_000)
    const b = await bannerOf(p)
    ok(!!b && b.text === OLDER, `the banner warns the copy looks older ("${b?.text}")`)
    ok(!!b && b.buttons.join(' · ') === 'Keep the file · Restore anyway', `"Keep the file" first, then "Restore anyway" (${b?.buttons.join(' · ')})`)
    ok(!!b && b.primary.join() === 'Keep the file', `"Keep the file" is the one primary button (${b?.primary.join(', ')})`)
    ok(!!b && b.focused === 'Keep the file', `keeping the file is the default: it has focus (${b?.focused})`)
    await clickBtn(p, 'Keep the file')
    await p.waitForTimeout(300)
    const kept = await p.evaluate(() => ({ gone: !document.querySelector('.sp-banner'), title: window.bento.doc.title }))
    const snap = await held(p, doc.docId)
    ok(kept.gone && kept.title === doc.title, `Keep the file closes the banner and keeps the file ("${kept.title}")`)
    ok(!!snap && snap.title === 'Recovered edits', `…without deleting the planted snapshot (a clock-skewed "older" must never cost work) (${JSON.stringify(snap)})`)
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
    await ctx.close()
  }
  {
    const { ctx, p } = await withSnapshot(MS - 3600_000)
    await clickBtn(p, 'Restore anyway')
    await p.waitForTimeout(400)
    const t = await p.evaluate(() => window.bento.doc.title)
    ok(t === 'Recovered edits', `"Restore anyway" restores the older snapshot ("${t}")`)
    await ctx.close()
  }

  console.log('\na snapshot that is not older: the plain banner\n')
  for (const [at, what] of [[MS + 3600_000, 'newer'], [MS, 'equal-time']]) {
    const { ctx, p } = await withSnapshot(at)
    const b = await bannerOf(p)
    ok(!!b && b.text === PLAIN, `${what}: spaces' plain banner ("${b?.text}")`)
    ok(!!b && !/newer|older|safe/i.test(b.text + ' ' + b.buttons.join(' ')), `${what}: it claims nothing about newer, older or safe`)
    ok(!!b && b.buttons.join(' · ') === 'Restore · Discard', `${what}: Restore then Discard (${b?.buttons.join(' · ')})`)
    // slides' default (lead ruling 2026-10-16): Restore primary, Discard not
    ok(!!b && b.primary.join() === 'Restore', `${what}: Restore is the one primary button (${b?.primary.join(', ') || 'none'})`)
    // …and, as in slides, not focused: no banner button holds focus
    ok(!!b && b.focused === null, `${what}: no banner button takes focus, as in slides (focus: ${b?.focused})`)
    await ctx.close()
  }

  console.log('\nslides\' words, in Portuguese and German\n')
  for (const loc of ['pt', 'de']) {
    const { ctx, p } = await withSnapshot(MS - 3600_000, loc)
    const b = await bannerOf(p)
    const want = {
      text: catalog('slides', loc, OLDER),
      keep: catalog('slides', loc, 'Keep the file'),
      anyway: catalog('slides', loc, 'Restore anyway'),
    }
    ok(!!want.text && !!b && b.text === want.text, `${loc}: the warning is slides' ("${b?.text}")`)
    ok(!!b && b.buttons.join(' · ') === `${want.keep} · ${want.anyway}` && b.focused === want.keep,
      `${loc}: the buttons are slides', the first focused (${b?.buttons.join(' · ')})`)
    await ctx.close()
  }

  // A host with a per-document store, played by the page: it announces `store`
  // and answers the kernel's postMessage requests, refusing or keeping the
  // recovery copy per run.
  async function hosted(refuse, lang) {
    const ctx = await newCtx()
    await ctx.addInitScript(([refuseRecovery, l]) => {
      if (l) try { localStorage.setItem('bento-lang', l) } catch {}
      window.__bentoHost = { ops: ['store'] }
      window.__sets = 0
      window.__notices = []
      const CH = '__bento_tray__'
      window.addEventListener('message', (ev) => {
        const d = ev.data
        if (!d || d[CH] !== true || d.dir !== 'req') return
        let result = { ok: true }
        if (d.op === 'store.set' && d.payload?.name === 'recovery') { window.__sets++; result = refuseRecovery ? { ok: false, reason: 'too-large' } : { ok: true } }
        if (d.op === 'store.get') result = { ok: true, bytes: null }
        if (d.op === 'store.list') result = { ok: true, names: [] }
        window.postMessage({ [CH]: true, dir: 'res', id: d.id, result }, '*')
      })
      // every time the save status is SET to a sentence (the status rewrites
      // its text on each call, so a repeat shows as a second record)
      new MutationObserver((ms) => {
        for (const m of ms) {
          const s = m.target.nodeType === 1 ? m.target.closest?.('.sp-status') : m.target.parentElement?.closest('.sp-status')
          if (s && m.type === 'childList' && s.textContent) window.__notices.push(s.textContent)
        }
      }).observe(document, { subtree: true, childList: true })
    }, [refuse, lang])
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(base + '/space.html')
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.sp-doctitle'))
    const edit = async (v) => {
      await p.locator('.sp-doctitle').fill(v)
      await p.locator('.sp-doctitle').press('Tab')
      await p.waitForTimeout(3300) // the 2.5s autosave debounce, then the host's answer
    }
    await edit('First edit')
    const first = await p.evaluate(() => {
      const s = document.querySelector('.sp-status')
      return { text: s?.textContent ?? '', shown: !!s?.classList.contains('sp-on'), sets: window.__sets }
    })
    await p.waitForTimeout(2500) // past the 1.8s an ordinary status lasts
    const stillUp = await p.evaluate(() => !!document.querySelector('.sp-status')?.classList.contains('sp-on'))
    await edit('Second edit')
    await p.waitForTimeout(500)
    const second = await p.evaluate((n) => ({ sets: window.__sets, notices: window.__notices.filter((x) => x.startsWith(n)).length }), NOTICE.slice(0, 12))
    await ctx.close()
    return { first, stillUp, second, errors }
  }

  console.log('\na host that refuses the recovery copy\n')
  {
    const r = await hosted(true)
    ok(r.first.sets >= 1, `the app asked the host to keep a recovery copy (${r.first.sets})`)
    ok(r.first.shown && r.first.text === NOTICE, `the save status says recovery is off ("${r.first.text}")`)
    ok(r.stillUp, 'and holds it long enough to read')
    ok(r.second.sets >= 1 && r.second.notices === 1, `said ONCE: a later autosave stays quiet (${r.second.notices} notice)`)
    ok(r.errors.length === 0, `no page errors${r.errors.length ? ': ' + r.errors.join('; ') : ''}`)
  }
  console.log('\na host that keeps it (the control)\n')
  {
    const r = await hosted(false)
    ok(r.first.sets >= 1 && r.second.notices === 0 && r.first.text !== NOTICE, `no recovery-off message (${r.second.notices})`)
  }
  for (const loc of ['pt', 'de']) {
    const r = await hosted(true, loc)
    const want = catalog('spaces', loc, NOTICE)
    ok(!!want && r.first.text === want, `${loc}: the notice is the catalog's ("${r.first.text}")`)
  }
} finally {
  await browser.close()
  server.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
