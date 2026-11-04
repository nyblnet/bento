#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The text of #bento-doc: picture data LAST, on its own line (kernel/src/save.ts docText).
//
//   node scripts/test-doc-layout.ts
//
// WHY. The block was one line of JSON with `assets` wherever its key fell; one
// photo made that line megabytes of base64 mixed in with the slides, and an
// agent reading the file line by line (as the Tooling note invites) cannot stop
// partway through a line. Now `assets` is always the last key and starts its
// own line; the note says to stop before it.
//
// WHAT THIS PROVES
//   1. docText: no assets → exactly JSON.stringify (one line, every app's
//      output unchanged); with assets → two lines, the second starting
//      "assets":, parsing back to the same document with assets last and every
//      other key in its order; a nested "assets" (an embedded document) stays
//      on line 1
//   2. the real write path (encodeDocBody, plain) writes docText; a password
//      still writes an envelope, untouched by the layout
//   3. both plain save paths go through docText, and none stringifies the
//      document into the block on its own
//   4. the shared recovery key (docfields.ts docContentKey, spaces' and dash's)
//      is the same for a document and for that document saved and read back,
//      wherever `assets` sat — so the move cannot raise a Restore banner by
//      itself (slides' own key, and a real save → reopen, are in
//      test-slides-doc-layout-browser.mjs)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configureApp } from '../kernel/src/app.ts'
import { docText, encodeDocBody, setEncryptionPassword } from '../kernel/src/save.ts'
import { docContentKey } from '../kernel/src/docfields.ts'

const FAILS: string[] = []
const ok = (cond: boolean, name: string, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 200) : ''}`)
}
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8')

const PNG = 'data:image/png;base64,' + 'A'.repeat(5000)
const base = () => ({ $schema: 'x', format: 'bento/slides', version: 1, title: 't', slides: [{ id: 's', elements: [] }] })

console.log('the layout')
{
  const plain = base()
  ok(docText(plain) === JSON.stringify(plain), 'no assets: exactly JSON.stringify, one line')
  const withPics = { ...base(), assets: { a1: PNG }, collab: { on: false } }
  const text = docText(withPics)
  const lines = text.split('\n')
  ok(lines.length === 2 && lines[1].startsWith('"assets":'), `with assets: two lines, the second starting "assets": (${lines.length} lines)`)
  ok(!lines[0].includes('AAAAAAAAAA') && lines[0].length < 200, `line 1 carries no picture data (${lines[0].length} chars of ${text.length})`)
  ok(JSON.stringify(JSON.parse(text)) === JSON.stringify({ ...base(), collab: { on: false }, assets: { a1: PNG } }),
    'it parses back to the same document, assets last, every other key in its order')
  const early = docText({ assets: { a1: PNG }, ...base() })
  ok(early.split('\n')[1].startsWith('"assets":') && Object.keys(JSON.parse(early)).pop() === 'assets', 'assets that came FIRST are still written last')
  ok(JSON.stringify(JSON.parse(docText({ assets: {} }))) === '{"assets":{}}', 'a document of nothing but assets is still valid JSON')
  const nested = docText({ ...base(), slides: [{ id: 's', elements: [{ id: 'e', type: 'embed', doc: { assets: { n: 'inner' } } }] }], assets: { a1: PNG } }).split('\n')
  ok(nested.length === 2 && nested[0].includes('"assets":{"n":"inner"}'), 'an embedded document\'s own "assets" stays on line 1')
}

console.log('\nthe write path')
{
  configureApp({ appName: 'Bento Slides', format: 'bento/slides', shellName: 'Bento_Slides.bento.html' } as never)
  const d = { ...base(), assets: { a1: PNG } }
  ok(await encodeDocBody(d as never) === docText(d), 'a plain save writes docText')
  setEncryptionPassword('correct horse')
  const env = JSON.parse(await encodeDocBody(d as never))
  ok(env.format === 'bento/enc' && !JSON.stringify(env).includes('"assets"'), 'with a password it is still one envelope; the layout never reaches ciphertext')
  setEncryptionPassword(null)
  const k = read('kernel/src/save.ts')
  ok(/return serializeBody\(shell, docText\(doc\), doc\)/.test(k) && /\n {2}return docText\(doc\)\n\}/.test(k) && !/serializeBody\(shell, JSON\.stringify\(/.test(k),
    'both plain save paths (serializeWith, encodeDocBody) write docText, and none stringifies the document on its own')
}

console.log('\nthe recovery key')
{
  const { slides, ...head } = base()
  const mid = { ...head, assets: { a1: PNG }, slides, collab: { on: false }, modified: 1 }
  const reread = JSON.parse(docText(mid))
  ok(Object.keys(mid).join() !== Object.keys(reread).join() && Object.keys(reread).pop() === 'assets', 'saving moves assets: the key order differs once read back')
  ok(docContentKey(mid, {}) === docContentKey(reread, {}), 'the kernel recovery key is unchanged by it (keys are compared sorted)')
}

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nall checks passed')
process.exit(FAILS.length ? 1 : 0)
