#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

/**
 * Does the iOS text extractor agree with the one the extension ships?
 *
 * `docs/DECISIONS.md` (2026-08-16) settles that the three hosts each carry their
 * own copy of the indexer and are held together by a shared fixture corpus
 * rather than by shared code. The guarantee that buys is not "cannot diverge"
 * but "cannot diverge SILENTLY" — which is only true if something actually
 * looks. This is the thing that looks, for `home/ios`.
 *
 * It drives the REAL `library.js`: `describe()` is exported and takes its cache
 * through injectable deps, so a fake file handle is enough to run the shipping
 * code path — the title regex, the format regex, the encrypted test, the
 * preview slice and `extractText`, exactly as the extension runs them. That
 * matters more than it might look. A rig that re-implemented the reference
 * would only ever prove the re-implementation agrees with the port; when
 * `library.js` changed, both would be wrong together and the rig would stay
 * green. Importing it means the reference cannot move without this failing.
 *
 * The Swift side is compiled straight from `home/ios/BentoIndex.swift` with
 * `swiftc`, which is why that file is Foundation-only and has no UIKit in it.
 *
 * Corpus: real documents found in the repo, plus generated edge cases covering
 * the places the two languages are most likely to part company — UTF-16 versus
 * grapheme counting, JavaScript's `\s` versus ICU's, ASCII `\d` versus Unicode
 * Nd, and every budget boundary at N-1/N/N+1. When the shared corpus lands,
 * point this at it: `node scripts/test-tray-index.mjs --corpus <dir>`. It is
 * additive, not a replacement — the generated cases are cheap and the real
 * documents are the ones that catch what nobody thought to generate.
 *
 * Usage:
 *   node scripts/test-tray-index.mjs [--corpus <dir>] [--verbose]
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const VERBOSE = args.includes('--verbose')
const corpusIdx = args.indexOf('--corpus')
const EXTRA_CORPUS = corpusIdx !== -1 ? resolve(args[corpusIdx + 1]) : null

const decoder = new TextDecoder('utf-8')

/* ── the generated edge cases ─────────────────────────────────────────────── */

const MARKER = 'id="bento-doc"'
const doc = (body) => `<!doctype html><html><head><title>x</title></head><body>` +
  `<script type="application/json" ${MARKER}>${body}</script></body></html>`

function cases() {
  const out = []
  const add = (name, html) => out.push({ name, html })

  // Nothing to find.
  add('empty', '')
  add('no-marker', '<!doctype html><html><body>hello there friend</body></html>')
  // The marker with no closing script tag — the reference returns null rather
  // than running to the end of the file.
  add('marker-unterminated', `<!doctype html><body><script ${MARKER}>{"title":"Orphan text here"}`)

  // Values are taken from `:"…"`, never from keys.
  add('keys-are-not-values', doc('{"heading":"alpha bravo","charlie":"delta echo"}'))
  // Fewer than three consecutive ASCII letters = an id, a colour, a number.
  add('short-values-skipped', doc('{"a":"#ff0088","b":"12345","c":"ab","d":"real words here"}'))

  // Data URIs: 199 chars stays, 200 goes. The boundary is the whole point.
  add('data-uri-199', doc(`{"src":"data:${'A'.repeat(199)}","t":"keep this prose"}`))
  add('data-uri-200', doc(`{"src":"data:${'A'.repeat(200)}","t":"keep this prose"}`))
  // A `data:` inside a run that was too short to strip — the reference resumes
  // one character later, so the inner one is still found.
  add('data-uri-nested', doc(`{"src":"data:xx data:${'B'.repeat(400)}","t":"prose here"}`))

  // Value length: 400 units matches, 401 is skipped entirely.
  add('value-400', doc(`{"v":"${'word '.repeat(80).slice(0, 400)}"}`))
  add('value-401', doc(`{"v":"${('word '.repeat(81)).slice(0, 401)}","after":"tail words"}`))

  // Escaped quotes keep a value together.
  add('escaped-quote', doc('{"v":"she said \\"hello there\\" loudly"}'))
  add('escaped-backslash', doc('{"v":"path\\\\to\\\\somewhere useful"}'))
  // A trailing backslash cannot start a repetition, so the value never closes.
  add('trailing-backslash', doc('{"v":"dangling\\\\"}'))

  // Tags: 200 non-`>` chars strips, 201 does not.
  add('tag-200', doc(`{"v":"alpha <${'x'.repeat(198)}> bravo"}`))
  add('tag-201', doc(`{"v":"alpha <${'x'.repeat(199)}> bravo"}`))
  add('tag-nested-lt', doc('{"v":"alpha <<b> bravo charlie"}'))
  add('tag-empty', doc('{"v":"alpha <> bravo charlie"}'))

  // Entities. The Arabic-Indic digits are the ICU trap: JavaScript's `\\d` is
  // ASCII, so `&#١٢٣;` is NOT an entity and must survive.
  add('entities-named', doc('{"v":"alpha &amp; bravo &NBSP; charlie"}'))
  add('entities-numeric', doc('{"v":"alpha &#38; bravo &#1234; charlie"}'))
  add('entities-arabic-indic', doc('{"v":"alpha &#١٢٣; bravo charlie"}'))
  add('entities-malformed', doc('{"v":"alpha &notanentity bravo & charlie"}'))

  // Whitespace. NBSP and U+FEFF collapse (JavaScript `\\s`); U+200B does not.
  add('ws-nbsp', doc('{"v":"alpha  bravo charlie"}'))
  add('ws-feff', doc('{"v":"alpha﻿﻿bravo charlie"}'))
  add('ws-zwsp-kept', doc('{"v":"alpha​​bravo charlie"}'))
  add('ws-exotic', doc('{"v":"alpha   　bravo charlie"}'))
  add('ws-vertical-tab', doc('{"v":"alphabravo charlie"}'))

  // UTF-16 counting. Emoji are surrogate pairs: a grapheme-counting port
  // disagrees with the reference on every one of these.
  add('astral-emoji', doc('{"v":"alpha \u{1F600}\u{1F601}\u{1F602} bravo charlie"}'))
  add('cjk', doc('{"v":"alpha 你好世界 bravo charlie"}'))
  add('combining', doc('{"v":"alpha ééé bravo charlie"}'))
  // A 400-unit value made of astral characters — 200 characters, 400 units.
  add('astral-value-400', doc(`{"v":"${'\u{1F600}'.repeat(200)}","after":"tail words here"}`))

  // Title.
  add('title-plain', doc('{"title":"Quarterly Review","v":"body words here"}'))
  add('title-escaped', doc('{"title":"She said \\"go\\"","v":"body words here"}'))
  add('title-empty', doc('{"title":"","v":"body words here"}'))
  add('title-spaced-colon', doc('{"title"  :   "Spaced Out","v":"body words here"}'))
  add('title-too-long', doc(`{"title":"${'t'.repeat(201)}","v":"body words here"}`))
  add('title-201-boundary', doc(`{"title":"${'t'.repeat(200)}","v":"body words here"}`))

  // Format, and the reason it must scan past a non-matching key.
  add('format-slides', doc('{"format":"bento/slides","v":"body words here"}'))
  add('format-unrelated-first', doc('{"format":"text/html","format":"bento/spaces","v":"body words"}'))
  add('format-uppercase', doc('{"format":"bento/Slides","v":"body words here"}'))

  // Encrypted: no text, no preview. Both spellings.
  add('encrypted-format', doc('{"format":"bento/enc","ct":"opaque ciphertext here"}'))
  add('encrypted-attr', `<!doctype html><body data-bento-enc="1">` +
    `<script ${MARKER}>{"title":"Secret","v":"should not be extracted"}</script>` +
    `<div data-bento-preview="1">leak</div><script data-bento-preview="1"></script></body>`)

  // Preview slice, present and absent.
  add('preview-present', doc('{"v":"body words here"}') +
    `<div data-bento-preview="1"><p>page one</p></div><script data-bento-preview="1">x</script>`)
  add('preview-no-remover', doc('{"v":"body words here"}') +
    `<div data-bento-preview="1"><p>page one</p></div>`)

  // The budget, and the deliberate overshoot: the value is kept, THEN the size
  // is checked, so the last value crosses 40KB before the final slice cuts back.
  const filler = Array.from({ length: 200 }, (_, i) => `"k${i}":"${`lorem ipsum dolor sit amet ${i} `.repeat(8)}"`).join(',')
  add('budget-overshoot', doc(`{${filler}}`))
  // Astral characters straddling the 40KB cut — the one documented deviation.
  const bigAstral = Array.from({ length: 300 }, (_, i) => `"k${i}":"word ${'\u{1F600}'.repeat(80)} ${i}"`).join(',')
  add('budget-astral-cut', doc(`{${bigAstral}}`))

  return out
}

/* ── corpus ───────────────────────────────────────────────────────────────── */

function realDocuments() {
  const found = []
  const skip = new Set(['node_modules', '.git', '.worktrees', 'dist', 'dist-single'])
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.html?$/i.test(e.name)) {
        try { if (statSync(p).size > 0) found.push(p) } catch { /* raced */ }
      }
    }
  }
  walk(ROOT, 0)
  // Deterministic order, and a cap so the rig stays quick on a big working tree.
  return found.sort().slice(0, 60)
}

function buildCorpus() {
  const dir = mkdtempSync(join(tmpdir(), 'bento-index-'))
  const files = []
  for (const c of cases()) {
    const p = join(dir, `${c.name}.bento.html`)
    writeFileSync(p, c.html, 'utf8')
    files.push(p)
  }
  const generated = files.length
  for (const p of realDocuments()) files.push(p)
  if (EXTRA_CORPUS) {
    let entries = []
    try { entries = readdirSync(EXTRA_CORPUS, { withFileTypes: true }) } catch {
      console.error(`corpus directory not readable: ${EXTRA_CORPUS}`)
      process.exit(2)
    }
    for (const e of entries) if (e.isFile() && /\.html?$/i.test(e.name)) files.push(join(EXTRA_CORPUS, e.name))
  }
  return { dir, files, generated }
}

/* ── the reference, run as the extension runs it ──────────────────────────── */

async function referenceFor(files) {
  const lib = await import(pathToFileURL(join(ROOT, 'home/webext/src/library.js')).href)
  const deps = { get: async () => null, put: async () => {} }
  const out = new Map()
  for (const path of files) {
    const bytes = readFileSync(path)
    // What `listDocuments` computes and hands to describe() as the title
    // fallback — extensions stripped, both of them.
    const base = basename(path).replace(/\.bento\.html$/i, '').replace(/\.html?$/i, '')
    const file = {
      size: bytes.length,
      lastModified: 0,
      slice: (a, b) => ({ text: async () => decoder.decode(bytes.subarray(a, b)) }),
      text: async () => decoder.decode(bytes),
    }
    const d = { handle: { getFile: async () => file, name: base }, base, folder: 'corpus', rel: [] }
    const meta = await lib.describe(d, deps)
    // `sniff` is not exported; it is one `includes` on the first 64KB and the
    // rig checks the same thing rather than reaching into the module.
    const isDoc = decoder.decode(bytes.subarray(0, 64 * 1024)).includes(MARKER)
    out.set(path, {
      isDoc,
      title: meta.title,
      app: meta.app ?? null,
      encrypted: meta.encrypted,
      text: meta.text ?? null,
      preview: meta.preview ?? null,
    })
  }
  return out
}

/* ── the port, compiled ───────────────────────────────────────────────────── */

const MAIN_SWIFT = `
import Foundation

struct Row: Codable {
    let path: String
    let isDoc: Bool
    let title: String?
    let app: String?
    let encrypted: Bool
    let text: String?
    let preview: String?
}

let encoder = JSONEncoder()
for path in CommandLine.arguments.dropFirst() {
    guard let data = FileManager.default.contents(atPath: path) else { continue }
    let head = String(decoding: data.prefix(BentoIndex.headBytes), as: UTF8.self)
    let sniff = String(decoding: data.prefix(BentoIndex.sniffBytes), as: UTF8.self)
    let whole = String(decoding: data, as: UTF8.self)
    let meta = BentoIndex.describe(head: head, sniffHead: sniff, whole: whole)
    let row = Row(path: path,
                  isDoc: meta.isDocument,
                  title: meta.title,
                  app: meta.app,
                  encrypted: meta.encrypted,
                  text: meta.text,
                  preview: meta.preview)
    if let out = try? encoder.encode(row), let s = String(data: out, encoding: .utf8) {
        print(s)
    }
}
`

/**
 * `BentoIndex.swift` is Foundation-only, which is what lets this rig REALLY RUN
 * on the Linux CI runner — Swift is installed there and the file compiles
 * unchanged, so the whole diff happens on every push rather than only on a Mac.
 * That is the payoff for keeping UIKit out of it.
 *
 * The skip below is for a machine with no Swift at all. Deliberately LOUD: a
 * skip that reads like a pass is how a rig stops being run.
 */
function haveSwift() {
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function buildSwift(dir) {
  const mainPath = join(dir, 'main.swift')
  writeFileSync(mainPath, MAIN_SWIFT, 'utf8')
  const bin = join(dir, 'indexer')
  const src = join(ROOT, 'home/ios/BentoIndex.swift')
  try {
    execFileSync('swiftc', ['-O', '-o', bin, src, mainPath], { stdio: 'pipe' })
  } catch (e) {
    console.error('swiftc failed:\n' + (e.stderr?.toString() ?? e.message))
    process.exit(2)
  }
  return bin
}

function runSwift(bin, files) {
  const out = new Map()
  // Chunked so the argument list cannot overflow on a large corpus.
  for (let i = 0; i < files.length; i += 40) {
    const chunk = files.slice(i, i + 40)
    const stdout = execFileSync(bin, chunk, { maxBuffer: 512 * 1024 * 1024 }).toString()
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line)
      out.set(row.path, {
        isDoc: row.isDoc,
        // `library.js`'s describe() ALWAYS returns a title, falling back to the
        // file's base name, because its caller has already sniffed and it never
        // faces a non-document. The Swift port answers all the questions in one
        // call (the shared contract in home/fixtures) so it returns nil, and the
        // listing supplies the file name. Same behaviour, different seam — the
        // fallback is applied here so the two are compared like for like.
        title: row.title ?? basename(row.path)
          .replace(/\.bento\.html$/i, '').replace(/\.html?$/i, ''),
        rawTitle: row.title ?? null,
        app: row.app ?? null,
        encrypted: row.encrypted,
        text: row.text ?? null,
        preview: row.preview ?? null,
      })
    }
  }
  return out
}

/* ── compare ──────────────────────────────────────────────────────────────── */

const show = (v) => v === null ? 'null' : JSON.stringify(v.length > 90 ? v.slice(0, 90) + '…' : v)

function firstDifference(a, b) {
  if (a === null || b === null) return null
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? null : n
}

/**
 * The one difference that is allowed, stated narrowly enough to be a check.
 *
 * `extractText` ends with `.slice(0, 40KB)` on UTF-16 units, which can land
 * between a surrogate pair. JavaScript keeps the lone half; a Swift `String`
 * cannot hold one at all, so the port drops it — the deviation is forced by the
 * language rather than chosen, and dropping beats decoding to U+FFFD in a
 * search index either way. Recognised here as EXACTLY "js has one more unit,
 * that unit is an unpaired high surrogate, and everything before it is
 * identical", so any other disagreement about text still fails.
 */
function isSurrogateCut(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length + 1) return false
  const last = a.charCodeAt(a.length - 1)
  if (last < 0xd800 || last > 0xdbff) return false
  return a.slice(0, -1) === b
}

function compare(path, js, sw, failures, known) {
  const bad = []
  for (const field of ['isDoc', 'title', 'app', 'encrypted', 'text', 'preview']) {
    if (js[field] === sw[field]) continue
    if (field === 'text' && isSurrogateCut(js[field], sw[field])) { known.push(basename(path)); continue }
    let detail = `      js: ${show(js[field])}\n      sw: ${show(sw[field])}`
    if (typeof js[field] === 'string' && typeof sw[field] === 'string') {
      const at = firstDifference(js[field], sw[field])
      const ctx = (s) => JSON.stringify(s.slice(Math.max(0, at - 25), at + 25))
      detail = `      lengths js=${js[field].length} sw=${sw[field].length}, first differs at ${at}\n` +
               `      js …${ctx(js[field])}…\n      sw …${ctx(sw[field])}…`
    }
    bad.push(`    ${field}:\n${detail}`)
  }
  if (bad.length) failures.push(`  ${basename(path)}\n${bad.join('\n')}`)
  return bad.length === 0
}

/* ── main ─────────────────────────────────────────────────────────────────── */

if (!haveSwift()) {
  console.log('tray index: SKIPPED — no swiftc on this machine.')
  console.log('            This rig is the only thing holding home/ios/BentoIndex.swift to')
  console.log('            home/webext/src/library.js. Run it on a Mac before changing either.')
  process.exit(0)
}

const { dir, files, generated } = buildCorpus()
const bin = buildSwift(dir)
const js = await referenceFor(files)
const sw = runSwift(bin, files)

const failures = []
const known = []
let checked = 0
let withText = 0
for (const path of files) {
  const a = js.get(path), b = sw.get(path)
  if (!a || !b) { failures.push(`  ${basename(path)}\n    missing result (js=${!!a} swift=${!!b})`); continue }
  checked++
  if (a.text) withText++
  const ok = compare(path, a, b, failures, known)
  if (VERBOSE) console.log(`${ok ? 'ok  ' : 'FAIL'} ${basename(path)}`)
}

const real = files.length - generated - (EXTRA_CORPUS ? 0 : 0)
/* ── the shared corpus ────────────────────────────────────────────────────── */

/**
 * `home/fixtures/` is the corpus all three hosts answer, with `expected.json`
 * as the answer key and `home/doc-index.mjs` as the reference. It is a DIFFERENT
 * guarantee from the diff above and worth having both: that one proves this port
 * tracks the extension as it moves, this one proves all three hosts agree on one
 * frozen set of answers — including Kotlin, which nothing on this machine can run.
 *
 * It used to SKIP when the directory was absent, because it arrived with the
 * Android work and a rig that fails until an unrelated branch lands is a rig
 * people learn to ignore. It has landed, so the skip now protects nothing and
 * costs the whole check: the tray→home rename moved the corpus, this kept
 * reading `tray/fixtures`, and for weeks the rig printed "absent, skipped" in
 * green while eleven cases went untested. A path that is supposed to exist is
 * a FAILURE when it does not.
 */
/**
 * Any `expected.json` sitting in a fixtures directory elsewhere in the tree, so a
 * MOVED corpus is told apart from a genuinely absent one. Cheap: two shallow
 * levels, no full walk. (Written without the glob it describes: a literal
 * star-slash in this comment would close it early.)
 *
 * This DECIDES nothing. The policy above is absolute — absent is a failure
 * either way — and this only enriches the message, because "MISSING" sends a
 * reader looking for a deleted corpus while "MISSING, and one is sitting at X"
 * sends them to fix a path. Its ancestor in PR #405 threw instead, which aborted
 * the run before the Swift-diff summary printed and left a raw stack trace as
 * the last thing on screen — the rig read as crashed rather than stale-pathed.
 * Diagnosis belongs in the message, not in the control flow.
 *
 * From bento-team-home-ios (PR #405); `tray` dropped from the probe roots, the
 * rename having landed.
 */
function strayCorpus() {
  for (const top of ['home', 'scripts', '.']) {
    const base = join(ROOT, top)
    let entries
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      for (const probe of [join(base, e.name, 'expected.json'),
                           join(base, e.name, 'fixtures', 'expected.json')]) {
        try { readFileSync(probe); return probe.replace(ROOT + '/', '') } catch { /* keep looking */ }
      }
    }
  }
  return null
}

function sharedCorpus() {
  const dir = join(ROOT, 'home/fixtures')
  let expected
  try { expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) } catch { return null }

  const names = Object.keys(expected.cases).sort()
  const paths = names.map((n) => join(dir, 'cases', n))
  const rows = runSwift(bin, paths)
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)
  const bad = []

  for (const name of names) {
    const want = expected.cases[name]
    const r = rows.get(join(dir, 'cases', name))
    if (!r) { bad.push(`  ${name}: the port produced no answer`); continue }
    const mine = {
      isDocument: r.isDoc,
      title: r.rawTitle,
      app: r.app,
      encrypted: r.encrypted,
      hasPreview: r.preview !== null,
      textLength: r.text === null ? null : r.text.length,
      textSha256_16: r.text === null ? null : sha(r.text),
      text: r.text,
    }
    for (const key of Object.keys(want)) {
      if (JSON.stringify(want[key]) === JSON.stringify(mine[key])) continue
      bad.push(`  ${name} · ${key}: corpus says ${show(want[key])}, port says ${show(mine[key])}`)
    }
  }

  // The budgets are part of the contract too — a port that agreed on every case
  // while carrying a different TEXT_BUDGET agrees only by luck.
  const budgets = [['textBudget', 40960], ['sniffBytes', 65536], ['headBytes', 307200]]
  for (const [key, mineValue] of budgets) {
    if (expected[key] !== undefined && expected[key] !== mineValue) {
      bad.push(`  ${key}: corpus says ${expected[key]}, port uses ${mineValue}`)
    }
  }
  return { count: names.length, bad }
}

const shared = sharedCorpus()

console.log(`\ntray index: ${checked} documents compared ` +
  `(${generated} generated edge cases, ${real} from the tree${EXTRA_CORPUS ? `, corpus ${EXTRA_CORPUS}` : ''})`)
console.log(`            ${withText} yielded searchable text`)
if (known.length) {
  console.log(`            ${known.length} matched only after the documented surrogate-cut deviation ` +
    `(${known.join(', ')})`)
}

if (shared) {
  console.log(`            shared corpus (home/fixtures): ${shared.count} cases` +
    (shared.bad.length ? ` — ${shared.bad.length} DISAGREE` : ' — all agree'))
} else {
  console.error('            shared corpus (home/fixtures): MISSING — expected.json did not load.')
  console.error('            This corpus has landed; absent means a moved or broken path, not "not yet".')
  const stray = strayCorpus()
  if (stray) {
    console.error(`            It IS at ${stray} — this rig's path is stale. Update the path;`)
    console.error('            do not restore the skip that hid this for weeks.')
  }
  // exitCode, not exit(): the Swift-diff summary above has already printed and
  // the disagreement report below still needs to. A stale path must not withhold
  // the other half of the rig from the reader.
  process.exitCode = 1
}

if (failures.length || shared?.bad.length) {
  if (failures.length) {
    console.error(`\n${failures.length} disagreement(s) between library.js and BentoIndex.swift:\n`)
    console.error(failures.join('\n\n'))
  }
  if (shared?.bad.length) {
    console.error('\nDisagreements with the shared corpus (home/fixtures/expected.json):\n')
    console.error(shared.bad.join('\n'))
  }
  process.exit(1)
}
console.log('            swift port agrees with library.js on every field')
