-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 The Bento authors
--
-- Migration 0003 — per-deck editable toggle. Every deck has been reachable
-- by anyone holding its unguessable /d/:id link since before auth existed
-- (see index.ts's routing-table comment); this adds a way to turn that into
-- a read-only "presentation" link on a per-deck, owner-flippable basis. The
-- owner (a valid session) always keeps full edit access regardless of this
-- flag — only anonymous viewers are affected. Defaults to 1 (editable) so
-- every already-created deck's link keeps behaving exactly as it does today.
--
-- Apply by hand in the CF dashboard: D1 → your database → Console tab, paste
-- this whole file, run — AFTER 0001_init.sql and 0002_auth.sql, once.

ALTER TABLE decks ADD COLUMN is_editable INTEGER NOT NULL DEFAULT 1;
