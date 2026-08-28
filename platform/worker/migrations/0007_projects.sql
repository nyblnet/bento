-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 The Bento authors
--
-- Migration 0007 — a lightweight grouping concept: `projects`, and
-- `decks.project_id` pointing into it. A project is just an id + name; it
-- has no access level, no kind, nothing else — it's purely an
-- organizational folder for the sidebar, not a document or a permission
-- boundary. Deleting a project does NOT delete its decks: they just lose
-- their `project_id` (see store.ts's deleteProject, which unassigns before
-- dropping the row — there is no ON DELETE CASCADE here on purpose).
--
-- Apply by hand in the CF dashboard: D1 → your database → Console tab, paste
-- this whole file, run — AFTER 0001-0006, once.

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE decks ADD COLUMN project_id TEXT;
