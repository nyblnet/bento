#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Builds the store-uploadable package for home/webext.
//
//   node scripts/pack-webext.mjs            → dist/bento-home-<version>.zip
//   node scripts/pack-webext.mjs --check    → validate only, write nothing (CI)
//
// WHY THIS EXISTS RATHER THAN `zip -r`.
//
// **It refuses to ship the wrong files.** `home/webext/` contains things that
// must NOT reach a listing: `probe/` is four capability probes that open local
// files and talk across origins — harmless to us, alarming to a reviewer, and
// nothing to do with the product — and `README.md` is 200 lines of internal
// reasoning. A recursive zip takes the lot. Here the payload is an explicit
// allow-list and anything unexpected in the tree is an error, not a silent
// inclusion.
//
// **It checks the manifest against the tree.** Every file the manifest names —
// service worker, both content scripts, options page, popup, every icon — must
// exist, and every icon must be the size it claims. A listing rejected for a
// missing 128px icon costs a review round trip measured in days.
//
// **It is byte-reproducible.** Entries are sorted, timestamps fixed, no
// filesystem metadata. The same tree always produces the same zip, so "is the
// uploaded package the reviewed package?" is answerable by hashing it. This
// repo already holds that line for the document shell (docs/RELEASING.md:
// signed locally, the signed bytes are the served bytes); an extension going to
// a store cannot be signed by us, so reproducibility is what is left.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, crc32 } from 'node:zlib'
import { createHash } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'home/webext')
const OUT = join(root, 'dist')

/** What ships. Anything in the tree and not matched here is an error. */
// The PNGs are the toolbar action icon, which Chrome composites into its own
// chrome at fixed sizes. The SVG is the favicon for the extension's own pages —
// one vector rather than a family of files, because a tab icon is drawn at 16px
// and again at whatever the history and bookmarks views feel like.
const INCLUDE = [
  /^manifest\.json$/,
  /^icons\/[^/]+\.(png|svg)$/,
  /^src\/[^/]+\.(js|html|css)$/,
  /^_locales\/[a-zA-Z_]+\/messages\.json$/,
]
/** Present on purpose, deliberately NOT shipped. */
const EXCLUDE = [/^probe\//, /^README\.md$/, /^STORE\.md$/]

const problems = []
const fail = (m) => problems.push(m)

// ---- walk the tree ---------------------------------------------------------
function walk(dir, base = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel))
    else out.push(rel)
  }
  return out
}

const all = walk(SRC)
const payload = []
for (const rel of all) {
  if (EXCLUDE.some((r) => r.test(rel))) continue
  if (INCLUDE.some((r) => r.test(rel))) { payload.push(rel); continue }
  fail(`unexpected file in home/webext — add it to INCLUDE or EXCLUDE deliberately: ${rel}`)
}

// ---- the icons must have transparent corners -------------------------------
// The shipped PNGs had NO ALPHA CHANNEL: RGB, not RGBA, so opaque squares by
// construction, and the toolbar showed a hard square no CSS could round. They
// are exports of icons/icon.svg, and an export that quietly drops the alpha
// looks identical in a file listing and square in the browser — the kind of
// regression nobody sees until it ships.
//
// Colour type lives at byte 25 of a PNG: 8-byte signature, then IHDR's length
// and type (8 more), then width, height, bit depth, and colour type. 6 is
// truecolour with alpha, 4 is greyscale with alpha; anything else has none.
function pngColourType(abs) {
  const head = readFileSync(abs).subarray(0, 26)
  if (head.length < 26 || head.readUInt32BE(0) !== 0x89504e47) return null
  return head[25]
}
for (const rel of all.filter((r) => /^icons\/.*\.png$/.test(r))) {
  const ct = pngColourType(join(SRC, rel))
  if (ct === null) { fail(`${rel} is not a PNG`); continue }
  if (ct !== 6 && ct !== 4) {
    fail(`${rel} has no alpha channel (colour type ${ct}) — its corners are opaque, `
      + 'so the rounded mark will render as a square. Re-export from icons/icon.svg.')
  }
}

// ---- a shipped SVG must actually parse -------------------------------------
// It did not. `icon.svg` carried its own regeneration command in an XML comment,
// and every flag in that command starts with a double hyphen — which an XML
// comment may not contain. The file was malformed, so the mark rendered as a
// broken image on every surface that used it, while looking perfectly correct
// in an editor and passing every other check here.
//
// No XML parser in node's standard library, so this checks the one rule that
// was broken plus the shape of the thing: a comment with `--` inside it, and a
// root element that opens and closes.
for (const rel of payload.filter((p) => p.endsWith('.svg'))) {
  const text = readFileSync(join(SRC, rel), 'utf8')
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (m[1].includes('--')) {
      fail(`${rel} has a comment containing "--", which is not valid XML — the file will not `
        + 'parse and the image will not render. Command line flags belong in the README.')
    }
  }
  if (!/<svg[\s>]/.test(text) || !/<\/svg>/.test(text)) fail(`${rel} has no <svg> root element`)
}

// ---- one design system, not three ------------------------------------------
// There were three: the home page had tokens and dark mode, the popup had 21
// hardcoded colours and no dark mode, the options page had 16 and no dark mode —
// the same product in three costumes, and the surface people actually open was
// the one that turned white at midnight.
//
// ui.css owns the palette. A literal colour anywhere else is how that comes
// back, one convenient hex at a time, and the symptom is a page that ignores
// dark mode rather than anything that looks broken in review.
//
// `chrome.action.setBadgeBackgroundColor` is exempt: it is a browser API taking
// a colour string, not a stylesheet, and CSS variables cannot reach it.
for (const rel of payload.filter((p) => /\.(html|js)$/.test(p) && p !== 'src/ui.css')) {
  const text = readFileSync(join(SRC, rel), 'utf8')
  for (const line of text.split('\n')) {
    if (!/#[0-9a-fA-F]{3,8}\b/.test(line)) continue
    if (/setBadgeBackgroundColor/.test(line)) continue
    if (/^\s*(\*|\/\/|<!--)/.test(line)) continue // prose about colours is fine
    fail(`${rel} has a literal colour — the palette lives in ui.css: ${line.trim().slice(0, 72)}`)
  }
}

// ---- the manifest must match the tree --------------------------------------
let manifest = null
try {
  manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
} catch (e) {
  fail(`manifest.json does not parse: ${e.message}`)
}

// ---- localisation ----------------------------------------------------------
// The store shows `name` and `description` in the shopper's language, so those
// are `__MSG_*__` placeholders resolved from `_locales`. Which means the checks
// below MUST resolve them first: a length check against the literal string
// "__MSG_appDesc__" passes happily while the real German description runs 40
// characters over and gets truncated in the listing.
const messagesFor = (loc) => {
  try {
    return JSON.parse(readFileSync(join(SRC, `_locales/${loc}/messages.json`), 'utf8'))
  } catch {
    return null
  }
}
const localeDirs = [...new Set(all
  .filter((r) => r.startsWith('_locales/'))
  .map((r) => r.split('/')[1]))]

let resolve = (v) => v
if (manifest && localeDirs.length) {
  const def = manifest.default_locale
  if (!def) fail('there is a _locales directory, so the manifest must set "default_locale"')
  const base = def ? messagesFor(def) : null
  if (def && !base) fail(`default_locale is "${def}" but _locales/${def}/messages.json is missing or invalid`)

  resolve = (v, loc = def) => String(v ?? '').replace(/__MSG_([A-Za-z0-9_]+)__/g, (whole, key) => {
    const m = messagesFor(loc)?.[key]?.message
    return m ?? whole
  })

  for (const loc of localeDirs) {
    const msgs = messagesFor(loc)
    if (!msgs) { fail(`_locales/${loc}/messages.json does not parse`); continue }
    for (const [key, entry] of Object.entries(msgs)) {
      if (typeof entry?.message !== 'string' || !entry.message) {
        fail(`_locales/${loc}/messages.json: "${key}" has no message`)
      }
    }
  }

  // Every placeholder the manifest uses must exist in the DEFAULT locale, or
  // the store sees the raw "__MSG_appName__" as the extension's name.
  for (const field of ['name', 'description']) {
    const raw = manifest[field] ?? ''
    for (const m of String(raw).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
      if (!base?.[m[1]]) fail(`manifest.${field} uses __MSG_${m[1]}__ but the default locale does not define it`)
    }
  }

  // And the LISTING strings are checked in every locale, because a description
  // is only useful where it is read.
  for (const loc of localeDirs) {
    const desc = resolve(manifest.description, loc)
    if (desc.startsWith('__MSG_')) continue // falls back to default: fine
    if (desc.length > 132) fail(`${loc} description is ${desc.length} chars; the store truncates at 132`)
  }
}

if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3')
  for (const k of ['name', 'version', 'description']) {
    if (!manifest[k]) fail(`manifest is missing "${k}" — the store requires it`)
  }
  if (manifest.version === '0.0.1') fail('manifest version is still the scaffold placeholder 0.0.1')
  const desc = resolve(manifest.description)
  if (desc.length > 132) fail(`description is ${desc.length} chars; the store truncates at 132`)
  if (desc.startsWith('__MSG_')) fail('manifest.description does not resolve — check _locales')

  const named = new Set()
  // A manifest path may legitimately carry a fragment or query — `options_page`
  // is `src/home.html#settings`, because Chrome's "Options" entry means
  // "configure this extension" and the page routes on the hash. Only the file
  // part is a file, so only the file part is checked for existence.
  const claim = (p) => { if (p) named.add(p.replace(/^\//, '').replace(/[#?].*$/, '')) }
  claim(manifest.background?.service_worker)
  claim(manifest.options_page)
  claim(manifest.action?.default_popup)
  claim(manifest.side_panel?.default_path)
  for (const cs of manifest.content_scripts ?? []) (cs.js ?? []).forEach(claim)
  for (const size of ['16', '32', '48', '128']) {
    const p = manifest.icons?.[size]
    if (!p) fail(`manifest.icons is missing the ${size}px entry — the store requires 128 and uses the rest`)
    else claim(p)
  }
  for (const p of named) {
    if (!payload.includes(p)) fail(`manifest names "${p}" but it is not in the package`)
  }

  // Icons must actually BE the size they claim. A store rejection for this is
  // days of review latency for a one-line mistake.
  for (const [size, p] of Object.entries(manifest.icons ?? {})) {
    try {
      const b = readFileSync(join(SRC, p))
      // PNG: width/height are big-endian u32 at byte 16 and 20 of the IHDR.
      const w = b.readUInt32BE(16)
      const h = b.readUInt32BE(20)
      if (w !== Number(size) || h !== Number(size)) {
        fail(`${p} is ${w}x${h} but is declared as the ${size}px icon`)
      }
    } catch (e) {
      fail(`cannot read icon ${p}: ${e.message}`)
    }
  }

  // A permission that is declared and unused is a question a reviewer asks and
  // the listing cannot answer.
  const srcText = payload.filter((p) => p.endsWith('.js'))
    .map((p) => readFileSync(join(SRC, p), 'utf8')).join('\n')
  for (const perm of manifest.permissions ?? []) {
    if (!new RegExp(`chrome\\.${perm}\\b`).test(srcText) && perm !== 'storage') {
      fail(`permission "${perm}" is declared but never used in the shipped code`)
    }
  }
}

// ---- a minimal, deterministic zip ------------------------------------------
// Written by hand rather than shelled out to `zip` so the output is fixed by
// construction: sorted entries, one timestamp, no filesystem metadata.
const DOS_TIME = 0x0000 // 00:00:00
const DOS_DATE = 0x2821 // 2020-01-01 — a constant, so the bytes never drift

function zip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const { name, data } of files) {
    const body = deflateRawSync(data, { level: 9 })
    const nameBuf = Buffer.from(name, 'utf8')
    const sum = crc32(data)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(sum, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(DOS_TIME, 12)
    cd.writeUInt16LE(DOS_DATE, 14); cd.writeUInt32LE(sum, 16)
    cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += lh.length + nameBuf.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cdBuf, end])
}

// ---- report ----------------------------------------------------------------
console.log(`home/webext → ${payload.length} files`)
for (const p of payload) console.log(`  ${p}`)

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length > 1 ? 's' : ''}:`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  console.log('\npackage is valid (nothing written)')
  process.exit(0)
}

const bytes = zip(payload.map((name) => ({ name, data: readFileSync(join(SRC, name)) })))
mkdirSync(OUT, { recursive: true })
const out = join(OUT, `bento-home-${manifest.version}.zip`)
writeFileSync(out, bytes)
console.log(`\nwrote ${relative(root, out)} — ${(bytes.length / 1024).toFixed(1)}KB`)
console.log('deterministic: the same tree always produces these bytes')

// ---- the release manifest unpacked installs read ---------------------------
// A store install updates itself. One loaded unpacked never will — Chrome
// ignores `update_url` for a development install — so the extension asks this
// file whether it is behind (src/update.js) and says so. Emitted here rather
// than written by hand because the digest has to match the bytes just built,
// and a hand-copied hash is a hash that goes stale silently.
//
// The digest is publishable BECAUSE the zip is reproducible: anyone can rebuild
// from source and confirm the package they downloaded is the package that was
// reviewed. That is the only verification available when the browser is not the
// one doing the updating.
const digest = createHash('sha256').update(bytes).digest('hex')
const release = {
  version: manifest.version,
  url: `https://github.com/nyblnet/bento/releases/tag/tray-v${manifest.version}`,
  sha256: digest,
}
const relOut = join(OUT, 'tray-release.json')
writeFileSync(relOut, `${JSON.stringify(release, null, 2)}\n`)
console.log(`wrote ${relative(root, relOut)} — publish at /releases/home/manifest.json`)
console.log(`sha256 ${digest}`)
