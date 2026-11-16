// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Facade: the IndexedDB auto-save/version store lives in the shared kernel now
// (kernel/src/autosave.ts). This path stays alive so slides code keeps
// importing './autosave' unchanged — see docs/PLATFORM.md §9.
//
// docContentKey stays HERE (not in the kernel): "what counts as content" is a
// per-app model question — it reads slides-specific fields the kernel must
// never see. Spaces/dash define their own beside their models.

import type { BentoDoc } from './model'

export * from '../../kernel/src/autosave.ts'

/** The content that actually matters for "did this change" — excludes volatile
 *  fields (modified timestamp, collab sync state) that churn without a real edit. */
export function docContentKey(doc: BentoDoc): string {
  // Restore sanitizes documents and rebuilds element objects, so equivalent
  // content can arrive with a different property order. Keep array order
  // meaningful, but make object key order irrelevant to recovery comparison.
  return JSON.stringify(
    [doc.title, doc.size, doc.theme, doc.slides, doc.layouts ?? null, doc.fonts ?? null, doc.assets ?? null],
    (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
      : value,
  )
}
