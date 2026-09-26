#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The live-session notices say what was refused.
//
//   node scripts/test-slides-sync-notice.ts
//
// WHAT THIS PROVES. A refused whole-deck snapshot (SyncNotice.snapshot, from
// #509) is worded as "this deck is too large", never as "that change" or
// "that image": syncNoticeText branches on `snapshot` BEFORE `media`. The
// pictures-still-uploading count (session.pendingBlobUploads) is polled by the
// Share popover only while it is open, and the interval stops itself when the
// popover closes. Every new string is in all eight core catalogs.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const editor = read('slides/src/editor/editor.ts')

console.log('the wording\n')
const fn = editor.slice(editor.indexOf('function syncNoticeText('), editor.indexOf('\n}\n', editor.indexOf('function syncNoticeText(')))
const tooLarge = fn.slice(fn.indexOf("case 'too-large':"), fn.indexOf("case 'room-full':"))
const iSnap = tooLarge.indexOf('n.snapshot')
const iMedia = tooLarge.indexOf('n.media')
ok(iSnap > 0 && iMedia > 0 && iSnap < iMedia, 'too-large branches on `snapshot` before `media`')
ok(/if \(n\.snapshot\) return t\('This deck is too large to share live in one piece\./.test(tooLarge), 'a refused snapshot is worded as the deck, not a change')
ok(/n\.media\s*\?\s*t\('That image is too large/.test(tooLarge) && /: t\('That change is too large/.test(tooLarge), 'the change and image wordings are unchanged')
const session = read('kernel/src/sync/session.ts')
ok(/snapshot\?: boolean/.test(session.slice(session.indexOf('export interface SyncNotice'))), 'the kernel notice carries `snapshot` (#509) — the type is the kernel\'s, not widened here')
ok(/pendingBlobUploads\(\): number/.test(session), 'the kernel exposes pendingBlobUploads()')

console.log('\nthe toast\n')
const onNotice = editor.slice(editor.indexOf('session.onNotice((n) => {'), editor.indexOf('})', editor.indexOf('session.onNotice((n) => {')) + 2)
ok(/const pending = n\.snapshot \? session\.pendingBlobUploads\(\) : 0/.test(onNotice), 'the pending count is appended only to a snapshot refusal (informational)')
ok(/pending === 1 \? t\('1 picture is still uploading; it will follow\.'\) : t\('\{n\} pictures are still uploading; they will follow\.'/.test(onNotice), 'singular and plural keys, the existing pattern')

console.log('\nthe popover poll\n')
const panel = editor.slice(editor.indexOf('private renderSharePanel()'), editor.indexOf('private shareTransports') > 0 ? editor.indexOf('private shareTransports') : editor.indexOf('private renderSharePanel()') + 20000)
ok(/if \(this\.uploadPoll !== null\) \{ clearInterval\(this\.uploadPoll\); this\.uploadPoll = null \}/.test(panel), 'a rebuild clears the previous poll first')
ok(/if \(!this\.shareWrap\.classList\.contains\('open'\)\) \{ if \(this\.uploadPoll !== null\) clearInterval\(this\.uploadPoll\); this\.uploadPoll = null; return \}/.test(panel), 'the poll stops itself when the popover is closed')
ok(/this\.uploadPoll = window\.setInterval\(tick, 1000\)/.test(panel), 'polled once a second')
ok(/uploading\.hidden = k === 0/.test(panel), 'hidden at zero')
ok(/k === 1 \? t\('1 picture still uploading…'\) : t\('\{n\} pictures still uploading…', \{ n: k \}\)/.test(panel), 'singular and plural, the existing pattern')
ok(/if \(on && this\.session\) \{/.test(panel), 'only while sharing is on')

console.log('\nthe strings\n')
const keys = ['This deck is too large to share live in one piece. Your changes are saved in your copy, but a collaborator joining now may not receive the whole deck.',
  '1 picture is still uploading; it will follow.', '{n} pictures are still uploading; they will follow.', '1 picture still uploading…', '{n} pictures still uploading…']
for (const f of readdirSync(join(root, 'slides/src/i18n')).filter((f) => f.endsWith('.ts') && f !== 'packed.ts' && f !== 'index.ts')) {
  const cat = read(`slides/src/i18n/${f}`)
  const missing = keys.filter((k) => !cat.includes(`"${k.replace(/"/g, '\\"')}":`))
  ok(missing.length === 0, `${f}: every new string present${missing.length ? ` — missing ${missing.length}` : ''}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
