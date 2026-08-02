// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Per-app identity for the kernel. Every Bento app calls configureApp() once,
// first thing at boot, before any kernel module is used.
//
// Only three values are app-specific across the whole kernel: the id the
// release manifest is signed with, the display name that appears in window
// titles and save dialogs, and where updates are fetched from. Everything
// else in the kernel is genuinely app-agnostic.
//
// Deliberately NOT a general "kernel init" — modules that need no config
// (anim, charts) take none, so there is no import-order trap and no false
// coupling for apps that skip a module. `autosave` is the one exception and
// reads appConfig() LAZILY, inside openDb(), for exactly that reason: its
// IndexedDB database is named per app, and resolving that at module scope
// would make importing it before configureApp() throw.

export interface AppConfig {
  /** Manifest `app` field this shell will accept — e.g. 'bento-slides'.
   *  A manifest signed for another app is rejected even though the signing
   *  key is shared platform-wide. */
  appId: string
  /** Human-facing product name: window title suffix, save-picker label. */
  appName: string
  /** Release manifest URL. Dev override: localStorage 'bento-update-url'. */
  manifestUrl: string
}

let config: AppConfig | null = null

/** Called once at boot, before kernel modules are used. */
export function configureApp(cfg: AppConfig): void {
  config = cfg
}

/** The active app config. Throws if the app forgot to configure itself —
 *  a loud failure at boot beats silently checking updates against the
 *  wrong manifest. */
export function appConfig(): AppConfig {
  if (!config) throw new Error('bento kernel: configureApp() was never called')
  return config
}
