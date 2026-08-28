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
  announceRuntime()
}

declare const __APP_VERSION__: string

/**
 * Tell a HOST which Bento runtime this document carries.
 *
 * A host that polyfills `showSaveFilePicker` (home/webext) must know whether
 * this document is old enough to predate `pickerIdFor` (#213). Before that,
 * every save — including "Save a copy…" — sent `bento-doc`, so acting on the id
 * there overwrites the open document. The host therefore refuses to write in
 * place unless the runtime says it is at least 1.0.15.
 *
 * It used to read that from `window.bento.updates.version`, which each app
 * assembles by hand — and **bento/dash does not include `updates` at all**, so
 * every ⌘S in Dash fell back to a destination prompt even with a folder
 * granted. The bug is not that Dash forgot; it is that the signal lived in a
 * per-app object at all. Every app calls `configureApp`, so the version is
 * announced here, once, and the next app gets it without knowing this exists.
 *
 * Deliberately a plain string on `window`, not a getter or an object: a host
 * reads it from the page's world through a content script, and the simplest
 * possible value is the one least likely to be mangled crossing that boundary.
 */
function announceRuntime(): void {
  try {
    const v = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
    Object.defineProperty(window, '__bentoRuntime', {
      value: v, writable: false, configurable: true, enumerable: false,
    })
  } catch {
    /* already defined (a second configureApp in tests), or no window at all */
  }
}

/** The active app config. Throws if the app forgot to configure itself —
 *  a loud failure at boot beats silently checking updates against the
 *  wrong manifest. */
export function appConfig(): AppConfig {
  if (!config) throw new Error('bento kernel: configureApp() was never called')
  return config
}
