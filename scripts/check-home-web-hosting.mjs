#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id's hosting rules for bento/home, OFFLINE, over a built home/web tree
// (home/web/build.mjs --out DIR): what the library WILL send, before it is
// deployed. scripts/check-id-hosting.mjs checks the same rules against the live
// host; both read them from scripts/lib/id-hosting-rules.mjs.
//
//   node scripts/check-home-web-hosting.mjs DIR
//
//   home-framing   every HTML path the library's _headers lists sends
//                  frame-ancestors 'none' (no X-Frame-Options needed: the
//                  CSP is what browsers enforce)
//   home-coop      every path sends COOP at most same-origin-allow-popups
//                  (stricter would cut the sign-in popup off from its opener)
//   home-one-csp   each path has exactly one CSP header (two are two policies)
//   home-no-webauthn  the library serves no /.well-known/webauthn file, and no
//                  _headers rule names one
//
// Exits 1 on any problem, 2 when DIR is not a home/web build.

import fs from 'node:fs'
import path from 'node:path'
import { parseHeaders } from '../home/web/serve.mjs'
import { coopProblem, framingProblem } from './lib/id-hosting-rules.mjs'

export function homeWebHostingProblems(dir) {
  const lib = path.join(dir, 'library')
  const hfile = path.join(lib, '_headers')
  if (!fs.existsSync(hfile) || !fs.existsSync(path.join(lib, 'index.html'))) return null
  const rules = parseHeaders(fs.readFileSync(hfile, 'utf8'))
  const problems = []
  const html = rules.filter((r) => r.pattern === '/' || /\.html$/.test(r.pattern))
  if (!html.some((r) => r.pattern === '/')) problems.push('home-framing: _headers has no rule for /')
  for (const r of rules) {
    const csp = r.headers.filter(([k]) => k.toLowerCase() === 'content-security-policy').map(([, v]) => v)
    const coop = r.headers.filter(([k]) => k.toLowerCase() === 'cross-origin-opener-policy').map(([, v]) => v)
    if (html.includes(r)) {
      if (csp.length !== 1) problems.push(`home-one-csp: ${r.pattern} has ${csp.length} Content-Security-Policy headers (exactly one)`)
      const f = framingProblem(csp.join(', '), undefined, { requireXfo: false })
      if (f) problems.push(`home-framing: ${r.pattern}: ${f}`)
    }
    for (const c of coop) { const p = coopProblem('home', c); if (p) problems.push(`home-coop: ${r.pattern} ${p}`) }
    if (coop.length > 1) problems.push(`home-coop: ${r.pattern} has ${coop.length} COOP headers`)
    if (/well-known\/webauthn/.test(r.pattern)) problems.push(`home-no-webauthn: _headers names ${r.pattern}`)
  }
  if (fs.existsSync(path.join(lib, '.well-known/webauthn'))) problems.push('home-no-webauthn: the library serves /.well-known/webauthn')
  return { problems, paths: rules.map((r) => r.pattern) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: check-home-web-hosting.mjs DIR (a home/web build)'); process.exit(2) }
  const r = homeWebHostingProblems(path.resolve(dir))
  if (!r) { console.error(`${dir} is not a home/web build (no library/index.html and library/_headers)`); process.exit(2) }
  for (const p of r.problems) console.log(`  FAIL  ${p}`)
  console.log(`${r.problems.length ? 'FAIL' : 'ok'}: bento/home hosting rules over ${r.paths.length} paths (${r.paths.join(' ')})`)
  process.exit(r.problems.length ? 1 : 0)
}
