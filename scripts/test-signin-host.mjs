// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/id sign-in host (server/signin/) without a browser: what the worker
// serves, the rules its page source must keep, and the hosting check the deploy
// runs, proven able to fail.
//
//   node scripts/test-signin-host.mjs
//
// 1. The worker: exactly four files, each with the fixed header set; every
//    other path (/.well-known/webauthn included) is a 404 with the same
//    headers; nothing but GET and HEAD. public/ holds exactly those files.
// 2. The page source: no inline script, style or handler (the CSP would block
//    them, so the page would silently break); one postMessage call, to a literal
//    https://home.bento.page; nothing read from the page's own URL; no Signal
//    API, no credentials.create. These are cheap guards beside the browser rig
//    (scripts/test-signin-host-browser.mjs), which tests the behaviour.
// 3. check-hosting.mjs passes against the real worker on a local server, and
//    fails against each mutant worker (a header dropped or loosened, COOP that
//    severs the opener, a /.well-known/webauthn served) and against a bento/home
//    sending COOP same-origin.
// Every mutant edits a copy of server/signin/; one whose edit no longer applies
// fails the rig.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, siteHandler } from '../server/signin/local.mjs'
import { checkHosting, cspProblems } from '../server/signin/check-hosting.mjs'
import { CSP, FILES, HEADERS } from '../server/signin/src/worker.js'

const ROOT = fileURLToPath(new URL('../server/signin/', import.meta.url))
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const tmp = mkdtempSync(join(tmpdir(), 'signin-host-'))
let n = 0
function copyWith(edits) {
  const dir = join(tmp, 'c' + ++n)
  cpSync(ROOT, dir, { recursive: true })
  for (const [file, from, to] of edits) {
    const f = join(dir, file), text = readFileSync(f, 'utf8')
    const k = text.split(from).length - 1
    if (k !== 1) throw new Error(`mutant edit occurs ${k} times in ${file}, not once: ${from.slice(0, 60)}`)
    writeFileSync(f, text.replace(from, () => to))
  }
  return dir
}

try {
  // ---- 1. the worker ----------------------------------------------------------
  console.log('the worker')
  const h = await siteHandler(ROOT)
  const req = (path, method = 'GET') => h(new Request('https://signin.id.bento.page' + path, { method }))
  const sameHeaders = (r) => Object.entries(HEADERS).every(([k, v]) => r.headers.get(k) === v)
  ok(cspProblems(CSP).length === 0, `its CSP meets the hosting rule (${CSP})`)
  ok(/connect-src https:\/\/id\.bento\.page(;|$)/.test(CSP), 'connections go to the directory only')
  ok(!Object.keys(HEADERS).includes('cross-origin-opener-policy'), 'it sends no Cross-Origin-Opener-Policy')
  for (const [path, [, type]] of Object.entries(FILES)) {
    const r = await req(path)
    ok(r.status === 200 && r.headers.get('content-type') === type && sameHeaders(r), `${path}: 200 ${type}, every fixed header`)
  }
  const onDisk = readdirSync(join(ROOT, 'public')).sort()
  ok(JSON.stringify(onDisk) === JSON.stringify(Object.values(FILES).map(([f]) => f.slice(1)).sort()), `public/ holds exactly the served files (${onDisk.join(', ')})`)
  for (const path of ['/.well-known/webauthn', '/index.html', '/enrol', '/roster', '/%2e%2e/etc/passwd', '/signin.js/', '/SIGNIN.JS']) {
    const r = await req(path)
    ok(r.status === 404 && sameHeaders(r), `${path}: 404 with every fixed header`)
  }
  const q = await req('/?t=enrol&W=AAAA')
  ok(q.status === 200 && (await q.text()) === readFileSync(join(ROOT, 'public/index.html'), 'utf8'), 'a query string changes nothing the worker serves')
  for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const r = await req('/', m)
    ok(r.status === 405 && sameHeaders(r), `${m} /: 405 with every fixed header`)
  }
  const head = await req('/', 'HEAD')
  ok(head.status === 200 && (await head.text()) === '' && sameHeaders(head), 'HEAD /: 200, no body, every fixed header')

  // ---- 2. the page source --------------------------------------------------------
  console.log('\nthe page source')
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')
  const js = ['signin.js', 'directory-client.js'].map((f) => readFileSync(join(ROOT, 'public', f), 'utf8')).join('\n')
  const rules = {
    'no inline script (every <script> has a src)': (h) => [...h.matchAll(/<script\b([^>]*)>/gi)].every((m) => /\bsrc=/.test(m[1])) && !/<script\b[^>]*>[^<\s]/i.test(h),
    'no inline handler or style attribute': (h) => !/\son[a-z]+\s*=|\sstyle\s*=|<style\b|javascript:/i.test(h),
  }
  for (const [name, f] of Object.entries(rules)) ok(f(html), `index.html: ${name}`)
  const code = js.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const lint = {
    'exactly one postMessage call, to the literal HOME': (c) => (c.match(/postMessage\(/g) || []).length === 1 && /postMessage\(msg, HOME\)/.test(c),
    "HOME is the literal 'https://home.bento.page'": (c) => /const HOME = 'https:\/\/home\.bento\.page'\n/.test(c),
    'nothing read from the URL (location, URLSearchParams, document.URL, referrer, window.name)': (c) => !/\blocation\b|URLSearchParams|document\.URL|documentURI|document\.referrer|window\.name|\bname\s*=\s*window/.test(c),
    'no Signal API call': (c) => !/\bsignal(AllAcceptedCredentials|UnknownCredential|CurrentUserDetails)\b|PublicKeyCredential\s*\[/.test(c),
    'no credentials.create (the popup only asserts)': (c) => !/credentials\.create|\.create\s*\(\s*\{\s*publicKey/.test(c),
    'no eval, Function or HTML sinks': (c) => !/\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(c),
    "the origin check is e.origin !== HOME": (c) => /if \(e\.origin !== HOME\) return show\('refused', 'wrong-origin'\)/.test(c),
    'the source check is e.source !== window.opener': (c) => /if \(e\.source !== window\.opener/.test(c),
    'the request is exactly the keys W,kx,label,t': (c) => /Object\.keys\(m\)\.sort\(\)\.join\(','\) !== 'W,kx,label,t'/.test(c),
    'rq is event.origin': (c) => /request = \{ \.\.\.r, rq: e\.origin \}/.test(c),
  }
  for (const [name, f] of Object.entries(lint)) ok(f(code), `page script: ${name}`)
  // each lint, against a source that breaks it
  const bad = {
    'exactly one postMessage call, to the literal HOME': code.replace('postMessage(msg, HOME)', "postMessage(msg, '*')"),
    "HOME is the literal 'https://home.bento.page'": code.replace("const HOME = 'https://home.bento.page'", "const HOME = 'https://home.bento.page.evil'"),
    'nothing read from the URL (location, URLSearchParams, document.URL, referrer, window.name)': code + '\nconst q = new URLSearchParams(location.search)',
    'no Signal API call': code + '\nPublicKeyCredential.signalUnknownCredential({})',
    'no credentials.create (the popup only asserts)': code + '\nnavigator.credentials.create({ publicKey: {} })',
    'no eval, Function or HTML sinks': code + "\n$('who').innerHTML = e.origin",
    "the origin check is e.origin !== HOME": code.replace("if (e.origin !== HOME) return show('refused', 'wrong-origin')", ''),
    'the source check is e.source !== window.opener': code.replace('if (e.source !== window.opener', 'if (false'),
    'the request is exactly the keys W,kx,label,t': code.replace("!== 'W,kx,label,t'", "=== ''"),
    'rq is event.origin': code.replace('request = { ...r, rq: e.origin }', 'request = { ...r, rq: e.data.rq }'),
  }
  for (const [name, src] of Object.entries(bad)) ok(src !== code && !lint[name](src), `MUTANT ${name}: the lint fails`)
  ok(!rules['no inline script (every <script> has a src)'](html.replace('</head>', '<script>alert(1)</script></head>')), 'MUTANT inline script: the lint fails')
  ok(!rules['no inline handler or style attribute'](html.replace('<main>', '<main onclick="x()">')), 'MUTANT inline handler: the lint fails')

  // ---- 3. the hosting check ------------------------------------------------------
  console.log('\nthe hosting check, against the real worker')
  const run = async (handler, extra = {}) => {
    const s = await serve(handler)
    try { return await checkHosting({ origin: s.url, rpOrigin: 'none', local: true, ...extra }) } finally { await s.close() }
  }
  let rows = await run(h)
  const fails = rows.filter((r) => !r.ok)
  ok(fails.length === 0 && rows.length > 50, `every row passes (${rows.length} rows${fails.length ? '; ' + fails.map((r) => r.row).join(' | ') : ''})`)
  ok(rows.some((r) => r.ok && /HTML response\(s\) seen/.test(r.row) && !/^0 /.test(r.row)), 'it saw the HTML page (the HTML rows are not vacuous)')

  // the rp host's /.well-known/webauthn, and bento/home's COOP, against small stand-ins
  const stand = (status, headers = {}) => async () => new Response('', { status, headers })
  const sRp = await serve(stand(404)), sRpBad = await serve(stand(200, { 'content-type': 'application/json' }))
  const sHome = await serve(stand(200, { 'cross-origin-opener-policy': 'same-origin-allow-popups' }))
  const sHomeBad = await serve(stand(200, { 'cross-origin-opener-policy': 'same-origin' }))
  const sHomeNone = await serve(stand(200))
  try {
    const only = async (extra, re) => (await run(h, extra)).filter((r) => re.test(r.row))
    let r = await only({ rpOrigin: sRp.url }, /^http.*well-known\/webauthn: status/)
    ok(r.length === 1 && r[0].ok, `rp host answering 404 for /.well-known/webauthn passes (${r[0]?.row})`)
    r = await only({ rpOrigin: sRpBad.url }, /^http.*well-known\/webauthn: status/)
    ok(r.length === 1 && !r[0].ok, `MUTANT the rp host serves /.well-known/webauthn: the check fails (${r[0]?.row})`)
    for (const [srv, want, what] of [[sHome, true, 'same-origin-allow-popups'], [sHomeNone, true, 'no COOP'], [sHomeBad, false, 'same-origin']]) {
      r = await only({ home: srv.url }, /Cross-Origin-Opener-Policy at most/)
      ok(r.length === 1 && r[0].ok === want, `${want ? '' : 'MUTANT '}bento/home sending ${what}: the check ${want ? 'passes' : 'fails'} (${r[0]?.row})`)
    }
  } finally {
    for (const s of [sRp, sRpBad, sHome, sHomeBad, sHomeNone]) await s.close()
  }

  console.log('\nthe hosting check, against mutant workers')
  const W = 'src/worker.js'
  const MUTANTS = {
    'CSP dropped on the 404': [[W, "    if (!file) return answer(404, 'Not found\\n', 'text/plain; charset=utf-8', head)",
      "    if (!file) return new Response(head ? null : 'Not found\\n', { status: 404, headers: { ...HEADERS, 'content-security-policy': '', 'content-type': 'text/plain' } })"]],
    'CSP dropped on the page': [[W, "  'content-security-policy': CSP,\n", '']],
    "script-src 'unsafe-inline'": [[W, `"script-src 'self'",`, `"script-src 'self' 'unsafe-inline'",`]],
    'script-src https:': [[W, `"script-src 'self'",`, `"script-src 'self' https:",`]],
    'default-src missing': [[W, `"default-src 'none'",\n`, '']],
    "frame-ancestors 'self'": [[W, `"frame-ancestors 'none'",`, `"frame-ancestors 'self'",`]],
    'X-Frame-Options dropped': [[W, "  'x-frame-options': 'DENY',\n", '']],
    'nosniff dropped': [[W, "  'x-content-type-options': 'nosniff',\n", '']],
    'COOP same-origin': [[W, "  'cache-control': 'no-cache',\n", "  'cache-control': 'no-cache',\n  'cross-origin-opener-policy': 'same-origin',\n"]],
    'COOP same-origin-allow-popups (measured to sever the popup in Chromium)': [[W, "  'cache-control': 'no-cache',\n", "  'cache-control': 'no-cache',\n  'cross-origin-opener-policy': 'same-origin-allow-popups',\n"]],
    'CSP report-only': [[W, "  'content-security-policy': CSP,\n", "  'content-security-policy-report-only': CSP,\n"]],
    '/.well-known/webauthn served': [[W, "  '/signin.css': ['/signin.css', 'text/css; charset=utf-8'],\n",
      "  '/signin.css': ['/signin.css', 'text/css; charset=utf-8'],\n  '/.well-known/webauthn': ['/signin.css', 'application/json'],\n"]],
    'an extra page served': [[W, "  '/signin.css': ['/signin.css', 'text/css; charset=utf-8'],\n",
      "  '/signin.css': ['/signin.css', 'text/css; charset=utf-8'],\n  '/enrol': ['/index.html', 'text/html; charset=utf-8'],\n"]],
  }
  for (const [name, edits] of Object.entries(MUTANTS)) {
    const dir = copyWith(edits)
    const rows = await run(await siteHandler(dir, 'm' + n))
    const red = rows.filter((r) => !r.ok)
    ok(red.length > 0, `MUTANT ${name}: the check fails (${red.length} row(s), e.g. ${red[0]?.row})`)
  }

  console.log('\nthe CSP rule itself')
  for (const [v, good] of [
    [CSP, true],
    [CSP.replace("script-src 'self'", "script-src 'self' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='"), true],
    [CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), false],
    [CSP.replace("script-src 'self'", "script-src 'self' 'strict-dynamic'"), false],
    [CSP.replace("script-src 'self'", "script-src *"), false],
    [CSP.replace("script-src 'self'", "script-src 'self' data:"), false],
    [CSP.replace("script-src 'self'", "script-src 'self' blob:"), false],
    [CSP.replace("script-src 'self'", "script-src 'self' 'nonce-abc'"), false],
    [CSP.replace("frame-ancestors 'none'", "frame-ancestors *"), false],
    [CSP + "; frame-ancestors https://home.bento.page", false],
    [CSP.replace("default-src 'none'", "default-src 'self'"), false],
    [CSP + "; script-src-attr 'unsafe-inline'", false],
    ['', false],
  ]) ok((cspProblems(v).length === 0) === good, `${good ? 'accepts' : 'refuses'}: ${v.slice(0, 90) || '(none)'}${cspProblems(v).length ? ' — ' + cspProblems(v)[0] : ''}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
