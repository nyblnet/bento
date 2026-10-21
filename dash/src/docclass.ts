// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// How each TOP-LEVEL field of a bento/dash workbook is classed — the
// workbook's row in the kernel's field classification
// (kernel/src/docfields.ts). share.ts builds every copy that goes to SOMEONE
// ELSE (a reading copy, an invite, a view-only follower) through the kernel's
// copy table with this map, so what a copy carries is decided by one table and
// not by a hand-written list of deletes in each builder.
//
// THE MAP IS EXHAUSTIVE, and the compiler holds it to that: `satisfies` over
// DashDoc's declared keys fails tsc on a key missing here and on one that is
// not a field. A key that is not in this map at all — a newer build's field —
// follows the kernel's fail-closed default: kept by the file itself, dropped
// from every copy made for another person.
//
// Not a format change: nothing here is written into a file. It only answers
// "which fields survive which copy".

import type { FieldClass, ModeFieldsOk } from '../../kernel/src/docfields.ts'
import type { DashDoc } from './model.ts'

/** DashDoc's declared keys, without its `[extra: string]` index signature —
 *  which would otherwise make `keyof` plain `string`. */
type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]
}

export const DASH_FIELDS = {
  // identity — re-minted on a duplicate, never on any other copy
  docId: 'identity',
  // mode — SET per copy by the kernel's MODE_FIELD_RULES (a reader copy is
  // read-only, a template copy is a template), never simply stripped
  readonly: 'mode',
  template: 'mode',
  // capability — every field under it is a bearer key; projected through the
  // kernel's allowlists (collabForReader / collabForInvite)
  collab: 'capability',
  // content — the workbook itself. Comments live inside their sheets.
  format: 'content',
  version: 'content',
  policy: 'content',
  title: 'content',
  modified: 'content',
  meta: 'content',
  sheets: 'content',
  measures: 'content',
  story: 'content',
  chart: 'content',
  names: 'content',
  views: 'content',
  theme: 'content',
  assets: 'content',
  // the relay's offload map — content, exactly as slides classes it
  blobs: 'content',
} satisfies Record<DeclaredKeys<DashDoc>, FieldClass>

/** tsc fails here if the fields classed 'mode' stop being exactly the
 *  kernel's two (readonly, template). */
const _modeOk: ModeFieldsOk<typeof DASH_FIELDS> = true
void _modeOk
