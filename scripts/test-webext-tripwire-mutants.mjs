#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Mutants for the bento/home tripwire: each turns ONE rule off in a copy of
 * the extension and runs the browser rig's row that guards it. Every mutant
 * must turn that row red; a mutant that leaves it green means the row does not
 * test the rule it claims to.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-webext-tripwire-mutants.mjs
 *
 * The rows run unmutated first (the control): a mutant run means nothing if
 * its row is already red.
 *
 * A mutant with `build` changes the home/web SOURCE instead (the rig rebuilds
 * release A with it, through build.mjs's --dev mutant seam): the stage-3
 * worker without navigation preload (security ruling #954 C1), whose rows the
 * tripwire alone cannot hold.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RIG = path.join(ROOT, 'scripts/test-webext-tripwire-browser.mjs')
// the stage-3 worker without navigation preload (security ruling #954 C1): it answers navigations
// by its own fetch, which webRequest does not see as the tab's main frame
const NO_PRELOAD = [
  { file: 'sw.ts', from: '    try { await self.registration.navigationPreload?.enable() } catch { /* no navigation preload: navigations fetch from here */ }\n', to: '' },
  { file: 'sw.ts', from: "const pre = e.request.mode === 'navigate' ? e.preloadResponse : undefined", to: 'const pre: Promise<Response | undefined> | undefined = undefined' },
]
const J = 'src/tripwire-judge.js', W = 'src/tripwire.js', O = 'src/tripwire-observe.js', P = 'src/tripwire-page.js', M = 'manifest.json'

const MUTANTS = [
  { name: 'bytes rule off', row: 'library-byte', file: J, from: 'if (obs.bytes && obs.bytes.sha256 !== e.sha256)', to: 'if (false)' },
  { name: 'size rule off', row: 'sw-size', file: J, from: 'if (obs.size > 0 && obs.size !== e.bytes)', to: 'if (false)' },
  { name: 'scripts rule off', row: 'sw-navigation-only', file: J, from: 'if (!scriptsMatch(obs.scripts, e.scripts, site.files))', to: 'if (false)' },
  { name: 'scripts rule off (frame)', row: 'frame-byte', file: J, from: 'if (!scriptsMatch(obs.scripts, e.scripts, site.files))', to: 'if (false)' },
  { name: 'csp rule off', row: 'library-csp', file: J, from: "if (obs.csp != null && join(obs.csp) !== (e.csp ?? ''))", to: 'if (false)' },
  { name: 'navigation headers ignored (webRequest)', row: 'frame-csp', file: W, from: 'const fresh = matches(h, url, obs.timeOrigin)', to: 'const fresh = false' },
  { name: 'markup rule off', row: 'sw-markup', file: J, from: "return (obs.flags ?? []).length ? [{ rule: 'markup', got: obs.flags }] : []", to: 'return []' },
  { name: 'self-rewriting script not flagged', row: 'script-rewrite', file: O, from: "if (!text.startsWith(e.text)) flag('script-rewritten')", to: '' },
  { name: 'worker URL rule off', row: 'sw-custom-path', file: J, from: 'if (!listed.length) {', to: 'if (listed.length < 0) {' },
  { name: 'worker bytes rule off', row: 'sw-script-bytes', file: J, from: 'if (w.sha256 != null && !listed.some(', to: 'if (false && !listed.some(' },
  { name: 'cache rule off', row: 'sw-cache-extra', file: J, from: 'if (!ok) out.push(', to: 'if (false) out.push(' },
  { name: 'signature not checked', row: 'bad-signature', file: J, from: "const p = await verifySigned(raw, 'bento/home release list', jwk)", to: 'const p = JSON.parse(JSON.parse(raw).payload)' },
  { name: 'type not checked', row: 'wrong-type', file: J, from: "if (p.type !== SERVED_TYPE) return `type is not ${SERVED_TYPE}`", to: '' },
  { name: 'rollback accepted', row: 'rollback', file: J, from: "if (payload.serial < held.serial) return { status: 'rollback', serial: payload.serial }", to: '' },
  { name: 'serial reuse accepted', row: 'conflict', file: J, from: "return held.payload === env.payload ? { status: 'same' } : { status: 'conflict', serial: payload.serial }", to: "return { status: 'same' }" },
  { name: 'no refresh before warning', row: 'stale-held', file: W, from: "if (current && v.verdict !== 'ok' && v.verdict !== 'unlisted' && !refresh) {", to: 'if (false) {' },
  { name: 'only the newest release counts', row: 'rollback', file: J, from: 'const index = perRelease.findIndex((f) => f.length === 0)', to: 'const index = perRelease[0].length === 0 ? 0 : -1' },
  { name: 'older release announced at once', row: 'rollback', file: J, from: 'notify: now - newest > GRACE_MS', to: 'notify: true' },
  { name: 'older release never announced', row: 'outdated-late', file: J, from: 'notify: now - newest > GRACE_MS', to: 'notify: false' },
  { name: 'a mismatch is not announced', row: 'library-byte', file: W, from: "if (v?.verdict === 'mismatch') event.warned.push(", to: 'if (false) event.warned.push(' },
  { name: 'a bad list is not announced', row: 'bad-signature', file: W, from: "if (refresh?.status === 'invalid' || refresh?.status === 'conflict') {", to: 'if (false) {' },
  { name: 'the tripwire "fixes" the page (reloads it)', row: 'sw-cache-poisoned', file: W, from: "      warned.push('badge')", to: "      warned.push('badge'); await chrome.tabs.reload(tab.id)" },
  // security ruling #956, C1-C5, R1-R3
  { name: 'no early report (C1)', row: 'held-then-leave', file: O, from: "chrome.runtime.sendMessage({ op: 'tripwire.early', payload })", to: "chrome.runtime.sendMessage({ op: 'tripwire.none', payload })" },
  { name: 'unsettled early reports never judged (C1)', row: 'held-then-leave', file: W, from: 'for (const p of due) {', to: 'for (const p of []) {' },
  { name: 'a blob: document of the library origin not flagged (C1)', row: 'blob-escape', file: O, from: "if (!/^https?:$/.test(location.protocol)) { flag(", to: 'if (false) { flag(' },
  { name: 'unread bytes pass (C2)', row: 'no-store', file: J, from: "if (obs.role === 'library' && (!obs.viaWorker || obs.cspFrom === 'navigation') && !obs.bytes && !obs.crossSite) out.push", to: 'if (false) out.push' },
  { name: 'unread bytes waived under any worker, preload or not (#954 C2)', row: 'sw-preload-vary', file: J, from: "(!obs.viaWorker || obs.cspFrom === 'navigation') && !obs.bytes", to: '!obs.viaWorker && !obs.bytes' },
  { name: 'an unfinished parse passes (C2)', row: 'held-open-hostile', file: J, from: "if (obs.complete === false) out.push", to: 'if (false) out.push' },
  { name: 'size 0 passes (C2)', row: 'held-open-hostile', file: J, from: "if (!(obs.size > 0)) out.push", to: 'if (false) out.push' },
  { name: 'a script-free unlisted page is loud (C3)', row: 'unlisted-404', file: J, from: 'if (!obs.scripts?.length && !obs.flags?.length && !listedPath(list, origin, obs.url)) {', to: 'if (false) {' },
  { name: 'loud once per URL, not per origin (C3)', row: 'unlisted-spa', file: W, from: '`loud:${event.class}:${event.origin}`', to: '`loud:${event.class}:${event.url}`' },
  { name: 'the library judged in frames (C3)', row: 'framed', edits: [
    { file: M, from: '"http://127.0.0.1/*"\n      ],\n      "all_frames": false', to: '"http://127.0.0.1/*"\n      ],\n      "all_frames": true' },
    { file: O, from: 'if (!opaque && window !== window.top) return', to: '' },
    { file: W, from: "if (role === 'library' && sender.frameId !== 0) return null", to: '' }] },
  { name: 'storage writes not serialized (C4)', row: 'concurrent', file: W, from: 'const serial = (fn) => { const r = chain.then(fn, fn); chain = r.then(() => {}, () => {}); return r }', to: 'const serial = (fn) => fn()' },
  { name: 'no caps, no compact record (C4)', row: 'oversized', edits: [
    { file: O, from: 'const MAX_SCRIPTS = 64, MAX_FLAGS = 64, MAX_CACHE = 200, MAX_STR = 512', to: 'const MAX_SCRIPTS = 1e9, MAX_FLAGS = 1e9, MAX_CACHE = 1e9, MAX_STR = 1e9' },
    { file: W, from: 'const MAX_SCRIPTS = 64, MAX_FLAGS = 64, MAX_CACHE = 200, MAX_WORKERS = 16, MAX_STR = 512', to: 'const MAX_SCRIPTS = 1e9, MAX_FLAGS = 1e9, MAX_CACHE = 1e9, MAX_WORKERS = 16, MAX_STR = 1e9' },
    { file: W, from: '    } catch {\n      const { page, ...compact } = event', to: '    } catch (e) { throw e\n      const { page, ...compact } = event' }] },
  { name: 'the report page falls back to the last check (C4)', row: 'report-not-found', file: P, from: 'const ev = want ? (log.find((e) => e.id === want) ?? null) : (log[0] ?? null)', to: 'const ev = (want && log.find((e) => e.id === want)) || log[0] || null' },
  { name: 'shadow roots not flagged (C5)', row: 'shadow-root', edits: [
    { file: O, from: "if (name === 'template' && (el.hasAttribute('shadowrootmode') || el.hasAttribute('shadowroot'))) flag('shadow-root')", to: '' },
    { file: O, from: "    if (shadowOf(el)) flag('shadow-root')\n", to: '\n' },
    { file: O, from: "for (const el of recent) if (shadowOf(el)) flag('shadow-root')", to: '' },
    { file: O, from: "for (const el of [...document.querySelectorAll('*'), ...walked]) if (shadowOf(el)) { flag('shadow-root'); break }", to: '' }] },
  // security re-check, N2 and N3
  { name: 'about: senders judged by their URL (N2)', row: 'about-popup', file: W, from: "if (scheme === 'about:' || scheme === 'blob:') origin = sender.origin", to: '' },
  { name: 'only the live document checked for shadow roots (N3)', row: 'shadow-root-removed', file: O, from: "for (const el of [...document.querySelectorAll('*'), ...walked]) if (shadowOf(el))", to: "for (const el of document.querySelectorAll('*')) if (shadowOf(el))" },
  // N1: the element sequence, as it happens
  { name: 'an early parse off the listed sequence is clean (N1)', row: 'dsd-leave', file: J, from: "if (d.kind !== 'document' || !isPrefix(obs.elements, d.elements) ||", to: "if (d.kind !== 'document' ||" },
  { name: 'early reports carry no elements (N1)', row: 'dsd-leave', file: O, from: 'elements: elements.slice(elementsSent), elementsFrom: elementsSent', to: 'elements: [], elementsFrom: 0' },
  { name: 'no "visit started" report (N1)', row: 'visit-started', file: O, from: '  early()\n  // A visit that ends early', to: '  // A visit that ends early' },
  { name: 'a shadow root not flagged as the parse goes on (N1)', row: 'dsd-leave-prefix', edits: [
    { file: O, from: "if (name === 'template' && (el.hasAttribute('shadowrootmode') || el.hasAttribute('shadowroot'))) flag('shadow-root')", to: '' },
    { file: O, from: "    if (shadowOf(el)) flag('shadow-root')\n", to: '\n' },
    { file: O, from: "for (const el of recent) if (shadowOf(el)) flag('shadow-root')", to: '' }] },
  { name: 'the full report\'s sequence not judged (N1)', row: 'sw-element', file: J, from: 'if (Array.isArray(obs.elements) && !sameList(obs.elements, e.elements)) f.push', to: 'if (false) f.push' },
  // N4: visits cut short, and warnings by class
  { name: 'nothing is ever cut short (N4)', row: 'held-open', file: O, from: 'const aborted = left || !complete || (nav ? nav.responseEnd === 0 : false)', to: 'const aborted = false' },
  { name: 'a clean visit cut short is loud (N4)', row: 'held-open', file: J, from: 'if (obs.aborted && !headerFailures(obs).length && cleanPrefix(obs, list, origin, partialOk)) return', to: 'if (false) return' },
  { name: 'a script cut short is never clean (N4)', row: 'cut-mid-script', file: W, from: 'if (t != null && p.text.length < t.length && t.startsWith(p.text)) ok.add(h)', to: 'if (false) ok.add(h)' },
  { name: 'one loud warning per origin, whatever the class (N4)', row: 'class-keys', file: W, from: '`loud:${event.class}:${event.origin}`', to: '`loud:${event.origin}`' },
  // a navigation another site started
  { name: 'a cross-site navigation must have readable bytes', row: 'cross-site-link', file: J, from: '&& !obs.crossSite) out.push({ rule: \'bytes-unread\' })', to: ') out.push({ rule: \'bytes-unread\' })' },
  { name: 'a cross-site navigation judged on stale cached bytes', row: 'cross-site-link', file: W, from: "role === 'library' && !crossSite && HEX.test(obs.bytes?.sha256 ?? '')", to: "role === 'library' && HEX.test(obs.bytes?.sha256 ?? '')" },
  { name: 'Cache-Control not pinned', row: 'cross-site-no-store', file: J, from: 'if (obs.cacheControl != null && e.cacheControl !== undefined && join(obs.cacheControl) !== e.cacheControl) f.push', to: 'if (false) f.push' },
  // the cross-site limit, after the element sequence: an added element is still caught
  { name: 'the full report\'s sequence not judged, cross-site (N1)', row: 'xsite-markup', file: J, from: 'if (Array.isArray(obs.elements) && !sameList(obs.elements, e.elements)) f.push', to: 'if (false) f.push' },
  // R4: a Refresh response header
  { name: 'a Refresh header passes (R4)', row: 'refresh-header', file: J, from: "const out = (obs.refresh ?? []).length ? [{ rule: 'refresh-header', got: obs.refresh }] : []", to: 'const out = []' },
  { name: 'the Refresh header is not recorded (R4)', row: 'refresh-header', file: W, from: ".filter((h) => h.name.toLowerCase() === 'refresh')", to: '.filter(() => false)' },
  { name: 'the first early report does not read the Refresh header (R4)', row: 'refresh-header-now', file: W, from: 'if (matches(h, cut(noHash(sender.url)), Number(obs.timeOrigin) || 0) && Array.isArray(h.refresh) && h.refresh.length) refresh = h.refresh', to: '' },
  { name: 'a withdrawn release is quiet (R1)', row: 'withdrawn', file: J, from: 'if (list.releases[index].withdrawn) return', to: 'if (false) return' },
  { name: 'a list carrying app is taken (R2)', row: 'carries-app', file: J, from: "if ('app' in p) return", to: 'if (false) return' },
  { name: 'never checked is never said (R3)', row: 'never-checked', file: W, from: 'if (now - since > NEVER_MS) event.warned.push(', to: 'if (false) event.warned.push(' },
  // stage 3: the build's own worker in control (security ruling #954 C1, C2)
  { name: 'navigation headers ignored, worker in control', row: 'stage3-honest', file: W, from: 'const fresh = matches(h, url, obs.timeOrigin)', to: 'const fresh = false' },
  { name: 'the worker without navigation preload (C1): positive control', row: 'stage3-honest', build: NO_PRELOAD },
  { name: 'csp rule off, worker in control', row: 'stage3-csp', file: J, from: "if (obs.csp != null && join(obs.csp) !== (e.csp ?? ''))", to: 'if (false)' },
  { name: 'the worker without navigation preload (C1): CSP + no-store', row: 'stage3-csp-nostore', build: NO_PRELOAD },
  { name: 'Cache-Control, csp and unread-bytes rules all off, worker in control', row: 'stage3-csp-nostore', edits: [
    { file: J, from: 'if (obs.cacheControl != null && e.cacheControl !== undefined && join(obs.cacheControl) !== e.cacheControl) f.push', to: 'if (false) f.push' },
    { file: J, from: "if (obs.csp != null && join(obs.csp) !== (e.csp ?? ''))", to: 'if (false)' },
    { file: J, from: "if (obs.role === 'library' && (!obs.viaWorker || obs.cspFrom === 'navigation') && !obs.bytes && !obs.crossSite) out.push", to: 'if (false) out.push' }] },
  { name: 'unread bytes waived under any worker (C2), worker in control', row: 'stage3-vary-text', file: J, from: "(!obs.viaWorker || obs.cspFrom === 'navigation') && !obs.bytes", to: '!obs.viaWorker && !obs.bytes' },
  { name: 'the worker without navigation preload (C1): text + no-store', row: 'stage3-nostore-text', build: NO_PRELOAD },
  { name: 'bytes rule off, worker in control', row: 'stage3-text', file: J, from: 'if (obs.bytes && obs.bytes.sha256 !== e.sha256)', to: 'if (false)' },
  { name: 'the worker without navigation preload (C1): cross-site + no-store', row: 'stage3-cross-site-no-store', build: NO_PRELOAD },
  // C5: the library worker's own requests (security ruling #954, F-W)
  { name: 'the library worker\'s requests not watched (C5)', row: 'sw-cloak', file: W, from: "  chrome.webRequest?.onSendHeaders.addListener(onWorkerRequest, { urls: [`${LIBRARY_ORIGIN}/*`], tabId: -1 }, ['requestHeaders', 'extraHeaders'])\n", to: '' },
  { name: 'the worker script may be fetched by the worker itself (C5)', row: 'sw-cloak-launder', file: J, from: "if (list.releases.some((r) => (r.workers ?? []).includes(p)) && !browserScript) why(", to: 'if (false) why(' },
  { name: 'a query allowed (C5)', row: 'worker-query', file: J, from: "if (String(req.url).split('#')[0].includes('?')) why('a query')", to: '' },
  { name: 'any path allowed (C5)', row: 'worker-unlisted-path', file: J, from: "if (!list.releases.some((r) => r.origins[origin]?.files[p] !== undefined)) why('a path no release serves')", to: '' },
  { name: 'any method allowed (C5)', row: 'worker-post', file: J, from: "if (req.method !== 'GET') why('not GET')", to: '' },
  { name: 'the extension\'s own requests taken for the worker\'s (C5)', row: 'c5-honest-worker', file: W, from: 'if (d.initiator != null && d.initiator !== LIBRARY_ORIGIN) return null', to: '' },
  { name: 'page requests taken for the worker\'s (C5)', row: 'c5-honest-worker', edits: [
    { file: W, from: '  if (d?.tabId !== -1) return null\n', to: '' },
    { file: W, from: "{ urls: [`${LIBRARY_ORIGIN}/*`], tabId: -1 }", to: "{ urls: [`${LIBRARY_ORIGIN}/*`] }" }] },
  // the worker's request headers and the navigation preload value (security ruling on #983, M1)
  { name: 'worker request headers not held (C5)', row: 'worker-header', file: J, from: '  for (const w of requestHeaderProblems(req.headers, ctx.nav, ownReferer)) why(w)\n', to: '' },
  { name: 'header values not held (C5)', row: 'worker-header-held', edits: [
    { file: J, from: "if (!HELD_REQUEST.get(n).includes(v)) out.push(", to: 'if (false) out.push(' },
    { file: J, from: "      else if (v !== want) out.push(", to: '      else if (false) out.push(' }] },
  { name: 'the preload header value not judged (C5)', row: 'preload-header', file: J, from: "  if (obs.preload != null && obs.preload !== 'true') out.push", to: '  if (false) out.push' },
  { name: 'browser-filled header values read from top-level navigations only (C5)', row: 'framed', file: W, from: "addListener(onRequest, { urls: patterns(), types: ['main_frame', 'sub_frame'] }", to: "addListener(onRequest, { urls: patterns(), types: ['main_frame'] }" },
  // Cookie and Referer: forbidden names whose values a worker chooses (security's second review of #983, M4)
  { name: 'Cookie and Referer exempt as the browser\'s (C5)', row: 'worker-cookie', file: J, from: '    if (ABSENT_REQUEST.has(n)) { out.push(`a header the honest worker does not send: ${n}`); continue }', to: '    if (ABSENT_REQUEST.has(n)) continue' },
  { name: 'Referer exempt as the browser\'s (C5)', row: 'worker-referer', file: J, from: '    if (ABSENT_REQUEST.has(n)) { out.push(', to: "    if (n === 'referer') continue\n    if (ABSENT_REQUEST.has(n)) { out.push(" },
  { name: 'the navigation\'s Cookie not recorded (C5)', row: 'worker-cookie', file: W, from: "  const cookie = hv('cookie') != null", to: '  const cookie = false' },
  { name: 'the browser\'s update-check Referer not allowed (C5)', row: 'c5-honest-soft-update', file: J, from: "    if (n === 'referer' && ownReferer != null && v === ownReferer) continue\n", to: '' },
  { name: 'the preload header value not recorded (C5)', row: 'preload-header', file: W, from: 'preload: preload == null ? null : cut(preload), cookie },', to: 'preload: null, cookie },' },
  // a library page's own requests: the browser's manifest fetch of a rewritten href (security's third review of #983, M6)
  { name: 'a library page\'s own requests not watched (M6)', row: 'page-manifest-query', file: W, from: "  chrome.webRequest?.onSendHeaders.addListener(onPageRequest, { urls: [`${LIBRARY_ORIGIN}/*`] }, ['requestHeaders', 'extraHeaders'])\n", to: '' },
  { name: 'a query allowed on a page\'s request (M6)', row: 'page-manifest-query', file: J, from: "if (!own && String(req.url).split('#')[0].includes('?')) why('a query')", to: '' },
  { name: 'a page\'s requests never routed to the judge (M6)', row: 'page-manifest-query', file: W, from: "  if (typeof d?.tabId !== 'number' || d.tabId < 0) return null\n", to: '  return null\n' },
  { name: 'a page\'s requests held to the documents\' paths (M6, the honest control)', row: 'c5-honest-manifest', file: J, from: "if (!own && !browserIcon && !list.releases.some((r) => r.origins[origin]?.files[p] !== undefined)) why(", to: "if (!own && !browserIcon && !list.releases.some((r) => r.origins[origin]?.files[p]?.kind === 'document')) why(" },
  { name: 'the browser\'s default icon fetch and the page\'s own Referer not excused (M6, a host\'s 404)', row: 'unlisted-404', edits: [
    { file: J, from: 'const browserIcon = p === BROWSER_ICON', to: 'const browserIcon = false' },
    { file: J, from: "      if (n === 'referer' && ownReferer(String(x?.value ?? ''))) continue\n", to: '' }] },
  { name: 'the tab\'s own URL not excused (M6)', row: 'c5-honest-own-url', file: J, from: "const own = typeof ctx.ownUrl === 'string' && String(req.url).split('#')[0] === ctx.ownUrl", to: 'const own = false' },
  // /index.html answered as '/' (security ruling on #964, M1): without it an honest visit reads "unverified"
  // Not registered: the build mutant that drops sw.ts's /index.html line. MEASURED red on macOS Chromium 149
  // (stage3-index: 3 and 2 of 8 honest visits warned without the line, 0 of 8 with it), but CI's Linux
  // Chromium did not reproduce the false warning (8 of 8 quiet without the line), so in CI it would be a
  // survivor that proves nothing either way. Run it by hand with
  //   TW_ROWS=stage3-index TW_BUILD_MUTANT='{"file":"sw.ts","from":"  if (url.pathname === \'/index.html\') url.pathname = \'/\'\n","to":""}'
  { name: 'unread bytes waived under any worker (C2), at /index.html', row: 'stage3-vary-text-index', file: J, from: "(!obs.viaWorker || obs.cspFrom === 'navigation') && !obs.bytes", to: '!obs.viaWorker && !obs.bytes' },
  { name: 'bytes rule off, at /index.html', row: 'stage3-text-index', file: J, from: 'if (obs.bytes && obs.bytes.sha256 !== e.sha256)', to: 'if (false)' },
]

// A run that never reached the browser (a local port taken between freePorts and listen) is
// run again, at most twice: it judged nothing, so it is neither red nor green.
const run1 = (env) => spawnSync(process.execPath, [RIG], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 600000 })
const started = (r) => /^extension \S+ v/m.test(r.stdout)
const run = (env) => { let r = run1(env); for (let i = 0; i < 2 && !started(r); i++) { console.log('  note  the rig did not start (retrying): ' + (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 160)); r = run1(env) } return r }
const rows = [...new Set(MUTANTS.map((m) => m.row))]
console.log(`control: rows ${rows.join(', ')} unmutated`)
const control = run({ TW_ROWS: rows.join(',') })
if (control.status !== 0) {
  console.log(control.stdout.split('\n').filter((l) => /FAIL|checks passed/.test(l)).join('\n'))
  console.error('FAIL: the rows are red without a mutant, so no mutant result means anything')
  process.exit(1)
}
console.log(`  ok    ${control.stdout.trim().split('\n').at(-1)}`)
let failures = 0, ran = 0
const PICK = process.env.TW_ONLY_MUTANT // a substring of a mutant's name, to re-run one
for (const m of MUTANTS.filter((x) => !PICK || x.name.includes(PICK))) {
  ran++
  const r = run(m.build ? { TW_ROWS: m.row, TW_BUILD_MUTANT: JSON.stringify(m.build) } : { TW_ROWS: m.row, TW_MUTANT: JSON.stringify(m.edits ?? { file: m.file, from: m.from, to: m.to }) })
  const applied = /mutant applied to/.test(r.stdout)
  const red = r.status === 1 && /FAIL/.test(r.stdout)
  const okay = applied && red
  if (!okay) failures++
  const fail = r.stdout.split('\n').find((l) => /FAIL/.test(l))?.trim() ?? ''
  console.log(`  ${okay ? 'ok  ' : 'FAIL'}  ${m.name} → row ${m.row} ${!applied ? 'NOT APPLIED' : red ? 'red' : 'GREEN'}${fail ? `: ${fail.slice(5, 120)}` : ''}`)
  // a run that is neither red nor clean says why (a crash or a timeout is not a pass, and not a red row either)
  if (!okay) console.log(`        exit ${r.status} ${r.signal ?? ''} ${r.error?.message ?? ''} | ${(r.stdout + r.stderr).trim().split('\n').slice(-4).join(' | ').slice(0, 400)}`)
}
console.log(`\n${ran - failures}/${ran} mutants red on their row`)
process.exit(failures ? 1 : 0)
