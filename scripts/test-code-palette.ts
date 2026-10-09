#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Code colours rig: the Theme panel's rows for theme.codePalette (#450).
//
//   node scripts/test-code-palette.ts
//
// WHAT THIS PROVES. The eight token scopes are ONE list (code.ts CODE_SCOPES)
// that the built-in colours, the model's codePalette keys, the starter deck's
// palette and the Theme panel all agree with — the panel builds one row per
// entry, shows the built-in colour when the deck has none, and writes the
// field only when a colour is changed, so a deck without a codePalette keeps
// rendering exactly as before. Code colours are plain literals, not palette
// references (stated in the panel; asserted here so nobody adds a second
// reference mechanism quietly).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CODE_SCOPES, DEFAULT_CODE_COLORS } from '../slides/src/code.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')

console.log('one list of scopes\n')
const keys = CODE_SCOPES.map((s) => s.key)
ok(keys.length === 8 && new Set(keys).size === 8, 'eight scopes, no duplicates')
ok(keys.every((k) => /^#[0-9a-f]{6}$/i.test(DEFAULT_CODE_COLORS[k])), 'every scope has a built-in colour')
ok(Object.keys(DEFAULT_CODE_COLORS).filter((k) => k !== 'x').sort().join() === [...keys].sort().join(),
  'the built-in scheme colours exactly the scopes (plus x, the plain-text passthrough)')
const model = read('slides/src/model.ts')
const block = model.slice(model.indexOf('codePalette?: {'), model.indexOf('}', model.indexOf('codePalette?: {')))
const modelKeys = [...block.matchAll(/^\s*([a-z])\?: string/gm)].map((m) => m[1])
ok(modelKeys.sort().join() === [...keys].sort().join(), `the model's codePalette keys are the same eight (${modelKeys.join(',')})`)
ok(CODE_SCOPES.every((s) => s.label.length > 0 && /^[A-Z]/.test(s.label)), 'every scope has a panel label')

console.log('\nthe starter deck\n')
const starter = read('slides/src/starterdeck.ts')
const sblock = starter.slice(starter.indexOf('doc.theme.codePalette = {'), starter.indexOf('}', starter.indexOf('doc.theme.codePalette = {')))
const sKeys = [...sblock.matchAll(/^\s*([a-z]):/gm)].map((m) => m[1])
ok(sKeys.length > 0 && sKeys.every((k) => keys.includes(k as never)), `the starter deck's palette uses only known scopes (${sKeys.join(',')})`)

console.log('\nthe panel\n')
const panels = read('slides/src/editor/panels.ts')
const theme = panels.slice(panels.indexOf('private buildThemeProps()'), panels.indexOf('private colorAlpha('))
ok(/for \(const scope of CODE_SCOPES\)/.test(theme), 'the Theme section builds one row per CODE_SCOPES entry')
ok(/codePalette\?\.\[scope\.key\] \?\? DEFAULT_CODE_COLORS\[scope\.key\]/.test(theme), 'a row shows the deck\'s colour, else the built-in one')
ok(/\(t2\.codePalette \?\?= \{\}\)\[scope\.key\] = v/.test(theme), 'the field is created only when a colour is written')
ok(!/codePalette \?\?= \{\}/.test(theme.slice(0, theme.indexOf('for (const scope of CODE_SCOPES)'))), 'nothing writes codePalette before a row is edited')
ok(/delete this\.store\.doc\.theme\.codePalette/.test(theme) && /if \(this\.store\.doc\.theme\.codePalette\)/.test(theme), 'a deck with a palette gets a reset back to the built-in scheme')
const codeRows = theme.slice(theme.indexOf('for (const scope of CODE_SCOPES)'))
ok(!/ref:|setRef\(|paletteSwatches\(/.test(codeRows), 'code colours are plain literals — no palette reference wiring')

console.log('\nthe renderer\n')
ok(/codePalette\?\.\[token\.scopes\[0\]\] \?\? DEFAULT_CODE_COLORS\[token\.scopes\[0\] \?\? 'x'\]/.test(read('slides/src/code.ts')),
  'code.ts colours a token from the deck\'s palette, else the built-in scheme')

console.log('\nempty accent slots stay out of the panel\n')
const { slotIsSet, paletteOf, OPTIONAL_ACCENTS } = await import('../slides/src/palette.ts')
const fresh = { theme: { background: '#fff', color: '#111', accent: '#f7a600', fontFamily: 'x' } } as never
const authored = { theme: { background: '#fff', color: '#111', accent: '#f7a600', fontFamily: 'x', palette: { accent2: '#2266cc' } } } as never
ok(OPTIONAL_ACCENTS.every((k) => !slotIsSet(fresh, k)), 'a fresh deck sets none of accent 2–6')
ok(OPTIONAL_ACCENTS.every((k) => paletteOf(fresh)[k] === '#f7a600'), '…though paletteOf still resolves each of them to accent 1 (the format is untouched)')
ok(slotIsSet(authored, 'accent2') && !slotIsSet(authored, 'accent3'), 'a deck carrying accent2 sets that slot and not the next')
ok(slotIsSet(fresh, 'accent1') && slotIsSet(fresh, 'bg1') && slotIsSet(fresh, 'tx1'), 'the three canonical slots are always set')
ok(/if \(!slotIsSet\(this\.store\.doc, key\)\) continue/.test(theme), 'the Theme section shows an Accent N row only for a set slot')
ok(/if \(!slotIsSet\(this\.store\.doc, slot\)\) continue/.test(panels.slice(panels.indexOf('private paletteSwatches('))), 'the quick-pick swatch row skips unset accents, the way it skips unset hlink')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
