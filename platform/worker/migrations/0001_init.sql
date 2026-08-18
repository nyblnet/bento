-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 The Bento authors
--
-- D1 schema for the hosting platform's deck metadata. Doc content itself
-- lives in R2 (platform/worker/src/store.ts) — this table is small rows only,
-- so a listing/lookup query never has to move megabytes.
--
-- Apply by hand in the CF dashboard: D1 → your database → Console tab, paste
-- this whole file, run. No wrangler required (see platform/README.md).

CREATE TABLE IF NOT EXISTS decks (
  id               TEXT PRIMARY KEY,   -- also the deck's docId (store.ts createDeck)
  title            TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,   -- ms epoch
  updated_at       INTEGER NOT NULL,   -- ms epoch
  edit_token_hash  TEXT NOT NULL,      -- sha256 hex of the capability token; raw token is never stored
  shell_version    TEXT NOT NULL,      -- slides/package.json version the deck was created against
  doc_bytes        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_decks_created_at ON decks (created_at);
