#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home on iOS and the Mac: what the system search index holds for a
 * document, and keeping it current after a save (home/ios/SpotlightPlan.swift,
 * carried out by LibraryIndex).
 *
 *   node scripts/test-home-spotlight.mjs
 *
 * The plan runs against a simulated index that MERGES an add into an existing
 * entry (fields left unset keep their old values). That is the cautious reading
 * of CoreSpotlight, and it is why a sealed document's entry is deleted before it
 * is re-added: with the delete skipped, the old text survives and this fails.
 *
 * Apple platforms only; skips elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = [process.env.SPOTLIGHT_SRC || join(ROOT, 'home/ios/SpotlightPlan.swift')]
try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) } catch { console.log('home spotlight: SKIPPED — needs an Apple toolchain.'); process.exit(0) }

const main = String.raw`
import Foundation
typealias P = SpotlightPlan
struct Item { var title: String?; var text: String?; var description: String?; var keywords: [String]? }
var index: [String: Item] = [:]
func run(_ ops: [P.Op]) {
  for op in ops {
    switch op {
    case .delete(let ids): for id in ids { index[id] = nil }
    case .add(let es):
      for e in es {
        var it = index[e.id] ?? Item()
        it.title = e.title
        if let t = e.text { it.text = t }
        if let d = e.description { it.description = d }
        if !e.keywords.isEmpty { it.keywords = e.keywords }
        index[e.id] = it
      }
    }
  }
}
func emit(_ k: String, _ v: Any) { print("\(k)=\(v)") }
func all(_ id: String) -> String { let i = index[id]; return [i?.title, i?.text, i?.description, i?.keywords?.joined(separator: " ")].compactMap { $0 }.joined(separator: " | ") }
let path = "/docs/Q3 plan.bento.html"
let secret = "Acquisition of Contoso"
let body = "Board only. Offer price 41 per share."

// indexed while open
run([.add([P.entry(path: path, title: secret + " — Bento Slides", base: "Q3 plan", app: "slides", sealed: false, text: body, folder: "docs")])])
emit("open.hasText", all(path).contains(body))
// an unsealed save updates the text
let body2 = "Board only. Offer price 44 per share."
let e2 = P.entry(path: path, title: secret + " — Bento Slides", base: "Q3 plan", app: "slides", sealed: false, text: body2, folder: "docs")
run(P.refresh(e2, sealed: false))
emit("unsealed.updated", all(path).contains(body2) && !all(path).contains("41 per share"))
// sealed in one save: the saved <title> is now the app name; nothing extracted
let sealed = P.entry(path: path, title: "Bento Slides", base: "Q3 plan", app: "slides", sealed: true, text: body2, folder: "docs")
run(P.refresh(sealed, sealed: true))
let after = all(path)
emit("sealed.noText", !after.contains("Board only") && !after.contains("per share"))
emit("sealed.noTitle", !after.contains(secret))
emit("sealed.title", index[path]?.title ?? "nil")
emit("sealed.textNil", index[path]?.text == nil)
emit("sealed.desc", index[path]?.description ?? "nil")
emit("sealed.keywords", (index[path]?.keywords ?? []).joined(separator: ","))
// INTERRUPTED: open with text again, then a sealed save whose app dies after
// the write and before the re-index: only beforeSave ran
run([.add([P.entry(path: path, title: secret + " — Bento Slides", base: "Q3 plan", app: "slides", sealed: false, text: body, folder: "docs")])])
run(P.beforeSave(id: path, sealed: true))
emit("interrupted.clean", !all(path).contains(body) && !all(path).contains(secret))
emit("unsealed.beforeNoop", P.beforeSave(id: path, sealed: false).isEmpty)
// a sealed file with no <title>: the file name
emit("sealed.noTitleTag", P.entry(path: path, title: nil, base: "Q3 plan", app: "slides", sealed: true, text: nil, folder: "docs").title)
// a sealed document's entry never carries text, whatever is handed in
emit("sealed.dropsText", P.entry(path: path, title: "x", base: "b", app: nil, sealed: true, text: "leak", folder: "f").text == nil)
// a walk removes what it no longer finds
let gone = P.removals(before: [path, "/docs/b.bento.html", "/docs/c.bento.html"], after: ["/docs/b.bento.html"])
emit("walk.removals", gone.sorted().joined(separator: ","))
run([.delete(gone)])
emit("walk.gone", index[path] == nil)
`
const dir = mkdtempSync(join(tmpdir(), 'bento-spotlight-'))
let out
try {
  writeFileSync(join(dir, 'main.swift'), main)
  execFileSync('swiftc', ['-O', '-o', join(dir, 'a'), ...SRC, join(dir, 'main.swift')], { stdio: 'pipe' })
  out = Object.fromEntries(execFileSync(join(dir, 'a')).toString().trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)))
} catch (err) { console.error('swiftc or run failed:\n' + (err.stderr?.toString() ?? err.message)); process.exit(2) }
finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
console.log('after a save:')
ok(out['open.hasText'] === 'true', 'an open document is indexed with its text')
ok(out['unsealed.updated'] === 'true', 'an ordinary save replaces the text, and the old text is gone')
ok(out['sealed.noText'] === 'true' && out['sealed.textNil'] === 'true', 'a document sealed in one save: none of its text is left in the index')
ok(out['sealed.noTitle'] === 'true' && out['sealed.title'] === 'Bento Slides', "and none of its title: the entry carries the saved file's own neutral title")
ok(out['sealed.desc'] === 'Encrypted Bento document' && out['sealed.keywords'] === 'bento', 'with a fixed description and no keywords from the document')
ok(out['sealed.noTitleTag'] === 'Q3 plan', 'a sealed file with no title shows its file name')
ok(out['sealed.dropsText'] === 'true', 'a sealed entry never carries text, whatever it is handed')
ok(out['interrupted.clean'] === 'true', 'a sealed save interrupted between the write and the re-index: nothing from before is left')
ok(out['unsealed.beforeNoop'] === 'true', 'an ordinary save touches nothing before it is written')
console.log('a full walk:')
ok(out['walk.removals'] === '/docs/Q3 plan.bento.html,/docs/c.bento.html', 'documents no longer found (deleted, or moved out of a granted folder) are removed')
ok(out['walk.gone'] === 'true', 'and their entries leave the index')
console.log('LibraryIndex carries the plan out:')
const lib = readFileSync(join(ROOT, 'home/ios/LibraryIndex.swift'), 'utf8')
const ed = readFileSync(join(ROOT, 'home/ios/EditorViewController.swift'), 'utf8')
ok(/apply\(SpotlightPlan\.refresh\(/.test(lib), 'refresh() applies the save plan')
ok(/SpotlightPlan\.removals\(/.test(lib) && /apply\(\[\.delete\(gone\)/.test(lib), 'reindex() deletes what the walk no longer finds, before adding')
ok(!/attrs\.textContent = doc\./.test(lib), 'every entry is built by SpotlightPlan, never straight from the document')
ok(/if ok, let url = self\?\.document\.fileURL \{ LibraryIndex\.shared\.refresh\(url\) \}/.test(ed), 'the editor refreshes the entry after each successful save')
{
  const pre = ed.indexOf('LibraryIndex.shared.beforeSave(document.fileURL, sealed: sealed)')
  const dirty = ed.indexOf('self.document.updateChangeCount(.done)')
  const save = ed.indexOf('self.document.save(to: self.document.fileURL')
  ok(pre > 0 && dirty > pre && save > dirty && /let sealed = BentoIndex\.isEncrypted\(/.test(ed),
    'the editor reads whether the outgoing file is sealed, and marks it changed and writes it only inside beforeSave')
}
ok(/if waitingWrite \{ queuedWrites\.append/.test(lib), 'a write arriving while a sealed one waits on its delete queues behind it')
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
