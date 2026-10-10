// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento.page/convert rig: the BUILT page keeps the promise it prints, and
// bento.page/import still lands there.
//
// The page says the file never leaves the device. The enforcement is its
// Content Security Policy — `connect-src 'self'` means the browser itself
// refuses any other destination — so this rig builds the page exactly as the
// release does and asserts the policy, not the intention:
//   · one CSP, `default-src 'none'`, `connect-src 'self'` and nothing wider;
//   · the inline script and style are the ones the CSP hashes (a mismatch
//     means the page's own policy would block it — the $-pattern bug);
//   · the page loads no resource from anywhere (no script/img/iframe/link
//     that a browser fetches), and the script's only absolute URL is the
//     bento.page manifest (XML namespace URIs are identifiers, never fetched).
// The network behaviour of the code itself — exactly [manifest, shell], and
// refusal on any broken signature or pin — is deliver.ts's rig.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-convert-rig-'))
const out = path.join(tmp, 'convert/index.html')
const b = spawnSync(process.execPath, [path.join(root, 'scripts/build-convert-page.mjs'), out], { encoding: 'utf8' })
ok(b.status === 0 && fs.existsSync(out), `the page builds (exit ${b.status}${b.stderr ? ': ' + b.stderr.trim() : ''})`)
const html = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
const sha = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`

console.log('the policy')
const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)]
ok(metas.length === 1, `exactly one CSP (${metas.length})`)
const csp = new Map<string, string[]>()
for (const d of (metas[0]?.[1] ?? '').split(';')) {
  const [k, ...v] = d.trim().split(/\s+/)
  if (k) csp.set(k, v)
}
const is = (k: string, v: string[]) => JSON.stringify(csp.get(k)) === JSON.stringify(v)
ok(is('default-src', ["'none'"]), `default-src 'none' (${csp.get('default-src')})`)
ok(is('connect-src', ["'self'"]), `connect-src is 'self' and nothing else (${csp.get('connect-src')})`)
ok(is('base-uri', ["'none'"]) && is('form-action', ["'none'"]), 'base-uri and form-action are none')
ok(is('img-src', ["'self'", 'data:']), `img-src 'self' data: only (${csp.get('img-src')})`)
const allowed = new Set(['default-src', 'script-src', 'style-src', 'connect-src', 'img-src', 'base-uri', 'form-action'])
ok([...csp.keys()].every(k => allowed.has(k)), `no unexpected directives (${[...csp.keys()].join(', ')})`)
const wide = [...csp.values()].flat().filter(v => /^(\*|https?:|'unsafe-|blob:)/.test(v) || /^[a-z0-9.-]+\.[a-z]{2,}/i.test(v))
ok(wide.length === 0, `no host, wildcard, blob: or unsafe-* source anywhere (${wide.join(' ') || 'none'})`)

console.log('the hashes')
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
ok(scripts.length === 1 && !/\bsrc=/.test(scripts[0][1]), `one inline script, no src (${scripts.length})`)
const js = scripts[0]?.[2] ?? ''
ok(is('script-src', [sha(js)]), 'script-src is exactly the hash of the inline script')
const styles = [...html.replace(js, '').matchAll(/<style>([\s\S]*?)<\/style>/g)]
ok(styles.length === 1 && is('style-src', [sha(styles[0][1])]), 'one <style>, and style-src is exactly its hash')
ok(!/\sstyle="/.test(html.replace(js, '')), 'no inline style attributes (the hashed policy would drop them)')
ok(!/\son[a-z]+=/i.test(html.replace(js, '')), 'no inline event handlers')

console.log('what it loads')
const markup = html.replace(js, '')
const loads = [
  ...markup.matchAll(/<(?:img|iframe|embed|object|audio|video|source|track|frame)\b[^>]*>/gi),
  ...[...markup.matchAll(/<link\b[^>]*>/gi)].filter(m => !/rel="canonical"/.test(m[0]) && !/href="data:/.test(m[0])),
].map(m => m[0])
ok(loads.length === 0, `no fetched resource in the markup (${loads.join(' ') || 'none'})`)
const NAMESPACES = /^https?:\/\/(schemas\.openxmlformats\.org|schemas\.microsoft\.com|www\.w3\.org|purl\.org)\//
const urls = [...new Set(js.match(/https?:\/\/[^\s"'`)\\]+/g) ?? [])].filter(u => !NAMESPACES.test(u))
ok(urls.every(u => u === 'https://bento.page/releases/slides/manifest.json'),
  `the script's only absolute URL is the bento.page manifest (${urls.join(' ') || 'none'})`)
ok(!/\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection)\b/.test(js), 'no second network API in the bundle')
ok(/nothing is uploaded|never leaves/i.test(markup), 'the page says so in words')

console.log('what the page offers')
ok(/id="sample"/.test(markup) && /A little more portable/.test(js), 'the sample deck is built in (nothing fetched for it)')
ok(/<a [^>]*href="\/slides\/"/.test(markup), 'the header links the editor, like the rest of bento.page')

console.log('bento.page/import still works')
{
  const redirect = fs.readFileSync(path.join(root, 'site-src/import.html'), 'utf8')
  ok(!/<script/i.test(redirect), 'the /import page runs no script at all')
  ok(/<meta http-equiv="refresh" content="0; url=\/convert\?from=pptx">/.test(redirect), 'it sends the browser to /convert?from=pptx at once')
  ok(/<a href="\/convert\?from=pptx">/.test(redirect), 'and links there for a browser that ignores refresh')
  ok(/content="default-src 'none'; base-uri 'none'; form-action 'none'"/.test(redirect), "its CSP allows nothing to load (default-src 'none')")
  ok(/from'\) === 'pptx'/.test(fs.readFileSync(path.join(root, 'convert/page/convert-page.ts'), 'utf8')),
    '/convert reads ?from=pptx and greets an /import visitor with the import wording')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
