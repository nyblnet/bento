// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The platform Worker. Routes:
//
//   GET  /setup                one-time owner setup form (redirects to /login once config exists)
//   POST /api/setup             create the (only) owner account — 409 if one already exists
//   GET  /login                 owner login form
//   POST /api/login              verify credentials, start a session
//   POST /api/logout             end the current session
//   GET  /                     compile+create wizard + deck history sidebar (demo.ts) — OWNER ONLY
//   POST /api/compile           outline JSON -> compiled bento/slides doc JSON (no storage) — OWNER ONLY
//   GET  /api/decks             list decks, most-recently-touched first (sidebar data) — OWNER ONLY
//   POST /api/decks             create a deck: { doc } -> { id } — OWNER ONLY
//   GET  /api/decks/:id         fetch a deck's doc JSON — OWNER ONLY
//   PATCH /api/decks/:id        replace a deck's doc JSON — OWNER ONLY
//   POST /api/decks/:id/assets  upload an image blob — OWNER ONLY
//   GET  /d/:id                the deck spliced into the shell (a real .bento.html page)
//   GET  /d/:id/download        same, as a downloadable attachment
//   GET  /a/:id/:key            an uploaded asset's bytes
//
// "OWNER ONLY" = gated by a session cookie (auth.ts) — single account,
// created once via /setup, no signup. Viewing a deck (/d/:id, /a/:id/:key)
// is NOT yet gated here — every deck is reachable by anyone who has its
// unguessable id, same as before auth existed. Per-deck public/private
// access control is deliberately a separate PR (it needs its own `decks`
// column and its own review), not folded into this one — see
// docs/DECISIONS.md.
//
// wrangler.toml (bindings, no secrets) drives the primary Workers Builds
// deploy path; the "paste dist/worker.js into Quick Edit" fallback documented
// in platform/README.md doesn't touch this file at all. See platform/README.md.
import type { Env } from './env.ts'
import { spliceDoc, SHELL_VERSION } from './splice.ts'
import { validateIncomingDoc } from './validate.ts'
import { createDeck, getDeckDoc, replaceDeckDoc, putAsset, getAsset, listDecks } from './store.ts'
import { renderDemoPage } from './demo.ts'
import { renderSetupPage, renderLoginPage } from './authPages.ts'
import { parseOutline } from './compile/schema.ts'
import { compileOutline } from './compile/compile.ts'
import {
  getConfig,
  createConfig,
  verifyPassword,
  createSession,
  deleteSession,
  readSessionCookie,
  setSessionCookieHeader,
  clearSessionCookieHeader,
  isAuthenticated,
} from './auth.ts'

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

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

function notFound(): Response {
  return html('<!DOCTYPE html><title>Not found</title><p>No deck at this address.</p>', { status: 404 })
}

/** Where the caller stands relative to the single-owner account. */
type Gate = 'ok' | 'needs-setup' | 'needs-login'

async function ownerGate(req: Request, env: Env): Promise<Gate> {
  if (!(await getConfig(env))) return 'needs-setup'
  return (await isAuthenticated(req, env)) ? 'ok' : 'needs-login'
}

/** For HTML page routes: redirects instead of continuing. Returns null when
 *  the caller may proceed. */
async function requireOwnerPage(req: Request, env: Env): Promise<Response | null> {
  const gate = await ownerGate(req, env)
  if (gate === 'needs-setup') return redirect('/setup')
  if (gate === 'needs-login') return redirect('/login')
  return null
}

/** For JSON API routes: a 401 body instead of a redirect. Returns null when
 *  the caller may proceed. */
async function requireOwnerApi(req: Request, env: Env): Promise<Response | null> {
  const gate = await ownerGate(req, env)
  if (gate === 'ok') return null
  return json({ error: gate === 'needs-setup' ? 'not set up yet' : 'not authenticated' }, { status: 401 })
}

// --- auth routes -------------------------------------------------------

async function handleSetupPage(env: Env): Promise<Response> {
  if (await getConfig(env)) return redirect('/login')
  return html(renderSetupPage())
}

async function handleSetupSubmit(req: Request, env: Env): Promise<Response> {
  if (await getConfig(env)) return json({ error: 'already set up' }, { status: 409 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown }
  if (typeof username !== 'string' || !username.trim()) {
    return json({ error: 'username is required' }, { status: 422 })
  }
  if (typeof password !== 'string' || password.length < 8) {
    return json({ error: 'password must be at least 8 characters' }, { status: 422 })
  }
  await createConfig(env, username.trim(), password)
  const sessionId = await createSession(env)
  return json({ ok: true }, { headers: { 'set-cookie': setSessionCookieHeader(sessionId) } })
}

async function handleLoginPage(req: Request, env: Env): Promise<Response> {
  const gate = await ownerGate(req, env)
  if (gate === 'needs-setup') return redirect('/setup')
  if (gate === 'ok') return redirect('/')
  return html(renderLoginPage())
}

async function handleLoginSubmit(req: Request, env: Env): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown }
  if (typeof username !== 'string' || typeof password !== 'string') {
    return json({ error: 'username and password are required' }, { status: 400 })
  }
  if (!(await verifyPassword(env, username, password))) {
    return json({ error: 'invalid username or password' }, { status: 401 })
  }
  const sessionId = await createSession(env)
  return json({ ok: true }, { headers: { 'set-cookie': setSessionCookieHeader(sessionId) } })
}

async function handleLogout(req: Request, env: Env): Promise<Response> {
  const sessionId = readSessionCookie(req)
  if (sessionId) await deleteSession(env, sessionId)
  return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookieHeader() } })
}

// --- deck routes ---------------------------------------------------------

async function handleListDecks(env: Env): Promise<Response> {
  const decks = await listDecks(env)
  return json({
    decks: decks.map((d) => ({ id: d.id, title: d.title, createdAt: d.created_at, updatedAt: d.updated_at })),
  })
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
  const { id } = await createDeck(env, result.doc!)
  return json({ id, url: `/d/${id}` }, { status: 201 })
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

async function handleGetDoc(env: Env, id: string): Promise<Response> {
  const doc = await getDeckDoc(env, id)
  if (!doc) return notFound()
  return json({ doc })
}

async function handleReplace(req: Request, env: Env, id: string): Promise<Response> {
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
      // Every branch below MUST `await` its handler before returning, even
      // though every handler already returns a Promise<Response> that a
      // bare `return handler(...)` would type-check against just fine.
      // `return promise` (not awaited) makes the try block complete
      // immediately, handing back a still-pending promise — so a REJECTION
      // that promise has later never runs through this catch at all; it
      // surfaces to the Workers runtime as an uncaught exception (Cloudflare's
      // generic "error code: 1101" page instead of our JSON error response).
      // Caught in production the hard way once already — see docs/DECISIONS.md.
      if (parts[0] === 'setup' && parts.length === 1) {
        if (req.method === 'GET') return await handleSetupPage(env)
      }
      if (parts[0] === 'login' && parts.length === 1) {
        if (req.method === 'GET') return await handleLoginPage(req, env)
      }
      if (parts[0] === 'api' && parts[1] === 'setup' && parts.length === 2 && req.method === 'POST') {
        return await handleSetupSubmit(req, env)
      }
      if (parts[0] === 'api' && parts[1] === 'login' && parts.length === 2 && req.method === 'POST') {
        return await handleLoginSubmit(req, env)
      }
      if (parts[0] === 'api' && parts[1] === 'logout' && parts.length === 2 && req.method === 'POST') {
        return await handleLogout(req, env)
      }

      if (parts.length === 0 && req.method === 'GET') {
        const denied = await requireOwnerPage(req, env)
        if (denied) return denied
        return html(renderDemoPage())
      }

      if (parts[0] === 'api' && parts[1] === 'compile' && parts.length === 2 && req.method === 'POST') {
        const denied = await requireOwnerApi(req, env)
        if (denied) return denied
        return await handleCompile(req)
      }

      if (parts[0] === 'api' && parts[1] === 'decks') {
        if (parts.length === 2 && req.method === 'GET') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleListDecks(env)
        }
        if (parts.length === 2 && req.method === 'POST') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleCreate(req, env)
        }
        if (parts.length === 3 && req.method === 'GET') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleGetDoc(env, parts[2]!)
        }
        if (parts.length === 3 && req.method === 'PATCH') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleReplace(req, env, parts[2]!)
        }
        if (parts.length === 4 && parts[3] === 'assets' && req.method === 'POST') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleUploadAsset(req, env, parts[2]!)
        }
      }

      if (parts[0] === 'd' && parts.length === 2 && req.method === 'GET') {
        return await handleView(env, parts[1]!, false)
      }
      if (parts[0] === 'd' && parts.length === 3 && parts[2] === 'download' && req.method === 'GET') {
        return await handleView(env, parts[1]!, true)
      }

      if (parts[0] === 'a' && parts.length === 3 && req.method === 'GET') {
        return await handleAsset(env, parts[1]!, parts[2]!)
      }

      if (parts[0] === 'healthz') return json({ ok: true, shellVersion: SHELL_VERSION })

      return notFound()
    } catch (e) {
      console.error(e)
      return json({ error: 'internal error' }, { status: 500 })
    }
  },
}
