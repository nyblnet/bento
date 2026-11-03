// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect — the desktop agent core (Windows, Linux).
//
// The reference for every byte is kernel/src/statements.ts and
// kernel/src/address.ts; the CONTRACT is kernel/fixtures/identity-v1.json,
// which tests/conformance.rs runs row by row. This crate never re-derives a
// rule from prose: where the reference makes a choice (an order of checks, a
// JS string semantic), it is mirrored here and commented.

pub mod address;
pub mod agent;
pub mod b64u;
pub mod device_list;
pub mod webauthn;
pub mod recovery;
mod display_table;
pub mod statements;

#[cfg(all(target_os = "linux", feature = "tpm"))]
pub mod tpm_linux;

#[cfg(all(target_os = "linux", feature = "keyring"))]
pub mod secret_linux;

#[cfg(all(target_os = "linux", feature = "fido"))]
pub mod fido_linux;
