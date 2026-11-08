#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Outside-edit guard in a REAL browser (kernel/src/save.ts, "outside edits").
//
//   node scripts/test-disk-change-browser.mjs   (PLAYWRIGHT_MODULE, as in CI)
//
// scripts/test-disk-change.ts proves the logic against a fake handle. What a
// fake cannot prove is the false-positive question: does the stamp Chromium
// reports through getFile() after OUR createWritable()/close() match the stamp
// it reports on the next read, every time? Here the real save.ts runs in
// Chromium against real FileSystemFileHandles (the origin-private file system,
// the same FileSystemFileHandle type a picker returns), and a SECOND handle to
// the same file plays the other program.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const dir = mkdtempSync(join(tmpdir(), 'disk-change-'))
const entry = join(dir, 'entry.ts'), out = join(dir, 'bundle.js')
writeFileSync(entry, `import * as m from ${JSON.stringify(join(ROOT, 'kernel/src/save.ts'))}\n;(globalThis as any).__save = m\n`)
execFileSync(join(ROOT, 'slides/node_modules/.bin/esbuild'), [entry, '--bundle', '--format=iife', '--log-level=error', `--outfile=${out}`])
const bundle = readFileSync(out, 'utf8')
rmSync(dir, { recursive: true, force: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH })
try {
  const page = await browser.newPage()
  // a secure origin (the file system API needs one), served from memory
  await page.route('https://disk-change.test/**', (r) => r.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><script id="bento-doc" type="application/json">{}</script><script>' + bundle + '</script>',
  }))
  await page.goto('https://disk-change.test/d.bento.html')
  const r = await page.evaluate(async () => {
    const m = globalThis.__save
    const root = await navigator.storage.getDirectory()
    const h = await root.getFileHandle('d.bento.html', { create: true })
    const w0 = await h.createWritable(); await w0.write('<html>start'); await w0.close()
    const other = await root.getFileHandle('d.bento.html') // the other program
    const outside = async (text) => { const w = await other.createWritable(); await w.write(text); await w.close() }
    const disk = async () => (await h.getFile()).text()
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
    const attempt = async (html) => { try { await m.writeUpdatedFile(html); return 'written' } catch (e) { return e?.name ?? String(e) } }
    let events = 0
    m.onFileChangedOnDisk(() => events++)
    m.adoptFileHandle(h)
    await sleep(20)

    const res = {}
    const own = []
    for (let i = 0; i < 40; i++) own.push(await attempt('<html>mine ' + 'x'.repeat(i % 4)))
    res.ownSequential = own.every((x) => x === 'written')
    res.ownConcurrent = (await Promise.all([attempt('a'), attempt('bb'), attempt('ccc'), attempt('dddd')])).every((x) => x === 'written')
    res.eventsAfterOwn = events

    await sleep(20)
    await outside('<html>edited elsewhere')
    res.afterOutside = await attempt('<html>clobber')
    res.diskAfterOutside = await disk()
    res.eventsAfterOutside = events
    res.stillStopped = await attempt('<html>autosave')

    await m.keepMineOverDisk()
    res.keepMine = await attempt('<html>mine, deliberately')
    res.diskAfterKeep = await disk()
    res.afterKeepOwn = await attempt('<html>mine again')

    await sleep(20)
    await outside('<html>same len!') // same byte length as the line above it
    res.sameSize = await attempt('<html>ours 12345')
    res.diskAfterSameSize = await disk()

    const loaded = await m.readDiskVersion()
    res.loaded = loaded.html
    loaded.accept()
    res.afterAccept = await attempt('<html>after load')
    res.events = events
    return res
  })
  ok(r.ownSequential, '40 consecutive own writes through a real handle: none refused')
  ok(r.ownConcurrent, '4 concurrent own writes: none refused')
  ok(r.eventsAfterOwn === 0, 'no event after our own writes')
  ok(r.afterOutside === 'FileChangedOnDiskError', 'a write after another handle rewrote the file is refused')
  ok(r.diskAfterOutside === '<html>edited elsewhere', 'the other program\'s edit is still on disk')
  ok(r.eventsAfterOutside === 1, 'the event fired once')
  ok(r.stillStopped === 'FileChangedOnDiskError', 'writes stay stopped until the author chooses')
  ok(r.keepMine === 'written' && r.diskAfterKeep === '<html>mine, deliberately', 'keep-mine: one deliberate overwrite')
  ok(r.afterKeepOwn === 'written', 'then our own writes continue without a false alarm')
  ok(r.sameSize === 'FileChangedOnDiskError' && r.diskAfterSameSize === '<html>same len!', 'a same-size outside edit is caught by its mtime')
  ok(r.loaded === '<html>same len!' && r.afterAccept === 'written', 'load-from-disk returns the disk text; writes resume after accept()')
  ok(r.events === 2, 'two outside edits, two events')
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
