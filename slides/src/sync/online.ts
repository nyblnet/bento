// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The online relay transport for bento/slides — A FACADE. The implementation
// is kernel/src/sync/online.ts.
//
// It needed almost nothing to move: the E2EE transport, the credential
// minting, the invite/member signature chain and the reconnect logic never
// knew what a slide was — they work in terms of `doc.collab` and `docId`,
// which every Bento document has (PLATFORM §2).
//
// Even the hard no-network switch needed nothing: `offlineEnabled` was ALREADY
// in kernel/src/update.ts, and this app's update.ts is itself a facade over it.
// An injection point was built for it first and then removed — the dependency
// it was defending against did not exist.

export * from '../../../kernel/src/sync/online.ts';
