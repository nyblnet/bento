#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Screenshot every slide of a built .bento.html with the app's REAL renderer,
// so a generated deck can be eyeballed without opening it by hand.
//
//   node scripts/preview-deck.mjs working/My_Deck.bento.html [--out working/preview]
//   node scripts/preview-deck.mjs working/My_Deck.bento.html --contact
//
// One PNG per slide by default; --contact renders a single contact sheet.
// It pulls the doc out of the file's #bento-doc block and hands it to
// render.ts through the vite dev server — same code path as the editor canvas,
// thumbnails and present mode, so what you see here is what a viewer gets
// (baked math included; that needs no engine at view time).
//
// Requirements are the baker's: a Chrome/Chromium binary and vite.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.BAKE_PORT || 5199)

const args = process.argv.slice(2)
const deckPath = args.find((a) => !a.startsWith('--'))
if (!deckPath) {
  console.error('usage: node scripts/preview-deck.mjs <deck.bento.html> [--out <dir>] [--contact]')
  process.exit(1)
}
const contact = args.includes('--contact')
const outFlag = args.indexOf('--out')
const outDir = resolve(outFlag >= 0 ? args[outFlag + 1] : join(root, 'working/preview'))

const html = readFileSync(resolve(deckPath), 'utf8')
const block = /<script type="application\/bento\+json" id="bento-doc">([\s\S]*?)<\/script>/.exec(html)
if (!block) throw new Error('no #bento-doc block in that file')
const doc = JSON.parse(block[1])
console.log(`• ${doc.slides.length} slides — "${doc.title}"`)

function chromeCommand() {
  if (process.env.CHROME) return [process.env.CHROME, []]
  for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    const hit = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' })
    if (hit.status === 0 && hit.stdout.trim()) return [hit.stdout.trim(), []]
  }
  if (spawnSync('flatpak', ['info', 'com.google.Chrome'], { encoding: 'utf8' }).status === 0) {
    return ['flatpak', ['run', 'com.google.Chrome']]
  }
  throw new Error('No Chrome/Chromium found — set CHROME=/path/to/chrome')
}

const alive = async () => {
  try { return (await fetch(`http://localhost:${PORT}/src/render.ts`)).ok } catch { return false }
}
let vite = null
if (await alive()) console.log(`• using the vite dev server already on :${PORT}`)
else {
  console.log(`• starting vite on :${PORT}`)
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
    { cwd: join(root, 'slides'), stdio: 'ignore', detached: true })
  const deadline = Date.now() + 30000
  while (!(await alive())) {
    if (Date.now() > deadline) throw new Error('vite did not come up')
    await new Promise((r) => setTimeout(r, 300))
  }
}
const stopVite = () => { if (vite) { try { process.kill(-vite.pid) } catch { /* gone */ } vite = null } }

// The page renders slides at full size and lays them out in a column (or grid
// for a contact sheet); Chrome screenshots the whole thing.
const W = doc.size?.width ?? 1280
const H = doc.size?.height ?? 720
const cols = contact ? 3 : 1
const scale = contact ? 0.33 : 1
const pagePath = join(root, 'slides', '__deck-preview.html')
mkdirSync(outDir, { recursive: true })

const payload = JSON.stringify(doc).replace(/</g, '\\u003c')
writeFileSync(pagePath, `<!doctype html><meta charset="utf-8"><title>preview</title>
<style>
  html,body{margin:0;background:#2A2F3A}
  #grid{display:grid;grid-template-columns:repeat(${cols}, ${Math.round(W * scale)}px);gap:${contact ? 16 : 24}px;padding:${contact ? 16 : 24}px;width:max-content}
  .cell{position:relative;width:${Math.round(W * scale)}px;height:${Math.round(H * scale)}px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  .cell > .bento-slide{transform:scale(${scale});transform-origin:0 0}
  .n{position:absolute;left:0;top:0;z-index:9;background:#000A;color:#fff;font:700 12px/1 monospace;padding:4px 6px}
</style>
<script id="doc" type="application/json">${payload}</scr` + `ipt>
<div id="grid"></div>
<script type="module">
import { renderSlide } from '/src/render.ts'
import '/src/styles.css'
const doc = JSON.parse(document.getElementById('doc').textContent)
// @font-face from doc.fonts, exactly as the app does at boot
if (doc.fonts) {
  const css = doc.fonts.map((f) => {
    const src = doc.assets?.[f.asset] ?? f.asset
    return '@font-face{font-family:"' + f.family + '";src:url(' + src + ');font-weight:' + (f.weight || '400') + ';font-display:block}'
  }).join('')
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st)
}
const grid = document.getElementById('grid')
doc.slides.forEach((s, i) => {
  const cell = document.createElement('div')
  cell.className = 'cell'
  const n = document.createElement('div'); n.className = 'n'; n.textContent = String(i + 1)
  cell.append(n, renderSlide(s, doc, { hidePlaceholders: false }))
  grid.appendChild(cell)
})
await (document.fonts ? document.fonts.ready : Promise.resolve())
document.title = 'PREVIEW-READY'
</scr` + `ipt>
`)

try {
  const [bin, pre] = chromeCommand()
  const rows = Math.ceil(doc.slides.length / cols)
  const winW = Math.round(cols * W * scale + (cols + 1) * (contact ? 16 : 24)) + 20
  const winH = Math.round(rows * H * scale + (rows + 1) * (contact ? 16 : 24)) + 20
  const shot = join(outDir, contact ? 'contact-sheet.png' : 'all-slides.png')
  console.log(`• shooting ${winW}×${winH}`)
  const res = spawnSync(bin, [
    ...pre, '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${winW},${winH}`,
    '--virtual-time-budget=45000', '--run-all-compositor-stages-before-draw',
    `--screenshot=${shot}`, `http://localhost:${PORT}/__deck-preview.html`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.error) throw res.error
  console.log(`✓ ${shot}`)
} finally {
  rmSync(pagePath, { force: true })
  stopVite()
}
