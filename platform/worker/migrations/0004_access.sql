-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 The Bento authors
--
-- Migration 0004 — replaces the boolean `is_editable` (migrations/
-- 0003_editable.sql, shipped hours earlier) with a three-state `access`
-- column: 'private' | 'view' | 'edit'. The boolean only covered two of the
-- three states a deck owner actually wants ("can anyone with the link edit
-- it") and had no way to express "don't let ANYONE without my session open
-- it at all" — that third state needs its own column, not a bigger enum
-- bolted onto is_editable, because index.ts's handleView/handleAsset now
-- branch on it before even fetching the doc.
--
-- `is_editable` is left in place, unused, same as `edit_token_hash` before
-- it (migrations/0002_auth.sql) — existing rows keep a valid value, nothing
-- reads the column going forward.
--
-- Apply by hand in the CF dashboard: D1 → your database → Console tab, paste
-- this whole file, run — AFTER 0001/0002/0003, once.

ALTER TABLE decks ADD COLUMN access TEXT NOT NULL DEFAULT 'edit';

-- Carry every existing deck's old boolean forward losslessly: editable (1)
-- becomes 'edit', non-editable (0) becomes 'view' — no deck silently becomes
-- private just because this migration ran.
UPDATE decks SET access = CASE WHEN is_editable = 1 THEN 'edit' ELSE 'view' END;
