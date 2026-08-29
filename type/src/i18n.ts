// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Facade: the i18n ENGINE lives in the shared kernel; CATALOGS are per-app
// string data and live in ./i18n/. This module registers them at import time
// and re-exports the engine, so registration is guaranteed to precede the first
// t() call by ES module evaluation order — the same arrangement slides and
// spaces use.
//
// ENGLISH-STRING-AS-KEY (gettext style): the source sentence IS the key, so a
// missing entry falls back to readable English rather than a blank. Never call
// t() in a module-level const — it would freeze at import time, before the
// viewer's locale is resolved. That rule is why the chrome sets its labels from
// script rather than from the markup template.
//
// NO CATALOGS YET, DELIBERATELY, and this is the interesting part.
//
// The sweep (every user-visible string routed through t()) and the translation
// (those strings rendered into eight languages) are two different jobs, and
// doing them together here would mean doing the second one twice. bento/type is
// missing lists, tables, images, links and find — each of which brings its own
// UI strings — so the string set is about to move a lot. Translating an
// 85-string app that is on its way to a few hundred wastes the translation and,
// worse, leaves half-translated chrome in the shipped file, which reads as
// broken in a way plain English does not.
//
// So: the sweep lands now, because it must precede any translation and because
// an un-swept string is invisible to the extractor later. The catalogs land
// when the tier-1 features are in and the strings have stopped moving. Until
// then the picker offers nothing, rather than offering languages that would
// return English — an empty menu is honest and a dead one is not.
//
// The engine handles this exact case: with no packed table, t() returns its
// argument, which IS the English source text.

import { registerI18n } from '../../kernel/src/i18n.ts';

registerI18n({
  choices: [{ code: 'en', label: 'English' }],
});

export { t, locale, setLocale, localeChoices } from '../../kernel/src/i18n.ts';
export type { LocaleChoice } from '../../kernel/src/i18n.ts';
