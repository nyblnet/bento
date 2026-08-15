// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Telling unpacked installs that they are behind.
//
// THE PROBLEM. Store installs update themselves; an extension loaded unpacked
// NEVER does. Chrome ignores `update_url` for a development install — it is
// running from a directory on disk, and nothing is going to rewrite that
// directory. So someone who takes the GitHub route is frozen at whatever they
// downloaded, and will not find out from the browser.
//
// WHO IS ASKED. `chrome.management.getSelf()` reports `installType`, and
// `development` means unpacked. It needs NO permission — verified in the API
// docs, which say so explicitly — so this costs nothing on the listing. Store
// users (`normal`) are never checked and never badged: they update silently,
// and a notice they cannot act on is noise.
//
// WHAT IS SENT. A GET for a static JSON file. No identifiers, no query string,
// no version reported upward — the comparison happens here. That is the same
// promise the app's own update check makes ("no ids, no telemetry"), and it
// should not be quietly weaker in the extension.
//
// WHAT IT DOES NOT DO. It cannot install anything. There is no mechanism for an
// unpacked extension to update itself, and inventing one would mean downloading
// code and asking the user to trust it — exactly the thing a reviewer would ask
// about. It reports, links to the release, and stops.

import { GRANT, get, put } from './db.js'

/** Mirrors the app's release channels: /releases/<app>/manifest.json */
const MANIFEST = 'https://bento.page/releases/tray/manifest.json'

/** Numeric compare, most significant first. Returns >0 when `a` is newer. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/**
 * Is this install one that will never update itself?
 *
 * Anything but `normal` is treated as "tell them": `development` is the GitHub
 * route this exists for, and `sideload`/`admin`/`other` also arrive outside the
 * store's update mechanism. Being unable to ask at all is treated the same way
 * as a store install — silence — because badging on a guess is worse than
 * missing a case.
 */
export async function isSelfManaged(deps = {}) {
  const getSelf = deps.getSelf ?? (() => chrome.management.getSelf())
  try {
    const self = await getSelf()
    return self?.installType !== 'normal'
  } catch {
    return false
  }
}

/**
 * Check, and remember the answer.
 *
 * Stored rather than returned to a caller, because the surfaces that show it —
 * the badge, the library, settings — run in different contexts at different
 * times, and none of them should trigger a network request of its own.
 */
export async function checkForUpdate(deps = {}) {
  const net = deps.fetch ?? fetch
  const current = deps.currentVersion ?? chrome.runtime.getManifest().version
  const save = deps.put ?? ((v) => put(GRANT, 'update', v))

  if (!(await isSelfManaged(deps))) {
    await save(null) // a store install that was once unpacked must stop nagging
    return null
  }

  try {
    const res = await net(MANIFEST, { cache: 'no-store' })
    if (!res.ok) return null
    const m = await res.json()
    if (!m?.version || compareVersions(m.version, current) <= 0) {
      await save(null)
      return null
    }
    const found = {
      version: m.version,
      url: m.url ?? 'https://github.com/nyblnet/bento/releases',
      // The package is byte-reproducible (scripts/pack-webext.mjs), so a
      // published digest lets anyone confirm the zip they downloaded is the one
      // that was built. Carried through rather than dropped, even though
      // nothing here can verify it: the person doing the install can.
      sha256: m.sha256 ?? null,
      found: Date.now(),
    }
    await save(found)
    return found
  } catch {
    // Offline, DNS, a redirect to a captive portal. Silence is right: this is
    // a courtesy, and a broken courtesy should not look like a broken product.
    return null
  }
}

/** What the last check found, if anything. */
export const pendingUpdate = () => get(GRANT, 'update')
