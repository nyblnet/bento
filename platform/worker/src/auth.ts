// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Single-owner authentication (migrations/0002_auth.sql), plus the PBKDF2
// primitives store.ts/index.ts reuse for a SECOND, unrelated secret — a
// deck's own per-deck share password (migrations/0008_share_password.sql).
// Three concerns:
//
//   - Password hashing (config table, set once via POST /api/setup).
//     PBKDF2-SHA-256, same family kernel/src/save.ts uses for bento/enc
//     password-protected decks — but NOT the same iteration count: that
//     code runs in a browser, which has no cap on PBKDF2 iterations, and
//     used 300_000. The Workers runtime (workerd) hard-rejects PBKDF2 above
//     100_000 iterations (`NotSupportedError: Pbkdf2 failed: iteration
//     counts above 100000 are not supported`) — this shipped once with
//     300_000 and every POST /api/setup 500'd in production until this was
//     caught via `wrangler tail`, see docs/DECISIONS.md. 100_000 is the
//     platform's hard ceiling, not a tuning choice — it can't be raised.
//     The salt is always crypto.getRandomValues()'d here, server-side;
//     there is no code path that accepts a caller-supplied salt
//     (docs/DECISIONS.md would need updating if that ever changes — it's a
//     deliberate constraint, not an oversight).
//   - Sessions (sessions table). Stateful, not a signed cookie: for a
//     single-owner, low-traffic project a session is one small D1 row,
//     logout is just deleting it, and there's no signing-key story to get
//     wrong. The cookie value IS the row's `id` — an opaque random token,
//     looked up (and its expiry slid forward) on every owner-gated request.
//   - Deck share passwords (`hashSharePassword`/`verifySharePassword` below)
//     — an OPTIONAL extra gate an owner can put in front of a 'view'/'edit'
//     deck: even with the link, an anonymous viewer must submit this
//     password before index.ts's handleView/handleAsset serve anything.
//     Same PBKDF2-SHA-256 machinery as the owner's own account password
//     (there's exactly one derivePasswordHash implementation in this file;
//     both callers share it), stored per-deck in `decks.share_password_*`
//     rather than in `config`. Unlike sessions, unlocking a deck does NOT
//     mint a D1 row — see index.ts's deckUnlockToken for why a stateless,
//     deterministic cookie value works here and sessions still don't use
//     that trick (a session needs to be revocable independent of any
//     password change; a deck unlock is fine being tied to — and
//     automatically invalidated by — the deck's current password hash).
import type { Env } from './env.ts'
import { randomToken } from './ids.ts'

// Cloudflare Workers' PBKDF2 implementation rejects anything above this —
// see the file header. Do not raise it. Exported so auth.spec.ts can assert
// on it directly: Node's WebCrypto (what the test suite runs under) does
// NOT enforce this Workers-specific limit, so a regression here is
// invisible to `npm test` otherwise — it only fails in production.
export const PASSWORD_ITERATIONS = 100_000
const SALT_BYTES = 16
const HASH_BITS = 256
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days, sliding
export const SESSION_COOKIE_NAME = 'bento_session'

function toB64(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
  let binary = ''
  for (const b of arr) binary += String.fromCharCode(b)
  return btoa(binary)
}

function fromB64(s: string): Uint8Array {
  const binary = atob(s)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    HASH_BITS,
  )
  return new Uint8Array(bits)
}

// --- config (single row, owner identity) ------------------------------------

export interface Config {
  username: string
  passwordHash: string
  passwordSalt: string
  passwordIterations: number
  createdAt: number
}

interface ConfigRow {
  username: string
  password_hash: string
  password_salt: string
  password_iterations: number
  created_at: number
}

export async function getConfig(env: Env): Promise<Config | null> {
  const row = await env.DB.prepare(
    `SELECT username, password_hash, password_salt, password_iterations, created_at FROM config WHERE id = 1`,
  ).first<ConfigRow>()
  if (!row) return null
  return {
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    passwordIterations: row.password_iterations,
    createdAt: row.created_at,
  }
}

/** Throws if config already exists — setup is one-time, never overwrites an
 *  existing owner. Salt is minted here, always — never accepted from a caller. */
export async function createConfig(env: Env, username: string, password: string): Promise<void> {
  if (await getConfig(env)) throw new Error('config already exists')
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS)
  await env.DB.prepare(
    `INSERT INTO config (id, username, password_hash, password_salt, password_iterations, created_at)
     VALUES (1, ?, ?, ?, ?, ?)`,
  )
    .bind(username, toB64(hash), toB64(salt), PASSWORD_ITERATIONS, Date.now())
    .run()
}

export async function verifyPassword(env: Env, username: string, password: string): Promise<boolean> {
  const config = await getConfig(env)
  if (!config) return false
  const candidate = await derivePasswordHash(password, fromB64(config.passwordSalt), config.passwordIterations)
  const passwordOk = timingSafeEqual(candidate, fromB64(config.passwordHash))
  // Username isn't secret in a single-owner system (there is exactly one
  // valid value, set by the owner themselves at setup) — a plain compare is
  // fine; the password comparison above is the one that needs to be
  // constant-time, and runs unconditionally regardless of username match so
  // a wrong username never short-circuits before the timing-sensitive part.
  return config.username === username && passwordOk
}

// --- sessions -----------------------------------------------------------

export async function createSession(env: Env): Promise<string> {
  const id = randomToken()
  const now = Date.now()
  await env.DB.prepare(`INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)`)
    .bind(id, now, now + SESSION_TTL_MS)
    .run()
  return id
}

/** Validates the session and, if valid, slides its expiry forward. */
export async function touchSession(env: Env, sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const now = Date.now()
  const row = await env.DB.prepare(`SELECT expires_at FROM sessions WHERE id = ?`).bind(sessionId).first<{
    expires_at: number
  }>()
  if (!row || row.expires_at < now) return false
  await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).bind(now + SESSION_TTL_MS, sessionId).run()
  return true
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run()
}

// --- cookies -----------------------------------------------------------

/** Generic single-cookie reader — session and per-deck unlock cookies both
 *  go through this rather than each parsing the `cookie` header themselves. */
export function readCookie(req: Request, name: string): string {
  const header = req.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    if (key === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return ''
}

export function readSessionCookie(req: Request): string {
  return readCookie(req, SESSION_COOKIE_NAME)
}

export function setSessionCookieHeader(sessionId: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000)
  return `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

/** True if the request carries a valid, non-expired owner session. */
export async function isAuthenticated(req: Request, env: Env): Promise<boolean> {
  return touchSession(env, readSessionCookie(req))
}

// --- deck share passwords -------------------------------------------------
//
// See the file header. This is the SAME derivePasswordHash/PBKDF2 machinery
// as the owner's own account password, applied to a different secret.

export interface SharePasswordRecord {
  hash: string
  salt: string
  iterations: number
}

/** Hash a NEW share password for a deck. Salt is always minted here, never
 *  caller-supplied — same rule as createConfig. */
export async function hashSharePassword(password: string): Promise<SharePasswordRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS)
  return { hash: toB64(hash), salt: toB64(salt), iterations: PASSWORD_ITERATIONS }
}

export async function verifySharePassword(password: string, record: SharePasswordRecord): Promise<boolean> {
  const candidate = await derivePasswordHash(password, fromB64(record.salt), record.iterations)
  return timingSafeEqual(candidate, fromB64(record.hash))
}
