// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// TYPE-LEVEL test for the field-classification table. This file EMITS NOTHING
// (kernel/tsconfig.json has noEmit); its only job is to be type-checked by CI's
// "Typecheck kernel (standalone)" step (node_modules/.bin/tsc -p ../kernel),
// which includes "src". Every `@ts-expect-error` below marks a line that MUST
// fail to type-check; if a guard is weakened the error disappears, the directive
// becomes unused, and tsc fails the step — so the type half of the table is
// pinned, not merely asserted at runtime. Symbols are exported to satisfy
// noUnusedLocals.
//
// Verify by hand: delete the `readonly:` block from MODE_FIELD_RULES in
// docfields.ts and run `tsc -p kernel` — GOOD_OK below stops type-checking.

import {
  type FieldClass, type ModeFieldsOk, CLASS_RULES, MODE_FIELD_RULES,
} from './docfields.ts'

// A correct map: exactly readonly+template are 'mode'. This assignment HOLDS; it
// breaks (good) if a kernel mode field loses its MODE_FIELD_RULES entry.
export const GOOD = {
  docId: 'identity', title: 'content', collab: 'capability',
  readonly: 'mode', template: 'mode', revisions: 'history',
} satisfies Record<string, FieldClass>
export const GOOD_OK: ModeFieldsOk<typeof GOOD> = true

// A map that classes a THIRD field as 'mode' with no MODE_FIELD_RULES entry.
export const BAD_EXTRA_MODE = {
  docId: 'identity', readonly: 'mode', template: 'mode', locked: 'mode',
} satisfies Record<string, FieldClass>
// @ts-expect-error - `locked` is classed 'mode' but has no MODE_FIELD_RULES rule, so ModeFieldsOk is a diagnostic string, not `true`.
export const BAD_EXTRA_MODE_OK: ModeFieldsOk<typeof BAD_EXTRA_MODE> = true

// A map that omits a kernel mode field (template) from 'mode'.
export const BAD_MISSING_MODE = {
  docId: 'identity', readonly: 'mode', template: 'content',
} satisfies Record<string, FieldClass>
// @ts-expect-error - a kernel mode field is missing from the map, so ModeFieldsOk is a diagnostic string.
export const BAD_MISSING_MODE_OK: ModeFieldsOk<typeof BAD_MISSING_MODE> = true

// 'per-field' is allowed ONLY in the mode row of CLASS_RULES. A non-mode cell
// must reject it.
// @ts-expect-error - a content cell is a Rule and cannot hold the mode-only 'per-field' literal.
export const PER_FIELD_IN_CONTENT: (typeof CLASS_RULES)['content']['file'] = 'per-field'

// The mode row IS 'per-field' everywhere — a scalar Rule may not be written there.
// @ts-expect-error - the mode row only holds 'per-field'; 'keep' is not assignable.
export const KEEP_IN_MODE: (typeof CLASS_RULES)['mode']['reader'] = 'keep'

// MODE_FIELD_RULES is the single source for mode fields; referenced so the import
// is used and a typo in its shape surfaces here too.
export const MODE_FIELDS = Object.keys(MODE_FIELD_RULES)
