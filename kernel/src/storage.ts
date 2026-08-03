// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Preference storage that cannot take the app down.
//
// WHY THIS EXISTS. `localStorage` is not always there, and the way it is absent
// is worse than useful: reading the PROPERTY throws, before any method is
// called. So the obvious defences are themselves the crash —
//
//   if (localStorage) …                        // throws
//   if (typeof localStorage !== 'undefined') … // throws
//
// — and the only way to find out is to attempt it inside a `try`. One bare read
// at module scope therefore takes the whole file down before it paints. That is
// exactly what happened: `resolve()` in i18n.ts reads `bento-lang` on import, so
// in a context without storage the shell caught the SecurityError and printed
// "This file could not start" instead of opening the deck.
//
// The contexts where that happens are real, and none of them are exotic:
//
//   · a sandboxed iframe without `allow-same-origin` (an opaque origin — no
//     localStorage, no IndexedDB, no caches)
//   · a browser set to block site data, or an embedded webview with storage
//     partitioned off
//   · Safari private browsing, historically, on write
//
// In every one of them a Bento file should open and work. Preferences are
// preferences: not having them is what a first-time visitor looks like, which
// is a path the app already handles well. Losing the DOCUMENT because we could
// not read a language code is a bad trade.
//
// So: reads degrade to "unset", writes degrade to "did not stick", and nothing
// throws. Both layers are guarded deliberately — the property access throws in
// an opaque origin, and the methods can throw separately on quota.
//
// IndexedDB already does this (autosave.ts guards `indexedDB.open`), so the
// gap this closes is localStorage, and specifically the READS: writes were
// mostly defended already, because a full disk is the failure somebody hit
// first. Reads are what run at boot.

/** The Storage object, or null where the context refuses to hand one over. */
function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // opaque origin, site data blocked, storage partitioned off
  }
}

/** A stored preference, or null when unset OR unavailable. Never throws. */
export function lsGet(key: string): string | null {
  try {
    return backing()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/**
 * Store a preference. Returns whether it actually stuck, so a caller that
 * cares (an explicit "remember this" affordance) can say so — most do not.
 */
export function lsSet(key: string, value: string): boolean {
  try {
    const s = backing()
    if (!s) return false
    s.setItem(key, value)
    return true
  } catch {
    return false // quota, or a context that allows reads but refuses writes
  }
}

/** Forget a preference. A no-op where there is nothing to forget from. */
export function lsDel(key: string): void {
  try {
    backing()?.removeItem(key)
  } catch {
    /* nothing to remove from */
  }
}

/**
 * A JSON-shaped preference, falling back on anything unusable.
 *
 * Several call sites stored objects and each re-invented
 * `JSON.parse(getItem(k) ?? '{}')` inside its own try — which meant a corrupt
 * value and an unavailable store took different paths in different files. Here
 * they are the same path: you get the fallback.
 */
export function lsJson<T>(key: string, fallback: T): T {
  const raw = lsGet(key)
  if (raw === null) return fallback
  try {
    const parsed = JSON.parse(raw)
    return (parsed ?? fallback) as T
  } catch {
    return fallback // someone else's data, or a half-written value
  }
}

/** Store a JSON-shaped preference. Returns whether it stuck. */
export function lsSetJson(key: string, value: unknown): boolean {
  try {
    return lsSet(key, JSON.stringify(value))
  } catch {
    return false // circular, or otherwise not serialisable
  }
}

/**
 * Is persistent preference storage available at all?
 *
 * For UI that would otherwise promise something it cannot keep — "remember my
 * name", a version-history panel. Not for guarding the accessors above: they
 * are already safe, and a caller checking first would just be racing.
 */
export function storageAvailable(): boolean {
  return backing() !== null
}
