// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation

/// bento/connect's recovery code and key blobs (identity-design §2f, security §28), a
/// Swift port of kernel/src/recovery.ts held to every byte of
/// kernel/fixtures/recovery-v1.json by scripts/test-home-id-recovery.mjs.
///
/// Two ways back into an account on a new device:
/// - a passkey's PRF output unwraps the account key from a per-passkey blob
/// - the printed recovery code, stretched by Argon2id, unwraps a second blob
///
/// The directory's pepper layer over the recovery blob is server-side and isn't
/// here.
enum IdentityRecovery {
    enum Verdict<T> {
        case ok(T)
        case no(String)
    }

    // MARK: - the recovery code: 80 bits, Crockford base32, a mod-37 check symbol

    static let codeBytes = 10
    static let saltLength = 16
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf16)
    /// the 32 above, plus * ~ $ = U for check values 32–36
    private static let checkAlphabet = alphabet + Array("*~$=U".utf16)

    private static func check37(_ code: [UInt8]) -> Int { code.reduce(0) { ($0 * 256 + Int($1)) % 37 } }

    /// The printed form: XXXX-XXXX-XXXX-XXXX-C.
    static func formatCode(_ code: [UInt8]) -> String? {
        guard code.count == codeBytes else { return nil }
        var s: [UInt16] = []
        for i in 0..<16 {   // symbol i is bits 5i..5i+4 from the top
            let bit = i * 5, byte = bit >> 3, sh = bit & 7
            let two = (Int(code[byte]) << 8) | (byte + 1 < codeBytes ? Int(code[byte + 1]) : 0)
            s.append(alphabet[(two >> (11 - sh)) & 31])
        }
        let g = { (r: Range<Int>) in String(utf16CodeUnits: Array(s[r]), count: r.count) }
        return "\(g(0..<4))-\(g(4..<8))-\(g(8..<12))-\(g(12..<16))-" +
            String(utf16CodeUnits: [checkAlphabet[check37(code)]], count: 1)
    }

    /// JavaScript's \s, which the reference strips: a host must forgive exactly the same.
    private static let jsSpace: Set<UInt16> = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680,
        0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
        0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]

    /// Read what a person typed: case, spaces and hyphens don't matter; O reads
    /// as 0 and I/L as 1; the check symbol must match, so a typo is caught here.
    /// Returns the 10 bytes Argon2id takes, never the string. Counted in UTF-16,
    /// as the reference counts, so the two agree on every input.
    static func parseCode(_ input: String) -> Verdict<[UInt8]> {
        let up = input.uppercased().utf16.filter { !jsSpace.contains($0) && $0 != 0x2D }.map { (u: UInt16) -> UInt16 in
            switch u { case 0x4F: return 0x30; case 0x49, 0x4C: return 0x31; default: return u }
        }
        guard up.count == 17 else { return .no("length") }
        var code = [UInt8](repeating: 0, count: codeBytes)
        for i in 0..<16 {
            guard let v = alphabet.firstIndex(of: up[i]) else { return .no("character") }   // U is only a check
            let bit = i * 5, byte = bit >> 3, sh = bit & 7
            let two = v << (11 - sh)
            code[byte] |= UInt8(two >> 8)
            if byte + 1 < codeBytes { code[byte + 1] |= UInt8(two & 0xFF) }
        }
        guard let check = checkAlphabet.firstIndex(of: up[16]) else { return .no("character") }
        guard check == check37(code) else { return .no("check") }
        return .ok(code)
    }

    // MARK: - derivations

    /// HKDF-SHA-256 to 32 bytes; an empty salt is zero-length (the same as 32 zero bytes).
    static func hkdf(_ ikm: [UInt8], salt: [UInt8] = [], info: String) -> [UInt8] {
        let k = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt,
                                       info: Data(info.utf8), outputByteCount: 32)
        return k.withUnsafeBytes { Array($0) }
    }

    /// the recovery blob's wrap key: HKDF(Argon2id(code, salt), empty, "bento/id/rc-wrap/v1").
    /// nil for a malformed input, or when Argon2id.hasMemory() says no
    static func recoveryWrapKey(code: [UInt8], salt: [UInt8]) -> [UInt8]? {
        guard code.count == codeBytes, salt.count == saltLength else { return nil }
        guard var stretched = Argon2id.hash(password: code, salt: salt) else { return nil }   // no memory for it
        defer { Argon2id.wipe(&stretched) }
        return hkdf(stretched, info: "bento/id/rc-wrap/v1")
    }

    /// what proves knowledge of the code to the directory: Argon2id(code, salt_v)
    static func recoveryVerifier(code: [UInt8], saltV: [UInt8]) -> [UInt8]? {
        guard code.count == codeBytes, saltV.count == saltLength else { return nil }
        return Argon2id.hash(password: code, salt: saltV)
    }

    /// the PRF blob's key: HKDF(PRF output, 32-byte salt, "bento/id/acct-wrap/v1")
    static func prfKek(prfOutput: [UInt8], salt: [UInt8]) -> [UInt8]? {
        guard prfOutput.count == 32, salt.count == 32 else { return nil }
        return hkdf(prfOutput, salt: salt, info: "bento/id/acct-wrap/v1")
    }

    // MARK: - AES-256-GCM: ciphertext ‖ 16-byte tag, 12-byte IV

    static func gcmSeal(key: [UInt8], iv: [UInt8], aad: String, _ pt: [UInt8]) -> [UInt8]? {
        guard key.count == 32, iv.count == 12, let nonce = try? AES.GCM.Nonce(data: iv),
              let box = try? AES.GCM.seal(pt, using: SymmetricKey(data: key), nonce: nonce, authenticating: Data(aad.utf8))
        else { return nil }
        return Array(box.ciphertext) + Array(box.tag)
    }

    static func gcmOpen(key: [UInt8], iv: [UInt8], aad: String, _ ct: [UInt8]) -> [UInt8]? {
        guard key.count == 32, iv.count == 12, ct.count >= 16, let nonce = try? AES.GCM.Nonce(data: iv),
              let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ct.dropLast(16), tag: ct.suffix(16)),
              let pt = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Data(aad.utf8))
        else { return nil }
        return Array(pt)
    }

    // MARK: - the blob plaintext: raw private scalars, checked before use

    /// identity-design §6b: which kx placement is ruled (unruled while it isn't)
    enum KxMode: String { case unruled, A, B, C
        var blobCarriesKx: Bool { self == .A || self == .C }
    }
    static let kxMode: KxMode = .unruled

    struct BlobKeys: Equatable {
        let account: [UInt8]
        let kx: [UInt8]?
    }

    static func packScalars(_ keys: BlobKeys, mode: KxMode = kxMode) -> [UInt8]? {
        guard keys.account.count == 32 else { return nil }
        if !mode.blobCarriesKx { return keys.kx == nil ? keys.account : nil }
        guard let kx = keys.kx, kx.count == 32 else { return nil }
        return keys.account + kx
    }

    /// Read a blob's plaintext and CHECK it before anything uses it: the right
    /// length for the mode, every scalar in 1..n−1, and each one's public half
    /// equal to the key in the directory-signed binding, so a swapped blob fails
    /// closed. These are recovered PRIVATE scalars: the range check doesn't branch
    /// on their bytes, and the match goes through CryptoKit, never arithmetic here.
    static func unpackScalars(_ pt: [UInt8], accountPub: String, kxPub: String? = nil,
                              mode: KxMode = kxMode) -> Verdict<BlobKeys> {
        let withKx = mode.blobCarriesKx
        guard pt.count == (withKx ? 64 : 32) else { return .no("length") }
        let scalars = withKx ? [Array(pt[0..<32]), Array(pt[32...])] : [pt]
        let pubs = withKx ? [accountPub, kxPub] : [accountPub]
        for (d, pub) in zip(scalars, pubs) {
            guard scalarInRange(d) else { return .no("scalar-range") }
            guard let pub, scalarMatches(d, pub) else { return .no("key-mismatch") }
        }
        return .ok(BlobKeys(account: scalars[0], kx: withKx ? scalars[1] : nil))
    }

    private static let nBytes: [UInt8] = [
        0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
    ]

    /// 1 ≤ d < n for a 32-byte big-endian scalar, without branching on its bytes.
    static func scalarInRange(_ d: [UInt8]) -> Bool {
        guard d.count == 32 else { return false }
        var nonzero: UInt32 = 0, lt: UInt32 = 0, gt: UInt32 = 0
        for i in 0..<32 {
            let a = UInt32(d[i]), b = UInt32(nBytes[i]), open = 1 ^ (lt | gt)
            lt |= open & ((a &- b) >> 31)
            gt |= open & ((b &- a) >> 31)
            nonzero |= a
        }
        return (lt & ((nonzero | (0 &- nonzero)) >> 31)) == 1
    }

    /// Does d belong to the raw public key `pub`? CryptoKit computes d·G (and
    /// itself refuses 0 and ≥ n); comparing public points reveals nothing secret.
    private static func scalarMatches(_ d: [UInt8], _ pub: String) -> Bool {
        guard let raw = b64uDec(pub), raw.count == 65, raw[0] == 4,
              let k = try? P256.Signing.PrivateKey(rawRepresentation: d) else { return false }
        return Array(k.publicKey.x963Representation) == raw
    }

    // MARK: - the PRF blob, one per passkey

    struct PrfBlob: Equatable {
        let v: Int
        let cred: String
        let salt: String
        let iv: String
        let ct: String
    }

    private static func credTag(_ credentialId: [UInt8]) -> String { b64uEnc(Array(SHA256.hash(data: credentialId))) }

    /// aad = "bento/id/acct-wrap/v1." ‖ b64u(sha256(credentialId))
    static func sealPrfBlob(prfOutput: [UInt8], credentialId: [UInt8], salt: [UInt8], iv: [UInt8],
                            keys: BlobKeys, mode: KxMode = kxMode) -> PrfBlob? {
        let cred = credTag(credentialId)
        guard let kek = prfKek(prfOutput: prfOutput, salt: salt), let pt = packScalars(keys, mode: mode),
              let ct = gcmSeal(key: kek, iv: iv, aad: "bento/id/acct-wrap/v1.\(cred)", pt) else { return nil }
        return PrfBlob(v: 1, cred: cred, salt: b64uEnc(salt), iv: b64uEnc(iv), ct: b64uEnc(ct))
    }

    static func openPrfBlob(_ blob: PrfBlob, prfOutput: [UInt8], credentialId: [UInt8],
                            accountPub: String, kxPub: String? = nil, mode: KxMode = kxMode) -> Verdict<BlobKeys> {
        guard blob.v == 1 else { return .no("version") }
        let cred = credTag(credentialId)
        guard blob.cred == cred else { return .no("credential") }
        guard let salt = b64uDec(blob.salt), salt.count == 32, let iv = b64uDec(blob.iv), iv.count == 12,
              let ct = b64uDec(blob.ct) else { return .no("grammar") }
        guard prfOutput.count == 32, let kek = prfKek(prfOutput: prfOutput, salt: salt),
              let pt = gcmOpen(key: kek, iv: iv, aad: "bento/id/acct-wrap/v1.\(cred)", ct) else { return .no("decrypt") }
        return unpackScalars(pt, accountPub: accountPub, kxPub: kxPub, mode: mode)
    }

    // MARK: - the recovery-code blob (inner layer; the directory adds its pepper)

    static func accountTag(_ accountPub: String) -> String { b64uEnc(Array(SHA256.hash(data: Data(accountPub.utf8)))) }

    /// aad = "bento/id/rc-wrap/v1." ‖ b64u(sha256(accountPub))
    static func sealRecoveryInner(wrapKey: [UInt8], iv: [UInt8], accountPub: String, keys: BlobKeys,
                                  mode: KxMode = kxMode) -> [UInt8]? {
        guard let pt = packScalars(keys, mode: mode) else { return nil }
        return gcmSeal(key: wrapKey, iv: iv, aad: "bento/id/rc-wrap/v1.\(accountTag(accountPub))", pt)
    }

    static func openRecoveryInner(_ ct: [UInt8], wrapKey: [UInt8], iv: [UInt8], accountPub: String,
                                  kxPub: String? = nil, mode: KxMode = kxMode) -> Verdict<BlobKeys> {
        guard let pt = gcmOpen(key: wrapKey, iv: iv, aad: "bento/id/rc-wrap/v1.\(accountTag(accountPub))", ct)
        else { return .no("decrypt") }
        return unpackScalars(pt, accountPub: accountPub, kxPub: kxPub, mode: mode)
    }

    // MARK: - canonical base64url (kernel statements.ts)

    static func b64uEnc(_ b: [UInt8]) -> String {
        Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// strict: the alphabet only, no padding, and it must re-encode identically
    static func b64uDec(_ s: String) -> [UInt8]? {
        guard s.count % 4 != 1, s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        else { return nil }
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        guard let d = Data(base64Encoded: t) else { return nil }
        let b = Array(d)
        return b64uEnc(b) == s ? b : nil
    }
}
