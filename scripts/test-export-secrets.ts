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

// ---------------------------------------------------------------------------
// EVERY APP, NOT JUST SLIDES.
//
// This rig was written when slides shipped the owner private key on the
// clipboard, and every path in it above is hardcoded to slides/. So when
// bento/spaces grew a "Copy document JSON" of its own it reintroduced the
// identical bug — `JSON.stringify(store.doc, null, 2)`, credentials included,
// under a note inviting the copy — and the rig that exists to prevent exactly
// this was structurally incapable of seeing it. Measured on the shipped build:
// ownerPriv, key and room all present in what reached the clipboard.
//
// A guard that covers one app of four is a guard against one app's mistakes.

console.log('\nclipboard exports, in every app that has one')

const CLIP_APPS = ['spaces', 'dash', 'type']
for (const app of CLIP_APPS) {
  for (const file of ['about.ts', 'main.ts', 'editor.ts']) {
    const rel = `${app}/src/${file}`
    let src: string
    try { src = read(rel) } catch { continue }
    const masked = mask(src)
    // any clipboard write that stringifies a document must go through a
    // stripper first. The shape is deliberately loose — it is looking for a
    // NEW leak, not enforcing one spelling.
    for (const m of masked.matchAll(/writeText\(([^)]*)/g)) {
      const arg = src.slice(m.index! + 'writeText('.length, m.index! + m[0].length + 60)
      if (!/JSON\.stringify/.test(arg)) continue
      ok(/docForExport|stripCollab|forExport|Export\(/.test(arg),
        `${rel}: a clipboard copy of the document goes through a stripper, not the raw doc`)
    }
  }
}

// …and the stripper, where it exists, must REMOVE rather than allow-list, so a
// private field added to CollabCreds later is covered without anyone acting.
for (const app of CLIP_APPS) {
  let src: string
  try { src = read(`${app}/src/model.ts`) } catch { continue }
  if (!/docForExport/.test(src)) continue
  const body = src.slice(src.indexOf('export function docForExport'))
  ok(/\.\.\.rest|delete .*collab|const \{ collab/.test(body.slice(0, 400)),
    `${app}/src/model.ts: docForExport strips by REMOVING collab, not by listing fields to keep`)
}

// ---------------------------------------------------------------------------
// SHARE COPIES, in every app that can send one.
//
// The clipboard checks above are about a copy that must carry NO capability.
// An invite is the opposite case and the harder one: it has to carry SOME
// capability or it cannot join, so "did this path strip?" is not the question —
// the question is WHICH capability it kept.
//
// Measured on bento/spaces, 2026-08-22: "Invite someone…" was
// `invite: () => { void this.saveAs('copy') }`, and `saveAs` serializes
// `store.doc`. Everyone invited to a space therefore received `ownerPriv` —
// the root key of the room, which signs writes AND revocations — so an invited
// person could remove the person who invited them. The hint under the button
// read "Saves a copy that joins this session", which was true and was not the
// whole truth.
//
// What is checked here is the SHAPE of the call site: a share copy is written
// from a DERIVED document, never from the live one. The cryptographic proof
// that the derived document holds no owner key lives in
// scripts/test-spaces-invite.ts, which runs the real functions against real
// keys; this is the cheap check that stops a new button from routing around
// them.

console.log('\nshare copies')

/**
 * The body of a MODULE-LEVEL `export function NAME(…)`.
 *
 * `bodies()` above cannot be used here and the reason is worth recording: its
 * declaration pattern also matches any two-space-indented `name(` — which in a
 * class file is a method and in a module file is an ordinary CALL. share.ts
 * calls `stripCollabSecrets(out, …)` from inside two other functions, so the
 * map's last-wins would hand back a call site, and the checks below would then
 * pass or fail against the wrong text. Anchoring on `export function` is exact.
 */
function exportedBody(src: string, name: string): string {
  const masked = mask(src)
  const decl = new RegExp(`^export (?:async )?function ${name}\\s*\\(`, 'm')
  const m = decl.exec(masked)
  if (!m) return ''
  let p = m.index + m[0].length - 1
  for (let depth = 0; p < masked.length; p++) {
    if (masked[p] === '(') depth++
    else if (masked[p] === ')' && --depth === 0) break
  }
  const open = masked.indexOf('{', p)
  if (open < 0) return ''
  let depth = 0
  let i = open
  for (; i < masked.length; i++) {
    if (masked[i] === '{') depth++
    else if (masked[i] === '}' && --depth === 0) break
  }
  return src.slice(open, i + 1)
}

const SHARE_APPS = ['spaces']
for (const app of SHARE_APPS) {
  const rel = `${app}/src/share.ts`
  let src: string
  try { src = read(rel) } catch {
    ok(false, `${rel} exists — share copies must be minted in one place`)
    continue
  }
  const stripper = exportedBody(src, 'stripCollabSecrets')
  ok(!!stripper, `${rel}: found stripCollabSecrets() — the checks below are worthless without it`)
  ok(/delete doc\.collab\.ownerPriv\b/.test(stripper), `${rel}: the stripper drops ownerPriv`)
  ok(/delete doc\.collab\.writerPriv\b/.test(stripper), `${rel}: the stripper drops writerPriv`)
  ok(/delete doc\.collab\.invite\b/.test(stripper), `${rel}: the stripper drops any invite it holds`)
  ok(/delete doc\.collab\b(?!\.)/.test(stripper),
    `${rel}: the stripper drops the whole block by default — the room key is a capability too`)

  const inviteFn = exportedBody(src, 'inviteCopy')
  ok(/stripCollabSecrets\(\s*out\s*,\s*\{\s*keepRoom:\s*true\s*\}\s*\)/.test(inviteFn),
    `${rel}: inviteCopy strips before it delegates`)
  ok(/mintInvite\(/.test(inviteFn), `${rel}: inviteCopy mints a SCOPED invite rather than passing the room's own keys`)
  const masked = mask(inviteFn)
  ok(masked.indexOf('stripCollabSecrets(') < masked.indexOf('mintInvite('),
    `${rel}: it strips FIRST — a stray writerPriv beside an invite is a second, unrevokable way in`)
  ok(!/ownerPriv\s*[,}]/.test(mask(exportedBody(src, 'readerCopy'))),
    `${rel}: readerCopy never re-attaches a private key`)

  // The call site. A share copy must reach the file through a writer that takes
  // a DOCUMENT — the ordinary save path serializes the open one.
  const ed = read(`${app}/src/editor.ts`)
  const share = bodies(ed).get('shareCopy') ?? ''
  ok(!!share, `${app}/src/editor.ts has a shareCopy()`)
  ok(/inviteCopy\(|readerCopy\(/.test(share),
    `${app}: the share button derives its document (inviteCopy/readerCopy)`)
  ok(!/saveAs\(/.test(mask(share)),
    `${app}: the share button does NOT reach the ordinary copy path — that path writes store.doc, credentials and all`)
  ok(/onShareCopy\?\.\(/.test(share), `${app}: it writes through the share-copy hook`)

  // …and that hook must encrypt, and must not become the ⌘S target.
  const main = read(`${app}/src/main.ts`)
  const hook = main.slice(main.indexOf('editor.onShareCopy'), main.indexOf('editor.onShareCopy') + 400)
  ok(/serializeAuto\(/.test(hook),
    `${app}: onShareCopy writes through serializeAuto — an active password reaches the shared copy`)
  ok(!/keepHandle:\s*true/.test(hook),
    `${app}: onShareCopy does not retain the file handle — the next ⌘S must not overwrite the copy with the full document`)
}

// --- the OTHER half of the round trip: pasting one back in -------------------
//
// Stripping `collab` out of "Copy document JSON" is right, and it changed what
// the documented AI round trip does on the way BACK. Both directions were
// wrong; the strip turned the first from rare into routine.
//
//   · a STRIPPED paste — now the ordinary case — carried no credentials, so
//     replacing SILENTLY ENDED the live session. Measured before the fix:
//     sharing on / room `w-abc` before, sharing off / room gone after, nothing
//     on screen, peers still editing.
//   · a paste carrying SOMEBODY ELSE'S credentials silently JOINED their room.
//     Measured: `w-MINE` became `w-THEIRS`, the next edit went out under their
//     key, and they hold the owner key that can revoke.
//
// The rule is the one this file's own fix draws: a saved FILE carrying its own
// capability is the design, and pasted text is not a file. So the room belongs
// to the open workbook and the paste replaces content only. A dropped or opened
// workbook is unaffected and still adopts its own room.
{
  const about = readFileSync(new URL('../dash/src/about.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  ok(/const keep = \(store\.doc as \{ collab\?: unknown \}\)\.collab/.test(about),
    'the paste path reads the OPEN workbook’s credentials')
  ok(/collab: keep/.test(about),
    'and carries them onto the pasted document, so a stripped paste cannot end the session ' +
    'and a stranger’s paste cannot move it')
  ok(/replaceWorkbook\(hooks, merged\)/.test(about),
    'and it is the merged document that replaces, not the pasted one')

  // NOT in replaceWorkbook itself: "Duplicate as new workbook" goes through it
  // and mints fresh credentials deliberately. Folding the rule in there would
  // make a fork keep its ancestor's room — the opposite of what it is for.
  const dup = about.slice(about.indexOf('function replaceWorkbook'))
  ok(!/collab: keep/.test(dup),
    'and replaceWorkbook itself is untouched, so Duplicate-as-new-workbook still forks its identity')
}

// --- the OTHER button with that label -----------------------------------------
//
// dash has TWO "Copy document JSON" buttons. #338 fixed About's. This is the
// one on the REFUSAL surface — the screen shown when a file cannot be parsed —
// and it was missed by the fix and by this rig alike, because it copies the raw
// embedded block rather than a stringified document, so a check looking for a
// document reaching a clipboard cannot see it.
//
// It also PRINTS that block on screen, and an error screen is the thing people
// screenshot and paste into a chat window. A file whose `format` string is not
// `bento/dash` — a slides deck, a space — refuses here and is perfectly good
// JSON with live keys in it. (A newer VERSION does not refuse: format
// additivity means it opens. Checked rather than assumed.)
//
// Parse what parses, strip through the SAME `docForExport`, and when the block
// is not JSON at all leave it alone and SAY so — recovering somebody's data
// matters more than tidiness, and "Save an untouched copy" beside it is the
// byte-exact route regardless.
{
  const main = readFileSync(new URL('../dash/src/main.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  const gate = main.slice(main.indexOf('function refuse('), main.indexOf('function refuse(') + 3000)

  ok(/docForExport\(/.test(gate),
    'the refusal screen strips through docForExport — the same stripper, not a second one')
  ok(!/writeText\(raw\)/.test(gate),
    'and the clipboard no longer gets the raw block with the keys still in it')
  ok(/textContent = shown\./.test(gate),
    'and the block PRINTED on screen is the stripped one too — an error screen gets screenshotted')
  ok(/catch \{ return \{ text: raw, safe: false \} \}/.test(gate),
    'an unparseable block still yields its raw text, because recovering the data is what this screen is for')
  ok(/dx-gate-warn/.test(gate) && /take care where you paste this/.test(gate),
    'and in that case it says the keys could not be removed, rather than leaving it to be discovered')
  ok(/Save an untouched copy/.test(gate),
    'with the byte-exact route still offered beside it, which is why stripping here costs nothing')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
