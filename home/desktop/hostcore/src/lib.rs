// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The desktop host's security core (bento/connect H2), with no webview in it,
// so every rule is unit-tested on any machine:
// - trust:  which releases are genuine (bundled signed histories, the pinned
//   key, the anti-rollback floor) and the CSP each is served under;
// - origin: one origin per document (security §19g/§19i), and the change
//   detector for envelope documents;
// - arming: the per-load capability, generation-bound arming and the
//   navigation lock (security §19d/§19e).

pub mod trust;
pub mod origin;
pub mod arming;
