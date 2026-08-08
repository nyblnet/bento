#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// End-to-end smoke test against the BUNDLED worker (dist/worker.js) with
// in-memory R2/D1 mocks standing in for the real Cloudflare bindings — this
// is what proves create → view → download → asset-upload actually works as
// one flow, not just that each module typechecks in isolation. Run after
// `npm run build`:
//
//   node test/router.test.mjs

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distPath = join(here, '..', 'dist', 'worker.js')

let worker
try {
  worker = (await import(pathToFileURL(distPath).href)).default
} catch (e) {
  console.error(`✗ could not import ${distPath}: ${e.message}`)
  console.error('  run `npm run build` in platform/worker/ first')
  process.exit(2)
}

// --- in-memory mocks for R2Bucket / D1Database -----------------------------

function makeR2() {
  const objects = new Map()
  return {
    async put(key, value, opts) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
      objects.set(key, { bytes: new Uint8Array(bytes), httpMetadata: opts?.httpMetadata })
    },
    async get(key) {
      const obj = objects.get(key)
      if (!obj) return null
      return {
        httpMetadata: obj.httpMetadata,
        body: obj.bytes,
        async text() {
          return new TextDecoder().decode(obj.bytes)
        },
      }
    },
  }
}

function makeD1() {
  const rows = new Map() // id -> row
  return {
    prepare(sql) {
      let boundArgs = []
      const stmt = {
        bind(...args) {
          boundArgs = args
          return stmt
        },
        async run() {
          if (sql.startsWith('INSERT INTO decks')) {
            const [id, title, created_at, updated_at, edit_token_hash, shell_version, doc_bytes] = boundArgs
            rows.set(id, { id, title, created_at, updated_at, edit_token_hash, shell_version, doc_bytes })
          } else if (sql.startsWith('UPDATE decks')) {
            const [title, updated_at, doc_bytes, id] = boundArgs
            const row = rows.get(id)
            if (row) Object.assign(row, { title, updated_at, doc_bytes })
          }
          return { success: true }
        },
        async first() {
          if (sql.includes('edit_token_hash FROM decks')) {
            const row = rows.get(boundArgs[0])
            return row ? { edit_token_hash: row.edit_token_hash } : null
          }
          return rows.get(boundArgs[0]) ?? null
        },
      }
      return stmt
    },
  }
}

const env = { DOCS: makeR2(), DB: makeD1() }

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ✗ ${name}: ${e.stack ?? e.message}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

// Reads the body exactly once (a Response body can only be consumed once)
// and hands back both the parsed JSON (if any) and the raw text, so a check
// can assert on status AND inspect the body without a second read — and
// without the classic bug of an eagerly-evaluated assert() message consuming
// the body before the "real" read runs.
async function readBody(res) {
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  return { text, data }
}

console.log('platform worker router smoke test')

const exampleDoc = {
  format: 'bento/slides',
  version: 1,
  title: 'Router test deck',
  size: { width: 1280, height: 720 },
  theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E', fontFamily: 'system-ui' },
  slides: [
    {
      id: 's1',
      background: '#0D1B2E',
      transition: 'none',
      notes: '',
      elements: [
        {
          id: 'headline',
          type: 'text',
          x: 96,
          y: 260,
          w: 1088,
          h: 200,
          html: 'Router test',
          fontSize: 96,
          fontFamily: 'system-ui',
          fontWeight: 900,
          color: '#F5F7FA',
          align: 'left',
          valign: 'top',
          lineHeight: 1,
          rotation: 0,
          opacity: 1,
        },
      ],
    },
  ],
  // a doc that arrives already carrying collab must have it stripped on ingest
  collab: { on: true, key: 'should-be-stripped' },
}

let deckId, editToken

await check('GET / serves the compile+create demo page with both steps intact', async () => {
  const res = await worker.fetch(new Request('https://platform.example/'), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(text.includes('id="outline"'), 'outline textarea missing — template structure likely broken')
  assert(text.includes('id="doc"'), 'doc textarea missing — template structure likely broken')
  assert(text.includes("getElementById('compile')"), 'compile button wiring missing')
  assert(text.includes("getElementById('create')"), 'create button wiring missing')
})

await check('POST /api/decks creates a deck and strips collab', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: exampleDoc }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  assert(data?.id && data?.editToken, 'response missing id/editToken')
  deckId = data.id
  editToken = data.editToken
})

await check('POST /api/decks rejects an svg element', async () => {
  const doc = { ...exampleDoc, slides: [{ ...exampleDoc.slides[0], elements: [{ id: 'x', type: 'svg', markup: '<svg/>' }] }] }
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc }),
    }),
    env,
  )
  const { text } = await readBody(res)
  assert(res.status === 422, `expected 422, got ${res.status}: ${text}`)
})

await check('POST /api/decks rejects a javascript: image src', async () => {
  const doc = {
    ...exampleDoc,
    slides: [{ ...exampleDoc.slides[0], elements: [{ id: 'x', type: 'image', src: 'javascript:alert(1)' }] }],
  }
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc }),
    }),
    env,
  )
  const { text } = await readBody(res)
  assert(res.status === 422, `expected 422, got ${res.status}: ${text}`)
})

await check('GET /d/:id serves a spliced .bento.html containing the doc and no live collab', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${deckId}`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(text.includes('Router test'), 'spliced page does not contain the deck title/content')
  assert(!text.includes('should-be-stripped'), 'collab key leaked into the spliced output')
  assert(text.match(/id="bento-doc"/g)?.length === 1, 'expected exactly one #bento-doc block')
})

await check('GET /d/:id/download sets a Content-Disposition attachment header', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${deckId}/download`), env)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(res.headers.get('content-disposition')?.includes('attachment'), 'missing attachment disposition')
})

await check('GET /d/:id for an unknown id is 404', async () => {
  const res = await worker.fetch(new Request('https://platform.example/d/does-not-exist'), env)
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('GET /api/decks/:id without a token is 401', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/api/decks/${deckId}`), env)
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('GET /api/decks/:id with the correct edit token succeeds', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}`, {
      headers: { authorization: `Bearer ${editToken}` },
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(data.doc.title === 'Router test deck', 'unexpected doc content')
})

await check('PATCH /api/decks/:id with a wrong token is rejected', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'Hijacked' } }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('PATCH /api/decks/:id with the right token updates the doc', async () => {
  const updated = { ...exampleDoc, title: 'Updated title' }
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${editToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ doc: updated }),
    }),
    env,
  )
  const { text: patchText } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${patchText}`)
  const viewRes = await worker.fetch(new Request(`https://platform.example/d/${deckId}`), env)
  const { text: viewText } = await readBody(viewRes)
  assert(viewText.includes('Updated title'), 'view did not reflect the PATCHed doc')
})

await check('POST /api/decks/:id/assets stores an image and it is fetchable', async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}/assets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${editToken}`, 'content-type': 'image/png' },
      body: pngBytes,
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  assert(data.path.startsWith(`/a/${deckId}/`), `unexpected asset path ${data.path}`)
  const assetRes = await worker.fetch(new Request(`https://platform.example${data.path}`), env)
  assert(assetRes.status === 200, `asset fetch expected 200, got ${assetRes.status}`)
  assert(assetRes.headers.get('content-type') === 'image/png', 'wrong content-type on stored asset')
})

const exampleOutline = {
  title: 'Compiled deck',
  theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E' },
  slides: [
    { layout: 'title', heading: 'From an outline', subheading: 'via POST /api/compile' },
    { layout: 'stat', value: 42, label: 'The answer' },
  ],
}

await check('POST /api/compile turns an outline into a doc, without storing anything', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outline: exampleOutline }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(data.doc.format === 'bento/slides', 'compiled doc has the wrong format')
  assert(data.doc.slides.length === 2, 'compiled doc has the wrong slide count')
})

await check('POST /api/compile rejects an invalid outline with field errors', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outline: { slides: [{ layout: 'title' }] } }), // missing title + heading
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 422, `expected 422, got ${res.status}: ${text}`)
  assert(Array.isArray(data.errors) && data.errors.length >= 2, 'expected multiple field errors')
})

await check('a compiled doc round-trips through POST /api/decks and renders in the spliced view', async () => {
  const compileRes = await worker.fetch(
    new Request('https://platform.example/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outline: exampleOutline }),
    }),
    env,
  )
  const { data: compiled } = await readBody(compileRes)

  const createRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: compiled.doc }),
    }),
    env,
  )
  const { data: created, text: createText } = await readBody(createRes)
  assert(createRes.status === 201, `expected 201, got ${createRes.status}: ${createText}`)

  const viewRes = await worker.fetch(new Request(`https://platform.example/d/${created.id}`), env)
  const { text: viewText } = await readBody(viewRes)
  assert(viewRes.status === 200, `expected 200, got ${viewRes.status}`)
  assert(viewText.includes('From an outline'), 'compiled title text missing from the spliced view')
  assert(viewText.includes('42'), 'compiled stat value missing from the spliced view')
})

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
