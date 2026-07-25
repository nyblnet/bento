#!/usr/bin/env node
// Fetch MathJax's tex-svg component into slides/public/vendor/ for local dev.
//
// The engine is ~2MB and is NEVER bundled or committed (see .gitignore) — the
// shipped app fetches it on demand and caches it in IndexedDB. This script is
// purely a convenience so `npm run dev` bakes math with no network at all:
// mathjax.ts prefers /vendor/tex-svg.js when served from localhost.
//
// Usage:  npm run fetch-mathjax        (from slides/)

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../slides/public/vendor/tex-svg.js')

// Pinned so a local checkout and a shipped deck bake identical markup.
const VERSION = '3.2.2'
const SOURCES = [
  `https://cdn.jsdelivr.net/npm/mathjax@${VERSION}/es5/tex-svg.js`,
  `https://cdnjs.cloudflare.com/ajax/libs/mathjax/${VERSION}/es5/tex-svg.js`,
  `https://unpkg.com/mathjax@${VERSION}/es5/tex-svg.js`,
]

const exists = async (p) => { try { await stat(p); return true } catch { return false } }

if (await exists(OUT) && !process.argv.includes('--force')) {
  console.log(`tex-svg.js already present at ${OUT} (pass --force to refetch)`)
  process.exit(0)
}

await mkdir(dirname(OUT), { recursive: true })

for (const url of SOURCES) {
  try {
    process.stdout.write(`fetching ${url} … `)
    const res = await fetch(url)
    if (!res.ok) { console.log(`HTTP ${res.status}`); continue }
    const js = await res.text()
    if (js.length < 10000) { console.log('too small — not the engine'); continue }
    await writeFile(OUT, js)
    console.log(`ok (${Math.round(js.length / 1024)}KB)`)
    console.log(`\nWrote ${OUT}`)
    console.log('`npm run dev` will now bake math offline.')
    process.exit(0)
  } catch (err) {
    console.log(err.message)
  }
}

console.error('\nCould not fetch the MathJax engine from any source.')
console.error('Math still works without this — the app falls back to the CDN at runtime.')
process.exit(1)
