// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What the relay refused, in words somebody can act on.
//
// The wording is bento/slides' word-for-word, deliberately. These four
// sentences were already written, already reviewed and already translated into
// eight languages there; rewording them for a notes app would mean eight fresh
// translations to say the same thing, and would let the two apps drift on the
// one message a user only ever sees when something has gone wrong.
//
// The distinction the text carries is the important part: for the permanent
// codes the change IS saved in this copy and will never reach anyone else, so
// the sentence has to say both halves. "Sync failed" would leave a person
// believing they had lost work they still have.

import { t } from './i18n.ts'
import type { SyncNotice } from './sync/session.ts'

export function syncNoticeText(n: SyncNotice): string {
  switch (n.code) {
    case 'too-large':
      return n.media
        ? t('That image is too large to share live (about 1 MB max). It’s saved in your copy, but collaborators won’t see it.')
        : t('That change is too large to share live (about 1 MB max). It’s saved in your copy, but collaborators won’t see it.')
    case 'room-full':
      return t('This live session has run out of room. Your change is saved in your copy, but collaborators won’t see it.')
    case 'storage-failed':
      return t('The live session couldn’t store that change. It’s saved in your copy, but collaborators won’t see it.')
    case 'rate-limited':
      return t('Too many changes at once — live sync is catching up.')
  }
}
