#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Origin-trust rig for boot-read dev overrides.
//
//   node scripts/test-origin-overrides.ts
//
// The release-manifest URL, the sync host and the pack host each have a
// localStorage dev override. Chrome gives every file:// document one shared
// origin, so localStorage there is not this document's alone — an override must
// be honoured only from a real, isolated origin. sharedStorageOrigin() is that
// gate. The read sites are asserted at source (they need a DOM/network to run).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0, checks = 0
function ok(cond: boolean, msg: string) { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

const g = globalThis as Record<string, unknown>
const setOrigin = (protocol: string, origin: string | undefined) => {
  g.location = { protocol, origin }
  g.self = origin === undefined ? undefined : { origin }
}
const { sharedStorageOrigin } = await import('../kernel/src/net.ts')

// file:// — every local document shares this origin's storage
setOrigin('file:', 'null')
ok(sharedStorageOrigin() === true, 'file:// is shared storage (overrides ignored)')
// file:// where the origin string serialises non-null (some engines): the
// protocol check, not the opaque check, is what catches it
setOrigin('file:', 'file://')
ok(sharedStorageOrigin() === true, 'file:// is shared even when its origin is not the string "null"')
// a real isolated web origin
setOrigin('https:', 'https://bento.page')
ok(sharedStorageOrigin() === false, 'a real https origin is trusted (overrides honoured)')
// localhost dev over http — a real origin, isolated
setOrigin('http:', 'http://localhost:5199')
ok(sharedStorageOrigin() === false, 'localhost dev is trusted')
// opaque origin (self.origin === 'null') even on a non-file protocol
setOrigin('https:', 'null')
ok(sharedStorageOrigin() === true, 'an opaque origin is shared storage')
// cannot determine → fail safe (treat as shared)
g.location = undefined; g.self = undefined
ok(sharedStorageOrigin() === true, 'origin undeterminable → treated as shared (fail safe)')

// --- the kernel read sites gate the override on it --------------------------
{
  const upd = readFileSync(join(root, 'kernel/src/update.ts'), 'utf8')
  ok(/sharedStorageOrigin\(\)\s*\?\s*null\s*:\s*lsGet\('bento-update-url'\)/.test(upd),
    'update.ts honours bento-update-url only from a non-shared origin')
  const onl = readFileSync(join(root, 'kernel/src/sync/online.ts'), 'utf8')
  ok(/sharedStorageOrigin\(\)\s*\?\s*''\s*:\s*lsGet\('bento-sync-url'\)/.test(onl),
    'online.ts honours bento-sync-url only from a non-shared origin')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
