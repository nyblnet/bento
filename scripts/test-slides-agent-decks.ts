#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Agent-deck corpus: compact decks written the way agents write them
// (scripts/fixtures/agent-decks/*.json) must load clean — through the real
// loader (compactload.ts: expand → gate → parseDoc → validate) — with zero
// dropped keys and zero validate() errors. A change to a default, the gate or
// the expansion that breaks the agent path fails here, not in someone's
// harness. esbuild-bundled in CI (the loader pulls the gate and validate).
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-agent-decks.ts --bundle --platform=node --format=esm --outfile=/tmp/x.mjs && node /tmp/x.mjs
//
// No DOM here: fit-to-text is skipped (fit=false) and validate() runs its
// unmeasured checks; the browser half (heights) is measured in Chrome and
// stated in the PR that lands each change to compactload.ts.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocInputReport } from '../slides/src/compactload.ts'
import { isCompact, provisionalHeight } from '../slides/src/compact.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
// bundled: the bundle lives elsewhere, so the repo root is the cwd (CI runs from it)
const root = process.cwd()
const dir = join(root, 'scripts/fixtures/agent-decks')
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
ok(files.length >= 3, `${files.length} agent decks in the corpus`)

for (const f of files) {
  console.log(`\n${f}\n`)
  const json = readFileSync(join(dir, f), 'utf8')
  const raw = JSON.parse(json)
  ok(isCompact(raw), 'is a compact document')
  const parsed = parseDocInputReport(json, false)
  ok(!!parsed, 'loads')
  if (!parsed) continue
  const { doc, report } = parsed
  ok(report.compact && report.dropped.length === 0, `zero dropped keys${report.dropped.length ? ': ' + report.dropped.map((d) => `${d.path} (${d.reason})`).join('; ') : ''}`)
  ok(report.expanded > 0, `${report.expanded} fields expanded`)
  const errors = report.findings.findings.filter((x) => x.severity === 'error')
  ok(errors.length === 0, `validate(): zero errors${errors.length ? ': ' + errors.map((e) => e.message).join('; ') : ''}`)
  const warnings = report.findings.findings.filter((x) => x.severity === 'warning')
  if (warnings.length) console.log(`        (${warnings.length} warning(s): ${warnings.map((w) => w.code ?? w.message).join(', ')})`)
  const els = doc.slides.flatMap((s) => s.elements)
  ok(els.every((e) => typeof e.id === 'string' && e.id), 'every element has an id')
  ok(new Set(els.map((e) => e.id)).size === els.length || doc.slides.every((s) => new Set(s.elements.map((e) => e.id)).size === s.elements.length), 'ids are unique within each slide')
  ok(els.every((e) => e.type !== 'text' || typeof (e as { html?: unknown }).html === 'string'), 'every text element has html (md converted)')
  ok(els.every((e) => !('md' in e)), 'no md reaches the document')
  // provisional heights are present where h was omitted (the browser fits them)
  const auto = raw.slides.flatMap((s: { elements?: unknown[] }) => (s.elements ?? []).flat(Infinity)).filter((e: { type?: string; h?: unknown }) => e.type === 'text' && (e.h === undefined || e.h === 'auto')).length
  ok(report.fitted === 0 && report.refit.length === 0, 'without a DOM nothing is fitted (fit=false) and nothing is queued')
  if (auto) ok(els.some((e) => e.type === 'text' && e.h === provisionalHeight(Number((e as { fontSize?: number }).fontSize) || 24, Number((e as { lineHeight?: number }).lineHeight) || 1.2)), `${auto} text element(s) carry a provisional one-line height`)
}

console.log('\nthe report on a deliberately wrong deck\n')
{
  const bad = JSON.stringify({ compact: true, slides: [{ elements: [
    { type: 'text', x: 0, y: 0, w: 100, h: 20, html: 'x', bogus: 1, onclick: 'alert(1)', fontSize: 'big' },
    { type: 'sparkle', x: 0, y: 0, w: 1, h: 1 },
  ] }] })
  const parsed = parseDocInputReport(bad, false)
  ok(!!parsed, 'a deck with mistakes still loads (the gate drops, it does not refuse)')
  const paths = parsed?.report.dropped.map((d) => d.path) ?? []
  ok(paths.includes('/slides/0/elements/0/bogus'), `bogus key reported at its path (${paths.join(', ')})`)
  ok(paths.includes('/slides/0/elements/0/onclick'), 'onclick reported at its path')
  ok(parsed?.report.dropped.some((d) => d.path === '/slides/0/elements/0/fontSize' && d.reason === 'invalid value'), 'an invalid value is reported as such')
  ok(parsed?.report.dropped.some((d) => d.path === '/slides/0/elements/1/type' && /unknown element type/.test(d.reason)), 'an unknown element type is reported and the element dropped')
  ok(parsed?.doc.slides[0].elements.length === 1, 'the good element survives, the unknown one is gone')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
