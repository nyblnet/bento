#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The signed release history (K4, security §36): append-only, anti-rollback,
// and a file matches a release only if ONE entry matches EVERY block.
//
//   node scripts/test-release-history.ts
//
// Synthetic shells and saved files (tiny, deterministic) stand in for real
// releases, so this runs in CI without a browser. sign-history.mjs is driven
// end to end with a throwaway TEST key, never the release key.

import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePins } from './lib/release-pins.mjs'
import { nextHistory, acceptHistory, matchRelease, historyProblems } from './lib/release-history.mjs'
import { verifyEnvelope } from './sign-payload.mjs'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const throws = (f: () => unknown, re?: RegExp) => { try { f(); return false } catch (e) { return !re || re.test((e as Error).message) } }

const S = 'scr' + 'ipt'
const html = (o: { rt?: string; css?: string; loader?: string; remover?: string | null; extra?: string }) =>
  `<!DOCTYPE html><html><head><${S} type="application/bento+json" id="bento-doc">{}</${S}>` +
  `<${S} type="bento/deflate-b86" id="bento-rt-css">${o.css ?? 'CSS1'}</${S}>` +
  `<${S} type="bento/deflate-b86" id="bento-rt">${o.rt ?? 'RT1'}</${S}>` +
  `<${S}>${o.loader ?? 'load1()'}</${S}>${o.extra ?? ''}</head><body>` +
  (o.remover === null ? '' : `<div data-bento-preview="1">p</div><${S} data-bento-preview="1">${o.remover ?? 'rm()'}</${S}>`) +
  '</body></html>'
const release = (version: string, o: Parameters<typeof html>[0] = {}) => {
  const shell = html({ ...o, remover: null }), saved = html(o)
  return { entry: { version, sha256: version.replace(/\./g, '').padEnd(64, 'a'), at: '2026-10-21T00:00:00.000Z', pins: derivePins(shell, saved) }, saved }
}

const r1 = release('1.0.0'), r2 = release('1.1.0', { loader: 'load2()' }), r3 = release('1.2.0', { rt: 'RT3', loader: 'load3()' })

console.log('\nthe history only grows (nextHistory)')
const h1 = nextHistory('bento-test', null, r1.entry)
ok(h1.releases.length === 1 && historyProblems(h1).length === 0, 'the first history holds the first release')
const h2 = nextHistory('bento-test', h1, r2.entry)
ok(h2.releases.map((e) => e.version).join() === '1.1.0,1.0.0', 'a newer release is added, newest first')
ok(nextHistory('bento-test', h2, r2.entry).releases.length === 2, 're-signing the same release is a no-op')
ok(throws(() => nextHistory('bento-test', h2, release('1.0.5').entry), /not newer/), 'a release older than the newest held is refused')
ok(throws(() => nextHistory('bento-test', h2, { ...r2.entry, sha256: 'b'.repeat(64) }), /different bytes/), 'a changed entry for a held version is refused')
ok(throws(() => nextHistory('bento-other', h2, release('2.0.0').entry), /is for bento-test/), "a history held for another app is refused")

console.log('\na host accepts a history only forward (acceptHistory)')
const h3 = nextHistory('bento-test', h2, r3.entry)
ok(acceptHistory(null, h1, 'bento-test').ok, 'the first history a host sees is accepted')
ok(acceptHistory(h2, h3, 'bento-test').ok, 'a newer history that keeps every held entry is accepted')
ok(acceptHistory(h2, h2, 'bento-test').ok, 'the same history again is accepted')
const lacks = { ...h3, releases: h3.releases.filter((e) => e.version !== '1.0.0') }
ok(!acceptHistory(h2, lacks, 'bento-test').ok && /lacks 1\.0\.0/.test(acceptHistory(h2, lacks, 'bento-test').reason ?? ''), 'ROLLBACK refused: a history lacking an entry the host holds')
ok(!acceptHistory(h3, h2, 'bento-test').ok && /older/.test(acceptHistory(h3, h2, 'bento-test').reason ?? ''), 'ROLLBACK refused: a replayed older history (lower newest version)')
const changed = { ...h3, releases: h3.releases.map((e) => (e.version === '1.0.0' ? { ...e, sha256: 'c'.repeat(64) } : e)) }
ok(!acceptHistory(h3, changed, 'bento-test').ok, 'a history that changes a held entry is refused')
ok(!acceptHistory(null, h3, 'bento-other').ok, "another app's history is refused")
ok(!acceptHistory(null, { ...h3, releases: [h3.releases[1], h3.releases[0]] }, 'bento-test').ok, 'a history not newest-first is refused')

console.log('\na file matches ONE release on EVERY block, or is UNKNOWN (matchRelease)')
ok((await matchRelease(h3, r1.saved))?.version === '1.0.0', 'a 1.0.0 file matches 1.0.0')
ok((await matchRelease(h3, r2.saved))?.version === '1.1.0', '1.0.0 and 1.1.0 share a runtime; the loader tells them apart')
ok((await matchRelease(h3, html({ loader: 'loadX()' }))) === null, 'a known runtime with an unknown loader is UNKNOWN (a partial match)')
ok((await matchRelease(h3, html({ remover: 'rmX()' }))) === null, 'an unknown remover is UNKNOWN')
ok((await matchRelease(h3, html({ css: 'CSSX' }))) === null, 'an unknown stylesheet block is UNKNOWN')
ok((await matchRelease(h3, html({ extra: `<${S}>evil()</${S}>` }))) === null, 'an extra executable script is UNKNOWN')
ok((await matchRelease(h3, html({ extra: `<${S} type="bento/deflate-b86" id="bento-rt">RT1</${S}>` }))) === null, 'two bento-rt blocks are UNKNOWN (exactly one per id)')
ok((await matchRelease(h3, html({ rt: 'RTX' }))) === null, 'an unknown runtime is UNKNOWN')
const twin = { ...h3, releases: [{ ...r1.entry, version: '1.3.0' }, ...h3.releases] }
ok((await matchRelease(twin, r1.saved)) === null, 'two entries with identical blocks are ambiguous: UNKNOWN')

console.log('\nthe grammar (security, 2026-10-21): only Bento data types are inert; foreign markup is UNKNOWN')
{
  const genuine = r1.saved
  ok((await matchRelease(h3, genuine))?.version === '1.0.0', 'control: the genuine file matches')
  const head = (extra: string) => genuine.replace('</head>', extra + '</head>')
  const body = (extra: string) => genuine.replace('</body>', extra + '</body>')
  const rows: Array<[string, string]> = [
    ['an external <script src=…>', head(`<${S} src="https://evil.example/x.js"></${S}>`)],
    ['a script of an unknown type', head(`<${S} type="text/x-template">x</${S}>`)],
    ['an inline type="module" script', head(`<${S} type="module">x</${S}>`)],
    ['type="Module" (another case)', head(`<${S} type="Module">x</${S}>`)],
    ['type="text/JavaScript" (a JS type, mixed case)', head(`<${S} type="text/JavaScript">x</${S}>`)],
    ['a data type in different case', genuine.replace('type="application/bento+json"', 'type="Application/Bento+JSON"')],
    ['an uppercase <SCRIPT>', head(`<SCRIPT>x</SCRIPT>`)],
    ['a NUL inside the type attribute name', genuine.replace('type="bento/deflate-b86" id="bento-rt"', 'ty\u0000pe="bento/deflate-b86" id="bento-rt"')],
    ['an <iframe>', body('<iframe src="https://evil.example/"></iframe>')],
    ['an <object>', body('<object data="x"></object>')],
    ['an <embed>', body('<embed src="x">')],
    ['a <base>', head('<base href="https://evil.example/">')],
    ['a <meta> refresh', head('<meta http-equiv="refresh" content="0;url=https://evil.example/">')],
    ['a <meta> CSP', head(`<meta http-equiv='Content-Security-Policy' content="script-src *">`)],
    ['an on*= attribute', genuine.replace('<body>', '<body onload="evil()">')],
    ['a comment holding a <script>, before the loader', head(`<!-- <${S}>evil()</${S}> -->`)],
    ['a <script> inside <textarea>', body(`<textarea><${S}>x</${S}></textarea>`)],
    ['a <script> inside <title>', head(`<title><${S}>x</${S}></title>`)],
    ['a <script> inside <style>', head(`<style>/* <${S}>x</${S}> */</style>`)],
    // the DOCUMENT block isn't hashed (it holds the user's content), so only
    // the "<" rule can catch these: Bento always writes it <-escaped
    ['the document block holding a raw "<"', genuine.replace('id="bento-doc">{}<', 'id="bento-doc">{"x":"<b>"}<')],
    ['"<!--<script" inside the document block', genuine.replace('id="bento-doc">{}<', `id="bento-doc">{"x":"<!--<${S}>"}<`)],
  ]
  for (const [name, html] of rows) ok((await matchRelease(h3, html)) === null, `UNKNOWN: ${name}`)
  ok((await matchRelease(h3, genuine.replace(/type="bento\/deflate-b86"/g, "type='bento/deflate-b86'")))?.version === '1.0.0', 'single-quoted attributes parse the same (still matches)')
  ok((await matchRelease(h3, genuine.replace(/type="bento\/deflate-b86"/g, 'type=bento/deflate-b86')))?.version === '1.0.0', 'unquoted attributes parse the same (still matches)')
  ok((await matchRelease(h3, genuine.replace(`id="bento-rt">RT1</${S}>`, `id="bento-rt">RT1</${S} >`)))?.version === '1.0.0', '"</script >" closes a block like "</script>"')
}

console.log('\nsign-history.mjs, end to end with a TEST key')
{
  const dir = mkdtempSync(join(tmpdir(), 'bento-history-'))
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pub = publicKey.export({ format: 'jwk' })
  writeFileSync(join(dir, 'key.json'), JSON.stringify({ private: privateKey.export({ format: 'jwk' }), public: pub }))
  writeFileSync(join(dir, 'public.json'), JSON.stringify(pub))
  const script = join(dirname(fileURLToPath(import.meta.url)), 'sign-history.mjs')
  const shell = join(dir, 'shell.html'); writeFileSync(shell, html({ remover: null }))
  const pins = join(dir, 'pins.json'); writeFileSync(pins, JSON.stringify(r1.entry.pins))
  const sign = (version: string, held: string | null, out: string) => {
    try {
      execFileSync('node', [script, '--app', 'bento-test', '--version', version, '--shell', shell, '--pins', pins,
        ...(held ? ['--held', held] : []), '--key', join(dir, 'key.json'), '--public', join(dir, 'public.json'), '--out', out], { stdio: 'pipe' })
      return true
    } catch { return false }
  }
  ok(sign('1.0.0', null, join(dir, 'h1.json')), 'the first history is signed')
  const first = verifyEnvelope(readFileSync(join(dir, 'h1.json'), 'utf8'), pub)
  ok(first.releases.length === 1 && first.releases[0].version === '1.0.0', 'and verifies, with the release in it')
  ok(sign('1.1.0', join(dir, 'h1.json'), join(dir, 'h2.json')), 'a newer release is appended to the held history')
  ok(verifyEnvelope(readFileSync(join(dir, 'h2.json'), 'utf8'), pub).releases.length === 2, 'and the new history holds both')
  ok(!sign('1.0.5', join(dir, 'h2.json'), join(dir, 'bad.json')), 'an older release is refused by the CLI')
  const tampered = JSON.parse(readFileSync(join(dir, 'h2.json'), 'utf8'))
  tampered.payload = tampered.payload.replace('1.0.0', '0.9.0')
  writeFileSync(join(dir, 'tampered.json'), JSON.stringify(tampered))
  ok(!sign('1.2.0', join(dir, 'tampered.json'), join(dir, 'bad2.json')), 'a held history with a broken signature is refused, never re-signed')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
