// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// How each TOP-LEVEL field of a bento/spaces document is copied — the space's
// row in the kernel's field classification (kernel/src/docfields.ts).
//
// Not to be confused with fields.ts, which is a page's PROPERTIES (status,
// due date, assignee). This file is about the document's own keys: which of
// them a copy handed to someone else may carry.
//
// THE MAP IS EXHAUSTIVE, and the compiler holds it to that. `satisfies` over
// the document's DECLARED keys fails tsc on a key that is missing here and on
// one that is not a field, so a new field cannot reach a copy without
// somebody deciding what it is. A field that arrives without being declared at
// all (a newer build's, or an agent's) is unclassified, and the kernel drops it
// from every copy except the file itself and the owner's duplicate.
//
// Every copy for someone else is built by `projectForCopy(doc, SPACES_FIELDS,
// tier)` (share.ts, model.ts docForExport), which starts from an EMPTY object
// and carries a field only when the kernel's table says so for that tier.

import type { FieldClass, ModeFieldsOk } from '../../kernel/src/docfields.ts'
import type { SpacesDoc } from './model.ts'

/** The keys SpacesDoc declares — its index signature (`[extra: string]`)
 *  removed, which would otherwise make `keyof` plain `string` and the map
 *  exhaustive over nothing. */
type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]
}

export const SPACES_FIELDS = {
  // identity — re-minted on a duplicate, never on any other copy
  docId: 'identity',
  // mode — SET per copy by the kernel's MODE_FIELD_RULES (a reader copy is
  // readonly, a template copy is a template), never simply stripped
  readonly: 'mode',
  template: 'mode',
  // capability — every field under it is a bearer key; projected through the
  // kernel's allowlists (collabForReader / collabForInvite), including `sync`
  collab: 'capability',
  // history — file-local version history: kept by the file, the duplicate and
  // an invite; dropped from every reader-tier copy and from Copy document JSON
  revisions: 'history',
  trail: 'history',
  // content — the document itself
  format: 'content',
  version: 'content',
  policy: 'content',
  title: 'content',
  // content, but NOT an edit: excluded from the recovery key (model.ts)
  modified: 'content',
  pages: 'content',
  home: 'content',
  theme: 'content',
  design: 'content',
  designs: 'content',
  // the asset pool
  assets: 'content',
  footnotes: 'content',
  fonts: 'content',
  templates: 'content',
  journalTemplate: 'content',
} satisfies Record<DeclaredKeys<SpacesDoc>, FieldClass>

/** tsc fails here if the fields classed 'mode' stop being exactly the kernel's
 *  two (readonly, template). */
const _modeOk: ModeFieldsOk<typeof SPACES_FIELDS> = true
void _modeOk

/** Content that changes without anyone editing — excluded from the recovery
 *  key so an autosave of an untouched space is not a phantom edit. */
export const SPACES_NOT_EDIT: ReadonlySet<string> = new Set(['modified'])
