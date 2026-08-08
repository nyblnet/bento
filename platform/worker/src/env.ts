// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Cloudflare bindings this Worker expects. There is deliberately no
// wrangler.toml in this project — bindings are added by hand in the CF
// dashboard (Worker → Settings → Bindings) after pasting the bundled
// dist/worker.js via Quick Edit. See platform/README.md for the exact names
// to use; they must match the property names below verbatim.
export interface Env {
  /** R2 bucket: deck doc JSON + uploaded asset blobs. Binding name: DOCS. */
  DOCS: R2Bucket
  /** D1 database: deck metadata + edit-token hashes. Binding name: DB. */
  DB: D1Database
}
