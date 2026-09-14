#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash internationalization rig — and the packer that feeds it.
//
//   node scripts/test-dash-i18n.ts            verify (CI)
//   node scripts/test-dash-i18n.ts --write    regenerate dash/src/i18n/packed.ts
//
// WHAT THIS PROVES. English-string-as-key is a wonderful authoring choice and a
// terrible one to leave unguarded, because every failure mode is SILENT:
//
//   1. DRIFT KILLS A TRANSLATION WITHOUT A TRACE. The key is the source
//      sentence, so re-wording a button in main.ts orphans seven translations
//      at once and the UI simply reverts to English. Nothing throws, nothing
//      logs. So the key universe is SWEPT FROM THE SOURCE and any catalog key
//      that no longer matches a t() call is a failure, not a warning.
//   2. A PLACEHOLDER IS A CONTRACT. "{n} rows" interpolates by NAME. A
//      translator who writes "{N} rader" or drops the brace ships a string that
//      renders the literal token to a user. Placeholders are compared as SETS,
//      both ways: missing in the translation, and invented by it.
//   3. NOT EVERY t() TAKES A LITERAL. help.ts and panels.ts hold their English
//      in module consts and translate at RENDER time (the correct shape — a
//      t() in a module const freezes at import, before the locale is known).
//      A regex sweep cannot see those strings, so they are declared below AND
//      the rig fails if a NEW indirect call site appears that is not declared.
//      Otherwise the first such string would just quietly never be translated.
//   4. A CATALOG IS DEAD WEIGHT IF IT IS NOT REACHABLE. Coverage is reported
//      per locale, and an incomplete core catalog is a build failure: catalogs
//      ship INSIDE every saved workbook and cannot be corrected without a
//      release, so "we'll finish it later" means shipping a half-Japanese app.
//
// The per-locale files in dash/src/i18n/*.ts are the SOURCE OF TRUTH — that is
// what a translator reviews and what a contributor submits. packed.ts is
// generated: it stores each English key ONCE with translations positional by
// column, because seven plain catalogs store the same English sentence seven
// times and deflate cannot dedupe across its 32KB window.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'dash/src')
const i18nDir = join(srcDir, 'i18n')
const OUT = join(i18nDir, 'packed.ts')

/** Locale columns, in order. English is the key, so it is never a column. */
const LOCALES = ['ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'it'] as const

/**
 * Strings that reach t() through a module const rather than as a literal.
 *
 * These are NOT a bug — they are the right shape. `const TIPS = ['…']` holds
 * raw English and `t(tip)` runs at render time, which is exactly what a
 * module-level `t()` must not do. But a regex cannot follow the indirection,
 * so each table is named here, keyed by the ARGUMENT EXPRESSION as written at
 * the call site. Anything else that reaches t() without a literal fails the
 * rig — otherwise the first such string would quietly never be translated.
 *
 * `pick` says where the English lives inside the parsed literal.
 */
const INDIRECT: Array<{ arg: string; file: string; name: string; pick: 'values' | 'items' | 'tuple1' }> = [
  { arg: 'TYPE_LABEL[tp]', file: 'format.ts', name: 'TYPE_LABEL', pick: 'values' },
  { arg: 'AGG_LABEL[v.fn] ?? String(v.fn)', file: 'pivot.ts', name: 'AGG_LABEL', pick: 'values' },
  { arg: 'a', file: 'panels.ts', name: 'AGGS', pick: 'items' },            // AGGS.map((a) => … t(a))
  { arg: 'SECTION_TITLE[section]', file: 'help.ts', name: 'SECTION_TITLE', pick: 'values' },
  { arg: 'r.label', file: 'help.ts', name: 'LABELS', pick: 'tuple1' },     // helpRows() carries LABELS[…][1]
  { arg: 'tip', file: 'help.ts', name: 'TIPS', pick: 'items' },
  // The column header renders the SAME table panels.ts wraps in t(); it used to
  // render it raw, so the type chip read "Money" in a Japanese workbook.
  { arg: 'TYPE_LABEL[c.type]', file: 'format.ts', name: 'TYPE_LABEL', pick: 'values' },
  // The dataset Cell section shows the column's type READ-ONLY beside the
  // cell's appearance — the type boundary made visible, so it has to be
  // localized like every other reading of this table.
  { arg: 'TYPE_LABEL[col.type]', file: 'format.ts', name: 'TYPE_LABEL', pick: 'values' },
  // …and the "this pattern does nothing" note names the type it is refusing to
  // format, so it reads the same table again — a fourth spelling of the same
  // indirection rather than a fourth table.
  { arg: 'TYPE_LABEL[type]', file: 'format.ts', name: 'TYPE_LABEL', pick: 'values' },
  { arg: 'role', file: 'sync/people.ts', name: 'ROLE_LABEL', pick: 'values' },
]

/**
 * Calls that LOOK like t() and are not. filter.ts binds a local predicate
 * named `t` over its filter tests — `for (const t of tests) if (!t(i))`. It is
 * listed rather than special-cased so that renaming it away is visible.
 */
const NOT_I18N: Array<{ file: string; arg: string }> = [
  { file: 'dash/src/filter.ts', arg: 'i' },
]

/**
 * Keys deliberately left in English in every locale.
 *
 * The bar is high on purpose. A spreadsheet's vocabulary is settled in every
 * one of these languages — Excel and Sheets shipped it decades ago — so
 * "hard to translate" is almost never true and a fresh coinage is worse than
 * the boring standard word. What survives here is what is not language at all:
 * a key name, a unit, a file extension, a formula sample.
 */
const KEEP_ENGLISH = new Map<string, string>([
  ['Value * Probability', 'a formula sample shown as an input placeholder — it is code, and it is the column names of the starter workbook'],
  ['3D', 'the same three characters in every one of these locales'],
])

/**
 * Rows whose translation is correctly IDENTICAL to the English.
 *
 * A translation that echoes its key is nearly always a forgotten row, so the
 * rig fails on one — but "nearly always" is not always, and a checker that
 * cannot be satisfied honestly gets satisfied dishonestly. The first draft of
 * the Spanish catalog came back with "Total" rendered "Totales", a plural
 * invented purely to get past this check, which is a worse string than the
 * correct one. So the correct ones are listed instead, per locale, and stay
 * countable as translated because they are.
 */
const SAME_AS_ENGLISH: Record<string, string[]> = {
  es: ['Total', 'editor', 'General'],
  fr: ['Auto', 'Date', 'Format', 'Orientation', 'Portrait', 'Total', 'Type'],
  ja: ['OK'],
  de: ['Dashboard', 'Format', 'Name', 'OK', 'Symbol', 'Text', 'Updates'],
  it: ['Dashboard', 'File', 'Formula', 'Max', 'Min', 'OK', 'vs', 'editor'],
}

// --- sweeping the source -----------------------------------------------------

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'i18n') tsFiles(full, out); continue }
    if (e.name.endsWith('.ts') && e.name !== 'i18n.ts') out.push(full)
  }
  return out
}

/** Unescape a TS single/double-quoted string body. */
const unquote = (s: string): string =>
  s.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|n|r|t|['"\\`$]|\r?\n)/g,
    (_m, _all, uBrace, u4, x2, ) => {
      if (uBrace) return String.fromCodePoint(parseInt(uBrace, 16))
      if (u4) return String.fromCharCode(parseInt(u4, 16))
      if (x2) return String.fromCharCode(parseInt(x2, 16))
      const tail = _m.slice(1)
      if (tail === 'n') return '\n'
      if (tail === 'r') return '\r'
      if (tail === 't') return '\t'
      if (/^\r?\n$/.test(tail)) return ''
      return tail
    })

/**
 * Blank out comments, preserving offsets and newlines so line numbers survive.
 * A `t()` inside prose is not a call site — help.ts's own warning about module
 * consts is written as `a t() in a module const freezes`, and without this the
 * rig would demand a translation for it.
 */
function blankComments(src: string): string {
  const out = src.split('')
  let i = 0, q = ''
  while (i < src.length) {
    const c = src[i]
    if (q) {
      if (c === '\\') { i += 2; continue }
      if (c === q) q = ''
      i++; continue
    }
    if (c === "'" || c === '"' || c === '`') { q = c; i++; continue }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      for (; i < stop; i++) if (src[i] !== '\n') out[i] = ' '
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * `t` preceded by anything that is not an identifier char, a dot or a quote.
 * The dot rules out `x.t(`; the quote rules out a `t(` inside a string.
 */
const T_CALL = /(^|[^A-Za-z0-9_$.'"`\\])t\(/g

/**
 * Read `'a'`, or `'a' + 'b' + …`, starting at `at`. Returns the concatenated
 * value, or null if what starts there is not a string literal.
 */
function readLiteralChain(src: string, at: number): string | null {
  let i = at, out = ''
  for (;;) {
    const q = src[i]
    if (q !== "'" && q !== '"') return i === at ? null : out
    const body = new RegExp(`^((?:\\\\.|[^\\\\${q}])*)`).exec(src.slice(i + 1))![1]
    out += unquote(body)
    i += 1 + body.length + 1
    const join = /^\s*\+\s*/.exec(src.slice(i))
    if (!join) return out
    i += join[0].length
  }
}

/** The argument expression as written, up to the matching close paren. */
function argText(src: string, at: number): string {
  let depth = 1, i = at, q = ''
  for (; i < src.length; i++) {
    const c = src[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue }
    if (c === "'" || c === '"' || c === '`') { q = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (!depth) break }
    else if (c === ',' && depth === 1) break        // t(key, vars) — the key is arg 1
  }
  return src.slice(at, i).trim().replace(/\s+/g, ' ')
}

function sweepLiterals(): { keys: Set<string>; indirect: Array<{ where: string; file: string; arg: string }> } {
  const keys = new Set<string>()
  const indirect: Array<{ where: string; file: string; arg: string }> = []
  for (const file of tsFiles(srcDir)) {
    const src = blankComments(readFileSync(file, 'utf8'))
    const rel = relative(root, file)
    let m: RegExpExecArray | null
    T_CALL.lastIndex = 0
    while ((m = T_CALL.exec(src))) {
      const open = m.index + m[0].length
      const lead = src.slice(open).match(/^\s*/)![0]
      const at = open + lead.length
      // A literal, or a CHAIN of literals joined with `+`. The chain matters:
      // splash.ts wraps a long sentence as `t('… this file. ' + 'Try opening
      // it again…')`, and t() receives the JOINED string. Taking only the
      // first piece would have made a key that can never match at runtime —
      // a translation that is dead the day it is written, which is the exact
      // failure this rig exists to prevent.
      const lit = readLiteralChain(src, at)
      if (lit !== null) { keys.add(lit); continue }
      const line = src.slice(0, m.index).split('\n').length
      indirect.push({ where: `${rel}:${line}`, file: rel, arg: argText(src, open) })
    }
  }
  return { keys, indirect }
}

/** Slice a `const NAME … = <literal>` out of a file and evaluate it. */
function readConst(file: string, name: string): unknown {
  const src = readFileSync(join(srcDir, file), 'utf8')
  const decl = new RegExp(`\\bconst\\s+${name}\\b[^=]*=\\s*`).exec(src)
  if (!decl) throw new Error(`${file}: no const ${name}`)
  const from = decl.index + decl[0].length
  const open = src[from]
  const close = open === '{' ? '}' : ']'
  if (open !== '{' && open !== '[') throw new Error(`${file}: ${name} is not an object or array literal`)
  // Depth scan, skipping string bodies so a brace inside a tip does not close it.
  let depth = 0, i = from, q = ''
  for (; i < src.length; i++) {
    const c = src[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue }
    if (c === "'" || c === '"' || c === '`') { q = c; continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (!depth) break }
  }
  const body = src.slice(from, i + 1)
  // The literals are plain string data; type annotations live outside the slice.
  return Function(`"use strict"; return (${body})`)()
}

function sweepIndirect(): Set<string> {
  const keys = new Set<string>()
  for (const spec of INDIRECT) {
    const v = readConst(spec.file, spec.name) as Record<string, unknown> | unknown[]
    const take = (s: unknown) => { if (typeof s === 'string' && s) keys.add(s) }
    if (spec.pick === 'values') Object.values(v as Record<string, unknown>).forEach(take)
    else if (spec.pick === 'items') (v as unknown[]).forEach(take)
    else Object.values(v as Record<string, unknown[]>).forEach((tup) => take(tup[1]))
  }
  return keys
}

// --- catalogs ----------------------------------------------------------------

/** Read one per-locale catalog by evaluating its exported object literal. */
function readCatalog(code: string): Record<string, string> {
  const file = join(i18nDir, `${code}.ts`)
  if (!existsSync(file)) return {}
  const src = readFileSync(file, 'utf8')
  const start = src.indexOf('{', src.indexOf('export const '))
  const end = src.lastIndexOf('}')
  if (start < 0 || end < 0) return {}
  return Function(`"use strict"; return (${src.slice(start, end + 1)})`)() as Record<string, string>
}

/** `{name}` tokens, as a sorted set. `{{x}}` is not a thing in dash. */
function placeholders(s: string): string[] {
  return [...new Set([...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))].sort()
}

// --- run ---------------------------------------------------------------------

let failures = 0
/** `--keys` prints the swept key universe and nothing else, so it can be piped. */
const QUIET = process.argv.includes('--keys')
const say = (s: string) => { if (!QUIET) console.log(s) }
const fail = (msg: string) => { failures++; say(`  FAIL  ${msg}`) }
const ok = (msg: string) => say(`  ok    ${msg}`)

const { keys: literalKeys, indirect: indirectSites } = sweepLiterals()

// (3) an undeclared indirect call site would be a string nobody can translate
const unexplained = indirectSites.filter((s) =>
  !INDIRECT.some((spec) => spec.arg === s.arg) &&
  !NOT_I18N.some((n) => n.file === s.file && n.arg === s.arg))
if (unexplained.length) {
  for (const s of unexplained) fail(`indirect t() at ${s.where} is not declared in INDIRECT: t(${s.arg})`)
} else {
  ok(`every indirect t() call site is declared (${indirectSites.length} site(s))`)
}
// …and a declaration nobody calls is a stale table the sweep still pays for
for (const spec of INDIRECT) {
  if (!indirectSites.some((s) => s.arg === spec.arg)) {
    fail(`INDIRECT declares t(${spec.arg}) for ${spec.file}:${spec.name}, but no such call site exists any more`)
  }
}

const indirectKeys = sweepIndirect()
const keys = [...new Set([...literalKeys, ...indirectKeys])].sort()
ok(`swept ${keys.length} strings (${literalKeys.size} literal, ${indirectKeys.size} via module consts)`)

// The swept key universe, for a translator (or a tool) to work from. Printing
// it from the RIG rather than from a second scanner is the point: a key list
// that disagrees with the checker is how a catalog drifts on day one.
if (process.argv.includes('--keys')) {
  process.stdout.write(JSON.stringify(keys, null, 1) + '\n')
  process.exit(0)
}

const known = new Set(keys)
const catalogs = Object.fromEntries(LOCALES.map((c) => [c, readCatalog(c)])) as Record<string, Record<string, string>>

// (1) drift: a catalog key that matches no source string is a dead translation
for (const loc of LOCALES) {
  const dead = Object.keys(catalogs[loc]).filter((k) => !known.has(k))
  if (dead.length) {
    fail(`${loc}: ${dead.length} catalog key(s) match no t() in the source — the source string was re-worded and these are now dead:`)
    for (const k of dead.slice(0, 8)) console.log(`          ${JSON.stringify(k)}`)
    if (dead.length > 8) console.log(`          … and ${dead.length - 8} more`)
  }
}
if (!failures) ok('no catalog key has drifted away from its source string')

// (2) placeholders are a contract, checked both ways
let phBad = 0
for (const loc of LOCALES) {
  for (const [k, v] of Object.entries(catalogs[loc])) {
    if (!known.has(k)) continue
    const want = placeholders(k), got = placeholders(v)
    const missing = want.filter((p) => !got.includes(p))
    const invented = got.filter((p) => !want.includes(p))
    if (missing.length) { phBad++; fail(`${loc}: {${missing.join('} {')}} missing from the translation of ${JSON.stringify(k)}`) }
    if (invented.length) { phBad++; fail(`${loc}: {${invented.join('} {')}} invented by the translation of ${JSON.stringify(k)}`) }
  }
}
if (!phBad) ok('every {placeholder} survives every translation, spelled identically')

// (4) coverage — an incomplete core catalog cannot be fixed without a release
const missingPer: Record<string, string[]> = {}
for (const loc of LOCALES) {
  missingPer[loc] = keys.filter((k) => !KEEP_ENGLISH.has(k) && !(typeof catalogs[loc][k] === 'string' && catalogs[loc][k].length))
}
const translatable = keys.filter((k) => !KEEP_ENGLISH.has(k)).length
say(`\n  coverage (${translatable} translatable of ${keys.length} swept; ${KEEP_ENGLISH.size} kept English by design)`)
for (const loc of LOCALES) {
  const done = translatable - missingPer[loc].length
  const pct = translatable ? Math.round((done / translatable) * 1000) / 10 : 100
  say(`    ${loc.padEnd(8)} ${String(done).padStart(4)}/${translatable}  ${String(pct).padStart(5)}%`)
}
say('')
for (const loc of LOCALES) {
  if (!missingPer[loc].length) continue
  fail(`${loc}: ${missingPer[loc].length} string(s) have no translation — a core catalog ships inside every saved workbook and cannot be patched without a release`)
  for (const k of missingPer[loc].slice(0, 6)) console.log(`          ${JSON.stringify(k)}`)
}
if (!LOCALES.some((l) => missingPer[l].length)) ok('every core catalog is complete')

// A translation identical to its English key is usually a forgotten row rather
// than a deliberate one — the deliberate ones are named in KEEP_ENGLISH.
const echoes: string[] = []
for (const loc of LOCALES) {
  for (const [k, v] of Object.entries(catalogs[loc])) {
    if (v !== k || !known.has(k) || KEEP_ENGLISH.has(k)) continue
    if (SAME_AS_ENGLISH[loc]?.includes(k)) continue
    echoes.push(`${loc}: ${JSON.stringify(k)}`)
  }
}
if (echoes.length) {
  fail(`${echoes.length} translation(s) are byte-identical to their English key and are declared in neither KEEP_ENGLISH nor SAME_AS_ENGLISH:`)
  for (const e of echoes.slice(0, 8)) console.log(`          ${e}`)
} else ok('no translation silently echoes its English key')

// …and an allowance nobody uses is a licence left lying around: the day that
// string DOES get a real translation, the entry would quietly excuse a future
// echo of it instead.
const staleAllow: string[] = []
for (const [loc, list] of Object.entries(SAME_AS_ENGLISH)) {
  for (const k of list) if (catalogs[loc]?.[k] !== k) staleAllow.push(`${loc}: ${JSON.stringify(k)}`)
}
if (staleAllow.length) {
  fail(`${staleAllow.length} SAME_AS_ENGLISH entry(ies) no longer describe the catalog — drop them:`)
  for (const e of staleAllow) say(`          ${e}`)
} else ok('every SAME_AS_ENGLISH allowance is still earning its place')

// --- the packed table --------------------------------------------------------

const rows = keys.map((k) => {
  const row: Array<string | 0> = LOCALES.map((c) => {
    const v = catalogs[c][k]
    return typeof v === 'string' && v.length ? v : 0
  })
  while (row.length && row[row.length - 1] === 0) row.pop()   // a short row reads as English
  return [k, row] as const
})

const body = `// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// GENERATED by scripts/test-dash-i18n.ts — do not edit. Run it after changing
// a catalog or adding a t() string; the rig fails if this is out of date:
//
//     node scripts/test-dash-i18n.ts --write
//
// One row per English key: the key is stored ONCE and the translations follow
// by column. \`0\` (or a short row) means "no translation in that locale" and
// falls back to the English key — which is also the source text, so a hole
// degrades to a readable sentence rather than a blank.

/** Column order for every row in PACKED. */
export const PACKED_LOCALES = ${JSON.stringify(LOCALES)} as const

/** English source string -> translations, positional by PACKED_LOCALES. */
export const PACKED: Record<string, ReadonlyArray<string | 0>> = {
${rows.map(([k, r]) => `  ${JSON.stringify(k)}: ${JSON.stringify(r)},`).join('\n')}
}
`

const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null
if (process.argv.includes('--write')) {
  writeFileSync(OUT, body)
  say(`\n  wrote ${relative(root, OUT)} — ${keys.length} strings × ${LOCALES.length} locales`)
} else if (current !== body) {
  fail(`dash/src/i18n/packed.ts is out of date — run: node scripts/test-dash-i18n.ts --write`)
} else {
  ok('packed.ts matches the per-locale catalogs')
}

// --- the wiring, actually run ------------------------------------------------
//
// Everything above reads FILES. This part boots the real facade — the same
// module the app imports — against a stubbed localStorage and navigator, and
// asks it questions. A catalog can be perfect and still never reach a user if
// registration or locale resolution is wrong, and that failure is invisible to
// any amount of static checking: the app just quietly speaks English.
//
// The stubs are deliberately minimal. kernel/src/storage.ts exists because
// reading `localStorage` THROWS in an opaque origin, so it must degrade to
// "unset" rather than crash; giving it a working Map here keeps that path out
// of the way of what is being measured.

const lsStore = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
    setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
    removeItem: (k: string) => { lsStore.delete(k) },
  },
})
const setNav = (language: string) =>
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language } })

const facade = pathToFileURL(join(srcDir, 'i18n.ts')).href
let bust = 0
/** Boot the facade fresh under a given navigator.language. */
async function boot(language: string) {
  setNav(language)
  lsStore.clear()
  // A new query string re-evaluates the facade, whose registerI18n() clears
  // the kernel's memoized locale — which is the only way to re-resolve.
  return (await import(`${facade}?boot=${bust++}`)) as {
    t: (en: string, vars?: Record<string, string | number>) => string
    locale: () => string
    setLocale: (c: string) => void
  }
}

setNav('en')
const probe = ['Save', 'Workbook', 'Pivot', 'Grand total']

// Resolution, including the two ways a full tag has to reach a column: the
// kernel's base-language fallback (fr-CA -> fr) and this app's zh aliases,
// without which a Taiwanese reader lands on English with zh-Hant right there.
const RESOLVE: Array<[string, string]> = [
  ['en-GB', 'en'], ['ja-JP', 'ja'], ['fr-CA', 'fr'], ['de-AT', 'de'],
  ['it-CH', 'it'], ['es-MX', 'es'],
  ['zh-CN', 'zh-Hans'], ['zh-SG', 'zh-Hans'], ['zh', 'zh-Hans'],
  ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'],
  ['pt-BR', 'en'],   // dash carries no pt: it must degrade, not guess
  ['xx-YY', 'en'],
]
let resolveBad = 0
for (const [nav, want] of RESOLVE) {
  const m = await boot(nav)
  // The active code may be the tag itself (an alias column) — compare by what
  // it actually SPEAKS, which is the only thing a reader can tell apart.
  const spoken = probe.map((k) => m.t(k)).join('|')
  const expected = want === 'en' ? probe.join('|') : probe.map((k) => catalogs[want][k] ?? k).join('|')
  if (spoken !== expected) { resolveBad++; fail(`navigator.language "${nav}" should speak ${want} — got ${JSON.stringify(spoken)}`) }
}
if (!resolveBad) ok(`every navigator.language reaches the right catalog (${RESOLVE.length} tags, incl. the zh aliases)`)

{
  const m = await boot('ja-JP')
  const k = '{n} of {all} rows'
  const got = m.t(k, { n: 3, all: 9 })
  if (got === k || /\{n\}|\{all\}/.test(got)) fail(`interpolation into a TRANSLATED string is broken: ${JSON.stringify(got)}`)
  else ok(`{placeholder} interpolation survives translation (ja: ${JSON.stringify(got)})`)

  const miss = 'a string that is in no catalog anywhere'
  if (m.t(miss) !== miss) fail('an untranslated key must fall back to its English self')
  else ok('an unknown key falls back to the English source string')

  m.setLocale('x-pseudo')
  const ps = m.t('Save')
  if (!/^⟦.*⟧$/.test(ps)) fail(`setLocale('x-pseudo') is not reachable — the audit locale is how unswept strings are found (got ${JSON.stringify(ps)})`)
  else ok(`setLocale('x-pseudo') wraps every swept string (Save -> ${ps})`)

  m.setLocale('de')
  if (m.t('Save') !== catalogs['de']['Save']) fail('the About picker path (setLocale) does not switch catalogs')
  else ok('setLocale switches catalogs, as the About picker needs')
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\ndash i18n: all checks passed')
process.exit(failures ? 1 : 0)
