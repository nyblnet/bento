#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// iOS tray bridge rig — the untrusted-name filter, the handle routing, and the
// JS reply encoder.
//
//   node scripts/test-tray-bridge.ts
//
// WHAT THIS PROVES. These functions guard the boundary where a DOCUMENT — which
// this host treats as untrusted, since it opens any self-contained HTML file —
// reaches native file writes and native JS eval. None of the failures is
// visible: a traversal write lands before the export picker appears, so the user
// is shown a picker for a different file than the one written; an export vended
// under the open document's own name overwrites the original silently; a
// mis-encoded reply either hangs a promise forever or mutates the document on
// its way back to the page. Nothing downstream notices.
//
// The functions are EXTRACTED FROM THE REAL SOURCE rather than copied here, so
// this cannot pass against a stale duplicate of code that has since regressed.
// It fails against the pre-fix EditorViewController.swift: safeFileName did not
// exist, the encoder escaped only '"', and an export whose suggested name
// reduced onto the open file's name routed to the in-place overwrite.
//
// Two halves. The SHAPE checks read the source and always run, so a Linux CI
// runner still catches the call sites drifting back. The BEHAVIOUR checks
// compile the real function bodies and run them, and need a Swift toolchain —
// they skip cleanly without one.

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Walk up to the repo root rather than assuming a fixed depth, so the rig runs
// from wherever it is invoked.
const REL = 'tray/ios/EditorViewController.swift'
let SRC = ''
for (const from of [dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
  for (let d = from; d !== resolve(d, '..'); d = resolve(d, '..')) {
    if (existsSync(join(d, REL))) { SRC = join(d, REL); break }
  }
  if (SRC) break
}
if (!SRC) { console.log(`  FAIL  could not find ${REL}`); process.exit(1) }

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ------------------------------------------------------------------ extraction
// Brace-matched slice of one declaration out of the Swift source.
function slice(src, decl) {
  const at = src.indexOf(decl)
  if (at < 0) throw new Error(`${decl} not found in ${SRC} — did it get renamed?`)
  let depth = 0
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1)
  }
  throw new Error(`unbalanced braces reading ${decl}`)
}
const extractFunc = (src, name) => slice(src, `private func ${name}(`).replace(/^private /, '')

const swift = readFileSync(SRC, 'utf8')

// ----------------------------------------------------------------- shape checks
// Each of these is a call site that was, or could again be, the bug.
const handler = slice(swift, 'func userContentController(')

ok(!/appendingPathComponent\(suggestedFilename\)/.test(swift)
  && /appendingPathComponent\(safeFileName\(suggestedFilename\)/.test(swift),
  'the download destination filters suggestedFilename instead of trusting WebKit')

ok(!/==\s*document\.fileURL\.lastPathComponent/.test(handler),
  'read/write do not route on a bare filename comparison')
ok((handler.match(/targetsOpenDocument\(/g) || []).length === 2,
  'both read and write route through targetsOpenDocument')

ok(!/return\s+"\\""\\""/.test(swift) && /else\s*{\s*return\s+"null"\s*}/.test(swift),
  'jsString falls back to null, never to a claim that the file is empty')

// pendingExportName held the sanitised name and was then read back on the very
// next line and never again — a stored property that only a local needed, and
// one nothing stops a later edit from consulting after it has gone stale.
ok(!/private var pendingExportName/.test(swift),
  'no stored property shadows the export name the page was handed')

if (spawnSync('swiftc', ['--version']).status !== 0) {
  console.log('  skip  no Swift toolchain on this machine — behaviour checks not run')
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

// ------------------------------------------------------------------- behaviour
// exportName and targetsOpenDocument read two properties of the view controller.
// Those two references are REBOUND to harness variables so the real bodies can
// run outside UIKit; the rebinding is asserted, so a rename fails the rig loudly
// rather than quietly leaving it testing nothing.
function extractBound(name) {
  const before = extractFunc(swift, name)
  const after = before.replace(/document\.fileURL\.lastPathComponent/g, 'openName')
  if (after === before) throw new Error(`${name} no longer reads the open document's name`)
  return after
}

const harness = `import Foundation
var openName = ""
var openDocumentVended = false
${extractFunc(swift, 'safeFileName')}
${extractFunc(swift, 'jsString')}
${extractBound('exportName')}
${extractBound('targetsOpenDocument')}

func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }

// stdin: "<mode> <base64 utf8 arg>…" per line, "-" standing in for an empty
// argument so the positions never shift. stdout, per line:
//   name   <raw>                      -> "nil" | "ok <b64 name> <0|1 inside the temp dir>"
//   js     <raw>                      -> "ok <b64 literal>"
//   export <open name> <suggested>    -> "ok <b64 vended name>"
//   route  <open name> <name> <0|1>   -> "ok <b64 1|0>"
let dir = FileManager.default.temporaryDirectory
while let line = readLine(strippingNewline: true) {
    let p = line.split(separator: " ").map(String.init)
    func arg(_ i: Int) -> String {
        guard i < p.count, p[i] != "-", let d = Data(base64Encoded: p[i]),
              let s = String(data: d, encoding: .utf8) else { return "" }
        return s
    }
    switch p[0] {
    case "name":
        guard let out = safeFileName(arg(1)) else { print("nil"); continue }
        // The property exportCopy asserts, evaluated on the real URL machinery
        // for every name the filter lets through.
        let inside = dir.appendingPathComponent(out).standardizedFileURL.path
            .hasPrefix(dir.standardizedFileURL.path + "/")
        print("ok " + b64(out) + " " + (inside ? "1" : "0"))
    case "export":
        openName = arg(1)
        print("ok " + b64(exportName(arg(2))))
    case "route":
        openName = arg(1)
        openDocumentVended = arg(3) == "1"
        print("ok " + b64(targetsOpenDocument(arg(2)) ? "1" : "0"))
    default:
        print("ok " + b64(jsString(arg(1))))
    }
}
`

const work = mkdtempSync(join(tmpdir(), 'bento-tray-rig-'))
writeFileSync(join(work, 'harness.swift'), harness)
execFileSync('swiftc', ['-swift-version', '5', '-o', join(work, 'harness'), join(work, 'harness.swift')],
  { stdio: 'inherit' })

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
function run(cases) {
  const stdin = cases.map((c) => c.map((v, i) => (i === 0 ? v : b64(v) || '-')).join(' ')).join('\n') + '\n'
  const out = execFileSync(join(work, 'harness'), { input: stdin, encoding: 'utf8' })
  return out.split('\n').filter(Boolean).map((line) => {
    if (line === 'nil') return null
    const [, val, inside] = line.split(' ')
    return { value: Buffer.from(val, 'base64').toString('utf8'), inside: inside === '1' }
  })
}

// ------------------------------------------------------------- names: refused
// Every one of these reaches appendingPathComponent unchanged in the old code.
const attacks = [
  '../Documents/Notes.bento.html',   // the Documents folder is user-visible in Files
  '../../Library/Preferences/x.plist',
  '..',
  '.',
  '.hidden.html',
  '/',
  '',
  'a/../../b.html',
  'foo/',                            // lastPathComponent would hand back "foo"
]
const refused = run(attacks.map((a) => ['name', a]))
attacks.forEach((a, i) => {
  const got = refused[i]
  // "foo/" and "a/../../b.html" reduce to a legitimate single component; what
  // matters is that nothing escapes, not that every input is refused.
  if (got === null) ok(true, `refused ${JSON.stringify(a)}`)
  else ok(got.inside && !got.value.includes('/'),
    `${JSON.stringify(a)} reduced to ${JSON.stringify(got.value)}, still inside the temp dir`)
})
ok(refused[0] === null || refused[0].value === 'Notes.bento.html',
  'a traversal into Documents/ cannot address Documents/')
ok(refused[2] === null && refused[3] === null && refused[4] === null,
  '"..", "." and a dotfile are all refused outright')
ok(refused[5] === null && refused[6] === null, 'bare "/" and "" are refused')

// -------------------------------------------------------------- names: allowed
const good = ['Deck.bento.html', 'Q4 review (final).bento.html', '日本語.bento.html',
  'read-only copy.bento.html', 'a..b.html']
const allowed = run(good.map((g) => ['name', g]))
good.forEach((g, i) => {
  ok(allowed[i] !== null && allowed[i].value === g, `passes a real export name ${JSON.stringify(g)}`)
  ok(allowed[i] !== null && allowed[i].inside, `${JSON.stringify(g)} resolves inside the temp dir`)
})

// ------------------------------------------------------- handles: export names
// The vended name IS the handle, so an export may not be vended under the open
// document's name — Bento suggests a name derived from the deck TITLE, so a deck
// saved as its own title collides on an ordinary "Duplicate as new deck…".
const OPEN = 'Notes.bento.html'
const vended = run([
  ['export', OPEN, OPEN],                       // the collision that loses the original
  ['export', OPEN, 'Notes (read-only).bento.html'],
  ['export', OPEN, '../Notes.bento.html'],      // traversal that REDUCES onto it
  ['export', OPEN, ''],                         // no suggestion at all
  ['export', OPEN, '../../etc/passwd'],
])
ok(vended[0].value !== OPEN, `an export suggested "${OPEN}" is not vended as "${OPEN}"`)
ok(vended[0].value.endsWith('.bento.html'),
  `the disambiguated name keeps the double extension (${JSON.stringify(vended[0].value)})`)
ok(vended[1].value === 'Notes (read-only).bento.html', 'a non-colliding export name is untouched')
ok(vended[2].value !== OPEN, 'a traversal that reduces onto the open name is disambiguated too')
ok(vended[3].value !== OPEN && vended[3].value !== '', 'a missing suggestion still vends a usable name')
ok(vended.every((v) => !v.value.includes('/')), 'no vended export name carries a path separator')

// ------------------------------------------------------------ handles: routing
const routed = run([
  ['route', OPEN, OPEN, '1'],
  ['route', OPEN, OPEN, '0'],                   // no handle vended for it yet
  ['route', OPEN, vended[0].value, '1'],        // the export handle from above
  ['route', OPEN, 'Something else.bento.html', '1'],
  ['route', OPEN, '', '1'],                     // a write with no name at all
])
ok(routed[0].value === '1', 'the open document\u2019s own handle still writes in place')
ok(routed[1].value === '0', 'a name the page invented before any handle was vended cannot address the file')
ok(routed[2].value === '0', 'the disambiguated export handle routes to the export picker')
ok(routed[3].value === '0' && routed[4].value === '0', 'other names route to the export picker')

// ------------------------------------------------------------------- js encoder
// The payloads that actually flow: `read` returns the whole document HTML.
const payloads = [
  'plain',
  '<!doctype html>\n<html>\n  <body>hi</body>\n</html>\n',   // newline = syntax error before
  '{"t":"a \\u003cscript\\u003e b"}',                        // save.ts escapes < this way
  'quote " and backslash \\ together',
  'line \u2028 and paragraph \u2029 separator',
  'tab\tand\rreturn and \0 nul',
  'emoji 🍱 and 日本語',
]
const encoded = run(payloads.map((p) => ['js', p]))
payloads.forEach((p, i) => {
  const lit = encoded[i].value
  let round
  try { round = JSON.parse(lit) } catch { round = Symbol('unparseable') }
  ok(round === p, `round-trips ${JSON.stringify(p).slice(0, 46)}…`)
  ok(!/[\n\r\u2028\u2029]/.test(lit),
    `emits no raw line terminator for ${JSON.stringify(p).slice(0, 46)}…`)
})
// The literal must be safe to paste into the reply call, which is what the old
// hand-escaping got wrong.
const call = `window.__bentoNativeReply(1, true, ${encoded[1].value})`
ok(!/\n/.test(call), 'the assembled reply call is a single line')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
