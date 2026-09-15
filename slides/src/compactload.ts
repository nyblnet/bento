// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The agent entry point for a document that may be compact (src/compact.ts).
// Kept apart from compact.ts so that module stays node-importable for the rig
// and the measure script: this one needs the untrusted gate, which is bundled.
//
// parseDoc (model.ts) stays what it is — the file on disk is always full. A
// COMPACT document is authored by a tool, so it gets the untrusted shape gate
// on the way in (sanitizeSlide, the same rule pasted clips and remote ops
// meet): an unknown key or a malformed value is dropped rather than reaching
// the renderer. A full document is not gated here — that is today's
// behaviour and today's promise (your own file is yours).

import { parseDoc, type BentoDoc, type Slide } from './model'
import { sanitizeSlide } from './untrusted'
import { expandDoc, isCompact } from './compact'

/**
 * Parse document JSON that may be compact. Returns null on anything parseDoc
 * refuses. Expansion happens BEFORE parseDoc so the format/slides checks and
 * docId minting see a full document.
 */
export function parseDocInput(json: string): BentoDoc | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!isCompact(raw)) return parseDoc(json)
  const expanded = expandDoc(raw) as unknown as Record<string, unknown>
  expanded.slides = ((expanded.slides ?? []) as unknown[]).map(sanitizeSlide).filter((s): s is Slide => s !== null)
  return parseDoc(JSON.stringify(expanded))
}
