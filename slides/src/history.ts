// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slides owns its metadata policy; differences and reversal live in kernel.
import { changes as diff } from '../../kernel/src/history.ts'
export { copy, equal, reverse } from '../../kernel/src/history.ts'
export type { Change, Path } from '../../kernel/src/history.ts'
export function changes(before: unknown, after: unknown) {
  return diff(before, after, { ignoreRootKeys: ['modified', 'collab', 'docId'] })
}
