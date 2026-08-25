-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 The Bento authors
--
-- Migration 0005 — a second deck kind: 'html'. Every deck so far has been a
-- 'bento/slides' JSON document (compiled from an outline, or pasted
-- directly) that the platform can splice into the live editor shell. This
-- adds a second, deliberately opaque kind: a self-contained HTML file a
-- chat AI generated directly (Gemini/Claude/etc. asked to "just give me a
-- runnable HTML slide deck"), stored and served as-is — no compiling, no
-- editing, no splice contract. store.ts/index.ts branch on this column;
-- see docs/DECISIONS.md for why it's served through a sandboxed iframe
-- wrapper rather than directly at the platform's own origin.
--
-- Apply by hand in the CF dashboard: D1 → your database → Console tab, paste
-- this whole file, run — AFTER 0001-0004, once.

ALTER TABLE decks ADD COLUMN kind TEXT NOT NULL DEFAULT 'bento';
