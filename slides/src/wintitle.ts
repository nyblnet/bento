// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Window titles. Every title slides gives a window — the editor's tab, the
 * player's and audience's, the speaker-view popup's — is built here, so one
 * rule covers them all: while the file's body is sealed (a password or the
 * identity seal — kernel isBodySealed()),
 * a window title never carries the deck's title. Browsers keep tab titles in
 * their history on disk, in plaintext, so a title shown in a tab outlives the
 * session and sits beside a file whose whole point is that its content is not
 * readable without the password. A sealed deck's tab is named by its FILE
 * (already in the address bar and in history, through its URL), else by the
 * app. This reverses #742's choice to show the real title after unlocking.
 */
import { appConfig } from '../../kernel/src/app.ts'
import { currentFileName, isBodySealed, openedFileName } from './save'
import { t } from './i18n'

/** Is the deck's body sealed, so its title must stay out of every window title? */
export const titleSealed = (): boolean => isBodySealed()

/** The neutral name: the file when it is known, else the app. The editor
 *  passes the file it knows (a dropped file is named by itself, not the URL). */
export function neutralWindowTitle(file: string | null = currentFileName() ?? openedFileName()): string {
  const app = appConfig().appName
  return file ? `${file} — ${app}` : app
}
const neutral = () => neutralWindowTitle()

/** A boot or player window: "<deck title> — <app>", or the neutral name while sealed. */
export function deckWindowTitle(docTitle: string): string {
  return titleSealed() ? neutral() : `${docTitle} — ${appConfig().appName}`
}

/** The speaker-view popup: "<deck title> — Speaker view", or no deck title while sealed. */
export function speakerWindowTitle(docTitle: string): string {
  return titleSealed() ? `${t('Speaker view')} — ${appConfig().appName}` : `${docTitle} — ${t('Speaker view')}`
}
