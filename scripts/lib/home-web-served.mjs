// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The bento/home release list: what the tripwire (home/webext/src/tripwire*.js)
// checks home.bento.page against. Derived from a home/web build's output
// directory, appended to the list already published, signed with the release
// key by scripts/sign-home-web-served.mjs.
//
// The payload's format is documented once, in home/webext/src/tripwire-judge.js
// (the reader), and checked by its servedProblem(); this module is the writer,
// and the two meet in scripts/test-webext-tripwire.ts.
//
// What a release MUST emit, so the tripwire can recognise it:
//   - every file the library site and the frame site serve, at every path they
//     serve it (index.html also as /, frame.html also as /frame): sha256, bytes;
//   - for each HTML document, the <script> elements in document order (inline
//     ones by the sha256 of their text as the browser's tokenizer reads it,
//     external ones by path), and the Content-Security-Policy header its
//     _headers rule sends;
//   - the paths registered as service workers (build.json `serviceWorkers`;
//     none in stage 1).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const SERVED_TYPE = 'bento/home-web/served'
export const SERVED_V = 1
/** Releases kept in the list: an older one still served is "outdated", one dropped off the end is a mismatch. */
export const KEEP = 24

const sha = (b) => createHash('sha256').update(b).digest('hex')

/** Cloudflare _headers, the way home/web/serve.mjs applies them: rules in order, a later match appends. */
function headerRules(text) {
  const rules = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) { rules.push({ pattern: line.trim(), headers: [] }); continue }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(line)
    if (m && rules.length) rules.at(-1).headers.push([m[1].trim().toLowerCase(), m[2].trim()])
  }
  return rules
}
function headerFor(rules, p, name) {
  let v
  for (const r of rules) {
    const hit = r.pattern.endsWith('*') ? p.startsWith(r.pattern.slice(0, -1)) : r.pattern === p
    if (!hit) continue
    for (const [k, val] of r.headers) if (k === name) v = v === undefined ? val : `${v}, ${val}`
  }
  return v
}

/**
 * A <script>'s text as the browser's DOM holds it: the input stream's
 * newlines normalised (CR LF and CR become LF) and NUL replaced, as the HTML
 * parser does before tokenizing. Script data has no character references.
 */
const asParsed = (text) => text.replace(/\r\n?/g, '\n').replace(/\0/g, '�')

/** The scripts of one HTML document served at `url`, in document order (as tripwire-observe.js reports them). */
export async function documentScripts(html, url) {
  const { scanBlocks } = await import(path.join(root, 'kernel/src/gate1.ts'))
  return scanBlocks(html).filter((b) => b.tag === 'script').map((b) => {
    if (b.src !== null) { const u = new URL(b.src, url); return { src: u.origin === new URL(url).origin ? u.pathname : u.href } }
    return { sha256: sha(Buffer.from(asParsed(b.text), 'utf8')) }
  })
}

/** Every path a site directory serves a file at. */
function servedPaths(dir) {
  const out = []
  const walk = (d, base) => {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name)
      const rel = `${base}/${name}`
      if (fs.statSync(abs).isDirectory()) walk(abs, rel)
      else if (!name.startsWith('_') && !name.startsWith('.')) out.push({ abs, path: rel })
    }
  }
  walk(dir, '')
  return out
}

/**
 * One release, from a home/web build directory (<out>/library, <out>/frame,
 * <out>/build.json). Aliases: index.html is also served at the directory, and
 * frame.html at /frame (both _headers files say so).
 */
export async function describeBuild(out, at = new Date().toISOString()) {
  const info = JSON.parse(fs.readFileSync(path.join(out, 'build.json'), 'utf8'))
  const origins = {}
  for (const [role, origin, aliases] of [
    ['library', info.libraryOrigin, { '/index.html': ['/'] }],
    ['frame', info.frameOrigin, { '/frame.html': ['/frame'] }],
  ]) {
    const dir = path.join(out, role)
    const hf = path.join(dir, '_headers')
    const rules = fs.existsSync(hf) ? headerRules(fs.readFileSync(hf, 'utf8')) : []
    const files = {}
    for (const f of servedPaths(dir)) {
      const bytes = fs.readFileSync(f.abs)
      const doc = /\.html?$/.test(f.path)
      for (const p of [f.path, ...(aliases[f.path] ?? [])]) {
        const e = { sha256: sha(bytes), bytes: bytes.length, kind: doc ? 'document' : 'asset' }
        if (doc) e.scripts = await documentScripts(bytes.toString('utf8'), origin + p)
        const csp = headerFor(rules, p, 'content-security-policy')
        if (csp !== undefined) e.csp = csp
        files[p] = e
      }
    }
    origins[origin] = { role, files }
  }
  const workers = Array.isArray(info.serviceWorkers) ? info.serviceWorkers : []
  for (const w of workers) if (!origins[info.libraryOrigin].files[w]) throw new Error(`build.json names a service worker the library does not serve: ${w}`)
  return { at, workers, origins }
}

/**
 * The next list: `held` is the payload already published (verified by the
 * caller), or null for the first. The serial only goes up; releases are newest
 * first and the oldest fall off after KEEP.
 */
export function nextServed(held, release, at = new Date().toISOString(), { withdraw = [] } = {}) {
  if (held && (held.type !== SERVED_TYPE || held.v !== SERVED_V || !Number.isSafeInteger(held.serial))) {
    throw new Error('the held release list is not a v1 bento/home list')
  }
  const older = (held ? held.releases : []).map((r) => ({ ...r }))
  // R1: a release with a known hole is WITHDRAWN: still listed, so serving it is a loud mismatch, not a quiet "outdated"
  for (const w of withdraw) {
    const hit = older.filter((r) => r.at === w)
    if (hit.length !== 1) throw new Error(`--withdraw ${w}: the held list has ${hit.length} releases signed at that time (exactly one required)`)
    hit[0].withdrawn = true
  }
  return {
    type: SERVED_TYPE, v: SERVED_V,
    serial: held ? held.serial + 1 : 1,
    at,
    releases: [release, ...older].slice(0, KEEP),
  }
}
