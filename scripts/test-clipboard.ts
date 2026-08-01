#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Clipboard transport is plain JSON, so this regression rig runs without a DOM.

import { insertElements, insertSlides, parseClip, serializeElements, serializeSlides } from '../slides/src/editor/clipboard.ts'
import { defaultText, newDoc, type BentoDoc } from '../slides/src/model.ts'

let checks = 0
let failures = 0

function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ✓ ${message}`)
  else {
    failures++
    console.error(`  ✗ ${message}`)
  }
}

function sourceDoc(): BentoDoc {
  const doc = newDoc()
  doc.assets = { 'font-acme': 'data:font/woff2;base64,U09VUkNF', unused: 'data:font/woff2;base64,VU5VU0VE' }
  doc.fonts = [
    { family: 'Acme', asset: 'font-acme' },
    { family: 'Unused', asset: 'unused' },
  ]
  doc.slides[0].elements = [defaultText({ id: 'text-acme', html: 'A', fontFamily: "'Acme', sans-serif" })]
  return doc
}

function targetDoc(): BentoDoc {
  const doc = newDoc()
  doc.assets = { 'font-acme': 'data:font/woff2;base64,VEFSR0VU' }
  return doc
}

function remappedFont(doc: BentoDoc) {
  return doc.fonts?.find((font) => font.family === 'Acme')
}

console.log('\nelement clipboard')
{
  const source = sourceDoc()
  const payload = parseClip(serializeElements(source.slides[0].elements, source))!
  ok(payload.fonts?.length === 1 && payload.fonts[0].family === 'Acme', 'copies only the embedded face used by pasted elements')
  ok(payload.assets?.['font-acme'] === source.assets!['font-acme'], 'copies bytes for an embedded element font')

  const target = targetDoc()
  insertElements(payload, target, target.slides[0])
  const font = remappedFont(target)
  ok(font?.asset !== 'font-acme', 'remaps a colliding font asset for pasted elements')
  ok(target.assets!['font-acme'] === 'data:font/woff2;base64,VEFSR0VU', 'keeps target asset bytes on collision')
  ok(font != null && target.assets![font.asset] === source.assets!['font-acme'], 'pasted element font points at its source bytes')
}

console.log('\nslide clipboard')
{
  const source = sourceDoc()
  const payload = parseClip(serializeSlides(source.slides, source))!
  ok(payload.fonts?.length === 1 && payload.fonts[0].family === 'Acme', 'copies only the embedded face used by pasted slides')
  ok(payload.assets?.['font-acme'] === source.assets!['font-acme'], 'copies bytes for an embedded slide font')

  const target = targetDoc()
  insertSlides(payload, target, 1)
  const font = remappedFont(target)
  ok(font?.asset !== 'font-acme', 'remaps a colliding font asset for pasted slides')
  ok(target.assets!['font-acme'] === 'data:font/woff2;base64,VEFSR0VU', 'keeps target slide asset bytes on collision')
  ok(font != null && target.assets![font.asset] === source.assets!['font-acme'], 'pasted slide font points at its source bytes')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
