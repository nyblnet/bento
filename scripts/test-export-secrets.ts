#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Export-safety rig.
//
//   node scripts/test-export-secrets.ts     (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Two properties of every path a person can use to send a
// deck somewhere — save-as, share copy, template, the JSON on the clipboard:
//
//   1. NO CAPABILITY TRAVELS BY ACCIDENT. Everything under `doc.collab` is a
//      bearer token. `ownerPriv` revokes members, `writerPriv` writes to the
//      room, and the symmetric `key` decrypts every frame and blob the relay
//      has ever stored. An export that forgets one hands that power to whoever
//      receives the file, and the file looks completely ordinary afterwards.
//   2. A PASSWORD IS HONOURED. `serializeFile` writes the document in the
//      clear; `serializeAuto` encrypts it when a password is active. They are
//      one identifier apart and nothing at runtime complains.
//
// Both failures are silent AND unrecoverable — the copy is already on somebody
// else's disk. Measured, 2026-08-09, before this rig existed: "Copy document
// JSON" put ownerPriv, writerPriv and the room key on the clipboard under a
// tooltip that recommended pasting it into an AI chat, and "Save as template…"
// called serializeFile, so a password-protected deck exported a plaintext
// template that still THUMBNAILED as locked (the preview veto fired correctly,
// which is what made it look protected).
//
// This rig reads SOURCE. slides/src/editor/editor.ts cannot be imported under
// node — extensionless bundler imports, DOM at module scope — and both rules
// are decisions about which function a call site reaches, which is exactly
// what source shows. The encryption itself is pinned by scripts/test-preview.ts
// and the splice contract by scripts/shell-gate.mjs.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

// --- reading the source -----------------------------------------------------

/**
 * Blank out comments and string bodies while keeping every offset, so brace
 * matching cannot be thrown by a `{` that lives inside a message, a comment or
 * a template. Offsets stay 1:1 with the original, which is what gets sliced.
 */
function mask(src: string): string {
  const out = src.split('')
  const blank = (i: number) => { if (src[i] !== '\n') out[i] = ' ' }
  // template-literal nesting: `${ … }` drops back to code, and code inside it
  // may open another template
  const stack: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const two = src.slice(i, i + 2)
    const inTemplate = stack[stack.length - 1] === '`'
    if (!stack.length && two === '//') {
      while (i < src.length && src[i] !== '\n') blank(i++)
      continue
    }
    if (!stack.length && two === '/*') {
      while (i < src.length && src.slice(i, i + 2) !== '*/') blank(i++)
      blank(i); blank(i + 1); i += 2
      continue
    }
    if (c === '\\' && stack.length) { blank(i); blank(i + 1); i += 2; continue }
    if (!stack.length && (c === '"' || c === "'" || c === '`')) { stack.push(c); i++; continue }
    if (stack.length && c === stack[stack.length - 1]) { stack.pop(); i++; continue }
    if (inTemplate && two === '${') { stack.push('}'); i += 2; continue }
    if (stack[stack.length - 1] === '}' && c === '}') { stack.pop(); i++; continue }
    if (stack.length) blank(i)
    i++
  }
  return out.join('')
}

/** Source of every function/method body in `src`, keyed by name. */
function bodies(src: string): Map<string, string> {
  const masked = mask(src)
  const found = new Map<string, string>()
  // class methods (two-space indent) and module-level functions
  const decl = /^(?:  (?:private |public |protected )?(?:static )?(?:async )?([A-Za-z_$][\w$]*)\s*\(|(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)\s*\()/gm
  for (const m of masked.matchAll(decl)) {
    const name = m[1] ?? m[2]
    // Step over the parameter list first: `opts: { keepRoom?: boolean } = {}`
    // otherwise reads as the body, and the checks below then pass vacuously
    // against a two-word type literal.
    let p = m.index! + m[0].length - 1
    for (let depth = 0; p < masked.length; p++) {
      if (masked[p] === '(') depth++
      else if (masked[p] === ')' && --depth === 0) break
    }
    const open = masked.indexOf('{', p)
    if (open < 0) continue
    let depth = 0
    let i = open
    for (; i < masked.length; i++) {
      if (masked[i] === '{') depth++
      else if (masked[i] === '}' && --depth === 0) break
    }
    found.set(name, src.slice(open, i + 1))
  }
  return found
}

const EDITOR = 'slides/src/editor/editor.ts'
const editorSrc = read(EDITOR)
const editor = bodies(editorSrc)
const editorMasked = mask(editorSrc)

// The parse is load-bearing for every check below: a rename that makes it find
// nothing would turn this whole file green.
ok(editor.size > 40 && editor.has('copyDocJson') && editor.has('saveAsTemplate'),
  `parsed ${editor.size} function bodies out of ${EDITOR}`)

const body = (name: string): string => {
  const b = editor.get(name)
  if (b === undefined) { failures++; checks++; console.error(`  ✗ ${EDITOR} has no ${name}() — this rig cannot check it`) }
  return b ?? ''
}

// --- 1. the strip list is complete ------------------------------------------
//
// Derived from the MODEL, not typed out here: a new private field added to
// `collab` fails this until the stripper covers it.

console.log('\nthe strip list')

const collabBlock = (() => {
  const src = read('slides/src/model.ts')
  const start = src.indexOf('  collab?: {')
  const masked = mask(src)
  let depth = 0
  let i = masked.indexOf('{', start)
  const open = i
  for (; i < masked.length; i++) {
    if (masked[i] === '{') depth++
    else if (masked[i] === '}' && --depth === 0) break
  }
  return src.slice(open, i + 1)
})()

const collabFields = [...collabBlock.matchAll(/^ {4}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1])
// Private key material: anything ending in -Priv, plus the delegation keypair.
// `key` and `room` are the read capability — a copy that must follow the live
// session keeps them, so they are only covered by the drop-the-block default.
const privateFields = collabFields.filter((f) => /Priv$/.test(f) || f === 'invite')

ok(collabFields.includes('key') && privateFields.length >= 3,
  `model.ts declares ${collabFields.length} collab fields, ${privateFields.length} of them private (${privateFields.join(', ')})`)

const stripper = body('stripCollabSecrets')
for (const f of privateFields) {
  ok(new RegExp(`delete doc\\.collab\\.${f}\\b`).test(stripper),
    `stripCollabSecrets drops ${f} from a copy that keeps the room`)
}
ok(/delete doc\.collab\b(?!\.)/.test(stripper),
  'stripCollabSecrets drops the whole block by default — the room key is a capability too')

// --- 2. no export carries the session ---------------------------------------

console.log('\nexports')

// Everything that hands the document to somebody else. Named rather than
// discovered so that a DELETED strip and a deleted export do not look alike.
const EXPORTS = ['savePresentationPackage', 'saveReaderCopy', 'saveEditorCopy', 'saveAsTemplate', 'copyDocJson']
for (const name of EXPORTS) {
  ok(/stripCollabSecrets\(/.test(body(name)),
    `${name}() strips the session before the copy leaves`)
}

ok(!/writeText\(JSON\.stringify\(this\.store\.doc\)/.test(body('copyDocJson')),
  'copyDocJson() copies a stripped CLONE, never the live document')

// The catch-all: any method that clones the document and then hands it to an
// outbound sink is an export, named in the list above or not. saveAsNewDeck is
// the one clone that legitimately keeps a session — it mints a brand new one.
const SINK = /writeUpdatedFileAs?\(|clipboard\.writeText\(|downloadFile\(/
for (const [name, src] of editor) {
  if (!/JSON\.parse\(JSON\.stringify\(this\.store\.doc\)\)/.test(src) || !SINK.test(mask(src))) continue
  ok(/stripCollabSecrets\(|await mintCollab\(\)/.test(src),
    `${name}() clones the document and sends it — and settles its collab first`)
}

// The paste side of the JSON round-trip. Adopting the pasted block would wipe
// the user's own credentials (our copy sends none) or move the deck into a
// room that came from somewhere else.
const paste = body('openReplaceJson')
ok(/const keep = this\.store\.doc\.collab/.test(paste) &&
  /next\.collab = keep/.test(paste) && /delete next\.collab/.test(paste),
  'openReplaceJson() keeps THIS document\'s collab instead of adopting the pasted one')
// …and settles it BEFORE the swap: replaceDoc's events reach the sync session
// synchronously, so a fix-up afterwards would already have re-attached the
// session to the pasted credentials.
// Masked, because the comment above the code names both of them.
const pasteCode = mask(paste)
ok(pasteCode.indexOf('next.collab = keep') < pasteCode.indexOf('replaceDoc(') && !/loadDoc/.test(pasteCode),
  'openReplaceJson() decides the session before replaceDoc, not after')

// --- 3. no user-facing path writes plaintext --------------------------------

console.log('\npasswords')

// serializeFile has exactly one legitimate caller left in the app: the
// documented window.bento.serialize() tooling hook, which is synchronous by
// contract and never writes a file for a person.
const callers = ['slides/src/editor/editor.ts', 'slides/src/main.ts', 'slides/src/save.ts', 'slides/src/autosave.ts', 'slides/src/present.ts']
  .filter((f) => /\bserializeFile\(/.test(mask(read(f))))
ok(callers.length === 1 && callers[0] === 'slides/src/main.ts',
  `serializeFile() is called from ${callers.join(', ') || 'nowhere'} — and only there`)
ok(/serialize:\s*\(\)\s*=>\s*\{[^}]*\bserializeFile\(store\.doc\)/.test(read('slides/src/main.ts')),
  'that one caller is window.bento.serialize(), the documented tooling hook')

ok(!/\bserializeFile\b/.test(editorMasked),
  'editor.ts does not even import serializeFile — every path in it writes a real file for a person')

for (const [name, src] of editor) {
  for (const call of mask(src).matchAll(/writeUpdatedFileAs?\(/g)) {
    const arg = src.slice(call.index! + call[0].length, call.index! + call[0].length + 22)
    ok(arg.startsWith('await serializeAuto('),
      `${name}() writes through serializeAuto — an active password reaches the file`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
