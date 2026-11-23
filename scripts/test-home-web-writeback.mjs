#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home in your browser, stage 2: saving. The document's own ⌘S, through
 * the frame's showSaveFilePicker and the session port, to a file the library
 * writes from the bytes it verified (home/web/src/writeback.ts).
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-home-web-writeback.mjs
 *   BENTO_BROWSER=webkit|firefox …      another engine (default chromium)
 *   … --mutants [name…] [--shard k/n]   each mutant must turn ITS row red (Chromium)
 *
 * Real release files: the frozen slides 1.2.10 shell (home/fixtures/gate1/real)
 * and slides 1.3.0 (home/web/fixtures), the first release whose document speaks
 * the store port, so its autosave keeps a recovery copy in the library. Each
 * document carries a canary; every edit carries a fresh EDIT- marker. Sockets
 * are refused for the whole run; every request is recorded.
 *
 * Rows (design names in brackets):
 *   [T1] a save writes the file: through the handle the library's own picker
 *        gave (Chromium: an OPFS file stands in for the person's file), the
 *        bytes pass scripts/shell-gate.mjs, a FRESH browser profile with every
 *        request aborted opens them from file:// with the canary and the
 *        marker; the hostile frame posting another release's file still gets
 *        the served code; a language pack survives byte for byte; an encrypted
 *        deck stays encrypted; after the write no recovery copy is held and no
 *        storage on the library origin holds the canary, the marker or the
 *        pack; the member key survives; a document that became encrypted loses
 *        its recovery copy; a file with no docId saves and keeps nothing.
 *   [T1 S.1a] positive control: a document closed after an edit and before a
 *        save keeps its recovery copy in the tab, and the SAME bytes reopened
 *        offer it; the same docId in different bytes is not offered it.
 *   [T3] the library adds nothing: the written document text is exactly what
 *        the shell posted.
 *   [T4] the code written is the release the file was served as (K5 blocks
 *        equal, same history entry; positive control: a write happened); a
 *        second save of a library-written file is the shell's own bytes
 *        exactly; a read-only verdict (tampered, forked, newer) makes ZERO
 *        createWritable calls on the file's handle however the document calls
 *        the writable, and keeps the changes only as a new file in the newest
 *        signed release, after the person asks; with the channel aborted the
 *        verdicts hold.
 *   [T5-4] nothing written names a bento.page or frame-site host the input did
 *        not (positive control: a planted link is found).
 *   [T6] without a handle (every engine): the chip shows from the first edit,
 *        stays after the export starts, and clears (recovery gone) only when
 *        the exported bytes are opened again; different bytes leave both.
 *   [T8] saves come only from this open's session port: a save posted to the
 *        library's window is ignored, a page that opens the library cannot post
 *        one, a flood closes the document, and the store port never takes one.
 *   [T2] every request is on the allow-list and none carries the canary or a
 *        marker (plain, base64, URI-encoded); positive control: planted requests
 *        from the library and the frame are seen.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
const ENGINE = process.env.BENTO_BROWSER || 'chromium'
const CHROMIUM = ENGINE === 'chromium'

// --- mutants -------------------------------------------------------------------
// src: edits to home/web/src (BENTO_HOME_WEB_MUTANT, applied by build.mjs, which
// refuses one whose text is not found exactly once). `only` runs the sections
// that hold the guarding row; `expect` is that row's text.
const MUTANTS = [
  { name: 'write-posted-html', why: '[T1] the library writes the html the frame posted, verbatim',
    src: { file: 'library.ts', from: "await w.write(new Blob([r.html], { type: 'text/html' }))", to: "await w.write(new Blob([m.html], { type: 'text/html' }))" },
    only: 't1b', expect: '[T1-b] the hostile frame' },
  { name: 'write-posted-when-genuine', why: '[T1] the library writes the posted html when it passes gate 1 on its own',
    src: { file: 'writeback.ts', from: "  const S = parts(served)\n", to: "  { const g = await judge(posted, held); if (g.verdict === 'genuine') return { html: posted, docText: '', encrypted: false, previewDropped: false } }\n  const S = parts(served)\n" },
    only: 't1b', expect: '[T1-b] the hostile frame' },
  { name: 'doc-only-splice', why: '[T1] only #bento-doc is carried (the stage 1 spliceDoc): packs are lost',
    src: { file: 'writeback.ts', from: '  for (const b of P.extras) {\n', to: '  for (const b of P.extras.slice(P.extras.length)) {\n' },
    only: 't1c', expect: '[T1-c]' },
  { name: 'keep-recovery-after-write', why: '[T1] a handle write leaves the recovery copy in place',
    src: { file: 'library.ts', from: '      s.held = null\n      settle(s.kept)\n', to: '      s.held = null\n' },
    only: 't1e', expect: '[T1-e] after the write' },
  { name: 'cache-the-pack', why: '[T1] the library keeps the saved file in Cache Storage',
    src: { file: 'library.ts', from: '    if (session !== s) return\n    if (\'refuse\' in r) {', to: "    if (session !== s) return\n    void caches.open('saved').then((c) => c.put('/last', new Response(m.html)))\n    if ('refuse' in r) {" },
    only: 't1e', expect: '[T1-e] no storage on the library origin' },
  { name: 'write-cache-not-handle', why: '[T1] the save goes to memory and not to the file',
    src: { file: 'library.ts', from: "if (m.purpose === 'bento-doc' && s.writable && s.handle) {", to: "if (m.purpose === 'bento-doc' && s.writable && s.handle && false) {" },
    only: 't1e', expect: '[T1-f] a file with no docId' },
  { name: 'settle-every-name', why: '[T1] a write-back clears the member key too',
    src: { file: 'library.ts', from: "const settle = (k: Kept) => { mem.delete(entryKey(k.entry, RECOVERY));", to: "const settle = (k: Kept) => { mem.delete(entryKey(k.entry, RECOVERY)); mem.delete(entryKey(k.entry, 'memberkey'));" },
    only: 't1e', expect: '[T1-g]' },
  { name: 'encrypted-keeps-recovery', why: '[T1] a document that became encrypted keeps its plaintext recovery copy',
    src: { file: 'library.ts', from: '    if (r.encrypted) { s.kept.noRetain = true; settle(s.kept) }\n', to: '' },
    only: 't1e', expect: '[T1 947-4]' },
  { name: 'library-adds-a-key', why: '[T3] the library writes its own key into the document',
    src: { file: 'writeback.ts', from: "  const edits: Array<Span & { text: string }> = [{ start: S.doc.start, end: S.doc.start + S.doc.text.length, text: P.doc.text }]",
      to: "  const edits: Array<Span & { text: string }> = [{ start: S.doc.start, end: S.doc.start + S.doc.text.length, text: P.doc.text.replace('{', '{\"libraryEntry\":1,') }]" },
    only: 't1e', expect: '[T3]' },
  { name: 'reformat-json', why: '[T4] the library re-stringifies the document JSON',
    src: { file: 'writeback.ts', from: "  const edits: Array<Span & { text: string }> = [{ start: S.doc.start, end: S.doc.start + S.doc.text.length, text: P.doc.text }]",
      to: "  const edits: Array<Span & { text: string }> = [{ start: S.doc.start, end: S.doc.start + S.doc.text.length, text: '\\n' + JSON.stringify(JSON.parse(P.doc.text), null, 1) + '\\n' }]" },
    only: 't1e', expect: '[T3]' },
  { name: 'writes-a-library-link', why: '[T5-4] the library writes a "last opened in home.bento.page" link into the file',
    src: { file: 'writeback.ts', from: "  return { html: out, docText: P.doc.text,", to: "  out = out.replace('</body>', '<a href=\"https://home.bento.page/open\">last opened in bento/home</a></body>')\n  return { html: out, docText: P.doc.text," },
    only: 't1e', expect: '[T5-4]' },
  { name: 'read-only-writes', why: '[T4] the verdict is not checked before writing: a read-only serve keeps its handle',
    src: { file: 'library.ts', from: "writable: false, handle: null, kept: await entryFor(bytes) })", to: "writable: true, handle, kept: await entryFor(bytes) })" },
    only: 't4ro', expect: 'make zero createWritable calls' },
  { name: 'recovery-by-docid', why: '[S.1a] the reopened entry is matched without the bytes\' hash',
    src: { file: 'library.ts', from: 'const again = [...kept.values()].find((k) => k.opened === opened && mem.has(', to: 'const again = [...kept.values()].find((k) => mem.has(' },
    only: 's1a', expect: '[S.1a] NEGATIVE' },
  { name: 'export-clears', why: '[T6] the chip and the recovery copy go when the export starts',
    src: { file: 'library.ts', from: '  download(html, name)\n', to: '  download(html, name)\n  settle(s.kept)\n' },
    only: 't6', expect: '[T6] still visible after the export' },
  { name: 'chip-hidden', why: '[T6] the chip never shows',
    src: { file: 'library.ts', from: "  show('unsaved', !!s && s.kept.dirty)\n", to: "  show('unsaved', false)\n" },
    only: 't6', expect: '[T6] the chip is visible from the first edit' },
  { name: 'save-by-window', why: '[T8] the library also takes saves posted to its window by the frame',
    src: { file: 'library.ts', from: "$('file').addEventListener('change', pick)\n", to: "$('file').addEventListener('change', pick)\naddEventListener('message', (e) => { if (session && e.source === session.frame.contentWindow) fromFrame(session, e.data) })\n" },
    only: 't8', expect: '[T8] a save posted to the library\'s window' },
  { name: 'no-save-rate', why: '[T8] no cap on saves',
    src: { file: 'library.ts', from: '  if (++s.inWindow > SAVES_PER_WINDOW) {', to: '  if (false) {' },
    only: 't8', expect: '[T8] a flood of saves' },
  { name: 'post-on-save', why: '[T2] the library posts the document somewhere the CSP allows when it saves',
    src: { file: 'library.ts', from: '  s.lastN = m.n\n', to: "  s.lastN = m.n\n  void fetch(__RELEASE_BASE__ + 'log', { method: 'POST', body: m.html.slice(0, 30000) }).catch(() => {})\n" },
    only: 't1e', expect: '[T2] every request' },
]

if (process.argv.includes('--mutants')) {
  // --shard k/n runs every n-th mutant from the k-th (CI splits them over steps)
  const sh = process.argv.indexOf('--shard')
  const [k, of] = sh > 0 ? process.argv[sh + 1].split('/').map(Number) : [1, 1]
  const only = process.argv.slice(process.argv.indexOf('--mutants') + 1).filter((a, i, all) => a !== '--shard' && all[i - 1] !== '--shard')
  let n = 0, bad = 0
  for (const m of MUTANTS.filter((x, i) => (!only.length || only.includes(x.name)) && i % of === k - 1)) {
    const env = { ...process.env, BENTO_BROWSER: 'chromium', NODE_NO_WARNINGS: '1', BENTO_HW_WB_ONLY: m.only }
    delete env.BENTO_HOME_WEB_MUTANT
    env.BENTO_HOME_WEB_MUTANT = JSON.stringify(m.src)
    const r = spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', timeout: 900_000 })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const applied = /mutant applied to a source/.test(out) && /mutant applied to b source/.test(out)
    const completed = /^\d+\/\d+ checks passed \(chromium\)/m.test(out) && !/the browser crashed/.test(out)
    const caught = out.split('\n').some((l) => l.includes('FAIL') && l.includes(m.expect))
    n++
    const killed = applied && completed && r.status !== 0 && caught
    if (!killed) bad++
    console.log(`  ${killed ? 'ok  ' : 'FAIL'}  ${m.name}: ${m.why} — ${!applied ? 'NOT APPLIED' : !completed ? 'the run did not complete (a crash is not a kill)' : caught ? 'red on its row' : r.status === 0 ? 'SURVIVED' : 'red, but not on its row'}`)
    if (!killed) console.log(out.split('\n').filter((l) => /FAIL|Error|mutant/.test(l)).slice(0, 8).map((l) => '        ' + l).join('\n'))
  }
  console.log(`\n${n - bad}/${n} mutants killed`)
  process.exit(bad ? 1 : 0)
}

const ONLY = process.env.BENTO_HW_WB_ONLY ? process.env.BENTO_HW_WB_ONLY.split(',') : null
const want = (k) => !ONLY || ONLY.some((o) => o === k || (o === 't1' && k.startsWith('t1')))

const { startServers, freePorts } = await import(path.join(ROOT, 'home/web/serve.mjs'))
const { spliceDoc, Histories, judge } = await import(path.join(ROOT, 'home/web/src/verify.ts'))
const { RELEASE_KEY } = await import(path.join(ROOT, 'home/webext/src/release.js'))
const { scanBlocks, executableScripts, sha256hex } = await import(path.join(ROOT, 'kernel/src/gate1.ts'))
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { guardBrowser, apiLogger } = await import(path.join(ROOT, 'scripts/lib/browser-guard.mjs'))

let checks = 0, failures = 0
let guard = null
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); guard?.progress(m) }
const note = (m) => { console.log(`  note  ${m}`); guard?.progress(m) }
const section = (m) => { console.log(`\n=== ${m}`); guard?.section(m) }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-home-wb-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

// --- fixtures ----------------------------------------------------------------------
const rnd = () => webcrypto.getRandomValues(new Uint32Array(2)).join('')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const shell1210 = read('home/fixtures/gate1/real/slides-1.2.10/Bento_Slides.bento.html')
const shell130 = read('home/web/fixtures/slides-1.3.0/Bento_Slides.bento.html')
const history130 = read('home/web/fixtures/slides-1.3.0/history.json')
const CANARY = 'BENTO-CANARY-' + rnd()
const PACKBODY = 'BENTO-PACK-' + rnd()
const docOf = (extra = {}) => ({
  format: 'bento/slides', version: 1, docId: webcrypto.randomUUID(), title: CANARY, size: { w: 1280, h: 720 },
  slides: [{ id: 's1', background: '#ffffff', elements: [{ id: 't1', type: 'text', x: 96, y: 200, w: 1000, h: 120, html: 'Hello ' + CANARY, fontSize: 48, color: '#16273E' }] }],
  ...extra,
})
const json = (d) => JSON.stringify(d).replace(/</g, '\\u003c')
const docA = docOf()
const deck1210 = spliceDoc(shell1210, json(docA))
const deck130 = spliceDoc(shell130, json(docA))
// the same docId in different bytes (a second slide): S.1a's negative
const deck130other = spliceDoc(shell130, json({ ...docA, slides: [...docA.slides, { id: 's2', background: '#fff', elements: [] }] }))
// a language pack, as a shell carries one
const packText = '\n' + JSON.stringify({ app: 'slides', lang: 'xx', label: 'Rig', strings: { Unlock: PACKBODY } }) + '\n'
if (shell130.split('</head>').length !== 2) throw new Error('the 1.3.0 shell has not exactly one </head>')
const deckPack = spliceDoc(shell130, json(docOf())).replace('</head>', () => `<script type="application/bento+lang" id="bento-lang-xx">${packText}</script></head>`)
// a password envelope (the kernel's own shape, kernel/src/save.ts encryptBody)
const PASSWORD = 'rig-password-' + rnd()
async function envelopeOf(text) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16)), iv = webcrypto.getRandomValues(new Uint8Array(12))
  const mat = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, ['deriveKey'])
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 300000 }, mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)))
  const b = (u) => Buffer.from(u).toString('base64')
  return JSON.stringify({ format: 'bento/enc', v: 1, it: 300000, salt: b(salt), iv: b(iv), data: b(ct) })
}
const deckEnc = spliceDoc(shell130, await envelopeOf(json(docOf())))
// no docId at all (the absent-field case)
const noId = docOf(); delete noId.docId
const deckNoId = spliceDoc(shell130, json(noId))

const hex = (s) => createHash('sha256').update(s).digest('hex')
const b64 = (s) => createHash('sha256').update(s).digest('base64')
const loaderOf = (html) => executableScripts(scanBlocks(html)).find((b) => b.text.includes('bento-rt') && !b.preview)
const withLoaderNote = (html, n) => { const b = loaderOf(html); const at = b.start + b.text.length; return html.slice(0, at) + `\n// ${n}\n` + html.slice(at) }
const tampered = (() => { const rt = scanBlocks(deck130).find((b) => b.id === 'bento-rt'); const at = rt.start + Math.floor(rt.text.length / 2); return deck130.slice(0, at) + (deck130[at] === 'A' ? 'B' : 'A') + deck130.slice(at + 1) })()
const forkDeck = withLoaderNote(deck130, 'a fork')
const futureShell = withLoaderNote(shell130, 'build 1.3.99')
const futureDeck = spliceDoc(futureShell, json(docA))

const files = { deck1210, deck130, deck130other, deckPack, deckEnc, deckNoId, tampered, forkDeck, futureDeck }
const F = (k) => path.join(work, `${k}.bento.html`)
for (const [k, v] of Object.entries(files)) fs.writeFileSync(F(k), v)

/** The code of a file, K5's way: every code block and executable script, by hash. */
async function codeOf(html) {
  const bl = scanBlocks(html)
  const out = []
  for (const b of bl) if (b.id === 'bento-rt' || b.id === 'bento-rt-css') out.push(`${b.id}:${await sha256hex(b.text)}`)
  // the loader; the preview remover is checked by gate 1 against the release's pin (it comes and goes with the preview)
  for (const b of executableScripts(bl)) if (!b.preview) out.push(`exec:${await sha256hex(b.text)}`)
  return out.join(' ')
}
const docTextOf = (html) => scanBlocks(html).find((b) => b.id === 'bento-doc')?.text
/** A file with its variable spans taken out (document text, title text, preview, carried data blocks): what a save must never change. */
function skeletonOf(html) {
  const bl = scanBlocks(html)
  const cuts = []
  for (const b of bl) {
    if (b.id === 'bento-doc') cuts.push([b.start, b.start + b.text.length, '<DOC>'])
    else if (b.type === 'application/bento+lang' || b.type === 'application/bento+json') cuts.push([b.tagStart, b.end, ''])
  }
  const t = /<title>([^<]*)<\/title>/.exec(html)
  if (t) cuts.push([t.index + 7, t.index + 7 + t[1].length, '<TITLE>'])
  const pv = html.indexOf('data-bento-preview')
  const rem = bl.find((b) => b.preview && b.tag === 'script')
  if (pv >= 0 && rem) cuts.push([html.lastIndexOf('<', pv), rem.end, ''])
  cuts.sort((a, b) => b[0] - a[0])
  let out = html
  for (const [a, z, r] of cuts) out = out.slice(0, a) + r + out.slice(z)
  return out
}
const held = new Histories(RELEASE_KEY, 'http://127.0.0.1:9/', fetch)
{
  const why = await held.take(history130)
  if (why) throw new Error(`the frozen 1.3.0 history does not verify: ${why}`)
}
const versionOf = async (html) => { const v = await judge(html, held.list()); return v.verdict === 'genuine' ? v.release.version : `unknown (${v.reason})` }

// the 1.3.99 entry and a throwaway key (build B's "release key"), for the read-only path
const p130 = JSON.parse(JSON.parse(history130).payload)
const futureLoader = loaderOf(shell130).text + '\n// build 1.3.99\n'
const e0 = p130.releases[0]
const futureEntry = { version: '1.3.99', sha256: hex(futureShell), at: '2026-11-23T00:00:00.000Z',
  pins: { v: 1, blocks: { ...e0.pins.blocks, loader: hex(futureLoader) }, scriptSrc: [`sha256-${b64(futureLoader)}`, ...e0.pins.scriptSrc.slice(1)] } }
const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', kp.publicKey)
const sign = async (payload) => JSON.stringify({ payload, sig: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(payload))).toString('base64') })
fs.writeFileSync(path.join(work, 'test-key.json'), JSON.stringify({ kty, crv, x, y }))
fs.writeFileSync(path.join(work, 'history-130.json'), history130)
fs.writeFileSync(path.join(work, 'history-test.json'), await sign(JSON.parse(history130).payload))
const historyPlus = JSON.stringify({ ...p130, releases: [futureEntry, ...p130.releases] })
const manifestFuture = await sign(JSON.stringify({ app: 'bento-slides', version: '1.3.99', sha256: hex(futureShell), url: 'https://bento.page/releases/slides/Bento_Slides.bento.html', at: futureEntry.at }))

// --- builds ----------------------------------------------------------------------
async function build(name, extra) {
  const [pl, pf, pr] = await freePorts(3)
  const out = path.join(work, name)
  const o = { library: `http://127.0.0.1:${pl}`, frame: `http://localhost:${pf}`, releaseBase: `http://127.0.0.1:${pr}/releases/` }
  execFileSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', out, '--library-origin', o.library, '--frame-origin', o.frame,
    '--release-base', o.releaseBase, '--dev', ...extra], { stdio: ['ignore', 'ignore', 'inherit'] })
  const info = JSON.parse(fs.readFileSync(path.join(out, 'build.json'), 'utf8'))
  if (info.mutant) console.log(`  mutant applied to ${name} source: ${info.mutant}`)
  const seen = []
  const s = await startServers({ dist: out, ports: { library: pl, frame: pf, release: pr }, onRequest: (r) => seen.push({ method: r.method, url: `http://${r.headers.host}${r.url}` }) })
  return { ...o, info, s, seen, out }
}
section(`builds (${ENGINE})`)
const A = await build('a', ['--history', path.join(work, 'history-130.json')])
const B = await build('b', ['--key', path.join(work, 'test-key.json'), '--history', path.join(work, 'history-test.json')])
// [T7] the library's budget, set by this PR (stage 1 set 32 KB; saving adds the write-back)
const BUDGET = { library: 40 * 1024, frame: 4 * 1024 }
ok(A.info.bytes.libraryWithoutHistories <= BUDGET.library, `[T7] library page ${A.info.bytes.libraryWithoutHistories} B (without bundled histories) is within ${BUDGET.library} B`)
ok(A.info.bytes.frame <= BUDGET.frame, `[T7] frame page ${A.info.bytes.frame} B, with the save polyfill, is within ${BUDGET.frame} B`)

// --- browser -------------------------------------------------------------------
// BENTO_CHANNEL=chrome runs system Chrome; the default is Playwright's bundled headless shell, as in CI
const browser = await pw[ENGINE].launch({ logger: apiLogger, ...(process.env.BENTO_CHANNEL ? { channel: process.env.BENTO_CHANNEL } : {}) })
guard = guardBrowser(browser, { rig: `home/web writeback (${ENGINE})` })
const recorded = []
const sockets = []
async function context() {
  const ctx = await browser.newContext({ acceptDownloads: true })
  await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
  ctx.on('request', async (r) => {
    const e = { method: r.method(), url: r.url(), body: r.postData() ?? '', headers: '' }
    recorded.push(e)
    try { e.headers = JSON.stringify(await r.allHeaders()) } catch {}
  })
  ctx.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})))
  // tee what the frame posts on the session port (the library sets port.onmessage): rig instrumentation only
  await ctx.addInitScript(() => {
    if (!/^http:\/\/127\.0\.0\.1:/.test(location.origin)) return
    const d = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
      configurable: true, get() { return d.get.call(this) },
      set(fn) { d.set.call(this, typeof fn !== 'function' ? fn : function (e) { if (e.data && e.data.kind === 'save') (window.__posted ||= []).push(e.data.html); return fn.call(this, e) }) },
    })
  })
  return ctx
}
const docFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame())
async function until(fn, ms = 20000) {
  const end = Date.now() + ms
  const limit = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('check timed out')), 10000))])
  while (Date.now() < end) { try { const v = await limit(fn()); if (v) return v } catch {} await new Promise((r) => setTimeout(r, 150)) }
  return null
}
const booted = (page) => until(async () => { const f = docFrame(page); return f && (await f.evaluate(() => !!(window.bento && window.bento.doc && window.bento.loadDoc))) ? f : null }, 30000)
const ui = (page) => page.evaluate(() => {
  const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null }
  return {
    viewing: document.body.classList.contains('viewing'), frames: document.querySelectorAll('iframe').length,
    problem: vis('problem-box') ? document.getElementById('problem').textContent : '', label: document.getElementById('doc-label').textContent,
    notice: vis('notice') ? document.getElementById('notice').textContent : '', chip: vis('unsaved'), saveCopy: vis('save-copy') ? document.getElementById('save-copy').textContent : '',
    savedIt: vis('saved-it'), away: vis('away') ? document.getElementById('away').textContent : '',
    recovery: Number(document.documentElement.getAttribute('data-bento-recovery') ?? 0), posted: (window.__posted ?? []).length,
    writes: window.__writes ?? 0,
  }
})
const settled = (page) => until(async () => { const u = await ui(page); return u.viewing || u.problem ? u : null }, 30000)
async function openByInput(page, key) { await page.setInputFiles('#file', F(key)); return settled(page) }
/** Open through the library's own picker (Chromium): an OPFS file stands in for the person's, its writes counted. */
async function openByHandle(page, key, html = files[key]) {
  const name = `rig-${key}.bento.html`
  await page.evaluate(async ({ name, html }) => {
    const root = await navigator.storage.getDirectory()
    const h = await root.getFileHandle(name, { create: true })
    const w = await h.createWritable(); await w.write(html); await w.close()
    window.__writes = 0
    const cw = h.createWritable.bind(h)
    h.createWritable = (...a) => { window.__writes++; return cw(...a) }
    window.__rigHandle = h
    window.showOpenFilePicker = async () => [h]
  }, { name, html })
  await page.evaluate(() => document.getElementById('file').click())
  return { u: await settled(page), name }
}
const opfsText = (page, name) => page.evaluate(async (n) => (await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile()).text(), name)
/** A scripted edit through window.bento, carrying a fresh marker. */
async function edit(fr) {
  const mark = 'EDIT-' + rnd()
  const done = await fr.evaluate((m) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides[0].elements[0].html = d.slides[0].elements[0].html + ' ' + m
    return !!window.bento.loadDoc(JSON.stringify(d))
  }, mark).catch((e) => String(e))
  if (done !== true) note(`the edit did not load: ${done}`)
  return mark
}
/** ⌘S as a person presses it: the document's window focused, the key from the keyboard (a press on its body element misses 1.3.0's handler). */
async function cmdS(fr) {
  await fr.evaluate(() => { document.activeElement?.blur?.(); window.focus() }).catch(() => {})
  await fr.page().keyboard.press('ControlOrMeta+s').catch(() => {})
}
const MARKS = []
const keep = (name, text) => { const p = path.join(work, name); fs.writeFileSync(p, text); return p }
const gate = (p) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/shell-gate.mjs'), p], { encoding: 'utf8' }); return { ok: r.status === 0, out: (r.stdout + r.stderr).split('\n').filter((l) => /FAIL|fail|error/i.test(l)).slice(0, 2).join(' | ') } }
/** Open a file from file:// in a FRESH profile with every request aborted: what the person's file holds. */
async function fromDisk(p, password) {
  const dir = fs.mkdtempSync(path.join(work, 'profile-'))
  const ctx = await pw[ENGINE].launchPersistentContext(dir, { logger: apiLogger, ...(process.env.BENTO_CHANNEL ? { channel: process.env.BENTO_CHANNEL } : {}) })
  try {
    const aborted = []
    await ctx.route(/^(https?|wss?):/, (r) => { aborted.push(r.request().url()); r.abort() })
    await ctx.routeWebSocket(/.*/, (ws) => ws.close())
    const page = ctx.pages()[0] ?? await ctx.newPage()
    await page.goto('file://' + p)
    if (password) {
      const gated = await until(() => page.evaluate(() => !!document.querySelector('.ed-pwgate input')), 30000)
      if (!gated) return { gated: false }
      await page.fill('.ed-pwgate input', password)
      await page.press('.ed-pwgate input', 'Enter')
    }
    const up = await until(() => page.evaluate(() => !!(window.bento && window.bento.doc && window.bento.doc.slides)), 30000)
    if (!up) return { booted: false, gated: !!password }
    const d = await page.evaluate(() => ({ title: window.bento.doc.title, text: JSON.stringify(window.bento.doc.slides) }))
    return { booted: true, gated: !!password, ...d, aborted: aborted.length }
  } finally { await ctx.close() }
}
/** Every store on the library origin, serialized: IndexedDB, Cache Storage, OPFS (but the person's file) and web storage. */
const scanStorage = (page, skip) => page.evaluate(async (skip) => {
  const parts = []
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); parts.push(k, localStorage.getItem(k)) } } catch {}
  try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); parts.push(k, sessionStorage.getItem(k)) } } catch {}
  try {
    for (const name of await caches.keys()) { const c = await caches.open(name); for (const r of await c.keys()) parts.push(r.url, await (await c.match(r)).text()) }
  } catch {}
  try {
    const root = await navigator.storage.getDirectory()
    for await (const [n, h] of root.entries()) if (!skip.includes(n) && h.kind === 'file') parts.push(n, await (await h.getFile()).text())
  } catch {}
  try {
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
      for (const s of db.objectStoreNames) {
        const all = await new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]) })
        parts.push(name, s, JSON.stringify(all))
      }
      db.close()
    }
  } catch {}
  return parts.join('\n')
}, skip)
const hostsIn = (html) => new Set(html.match(/[a-z0-9.-]*bento\.page[\w/.?=&%-]*|127\.0\.0\.1:\d+|localhost:\d+/g) ?? [])
const newHosts = (input, output) => [...hostsIn(output)].filter((h) => !hostsIn(input).has(h))

// the kernel's store client, as a later shell carries it, for rows that need a store the 1.2.10 shell never uses
const esbuild = process.env.ESBUILD || path.join(ROOT, 'slides/node_modules/.bin/esbuild')
const kernelJs = execFileSync(esbuild, [path.join(ROOT, 'kernel/src/docstore.ts'), '--bundle', '--format=iife', '--global-name=__bentoKernelStore', '--platform=browser', '--target=es2022', '--log-level=error'], { encoding: 'utf8' })
const loadKernel = (fr) => fr.evaluate((code) => new Promise((res, rej) => {
  const el = document.createElement('script')
  el.src = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  el.onload = () => res(true); el.onerror = () => rej(new Error('the kernel bundle did not load'))
  document.head.appendChild(el)
}), kernelJs)

// ===== [T1][T3][T4][T5-4] write-back through the handle (Chromium) =====================================
const T1 = ['t1a', 't1b', 't1c', 't1d', 't1e'].some(want)
if (T1 && !CHROMIUM) note(`[T1] the handle path is Chromium's (showOpenFilePicker); ${ENGINE} runs the export path in [T6]`)
if (T1 && CHROMIUM) {
  section('[T1] a save writes the file, from the bytes the library verified')
  const ctx = await context()
  const page = await ctx.newPage()
  const outputs = []
  let o, fr
  if (want('t1a')) {
    for (const key of ['deck1210', 'deck130']) {
      await page.goto(A.library + '/')
      const { u, name } = await openByHandle(page, key)
      const fr = await booted(page)
      ok(!!fr && /saves to this file/.test(u?.label ?? ''), `[T1-a] ${key}: opened through the library's picker, labelled as saving to the file (${u?.label})`)
      if (!fr) continue
      const mark = await edit(fr)
      MARKS.push(mark)
      await cmdS(fr)
      const wrote = await until(async () => { const v = await ui(page); return v.writes > 0 ? v : null }, 20000)
      await new Promise((r) => setTimeout(r, 500))
      const bytes = await opfsText(page, name)
      const posted = await page.evaluate(() => (window.__posted ?? []).at(-1) ?? null)
      const p = keep(`${key}-saved.bento.html`, bytes)
      outputs.push({ key, input: files[key], bytes })
      ok(!!wrote && bytes.includes(mark), `[T1-f] ${key}: ⌘S wrote the file through its handle, and the file holds the edit (${wrote?.writes ?? 0} write(s))`)
      const g = gate(p)
      ok(g.ok, `[T1-a] ${key}: the written file passes scripts/shell-gate.mjs ${g.out}`)
      // [T4-1] the code written is the release served, and its history entry
      ok((await codeOf(bytes)) === (await codeOf(files[key])) && (await versionOf(bytes)) === (await versionOf(files[key])),
        `[T4-1] ${key}: the written code (K5 blocks) equals the input's, the same release ${await versionOf(bytes)}`)
      // [T3] the document text written is exactly the one the shell posted
      ok(!!posted && docTextOf(bytes) === docTextOf(posted), `[T3] ${key}: the written document text is exactly the shell's: the library adds no key`)
      // against what the shell itself wrote: the shell may mint a relay room (an allow-listed host, T5 step 1); the library may add nothing
      ok(!!posted && newHosts(posted, bytes).length === 0, `[T5-4] ${key}: the written file names no bento.page or frame-site host the shell's own save did not (${posted ? newHosts(posted, bytes).join(', ') || 'none' : 'nothing posted'})`)
      const disk = await fromDisk(p)
      ok(disk.booted && disk.title === CANARY && disk.text.includes(mark), `[T1-a] ${key}: a fresh profile, every request aborted, opens the file from file:// with the canary and the edit (${JSON.stringify({ b: disk.booted, t: disk.title === CANARY })})`)
      // [T4-2] no reformat: outside the data spans the written file is the served file, byte for byte
      ok(skeletonOf(bytes) === skeletonOf(files[key]), `[T4-2] ${key}: outside the document, title, preview and data blocks, the written file is the served file byte for byte`)
      // why the library re-splices at all: the shell's own save, inside the frame, is no working file
      if (posted) ok((await versionOf(posted)).startsWith('unknown') && /src="blob:/.test(posted), `[T1] ${key}: the html the shell posts from inside the frame is no release (its scripts are the frame's blob: URLs), so only a re-splice writes a working file`)
      if (key === 'deck130') {
        const mark2 = await edit(fr)
        MARKS.push(mark2)
        const before = (await ui(page)).writes
        await cmdS(fr)
        await until(async () => (await ui(page)).writes > before, 20000)
        await new Promise((r) => setTimeout(r, 500))
        const second = await opfsText(page, name)
        const posted2 = await page.evaluate(() => (window.__posted ?? []).at(-1) ?? null)
        ok(second.includes(mark2) && docTextOf(second) === docTextOf(posted2 ?? '') && skeletonOf(second) === skeletonOf(files[key]),
          '[T4-2] a second save in the same open writes the new document text exactly, around the same served bytes')
      }
    }
    // positive control for [T5-4]: a planted link is found
    ok(outputs.length > 0 && newHosts(outputs[0].bytes, outputs[0].bytes.replace('</body>', '<a href="https://home.bento.page/open">last opened in bento/home</a></body>')).length > 0,
      '[T5-4] positive control: a "last opened in home.bento.page" link planted in a written file is found')

  }
  if (want('t1b')) {
    // [T1-b] the hostile frame: it posts a GENUINE 1.2.10 file (the other release) with its edit
    await page.goto(A.library + '/')
    o = await openByHandle(page, 'deck130')
    fr = await booted(page)
    if (fr) {
      const mark = 'EDIT-' + rnd()
      const other = spliceDoc(shell1210, json({ ...docA, title: mark }))
      const r = await fr.evaluate(async (html) => {
        const h = await window.showSaveFilePicker({ id: 'bento-doc' })
        const w = await h.createWritable(); await w.write(new Blob([html])); return w.close().then(() => 'saved', (e) => e.name)
      }, other).catch((e) => String(e))
      await new Promise((res) => setTimeout(res, 500))
      const bytes = await opfsText(page, o.name)
      ok(r === 'saved' && bytes.includes(mark) && (await codeOf(bytes)) === (await codeOf(deck130)) && (await versionOf(bytes)) === '1.3.0',
        `[T1-b] the hostile frame posts a genuine 1.2.10 file: its DATA is written, in the 1.3.0 code served (${r}, ${await versionOf(bytes)})`)
      // and a file that is not a release at all: refused, nothing written
      const before = (await ui(page)).writes
      const junk = await fr.evaluate(async () => {
        const h = await window.showSaveFilePicker({ id: 'bento-doc' })
        const w = await h.createWritable(); await w.write('<!doctype html><p>not a release</p>'); return w.close().then(() => 'saved', (e) => e.name)
      }).catch((e) => String(e))
      await new Promise((res) => setTimeout(res, 500))
      ok(junk === 'AbortError' && (await ui(page)).writes === before, `[T1-b] a posted file with no document block is refused and nothing is written (${junk})`)
    }

  }
  if (want('t1c')) {
    // [T1-c] a language pack, byte for byte
    await page.goto(A.library + '/')
    o = await openByHandle(page, 'deckPack')
    fr = await booted(page)
    if (fr) {
      const mark = await edit(fr)
      MARKS.push(mark)
      await cmdS(fr)
      await until(async () => (await ui(page)).writes > 0, 20000)
      await new Promise((res) => setTimeout(res, 500))
      const bytes = await opfsText(page, o.name)
      const pack = scanBlocks(bytes).filter((b) => b.type === 'application/bento+lang')
      ok(bytes.includes(mark) && pack.length === 1 && pack[0].text === packText, `[T1-c] the pack deck saved with its edit, and its application/bento+lang block is byte-identical (${pack.length} block(s), edit written: ${bytes.includes(mark)})`)
    }

  }
  if (want('t1d')) {
    // [T1-d] an encrypted deck stays encrypted
    await page.goto(A.library + '/')
    o = await openByHandle(page, 'deckEnc')
    const gated = await until(async () => { const f = docFrame(page); return f && (await f.evaluate(() => !!document.querySelector('.ed-pwgate input'))) ? f : null }, 30000)
    if (gated) {
      await gated.fill('.ed-pwgate input', PASSWORD)
      await gated.press('.ed-pwgate input', 'Enter')
      fr = await booted(page)
      const mark = fr ? await edit(fr) : 'none'
      MARKS.push(mark)
      if (fr) await cmdS(fr)
      await until(async () => (await ui(page)).writes > 0, 30000)
      await new Promise((res) => setTimeout(res, 800))
      const bytes = await opfsText(page, o.name)
      const p = keep('enc-saved.bento.html', bytes)
      ok(!!fr && bytes !== deckEnc && !bytes.includes(CANARY) && !bytes.includes(mark) && /"format":"bento\/enc"/.test(docTextOf(bytes) ?? ''),
        '[T1-d] the encrypted deck is written encrypted: no plaintext canary or edit in the bytes')
      const disk = await fromDisk(p, PASSWORD)
      ok(disk.booted && disk.gated && disk.text?.includes(mark), `[T1-d] from file://, the written deck shows its password gate and opens with the edit (${JSON.stringify({ b: disk.booted })})`)
      ok((await ui(page)).recovery === 0, '[T1-d] an encrypted deck leaves no recovery copy in the tab')
    } else ok(false, '[T1-d] the encrypted deck showed its password gate in the frame')

  }
  if (want('t1e')) {
    // [T1-e] [T1-g] recovery goes on a handle write, the member key stays; then the storage scan
    await page.goto(A.library + '/')
    o = await openByHandle(page, 'deck1210')
    fr = await booted(page)
    if (fr) {
      await loadKernel(fr).catch(() => {})
      const mark = 'EDIT-' + rnd()
      MARKS.push(mark)
      const set = await fr.evaluate(async (m) => {
        const ds = window.__bentoKernelStore.docStore()
        window.__ds = ds
        return [await window.__bentoKernelStore.setJSON(ds, 'recovery', { docId: window.bento.doc.docId, at: Date.now(), json: m }), await ds.set('memberkey', new TextEncoder().encode('member-' + m))]
      }, mark).catch((e) => [String(e)])
      const held1 = (await ui(page)).recovery
      ok(set[0] === 'stored' && held1 === 1, `[T1-e] positive control: a recovery copy is held for the open before the save (${JSON.stringify(set)}, ${held1})`)
      await edit(fr).then((m) => MARKS.push(m))
      await cmdS(fr)
      await until(async () => (await ui(page)).writes > 0, 20000)
      await new Promise((res) => setTimeout(res, 500))
      const after = await ui(page)
      ok(after.recovery === 0 && !after.chip, `[T1-e] after the write the recovery copy is gone and no chip shows (${after.recovery})`)
      const mk = await fr.evaluate(async () => { const b = await window.__ds.get('memberkey'); return b ? new TextDecoder().decode(b) : null }).catch((e) => String(e))
      ok(mk === 'member-' + mark, `[T1-g] the member key is still held for the open after the write-back (${mk})`)
    }
    // [T1 947-4] the document becomes encrypted mid-open: the library drops its recovery copy itself.
    // Opened WITHOUT a handle, so no write lands to clear it: only the encryption rule can.
    await page.goto(A.library + '/')
    await openByInput(page, 'deck1210')
    fr = await booted(page)
    if (fr) {
      await loadKernel(fr).catch(() => {})
      await fr.evaluate(async () => { const ds = window.__bentoKernelStore.docStore(); await window.__bentoKernelStore.setJSON(ds, 'recovery', { docId: window.bento.doc.docId, at: 1 }) }).catch(() => {})
      const before = (await ui(page)).recovery
      const env = await envelopeOf('{}')
      const r = await fr.evaluate(async (env) => {
        const html = window.bento.serialize()
        const start = html.indexOf('>', html.indexOf('id="bento-doc"')) + 1
        const end = html.indexOf('</' + 'script>', start)
        const h = await window.showSaveFilePicker({ id: 'bento-doc' })
        const w = await h.createWritable(); await w.write(html.slice(0, start) + '\n' + env + '\n' + html.slice(end)); return w.close().then(() => 'saved', (e) => e.name)
      }, env).catch((e) => String(e))
      await new Promise((res) => setTimeout(res, 500))
      ok(before === 1 && r === 'saved' && (await ui(page)).recovery === 0, `[T1 947-4] a save showing the document became encrypted drops its recovery copy host-side (${before} -> ${(await ui(page)).recovery}, ${r})`)
    }
    // a file with no docId saves, and keeps nothing (absent field)
    await page.goto(A.library + '/')
    o = await openByHandle(page, 'deckNoId')
    fr = await booted(page)
    if (fr) {
      const mark = await edit(fr)
      MARKS.push(mark)
      await cmdS(fr)
      await until(async () => (await ui(page)).writes > 0, 20000)
      await new Promise((res) => setTimeout(res, 500))
      const bytes = await opfsText(page, o.name)
      const posted = await page.evaluate(() => (window.__posted ?? []).at(-1) ?? null)
      ok(bytes.includes(mark), '[T1-f] a file with no docId: the save lands in the file through its handle')
      ok((await ui(page)).recovery === 0, '[T1-e] a file with no docId leaves no recovery copy')
      ok(!!posted && docTextOf(bytes) === docTextOf(posted), '[T3] a file with no docId: the written document text is exactly the shell\'s')
      ok(!!posted && newHosts(posted, bytes).length === 0, `[T5-4] a file with no docId: the written file names no host the shell's own save did not (${posted ? newHosts(posted, bytes).join(', ') || 'none' : 'nothing posted'})`)
    }
  }
  await page.click('#close').catch(() => {})
  const skip = (await page.evaluate(async () => { const n = []; for await (const [k] of (await navigator.storage.getDirectory()).entries()) if (/^rig-/.test(k)) n.push(k); return n }))
  const dump = await scanStorage(page, skip)
  const found = [CANARY, PACKBODY, ...MARKS].filter((c) => dump.includes(c))
  ok(found.length === 0, `[T1-e] no storage on the library origin (IndexedDB, Cache Storage, OPFS but the person's files, web storage) holds the canary, a marker or the pack (${found.length ? found[0] : 'none'}; ${dump.length} B scanned)`)
  await ctx.close()
}

// ===== [S.1a] the recovery copy past the open, by the bytes' hash ===========================================
if (want('s1a')) {
  section('[T1 S.1a] a recovery copy outlives its open in this tab, offered only to the same bytes')
  const ctx = await context()
  const page = await ctx.newPage()
  await page.goto(A.library + '/')
  await openByInput(page, 'deck130')
  let fr = await booted(page)
  let held = 0
  if (fr) {
    MARKS.push(await edit(fr))
    held = (await until(async () => { const u = await ui(page); return u.recovery > 0 ? u.recovery : null }, 20000)) ?? 0
  }
  ok(held === 1, `[S.1a] positive control: the 1.3.0 shell's autosave keeps a recovery copy in the library (${held})`)
  // the frame killed after the edit, before any save
  await page.click('#close', { timeout: 8000 }).catch(() => {})
  const away = await until(async () => { const u = await ui(page); return !u.viewing ? u : null }, 10000)
  ok(away?.recovery === 1 && /changes only in this tab/.test(away?.away ?? ''), `[S.1a] closed before a save, the copy stays in the tab and the page says so (${away?.recovery}, ${away?.away})`)
  // a file with the same docId in DIFFERENT bytes is not offered it
  await openByInput(page, 'deck130other')
  fr = await booted(page)
  await new Promise((r) => setTimeout(r, 4000))
  const offeredOther = fr ? await fr.evaluate(() => !!document.querySelector('.ed-recover')) : null
  ok(fr && offeredOther === false, `[S.1a] NEGATIVE: the same docId in different bytes is not offered the recovery copy (${offeredOther})`)
  await page.click('#close', { timeout: 8000 }).catch(() => {})
  // the same bytes again: the shell offers it
  await openByInput(page, 'deck130')
  fr = await booted(page)
  const offered = fr ? await until(() => fr.evaluate(() => !!document.querySelector('.ed-recover')), 15000) : null
  ok(!!offered, '[S.1a] the SAME bytes reopened: the shell offers the recovery copy (its own Restore banner)')
  await ctx.close()
}

// ===== [T4] read-only verdicts: zero writes, a new file only when asked =====================================
if (want('t4ro')) {
  section('[T4-4] a read-only verdict never writes the file')
  B.s.files.set('/releases/slides/history.json', await sign(historyPlus))
  B.s.files.set('/releases/slides/manifest.json', manifestFuture)
  B.s.files.set('/releases/slides/Bento_Slides.bento.html', futureShell)
  for (const offline of [false, true]) {
    for (const key of ['tampered', 'forkDeck']) {
      const ctx = await context()
      const page = await ctx.newPage()
      const downloads = []
      page.on('download', (d) => downloads.push(d))
      await page.goto(B.library + '/')
      const opened = CHROMIUM ? (await openByHandle(page, key)).u : await openByInput(page, key)
      ok(!!opened && !opened.viewing && /not a Bento release/.test(opened.problem), `[T4-4] ${key}${offline ? ' (channel aborted after)' : ''}: does not run as its own code (${opened?.problem.slice(0, 60)})`)
      await page.click('#readonly', { timeout: 8000 }).catch(() => {})
      const fr = await booted(page)
      if (offline) await ctx.route(B.releaseBase + '**', (r) => r.abort())
      if (!fr) { ok(false, `[T4-4] ${key}: opened read-only in the newest release`); await ctx.close(); continue }
      MARKS.push(await edit(fr))
      await cmdS(fr)
      const u = await until(async () => { const v = await ui(page); return v.saveCopy ? v : null }, 20000)
      // the document keeps calling the writable after the verdict
      const kept = await fr.evaluate(async (html) => {
        const out = []
        for (let i = 0; i < 4; i++) {
          const h = await window.showSaveFilePicker({ id: 'bento-doc' })
          const w = await h.createWritable(); await w.write(new Blob([html])); out.push(await Promise.race([w.close().then(() => 'saved', (e) => e.name), new Promise((r) => setTimeout(() => r('unanswered'), 5000))]))
        }
        return out
      }, await fr.evaluate(() => window.bento.serialize())).catch((e) => [String(e)])
      await new Promise((r) => setTimeout(r, 2500))
      const after = await ui(page)
      ok(!!u && after.writes === 0 && /read-only/.test(after.notice) && /Save as a new file/.test(after.saveCopy),
        `[T4-4] ${key}${offline ? ' (channel aborted)' : ''}: ⌘S and four more writable calls make zero createWritable calls on the file's handle, say why, and offer "Save as a new file" (${after.writes} writes, ${JSON.stringify(kept)})`)
      ok(downloads.length === 0, `[T4-4] ${key}: nothing is written before the person asks`)
      const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
      await page.click('#save-copy', { timeout: 8000 }).catch(() => {})
      const d = await dl
      const bytes = d ? fs.readFileSync(await d.path(), 'utf8') : ''
      const v = bytes ? await judge(bytes, (() => { const h = new Histories({ kty, crv, x, y }, B.releaseBase, fetch); return h })().list()) : null
      // judge against build B's history (the test key's, with 1.3.99)
      const hB = new Histories({ kty, crv, x, y }, B.releaseBase, fetch)
      await hB.take(await sign(historyPlus))
      const vB = bytes ? await judge(bytes, hB.list()) : null
      ok(!!d && vB?.verdict === 'genuine' && vB.release.version === '1.3.99' && bytes.includes(MARKS.at(-1)), `[T4-4] ${key}: asked, the new file is the newest signed release (${vB?.verdict} ${vB?.release?.version ?? ''}) with the edit`)
      void v
      await ctx.close()
    }
    if (!CHROMIUM) break // the handle rows are Chromium's; the verdicts themselves are the same everywhere
  }
}

// ===== [T6] the bend is visible: export without a handle ====================================================
if (want('t6')) {
  section('[T6] without a handle, the chip says the changes are only in this tab until the export is opened again')
  const ctx = await context()
  const page = await ctx.newPage()
  await page.goto(A.library + '/')
  await openByInput(page, 'deck130')
  const fr = await booted(page)
  const mark = fr ? await edit(fr) : 'none'
  MARKS.push(mark)
  const first = await until(async () => { const u = await ui(page); return u.chip ? u : null }, 20000)
  ok(!!first && first.recovery === 1, `[T6] the chip is visible from the first edit, a recovery copy held (${first?.recovery})`)
  if (fr) await cmdS(fr)
  const held = await until(async () => { const u = await ui(page); return u.saveCopy ? u : null }, 20000)
  ok(!!held && held.saveCopy === 'Save a copy' && held.writes === 0, `[T6] ⌘S without a handle: nothing written, "Save a copy" offered (${held?.saveCopy})`)
  const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
  await page.click('#save-copy', { timeout: 8000 }).catch(() => {})
  const d = await dl
  const exported = d ? path.join(work, 'exported.bento.html') : null
  if (d) await d.saveAs(exported)
  await new Promise((r) => setTimeout(r, 800))
  const after = await ui(page)
  ok(!!d && after.chip && after.recovery === 1, `[T6] still visible after the export starts, and the recovery copy is still held (${after.chip}, ${after.recovery})`)
  const bytes = exported ? fs.readFileSync(exported, 'utf8') : ''
  ok(bytes.includes(mark) && (await codeOf(bytes)) === (await codeOf(deck130)), '[T6] the export is the served release with the edit')
  // different bytes: both stay
  await openByInput(page, 'deck1210')
  await booted(page)
  let u = await ui(page)
  ok(u.recovery === 1 && /changes only in this tab/.test(u.away), `[T6] different bytes opened: the recovery copy and the warning stay (${u.recovery})`)
  // the exported bytes opened again: both go
  if (exported) { await page.setInputFiles('#file', exported); await settled(page); await booted(page) }
  u = await ui(page)
  ok(u.recovery === 0 && !u.away && !u.chip, `[T6] the exported bytes opened again: the recovery copy and the chip are gone (${u.recovery})`)
  // "I've saved it" clears it too (D12's explicit path)
  await openByInput(page, 'deck130other')
  const fr2 = await booted(page)
  if (fr2) MARKS.push(await edit(fr2))
  await until(async () => (await ui(page)).chip, 20000)
  await page.click('#saved-it').catch(() => {})
  u = await ui(page)
  ok(u.recovery === 0 && !u.chip, `[T6] "I've saved it" clears the chip and the recovery copy (${u.recovery})`)
  await ctx.close()
}

// ===== [T8] saves come only from this open's port ============================================================
if (want('t8')) {
  section('[T8] a save is taken only from the session port of this open')
  const ctx = await context()
  const page = await ctx.newPage()
  await page.goto(A.library + '/')
  if (CHROMIUM) await openByHandle(page, 'deck130'); else await openByInput(page, 'deck130')
  let fr = await booted(page)
  if (fr) {
    const html = await fr.evaluate(() => window.bento.serialize())
    // to the library's window, in the save message's exact shape
    await fr.evaluate((html) => { parent.postMessage({ kind: 'save', n: 99, purpose: 'bento-doc', name: 'x.bento.html', html }, '*') }, html)
    // on the store port (the S7 rows drop it there too)
    await new Promise((r) => setTimeout(r, 1500))
    const u = await ui(page)
    ok(u.writes === 0 && !u.saveCopy && u.posted === 0, `[T8] a save posted to the library's window by the frame is ignored (${u.writes} writes, ${u.posted} on the port)`)
    // positive control: the same html through the frame's own picker IS taken
    await fr.evaluate(async (html) => { const h = await window.showSaveFilePicker({ id: 'bento-copy' }); const w = await h.createWritable(); await w.write(html); await Promise.race([w.close(), new Promise((r) => setTimeout(r, 5000))]) }, html).catch(() => {})
    const pc = await until(async () => { const v = await ui(page); return v.saveCopy ? v : null }, 10000)
    ok(!!pc && pc.saveCopy === 'Save the copy', `[T8] positive control: the same file through the frame's picker is taken, as a copy to save (${pc?.saveCopy})`)
  }
  // a page that opens the library posts it a save
  const foreign = await ctx.newPage()
  A.s.files.set('/releases/opener.html', '<!doctype html><p>opener</p>')
  await foreign.goto(A.releaseBase + 'opener.html')
  const lib = await Promise.all([ctx.waitForEvent('page'), foreign.evaluate((u) => { window.__lib = window.open(u) }, A.library + '/')]).then(([p]) => p)
  await lib.waitForLoadState()
  await foreign.evaluate(() => { for (let i = 0; i < 3; i++) window.__lib.postMessage({ kind: 'save', n: i + 1, purpose: 'bento-doc', name: 'x', html: '<p>x</p>' }, '*') })
  await new Promise((r) => setTimeout(r, 800))
  const lu = await ui(lib)
  ok(!lu.viewing && !lu.saveCopy && lu.posted === 0, '[T8] a page that opens the library cannot post it a save')
  const framed = await foreign.evaluate(async (u) => { const f = document.createElement('iframe'); f.src = u; document.body.appendChild(f); await new Promise((r) => setTimeout(r, 1500)); try { return f.contentWindow.document.body?.innerHTML ?? 'opaque' } catch { return 'blocked' } }, A.library + '/')
  ok(framed !== null && !/Choose a file/.test(framed), `[T8] a page on another origin cannot frame the library to drive it (${String(framed).slice(0, 20)})`)
  // a flood of saves through the frame's own picker: the document is closed
  await page.goto(A.library + '/')
  await openByInput(page, 'deck130')
  fr = await booted(page)
  if (fr) {
    await fr.evaluate(async () => {
      // the frame keeps one save in flight; a document that wants more must spam its port by hand, so it floods with saves one after another
      for (let i = 0; i < 40; i++) {
        const h = await window.showSaveFilePicker({ id: 'bento-copy' })
        const w = await h.createWritable(); await w.write('<p>junk</p>')
        await Promise.race([w.close().catch(() => {}), new Promise((r) => setTimeout(r, 200))])
      }
    }).catch(() => {})
    const closed = await until(async () => { const u = await ui(page); return !u.viewing && /saves this page does not accept/.test(u.problem) ? u : null }, 20000)
    ok(!!closed, '[T8] a flood of saves closes the document')
  }
  await ctx.close()
}

// ===== [T2] the network over open, edit, save and export =====================================================
section('[T2] every request is on the allow-list; none carries the canary or a marker')
{
  const ctx = await context()
  const page = await ctx.newPage()
  await page.goto(A.library + '/')
  await openByInput(page, 'deck130')
  const fr = await booted(page)
  const probe = (who) => `${A.releaseBase}probe/${who}`
  await page.evaluate((u) => fetch(u).catch(() => {}), probe('library'))
  await fr?.evaluate((u) => fetch(u).catch(() => {}), probe('frame'))
  await new Promise((r) => setTimeout(r, 1500))
  for (const who of ['library', 'frame']) ok(recorded.some((r) => r.url === probe(who)) && A.seen.some((r) => r.url === probe(who)), `[T2] positive control: a request planted in the ${who} is seen in the browser and at the server`)
  // a socket opened by a page with no policy is recorded
  const SOCKET_PROBE = 'ws://127.0.0.1:9/bento-home-wb-probe'
  await page.evaluate((u) => { try { new WebSocket(u) } catch {} }, SOCKET_PROBE).catch(() => {})
  await until(() => sockets.includes(SOCKET_PROBE), 5000)
  await ctx.close()
  const libFiles = ['/', '/sw.js', ...(A.info.offline?.precache ?? []).map((p) => p.path)]
  const allowed = (r) => (r.method === 'GET' && [A, B].some((X) => libFiles.map((p) => X.library + p).includes(r.url) || r.url === X.frame + '/frame.html' || r.url.startsWith(X.releaseBase))) ||
    r.url.startsWith('blob:') || r.url.startsWith('data:') || r.url === 'about:blank' || r.url.startsWith('file:')
  const stray = recorded.filter((r) => !allowed(r))
  ok(stray.length === 0, `[T2] every request in this run (open, edit, save, export) is on the allow-list (${recorded.length} recorded${stray.length ? '; stray: ' + stray.slice(0, 3).map((r) => r.method + ' ' + r.url).join(', ') : ''})`)
  const forms = [CANARY, PACKBODY, ...MARKS].flatMap((c) => [c, Buffer.from(c).toString('base64').slice(0, 16), encodeURIComponent(c)])
  const leaks = recorded.filter((r) => forms.some((c) => r.url.includes(c) || r.body.includes(c) || r.headers.includes(c)))
  ok(leaks.length === 0, `[T2] no URL, header or body carries the canary, the pack or an edit marker${leaks.length ? ': ' + leaks[0].method + ' ' + leaks[0].url : ''}`)
  ok(sockets.includes(SOCKET_PROBE) && sockets.filter((u) => u !== SOCKET_PROBE).length === 0, `[T2] no socket was opened (positive control recorded: ${sockets.includes(SOCKET_PROBE)})`)
}

await guard.close()
await A.s.close(); await B.s.close()
console.log(`\n${checks - failures}/${checks} checks passed (${ENGINE})`)
process.exit(failures ? 1 : 0)
