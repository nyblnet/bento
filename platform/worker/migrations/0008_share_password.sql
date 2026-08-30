-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 The Bento authors
--
-- Migration 0008 — an OPTIONAL per-deck share password: an extra gate an
-- owner can put in front of a 'view'/'edit' deck (migrations/0004_access.sql)
-- so that even someone who has the link needs a password to actually open
-- it. All three columns are NULL together when no password is set (the
-- common case — every existing deck gets this for free via plain ALTER
-- TABLE ADD COLUMN, no backfill needed) and populated together when one is.
-- Same PBKDF2-SHA-256 shape as the owner's own account password (see
-- auth.ts's file header) — hash/salt are base64, iterations is always
-- PASSWORD_ITERATIONS (100,000) today but stored explicitly rather than
-- assumed, so a future iteration-count change doesn't silently break
-- passwords hashed under the old count.
--
-- Apply by hand in the CF dashboard: D1 → your database → Console tab, paste
-- this whole file, run — AFTER 0001-0007, once.

ALTER TABLE decks ADD COLUMN share_password_hash TEXT;
ALTER TABLE decks ADD COLUMN share_password_salt TEXT;
ALTER TABLE decks ADD COLUMN share_password_iterations INTEGER;
