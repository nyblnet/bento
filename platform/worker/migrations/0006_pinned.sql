-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 The Bento authors
--
-- Migration 0006 — decks.pinned, a per-deck boolean the owner sets from the
-- sidebar's context menu to keep a deck at the top of the history list
-- regardless of how recently it was touched. listDecks (store.ts) orders
-- `ORDER BY pinned DESC, updated_at DESC` — pinned decks first (most
-- recently pinned/touched among themselves), then everything else by the
-- existing most-recently-touched rule.
--
-- Apply by hand in the CF dashboard: D1 → your database → Console tab, paste
-- this whole file, run — AFTER 0001-0005, once.

ALTER TABLE decks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
