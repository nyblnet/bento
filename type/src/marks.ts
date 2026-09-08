// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE CHARACTER MARKS — one list, rendered in more than one place.
//
// Bold, italic, underline, strikethrough and code were written out twice: as
// toggles in the properties panel, and as two loose buttons in the ⋯ menu
// (strikethrough and code, exiled there when the toolbar ran out of room). The
// selection toolbar would have been a third copy.
//
// So the set lives here and the surfaces render it. That is the same rule the
// Insert menu follows — ONE list, several ways to reach it — and it is the
// difference between adding a sixth mark in one place and remembering three.

import { ICONS } from './icons.ts';
import { t } from './i18n.ts';
import type { MarkType } from './inline.ts';

export interface MarkTool {
  t: MarkType;
  icon: string;
  /** a FUNCTION, not a string: a label built at import time freezes before the
   *  viewer's locale is resolved — the rule in i18n.ts. */
  title: () => string;
}

export const MARK_TOOLS: readonly MarkTool[] = [
  { t: 'b', icon: ICONS.bold, title: () => t('Bold (⌘B)') },
  { t: 'i', icon: ICONS.italic, title: () => t('Italic (⌘I)') },
  { t: 'u', icon: ICONS.underline, title: () => t('Underline (⌘U)') },
  { t: 's', icon: ICONS.strike, title: () => t('Strikethrough') },
  { t: 'code', icon: ICONS.code, title: () => t('Code') },
];
