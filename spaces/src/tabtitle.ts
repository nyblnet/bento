// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The browser tab's title. Every write to document.title goes through here.
//
// Neutral title while sealed, matching the saved file's title: while the body
// is sealed (a password or the identity seal, kernel isBodySealed()), the tab
// reads the app's name, exactly what the kernel writes into the saved file's
// <title>, and never the space's or a page's title.

import { appConfig } from '../../kernel/src/app.ts'
import { isBodySealed } from '../../kernel/src/save.ts'

/** What the tab should read for a space titled `docTitle`. */
export function tabTitle(docTitle: string): string {
  const app = appConfig().appName
  return isBodySealed() ? app : `${docTitle} — ${app}`
}

/** Set the tab's title for a space titled `docTitle`. */
export function setTabTitle(docTitle: string): void {
  document.title = tabTitle(docTitle)
}

/** The neutral title, before the body is open (the password gate). */
export function setNeutralTabTitle(): void {
  document.title = appConfig().appName
}
