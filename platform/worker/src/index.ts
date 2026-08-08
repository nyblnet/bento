// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The platform Worker. Routes:
//
//   GET  /                    paste-and-create demo page (demo.ts)
//   POST /api/compile         outline JSON -> compiled bento/slides doc JSON (no storage)
//   POST /api/decks           create a deck: { doc } -> { id, editToken }
//   GET  /api/decks/:id       fetch a deck's doc JSON (Authorization: Bearer <editToken>)
//   PATCH /api/decks/:id      replace a deck's doc JSON (same auth)
//   POST /api/decks/:id/assets  upload an image blob (same auth) -> { path }
//   GET  /d/:id                the deck spliced into the shell (a real .bento.html page)
//   GET  /d/:id/download       same, as a downloadable attachment
//   GET  /a/:id/:key           an uploaded asset's bytes
//
// No wrangler.toml — bindings (env.DOCS, env.DB) are added by hand in the CF
// dashboard after pasting dist/worker.js via Quick Edit. See platform/README.md.
import type { Env } from './env.ts'
import { spliceDoc, SHELL_VERSION } from './splice.ts'
import { validateIncomingDoc } from './validate.ts'
import { createDeck, getDeckDoc, checkEditToken, replaceDeckDoc, putAsset, getAsset } from './store.ts'
import { renderDemoPage } from './demo.ts'
import { parseOutline } from './compile/schema.ts'
import { compileOutline } from './compile/compile.ts'

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...init.headers },
  })
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { ...init, headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers } })
}

function bearerToken(req: Request): string {
  const auth = req.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

async function requireEditAccess(req: Request, env: Env, id: string): Promise<Response | null> {
  const ok = await checkEditToken(env, id, bearerToken(req))
  if (!ok) return json({ error: 'invalid or missing edit token' }, { status: 401 })
  return null
}

function notFound(): Response {
  return html('<!DOCTYPE html><title>Not found</title><p>No deck at this address.</p>', { status: 404 })
}

async function handleCreate(req: Request, env: Env): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const doc = (body as { doc?: unknown })?.doc
  const result = validateIncomingDoc(doc)
  if (!result.ok) return json({ errors: result.errors }, { status: 422 })
  const { id, editToken } = await createDeck(env, result.doc!)
  return json({ id, editToken, url: `/d/${id}` }, { status: 201 })
}

async function handleCompile(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const outlineInput = (body as { outline?: unknown })?.outline
  const parsed = parseOutline(outlineInput)
  if (!parsed.ok) return json({ errors: parsed.errors }, { status: 422 })

  const doc = compileOutline(parsed.outline!)
  // Defense in depth: the compiled doc must itself pass the same ingest gate
  // a hand-pasted doc would (validate.ts) — a compiler bug that emitted an
  // svg element or a bad image src should fail loudly here, not ship.
  const result = validateIncomingDoc(doc)
  if (!result.ok) {
    console.error('compileOutline produced an invalid doc', result.errors)
    return json({ error: 'internal error: compiled doc failed validation' }, { status: 500 })
  }
  return json({ doc: result.doc })
}

async function handleGetDoc(req: Request, env: Env, id: string): Promise<Response> {
  const denied = await requireEditAccess(req, env, id)
  if (denied) return denied
  const doc = await getDeckDoc(env, id)
  if (!doc) return notFound()
  return json({ doc })
}

async function handleReplace(req: Request, env: Env, id: string): Promise<Response> {
  const denied = await requireEditAccess(req, env, id)
  if (denied) return denied
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const doc = (body as { doc?: unknown })?.doc
  const result = validateIncomingDoc(doc)
  if (!result.ok) return json({ errors: result.errors }, { status: 422 })
  await replaceDeckDoc(env, id, result.doc!)
  return json({ ok: true })
}

async function handleUploadAsset(req: Request, env: Env, id: string): Promise<Response> {
  const denied = await requireEditAccess(req, env, id)
  if (denied) return denied
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) {
    return json({ error: 'content-type must be image/*' }, { status: 400 })
  }
  const bytes = await req.arrayBuffer()
  const MAX_ASSET_BYTES = 8 * 1024 * 1024 // matches slides' MEDIA_EMBED_BUDGET
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return json({ error: `asset is ${bytes.byteLength} bytes, over the ${MAX_ASSET_BYTES} limit` }, { status: 413 })
  }
  const result = await putAsset(env, id, bytes, contentType)
  return json(result, { status: 201 })
}

async function handleView(env: Env, id: string, download: boolean): Promise<Response> {
  const doc = await getDeckDoc(env, id)
  if (!doc) return notFound()
  const spliced = spliceDoc(doc)
  const headers: HeadersInit = {}
  if (download) {
    const title = typeof (doc as { title?: unknown }).title === 'string' ? (doc as { title: string }).title : 'deck'
    const filename = title.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'deck'
    headers['content-disposition'] = `attachment; filename="${filename}.bento.html"`
  }
  return html(spliced, { headers })
}

async function handleAsset(env: Env, id: string, key: string): Promise<Response> {
  const obj = await getAsset(env, id, key)
  if (!obj) return notFound()
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)

    try {
      if (parts.length === 0 && req.method === 'GET') return html(renderDemoPage())

      if (parts[0] === 'api' && parts[1] === 'compile' && parts.length === 2 && req.method === 'POST') {
        return handleCompile(req)
      }

      if (parts[0] === 'api' && parts[1] === 'decks') {
        if (parts.length === 2 && req.method === 'POST') return handleCreate(req, env)
        if (parts.length === 3 && req.method === 'GET') return handleGetDoc(req, env, parts[2]!)
        if (parts.length === 3 && req.method === 'PATCH') return handleReplace(req, env, parts[2]!)
        if (parts.length === 4 && parts[3] === 'assets' && req.method === 'POST') {
          return handleUploadAsset(req, env, parts[2]!)
        }
      }

      if (parts[0] === 'd' && parts.length === 2 && req.method === 'GET') {
        return handleView(env, parts[1]!, false)
      }
      if (parts[0] === 'd' && parts.length === 3 && parts[2] === 'download' && req.method === 'GET') {
        return handleView(env, parts[1]!, true)
      }

      if (parts[0] === 'a' && parts.length === 3 && req.method === 'GET') {
        return handleAsset(env, parts[1]!, parts[2]!)
      }

      if (parts[0] === 'healthz') return json({ ok: true, shellVersion: SHELL_VERSION })

      return notFound()
    } catch (e) {
      console.error(e)
      return json({ error: 'internal error' }, { status: 500 })
    }
  },
}
