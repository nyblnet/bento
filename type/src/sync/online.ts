// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The online relay transport for bento/type — A FACADE. The implementation
// is kernel/src/sync/online.ts.
//
// It needed nothing app-specific to move: the E2EE transport, the credential
// minting, the invite/member signature chain and the reconnect logic all work
// in terms of `doc.collab` and `docId`, which every Bento document has
// (PLATFORM §2) — see type/src/model.ts TypeDoc.collab.

export * from '../../../kernel/src/sync/online.ts';
