// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect W2 — whether "Open with Bento ID" exists at all.
//
// TWO gates, both required: an UNPACKED install (the same gate as Bento ID
// setup) AND a setting that is OFF unless someone turned it on. Even then it
// is an explicit action on a document, never a change to how files open:
// double-clicking a file, and the library's own Open, are untouched. Store
// users get nothing until the directory exists and a Bento ID is real.

export const SETTING_KEY = 'serveWithIdentity'

/** Pure: only exactly 'development' and exactly true. Absent is off. */
export function servedOpenAllowed(installType, setting) {
  return installType === 'development' && setting === true
}

export async function servedOpenEnabled() {
  let installType = null
  try { installType = (await chrome.management.getSelf())?.installType ?? null } catch { installType = null }
  let setting = null
  try { setting = (await chrome.storage.local.get(SETTING_KEY))[SETTING_KEY] ?? null } catch { setting = null }
  return servedOpenAllowed(installType, setting)
}
