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
  const worker = (await import('../server/signin/src/worker.js')).default
  const boom = await worker.fetch(new Request('https://signin.id.bento.page/'), { ASSETS: { fetch() { throw new Error('binding down') } } })
  ok(boom.status === 500 && sameHeaders(boom), 'a throwing assets binding: 500 with every fixed header (never the platform error page)')
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
    'every await in onMessage is followed by a voided check': (c) => {
      const body = (c.match(/async function onMessage\(e\) \{\n([\s\S]*?)\n\}\n/) || [])[1]
      if (!body) return false
      const lines = body.split('\n')
      const awaits = lines.map((l, i) => [l, i]).filter(([l]) => /\bawait\b/.test(l))
      return awaits.length >= 2 && awaits.every(([, i]) => lines[i + 1] === '  if (voided) return')
    },
    'the statement challenge is computed in directory-client.js': (c) => /export async function challengeFor\(text\)/.test(c) && /const challenge = await challengeFor\(text\)/.test(c),
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
    'every await in onMessage is followed by a voided check': code.replace('  const fp = await fingerprint(r.W)\n  if (voided) return\n', '  const fp = await fingerprint(r.W)\n'),
    'the statement challenge is computed in directory-client.js': code.replace('const challenge = await challengeFor(text)', "const challenge = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))"),
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
    'Trusted Types not enforced': [[W, `  "require-trusted-types-for 'script'",\n`, '']],
    'a Trusted Types policy allowed': [[W, `  "trusted-types 'none'",`, `  "trusted-types default",`]],
    'an account page served without its CSP': [[W, "      return answer(200, await asset.arrayBuffer(), file[1], head)",
      "      if (file[0] === '/account.html') return new Response(await asset.arrayBuffer(), { headers: { 'content-type': file[1] } })\n      return answer(200, await asset.arrayBuffer(), file[1], head)"]],
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
    [CSP.replace('connect-src https://id.bento.page', 'connect-src https://evil.example'), false],
    [CSP.replace('connect-src https://id.bento.page', 'connect-src https://id.bento.page https://evil.example'), false],
    [CSP.replace("style-src 'self'", "style-src 'self' https://fonts.example"), false],
    [CSP.replace("; require-trusted-types-for 'script'", ''), false],
    [CSP.replace("trusted-types 'none'", 'trusted-types bento'), false],
    [CSP.replace("; trusted-types 'none'", ''), false],
    ['', false],
  ]) ok((cspProblems(v).length === 0) === good, `${good ? 'accepts' : 'refuses'}: ${v.slice(0, 90) || '(none)'}${cspProblems(v).length ? ' — ' + cspProblems(v)[0] : ''}`)

  console.log('\nthe DNS rows see wildcards (and only wildcards: explicit names need the zone listing by hand)')
  const zone = (names, wildcard) => {
    const has = (n) => names.includes(n) || (wildcard && wildcard.some((w) => n.endsWith('.' + w)))
    const ans = async (n) => { if (has(n)) return ['192.0.2.1']; const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e }
    return { resolve4: ans, resolve6: ans, resolveCname: async (n) => { const e = new Error('nodata'); e.code = 'ENODATA'; throw e } }
  }
  const dnsRows = async (resolver) => (await checkHosting({ origin: 'https://signin.id.bento.page', rpOrigin: 'none', fetchImpl: async () => { throw new Error('offline') }, resolver }))
    .filter((r) => /no wildcard name under/.test(r.row))
  let d = await dnsRows(zone(['id.bento.page', 'signin.id.bento.page']))
  ok(d.length === 2 && d.every((r) => r.ok), `a zone with only the two names passes both rows (${d.map((r) => r.row).join(' | ')})`)
  d = await dnsRows(zone([], ['id.bento.page']))
  ok(d.length === 2 && d.every((r) => !r.ok), 'MUTANT a wildcard under id.bento.page: both rows fail')
  d = await dnsRows(zone([], ['signin.id.bento.page']))
  ok(d.length === 2 && !d[0].ok && d[1].ok, 'MUTANT a wildcard under the sign-in host: its row fails')
  d = await dnsRows(zone(['x.id.bento.page', 'x.signin.id.bento.page']))
  ok(d.length === 2 && d.every((r) => r.ok), 'recorded: explicit extra names pass these rows, which is why the deploy lists the zone by hand')

  // ---- 4. the host's own pages: /setup, /reset, /account ------------------------------
  console.log('\nthe account pages (setup and reset links, sign in, sign out everywhere)')
  {
    const read = (f) => readFileSync(join(ROOT, 'public', f), 'utf8')
    const strip = (c) => c.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const pages = ['setup.html', 'reset.html', 'account.html']
    for (const f of pages) {
      const h = read(f)
      for (const [name, rule] of Object.entries(rules)) ok(rule(h), `${f}: ${name}`)
      ok(/<script type="module" src="\/(link|account)\.js"><\/script>/.test(h), `${f}: loads its one module script from this host`)
    }
    // `rest` is EVERY other script this host serves (the popup's signin.js and directory-client.js included):
    // the one-write rule is host-wide, so its lint reads them all (security-ruling-953 C1)
    const restFiles = readdirSync(join(ROOT, 'public')).filter((x) => x.endsWith('.js') && !['link.js', 'account.js', 'account-client.js'].includes(x)).sort()
    const files = { link: strip(read('link.js')), account: strip(read('account.js')), client: strip(read('account-client.js')), rest: restFiles.map((x) => strip(read(x))).join('\n') }
    ok(restFiles.includes('signin.js') && restFiles.includes('directory-client.js'), `the host-wide lint also reads ${restFiles.join(', ')}`)
    const all = (f) => [f.link, f.account, f.client].join('\n')
    const fnBody = (c, name) => (c.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`)) || [])[1] || null
    const URLREAD = /\blocation\b|URLSearchParams|document\.URL|documentURI|document\.referrer|window\.name/
    const htmls = pages.map(read).join('\n')
    const L = {
      // G12c and the 948 ruling: nothing but the documented fragment, and only on the link pages
      'the only URL read is readLink() on the link pages; account.js and account-client.js read none': (f) => {
        const rl = fnBody(f.link, 'readLink')
        return !!rl && !URLREAD.test(f.account) && !URLREAD.test(f.client) && !URLREAD.test(f.link.replace(rl, ''))
      },
      'readLink takes the fragment out of the address bar before it reads it': (f) => {
        const rl = fnBody(f.link, 'readLink') || ''
        const i = rl.indexOf('history.replaceState(null, \'\', location.pathname)'), j = rl.indexOf('new URLSearchParams(')
        return i >= 0 && j > i
      },
      'readLink takes exactly v, e and t, once each, v=1, a 43-character token, and no query': (f) => {
        const rl = fnBody(f.link, 'readLink') || ''
        return /if \(query\) return null/.test(rl) && /keys\.length !== 3 \|\| new Set\(keys\)\.size !== 3 \|\| !\['v', 'e', 't'\]\.every/.test(rl) &&
          /f\.get\('v'\) !== '1'/.test(rl) && /\^\[A-Za-z0-9_-\]\{43\}\$/.test(rl)
      },
      // security-ruling-948: only an account the person proved on this host
      'bento-id-account is written once, in signInHere(), with the directory\'s answer after the expect check': (f) => {
        // every script the host serves: each `localStorage` token is one of two reads or the one write (so an alias,
        // `const s = localStorage`, is a fourth token), and the key's name is written only where ACCOUNT_KEY is defined
        const c = all(f) + '\n' + f.rest
        const sib = fnBody(f.client, 'signInHere') || ''
        const tokens = (c.match(/localStorage/g) || []).length
        const reads = (c.match(/localStorage\.getItem\(ACCOUNT_KEY\)/g) || []).length
        const writes = (c.match(/localStorage\.setItem\(ACCOUNT_KEY, a\.address\)/g) || []).length
        const names = (c.match(/bento-id-account/g) || []).length
        const w = sib.indexOf('localStorage.setItem(ACCOUNT_KEY, a.address)'), e = sib.indexOf("if (expect !== undefined && a.address !== expect) throw new Refused('other-account')")
        const v = sib.indexOf("if (r.status !== 200) throw"), p = sib.indexOf('await post(ROUTES.signin,')
        return tokens === 3 && reads === 2 && writes === 1 && names === 2 &&
          /export const ACCOUNT_KEY = 'bento-id-account'\n/.test(f.client) && /const ACCOUNT_KEY = 'bento-id-account'\n/.test(f.rest) && w > e && e > v && v > p && p > 0
      },
      'signInHere is called only from the setup confirmation and the account page\'s sign-in': (f) => {
        const calls = all(f).match(/\bsignInHere\(/g) || []
        return calls.length === 3 && /await signInHere\(\{ allow: made, expect: link\.address \}\)/.test(f.link) && /await signInHere\(\)\n/.test(f.account)
      },
      'a setup reaches the confirmation only on a 200 from the setup route': (f) => /if \(r\.status !== 200\) throw new Refused\(why\(r, SETUP_FAIL\)\)\n\s*made = r\.credId\n/.test(f.link) && (f.link.match(/made = r\.credId/g) || []).length === 1 && /let made = null\n/.test(f.link) && (f.link.match(/\bmade = /g) || []).length === 2,
      'the account pages answer no message and post none': (f) => !/addEventListener\(\s*['"]message|onmessage|postMessage|\bopener\b|BroadcastChannel|MessageChannel/.test(all(f)),
      'no Signal API, eval, Function or HTML sink': (f) => !/\bsignal(AllAcceptedCredentials|UnknownCredential|CurrentUserDetails)\b|PublicKeyCredential\s*\[|\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(all(f)),
      'create: rp id.bento.page, ES256 only, a discoverable key, user verification required, no attestation': (f) => {
        const c = fnBody(f.client, 'completeLink') || ''
        return /rp: \{ id: RP_ID, name: 'bento\/id' \}/.test(c) && /pubKeyCredParams: \[\{ type: 'public-key', alg: -7 \}\]/.test(c) &&
          /residentKey: 'required', requireResidentKey: true, userVerification: 'required'/.test(c) && /attestation: 'none'/.test(c) &&
          /export const RP_ID = 'id\.bento\.page'\n/.test(f.client) && (all(f).match(/credentials\.create\(/g) || []).length === 1
      },
      'the user handle is the account\'s storage name plus 16 random bytes': (f) => {
        const u = fnBody(f.client, 'userHandle') || ''
        return /'bento-dir\/1\/addr\\n' \+ address/.test(u) && /new Uint8Array\(48\)/.test(u) && /crypto\.getRandomValues\(new Uint8Array\(16\)\), 32\)/.test(u)
      },
      'every get and create asks for user verification': (f) => (all(f).match(/userVerification: 'required'/g) || []).length === 3 && !/userVerification: '(preferred|discouraged)'/.test(all(f)),
      'a raw challenge is a 40-byte sealed one, never 32 (a statement hash)': (f) => /const SEALED = \/\^\[A-Za-z0-9_-\]\{54\}\$\/\n/.test(f.client) && (f.client.match(/!SEALED\.test\(/g) || []).length === 3,
    }
    const XL = {
      'X7: no page makes, shows or asks for a code (the X3 sentence alone mentions one)': (h, f) => {
        const x3 = /install the Bento app and make a recovery code\./
        const rest = h.replace(/<p class="note" id="x3">[^<]*<\/p>/, '')
        const inputs = [...h.matchAll(/<input\b[^>]*>/g)].map((m) => m[0])
        return x3.test(h) && !/\bcode\b/i.test(rest.replace(/<\/?code>/g, '')) && inputs.every((i) => /type="email"/.test(i)) &&
          !/<textarea|contenteditable/i.test(h) && !/recovery|\bcode\b/i.test(all(f).replace(/charCodeAt|fromCharCode/g, ''))
      },
      'X3: the setup page states what a browser-only account loses': (h) => h.includes('Documents shared with you are opened by keys kept in this browser.') && /<body data-link="setup"[\s\S]*id="x3"/.test(h),
    }
    for (const [name, f] of Object.entries(L)) ok(f(files), `account pages: ${name}`)
    for (const [name, f] of Object.entries(XL)) ok(f(htmls, files), `account pages: ${name}`)
    const mod = (key, from, to) => { const c = { ...files }; if (!c[key].includes(from)) throw new Error(`lint mutant: ${from.slice(0, 50)} not in ${key}`); c[key] = c[key].replace(from, () => to); return c }
    const BADL = {
      'the only URL read is readLink() on the link pages; account.js and account-client.js read none': mod('account', 'function home() {', "function home() {\n  if (new URLSearchParams(location.hash.slice(1)).get('a')) $('account').textContent = 'x'"),
      'readLink takes the fragment out of the address bar before it reads it': mod('link', "  history.replaceState(null, '', location.pathname)\n", ''),
      'readLink takes exactly v, e and t, once each, v=1, a 43-character token, and no query': mod('link', '  if (query) return null\n', ''),
      'bento-id-account is written once, in signInHere(), with the directory\'s answer after the expect check': mod('link', 'const link = readLink()', "const link = readLink()\ntry { localStorage.setItem('bento-id-account', link.address) } catch {}"),
      'signInHere is called only from the setup confirmation and the account page\'s sign-in': mod('link', "      $('ripens').textContent = when(r.body.ripensAt)", "      await signInHere({ expect: link.address })\n      $('ripens').textContent = when(r.body.ripensAt)"),
      'a setup reaches the confirmation only on a 200 from the setup route': mod('link', '      made = r.credId\n', '      made = r.credId\n      made = r.credId\n'),
      'the account pages answer no message and post none': mod('account', 'function start() {', "function start() {\n  addEventListener('message', (e) => { if (e.data && e.data.t === 'sign-out-everywhere') signOutAll() })"),
      'no Signal API, eval, Function or HTML sink': mod('account', "  $('account').textContent = account", "  $('account').innerHTML = account"),
      'create: rp id.bento.page, ES256 only, a discoverable key, user verification required, no attestation': mod('client', "      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],", "      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],"),
      'the user handle is the account\'s storage name plus 16 random bytes': mod('client', '  out.set(crypto.getRandomValues(new Uint8Array(16)), 32)\n', ''),
      'every get and create asks for user verification': mod('client', "    publicKey: { rpId: RP_ID, challenge: await challengeFor(text), userVerification: 'required',", "    publicKey: { rpId: RP_ID, challenge: await challengeFor(text), userVerification: 'preferred',"),
      'a raw challenge is a 40-byte sealed one, never 32 (a statement hash)': mod('client', 'const SEALED = /^[A-Za-z0-9_-]{54}$/', 'const SEALED = /^[A-Za-z0-9_-]{43,54}$/'),
    }
    for (const [name, src] of Object.entries(BADL)) ok(!L[name](src), `MUTANT ${name}: the lint fails`)
    // C1 of security-ruling-953: writes from the popup, the page that answers messages, and through an alias
    const ONE = 'bento-id-account is written once, in signInHere(), with the directory\'s answer after the expect check'
    for (const [what, src] of [
      ['m2: the popup stores bento/home\'s label as the account', mod('rest', '  busy = true\n  show(\'working\')\n', "  busy = true\n  localStorage.setItem(ACCOUNT_KEY, request.label)\n  show('working')\n")],
      ['the popup stores the account under the literal key', mod('rest', '  busy = true\n  show(\'working\')\n', "  busy = true\n  try { window['local' + 'Storage'].setItem('bento-id-account', request.label) } catch {}\n  show('working')\n")],
      ['a write through an alias', mod('client', 'export function savedAccount() {', 'const store = localStorage\nexport function remember(x) { store.setItem(ACCOUNT_KEY, x) }\nexport function savedAccount() {')],
      ['the directory client writes the account', mod('rest', 'export const DIRECTORY =', "try { localStorage.setItem(ACCOUNT_KEY, 'x') } catch {}\nexport const DIRECTORY =")],
    ]) ok(!L[ONE](src), `MUTANT ${what}: the lint fails`)
    ok(!XL['X7: no page makes, shows or asks for a code (the X3 sentence alone mentions one)'](htmls.replace('<section data-for="done" hidden>', '<section data-for="done" hidden>\n    <p>Your recovery code: <code id="code"></code></p>'), files), 'MUTANT a recovery code shown after setup: the lint fails')
    ok(!XL['X7: no page makes, shows or asks for a code (the X3 sentence alone mentions one)'](htmls.replace('<input id="reset-email" type="email"', '<input id="reset-code" type="text"'), files), 'MUTANT a typed code box: the lint fails')
    ok(!XL['X3: the setup page states what a browser-only account loses'](htmls.replace(/<p class="note" id="x3">[^<]*<\/p>/, ''), files), 'MUTANT the X3 sentence dropped: the lint fails')
    for (const f of ['link.js', 'account.js', 'account-client.js', ...pages]) {
      const t = read(f)
      ok(![...t].some((ch) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch) && ch !== '\n'), `${f}: no invisible or control characters in the source`)
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
