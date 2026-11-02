// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import Foundation

/// What happens when a person types their recovery code on a new device
/// (identity-design §2f, security §28): the decisions, apart from the screen.
///
/// Argon2id needs 64 MiB, and iOS ends a process that asks for more than it was
/// given. So the order is fixed:
/// 1. ask `Argon2id.hasMemory()` BEFORE anything else. If it says no, the answer
///    is `.unavailable` and the code is never read, let alone tried.
/// 2. read the code (a typo is caught by its check symbol, here, before any work)
/// 3. stretch it and open the blob.
///
/// Only step 3's decrypt failing is a wrong code, and only that counts against
/// `wrongCodes`. A device that can't afford the derivation, a typo, or a blob that
/// opens but doesn't match the directory-signed binding says nothing about whether
/// the person holds the right code, and none of them is counted. Counting a memory
/// refusal as a wrong guess would lock people out for owning an old phone.
struct RecoveryFlow {
    enum Outcome: Equatable {
        /// this device can't spare the memory right now (the UI says so; nothing was tried)
        case unavailable
        /// not a recovery code: why ("length", "character" or "check"), so the UI can point at it
        case notACode(String)
        /// the code stretched fine and did NOT open the blob
        case wrongCode
        /// the code was right (the blob opened) but what's inside isn't the key the
        /// directory-signed binding names: a swapped blob, refused
        case blobRejected(String)
        case restored(IdentityRecovery.BlobKeys)
    }

    /// the directory's inner blob and the binding it must match
    struct Material: Equatable {
        let salt: [UInt8]
        let iv: [UInt8]
        let ct: [UInt8]
        let accountPub: String
        let kxPub: String?
    }

    /// guesses that really were guesses
    private(set) var wrongCodes = 0

    /// what the screen shows before it asks for anything
    var available: Bool { Argon2id.hasMemory() }

    mutating func attempt(_ typed: String, _ m: Material) -> Outcome {
        guard Argon2id.hasMemory() else { return .unavailable }
        let code: [UInt8]
        switch IdentityRecovery.parseCode(typed) {
        case .no(let why): return .notACode(why)
        case .ok(let c): code = c
        }
        // memory can vanish between the check and the derivation: still not a guess
        guard var wrap = IdentityRecovery.recoveryWrapKey(code: code, salt: m.salt) else { return .unavailable }
        defer { Argon2id.wipe(&wrap) }
        switch IdentityRecovery.openRecoveryInner(m.ct, wrapKey: wrap, iv: m.iv, accountPub: m.accountPub, kxPub: m.kxPub) {
        case .ok(let keys): return .restored(keys)
        case .no("decrypt"):
            wrongCodes += 1
            return .wrongCode
        case .no(let why): return .blobRejected(why)
        }
    }
}
