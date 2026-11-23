// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The bento/home tripwire without a browser: the shipped configuration, the
 * release list's writer (scripts/lib/home-web-served.mjs, sign-home-web-served.mjs)
 * against its reader (home/webext/src/tripwire-judge.js), and the judge's
 * rules on hand-made observations. Throwaway keys only.
 *
 *   node scripts/test-webext-tripwire.ts
 *
 * The rules in a real browser, with a mutant per rule:
 * scripts/test-webext-tripwire-browser.mjs and scripts/test-webext-tripwire-mutants.mjs.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'home/webext')
const J = await import(path.join(EXT, 'src/tripwire-judge.js'))
const C = await import(path.join(EXT, 'src/tripwire-config.js'))
const { RELEASE_KEY } = await import(path.join(EXT, 'src/release.js'))
const W = await import(path.join(ROOT, 'scripts/lib/home-web-served.mjs'))
const { releasePublicKey } = await import(path.join(ROOT, 'scripts/sign-payload.mjs'))

let checks = 0, failures = 0
const ok = (c: unknown, m: string) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const section = (m: string) => console.log(`\n=== ${m}`)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-tripwire-node-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

// --- 1. what ships ------------------------------------------------------------
section('the shipped configuration')
ok(C.LIBRARY_ORIGIN === 'https://home.bento.page', `the library origin is https://home.bento.page (${C.LIBRARY_ORIGIN})`)
ok(C.LIST_URL === 'https://bento.page/releases/home-web/served.json', `the list is read from the release channel (${C.LIST_URL})`)
ok(new URL(C.LIST_URL).origin !== C.LIBRARY_ORIGIN, 'the list is not served by the site it describes')
ok(JSON.stringify(C.KEY) === JSON.stringify(RELEASE_KEY), 'the list must be signed with the release key (release.js, pinned to the kernel\'s)')
ok(['kty', 'crv', 'x', 'y'].every((k) => (C.KEY as any)[k] === (releasePublicKey() as any)[k]), 'and that key is kernel/src/update.ts\'s PUBLIC_KEY_JWK')
ok(Array.isArray(C.FRAME_ORIGINS) && C.FRAME_ORIGINS.every((o: string) => new URL(o).origin === o && o.startsWith('https://')), `frame origins are https origins (${JSON.stringify(C.FRAME_ORIGINS)})`)
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'))
const watched = [C.LIBRARY_ORIGIN, ...C.FRAME_ORIGINS].map((o: string) => `${o}/*`)
const cs = man.content_scripts.filter((c: any) => c.js.includes('src/tripwire-observe.js'))
ok(cs.length === 1 + (C.FRAME_ORIGINS.length ? 1 : 0), 'one tripwire content script for the library (and one for the frame site once named)')
ok(JSON.stringify(cs.flatMap((c: any) => c.matches)) === JSON.stringify(watched), `it runs on exactly the watched origins (${JSON.stringify(cs.flatMap((c: any) => c.matches))})`)
ok(JSON.stringify(cs[0]?.matches) === JSON.stringify([`${C.LIBRARY_ORIGIN}/*`]), 'the first is the library\'s')
ok(cs[0]?.world === 'ISOLATED' && cs[0]?.run_at === 'document_start', 'isolated world, from document_start')
ok(cs[0]?.all_frames === false && cs[0]?.match_origin_as_fallback === true, 'the library is watched as a TOP-LEVEL page only (it is never framed), and in blob:/about: documents of its origin too (ruling C1, C3)')
ok(C.FRAME_ORIGINS.length === 0 || man.content_scripts.some((c: any) => c.js.join() === 'src/tripwire-observe.js' && c.all_frames === true), 'the frame site, once named, is watched in frames')
ok(cs.every((c: any) => c.js.length === 1), 'and it is only the observer')
ok(watched.every((p: string) => man.host_permissions.includes(p)), 'host permissions cover the watched origins')
ok(man.host_permissions.every((p: string) => p === 'file:///*' || watched.includes(p)), `and nothing else (${man.host_permissions.join(' ')})`)
ok(man.permissions.includes('webRequest') && !man.permissions.includes('webRequestBlocking'), 'webRequest, observing only (no blocking)')
const twSrc = fs.readFileSync(path.join(EXT, 'src/tripwire.js'), 'utf8')
ok(!/chrome\.tabs\.reload|unregister\(|caches\.delete|chrome\.scripting|declarativeNetRequest/.test(twSrc + fs.readFileSync(path.join(EXT, 'src/tripwire-observe.js'), 'utf8')),
  'the tripwire reloads, unregisters, deletes and injects nothing')

// --- 2. the writer meets the reader --------------------------------------------
section('the list a release writes is the list the extension reads')
const build = path.join(work, 'build')
fs.mkdirSync(path.join(build, 'library'), { recursive: true })
fs.mkdirSync(path.join(build, 'frame'), { recursive: true })
const libJs = 'console.log("library")\r\nvar a = 1'
const libHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'x'"><p>hi</p><script>${libJs}</script><script src="/extra.js"></script>`
fs.writeFileSync(path.join(build, 'library/index.html'), libHtml)
fs.writeFileSync(path.join(build, 'library/extra.js'), 'void 0')
fs.writeFileSync(path.join(build, 'library/sw.js'), '// worker')
fs.writeFileSync(path.join(build, 'library/_headers'), "/\n  Content-Security-Policy: default-src 'none'\n  Cache-Control: no-cache\n/index.html\n  Content-Security-Policy: default-src 'none'\n  Cache-Control: no-cache\n")
fs.writeFileSync(path.join(build, 'frame/frame.html'), '<!doctype html><script>frame()</script>')
fs.writeFileSync(path.join(build, 'frame/_headers'), '/frame.html\n  Content-Security-Policy: sandbox allow-scripts\n/frame\n  Content-Security-Policy: sandbox allow-scripts\n')
const info = { libraryOrigin: 'https://home.bento.page', frameOrigin: 'https://frame.example', testKey: false, mutant: null, serviceWorkers: ['/sw.js'] }
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify(info))
const rel = await W.describeBuild(build, '2026-11-01T00:00:00.000Z')
const lib = rel.origins['https://home.bento.page'], frm = rel.origins['https://frame.example']
ok(lib?.role === 'library' && frm?.role === 'frame', 'both sites, by role')
ok(lib.files['/'] && lib.files['/index.html'] && lib.files['/'].sha256 === sha(libHtml), 'index.html at / and /index.html, pinned to its bytes')
ok(frm.files['/frame.html'] && frm.files['/frame'], 'frame.html at /frame.html and /frame')
ok(lib.files['/'].scripts.length === 2 && lib.files['/'].scripts[0].sha256 === sha(libJs.replace(/\r\n?/g, '\n')) && lib.files['/'].scripts[1].src === '/extra.js',
  'scripts in order: inline by the hash of the text AS PARSED (CR LF becomes LF), external by path')
ok(lib.files['/'].csp === "default-src 'none'" && frm.files['/frame'].csp === 'sandbox allow-scripts', 'each document carries its _headers CSP')
ok(lib.files['/extra.js'].kind === 'asset' && lib.files['/sw.js'] && JSON.stringify(rel.workers) === '["/sw.js"]', 'assets and the worker are listed')
ok(!Object.keys(lib.files).some((p) => p.includes('_headers')), '_headers is not a served file')
const list1 = W.nextServed(null, rel, '2026-11-01T00:00:00.000Z')
ok(J.servedProblem(list1) === null, `the reader accepts the writer's list (${J.servedProblem(list1)})`)
ok(list1.serial === 1 && list1.type === J.SERVED_TYPE && W.SERVED_TYPE === J.SERVED_TYPE && W.SERVED_V === J.SERVED_V, 'type and version agree on both sides')
const rel2 = await W.describeBuild(build, '2026-11-10T00:00:00.000Z')
const list2 = W.nextServed(list1, rel2, '2026-11-10T00:00:00.000Z')
ok(list2.serial === 2 && list2.releases.length === 2 && JSON.stringify(list2.releases[1]) === JSON.stringify(rel), 'the next list: serial + 1, newest first, the older release kept')
let long: any = list1
for (let i = 0; i < W.KEEP + 3; i++) long = W.nextServed(long, rel)
ok(long.releases.length === W.KEEP, `the list keeps the newest ${W.KEEP}`)
let threw = false
try { W.nextServed({ app: 'bento-slides', version: '1' }, rel) } catch { threw = true }
ok(threw, 'a held payload that is not a v1 list is refused')
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ ...info, serviceWorkers: ['/missing.js'] }))
threw = false
try { await W.describeBuild(build) } catch { threw = true }
ok(threw, 'a worker the library does not serve is refused')
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify(info))

// --- 3. signatures and the held list ---------------------------------------------
section('the list is checked before it is believed')
const mk = async () => {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', kp.publicKey) as any
  return { kp, jwk: { kty, crv, x, y } }
}
const K = await mk(), E = await mk()
const sign = async (p: unknown, k = K) => { const payload = JSON.stringify(p); const s = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.kp.privateKey, new TextEncoder().encode(payload)); return JSON.stringify({ payload, sig: Buffer.from(s).toString('base64') }) }
const env1 = await sign(list1), env2 = await sign(list2)
const held1 = { payload: JSON.parse(env1).payload, serial: 1 }
const held2 = { payload: JSON.parse(env2).payload, serial: 2 }
ok((await J.acceptServed(null, env1, K.jwk)).status === 'ok', 'a genuine first list is taken')
ok((await J.acceptServed(held1, env2, K.jwk)).status === 'ok', 'a newer genuine list is taken')
ok((await J.acceptServed(held1, env1, K.jwk)).status === 'same', 'the same list is the same')
ok((await J.acceptServed(held2, env1, K.jwk)).status === 'rollback', 'an older genuine list is a rollback, refused')
ok((await J.acceptServed(held1, await sign({ ...list1, at: '2026-11-02T00:00:00.000Z' }), K.jwk)).status === 'conflict', 'a different list with the held serial is a conflict')
ok((await J.acceptServed(null, await sign(list1, E), K.jwk)).status === 'invalid', 'another key\'s signature is invalid')
const flipped = JSON.parse(env1); flipped.payload = flipped.payload.replace('"serial":1', '"serial":9')
ok((await J.acceptServed(null, JSON.stringify(flipped), K.jwk)).status === 'invalid', 'an edited payload is invalid')
ok((await J.acceptServed(null, await sign({ ...list1, type: 'x' }), K.jwk)).status === 'invalid', 'a signed payload of another type is invalid')
ok((await J.acceptServed(null, await sign({ app: 'bento-slides', version: '1.2.13', sha256: 'a'.repeat(64), url: 'https://x' }), K.jwk)).status === 'invalid', 'a signed APP manifest is not a list')
ok((await J.acceptServed(null, await sign({ app: 'bento-slides', v: 1, releases: [] }), K.jwk)).status === 'invalid', 'a signed HISTORY is not a list')
ok(J.servedProblem({ ...list1, app: 'bento-slides' }) !== null, 'R2: a list carrying `app` is refused, whatever else it holds')
ok((await J.acceptServed(null, '<html>captive portal</html>', K.jwk)).status === 'unreadable', 'something that is not an envelope is unreadable, not invalid (nothing to warn about)')
for (const [m, bad] of [
  ['no releases', { ...list1, releases: [] }], ['serial 0', { ...list1, serial: 0 }], ['v 2', { ...list1, v: 2 }],
  ['a bad digest', JSON.parse(JSON.stringify(list1).replace(lib.files['/'].sha256, 'zz'))],
  ['a path that is not a path', JSON.parse(JSON.stringify(list1).replace('"/extra.js":', '"extra.js":'))],
  ['an origin with a path', JSON.parse(JSON.stringify(list1).replaceAll('"https://frame.example"', '"https://frame.example/x"'))],
] as [string, unknown][]) ok(J.servedProblem(bad) !== null, `shape refused: ${m}`)
// the real envelope verifier on a real (kernel) key shape: a list signed by the release key would verify
ok(typeof J.verifyServed === 'function' && J.SERVED_TYPE === 'bento/home-web/served', 'verifyServed exists for the release key')

// --- 4. the judge -------------------------------------------------------------------
section('the judge')
const L = 'https://home.bento.page'
const honestObs = () => ({
  role: 'library', url: `${L}/`, complete: true, viaWorker: false, size: lib.files['/'].bytes, bytes: { sha256: lib.files['/'].sha256 }, csp: ["default-src 'none'"],
  scripts: [{ sha256: lib.files['/'].scripts[0].sha256 }, { src: '/extra.js', sha256: lib.files['/extra.js'].sha256 }],
  flags: [], workers: [{ scriptURL: `${L}/sw.js`, sha256: lib.files['/sw.js'].sha256 }],
  cache: [{ url: `${L}/`, sha256: lib.files['/'].sha256 }, { url: `${L}/extra.js`, sha256: lib.files['/extra.js'].sha256 }],
})
const now = Date.parse('2026-11-10T01:00:00.000Z')
const v = (o: any, list: any = list1, t = now) => J.judge(o, list, L, t)
const rulesOf = (r: any) => r.failures.map((f: any) => f.rule).sort().join(',')
ok(v(honestObs()).verdict === 'ok', 'the honest observation is ok')
ok(v({ ...honestObs(), csp: null }).verdict === 'ok', 'an unobserved CSP is judged by the other rules')
ok(rulesOf(v({ ...honestObs(), bytes: null })) === 'bytes-unread', 'C2: on the library without a worker, bytes that could not be read are a mismatch (the honest library is always cached)')
ok(v({ ...honestObs(), bytes: null, viaWorker: true, cspFrom: 'cache' }).verdict === 'ok', 'under a worker that answered from its own store, unread bytes are judged by the other rules')
ok(rulesOf(v({ ...honestObs(), bytes: null, viaWorker: true, cspFrom: 'navigation' })) === 'bytes-unread', '#954 C2: under a worker whose navigation webRequest saw (preload), unread bytes are a mismatch')
ok(rulesOf(v({ ...honestObs(), cache: null })) === 'cache-unread', 'on the library, an unread cache is a mismatch (it is always readable)')
ok(rulesOf(v({ ...honestObs(), workers: null })) === 'workers-unread', 'on the library, an unread worker list is a mismatch')
ok(rulesOf(v({ ...honestObs(), size: 0 })) === 'size-unread', 'C2: size 0 is never a pass')
ok(v({ ...honestObs(), bytes: null, crossSite: true }).verdict === 'ok', 'a navigation another site started: unread bytes are not a failure (they cannot be read)')
ok(lib.files['/'].cacheControl === 'no-cache' && rulesOf(v({ ...honestObs(), cacheControl: ['no-store'] })) === 'cache-control' && v({ ...honestObs(), cacheControl: ['no-cache'] }).verdict === 'ok', 'the Cache-Control header the navigation got is pinned (the release lists its _headers value)')
ok(rulesOf(v({ ...honestObs(), complete: false })) === 'incomplete', 'C2: an unfinished parse is never a pass')
ok(v({ ...honestObs(), url: `${L}/nope?a`, scripts: [], bytes: null, size: 40 }).verdict === 'unlisted', 'C3: a script-free page at a path no release serves is recorded quietly')
ok(v({ ...honestObs(), url: `${L}/nope?a`, scripts: [], flags: ['handler:img.onerror'] }).verdict === 'mismatch', 'C3: ... unless it carries a flag')
ok(v({ ...honestObs(), url: `${L}/nope?a`, csp: [] }).verdict === 'mismatch', 'C3: ... or a script')
// R1 withdrawn
const wd = { ...list1, releases: [{ ...list1.releases[0], withdrawn: true }] }
ok(J.servedProblem(wd) === null && rulesOf(v(honestObs(), wd)) === 'withdrawn', 'R1: bytes of a WITHDRAWN release are a mismatch')
ok(J.servedProblem({ ...list1, releases: [{ ...list1.releases[0], withdrawn: false }] }) !== null, 'R1: withdrawn is true or absent')
// early reports (C1)
const ev = (o: any, list: any = list1) => J.judgeEarly({ role: 'library', ...o }, list, L)
const E3 = lib.files['/'].elements.slice(0, 3)
ok(JSON.stringify(lib.files['/'].elements) === JSON.stringify(['meta', 'p', 'script', 'script']), `N1: the element sequence of a document, as listed (${lib.files['/'].elements})`)
ok(ev({ scripts: [{ sha256: lib.files['/'].scripts[0].sha256 }], flags: [], elements: E3 }).verdict === 'incomplete', 'C1: an early report that is the clean start of a listed document, never settled, is incomplete (quiet)')
ok(rulesOf(ev({ scripts: [], flags: [], elements: ['div', 'p'] })) === 'elements', 'N1: an early report whose parse is not the start of any listed document is a mismatch on elements')
ok(ev({ scripts: [], flags: [], elements: [] }).verdict === 'incomplete', 'N1: "visit started" alone is incomplete, quietly')
ok(ev({ scripts: [{ sha256: 'a'.repeat(64) }], flags: [] }).verdict === 'mismatch', 'C1: an early report with a script no release lists is a mismatch')
ok(ev({ scripts: [], flags: ['document:blob:'] }).verdict === 'mismatch', 'C1: a flag in an early report is a mismatch')
ok(ev({ scripts: [{ src: '/evil.js' }], flags: [] }).verdict === 'mismatch', 'C1: an unlisted external script too')
ok(ev({ scripts: [{ sha256: lib.files['/'].scripts[0].sha256 }], flags: [], elements: E3 }, wd).verdict === 'mismatch', 'C1: scripts only a withdrawn release lists are not listed')
// N4: a script cut short is clean only as an exact, strictly shorter prefix of the published text
const libText = libJs.replace(/\r\n?/g, '\n')
const shaLib = lib.files['/'].scripts[0].sha256
const ok1 = (h: string, t: string) => h === shaLib && libText.startsWith(t) && t.length < libText.length
const partialObs = (text: string) => ({ scripts: [{ sha256: 'b'.repeat(64) }], flags: [], elements: E3, partial: { index: 0, text } })
ok(ev(partialObs(libText.slice(0, 10)), list1).verdict === 'mismatch', 'N4: without the published text, a script cut short is not clean')
ok(J.judgeEarly({ role: 'library', ...partialObs(libText.slice(0, 10)) }, list1, L, ok1).verdict === 'incomplete', 'N4: an honest script cut short (an exact prefix) is clean')
ok(J.judgeEarly({ role: 'library', ...partialObs(libText.slice(0, 10) + 'X') }, list1, L, ok1).verdict === 'mismatch', 'N4: a prefix plus anything else is not')
ok(J.judgeEarly({ role: 'library', ...partialObs(libText.slice(0, 10)), elements: [...E3, 'div'] }, list1, L, ok1).verdict === 'mismatch', 'N4: a script followed by more of the page was not cut short')
// N4: the full report of a visit cut short
const ab = { ...honestObs(), aborted: true, complete: true, size: 10, bytes: null, scripts: [], elements: ['meta', 'p'] }
ok(v(ab).verdict === 'incomplete', 'N4: a visit cut short that is the clean start of a listed document is incomplete, quietly')
ok(v({ ...ab, aborted: false }).verdict === 'mismatch', 'N4: ... the same report not cut short is a mismatch')
ok(v({ ...ab, flags: ['handler:img.onerror'] }).verdict === 'mismatch', 'N4: ... and cut short with a flag is a mismatch')
ok(v({ ...ab, elements: ['meta', 'div'] }).verdict === 'mismatch', 'N4: ... and cut short off the listed sequence is a mismatch')
// N1 in the full report
ok(rulesOf(v({ ...honestObs(), elements: ['meta', 'p', 'script', 'script', 'img'] })) === 'elements', 'N1: a full report whose sequence is not a listed document\'s is a mismatch on elements')
ok(v({ ...honestObs(), elements: lib.files['/'].elements }).verdict === 'ok', 'N1: the listed sequence is ok')
// N4: classes
ok(J.classOf([{ rule: 'bytes-unread' }, { rule: 'size-unread' }]) === 'unverified' && J.classOf([{ rule: 'bytes-unread' }, { rule: 'scripts' }]) === 'tampered' && J.classOf([{ rule: 'elements' }]) === 'tampered', 'N4: a finding is unverified only if every failure says "could not tell"')
// R4: a Refresh response header
ok(rulesOf(v({ ...honestObs(), refresh: ['1; url=https://x.example/'] })) === 'refresh-header' && J.classOf(v({ ...honestObs(), refresh: ['0'] }).failures) === 'tampered', 'R4: a Refresh header is a mismatch (tampered), whatever it says')
ok(v({ ...honestObs(), refresh: [] }).verdict === 'ok' && v({ ...honestObs(), refresh: null }).verdict === 'ok', 'R4: no Refresh header, or none recorded (a worker\'s answer), is judged by the other rules')
ok(rulesOf(v({ ...honestObs(), bytes: null, crossSite: true, refresh: ['0; url=https://x.example/'] })) === 'refresh-header', 'R4: on a navigation another site started too')
ok(rulesOf(v({ ...honestObs(), bytes: { sha256: 'f'.repeat(64) } })) === 'bytes', 'bytes')
ok(rulesOf(v({ ...honestObs(), size: 1 })) === 'size', 'size')
ok(rulesOf(v({ ...honestObs(), scripts: [honestObs().scripts[0]] })) === 'scripts', 'scripts: one missing')
ok(rulesOf(v({ ...honestObs(), scripts: [...honestObs().scripts, { sha256: 'a'.repeat(64) }] })) === 'scripts', 'scripts: one extra')
ok(rulesOf(v({ ...honestObs(), scripts: [honestObs().scripts[0], { src: '/extra.js', sha256: 'b'.repeat(64) }] })) === 'scripts', 'scripts: an external script\'s bytes')
ok(rulesOf(v({ ...honestObs(), csp: ["default-src 'none'", 'script-src *'] })) === 'csp', 'csp: a second header is a change')
ok(rulesOf(v({ ...honestObs(), csp: [] })) === 'csp', 'csp: a missing header is a change')
ok(rulesOf(v({ ...honestObs(), flags: ['handler:img.onerror'] })) === 'markup', 'markup')
ok(rulesOf(v({ ...honestObs(), workers: [{ scriptURL: `${L}/x.js`, sha256: null }] })) === 'worker', 'worker: an unlisted path')
ok(rulesOf(v({ ...honestObs(), workers: [{ scriptURL: 'https://evil.example/sw.js', sha256: null }] })) === 'worker', 'worker: another origin')
ok(rulesOf(v({ ...honestObs(), workers: [{ scriptURL: `${L}/sw.js`, sha256: 'c'.repeat(64) }] })) === 'worker-bytes', 'worker-bytes')
ok(rulesOf(v({ ...honestObs(), cache: [{ url: `${L}/later.js`, sha256: 'd'.repeat(64) }] })) === 'cache', 'cache: an unlisted entry')
ok(rulesOf(v({ ...honestObs(), cache: [{ url: `${L}/`, sha256: 'd'.repeat(64) }] })) === 'cache', 'cache: a listed path with other bytes')
ok(rulesOf(v({ ...honestObs(), role: 'frame' })) === 'page', 'a library page judged as a frame matches nothing')
// an older release
const old = { ...honestObs() }
const changed = { ...rel2, origins: JSON.parse(JSON.stringify(rel2.origins)) }
changed.origins[L].files['/'].sha256 = changed.origins[L].files['/index.html'].sha256 = 'e'.repeat(64)
const listNew = W.nextServed(list1, changed, '2026-11-10T00:00:00.000Z')
const o1 = v(old, listNew, Date.parse('2026-11-10T01:00:00.000Z'))
ok(o1.verdict === 'outdated' && o1.release === 1 && o1.notify === false, 'an older release is outdated, and not announced inside the grace period')
const o2 = v(old, listNew, Date.parse('2026-11-10T00:00:00.000Z') + J.GRACE_MS + 1000)
ok(o2.verdict === 'outdated' && o2.notify === true, 'and announced after it')
ok(v({ ...old, flags: ['x'] }, listNew).verdict === 'mismatch', 'an older release with a markup flag is a mismatch')
ok(v(old, { ...listNew, releases: [listNew.releases[0]] }).verdict === 'mismatch', 'a release that fell off the list is a mismatch')
ok(J.observed({ ...honestObs(), bytes: null }).bytes === false, 'what was not observed is recorded as such')

// --- 5. the signing script ---------------------------------------------------------
section('the library worker\'s own requests (security ruling #954 C5)')
{
  const O = 'https://home.bento.page'
  const H = (sw: string | null, dest: string | null) => [...(sw == null ? [] : [{ name: 'Service-Worker', value: sw }]), ...(dest == null ? [] : [{ name: 'Sec-Fetch-Dest', value: dest }])]
  const req = (over: Record<string, unknown> = {}) => ({ url: `${O}/`, method: 'GET', type: 'xmlhttprequest', initiator: O, headers: H(null, 'empty'), ...over })
  const wr = (r: unknown) => J.workerRequestFailures(r, list1, O).map((f: any) => f.why ?? f.rule).join('+')
  ok(lib.files['/sw.js'] && list1.releases[0].workers.includes('/sw.js'), 'the fixture release serves /sw.js as its worker (positive control on the list read)')
  ok(wr(req()) === '' && wr(req({ url: `${O}/index.html` })) === '' && wr(req({ url: `${O}/extra.js` })) === '', 'a precache fetch: GET, no query, a path the release serves: allowed')
  ok(wr(req({ url: `${O}/sw.js`, type: 'script', headers: H('script', 'serviceworker') })) === '', 'the browser\'s own fetch of the worker script (type script, Service-Worker: script, Sec-Fetch-Dest: serviceworker): allowed')
  ok(wr(req({ url: `${O}/sw.js` })) === 'the worker script, not fetched as the browser\'s worker script', 'the worker re-fetching its own script: a finding')
  ok(wr(req({ url: `${O}/sw.js`, type: 'script', headers: H('script', 'empty') })) !== '', 'Service-Worker: script set by a script, without Sec-Fetch-Dest serviceworker: a finding')
  ok(wr(req({ url: `${O}/sw.js`, type: 'xmlhttprequest', headers: H('script', 'serviceworker') })) !== '', 'the worker-script headers on a fetch() request type: a finding')
  ok(wr(req({ url: `${O}/sw.js`, type: 'script', headers: null })) !== '', 'requestHeaders ABSENT on a worker-script fetch: a finding, never a pass')
  ok(wr(req({ url: `${O}/sw.js`, type: 'script', headers: [] })) !== '', 'no headers at all: a finding')
  ok(wr(req({ headers: undefined })) === 'its request headers were not read', 'requestHeaders ABSENT on a plain precache path: a finding (its headers are held too, security ruling on #983 M1)')
  ok(wr(req({ url: `${O}/?x` })) === 'a query' && wr(req({ url: `${O}/?` })) === 'a query' && wr(req({ url: `${O}/#a?b` })) === '', 'a query, even a bare ?, is a finding; a ? in the fragment is not a query')
  ok(wr(req({ url: `${O}/not-served` })) === 'a path no release serves', 'a path no release serves: a finding')
  ok(wr(req({ method: 'POST' })) === 'not GET' && wr(req({ method: 'HEAD' })) === 'not GET', 'POST and HEAD: findings')
  ok(wr(req({ url: 'https://evil.example/' })) === 'another origin', 'another origin: a finding')
  ok(wr(req({ url: 'not a url' })) === 'unreadable URL', 'an unreadable URL: a finding')
  const un = J.workerRequestFailures(req({ initiator: undefined }), list1, O)
  ok(un.length === 1 && un[0].rule === 'worker-request-unattributed' && J.classOf(un) === 'unverified', 'initiator ABSENT: recorded as unverified, never allowed in silence')
  ok(J.workerRequestFailures(req({ initiator: null }), list1, O)[0]?.rule === 'worker-request-unattributed', 'initiator null: the same')
  ok(J.classOf(J.workerRequestFailures(req({ method: 'POST' }), list1, O)) === 'tampered', 'a worker request outside the allowlist is "tampered"')
  ok(wr(req({ url: `${O}/frame.html` })) === 'a path no release serves', 'the frame site\'s paths are not the library\'s')
  const noWorkers = { ...list1, releases: list1.releases.map((r: any) => { const { workers, ...rest } = r; return rest }) }
  ok(J.workerRequestFailures(req({ url: `${O}/sw.js` }), noWorkers, O).length === 0, 'a release with NO workers field: /sw.js is an ordinary served path (absent field read as no workers, not a crash)')

  // the header hold (security ruling on #983, M1): the headers MEASURED on the honest worker's requests
  // (Chromium 149: the install's precache fetches, the browser's script fetch and update check)
  const nav = { acceptLanguage: 'en-GB,en;q=0.9', userAgent: 'Mozilla/5.0 (test) Chrome/149' }
  const honestH = [{ name: 'Accept', value: '*/*' }, { name: 'Accept-Encoding', value: 'gzip, deflate, br, zstd' }, { name: 'Accept-Language', value: nav.acceptLanguage },
    { name: 'sec-ch-ua', value: '"Chromium";v="149"' }, { name: 'sec-ch-ua-mobile', value: '?0' }, { name: 'sec-ch-ua-platform', value: '"macOS"' },
    { name: 'Sec-Fetch-Dest', value: 'empty' }, { name: 'Sec-Fetch-Mode', value: 'cors' }, { name: 'Sec-Fetch-Site', value: 'same-origin' }, { name: 'User-Agent', value: nav.userAgent }]
  const wh = (headers: unknown, n: unknown = nav) => J.workerRequestFailures(req({ headers }), list1, O, { nav: n }).map((f: any) => f.why ?? f.rule).join('+')
  ok(wh(honestH) === '', `the honest worker's request headers: allowed (positive control on the header read; ${wh(honestH)})`)
  ok(wh([...honestH, { name: 'x-exfil', value: 'secret' }]) === 'a header the honest worker does not send: x-exfil', 'a header of the worker\'s own (x-exfil): a finding')
  ok(wh(honestH.map((h) => (h.name === 'Accept' ? { ...h, value: 'secret' } : h))) === 'a header the honest worker does not send: accept with another value', 'Accept with another value: a finding')
  ok(wh(honestH.map((h) => (h.name === 'Accept-Language' ? { ...h, value: 'secret' } : h))) === 'a header the honest worker does not send: accept-language with another value', 'Accept-Language unlike the navigation\'s: a finding')
  ok(wh(honestH.map((h) => (h.name === 'User-Agent' ? { ...h, value: 'secret' } : h))) !== '', 'User-Agent unlike the navigation\'s: a finding')
  ok(wh(honestH, null) === 'a header with no navigation to hold it to: accept-language+a header with no navigation to hold it to: user-agent', 'navigation record ABSENT: the browser-filled headers cannot be held, a finding, never a pass')
  ok(wh(honestH, {}) !== '', 'a navigation record with its fields ABSENT: the same')
  ok(wh([{ name: 'Cache-Control', value: 'no-cache' }]) !== '' && wh([{ name: 'Content-Type', value: 'text/plain' }]) !== '', 'Cache-Control and Content-Type, which the honest worker never sends: findings')
  ok(wh([{ name: 'Sec-Anything', value: 'x' }, { name: 'Proxy-Thing', value: 'x' }, { name: 'Origin', value: O }, { name: 'Connection', value: 'keep-alive' }]) === '', 'headers no script can set or choose (the other forbidden names, Sec-*, Proxy-*) are the browser\'s: allowed')
  // security ruling on #983, M4: forbidden NAMES whose VALUES a worker chooses (cookieStore, fetch's referrer)
  ok(wh([...honestH, { name: 'Cookie', value: 'x=secret' }]) === 'a header the honest worker does not send: cookie', 'a Cookie (a worker\'s cookieStore.set): a finding, though no script may set it by name')
  ok(wh([...honestH, { name: 'Referer', value: `${O}/secret?x=1` }]) === 'a header the honest worker does not send: referer', 'a Referer (fetch\'s referrer, unsafe-url): a finding')
  ok(wh([...honestH, { name: 'REFERER', value: `${O}/` }]) !== '' && wh([...honestH, { name: 'cookie', value: '' }]) !== '', 'any Referer, any Cookie, even an empty one, in any case: a finding (the honest worker sends neither)')
  // the browser's own update check names the script as its Referer (MEASURED, Chromium 149: a soft update)
  const scriptH = (ref: string | null) => [...honestH.filter((x) => x.name !== 'Sec-Fetch-Dest'), ...H('script', 'serviceworker'), ...(ref == null ? [] : [{ name: 'Referer', value: ref }])]
  const ws = (headers: unknown, url = `${O}/sw.js`, type = 'script') => J.workerRequestFailures(req({ url, type, headers }), list1, O, { nav }).map((f: any) => f.why ?? f.rule).join('+')
  ok(ws(scriptH(`${O}/sw.js`)) === '' && ws(scriptH(null)) === '', 'the browser\'s worker-script fetch with Referer = the script\'s own URL, or none: allowed (positive control)')
  ok(ws(scriptH(`${O}/sw.js?x`)) === 'a header the honest worker does not send: referer' && ws(scriptH(`${O}/`)) !== '' && ws(scriptH('https://evil.example/sw.js')) !== '', 'that fetch with any other Referer (a query, another path, another origin): a finding')
  ok(ws([...honestH, { name: 'Referer', value: `${O}/` }], `${O}/`, 'script') === 'a header the honest worker does not send: referer', 'a request\'s own URL as its Referer, without the browser\'s worker-script headers: a finding (only the browser\'s script fetch may carry it)')
  ok(wh([{ name: 'SERVICE-WORKER', value: 'script' }]) === '' && wh([{ name: 'Service-Worker', value: 'x' }]) !== '', 'header names are read case-blind; Service-Worker only as script')

  // the routing in front of the judge (security ruling on #983, M3): tripwire.js's workerRequestOf
  const T = await import(path.join(EXT, 'src/tripwire.js'))
  const d = (over: Record<string, unknown> = {}) => ({ tabId: -1, url: `${O}/`, method: 'GET', type: 'xmlhttprequest', initiator: O, requestHeaders: honestH, ...over })
  const routed = (x: unknown) => { const r = T.workerRequestOf(x); return r ? J.workerRequestFailures(r, list1, O, { nav }).map((f: any) => f.rule).join('+') || 'allowed' : 'ignored' }
  ok(routed(d()) === 'allowed', 'the library worker\'s honest request: judged, allowed (positive control on the routing)')
  ok(routed(d({ initiator: undefined })) === 'worker-request-unattributed', 'initiator ABSENT: judged as worker-request-unattributed, never dropped')
  ok(routed(d({ initiator: null })) === 'worker-request-unattributed', 'initiator null: the same')
  ok(routed(d({ initiator: 'chrome-extension://abcdefghijklmnop' })) === 'ignored', 'the extension\'s own fetch: not the worker\'s, ignored')
  ok(routed(d({ initiator: 'https://evil.example' })) === 'ignored', 'another site\'s initiator: ignored')
  ok(routed(d({ tabId: 3 })) === 'ignored' && routed(d({ tabId: undefined })) === 'ignored', 'a page\'s request (a tab id), or no tab id: ignored')
  ok(routed(d({ url: 'https://evil.example/x' })) === 'ignored', 'another origin: ignored (the listener never sees one)')
  ok(routed(d({ requestHeaders: undefined })) === 'worker-request', 'requestHeaders ABSENT: judged, a finding')
  ok(routed(d({ requestHeaders: [...honestH, { name: 'x-exfil', value: 's' }] })) === 'worker-request', 'a header of its own, through the routing: a finding')
  ok(routed(d({ requestHeaders: [...honestH, { name: 'Cookie', value: 'x=s' }] })) === 'worker-request' && routed(d({ requestHeaders: [...honestH, { name: 'Referer', value: `${O}/s` }] })) === 'worker-request', 'a Cookie or a Referer, through the routing: a finding (the routing keeps them)')

  // the navigation preload header value (security ruling on #983, M1)
  const pf = (o: unknown) => J.headerFailures(o).map((f: any) => f.rule).join('+')
  ok(pf({ preload: 'true' }) === '' && pf({}) === '' && pf({ preload: null }) === '', 'Service-Worker-Navigation-Preload: true, or absent: nothing to say')
  ok(pf({ preload: 'secret' }) === 'preload-header' && pf({ preload: '' }) === 'preload-header', 'any other value (a worker\'s setHeaderValue): preload-header')
  // a Cookie on the library's navigation (security ruling on #983, M4): recorded as present, never its value
  ok(pf({ cookie: true }) === 'request-cookie' && J.classOf(J.headerFailures({ cookie: true })) === 'tampered', 'a Cookie on the navigation: request-cookie, class tampered')
  ok(pf({ cookie: false }) === '' && pf({ cookie: null }) === '' && pf({}) === '' && pf({ cookie: 'x=1' }) === '', 'no Cookie, an unread record, or the field ABSENT: nothing to say (only a recorded true counts)')
  const twSrc2 = fs.readFileSync(path.join(EXT, 'src/tripwire.js'), 'utf8')
  ok(/onSendHeaders\.addListener\(onWorkerRequest, \{ urls: \[`\$\{LIBRARY_ORIGIN\}\/\*`\], tabId: -1 \}, \['requestHeaders', 'extraHeaders'\]\)/.test(twSrc2), 'the listener: the library origin only, tabId -1, with extraHeaders (Service-Worker and Sec-Fetch-Dest are only visible with it)')
}

section('a library page\'s own non-document requests (security ruling on #983, M6)')
{
  const O = 'https://home.bento.page'
  const T = await import(path.join(EXT, 'src/tripwire.js'))
  // MEASURED, Chromium 149: the honest page's manifest fetch (no credentials, the page is no-referrer)
  const pageH = [{ name: 'Accept', value: '*/*' }, { name: 'Sec-Fetch-Dest', value: 'manifest' }, { name: 'Sec-Fetch-Mode', value: 'cors' }, { name: 'Sec-Fetch-Site', value: 'same-origin' }, { name: 'User-Agent', value: 'Mozilla/5.0 (test)' }]
  const pr = (over: Record<string, unknown> = {}) => ({ url: `${O}/`, method: 'GET', type: 'other', initiator: O, headers: pageH, ...over })
  const pj = (r: unknown) => J.pageRequestFailures(r, list1, O).map((f: any) => f.why ?? f.rule).join('+')
  ok(pj(pr()) === '' && pj(pr({ url: `${O}/index.html` })) === '' && pj(pr({ url: `${O}/extra.js`, type: 'script' })) === '', 'the honest page\'s request: GET, no query, a path the release serves, no Cookie or Referer: allowed (positive control)')
  ok(pj(pr({ url: `${O}/?s=secret-mf` })) === 'a query' && pj(pr({ url: `${O}/?` })) === 'a query' && pj(pr({ url: `${O}/#a?b` })) === '', 'a query (the rewritten manifest href), even a bare ?: a finding; a ? in the fragment is not a query')
  ok(pj(pr({ url: `${O}/not-served` })) === 'a path no release serves', 'a path no release serves: a finding')
  ok(pj(pr({ method: 'POST' })) === 'not GET', 'POST (a ping, a form): a finding')
  ok(pj(pr({ url: 'https://evil.example/' })) === 'another origin' && pj(pr({ url: 'not a url' })) === 'unreadable URL', 'another origin, an unreadable URL: findings')
  ok(pj(pr({ headers: [...pageH, { name: 'Cookie', value: 'x=s' }] })) === 'a header the honest page does not send: cookie', 'a Cookie: a finding')
  ok(pj(pr({ headers: [...pageH, { name: 'REFERER', value: `${O}/` }] })) === 'a header the honest page does not send: referer', 'a Referer, in any case: a finding (the honest page is no-referrer)')
  ok(pj(pr({ headers: undefined })) === 'its request headers were not read' && pj(pr({ headers: null })) !== '', 'requestHeaders ABSENT: a finding, never a pass')
  ok(pj(pr({ headers: [...pageH, { name: 'Priority', value: 'u=4' }] })) === '', 'any other header is the browser\'s (a page with no script of its own sets none): allowed')
  const pu = J.pageRequestFailures(pr({ initiator: undefined }), list1, O)
  ok(pu.length === 1 && pu[0].rule === 'page-request-unattributed' && J.classOf(pu) === 'unverified', 'initiator ABSENT: page-request-unattributed, class unverified, never allowed in silence')
  ok(J.classOf(J.pageRequestFailures(pr({ url: `${O}/?x` }), list1, O)) === 'tampered', 'a page request outside the rules is "tampered"')

  // the tab's own document URL (the content script's re-read of the navigation): its query and path are the navigation's
  const po = (r: unknown, ownUrl: unknown) => J.pageRequestFailures(r, list1, O, { ownUrl }).map((f: any) => f.why ?? f.rule).join('+')
  ok(po(pr({ url: `${O}/?from=link`, type: 'xmlhttprequest' }), `${O}/?from=link`) === '' && po(pr({ url: `${O}/not-served`, type: 'xmlhttprequest' }), `${O}/not-served`) === '', 'the tab\'s own document URL, with a query or at an unlisted path (a 404): allowed (positive control)')
  ok(po(pr({ url: `${O}/?from=link` }), `${O}/?other`) === 'a query' && po(pr({ url: `${O}/?from=link` }), null) === 'a query' && po(pr({ url: `${O}/?from=link` }), undefined) === 'a query', 'another URL than the document\'s, or no navigation record (null, ABSENT): the query is a finding')
  ok(po(pr({ url: `${O}/?s=1` }), `${O}/`) === 'a query' && po(pr({ url: `${O}/not-served` }), `${O}/`) === 'a path no release serves', 'the document at / does not excuse a query or another path')
  ok(po(pr({ url: `${O}/?x`, method: 'POST' }), `${O}/?x`) === 'not GET' && po(pr({ url: `${O}/?x`, headers: [...pageH, { name: 'Cookie', value: 'c' }] }), `${O}/?x`) === 'a header the honest page does not send: cookie', 'the own URL is still held to GET and no Cookie')
  const d = (over: Record<string, unknown> = {}) => ({ tabId: 7, frameId: 0, url: `${O}/extra.js`, method: 'GET', type: 'other', initiator: O, requestHeaders: pageH, ...over })
  const routed = (x: unknown) => { const r = T.pageRequestOf(x); return r ? J.pageRequestFailures(r, list1, O).map((f: any) => f.why ?? f.rule).join('+') || 'allowed' : 'ignored' }
  ok(lib.files['/extra.js'] !== undefined, 'the fixture release serves /extra.js, standing in for the manifest (positive control on the list read)')
  ok(routed(d()) === 'allowed', 'the honest page\'s manifest fetch: judged, allowed (positive control on the routing)')
  ok(routed(d({ url: `${O}/extra.js?s=secret-mf-1234` })) === 'a query', 'the attack: that fetch with a query, judged: a finding')
  ok(routed(d({ tabId: 0 })) === 'allowed', 'tab id 0 is a tab: judged')
  ok(routed(d({ tabId: -1 })) === 'ignored' && routed(d({ tabId: undefined })) === 'ignored', 'tabId -1 (the worker\'s, onWorkerRequest\'s) or no tab id: not this listener\'s')
  ok(routed(d({ type: 'main_frame' })) === 'ignored' && routed(d({ type: 'sub_frame' })) === 'ignored', 'a navigation (main_frame, sub_frame): onRequest\'s, not this one\'s')
  ok(routed(d({ initiator: 'https://evil.example' })) === 'ignored' && routed(d({ initiator: 'chrome-extension://abcdefghijklmnop' })) === 'ignored', 'another site\'s page, or the extension, asking for a library file: ignored')
  ok(routed(d({ initiator: undefined })) === 'page-request-unattributed' && routed(d({ initiator: null })) === 'page-request-unattributed', 'initiator ABSENT or null: judged as page-request-unattributed, never dropped')
  ok(routed(d({ url: 'https://evil.example/x' })) === 'ignored', 'another origin: ignored (the listener never sees one)')
  ok(routed(d({ requestHeaders: undefined })) === 'its request headers were not read', 'requestHeaders ABSENT through the routing: a finding')
  ok(routed(d({ requestHeaders: [...pageH, { name: 'Cookie', value: 'x=s' }] })) === 'a header the honest page does not send: cookie', 'a Cookie through the routing: a finding (the routing keeps it)')
  ok(T.pageRequestOf(d({ requestHeaders: [{ name: 'Cookie', value: 'x=secret-ck' }] }))?.headers?.[0]?.value === '(not recorded)', 'the Cookie value is never recorded')
  const twSrc3 = fs.readFileSync(path.join(EXT, 'src/tripwire.js'), 'utf8')
  ok(/onSendHeaders\.addListener\(onPageRequest, \{ urls: \[`\$\{LIBRARY_ORIGIN\}\/\*`\] \}, \['requestHeaders', 'extraHeaders'\]\)/.test(twSrc3), 'the listener: the library origin, every type and tab (pageRequestOf picks), with extraHeaders (Cookie is only visible with it)')
}

section('sign-home-web-served.mjs')
const keyFile = (pub: any, priv: any) => { const f = path.join(work, `k-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify({ public: pub, private: priv })); return f }
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const pubJwk = publicKey.export({ format: 'jwk' }), privJwk = privateKey.export({ format: 'jwk' })
const throwaway = keyFile(pubJwk, privJwk)
const fakeRelease = keyFile(releasePublicKey(), privJwk) // public half is the release key, private is not ours
const signer = path.join(ROOT, 'scripts/sign-home-web-served.mjs')
const out = path.join(work, 'site/releases/home-web/served.json')
const runS = (...a: string[]) => spawnSync(process.execPath, [signer, ...a], { encoding: 'utf8' })
ok(runS('--build', build, '--out', out, '--key', throwaway, '--first').status !== 0 && !fs.existsSync(out), 'without --dev a key other than the release key is refused, nothing written')
ok(runS('--build', build, '--out', out, '--key', throwaway, '--dev').status !== 0 && !fs.existsSync(out), 'C8: neither --held nor --first is refused')
ok(runS('--build', build, '--out', out, '--key', throwaway, '--dev', '--held', path.join(work, 'nowhere.json')).status !== 0 && !fs.existsSync(out), 'C8: a --held that does not exist is refused (never a silent restart at serial 1)')
ok(runS('--build', build, '--out', out, '--key', throwaway, '--dev', '--held', out, '--first').status !== 0, 'C8: --held and --first together are refused')
ok(runS('--build', build, '--out', out, '--key', fakeRelease, '--dev', '--first').status !== 0 && !fs.existsSync(out), '--dev with the release key is refused')
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ ...info, testKey: true }))
ok(/development, test-key/.test(runS('--build', build, '--out', out, '--key', fakeRelease, '--first').stderr) && !fs.existsSync(out), 'a test-key build is refused for a release')
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ ...info, dev: true }))
ok(/development, test-key/.test(runS('--build', build, '--out', out, '--key', fakeRelease, '--first').stderr) && !fs.existsSync(out), 'a development build is refused for a release')
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ ...info, libraryOrigin: 'https://staging.example' }))
ok(/library origin/.test(runS('--build', build, '--out', out, '--key', fakeRelease, '--first').stderr) && !fs.existsSync(out), 'C8: a release for any library origin but https://home.bento.page is refused')
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify(info))
const r1 = runS('--build', build, '--out', out, '--key', throwaway, '--dev', '--first')
ok(r1.status === 0 && fs.existsSync(out), `a rehearsal signs with a throwaway key (${r1.stderr.trim().split('\n').at(-1) ?? ''})`)
const pubForJudge = { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y }
const a1 = await J.acceptServed(null, fs.readFileSync(out, 'utf8'), pubForJudge)
const scriptsDir = path.join(path.dirname(out), 'scripts')
const written = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : []
ok(written.length >= 2 && written.every((f) => sha(fs.readFileSync(path.join(scriptsDir, f), 'utf8')) + '.js' === f), `N4: the signer writes every inline script's text beside the list, named by its sha256 (${written.length})`)
ok(written.includes(`${lib.files['/'].scripts[0].sha256}.js`), 'N4: including the library\'s')
ok(a1.status === 'ok' && a1.list.serial === 1, 'the extension\'s reader verifies what the script signed (serial 1)')
const r2 = runS('--build', build, '--out', out, '--key', throwaway, '--dev', '--held', out)
const a2 = await J.acceptServed(a1.held, fs.readFileSync(out, 'utf8'), pubForJudge)
ok(r2.status === 0 && a2.status === 'ok' && a2.list.serial === 2 && a2.list.releases.length === 2, 'the next signing builds on the held list: serial 2, two releases')
const firstAt = a2.list.releases[1].at
const r2w = runS('--build', build, '--out', out, '--key', throwaway, '--dev', '--held', out, '--withdraw', firstAt)
const a3 = await J.acceptServed(a2.held, fs.readFileSync(out, 'utf8'), pubForJudge)
ok(r2w.status === 0 && a3.status === 'ok' && a3.list.serial === 3 && a3.list.releases[2].withdrawn === true && !a3.list.releases[0].withdrawn, 'R1: --withdraw marks the named older release withdrawn')
ok(runS('--build', build, '--out', path.join(work, 'y.json'), '--key', throwaway, '--dev', '--held', out, '--withdraw', '1999-01-01T00:00:00.000Z').status !== 0, 'R1: --withdraw of a release the list does not hold is refused')
const tampered = JSON.parse(fs.readFileSync(out, 'utf8')); tampered.payload = tampered.payload.replace('"serial":3', '"serial":7')
fs.writeFileSync(out, JSON.stringify(tampered))
const r3 = runS('--build', build, '--out', path.join(work, 'x.json'), '--key', throwaway, '--dev', '--held', out)
ok(r3.status !== 0 && !fs.existsSync(path.join(work, 'x.json')), 'a held list whose signature fails is never built on')
void execFileSync

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
