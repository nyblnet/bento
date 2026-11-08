#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/connect on iOS and the Mac: gate 1 (home/ios/Gate1.swift) against the
 * shared conformance corpus in home/fixtures/gate1/, read from disk exactly as
 * scripts/test-gate1.ts reads it for the JavaScript reference.
 *
 *   node scripts/test-home-gate1.mjs     (GATE1_DIR=<path> to point elsewhere)
 *
 * The same rows as the reference rig:
 *   - the signed history verifies with the corpus TEST key (as the host verifies
 *     the real one with the release key), and a tampered payload doesn't
 *   - served: ONE release matches EVERY block, or UNKNOWN, and a genuine file
 *     is served under its own pins
 *   - ambiguous: two matching entries is UNKNOWN
 *   - strict (file://): both genuine saves pass, all 16 tampers refuse
 *   - history: anti-rollback
 *   - the CSP string
 * Nothing here is pinned: every verdict comes from expected.json.
 *
 * Apple platforms only; skips elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = process.env.GATE1_DIR || join(ROOT, 'home/fixtures/gate1')
const SRC = [process.env.GATE1_SRC || join(ROOT, 'home/ios/Gate1.swift')]
if (!existsSync(join(DIR, 'expected.json'))) { console.error(`home gate1: no corpus at ${DIR}`); process.exit(2) }
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { console.log('home gate1: SKIPPED — needs an Apple toolchain (CryptoKit).'); process.exit(0) }

const main = String.raw`
import CryptoKit
import Foundation
if CommandLine.arguments[1] == "--diff" {
  // one JSON line per file: what this port makes of it, for comparison with the reference
  let hist = try! JSON.parse(try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
  let skel = try! JSON.parse(try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3])))
  let exp = Gate1.StrictExpected(skeleton: Gate1.u(skel["skeleton"]!.string!), remover: skel["remover"]?.string.map(Gate1.u))
  for path in CommandLine.arguments.dropFirst(4) {
    let h = Gate1.u(String(decoding: try! Data(contentsOf: URL(fileURLWithPath: path)), as: UTF8.self))
    var o: [String: Any] = ["file": (path as NSString).lastPathComponent]
    switch Gate1.verifyServed(h, history: hist) {
    case .genuine(let v, _, let csp): o["served"] = "genuine " + v; o["csp"] = csp
    // the scanner's own throw (the reference throws here too); markupProblems's "an unterminated <script>" is an ordinary unknown
    case .unknown(let why): o["served"] = why.range(of: #"^an unterminated <[a-z]+>( start tag)? at \d+$"#, options: .regularExpression) != nil ? "throw" : "unknown"
    }
    if let b = try? Gate1.scanBlocks(h) {
      o["blocks"] = b.map { ["tag": $0.tag, "type": $0.type ?? NSNull(), "id": $0.id ?? NSNull(), "src": $0.src ?? NSNull(),
                             "preview": $0.preview, "start": $0.start, "text": Gate1.sha256hex($0.text), "tagStart": $0.tagStart, "end": $0.end,
                             "duplicate": $0.duplicate, "slash": $0.slash] as [String: Any] }
      o["markup"] = (try? Gate1.markupProblems(h)) ?? "throw"
    } else { o["blocks"] = "throw"; o["markup"] = "throw" }
    switch Gate1.verifyStrict(h, exp) { case .success: o["strict"] = "ok"; case .failure(let r): o["strict"] = r.reason }
    print(String(decoding: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), as: UTF8.self))
  }
  exit(0)
}
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
func data(_ p: String) -> Data { try! Data(contentsOf: dir.appendingPathComponent(p)) }
// a file's text as a JavaScript string: its UTF-8 decoded, then UTF-16
func text(_ p: String) -> Gate1.S { Gate1.u(String(decoding: data(p), as: UTF8.self)) }
var checks = 0, fails = 0
func ok(_ c: Bool, _ m: String) { checks += 1; if !c { fails += 1 }; print("  \(c ? "ok  " : "FAIL")  \(m)") }
let E = try! JSON.parse(data("expected.json"))
let app = E["app"]!.string!

print("the signed history (verified with the corpus TEST key, as the host verifies the release key)")
let key = Gate1.publicKey(jwk: data("test-public-key.json"))
ok(key != nil, "the test public key reads as a P-256 key")
let history = Gate1.openSigned(data("history.json"), publicKey: key!)
ok(history != nil, "history.json verifies")
let env = try! JSON.parse(data("history.json"))
let tamperedPayload = env["payload"]!.string!.replacingOccurrences(of: "1.0.0", with: "1.0.1")
let tamperedEnv = try! JSONSerialization.data(withJSONObject: ["payload": tamperedPayload, "sig": env["sig"]!.string!])
ok(Gate1.openSigned(tamperedEnv, publicKey: key!) == nil, "a tampered payload does not")
let otherKey = P256.Signing.PrivateKey().publicKey
ok(Gate1.openSigned(data("history.json"), publicKey: otherKey) == nil, "nor does the real history under another key")

print("served: ONE release must match EVERY block")
for row in E["served"]!.array! {
  let c = row["case"]!.string!
  let v = Gate1.verifyServed(text(c), history: history!)
  let want = row["verdict"]!.string! == "genuine" ? "genuine \(row["release"]!.string!)" : "unknown"
  switch v {
  case .genuine(let version, let entry, let csp):
    ok("genuine \(version)" == want, "\(c.replacingOccurrences(of: "served/", with: "")): \(want)")
    let pin = entry["pins"]!["scriptSrc"]!.array![0].string!
    ok(csp.contains("'\(pin)'") && !csp.contains("unsafe-eval") && csp.hasPrefix("default-src 'none'")
       && !(csp.components(separatedBy: ";").first { $0.contains("script-src") } ?? "").contains("*")
       && !(csp.components(separatedBy: ";").first { $0.contains("script-src") } ?? "").contains("unsafe-inline"),
       "  …served under its own pins, with no unsafe-eval or wildcard script source")
  case .unknown(let why):
    ok(want == "unknown", "\(c.replacingOccurrences(of: "served/", with: "")): \(want) (\(why))")
  }
}

print("ambiguous: two entries matching every block is UNKNOWN, never \"the first\"")
for row in E["ambiguous"]!.array! {
  let c = row["case"]!.string!
  let v = Gate1.verifyServed(text(c), history: row["history"]!)
  let got: String
  if case .genuine = v { got = "genuine" } else { got = "unknown" }
  ok(got == row["verdict"]!.string!, "\(c.replacingOccurrences(of: "served/", with: "")) under its own history: \(row["verdict"]!.string!)")
}

if let heldRows = E["held"]?.array, let names = E["histories"] {
  print("held: a file is judged against EVERY history the host holds; exactly one must match")
  var histories: [String: JSON] = [:]
  if case .object(let o) = names {
    for (name, spec) in o {
      let k = Gate1.publicKey(jwk: data(spec["key"]!.string!))
      let h = k.flatMap { Gate1.openSigned(data(spec["history"]!.string!), publicKey: $0) }
      ok(h != nil, "the \(name) history verifies with its own key")
      histories[name] = h
    }
  }
  for row in heldRows {
    let list = row["held"]!.array!.compactMap { histories[$0.string!] }
    let (v, app) = Gate1.verifyServedHeld(text(row["case"]!.string!), list)
    let got: String
    switch v { case .genuine(let ver, _, _): got = "genuine \(app ?? "?") \(ver)"; case .unknown: got = "unknown" }
    let want = row["verdict"]!.string! == "genuine" ? "genuine \(row["app"]!.string!) \(row["release"]!.string!)" : "unknown"
    var why = ""; if case .unknown(let r) = v { why = " (\(r))" }
    ok(got == want, "\(row["name"]!.string!): \(want)\(why)")
  }
}

print("strict (file://): both genuine saves pass, all 16 tampers refuse")
let se = try! JSON.parse(data("strict-expected.json"))
let expected = Gate1.StrictExpected(skeleton: Gate1.u(se["skeleton"]!.string!), remover: se["remover"]?.string.map(Gate1.u))
var tampers = 0
for row in E["strict"]!.array! {
  let c = row["case"]!.string!, want = row["ok"]! == .bool(true)
  if !want { tampers += 1 }
  switch Gate1.verifyStrict(text(c), expected) {
  case .success: ok(want, "\(c.replacingOccurrences(of: "strict/", with: "")): \(want ? "pass" : "refuse (PASSED)")")
  case .failure(let r): ok(!want, "\(c.replacingOccurrences(of: "strict/", with: "")): \(want ? "pass (refused: \(r.reason))" : "refuse (\(r.reason))")")
  }
}
ok(tampers == 16, "the corpus carries exactly the 16 tamper rows")

print("history: anti-rollback")
for row in E["history"]!.array! {
  let got = Gate1.acceptHistory(held: row["held"], incoming: row["incoming"]!, app: app)
  let want = row["ok"]! == .bool(true)
  ok((got == .ok) == want, "\(row["name"]!.string!): \(want ? "accept" : "refuse") (\(row["why"]!.string!))")
}

print("the CSP a host serves under")
let p = Gate1.hostPolicy(Gate1.Pins(history!["releases"]!.array![0]["pins"]!))
let scriptSrc = p.components(separatedBy: "; ").first { $0.hasPrefix("script-src ") } ?? ""
let parts = scriptSrc.split(separator: " ").map(String.init)
ok(parts.count == 4 && parts[1].hasPrefix("'sha256-") && parts[2].hasPrefix("'sha256-") && parts[3] == "blob:", "script-src is the two pins plus blob:, nothing else")
ok(!p.contains("unsafe-eval") && !scriptSrc.contains("unsafe-inline"), "no unsafe-eval, no unsafe-inline scripts")
ok(p.contains("object-src 'none'") && p.contains("base-uri 'none'") && p.contains("form-action 'none'"), "object-src, base-uri and form-action are 'none'")

print("the encodings (never compared across)")
let g = text("served/genuine-1.0.0.html")
let blocks = try! Gate1.scanBlocks(g)
let loader = Gate1.executableScripts(blocks).first { Gate1.sha256hex($0.text) == history!["releases"]!.array!.first { $0["version"]!.string! == "1.0.0" }!["pins"]!["blocks"]!["loader"]!.string! }
let pins100 = history!["releases"]!.array!.first { $0["version"]!.string! == "1.0.0" }!["pins"]!
ok(loader != nil, "the 1.0.0 loader's sha256 HEX of its text is its blocks pin")
ok(loader.map { Gate1.cspHash($0.text) == pins100["scriptSrc"]!.array![0].string! } == true, "and 'sha256-' + BASE64 of the same text is its scriptSrc pin")

print("\n\(checks - fails)/\(checks) checks passed")
exit(fails == 0 ? 0 : 1)
`
/**
 * The reference itself, on files nobody wrote by hand: each corpus file mutated
 * at random with exactly the things scanners split on (case, quotes, "/", NUL,
 * tabs, comments, stray tags, handlers, U+0130 that changes length when
 * lowercased). The port and kernel/src/gate1.ts must agree on every one: the
 * served verdict and release, the CSP, the problem list, every scanned block,
 * and the strict verdict. Runs whenever the reference is in the tree
 * (GATE1_REF to point elsewhere); GATE1_FUZZ sets the count.
 */
async function differential(bin, dir) {
  const refPath = process.env.GATE1_REF || join(ROOT, 'kernel/src/gate1.ts')
  if (!existsSync(refPath)) { console.log('\ndifferential: the reference is not in this tree; skipped'); return 0 }
  const ref = await import(refPath)
  const { readFileSync, readdirSync } = await import('node:fs')
  const history = JSON.parse(JSON.parse(readFileSync(join(DIR, 'history.json'), 'utf8')).payload)
  const expected = JSON.parse(readFileSync(join(DIR, 'strict-expected.json'), 'utf8'))
  const seeds = ['served', 'strict'].flatMap((d) => readdirSync(join(DIR, d)).map((f) => readFileSync(join(DIR, d, f), 'utf8')))
  const tokens = ['<script>', '</script>', '</SCRIPT >', '<SCRIPT src=x>', '<script type="module">', '<script type=Module>', '/', ' / ', '\t', '\n', '\r\n',
    '\u0000', '<!--', '-->', '<!--<script', "'", '"', '=', '>', '<', '<style>', '</style>', '<style><script></style>', ' onclick=1', ' ONLOAD="x"', '/onerror=1',
    ' type="application/bento+json"', ' type="Application/bento+json"', ' type=bento/deflate-b64', ' src=a.js', '<iframe>', '<object>', '<embed src=x>', '<base href=/>',
    '<meta http-equiv=refresh content=0>', "<meta http-equiv='Content-Security-Policy'>", 'data-bento-preview', ' id="bento-rt"', ' id=bento-rt-css',
    ' id="bento-doc"', '<title>t</title>', '<textarea><script></textarea>', 'javascript:', '\u0130', '\u0130\u0130', 'İ<script>', '\ud83d\ude00', 'ſcript', 'K',
    '\u0085', '\u00a0', '\u2028', '\u000b', '\u180e', ' type="text/javascript"', ' type="application/bento+json" src=x',
    // whitespace JavaScript's \s and the platform disagree on, standing where a space would
    '\u0085type="module"', '\u0085onload=1', '\u0085id="bento-rt"', '\u180etype="text/javascript"', '\u00a0onclick=1',
    // tag gluing: a "<" inside a tag name, where a scanner that searches sees a tag the browser doesn't
    '<p<script>', '<div<style>', '<a<!--', '<meta<style><script>', '<p<script>window.x=1</script>',
    // attributes on END tags, which the tokenizer reads (quotes and all) before dropping
    '</p a=">', '</p a="><b c=\'">\'', "</div x='>'", '</>', '</p\t/>', '</b c=">">']
  const N = Number(process.env.GATE1_FUZZ || 1500)
  const seed0 = Number(process.env.GATE1_SEED || Date.now() % 1e9)
  // mulberry32: 32-bit integer arithmetic (a float LCG loses precision and cycles)
  let st = seed0 >>> 0
  const rnd = (n) => { st = (st + 0x6D2B79F5) >>> 0; let x = st; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return (((x ^ (x >>> 14)) >>> 0) % n) }
  console.log(`\ndifferential against the reference: ${N} mutated files (GATE1_SEED=${seed0})`)
  const fdir = join(dir, 'fuzz'); (await import('node:fs')).mkdirSync(fdir)
  const files = []
  for (let k = 0; k < N; k++) {
    let t = seeds[rnd(seeds.length)]
    for (let m = 1 + rnd(3); m > 0; m--) {
      // half the time inside an open tag, just after its name, where scanners split
      const opens = [...t.matchAll(/<(script|style|meta|div|title)/gi)].map((x) => x.index + x[0].length)
      const at = opens.length && rnd(2) ? opens[rnd(opens.length)] : rnd(t.length + 1)
      const lts = [...t.matchAll(/</g)].map((x) => x.index)
      if (rnd(4) === 0) t = t.slice(0, at) + t.slice(at + 1 + rnd(6))
      // glue a tag-name prefix straight onto an existing "<": <p<script>, <meta<style>…
      else if (rnd(5) === 0 && lts.length) { const lt = lts[rnd(lts.length)]; t = t.slice(0, lt) + ['<p', '<div', '<a', '<meta', '<x-y'][rnd(5)] + t.slice(lt) }
      else t = t.slice(0, at) + tokens[rnd(tokens.length)] + t.slice(at)
    }
    // the reference judges the file AS WRITTEN, as a host reads it: UTF-8 can't hold a
    // lone surrogate a mutation leaves behind, so the bytes on disk carry U+FFFD instead
    const f = join(fdir, `f${k}.html`); writeFileSync(f, t); files.push([f, readFileSync(f, 'utf8')])
  }
  writeFileSync(join(dir, 'h.json'), JSON.stringify(history)); writeFileSync(join(dir, 'x.json'), JSON.stringify(expected))
  const lines = execFileSync(bin, ['--diff', join(dir, 'h.json'), join(dir, 'x.json'), ...files.map(([f]) => f)], { maxBuffer: 1 << 28 }).toString().trim().split('\n').map((l) => JSON.parse(l))
  const sha = async (s) => ref.sha256hex(s)
  let differ = 0, genuine = 0, thrown = 0
  for (let k = 0; k < files.length; k++) {
    const t = files[k][1], sw = lines[k]
    const want = {}
    try { const v = await ref.verifyServed(t, history); want.served = v.verdict === 'genuine' ? 'genuine ' + v.release.version : 'unknown'; if (v.verdict === 'genuine') want.csp = v.csp }
    catch { want.served = 'throw' }
    try { want.blocks = await Promise.all(ref.scanBlocks(t).map(async (b) => ({ tag: b.tag, type: b.type, id: b.id, src: b.src, preview: b.preview, start: b.start, text: await sha(b.text), tagStart: b.tagStart, end: b.end, duplicate: b.duplicate, slash: b.slash }))) }
    catch { want.blocks = 'throw' }
    try { want.markup = want.blocks === 'throw' ? 'throw' : ref.markupProblems(t) } catch { want.markup = 'throw' }
    const st = ref.verifyStrict(t, expected); want.strict = st.ok ? 'ok' : st.reason
    if (want.served.startsWith('genuine')) genuine++
    if (want.served === 'throw') thrown++
    const norm = (o) => JSON.stringify(o, Object.keys(o).sort())
    const a = { served: sw.served, csp: sw.csp, blocks: sw.blocks, markup: sw.markup, strict: sw.strict }
    const b = { served: want.served, csp: want.csp, blocks: want.blocks, markup: want.markup, strict: want.strict }
    if (JSON.stringify(a.served) !== JSON.stringify(b.served) || JSON.stringify(a.csp) !== JSON.stringify(b.csp) ||
        JSON.stringify(a.markup) !== JSON.stringify(b.markup) || JSON.stringify(a.strict) !== JSON.stringify(b.strict) ||
        JSON.stringify((a.blocks === 'throw' ? 'throw' : a.blocks.map(norm))) !== JSON.stringify((b.blocks === 'throw' ? 'throw' : b.blocks.map(norm)))) {
      differ++
      if (differ <= 3) {
        writeFileSync(join(ROOT, `gate1-differ-${k}.html`), t)
        console.log(`  FAIL  ${sw.file} differs (kept as gate1-differ-${k}.html):\n    swift ${JSON.stringify({ ...a, blocks: undefined })}\n    ref   ${JSON.stringify({ ...b, blocks: undefined })}`)
      }
    }
  }
  const okAll = differ === 0
  console.log(`  ${okAll ? 'ok  ' : 'FAIL'}  ${files.length - differ}/${files.length} agree on verdict, release, CSP, problems, blocks and strict (${genuine} still genuine, ${thrown} unterminated)`)
  // every fuzz file EITHER implementation calls genuine goes to the browser
  const called = files.flatMap(([f, t], k) => {
    const csp = lines[k].csp ?? null
    return lines[k].served.startsWith('genuine') ? [{ file: f, csp, why: `fuzz ${lines[k].file} (${lines[k].served})`, version: lines[k].served.replace(/^genuine /, '') }] : []
  })
  return (okAll ? 0 : 1) | (await browserOracle(bin, dir, called, history))
}

/**
 * THE BROWSER decides what runs. A differential against the reference can't
 * find a bug the two share; WebKit can. Each file is served from a custom scheme
 * under the CSP gate 1 gave it (plus 'report-sample'), and every script that
 * CSP refuses is recorded: an inline script, a handler or a src= that isn't the
 * release's loader or remover. Anything gate 1 calls GENUINE must cause none.
 * Standing attack rows: the U+0130 index drift and the "/" type separator.
 */
async function browserOracle(bin, dir, called, history) {
  if (process.platform !== 'darwin') return 0
  const pinsOf = (version) => history.releases.find((e) => e.version === version)?.pins.scriptSrc ?? []
  const versionOf = (served) => served.replace(/^genuine /, '')
  const { readFileSync } = await import('node:fs')
  const oracle = join(dir, 'oracle')
  execFileSync('swiftc', ['-O', '-o', oracle, join(ROOT, 'scripts/lib/gate1-oracle.swift')], { stdio: 'pipe' })
  const genuine = readFileSync(join(DIR, 'served/genuine-1.0.0.html'), 'utf8')
  const attack = (name, payload) => { const f = join(dir, `${name}.html`); writeFileSync(f, genuine.replace('</body>', payload + '</body>')); return f }
  const attacks = [
    ['U+0130 index drift (home-desktop)', attack('a-u0130', '<p>' + '\u0130'.repeat(20) + '</p><style>a{}</style><script>window.pwned=1</script>')],
    ['"/" as an attribute separator (security)', attack('a-slash', '<script /type="text/javascript" type="application/bento+json">window.pwned=2</script>')],
    ['a quoted ">" in an END tag hides a <script> (kernel)', attack('a-endtag', `</p a="><b c='">'<script>window.pwned=4</script>'>`)],
    ['"<" inside a tag name hides a <script> (this oracle)', (() => { const f = join(dir, 'a-tagname.html'); writeFileSync(f, genuine.replace('<meta charset="UTF-8">', '<meta<style><script>window.pwned=3</script></style> charset="UTF-8">')); return f })()],
  ]
  const verdictOf = (f) => JSON.parse(execFileSync(bin, ['--diff', join(dir, 'h.json'), join(dir, 'x.json'), f]).toString())
  const csp100 = verdictOf(join(DIR, 'served/genuine-1.0.0.html')).csp
  const withSample = (c) => c.replace('script-src ', "script-src 'report-sample' ")
  const E = JSON.parse(readFileSync(join(DIR, 'expected.json'), 'utf8'))
  const cases = []
  // the control: the oracle must SEE an extra script, or its silence means nothing
  cases.push({ role: 'control', file: join(DIR, 'served/extra-plain-script.html'), csp: withSample(csp100), why: 'extra-plain-script under 1.0.0\'s CSP' })
  for (const row of E.served.filter((r) => r.verdict === 'genuine')) {
    const v = verdictOf(join(DIR, row.case))
    cases.push({ role: 'genuine', file: join(DIR, row.case), csp: withSample(v.csp), why: row.case, version: row.release })
  }
  for (const [why, f] of attacks) {
    const v = verdictOf(f)
    if (v.served.startsWith('genuine')) cases.push({ role: 'called', file: f, csp: withSample(v.csp), why: `${why}: gate 1 says ${v.served}`, version: versionOf(v.served) })
    else console.log(`  ok    ${why}: gate 1 says ${v.served}, so nothing is served under a pinned CSP`)
  }
  for (const c of called) cases.push({ role: 'called', file: c.file, csp: withSample(c.csp), why: c.why, version: c.version })
  // The oracle only sees what the CSP REFUSES, so it trusts the policy it's handed.
  // Every policy it serves must be exactly hostPolicy's shape, or the run is red:
  // a weak policy must never make the oracle quiet.
  const policyProblem = (c, version) => {
    const d = Object.fromEntries(c.split(/;\s*/).map((x) => { const [k, ...v] = x.trim().split(/\s+/); return [k, v] }))
    const ss = (d['script-src'] ?? []).filter((t) => t !== "'report-sample'")
    if (JSON.stringify(d['default-src']) !== JSON.stringify(["'none'"])) return 'default-src is not none'
    // exactly THIS release's pins from the signed history (the loader's, and the
    // remover's when it has one: 0.9.0, from before previews, doesn't), then blob:
    const want = [...pinsOf(version).map((h) => `'${h}'`), 'blob:']
    if (!pinsOf(version).length || JSON.stringify(ss) !== JSON.stringify(want)) return `script-src is not ${version}'s pins and blob: (${ss.join(' ')})`
    if (/unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic|\*/.test((d['script-src'] ?? []).join(' '))) return 'script-src is weakened'
    for (const k of ['script-src-elem', 'script-src-attr', 'worker-src']) if (k in d && k !== 'worker-src') return `${k} overrides script-src`
    if (JSON.stringify(d['object-src']) !== JSON.stringify(["'none'"]) || JSON.stringify(d['base-uri']) !== JSON.stringify(["'none'"])) return 'object-src or base-uri is open'
    return null
  }
  const weak = withSample(csp100).replace('blob:', "blob: 'unsafe-inline'")
  ok0(policyProblem(withSample(csp100), '1.0.0') === null && policyProblem(weak, '1.0.0') !== null && policyProblem(csp100.replace(/'sha256-[^']+' /, ''), '1.0.0') !== null,
    "the policy check passes hostPolicy's own policy and refuses a weakened one ('unsafe-inline' added, a pin dropped)")
  const weakCases = cases.filter((c) => c.role !== 'control' && policyProblem(c.csp, c.version))
  for (const c of weakCases.slice(0, 3)) console.log(`  FAIL  not served: ${c.why} would have run under a weak policy: ${policyProblem(c.csp, c.version)}`)
  const policyOk = weakCases.length === 0
  ok0(policyOk, `every policy the oracle serves is exactly hostPolicy's shape: the release's one or two pins and blob: (${cases.length})`)
  if (!policyOk) return 1
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases.map(({ file, csp }) => ({ file, csp }))))
  const out = execFileSync(oracle, [join(dir, 'cases.json')], { maxBuffer: 1 << 26, timeout: 30 * 60 * 1000 }).toString().trim().split('\n').map((l) => JSON.parse(l))
  console.log(`\nthe browser oracle (WebKit decides what runs): ${cases.length} files`)
  let bad = 0
  const res = (k) => out[k] ?? { loaded: false, violations: [{ directive: 'no result' }] }
  const scriptV = (r) => r.violations.filter((v) => v.directive.startsWith('script-src'))
  ok0(res(0).loaded && scriptV(res(0)).length > 0, `the control: the oracle sees an extra script (${scriptV(res(0)).map((v) => v.sample).join(', ')})`) || bad++
  const gen = cases.map((c, k) => [c, res(k)]).filter(([c]) => c.role === 'genuine')
  const genBad = gen.filter(([, r]) => !r.loaded || scriptV(r).length)
  ok0(genBad.length === 0, `every genuine corpus file loads and runs only its loader and remover (${gen.length})` + (genBad.length ? `: ${genBad.map(([c]) => c.why).join(', ')}` : '')) || bad++
  const callBad = cases.map((c, k) => [c, res(k)]).filter(([c, r]) => c.role === 'called' && scriptV(r).length)
  for (const [c, r] of callBad.slice(0, 5)) {
    const keep = join(ROOT, `gate1-oracle-${c.file.split('/').pop()}`)
    writeFileSync(keep, readFileSync(c.file))
    console.log(`  FAIL  gate 1 calls it genuine, and it runs more: ${c.why} (kept as ${keep.split('/').pop()}): ${scriptV(r).map((v) => `${v.directive} ${JSON.stringify(v.sample || v.blocked)}`).join('; ')}`)
  }
  const nCalled = cases.filter((c) => c.role === 'called').length
  ok0(callBad.length === 0, `nothing else gate 1 calls genuine runs anything but its loader and remover (${nCalled} files${callBad.length ? `, ${callBad.length} DO` : ''})`) || bad++
  return bad ? 1 : 0
}
function ok0(c, m) { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); return c }

const dir = mkdtempSync(join(tmpdir(), 'bento-gate1-'))
let code = 0
try {
  writeFileSync(join(dir, 'main.swift'), main)
  execFileSync('swiftc', ['-O', '-o', join(dir, 'g'), ...SRC, join(dir, 'main.swift')], { stdio: 'pipe' })
  try { process.stdout.write(execFileSync(join(dir, 'g'), [DIR], { maxBuffer: 1 << 26 })) }
  catch (e) { process.stdout.write(e.stdout ?? ''); code = e.status || 1 }
  code = Math.max(code, await differential(join(dir, 'g'), dir))
} catch (err) { console.error('swiftc failed:\n' + (err.stderr?.toString() ?? err.message)); code = 2 }
finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
process.exit(code)
