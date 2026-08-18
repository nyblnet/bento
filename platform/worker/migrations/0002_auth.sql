-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 The Bento authors
--
-- Migration 0002 — single-owner authentication. Two new tables; migration
-- 0001's `decks` table is untouched (its `edit_token_hash` column becomes
-- unused as of this migration, see the comment there — dropping a column
-- some already-written rows depend on isn't worth the risk for a column
-- that's simply ignored going forward).
--
-- Apply by hand in the CF dashboard: D1 → your database → Console tab, paste
-- this whole file, run — AFTER 0001_init.sql, once. No wrangler required.

-- Single row (id is CHECK-constrained to 1), created by POST /api/setup the
-- first time the Worker runs with no config yet. Never inserted twice —
-- setup refuses once a row exists (platform/worker/src/auth.ts).
CREATE TABLE IF NOT EXISTS config (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  username              TEXT NOT NULL,
  password_hash         TEXT NOT NULL,  -- base64, PBKDF2-SHA-256 derived bits
  password_salt         TEXT NOT NULL,  -- base64, crypto.getRandomValues — generated server-side, never chosen by the caller
  password_iterations   INTEGER NOT NULL,
  created_at            INTEGER NOT NULL
);

-- Stateful sessions (not signed cookies) — deliberate for a single-owner,
-- low-traffic project: a session is exactly one small row, revocation is
-- just deleting it (logout), and there's no signing-key management story to
-- get wrong. The cookie value IS `id` — an opaque random token, unguessable,
-- looked up on every owner-gated request.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,  -- ms epoch
  expires_at   INTEGER NOT NULL   -- ms epoch; sliding window, refreshed on use
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
