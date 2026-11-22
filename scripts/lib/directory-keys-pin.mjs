// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The directory keys a PRODUCTION bento/home identity build may carry: the
// kernel's pinned set and nothing else. They are the export DIRECTORY_KEYS of
// kernel/src/directory-keys.ts ({"<kid>": "<raw P-256 point, base64url>"}),
// written by the kernel once the directory's keys are minted. Until that file
// exists (or while it exports none), there are no pinned keys, and a
// production identity build is refused (home/web/build.mjs; release.mjs
// --home-web-identity refuses before signing anything).
//
// A key from anywhere else (a --directory-keys file, a network answer, an
// environment variable) is never a production key: build.mjs takes a file only
// in a --dev build.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DIRECTORY_KEYS_MODULE = 'kernel/src/directory-keys.ts'

/** Is `keys` {"<kid>": "<raw P-256 point, base64url>"} with at least one entry? */
export function directoryKeysShape(keys) {
  return !!keys && typeof keys === 'object' && !Array.isArray(keys) && Object.keys(keys).length > 0 &&
    Object.entries(keys).every(([k, v]) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(k) && typeof v === 'string' && /^[A-Za-z0-9_-]{87}$/.test(v))
}

/**
 * The kernel's pinned directory keys under `root`, or { none: why } when there
 * are none to pin (no module, no export, an empty set). A module that is there
 * but malformed throws: that is a broken kernel, not an absence.
 */
export async function pinnedDirectoryKeys(root) {
  const file = path.join(root, DIRECTORY_KEYS_MODULE)
  if (!fs.existsSync(file)) return { none: `${DIRECTORY_KEYS_MODULE} does not exist yet` }
  const mod = await import(pathToFileURL(file).href)
  const keys = mod.DIRECTORY_KEYS
  if (keys === undefined || keys === null) return { none: `${DIRECTORY_KEYS_MODULE} exports no DIRECTORY_KEYS` }
  if (typeof keys === 'object' && !Array.isArray(keys) && Object.keys(keys).length === 0) return { none: `${DIRECTORY_KEYS_MODULE} pins no key` }
  if (!directoryKeysShape(keys)) throw new Error(`${DIRECTORY_KEYS_MODULE}: DIRECTORY_KEYS is not {"<kid>": "<raw P-256 point, base64url>"}`)
  return { keys: { ...keys } }
}
