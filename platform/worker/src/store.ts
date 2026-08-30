// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// R2 + D1 access. R2 holds bytes (doc JSON, uploaded asset blobs); D1 holds
// only metadata — never doc content — so a row scan never has to move
// megabytes. Key layout:
//
//   docs/<deckId>/doc.json          current doc (v1 keeps one revision only;
//                                    a version history is deliberately
//                                    deferred, see platform/README.md)
//   assets/<deckId>/<sha256>.<ext>  uploaded images, content-addressed
//                                    within the deck's own namespace
//
// D1 table `decks` — see platform/worker/migrations/0001_init.sql for DDL
// comments. Mutation used to be gated by a per-deck capability token
// (edit_token_hash); that's superseded by the single-owner session auth in
// auth.ts (migrations/0002_auth.sql) — every mutating route now checks the
// caller's session instead, so nothing here mints or checks a token anymore.
// The column stays in the table (existing rows still have a NOT NULL value
// to satisfy), just unused. Same fate now for `is_editable`
// (migrations/0003_editable.sql, a same-day boolean superseded by the
// three-state `access` column below before it ever reached most users) —
// gates what an ANONYMOUS viewer of /d/:id and /a/:id/:key get, see
// index.ts's handleView/handleAsset.
import type { Env } from './env.ts'
import { randomId, sha256Hex } from './ids.ts'
import { SHELL_VERSION } from './splice.ts'
import { hashSharePassword, type SharePasswordRecord } from './auth.ts'

/** Who can reach a deck without the owner's own session.
 *  - 'private' — nobody; handleView/handleAsset 404 exactly like an unknown
 *    id, so a private deck's existence isn't distinguishable from no deck
 *    at all.
 *  - 'view'    — anyone with the link, but read-only (Bento's PLAYER mode
 *    for 'bento' decks; the only state 'html' decks ever have — see
 *    DeckKind).
 *  - 'edit'    — anyone with the link, full live editor — the default,
 *    matching how every deck link behaved before this column existed.
 *    Meaningless for 'html' decks (nothing to edit in place); handleCreate
 *    coerces it to 'view' rather than rejecting it, since "editable" isn't
 *    a real choice for that kind, not an invalid one. */
export type DeckAccess = 'private' | 'view' | 'edit'
export const DECK_ACCESS_LEVELS: readonly DeckAccess[] = ['private', 'view', 'edit']

/** What a deck's stored bytes actually are.
 *  - 'bento' — a `bento/slides` JSON document (compiled from an outline, or
 *    pasted directly). Splices into the live editor shell; access controls
 *    editable-vs-readonly.
 *  - 'html'  — an opaque, self-contained HTML file (typically a chat AI
 *    asked directly for "a runnable HTML slide deck", not through Bento at
 *    all). Stored and served byte-for-byte, never parsed or edited — see
 *    index.ts's handleView for why it's served through a sandboxed iframe
 *    wrapper rather than directly at the platform's own origin. */
export type DeckKind = 'bento' | 'html'

export interface DeckMeta {
  id: string
  title: string
  created_at: number
  updated_at: number
  shell_version: string
  doc_bytes: number
  access: DeckAccess
  kind: DeckKind
  pinned: number // D1 has no boolean type; 0/1
  project_id: string | null
  // All three NULL together = no share password set (the common case); all
  // three populated together = one is. See migrations/0008_share_password.sql
  // and auth.ts's hashSharePassword/verifySharePassword.
  share_password_hash: string | null
  share_password_salt: string | null
  share_password_iterations: number | null
}

export interface CreateResult {
  id: string
}

/** A project is just an id + name — a sidebar folder to group decks under,
 *  nothing else. It has no access level, no kind, no content of its own;
 *  it isn't a permission boundary, only an organizational one. Deleting a
 *  project does NOT delete the decks inside it — see deleteProject. */
export interface Project {
  id: string
  name: string
  created_at: number
  updated_at: number
}

function deckDocKey(id: string): string {
  return `docs/${id}/doc.json`
}

function deckHtmlKey(id: string): string {
  return `docs/${id}/doc.html`
}

function titleOf(doc: Record<string, unknown>): string {
  return typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim().slice(0, 200) : 'Untitled deck'
}

function clampTitle(title: string): string {
  const trimmed = title.trim()
  return trimmed ? trimmed.slice(0, 200) : 'Untitled deck'
}

/** Create a new 'bento' deck, writes R2 + D1. `doc` must already be
 *  validated (validate.ts) — this function trusts its shape. `access`
 *  defaults to 'edit', matching how every deck link has behaved since
 *  before this column existed: reachable and editable by anyone holding
 *  the id. */
export async function createDeck(
  env: Env,
  doc: Record<string, unknown>,
  access: DeckAccess = 'edit',
): Promise<CreateResult> {
  const id = randomId()
  const now = Date.now()

  // docId is minted once and never regenerated (docs/PLATFORM.md §3) — the
  // deck's own short id doubles as its docId rather than maintaining two
  // identifiers for the same thing.
  const stored = { ...doc, docId: id }
  const json = JSON.stringify(stored)

  await env.DOCS.put(deckDocKey(id), json, { httpMetadata: { contentType: 'application/json' } })
  await env.DB.prepare(
    `INSERT INTO decks (id, title, created_at, updated_at, edit_token_hash, shell_version, doc_bytes, access, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bento')`,
  )
    .bind(id, titleOf(stored), now, now, '', SHELL_VERSION, json.length, access)
    .run()

  return { id }
}

/** Create a new 'html' deck: a raw, self-contained HTML file stored
 *  byte-for-byte. `title` is typically extracted from the file's own
 *  `<title>` tag by the caller (index.ts) before this is called. `access`
 *  should already be 'private' or 'view' — 'edit' is meaningless for this
 *  kind (see DeckAccess) and the caller is expected to have coerced it. */
export async function createHtmlDeck(
  env: Env,
  html: string,
  title: string,
  access: DeckAccess = 'view',
): Promise<CreateResult> {
  const id = randomId()
  const now = Date.now()

  await env.DOCS.put(deckHtmlKey(id), html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } })
  await env.DB.prepare(
    `INSERT INTO decks (id, title, created_at, updated_at, edit_token_hash, shell_version, doc_bytes, access, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'html')`,
  )
    .bind(id, clampTitle(title), now, now, '', SHELL_VERSION, html.length, access)
    .run()

  return { id }
}

export async function getDeckDoc(env: Env, id: string): Promise<unknown | null> {
  const obj = await env.DOCS.get(deckDocKey(id))
  if (!obj) return null
  return JSON.parse(await obj.text())
}

/** Raw bytes of an 'html' deck — never parsed, served as-is. */
export async function getDeckHtml(env: Env, id: string): Promise<string | null> {
  const obj = await env.DOCS.get(deckHtmlKey(id))
  if (!obj) return null
  return obj.text()
}

const DECK_META_COLUMNS =
  'id, title, created_at, updated_at, shell_version, doc_bytes, access, kind, pinned, project_id, ' +
  'share_password_hash, share_password_salt, share_password_iterations'

export async function getDeckMeta(env: Env, id: string): Promise<DeckMeta | null> {
  const row = await env.DB.prepare(`SELECT ${DECK_META_COLUMNS} FROM decks WHERE id = ?`).bind(id).first<DeckMeta>()
  return row ?? null
}

const LIST_LIMIT = 200

/** All decks, pinned first (most-recently-touched among themselves), then
 *  everything else most-recently-touched — the sidebar's deck history list.
 *  Bounded at LIST_LIMIT; pagination is a later concern, not needed at this
 *  project's declared scale. */
export async function listDecks(env: Env): Promise<DeckMeta[]> {
  const result = await env.DB.prepare(
    `SELECT ${DECK_META_COLUMNS} FROM decks ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
  )
    .bind(LIST_LIMIT)
    .all<DeckMeta>()
  return result.results
}

/** Move a deck into a project, or clear its project (projectId = null) —
 *  the deck context menu's "Project ▸" submenu. No ownership check on the
 *  project id itself: an id that doesn't exist in `projects` just means the
 *  deck renders unfiled until a real one is set (same graceful-degrade as
 *  any other dangling foreign key in this schema — see deleteProject). */
export async function setDeckProject(env: Env, id: string, projectId: string | null): Promise<void> {
  await env.DB.prepare(`UPDATE decks SET project_id = ? WHERE id = ?`).bind(projectId, id).run()
}

/** Create a project — just a name; the sidebar's "+ New project…" action. */
export async function createProject(env: Env, name: string): Promise<{ id: string }> {
  const id = randomId()
  const now = Date.now()
  await env.DB.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .bind(id, clampTitle(name), now, now)
    .run()
  return { id }
}

/** All projects, alphabetical — there's no recency/pin concept for folders
 *  themselves, only for the decks inside them. */
export async function listProjects(env: Env): Promise<Project[]> {
  const result = await env.DB.prepare(`SELECT id, name, created_at, updated_at FROM projects ORDER BY name COLLATE NOCASE ASC`).all<Project>()
  return result.results
}

export async function getProject(env: Env, id: string): Promise<Project | null> {
  const row = await env.DB.prepare(`SELECT id, name, created_at, updated_at FROM projects WHERE id = ?`).bind(id).first<Project>()
  return row ?? null
}

export async function renameProject(env: Env, id: string, name: string): Promise<void> {
  await env.DB.prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`)
    .bind(clampTitle(name), Date.now(), id)
    .run()
}

/** Delete a project. Its decks are NOT deleted — they're unassigned first
 *  (project_id → NULL) so they fall back to the plain History section,
 *  exactly as if they'd never been filed. There is deliberately no
 *  ON DELETE CASCADE on decks.project_id: a folder is an organizational
 *  convenience, never a reason to destroy content. */
export async function deleteProject(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE decks SET project_id = NULL WHERE project_id = ?`).bind(id).run()
  await env.DB.prepare(`DELETE FROM projects WHERE id = ?`).bind(id).run()
}

/** Change a deck's access level — the owner-only setting behind the
 *  sidebar's context menu. Anonymous viewers get whatever `access` says
 *  (handleView/handleAsset in index.ts); the owner's own session always
 *  keeps full edit access regardless of it. */
export async function setDeckAccess(env: Env, id: string, access: DeckAccess): Promise<void> {
  await env.DB.prepare(`UPDATE decks SET access = ? WHERE id = ?`).bind(access, id).run()
}

/** Pin or unpin a deck — keeps it at the top of the sidebar's history list
 *  regardless of how recently it was touched (see listDecks' ORDER BY).
 *  Deliberately does NOT bump `updated_at` — pinning isn't "touching" the
 *  deck's content, and bumping it would fight the very ordering pinning is
 *  supposed to override. */
export async function setDeckPinned(env: Env, id: string, pinned: boolean): Promise<void> {
  await env.DB.prepare(`UPDATE decks SET pinned = ? WHERE id = ?`).bind(pinned ? 1 : 0, id).run()
}

/** Set or clear a deck's share password (see DeckMeta's fields and
 *  migrations/0008_share_password.sql). `password: null` clears all three
 *  columns back to NULL — index.ts/demo.ts's "Remove password" action.
 *  Meaningful only for 'view'/'edit' decks (a 'private' deck already blocks
 *  every non-owner outright), but not rejected for 'private' either — same
 *  "not applicable, not invalid" treatment 'edit' access gets on an 'html'
 *  deck elsewhere in this file. A fresh salt is minted on every call
 *  (hashSharePassword), so re-setting the same password still invalidates
 *  every previously issued unlock cookie (see index.ts's deckUnlockToken —
 *  it's derived from the current hash, so any hash change is itself a
 *  revocation, deliberately, no separate "sign everyone out" action needed). */
export async function setDeckSharePassword(env: Env, id: string, password: string | null): Promise<void> {
  if (password === null) {
    await env.DB.prepare(
      `UPDATE decks SET share_password_hash = NULL, share_password_salt = NULL, share_password_iterations = NULL WHERE id = ?`,
    )
      .bind(id)
      .run()
    return
  }
  const record: SharePasswordRecord = await hashSharePassword(password)
  await env.DB.prepare(
    `UPDATE decks SET share_password_hash = ?, share_password_salt = ?, share_password_iterations = ? WHERE id = ?`,
  )
    .bind(record.hash, record.salt, record.iterations, id)
    .run()
}

/** Overwrite a 'bento' deck's doc in place. Caller must have already
 *  verified the owner session and that `doc` passed validate.ts. */
export async function replaceDeckDoc(env: Env, id: string, doc: Record<string, unknown>): Promise<void> {
  const stored = { ...doc, docId: id }
  const json = JSON.stringify(stored)
  await env.DOCS.put(deckDocKey(id), json, { httpMetadata: { contentType: 'application/json' } })
  await env.DB.prepare(`UPDATE decks SET title = ?, updated_at = ?, doc_bytes = ? WHERE id = ?`)
    .bind(titleOf(stored), Date.now(), json.length, id)
    .run()
}

/** Rename an 'html' deck. Unlike a 'bento' deck, there's no document to
 *  rewrite a title field inside of — the stored bytes are untouched, just
 *  the D1 label. */
export async function renameHtmlDeck(env: Env, id: string, title: string): Promise<void> {
  await env.DB.prepare(`UPDATE decks SET title = ?, updated_at = ? WHERE id = ?`)
    .bind(clampTitle(title), Date.now(), id)
    .run()
}

/** Overwrite an 'html' deck's stored bytes in place — the re-upload path a
 *  'bento' deck gets for free by being editable, that an opaque HTML file
 *  otherwise wouldn't have at all. Re-derives the title from the NEW file's
 *  own `<title>` tag (same rule as createHtmlDeck) rather than preserving
 *  whatever the deck was called before: the content is now a different
 *  file, so its default label should reflect that — an owner who wants a
 *  custom title back can rename again afterward, same as after any create. */
export async function replaceHtmlDeck(env: Env, id: string, html: string, title: string): Promise<void> {
  await env.DOCS.put(deckHtmlKey(id), html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } })
  await env.DB.prepare(`UPDATE decks SET title = ?, updated_at = ?, doc_bytes = ? WHERE id = ?`)
    .bind(clampTitle(title), Date.now(), html.length, id)
    .run()
}

/** Permanently delete a deck: its D1 row, its stored bytes (doc.json OR
 *  doc.html — deleting both unconditionally is simpler and no less correct
 *  than branching on kind, since only one of them was ever written), and
 *  every asset blob under its namespace. R2 has no delete-by-prefix — list
 *  then batch delete (list() pages at up to 1000 keys, same as delete()'s
 *  own batch cap, so one delete call per list page is enough). Order
 *  matters only in that the D1 row goes last: if a crash lands between the
 *  R2 deletes and the D1 delete, the deck is an orphaned-but-still-listed
 *  row (annoying, recoverable by retrying delete) rather than a
 *  listed-nowhere row whose blobs leak forever. */
export async function deleteDeck(env: Env, id: string): Promise<void> {
  let cursor: string | undefined
  do {
    const listed = await env.DOCS.list({ prefix: `assets/${id}/`, cursor })
    if (listed.objects.length) {
      await env.DOCS.delete(listed.objects.map((o) => o.key))
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  await env.DOCS.delete(deckDocKey(id))
  await env.DOCS.delete(deckHtmlKey(id))
  await env.DB.prepare(`DELETE FROM decks WHERE id = ?`).bind(id).run()
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}

export interface PutAssetResult {
  key: string
  path: string
}

/** Store an uploaded image blob under the deck's own asset namespace,
 *  content-addressed so re-uploading the same bytes is a no-op write. */
export async function putAsset(
  env: Env,
  deckId: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<PutAssetResult> {
  const ext = EXT_BY_MIME[contentType] ?? 'bin'
  const hash = await sha256Hex(bytes)
  const key = `${hash}.${ext}`
  const r2Key = `assets/${deckId}/${key}`
  await env.DOCS.put(r2Key, bytes, { httpMetadata: { contentType } })
  return { key, path: `/a/${deckId}/${key}` }
}

export async function getAsset(env: Env, deckId: string, key: string): Promise<R2ObjectBody | null> {
  // Path segments only — no `..`, no slashes smuggled through the URL param.
  if (!/^[a-f0-9]+\.[a-z0-9]+$/i.test(key)) return null
  return env.DOCS.get(`assets/${deckId}/${key}`)
}
