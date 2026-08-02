#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Document validation rig.
//
//   esbuild scripts/test-validate.ts --bundle --platform=node --format=esm ...
//   node <bundle>
//
// (bundled because it pulls in starterdeck.ts, whose imports are extensionless)
//
// WHAT THIS PROVES. `validate()` exists so an agent can see what the runtime
// silently swallows. Its whole value rests on being TRUSTED, and the way it
// loses that is FALSE POSITIVES: an agent told that a real property is unknown
// will delete working configuration, which is worse than never having warned.
//
// So the rig pushes from both sides:
//
//   1. Real content stays quiet. The starter deck — our own showcase, which
//      exercises nearly every feature in the format — must report NO errors,
//      and a realistic chart option must produce no chart findings at all.
//   2. Broken content is caught. A deck built to trip every check must trip
//      exactly the expected codes, so a check silently ceasing to fire shows up
//      here rather than in somebody's deck.

import { starterDoc } from '../slides/src/starterdeck.ts'
import { validateDoc } from '../slides/src/validate.ts'
import type { BentoDoc } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ---------------------------------------------------------------- real content
const starter = validateDoc(starterDoc(), { measure: false })
ok(starter.ok && starter.counts.error === 0,
  `the starter deck reports no errors (${starter.counts.error} error, ${starter.counts.warning} warning, ${starter.counts.info} info)`)
ok(!starter.findings.some((f) => f.code === 'unknown-key'),
  'the starter deck has no unknown keys — the generated key tables match the format it is written in')
ok(!starter.findings.some((f) => f.code === 'chart-key-ignored'),
  'the starter deck has no dead chart options')
ok(!starter.findings.some((f) => f.code === 'overridden-enter-fx'),
  'the starter deck has no entrance animations the morph would override')
ok(starter.measured === false, 'measured is false without a DOM rather than silently skipping')

// ------------------------------------------------------------- a clean deck
const clean: BentoDoc = {
  format: 'bento/slides', version: '1.0.0', docId: 'test', title: 'clean',
  size: { width: 1280, height: 720 }, theme: { accent: '#F7A600', fontFamily: 'system-ui' },
  assets: {}, fonts: null,
  slides: [{
    id: 's1', name: 'one', background: '#FFF', transition: 'fade', notes: '', elements: [
      { id: 'a', type: 'text', x: 96, y: 100, w: 600, h: 120, rotation: 0, opacity: 1,
        html: 'hello', fontSize: 40, fontFamily: 'system-ui', fontWeight: 700,
        color: '#111', align: 'left', valign: 'middle', lineHeight: 1.2 },
    ],
  }],
} as any
const cleanResult = validateDoc(clean, { measure: false })
ok(cleanResult.findings.length === 0,
  `a clean deck produces no findings at all (got ${cleanResult.findings.length}: ${cleanResult.findings.map((f) => f.code).join(', ')})`)

// --------------------------------------------------------------- broken deck
const broken: BentoDoc = {
  ...clean,
  slides: [
    {
      id: 's1', name: 'one', background: '#FFF', transition: 'fade', notes: '', elements: [
        // unknown key, out of canvas, broken link, duplicate id
        { id: 'dup', type: 'text', x: 1000, y: 100, w: 600, h: 120, rotation: 0, opacity: 1,
          html: 'over the edge', fontSize: 40, fontFamily: 'system-ui', fontWeight: 700,
          color: '#111', align: 'left', valign: 'middle', lineHeight: 1.2,
          fontStyle: 'italic', link: 'nope' } as any,
        { id: 'dup', type: 'text', x: 96, y: 300, w: 400, h: 80, rotation: 0, opacity: 1,
          html: 'same id', fontSize: 20, fontFamily: 'system-ui', fontWeight: 400,
          color: '#111', align: 'left', valign: 'middle', lineHeight: 1.2 } as any,
        // dash-march on a solid stroke, and a morph-key collision with 'dup'
        { id: 'dash', morphId: 'dup', type: 'shape', shape: 'line', x: 96, y: 500, w: 400, h: 4,
          rotation: 0, opacity: 1, fill: '#000', stroke: '#000', strokeWidth: 2,
          fx: { loop: { type: 'dash-march' } } } as any,
        // missing asset
        { id: 'img', type: 'image', x: 96, y: 560, w: 100, h: 100, rotation: 0, opacity: 1,
          src: 'asset:nope', fit: 'cover' } as any,
      ],
    },
    {
      id: 's2', name: 'two', background: '#FFF', transition: 'morph', notes: '', elements: [
        // entrance on a morph arrival; also an unknown fx key
        { id: 'e', type: 'text', x: 96, y: 100, w: 400, h: 80, rotation: 0, opacity: 1,
          html: 'x', fontSize: 20, fontFamily: 'system-ui', fontWeight: 400,
          color: '#111', align: 'left', valign: 'middle', lineHeight: 1.2,
          fx: { enter: 'fade-up', wobble: true } } as any,
        // a chart with options charts-lite does not implement
        { id: 'c', type: 'chart', x: 600, y: 100, w: 400, h: 300, rotation: 0, opacity: 1,
          preset: 'bar',
          option: {
            xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value' },
            series: [{ type: 'bar', data: [1], label: { show: true } }],
            toolbox: { show: true },
          } } as any,
      ],
    },
  ],
} as any

const r = validateDoc(broken, { measure: false })
const codes = new Set(r.findings.map((f) => f.code))
for (const expected of [
  'unknown-key', 'out-of-canvas', 'broken-link', 'duplicate-id',
  'morph-key-collision', 'dash-march-no-dash', 'missing-asset',
  'overridden-enter-fx', 'chart-key-ignored',
]) {
  ok(codes.has(expected), `the broken deck trips ${expected}`)
}
ok(!r.ok, 'a deck with broken references is not ok')
ok(r.findings.some((f) => f.code === 'chart-key-ignored' && f.path === 'option.series[0].label'),
  'a label on a bar series is reported (it is read for pie only)')
ok(r.findings.some((f) => f.code === 'unknown-key' && f.path === 'fx.wobble'),
  'an unknown key nested under fx is reported with its path')

// ------------------------------------------------- chart false-positive guard
// The shape the starter deck's own charts use. Every key here IS implemented,
// so any finding is the validator lying about working configuration.
const realisticChart = {
  color: ['#F7A600', '#5B8DEF'],
  grid: { left: 48, right: 16, top: 24, bottom: 56 },
  legend: { show: true, top: 0, textStyle: { fontSize: 13 } },
  tooltip: { trigger: 'axis' },
  xAxis: { type: 'category', data: ['Mon', 'Tue'], axisLine: { lineStyle: { color: '#D8D2C4' } }, axisLabel: { color: '#6B7280' } },
  yAxis: [
    { type: 'value', axisLabel: { color: '#6B7280' }, splitLine: { lineStyle: { color: '#EAE4D6' } } },
    { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
  ],
  series: [
    { type: 'bar', name: 'Signups', data: [1, 2], itemStyle: { borderRadius: [6, 6, 0, 0] } },
    { type: 'line', name: 'Rate', yAxisIndex: 1, data: [3, 4], smooth: true, symbolSize: 8, lineStyle: { width: 3 } },
  ],
}
const chartDoc: BentoDoc = {
  ...clean,
  slides: [{
    id: 's1', name: 'one', background: '#FFF', transition: 'fade', notes: '', elements: [
      { id: 'ch', type: 'chart', x: 96, y: 96, w: 800, h: 400, rotation: 0, opacity: 1,
        preset: 'bar', option: realisticChart } as any,
    ],
  }],
} as any
const chartFindings = validateDoc(chartDoc, { measure: false }).findings
ok(chartFindings.length === 0,
  `a realistic dual-axis chart produces no findings (got ${chartFindings.map((f) => f.path).join(', ') || 'none'})`)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
