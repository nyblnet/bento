#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The compressed shell's carrier and loader (postbuild-compress.mjs):
//
//   node scripts/test-shell-loader.ts
//
// WHAT THIS PROVES. (1) base86 (scripts/lib/b86.mjs) round-trips every byte
// length mod 4 and the edge values, and its text can never contain the five
// sequences that would end or comment out the block carrying it — asserted
// over 10,000 random buffers and their concatenations, by construction (the
// characters are not in the alphabet) and by search; the loader's own inline
// decoder agrees with the node one byte for byte. (2) A shell built from a
// synthetic vite-shaped page carries bento/deflate-b86 blocks, passes the
// splice gate, and the gate goes RED when a payload is hand-edited to contain
// `-->`. (3) The loader probes nothing: no new Function('') probe, no
// createPolicy outside the lazy install, the inline module first, the
// fallbacks only after a violation; and it records window.bento.loader.
// Teams' preview pane treats any reported CSP violation as fatal, so a loader
// that probes is a loader that shows a blue splash there.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { encode, decode, ALPHABET, BASE, FORBIDDEN, LOADER_DECODER } from './lib/b86.mjs'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

console.log('base86 — the alphabet\n')
ok(BASE === 86 && ALPHABET.length === 86, 'eighty-six symbols')
ok(!/[<>&"'\\\-{ ]/.test(ALPHABET), 'no < > & " \' \\ - { or space — the five sequences are unproducible by construction')
ok(new Set(ALPHABET).size === 86 && [...ALPHABET].every((c) => c.charCodeAt(0) >= 0x21 && c.charCodeAt(0) <= 0x7e), 'distinct, printable ASCII')

console.log('\nbase86 — round trips\n')
let rt = true
for (let len = 0; len < 64; len++) for (let r = 0; r < 8; r++) { const b = new Uint8Array(randomBytes(len)); if (!eq(decode(encode(b)), b)) rt = false; if (encode(b).length !== Math.floor(len / 4) * 5 + (len % 4 ? len % 4 + 1 : 0)) rt = false }
ok(rt, 'every length 0–63 (all residues mod 4), byte-identical, n bytes → 5n/4 chars with the n+1 tail')
const edges = [[0, 0, 0, 0], [255, 255, 255, 255], [255], [0], [255, 255, 255], [128, 0, 0, 1], [255, 255, 255, 255, 255]]
ok(edges.every((e) => eq(decode(encode(new Uint8Array(e))), new Uint8Array(e))), 'edge values incl. all-0xFF groups and tails')
let threw = false
try { decode('a') } catch { threw = true }
ok(threw, 'a lone trailing character is refused')
threw = false
try { decode('ab<de') } catch { threw = true }
ok(threw, 'a character outside the alphabet is refused')
const loaderDecode = new Function(LOADER_DECODER + '\nreturn b86decode')() as (t: string) => Uint8Array
let agree = true
for (let len = 0; len < 64; len++) { const b = new Uint8Array(randomBytes(len)); if (!eq(loaderDecode(encode(b)), b)) agree = false }
ok(agree, "the loader's inline decoder (LOADER_DECODER) agrees with decode() byte for byte")

console.log('\nbase86 — the five sequences never appear\n')
let hits = 0, cat = ''
for (let r = 0; r < 10000; r++) {
  const t = encode(new Uint8Array(randomBytes(1 + (r % 97))))
  for (const f of FORBIDDEN) if (t.includes(f)) hits++
  cat += t
  if (cat.length > 100000) { for (const f of FORBIDDEN) if (cat.includes(f)) hits++; cat = cat.slice(-8) }
}
for (const f of FORBIDDEN) if (cat.includes(f)) hits++
ok(hits === 0, `${FORBIDDEN.map((f) => JSON.stringify(f)).join(' ')} — zero hits in 10,000 random buffers and their concatenations`)
// worst case by construction: the bytes that would spell them in base64 or raw
ok(!FORBIDDEN.some((f) => encode(new Uint8Array(Buffer.from(f.repeat(50)))).includes(f)), 'encoding the sequences themselves does not reproduce them')

console.log('\nthe built shell\n')
// a synthetic vite-shaped single file: module script + linked stylesheet + doc block + splash
const dir = mkdtempSync(join(tmpdir(), 'shell-loader-'))
const page = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>t</title>
<script type="module" crossorigin>window.bento = { doc: { format: 'bento/slides' } }; const T = '[data-bento-transient]'; document.getElementById('app').textContent = 'mounted' + T.length</script>
<style rel="stylesheet" crossorigin>#app{color:red}</style>
<script type="application/bento+json" id="bento-doc"></script></head>
<body><style>#bento-splash{opacity:.5}</style><div id="bento-splash"><div>splash</div></div><div id="app"></div></body></html>`
const shellPath = join(dir, 'shell.html')
writeFileSync(shellPath, page)
const run = (args: string[]) => execFileSync(process.execPath, [join(root, 'scripts/postbuild-compress.mjs'), shellPath, ...args], { cwd: join(root, 'slides'), encoding: 'utf8', env: { ...process.env, ZOPFLI: '0' } })
run(['--loader', 'cascade'])
const built = readFileSync(shellPath, 'utf8')
ok((built.match(/type="bento\/deflate-b86"/g) ?? []).length === 2, 'two bento/deflate-b86 payload blocks')
ok(!/type="bento\/deflate-b64"/.test(built), 'no base64 block')
const gate = (file: string) => { try { execFileSync(process.execPath, [join(root, 'scripts/shell-gate.mjs'), file], { encoding: 'utf8', stdio: 'pipe' }); return 'ok' } catch (e) { return String((e as { stderr?: string }).stderr ?? e) } }
ok(gate(shellPath) === 'ok', 'the splice gate passes')
const m = /(<script id="bento-rt-css" type="bento\/deflate-b86">)([^<]*)(<\/script>)/.exec(built)!
const badPath = join(dir, 'bad.html')
writeFileSync(badPath, built.slice(0, m.index + m[1].length) + m[2].slice(0, 20) + '-->' + m[2].slice(23) + built.slice(m.index + m[1].length + m[2].length))
const g = gate(badPath)
ok(g !== 'ok' && /must not be able to end its own block/.test(g), 'the gate goes red when a payload is hand-edited to contain -->')
// the payload really is the deflated module
const payload = m[2]
ok(eq(decode(payload), new Uint8Array(deflateRawSync(Buffer.from('#app{color:red}'), { level: 9 }))), 'the css payload decodes to the deflated stylesheet (zlib level 9 under ZOPFLI=0)')

console.log('\nthe loader probes nothing\n')
const loader = /<script>\n\(async \(\) => \{([\s\S]*?)\n<\/script>\n\s*<\/body>/.exec(built)?.[1] ?? ''
ok(loader.length > 0, 'the loader is the last script in the body')
ok(!/new Function\(''\)/.test(loader), "no new Function('') eval probe")
ok(/var installTT = function/.test(loader) && (loader.match(/createPolicy\(/g) ?? []).length === 2 && !/^\s*installTT\(\)/m.test(loader), 'createPolicy appears only inside the lazy install, never called at boot')
ok(/await attempt\('inline', viaInline\)/.test(loader) && /if \(!path\) runNow\('function', viaFunction\)/.test(loader) && /if \(!path\) await attempt\('blob'/.test(loader), 'order: inline module, then new Function, then blob — each only after the previous was refused')
ok(/window\.bento\.loader = \{ path: path, tried: tried, tt: tt, violations: violations \}/.test(loader), 'window.bento.loader records path, tried, tt and the violation count')
ok(/sourceURL=bento-slides\.js/.test(loader), 'the evaluated bundle is named bento-slides.js for DevTools')
ok(/data-bento-transient/.test(loader) && /b86decode/.test(loader) && !/atob\(/.test(loader), 'the loader carries the base86 decoder, no atob, and marks what it injects transient')
ok(!/<\/scr\x69pt>/.test(loader), 'no script-close inside the loader')
rmSync(dir, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
