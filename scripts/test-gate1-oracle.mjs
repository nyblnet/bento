// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE BROWSER ORACLE for gate 1 (security, after #825's two findings). A
// differential fuzz between the reference and a port can't see a bug they
// SHARE, and both the "/" separator and the length-changing case fold were
// shared. A browser is the ground truth for "what runs", so this asks it.
//
// Take a genuine file, mutate it the ways scanners disagree:
//   - candidate scripts in disguise: "/", quotes, case, duplicates, NUL, "=",
//     entities, src=, form feed;
//   - a run of length-changing characters before a <style> before a script;
//   - the genuine loader's text behind a src=;
//   - edits to the real blocks' tags;
//   - length-changing characters (İ ß ﬃ Σ);
//   - wrappers (comments, <style>, <textarea>, <title>).
// For every mutant gate1 calls GENUINE, load it in the browser with NO CSP and
// record what ran: the loader and remover push to a log, every candidate pushes
// its own name, and any data block that executes throws (its text isn't
// JavaScript), which a window error counter sees. A genuine verdict is only
// right if exactly the loader and the remover ran. Anything else is a failing
// row, written to home/fixtures/gate1/oracle-failures/ for every port to run.
//
//   node scripts/test-gate1-oracle.mjs [--seed N] [--cases N] [--random N]
//
// CI runs a fixed seed, plus a short run from a random seed (printed, so a
// failure can be replayed).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { verifyServed } from '../kernel/src/gate1.ts'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d }
const FIXED_SEED = opt('seed', 20261021), CASES = opt('cases', 400), RANDOM = opt('random', 100)
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'home/fixtures/gate1/oracle-failures')

// --- a synthetic release whose loader and remover REPORT that they ran --------------
const S = 'scr' + 'ipt'
const LOADER = "window.__ran.push('loader')"
const REMOVER = "window.__ran.push('remover');(function(){var a=document.querySelectorAll('[data-bento-preview]');for(var i=0;i<a.length;i++)a[i].remove()})()"
const hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const csp = (s) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`
const genuine = (o = {}) => '<!DOCTYPE html>\n<html lang="en"><head>\n<meta charset="UTF-8">\n' +
  `<title>${o.title ?? 'A deck'}</title>\n<style>body{margin:0}</style>\n` +
  `<${S} type="application/bento+json" id="bento-doc">${o.doc ?? '{"format":"bento/test","title":"A deck"}'}</${S}>\n` +
  `<${S} type="bento/deflate-b86" id="bento-rt-css" data-len="4">CSS1</${S}>\n` +
  `<${S} type="bento/deflate-b86" id="bento-rt" data-len="3">RT1</${S}>\n` +
  `</head><body>\n<div data-bento-preview="1">${o.preview ?? '<p>Page one</p>'}</div><${S} data-bento-preview="1">${REMOVER}</${S}>\n` +
  `<${S}>${LOADER}</${S}>\n</body></html>\n`
const history = {
  app: 'bento-oracle', v: 1,
  releases: [{ version: '1.0.0', sha256: hex(genuine()), at: '2026-10-21T00:00:00.000Z',
    pins: { v: 1, blocks: { 'bento-rt': hex('RT1'), 'bento-rt-css': hex('CSS1'), loader: hex(LOADER), remover: hex(REMOVER) }, scriptSrc: [csp(LOADER), csp(REMOVER)] } }],
}

// --- the mutation operators -------------------------------------------------------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function mutant(r, n) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)]
  const sep = () => pick([' ', ' ', '\t', '\n', '\f', '/', ' /', '/ ', '\r'])
  const q = (v) => pick([`"${v}"`, `'${v}'`, v.includes(' ') ? `"${v}"` : v])
  const typeName = () => pick(['type', 'type', 'TYPE', 'Type', 'ty\u0000pe', '=type', 'typ', 'type '])
  const dataType = () => pick(['application/bento+json', 'bento/deflate-b86', 'bento/deflate-b64', 'application/bento+lang'])
  const runType = () => pick(['', 'text/javascript', 'module', 'Module', 'text/JavaScript', 'application/ecmascript', '&#x6d;odule', 'text/x-unknown', 'application/bento+JSON'])
  const typeAttr = (v) => `${typeName()}=${q(v)}`
  const name = `x${n}`
  const body = `window.__ran.push('${name}')`
  // a candidate script: zero to three type attributes in some order, maybe src
  const attrs = []
  const k = Math.floor(r() * 4)
  for (let i = 0; i < k; i++) attrs.push(typeAttr(r() < 0.5 ? dataType() : runType()))
  if (r() < 0.12) attrs.push(`src=${q('data:text/javascript,' + encodeURIComponent(body))}`)
  if (r() < 0.25) attrs.push(`id=${q(pick(['bento-rt', 'bento-doc', 'bento-rt-css']))}`)
  if (r() < 0.1) attrs.push('data-bento-preview="1"')
  const tagName = pick(['script', 'script', 'SCRIPT', 'Script'])
  const candidate = `<${tagName}${attrs.map((a) => sep() + a).join('')}${pick(['', '', ' ', '/'])}>${body}</${pick(['script', 'SCRIPT', 'script '])}>`
  const wrapped = pick([candidate, candidate, candidate, `<!-- ${candidate} -->`, `<textarea>${candidate}</textarea>`, `<title>${candidate}</title>`, `<style>/*${candidate}*/</style>`, `<template>${candidate}</template>`])
  const len = () => pick(['İ', 'ß', 'ﬃ', 'Σ', 'ı', 'İİİİİİİİİİ', 'İ'.repeat(40)])
  let h = genuine({
    title: r() < 0.4 ? `A ${len()} deck` : undefined,
    doc: r() < 0.4 ? `{"format":"bento/test","title":"${len()}${len()}"}` : undefined,
    preview: r() < 0.3 ? `<p>${len()}</p>` : undefined,
  })
  // where to put it
  const spots = ['</head>', '</body>', `<${S}>${LOADER}`, '<div data-bento-preview', '<style>', '</title>']
  const at = pick(spots)
  if (r() < 0.75) h = h.replace(at, at.startsWith('</') ? wrapped + at : wrapped + at)
  // a run of length-changing characters, then a <style>, then the candidate: a
  // case fold that changes length lands the style's close late and skips it
  if (r() < 0.2) h = h.replace('</body>', `<p>${len()}${len()}</p><style>a{}</style>${candidate}</body>`)
  // tags glued together: a name runs to whitespace, "/" or ">", so "<meta<style>"
  // is one tag and what follows is real (home-ios found this with a WebKit oracle)
  if (r() < 0.2) {
    const glue = pick([`<${pick(['meta', 'p', 'div', 'a', 'span'])}<style>${candidate}</style>`, `<${pick(['p', 'div', 'b'])}${candidate}`,
      `<a<!--${candidate}-->`, `<!-->${candidate}`, `<!--->${candidate}`])
    h = h.replace(pick(['</head>', '</body>', '<meta charset="UTF-8">']), (m) => m === '<meta charset="UTF-8">' ? glue + ' ' + m : glue + m)
  }
  // quoted attributes in END tags: the tokenizer reads them, so a ">" inside the
  // quotes doesn't end the tag, and what a first-">" skip reads as a tag is text
  if (r() < 0.15) {
    const t = pick(['p', 'div', 'span', 'b'])
    const shut = pick([`</${t} a="><b c='">'${candidate}'>`, `</${t} x='><i y="'>"${candidate}">`, `</${t}${sep()}a=${q('>')}>${candidate}`])
    h = h.replace(pick(['</body>', '</head>']), (m) => shut + m)
  }
  // the loader's own text behind a src=: the browser runs the src and ignores it
  if (r() < 0.1) h = h.replace(`<${S}>${LOADER}`, `<${S}${sep()}src=${q('data:text/javascript,' + encodeURIComponent(body))}>${LOADER}`)
  // or edit a real block's tag the ways scanners split
  if (r() < 0.35) {
    const real = pick([`<${S} type="application/bento+json" id="bento-doc">`, `<${S} type="bento/deflate-b86" id="bento-rt"`, `<${S} type="bento/deflate-b86" id="bento-rt-css"`, `<${S}>${LOADER}`])
    const edit = pick([
      (t) => t.replace(`<${S} `, `<${S}/`),
      (t) => t.replace(`<${S} `, `<${S} type="text/javascript"${sep()}`),
      (t) => t.replace(`<${S} `, `<${S}${sep()}`),
      (t) => t.replace(`<${S}`, `<SCRIPT`),
      (t) => t.replace('type=', 'TYPE='),
    ])
    h = h.replace(real, edit(real))
  }
  return { html: h, name }
}

// --- the browsers -----------------------------------------------------------------
// BOTH engines: a Chromium-only oracle missed the glued-tag bypass that a WebKit
// oracle found (home-ios). ORACLE_ENGINES=chromium,webkit (the default) or one.
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const engines = (process.env.ORACLE_ENGINES || 'chromium,webkit').split(',').map((e) => e.trim()).filter(Boolean)
const browsers = []
for (const e of engines) browsers.push({ engine: e, b: await pw[e].launch(e === 'chromium' ? { executablePath: process.env.CHROME_PATH, headless: true } : { headless: true }) })
let browser = browsers[0].b
const URL_ = 'https://bento-oracle.test/doc.html'
async function whatRan(html) {
  const context = await browser.newContext()
  await context.route('**/*', (route) => route.request().url() === URL_
    ? route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html })
    : route.abort())
  await context.addInitScript(() => {
    window.__ran = []; window.__errors = 0
    addEventListener('error', () => { window.__errors++ }, true)
  })
  const page = await context.newPage()
  try {
    await page.goto(URL_, { waitUntil: 'load', timeout: 15000 })
    await page.waitForTimeout(150)
    return await page.evaluate(() => ({ ran: [...window.__ran], errors: window.__errors }))
  } finally { await context.close() }
}

let failures = 0, checks = 0
const ok = (cond, what) => { checks++; if (cond) console.log('  ok    ' + what); else { failures++; console.log('  FAIL  ' + what) } }
/** What ran in EVERY engine; a mutant is clean only if it's clean in all of them. */
async function whatRanEverywhere(html) {
  const out = []
  for (const { engine, b } of browsers) { browser = b; out.push({ engine, ...(await whatRan(html)) }) }
  return out
}
const onlyPinned = (r) => r.errors === 0 && r.ran.length === 2 && r.ran.includes('loader') && r.ran.includes('remover')

try {
  console.log(`\ncontrols, in each engine (${engines.join(', ')}): the oracle can see both kinds of extra execution`)
  for (const r of await whatRanEverywhere(genuine())) ok(onlyPinned(r), `${r.engine}: a genuine file runs exactly the loader and the remover (${JSON.stringify(r.ran)}, ${r.errors} errors)`)
  for (const r of await whatRanEverywhere(genuine().replace('</body>', `<${S}>window.__ran.push('extra')</${S}></body>`))) ok(r.ran.includes('extra'), `${r.engine}: an extra script is SEEN running`)
  for (const r of await whatRanEverywhere(genuine().replace('type="bento/deflate-b86" id="bento-rt"', 'id="bento-rt"'))) ok(r.errors > 0, `${r.engine}: a data block that executes is SEEN (its text throws)`)
  ok((await verifyServed(genuine(), history)).verdict === 'genuine', 'gate1 calls the genuine file genuine')

  const runs = [[FIXED_SEED, CASES, 'fixed seed'], [Math.floor(Math.random() * 2 ** 31), RANDOM, 'random seed']]
  for (const [seed, cases, label] of runs) {
    console.log(`\n${label} ${seed}: ${cases} mutants`)
    const r = rng(seed)
    let genuineCount = 0, bad = 0
    for (let n = 0; n < cases; n++) {
      const { html } = mutant(r, n)
      const v = await verifyServed(html, history)
      if (v.verdict !== 'genuine') continue
      genuineCount++
      const dirty = (await whatRanEverywhere(html)).filter((r) => !onlyPinned(r))
      if (dirty.length) {
        bad++
        mkdirSync(OUT, { recursive: true })
        // each failure is UNKNOWN against THIS history: written beside it, so a
        // port can run the folder with nothing else
        writeFileSync(join(OUT, 'history.json'), JSON.stringify(history, null, 2) + '\n')
        const file = join(OUT, `seed-${seed}-case-${n}.html`)
        writeFileSync(file, html)
        console.log(`  FAIL  case ${n}: gate1 says GENUINE but ${dirty.map((r) => `${r.engine} ran ${JSON.stringify(r.ran)} (${r.errors} errors)`).join('; ')} → ${file}`)
      }
    }
    ok(bad === 0, `${label}: every one of the ${genuineCount} GENUINE verdicts ran only the loader and remover (${cases - genuineCount} unknown)`)
  }
} finally {
  for (const { b } of browsers) await b.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
