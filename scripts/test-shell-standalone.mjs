#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * A shell may point to bento.page, never depend on it (single-file invariant
 * S.5, test T5). Every app's built shell, plus the frozen 1.2.10 release:
 *
 *  1. every bento.page host in the file, INCLUDING inside the compressed
 *     runtime, is on an allow-list: the release channel, the relay, the
 *     directory, or a hint link (help, agents.md, schema, convert). A new
 *     host or path (a library address, a frame site) fails until it is
 *     reviewed here;
 *  2. no navigation sink (location assign/replace/href, window.open, a meta
 *     refresh, <base>) takes a bento.page address that is not a hint, and no
 *     code tests the page's hostname against bento.page;
 *  3. opened from file:// with every network request refused and sockets
 *     closed, the app boots (its document or its password gate).
 *
 * Positive controls, run on a copy of a shell: an address planted INSIDE the
 * compressed runtime is found (the scan reaches the payload); a planted
 * redirect to a library address and a planted hostname test both fail.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-shell-standalone.mjs [shell.html…]
 * With no arguments: <app>/dist-single/*.bento.html for every app built, and
 * home/fixtures/gate1/real/slides-1.2.10. CI builds all four apps first.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { scanBlocks } = await import(path.join(ROOT, 'kernel/src/gate1.ts'))
const b86 = await import(path.join(ROOT, 'scripts/lib/b86.mjs'))

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

const APPS = ['slides', 'spaces', 'dash', 'type']
const shells = process.argv.slice(2).length ? process.argv.slice(2) : [
  ...APPS.flatMap((a) => { const d = path.join(ROOT, a, 'dist-single'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.bento.html')).map((f) => path.join(d, f)) : [] }),
  path.join(ROOT, 'home/fixtures/gate1/real/slides-1.2.10/Bento_Slides.bento.html'),
]
if (process.env.CI && shells.length < APPS.length + 1) {
  console.log(`  FAIL  CI must build every app's shell first (found ${shells.length - 1} of ${APPS.length})`)
  process.exit(1)
}

/** The file's plaintext plus every compressed payload, inflated. */
function readAll(html) {
  let all = html
  for (const b of scanBlocks(html)) {
    if (b.type !== 'bento/deflate-b86' && b.type !== 'bento/deflate-b64') continue
    const bytes = b.type.endsWith('b86') ? Buffer.from(b86.decode(b.text.trim())) : Buffer.from(b.text.trim(), 'base64')
    all += '\n' + zlib.inflateRawSync(bytes).toString('utf8')
  }
  return all
}

// what a shell may name, with why
const ALLOWED = [
  [/^bento\.page$/, 'the name in notices, the About dialog and hint copy'],
  [/^bento\.page\/releases\/(slides|spaces|dash|type)(\/(manifest|history)\.json)?$/, 'the signed release channel'],
  [/^sync\.bento\.page$/, 'the relay'],
  [/^(signin\.)?id\.bento\.page(\/l)?$/, 'the bento/id directory, its sign-in origin and its link page'],
  [/^bento\.page\/(help|agents\.md|llms\.txt|convert|import|slides|spaces|dash|type|schema\/[a-z]+\.json)$/, 'a hint link the person follows'],
]
const HINT = /^bento\.page(\/(help|agents\.md|llms\.txt|convert|import|slides|spaces|dash|type|schema\/[a-z]+\.json))?$/
/** Every bento.page address, cut at the first character an address cannot hold. */
const hosts = (text) => [...text.matchAll(/[a-z0-9.-]*bento\.page[a-zA-Z0-9._~/%-]*/gi)].map((m) => m[0].toLowerCase().replace(/^[.-]+|[./-]+$/g, ''))

function check(name, html) {
  const all = readAll(html)
  const found = [...new Set(hosts(all))]
  const stray = found.filter((h) => !ALLOWED.some(([re]) => re.test(h)))
  const sinks = []
  for (const re of [/\blocation\s*\.\s*(href\s*=|assign\s*\(|replace\s*\()/g, /\blocation\s*=[^=]/g, /\bwindow\.open\s*\(/g]) {
    for (const m of all.matchAll(re)) {
      const arg = all.slice(m.index, m.index + 220).split(/[;\n]/)[0]
      for (const h of hosts(arg)) if (!HINT.test(h)) sinks.push(`${m[0].trim()} → ${h}`)
    }
  }
  const plain = scanBlocks(html).reduce((s, b) => s.slice(0, b.start) + ' '.repeat(b.text.length) + s.slice(b.start + b.text.length), html)
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(plain)) sinks.push('a meta refresh')
  if (/<base[\s>]/i.test(plain)) sinks.push('a <base>')
  const hostTests = [...all.matchAll(/\b(hostname|host|origin)\b[^;\n]{0,60}bento\.page/g)].map((m) => m[0].slice(0, 80))
  return { found, stray, sinks, hostTests }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-standalone-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

console.log('=== 1-2. addresses and navigation, inside the payloads too')
for (const f of shells) {
  const name = path.relative(ROOT, f)
  const r = check(name, fs.readFileSync(f, 'utf8'))
  ok(r.stray.length === 0, `${name}: every bento.page address is allowed (${r.found.length} distinct${r.stray.length ? '; NOT: ' + r.stray.join(', ') : ''})`)
  ok(r.sinks.length === 0, `${name}: no navigation sink takes a bento.page address${r.sinks.length ? ': ' + r.sinks.slice(0, 3).join('; ') : ''}`)
  ok(r.hostTests.length === 0, `${name}: no code tests the page's host against bento.page${r.hostTests.length ? ': ' + r.hostTests[0] : ''}`)
}

// positive controls on a copy of the first shell: plant inside the runtime payload
console.log('\n=== positive controls (planted in a copy)')
const base = fs.readFileSync(shells[0], 'utf8')
function plant(code) {
  const rt = scanBlocks(base).find((b) => b.id === 'bento-rt')
  const isB86 = rt.type === 'bento/deflate-b86'
  const js = zlib.inflateRawSync(isB86 ? Buffer.from(b86.decode(rt.text.trim())) : Buffer.from(rt.text.trim(), 'base64')).toString('utf8')
  const packed = zlib.deflateRawSync(Buffer.from(js + '\n' + code))
  const text = isB86 ? b86.encode(packed) : packed.toString('base64')
  return base.slice(0, rt.start) + text + base.slice(rt.start + rt.text.length)
}
{
  const r = check('planted', plant(`const LIBRARY = 'https://open.bento.page/x'`))
  ok(r.stray.includes('open.bento.page/x'), 'an address planted inside the compressed runtime is found')
}
{
  const r = check('planted', plant(`if (location.protocol === 'file:') location.href = 'https://home.bento.page/open'`))
  ok(r.stray.length > 0 && r.sinks.length > 0, 'a planted file:// redirect to a library address fails the scan')
}
{
  const r = check('planted', plant(`const live = location.hostname.endsWith('bento.page')`))
  ok(r.hostTests.length > 0, 'a planted hostname test against bento.page fails the scan')
}

// 3. every shell boots from file:// with the network gone
console.log('\n=== 3. opened from file:// with no network')
let pw = null
try { pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright') } catch {}
if (!pw) {
  ok(false, 'Playwright is needed for the boot rows (set PLAYWRIGHT_MODULE)')
} else {
  const browser = await pw[process.env.BENTO_BROWSER || 'chromium'].launch()
  for (const f of shells) {
    const ctx = await browser.newContext()
    const tried = []
    await ctx.route((u) => !u.href.startsWith('file:') && !u.href.startsWith('blob:') && !u.href.startsWith('data:'), (r) => { tried.push(r.request().url()); r.abort() })
    await ctx.routeWebSocket(/.*/, (ws) => { tried.push(ws.url()); ws.close() })
    const page = await ctx.newPage()
    const copy = path.join(work, path.basename(f))
    fs.copyFileSync(f, copy)
    await page.goto('file://' + copy)
    const up = await page.waitForFunction(() => !!(window.bento && (window.bento.doc || window.bento.locked)), null, { timeout: 30000 }).then(() => true, () => false)
    const hosts = [...new Set(tried.map((u) => { try { return new URL(u).host } catch { return u } }))]
    ok(up, `${path.relative(ROOT, f)}: boots with every request refused${hosts.length ? ` (it tried ${hosts.join(', ')})` : ''}`)
    await ctx.close()
  }
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
