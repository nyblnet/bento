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
//   POST /api/decks             create a deck: { doc } or { html } -> { id } — OWNER ONLY
//   GET  /api/decks/:id         fetch a deck's content — OWNER ONLY
//   PATCH /api/decks/:id        replace a deck's stored content — { doc } for 'bento',
//                               { html } for 'html' (re-upload, overwriting in place) — OWNER ONLY
//   PATCH /api/decks/:id/access  change the deck's access level — OWNER ONLY
//   PATCH /api/decks/:id/title  rename a deck — OWNER ONLY
//   PATCH /api/decks/:id/pin    pin/unpin a deck (stays atop the sidebar list) — OWNER ONLY
//   PATCH /api/decks/:id/project  file a deck under a project, or null to unfile — OWNER ONLY
//   DELETE /api/decks/:id       permanently delete a deck (D1 row + R2 doc/assets) — OWNER ONLY
//   POST /api/decks/:id/assets  upload an image blob — OWNER ONLY
//   GET  /api/projects          list projects (sidebar folders), alphabetical — OWNER ONLY
//   POST /api/projects          create a project: { name } -> { id } — OWNER ONLY
//   PATCH /api/projects/:id     rename a project: { name } — OWNER ONLY
//   DELETE /api/projects/:id    delete a project (unassigns its decks, does NOT delete them) — OWNER ONLY
//   GET  /d/:id                the deck: a 'bento' deck spliced into the shell, or an
//                               'html' deck sandboxed in an iframe wrapper — see handleView
//   GET  /d/:id/download        same content, as a downloadable attachment (raw bytes for 'html')
//   GET  /a/:id/:key            an uploaded asset's bytes
//
// "OWNER ONLY" = gated by a session cookie (auth.ts) — single account,
// created once via /setup, no signup. What a non-owner (no valid session)
// gets from /d/:id, /d/:id/download, and /a/:id/:key depends on the deck's
// `access` column (migrations/0004_access.sql, store.ts's DeckAccess,
// default 'edit' — matches how every deck link behaved before this column
// existed):
//   'private' — handleView/handleAsset 404, identically to an unknown id.
//     A private deck's very existence isn't observable without the owner's
//     session; there is no "it exists but you can't open it" response.
//   'view'    — handleView serves the doc with `readonly: true` spliced in,
//     which boots Bento straight into its own PLAYER mode (present-only, no
//     editor chrome — see CLAUDE.md's "File modes" section) instead of a
//     bespoke read-only renderer. Assets still serve (needed to render it).
//   'edit'    — the live editor, same as always.
// The OWNER's own session always gets the full editable doc/assets
// regardless of `access` — the column only affects anonymous viewers. See
// docs/DECISIONS.md.
//
// Every deck also has a `kind` (migrations/0005_kind.sql, store.ts's
// DeckKind): 'bento' (the above) or 'html' — an opaque, self-contained HTML
// file a chat AI produced directly (not through Bento's own compiler),
// stored and served byte-for-byte, never parsed or edited. 'html' decks
// only ever have 'private' or 'view' access — 'edit' means nothing when
// there's no document to edit in place, so handleCreate coerces it to
// 'view' rather than rejecting it. See handleView for why an 'html' deck is
// served through a SANDBOXED IFRAME WRAPPER, not directly at this origin.
//
// wrangler.toml (bindings, no secrets) drives the primary Workers Builds
// deploy path; the "paste dist/worker.js into Quick Edit" fallback documented
// in platform/README.md doesn't touch this file at all. See platform/README.md.
import type { Env } from './env.ts'
import { spliceDoc, SHELL_VERSION } from './splice.ts'
import { validateIncomingDoc } from './validate.ts'
import {
  createDeck,
  createHtmlDeck,
  getDeckDoc,
  getDeckHtml,
  getDeckMeta,
  replaceDeckDoc,
  replaceHtmlDeck,
  renameHtmlDeck,
  setDeckAccess,
  setDeckPinned,
  setDeckProject,
  deleteDeck,
  putAsset,
  getAsset,
  listDecks,
  createProject,
  listProjects,
  getProject,
  renameProject,
  deleteProject,
  DECK_ACCESS_LEVELS,
  type DeckAccess,
} from './store.ts'
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
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }

/** Pulls a default title out of an uploaded 'html' deck's own `<title>` tag
 *  — a plain regex, not a parser: this is a display label, not something
 *  the file's behavior depends on, so a slightly-wrong extraction on
 *  malformed markup is a cosmetic miss, not a correctness bug. Falls back
 *  to 'Untitled deck' (same default store.ts's clampTitle uses) when there
 *  is no `<title>`. */
function extractHtmlTitle(rawHtml: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawHtml)
  if (!match) return 'Untitled deck'
  const decoded = match[1]!.replace(/&(#39|apos|amp|lt|gt|quot);/g, (_, name: string) => HTML_ENTITIES[name] ?? _)
  return decoded.trim() || 'Untitled deck'
}

/** An 'html' deck is served through a SANDBOXED IFRAME, never directly at
 *  this origin — deliberately, not an oversight. Bento's own doc content
 *  (text/table `html` fields) is sanitized at render time
 *  (slides/src/render.ts's sanitizeHtml); an uploaded 'html' deck is the
 *  opposite of that — arbitrary, unreviewed script the owner asked an AI to
 *  hand them and never necessarily read line-by-line. Serving it directly
 *  at ppt.rynnwang.com would let that script run with this origin's
 *  privileges: same-site cookies attach automatically to same-origin
 *  fetch(), so embedded script — even accidental, not malicious — could
 *  silently call the platform's own /api/decks/* endpoints using the
 *  OWNER's ambient session the moment they open their own deck's link
 *  while logged in elsewhere. `sandbox="allow-scripts …"` WITHOUT
 *  `allow-same-origin` gives the iframe's content a unique opaque origin —
 *  its script still runs (so the deck itself works), but it has no access
 *  to this origin's cookies, storage, or same-site fetch credentials at
 *  all, sandboxed or not. This only wraps the LIVE view; `/d/:id/download`
 *  still serves the raw bytes so the file is fully portable once saved.
 *  `srcdoc` needs the payload escaped as a double-quoted HTML attribute
 *  (not the same escaping as element content — `<`/`>` are fine here,
 *  `"` is not). */
function htmlDeckWrapper(rawHtml: string, title: string): string {
  const srcdocEscaped = rawHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const titleEscaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${titleEscaped}</title>
<style>html,body{margin:0;height:100%;background:#0D1B2E}iframe{border:0;width:100vw;height:100vh;display:block}</style>
</head><body><iframe sandbox="allow-scripts allow-popups allow-forms allow-modals" srcdoc="${srcdocEscaped}"></iframe></body></html>`
}

const MAX_HTML_DECK_BYTES = 8 * 1024 * 1024 // matches the image-asset cap (MEDIA_EMBED_BUDGET convention)

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

function isDeckAccess(v: unknown): v is DeckAccess {
  return typeof v === 'string' && (DECK_ACCESS_LEVELS as readonly string[]).includes(v)
}

async function handleListDecks(env: Env): Promise<Response> {
  const decks = await listDecks(env)
  return json({
    decks: decks.map((d) => ({
      id: d.id,
      title: d.title,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      access: d.access,
      kind: d.kind,
      pinned: !!d.pinned,
      projectId: d.project_id,
    })),
  })
}

async function handleCreate(req: Request, env: Env): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const { doc, html: rawHtml, access } = (body as { doc?: unknown; html?: unknown; access?: unknown }) ?? {}
  if (access !== undefined && !isDeckAccess(access)) {
    return json({ error: `access must be one of: ${DECK_ACCESS_LEVELS.join(', ')}` }, { status: 422 })
  }

  if (typeof rawHtml === 'string') {
    if (!rawHtml.trim()) return json({ error: 'html must not be empty' }, { status: 422 })
    if (rawHtml.length > MAX_HTML_DECK_BYTES) {
      return json({ error: `html is ${rawHtml.length} bytes, over the ${MAX_HTML_DECK_BYTES} limit` }, { status: 413 })
    }
    // 'edit' is meaningless for an 'html' deck (nothing to edit in place) —
    // coerced to 'view' rather than rejected, since it's not an invalid
    // choice, just not a real one for this kind. See store.ts's DeckAccess.
    const htmlAccess: DeckAccess = access === 'edit' || access === undefined ? 'view' : access
    const title = extractHtmlTitle(rawHtml)
    const { id } = await createHtmlDeck(env, rawHtml, title, htmlAccess)
    return json({ id, url: `/d/${id}` }, { status: 201 })
  }

  const result = validateIncomingDoc(doc)
  if (!result.ok) return json({ errors: result.errors }, { status: 422 })
  // Defaults to 'edit' unless the caller explicitly picks something else —
  // matches how every deck link has behaved since before this column existed.
  const { id } = await createDeck(env, result.doc!, access ?? 'edit')
  return json({ id, url: `/d/${id}` }, { status: 201 })
}

async function handleSetAccess(req: Request, env: Env, id: string): Promise<Response> {
  if (!(await getDeckMeta(env, id))) return notFound()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const access = (body as { access?: unknown })?.access
  if (!isDeckAccess(access)) {
    return json({ error: `access must be one of: ${DECK_ACCESS_LEVELS.join(', ')}` }, { status: 422 })
  }
  await setDeckAccess(env, id, access)
  return json({ ok: true, access })
}

async function handleRename(req: Request, env: Env, id: string): Promise<Response> {
  const meta = await getDeckMeta(env, id)
  if (!meta) return notFound()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const title = (body as { title?: unknown })?.title
  if (typeof title !== 'string' || !title.trim()) {
    return json({ error: 'title must be a non-empty string' }, { status: 422 })
  }
  if (meta.kind === 'html') {
    // No document to rewrite a title field inside of — just the D1 label.
    await renameHtmlDeck(env, id, title.trim())
    return json({ ok: true })
  }
  // The deck's displayed title IS doc.title — there's no separate cosmetic
  // label — so renaming rewrites the document, same as any other edit.
  // replaceDeckDoc's own titleOf() trims/truncates/defaults it consistently
  // with every other title write path (create, live edits).
  const doc = await getDeckDoc(env, id)
  if (!doc) return notFound()
  await replaceDeckDoc(env, id, { ...(doc as Record<string, unknown>), title: title.trim() })
  return json({ ok: true })
}

async function handleDelete(env: Env, id: string): Promise<Response> {
  if (!(await getDeckMeta(env, id))) return notFound()
  await deleteDeck(env, id)
  return json({ ok: true })
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
  const meta = await getDeckMeta(env, id)
  if (!meta) return notFound()
  if (meta.kind === 'html') {
    const htmlContent = await getDeckHtml(env, id)
    if (htmlContent === null) return notFound()
    return json({ kind: 'html', html: htmlContent })
  }
  const doc = await getDeckDoc(env, id)
  if (!doc) return notFound()
  return json({ kind: 'bento', doc })
}

async function handleReplace(req: Request, env: Env, id: string): Promise<Response> {
  const meta = await getDeckMeta(env, id)
  if (!meta) return notFound()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const { doc, html: rawHtml } = (body as { doc?: unknown; html?: unknown }) ?? {}

  if (meta.kind === 'html') {
    // The one edit path an 'html' deck DOES have: full re-upload, replacing
    // the stored bytes wholesale (there's no in-place field-level edit for
    // opaque content — see the file header). A { doc } body against an
    // 'html' deck is a kind mismatch, not a silent no-op.
    if (typeof rawHtml !== 'string') {
      return json({ error: "this deck is kind:'html' — PATCH it with { html }, not { doc }" }, { status: 400 })
    }
    if (!rawHtml.trim()) return json({ error: 'html must not be empty' }, { status: 422 })
    if (rawHtml.length > MAX_HTML_DECK_BYTES) {
      return json({ error: `html is ${rawHtml.length} bytes, over the ${MAX_HTML_DECK_BYTES} limit` }, { status: 413 })
    }
    await replaceHtmlDeck(env, id, rawHtml, extractHtmlTitle(rawHtml))
    return json({ ok: true })
  }

  if (typeof rawHtml === 'string') {
    return json({ error: "this deck is kind:'bento' — PATCH it with { doc }, not { html }" }, { status: 400 })
  }
  const result = validateIncomingDoc(doc)
  if (!result.ok) return json({ errors: result.errors }, { status: 422 })
  await replaceDeckDoc(env, id, result.doc!)
  return json({ ok: true })
}

async function handleSetPinned(req: Request, env: Env, id: string): Promise<Response> {
  if (!(await getDeckMeta(env, id))) return notFound()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const pinned = (body as { pinned?: unknown })?.pinned
  if (typeof pinned !== 'boolean') return json({ error: 'pinned must be a boolean' }, { status: 422 })
  await setDeckPinned(env, id, pinned)
  return json({ ok: true, pinned })
}

async function handleSetDeckProject(req: Request, env: Env, id: string): Promise<Response> {
  if (!(await getDeckMeta(env, id))) return notFound()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const projectId = (body as { projectId?: unknown })?.projectId
  if (projectId !== null && typeof projectId !== 'string') {
    return json({ error: 'projectId must be a string or null' }, { status: 422 })
  }
  await setDeckProject(env, id, projectId)
  return json({ ok: true, projectId })
}

async function handleListProjects(env: Env): Promise<Response> {
  const projects = await listProjects(env)
  return json({
    projects: projects.map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at, updatedAt: p.updated_at })),
  })
}

async function handleCreateProject(req: Request, env: Env): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const name = (body as { name?: unknown })?.name
  if (typeof name !== 'string' || !name.trim()) {
    return json({ error: 'name must be a non-empty string' }, { status: 422 })
  }
  const { id } = await createProject(env, name)
  return json({ id }, { status: 201 })
}

async function handleRenameProject(req: Request, env: Env, id: string): Promise<Response> {
  if (!(await getProject(env, id))) return notFound()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const name = (body as { name?: unknown })?.name
  if (typeof name !== 'string' || !name.trim()) {
    return json({ error: 'name must be a non-empty string' }, { status: 422 })
  }
  await renameProject(env, id, name)
  return json({ ok: true })
}

async function handleDeleteProject(env: Env, id: string): Promise<Response> {
  if (!(await getProject(env, id))) return notFound()
  await deleteProject(env, id)
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

async function handleView(req: Request, env: Env, id: string, download: boolean): Promise<Response> {
  const [meta, owner] = await Promise.all([getDeckMeta(env, id), isAuthenticated(req, env)])
  if (!meta) return notFound()
  // A private deck is 404 for anyone but the owner — indistinguishable from
  // no deck at all, so its existence isn't observable either. The owner's
  // own session always gets the full content regardless of `access`.
  if (!owner && meta.access === 'private') return notFound()

  if (meta.kind === 'html') {
    const rawHtml = await getDeckHtml(env, id)
    if (rawHtml === null) return notFound()
    const filename = meta.title.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'deck'
    if (download) {
      // The portable, standalone file — no wrapper. Sandboxing only matters
      // for the LIVE view served at this origin (see htmlDeckWrapper); once
      // downloaded, it's just a local file the browser opens on its own.
      return new Response(rawHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename="${filename}.html"` },
      })
    }
    // Always the sandboxed wrapper, even for the owner — see htmlDeckWrapper's
    // header comment for why this protects the owner's OWN session most of all.
    return html(htmlDeckWrapper(rawHtml, meta.title))
  }

  const doc = await getDeckDoc(env, id)
  if (!doc) return notFound()
  // 'view' gets `readonly: true` spliced in instead of the plain doc — Bento's
  // own PLAYER file mode (boots straight into the show, no editor chrome, see
  // CLAUDE.md) rather than a bespoke read-only renderer. Only the served copy
  // is touched; the stored doc (and the owner's own view of it) never is.
  const served =
    owner || meta.access === 'edit' ? doc : { ...(doc as Record<string, unknown>), readonly: true }
  const spliced = spliceDoc(served)
  const headers: HeadersInit = {}
  if (download) {
    const title = typeof (doc as { title?: unknown }).title === 'string' ? (doc as { title: string }).title : 'deck'
    const filename = title.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'deck'
    headers['content-disposition'] = `attachment; filename="${filename}.bento.html"`
  }
  return html(spliced, { headers })
}

async function handleAsset(req: Request, env: Env, id: string, key: string): Promise<Response> {
  const [meta, owner] = await Promise.all([getDeckMeta(env, id), isAuthenticated(req, env)])
  if (!meta) return notFound()
  // Same 404-not-403 rule as handleView: a private deck's assets are just as
  // unreachable, and just as invisible, to anyone without the owner's session.
  if (!owner && meta.access === 'private') return notFound()
  const obj = await getAsset(env, id, key)
  if (!obj) return notFound()
  // Content-addressed keys make `public, immutable` caching safe for
  // 'view'/'edit' decks. A 'private' deck must never be handed a
  // shared-cacheable response, even to its owner — a CDN edge caching it
  // once would let a later anonymous request for the same URL skip the
  // access check above entirely by being served straight from cache.
  const cacheControl =
    meta.access === 'private' ? 'private, no-store' : 'public, max-age=31536000, immutable'
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': cacheControl,
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
        if (parts.length === 3 && req.method === 'DELETE') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleDelete(env, parts[2]!)
        }
        if (parts.length === 4 && parts[3] === 'assets' && req.method === 'POST') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleUploadAsset(req, env, parts[2]!)
        }
        if (parts.length === 4 && parts[3] === 'access' && req.method === 'PATCH') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleSetAccess(req, env, parts[2]!)
        }
        if (parts.length === 4 && parts[3] === 'title' && req.method === 'PATCH') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleRename(req, env, parts[2]!)
        }
        if (parts.length === 4 && parts[3] === 'pin' && req.method === 'PATCH') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleSetPinned(req, env, parts[2]!)
        }
        if (parts.length === 4 && parts[3] === 'project' && req.method === 'PATCH') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleSetDeckProject(req, env, parts[2]!)
        }
      }

      if (parts[0] === 'api' && parts[1] === 'projects') {
        if (parts.length === 2 && req.method === 'GET') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleListProjects(env)
        }
        if (parts.length === 2 && req.method === 'POST') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleCreateProject(req, env)
        }
        if (parts.length === 3 && req.method === 'PATCH') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleRenameProject(req, env, parts[2]!)
        }
        if (parts.length === 3 && req.method === 'DELETE') {
          const denied = await requireOwnerApi(req, env)
          if (denied) return denied
          return await handleDeleteProject(env, parts[2]!)
        }
      }

      if (parts[0] === 'd' && parts.length === 2 && req.method === 'GET') {
        return await handleView(req, env, parts[1]!, false)
      }
      if (parts[0] === 'd' && parts.length === 3 && parts[2] === 'download' && req.method === 'GET') {
        return await handleView(req, env, parts[1]!, true)
      }

      if (parts[0] === 'a' && parts.length === 3 && req.method === 'GET') {
        return await handleAsset(req, env, parts[1]!, parts[2]!)
      }

      if (parts[0] === 'healthz') return json({ ok: true, shellVersion: SHELL_VERSION })

      return notFound()
    } catch (e) {
      console.error(e)
      return json({ error: 'internal error' }, { status: 500 })
    }
  },
}
