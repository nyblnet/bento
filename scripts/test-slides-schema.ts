#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/slides JSON Schema: built from the gate's tables, published for
// agents, pinned to the runtime.
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-schema.ts --bundle --platform=node --format=esm --outfile=/tmp/t.mjs && node /tmp/t.mjs
//
// WHAT THIS PROVES. (1) The checked-in schema/slides.json is byte-for-byte
// what slides/src/schema.ts builds, and window.bento.schema() is that same
// function — one source. (2) The schema's key set per element type equals the
// gate's key set: a field taught to the gate and not the schema, or the other
// way round, fails here. (3) The starter deck (and the gallery fixtures when
// present) validate against it with a small validator for exactly the subset
// of JSON Schema the generator emits; a deck with an unknown key does not.
// (4) `$schema` at the top of a deck is stripped on load, and BOTH the 1.1.0
// release's parseDoc and main's accept a deck carrying it (frozen copies of
// their one condition line, sha-noted) — ignored, never rejected — which is
// what lets save.ts write it. (5) The URL is a pointer, not a beacon: nothing
// in the runtime fetches, imports or links it.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildSchema, SCHEMA_URL, stampSchema } from '../slides/src/schema.ts'
import { starterDoc } from '../slides/src/starterdeck.ts'
import { parseDoc, FORMAT } from '../slides/src/model.ts'
import { MODEL_KEYS } from '../slides/src/modelkeys.generated.ts'
import { CHECKED_KEYS } from '../slides/src/untrusted.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
// bundled into a temp file in CI, so the repo root is the cwd, as the other bundled rigs do
const root = process.cwd()
const read = (f: string) => readFileSync(join(root, f), 'utf8')
type J = Record<string, unknown>
const version = JSON.parse(read('slides/package.json')).version as string

// --- a validator for the subset the generator emits ------------------------
function validate(schema: J, value: unknown, root: J, path = '$'): string[] {
  const errs: string[] = []
  const e = (m: string) => errs.push(`${path}: ${m}`)
  if (typeof schema.$ref === 'string') {
    const target = (schema.$ref as string).replace('#/', '').split('/').reduce<unknown>((o, k) => (o as J)?.[k], root) as J
    if (!target) return [`${path}: dangling $ref ${schema.$ref}`]
    return validate(target, value, root, path)
  }
  if (Array.isArray(schema.anyOf)) {
    if (!(schema.anyOf as J[]).some((s) => validate(s, value, root, path).length === 0)) e('matches no anyOf branch')
    return errs
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as J[]
    const n = branches.filter((s) => validate(s, value, root, path).length === 0).length
    if (n === 1) return errs
    // the element union is discriminated by `type`: report THAT branch's
    // errors, so a typo'd key is named rather than "no branch matched"
    const resolve = (s: J): J => (typeof s.$ref === 'string' ? (s.$ref as string).replace('#/', '').split('/').reduce<unknown>((o, k) => (o as J)?.[k], root) as J : s)
    const disc = value && typeof value === 'object' ? (value as J).type : undefined
    const mine = branches.map(resolve).find((s) => ((s.properties as J)?.type as J)?.const === disc)
    if (mine) errs.push(...validate(mine, value, root, path))
    else e(`matches ${n} oneOf branches`)
    return errs
  }
  if ('const' in schema && value !== schema.const) e(`expected const ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) e(`not one of ${JSON.stringify(schema.enum)}`)
  const t = schema.type
  if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) e('not a number')
    else {
      if (t === 'integer' && !Number.isInteger(value)) e('not an integer')
      if (typeof schema.minimum === 'number' && value < schema.minimum) e(`< ${schema.minimum}`)
      if (typeof schema.maximum === 'number' && value > schema.maximum) e(`> ${schema.maximum}`)
    }
  } else if (t === 'string') {
    if (typeof value !== 'string') e('not a string')
    else {
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) e('too long')
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) e(`fails /${schema.pattern}/`)
    }
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') e('not a boolean')
  } else if (t === 'array') {
    if (!Array.isArray(value)) e('not an array')
    else {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) e('too few items')
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) e('too many items')
      if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items as J, v, root, `${path}[${i}]`)))
    }
  } else if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) e('not an object')
    else {
      const props = (schema.properties ?? {}) as Record<string, J>
      for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in (value as J))) e(`missing ${k}`)
      for (const [k, v] of Object.entries(value as J)) {
        if (k in props) errs.push(...validate(props[k], v, root, `${path}.${k}`))
        else if (schema.additionalProperties === false) e(`unknown key ${k}`)
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties as J, v, root, `${path}.${k}`))
      }
      if (typeof schema.maxProperties === 'number' && Object.keys(value as J).length > schema.maxProperties) e('too many properties')
    }
  }
  return errs
}
const check = (doc: unknown, schema: J) => validate(schema, doc, schema)

console.log('one source\n')
const built = buildSchema(version)
const file = JSON.parse(read('schema/slides.json')) as J
ok(JSON.stringify(built) === JSON.stringify(file), 'schema/slides.json is byte-for-byte what buildSchema(version) returns (build-schema.mjs --check pins it in CI too)')
ok(file.$id === SCHEMA_URL && file.$id === 'https://bento.page/schema/slides.json', `$id is the published URL (${file.$id})`)
ok(file['x-bento-version'] === version, `stamped with the shell version ${version}`)
ok(existsSync(join(root, `schema/slides-${version}.json`)), 'a version-pinned twin exists')
const mainSrc = read('slides/src/main.ts')
ok(/schema\(\)\s*\{\s*return buildSchema\(APP_VERSION\)/.test(mainSrc), 'window.bento.schema() is the same function, stamped with the running version')

console.log('\nthe gate and the schema agree\n')
const defs = file.$defs as Record<string, J>
for (const type of Object.keys(MODEL_KEYS.element)) {
  const keys = (MODEL_KEYS.element as Record<string, readonly string[]>)[type]
  const schemaKeys = Object.keys((defs[type].properties as J)).sort()
  const gateKeys = keys.filter((k) => CHECKED_KEYS.element.includes(k)).sort()
  ok(schemaKeys.join() === gateKeys.join(), `${type}: schema keys == gate keys (${schemaKeys.length})`)
  ok((defs[type].required as string[]).includes('type') && (defs[type].required as string[]).includes('id'), `${type}: type and id required`)
}
ok(Object.keys(defs.slide.properties as J).sort().join() === [...MODEL_KEYS.slide].filter((k) => CHECKED_KEYS.slide.includes(k)).sort().join(), 'slide: schema keys == gate keys')
ok(Object.keys(defs.doc.properties as J).sort().join() === [...MODEL_KEYS.doc, '$schema', 'compact'].sort().join(), 'doc: every model key plus $schema and the compact flag')
ok(Object.keys(defs.theme.properties as J).sort().join() === [...MODEL_KEYS.theme].sort().join(), 'theme: keys from model.ts (via modelkeys.generated.ts)')

console.log('\nreal decks validate; a typo does not\n')
const starter = JSON.parse(JSON.stringify(starterDoc()))
const starterErrs = check(starter, file)
ok(starterErrs.length === 0, `the starter deck validates (${starterErrs.length} errors${starterErrs.length ? ': ' + starterErrs.slice(0, 3).join('; ') : ''})`)
const fixtures = join(root, 'scripts/fixtures/compact-decks')
if (existsSync(fixtures)) {
  for (const f of readdirSync(fixtures).filter((f) => f.endsWith('.json'))) {
    const errs = check(JSON.parse(readFileSync(join(fixtures, f), 'utf8')), file)
    ok(errs.length === 0, `${f} validates (${errs.length}${errs.length ? ': ' + errs.slice(0, 3).join('; ') : ''})`)
  }
}
const typo = JSON.parse(JSON.stringify(starter))
typo.slides[0].elements[0].fontsize = 12
ok(check(typo, file).some((m) => /unknown key fontsize/.test(m)), 'an element with `fontsize` (typo) fails with the key named')
const badEnum = JSON.parse(JSON.stringify(starter))
badEnum.slides[0].transition = 'wipe'
ok(check(badEnum, file).some((m) => /transition/.test(m)), 'an unknown transition fails')
const noFormat = { slides: [] }
ok(check(noFormat, file).length > 0, 'no format / no slides fails')
const withSchema = { ...JSON.parse(JSON.stringify(starter)), $schema: SCHEMA_URL }
ok(check(withSchema, file).length === 0, 'a deck carrying $schema validates')

console.log('\n$schema is a pointer for readers, never document data\n')
const loaded = parseDoc(JSON.stringify(withSchema))
ok(!!loaded && !('$schema' in loaded), 'parseDoc strips $schema on load')
// Frozen from the 1.1.0 release (03280f5) and origin/main (131015e): the one
// condition parseDoc applies. Neither looks at unknown top-level keys, so a
// deck carrying $schema is accepted and the key rides along untouched — an
// old shell keeps it and writes it back; its validate() lists it as unknown.
const frozenCondition = (doc: J) => !!(doc && doc.format === FORMAT && Array.isArray(doc.slides) && (doc.slides as unknown[]).length > 0)
const releaseSrc = 'if (doc && doc.format === FORMAT && Array.isArray(doc.slides) && doc.slides.length > 0) {'
ok(frozenCondition(withSchema), '1.1.0 (03280f5) parseDoc accepts a deck carrying $schema (frozen condition)')
ok(read('slides/src/model.ts').includes(releaseSrc), "main's parseDoc still applies exactly that condition (source check)")

console.log('\nthe saved JSON opens with its pointer\n')
{
  const live = JSON.parse(JSON.stringify(starter))
  const stamped = stampSchema(live)
  ok(Object.keys(stamped)[0] === '$schema' && stamped.$schema === SCHEMA_URL, 'stampSchema puts $schema FIRST, with the published URL')
  ok(!('$schema' in live), 'the input object is untouched (a new object, not a mutation)')
  ok(JSON.stringify(stamped).startsWith('{"$schema":"https://bento.page/schema/slides.json",'), 'serialized, the file starts with the pointer (50 B)')
  const again = parseDoc(JSON.stringify(stamped))
  ok(!!again && !('$schema' in again), 'load → save → load: the live document never carries it')
  const facade = read('slides/src/save.ts')
  ok(/function prepareForSave[\s\S]*stampSchema\(pruneUnusedAssets\(adoptBuiltinFonts\(doc\)\)\)/.test(facade), 'prepareForSave stamps the pointer on every write path (⌘S, autosave, exports, serialize())')
}

console.log('\nno beacon\n')
const carriers: string[] = []
for (const dir of ['slides/src', 'kernel/src']) {
  const walk = (d: string) => {
    for (const f of readdirSync(join(root, d), { withFileTypes: true })) {
      const p = `${d}/${f.name}`
      if (f.isDirectory()) walk(p)
      else if (/\.(ts|css|html)$/.test(f.name) && !/\.generated\./.test(f.name)) {
        const src = readFileSync(join(root, p), 'utf8')
        if (!src.includes('bento.page/schema')) continue
        carriers.push(p)
        const lines = src.split('\n').filter((l) => l.includes('bento.page/schema'))
        ok(!lines.some((l) => /fetch\(|import\(|href=|src=|new URL\(/.test(l)), `${p}: the URL is text only (${lines.length} line${lines.length === 1 ? '' : 's'})`)
      }
    }
  }
  walk(dir)
}
ok(carriers.length > 0 && carriers.includes('slides/src/schema.ts'), `the URL appears as text in: ${carriers.join(', ')}`)
const tooling = read('scripts/postbuild-compress.mjs')
ok(tooling.includes('https://bento.page/schema/slides.json') && tooling.includes('https://bento.page/llms.txt') && tooling.includes('window.bento.schema()'), 'the Tooling comment names the URL, schema() and llms.txt')
const llms = read('site-src/llms.txt')
ok(/^# /.test(llms) && llms.includes('https://bento.page/schema/slides.json') && llms.includes('agents.md'), 'llms.txt exists with the schema and the agent guide')
ok(read('scripts/release.mjs').includes("'llms.txt'") && read('scripts/release.mjs').includes("'schema'"), 'release.mjs stages llms.txt and schema/ into the site')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
