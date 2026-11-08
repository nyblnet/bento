// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation

/// The release signing PUBLIC keys this build trusts: the ONE place they live.
/// Every signed thing this app reads checks against them: release manifests
/// (Releases) and release histories (ReleaseHistory).
///
/// Copied from `kernel/src/update.ts`. The private half lives offline with the
/// maintainer. A rotation ships as an app update that pins the new key here, and
/// only the new key: a build that still trusts a retired key accepts what that
/// key signs.
enum ReleaseKeys {
    /// JWK x and y, base64url
    private static let pinned: [(x: String, y: String)] = [
        ("GMHSKwWcAoJVq-Dz1ZxWZM6TXATWIKbaQBpjoTystH8", "flFNzbdXCmJN8RQYCeG71rBZnnbN-MCEnp1EbCLFrj0"),
    ]

    static let keys: [P256.Signing.PublicKey] = pinned.compactMap { k in
        guard let x = b64url(k.x), let y = b64url(k.y) else { return nil }
        return try? P256.Signing.PublicKey(rawRepresentation: x + y)
    }

    /// Does any pinned key sign `message` with this raw r‖s signature?
    static func verify(_ signature: Data, _ message: Data) -> Bool {
        guard let sig = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
        return keys.contains { $0.isValidSignature(sig, for: message) }
    }

    static func b64url(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
}
