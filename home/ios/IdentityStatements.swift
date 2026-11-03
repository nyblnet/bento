// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation

/// bento/id's signed statements, in Swift: the same bytes as
/// kernel/src/statements.ts and kernel/src/address.ts, the reference every host
/// must match. The conformance contract is kernel/fixtures/identity-v1.json;
/// scripts/test-home-id-statements.mjs runs this file against every row of it.
///
/// The family rules, briefly:
/// - A statement is dot-joined printable ASCII, signed over its exact bytes.
/// - A field is a closed token or base64url free text.
/// - Parsing keeps empty fields and requires the exact field count.
/// - Keys are raw 65-byte P-256 points.
/// - Signatures are raw r‖s, low-S.
/// - Times are epoch milliseconds.
///
/// The check ORDER follows the reference too, so a refusal gives the same
/// reason everywhere, not just the same verdict.
enum IdentityStatements {
    struct Verdict<T> {
        let value: T?
        let reason: String?
        var ok: Bool { value != nil }
        static func yes(_ v: T) -> Verdict { Verdict(value: v, reason: nil) }
        static func no(_ r: String) -> Verdict { Verdict(value: nil, reason: r) }
    }

    // MARK: strict base64url

    static func b64uEnc(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// Canonical base64url only: the alphabet, no padding, and it must re-encode
    /// to exactly the same string.
    static func b64uDec(_ s: String) -> Data? {
        guard s.utf8.allSatisfy({ isB64u($0) }), s.utf8.count % 4 != 1 else { return nil }
        let pad = String(repeating: "=", count: (4 - s.utf8.count % 4) % 4)
        guard let d = Data(base64Encoded: s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + pad),
              b64uEnc(d) == s else { return nil }
        return d
    }

    private static func isB64u(_ c: UInt8) -> Bool {
        (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F
    }

    private static func freeText(_ f: String) -> String? {
        guard let b = b64uDec(f), let t = String(data: b, encoding: .utf8), b64uEnc(Data(t.utf8)) == f else { return nil }
        return t
    }

    /// Display text a person sees (a name, a device label), as the kernel
    /// defines it:
    /// - at most 64 code points, and in NFC
    /// - nothing in the frozen `IdentityDisplayTable` (Unicode 17.0, not the
    ///   platform's categories, so every host refuses the same characters)
    /// - ZWNJ/ZWJ only mid-text
    static func displayText(_ f: String) -> String? {
        guard let t = freeText(f), !t.isEmpty else { return nil }
        let cps = Array(t.unicodeScalars)
        guard cps.count <= 64 else { return nil }
        // NFC needs Unicode 17.0 data (fixtures/README). Where the platform's is
        // older, refuse rather than normalise with the wrong tables.
        guard platformUnicodeIs17 else { return nil }
        // compare SCALARS: String == is canonical equivalence, which would call
        // a decomposed é equal to the composed one
        guard Array(t.precomposedStringWithCanonicalMapping.unicodeScalars) == cps else { return nil }
        guard !cps.contains(where: { IdentityDisplayTable.forbidden($0.value) }) else { return nil }
        let zw: Set<UInt32> = [0x200C, 0x200D]
        guard !zw.contains(cps[0].value), !zw.contains(cps[cps.count - 1].value) else { return nil }
        return t
    }

    /// Whether the platform's normaliser (ICU) has Unicode 17.0 or later data.
    static let platformUnicodeIs17: Bool = {
        typealias GetVersion = @convention(c) (UnsafeMutablePointer<UInt8>) -> Void
        guard let h = dlopen("/usr/lib/libicucore.dylib", RTLD_NOW), let sym = dlsym(h, "u_getUnicodeVersion") else { return false }
        var v = [UInt8](repeating: 0, count: 4)
        unsafeBitCast(sym, to: GetVersion.self)(&v)
        return v[0] >= 17
    }()

    static func sha256b64u(_ text: String) -> String { b64uEnc(Data(SHA256.hash(data: Data(text.utf8)))) }

    // MARK: keys and signatures

    private static let n: [UInt8] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84, 0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63, 0x25, 0x51]
    private static let halfN: [UInt8] = [
        0x7F, 0xFF, 0xFF, 0xFF, 0x80, 0x00, 0x00, 0x00, 0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xDE, 0x73, 0x7D, 0x56, 0xD3, 0x8B, 0xCF, 0x42, 0x79, 0xDC, 0xE5, 0x61, 0x7E, 0x31, 0x92, 0xA8]

    /// big-endian compare of equal-length byte strings
    private static func cmp(_ a: [UInt8], _ b: [UInt8]) -> Int {
        for i in 0..<a.count where a[i] != b[i] { return a[i] < b[i] ? -1 : 1 }
        return 0
    }

    /// A raw r‖s signature in range, with s in the lower half.
    private static func sigInRange(_ sig: Data) -> Bool {
        guard sig.count == 64 else { return false }
        let r = Array(sig.prefix(32)), s = Array(sig.suffix(32)), zero = [UInt8](repeating: 0, count: 32)
        return cmp(r, zero) > 0 && cmp(r, n) < 0 && cmp(s, zero) > 0 && cmp(s, halfN) <= 0
    }

    /// The low-S form (what every signer must emit). Same as IdentityKeys.lowS.
    static func lowS(_ sig: Data) -> Data { IdentityKeys.lowS(sig) }

    static func signingKey(_ b64: String) -> P256.Signing.PublicKey? {
        guard let raw = b64uDec(b64), raw.count == 65, raw.first == 0x04 else { return nil }
        return try? P256.Signing.PublicKey(x963Representation: raw)
    }
    static func isSigningKey(_ b64: String) -> Bool { signingKey(b64) != nil }
    static func isKxKey(_ b64: String) -> Bool {
        guard let raw = b64uDec(b64), raw.count == 65, raw.first == 0x04 else { return false }
        return (try? P256.KeyAgreement.PublicKey(x963Representation: raw)) != nil
    }

    static func verifyStatementSig(_ pubB64: String, _ sigB64: String, _ text: String) -> Bool {
        guard let sig = b64uDec(sigB64), sigInRange(sig), let key = signingKey(pubB64),
              let s = try? P256.Signing.ECDSASignature(rawRepresentation: sig) else { return false }
        return key.isValidSignature(s, for: Data(text.utf8))
    }

    // MARK: strict parsing

    private static let maxStatement = 4096

    /// Printable ASCII only, exact prefix and field count, empty fields kept.
    private static func fields(_ text: String, _ prefix: String, _ count: Int) -> [String]? {
        let bytes = Array(text.utf8)
        guard !bytes.isEmpty, bytes.count <= maxStatement, bytes.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else { return nil }
        let parts = text.components(separatedBy: ".")
        return parts.count == count && parts[0] == prefix ? parts : nil
    }

    private static func int(_ f: String) -> Int? {
        let b = Array(f.utf8)
        guard !b.isEmpty, b.count <= 16, b.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), !(b.count > 1 && b[0] == 0x30),
              let v = Int(f), v <= 9_007_199_254_740_991 else { return nil }
        return v
    }
    private static func ms(_ f: String) -> Int? { int(f).flatMap { $0 > 0 ? $0 : nil } }
    private static func isHash(_ f: String) -> Bool { b64uDec(f)?.count == 32 }

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }
    private static func isKid(_ s: String) -> Bool { matches(s, "^[a-z0-9][a-z0-9-]{0,62}$") }
    private static func isRp(_ s: String) -> Bool { matches(s, "^(bento|vault-[a-z0-9][a-z0-9-]{0,62})$") }
    static func isDocId(_ s: String) -> Bool { matches(s, "^[A-Za-z0-9_-]{1,128}$") }
    private static func isCode(_ s: String) -> Bool { matches(s, "^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$") }
    private static func isAudience(_ s: String) -> Bool { matches(s, "^(dir|room:w[A-Za-z0-9_-]{43})$") }

    static let skewMs = 5 * 60_000
    private static let day = 86_400_000
    static let certMaxMs = Int((13 * 30.5 + 1) * Double(day))

    private static func lifetime(_ created: Int, _ expires: Int, _ now: Int) -> String? {
        if expires <= created { return "lifetime" }
        if expires - created > certMaxMs { return "lifetime" }
        if created > now + skewMs { return "not-yet-valid" }
        if now >= expires { return "expired" }
        return nil
    }

    // MARK: kx placement: mode C (ruled 2026-11-02, identity-design §6b)

    /// The one kx placement: a per-device kx in every dev. AND a recovery kx in
    /// every bind., both REQUIRED. There is no other mode and no lenient path.
    static let kxMode = "C"
    /// A kx slot: required, a valid ECDH point, never equal to any signing key in
    /// the same certificate. nil = refuse.
    private static func kxSlot(_ f: String, others: [String]) -> String? {
        if f.isEmpty || !isKxKey(f) || others.contains(f) { return nil }
        return f
    }

    // MARK: dev. — the device certificate

    struct DeviceCert: Equatable {
        let devicePub: String
        let consentPub: String?
        let accountPub: String
        let kx: String
        let label: String?
        let created: Int
        let expires: Int
    }

    static func buildDev(_ c: DeviceCert) -> String {
        ["dev", c.devicePub, c.consentPub ?? "", c.accountPub, c.kx,
         c.label.map { b64uEnc(Data($0.utf8)) } ?? "", String(c.created), String(c.expires)].joined(separator: ".")
    }

    static func verifyDev(_ text: String, _ sig: String, now: Int) -> Verdict<DeviceCert> {
        guard let p = fields(text, "dev", 8) else { return .no("grammar") }
        let devicePub = p[1], consentF = p[2], accountPub = p[3], kxF = p[4], labelF = p[5]
        guard isSigningKey(devicePub), isSigningKey(accountPub) else { return .no("key") }
        if devicePub == accountPub { return .no("key") }
        var consentPub: String?
        if !consentF.isEmpty {
            guard isSigningKey(consentF), consentF != devicePub, consentF != accountPub else { return .no("consent-key") }
            consentPub = consentF
        }
        guard let kx = kxSlot(kxF, others: [devicePub, accountPub, consentF]) else { return .no("kx") }
        var label: String?
        if !labelF.isEmpty { guard let l = displayText(labelF) else { return .no("label") }; label = l }
        guard let created = ms(p[6]), let expires = ms(p[7]) else { return .no("grammar") }
        if let life = lifetime(created, expires, now) { return .no(life) }
        guard verifyStatementSig(accountPub, sig, text) else { return .no("signature") }
        return .yes(DeviceCert(devicePub: devicePub, consentPub: consentPub, accountPub: accountPub, kx: kx, label: label, created: created, expires: expires))
    }

    // MARK: bind. — the person certificate

    struct BindCert: Equatable {
        let address: String
        let accountPub: String
        let kx: String
        let name: String?
        let seq: Int
        let prev: String?
        let created: Int
        let expires: Int
    }

    static func buildBind(_ c: BindCert) -> String {
        ["bind", b64uEnc(Data(c.address.utf8)), c.accountPub, c.kx, c.name.map { b64uEnc(Data($0.utf8)) } ?? "",
         String(c.seq), c.prev ?? "", String(c.created), String(c.expires)].joined(separator: ".")
    }

    static func verifyBind(_ text: String, _ sig: String, now: Int) -> Verdict<BindCert> {
        guard let p = fields(text, "bind", 9) else { return .no("grammar") }
        guard let address = freeText(p[1]), isNormalAddress(address) else { return .no("address") }
        let accountPub = p[2]
        guard isSigningKey(accountPub) else { return .no("key") }
        guard let kx = kxSlot(p[3], others: [accountPub]) else { return .no("kx") }
        var name: String?
        if !p[4].isEmpty { guard let nm = displayText(p[4]) else { return .no("name") }; name = nm }
        guard let seq = int(p[5]), seq >= 1 else { return .no("seq") }
        let prevF = p[6]
        if (seq == 1) != prevF.isEmpty { return .no("prev") }
        if !prevF.isEmpty && !isHash(prevF) { return .no("prev") }
        guard let created = ms(p[7]), let expires = ms(p[8]) else { return .no("grammar") }
        if let life = lifetime(created, expires, now) { return .no(life) }
        guard verifyStatementSig(accountPub, sig, text) else { return .no("signature") }
        return .yes(BindCert(address: address, accountPub: accountPub, kx: kx, name: name, seq: seq,
                             prev: prevF.isEmpty ? nil : prevF, created: created, expires: expires))
    }

    // MARK: att. — the directory's attestation

    struct Attestation: Equatable {
        let bindHash: String
        let verifiedAt: Int
        let issuedAt: Int
        let kid: String
        let state: String
    }

    static func buildAtt(_ a: Attestation) -> String {
        ["att", a.bindHash, String(a.verifiedAt), String(a.issuedAt), a.kid, a.state].joined(separator: ".")
    }

    static func verifyAtt(_ text: String, _ sig: String, directoryKeys: [String: String], bindText: String,
                          now: Int, maxAgeMs: Int) -> Verdict<Attestation> {
        guard let p = fields(text, "att", 6) else { return .no("grammar") }
        let bindHash = p[1], kid = p[4], state = p[5]
        guard isHash(bindHash), isKid(kid) else { return .no("grammar") }
        guard ["active", "pending", "frozen"].contains(state) else { return .no("grammar") }
        guard let verifiedAt = ms(p[2]), let issuedAt = ms(p[3]), verifiedAt <= issuedAt else { return .no("grammar") }
        if issuedAt > now + skewMs { return .no("not-yet-valid") }
        if now - issuedAt > maxAgeMs { return .no("stale") }
        if bindHash != sha256b64u(bindText) { return .no("bind-mismatch") }
        guard let dk = directoryKeys[kid] else { return .no("unknown-kid") }
        guard verifyStatementSig(dk, sig, text) else { return .no("signature") }
        return .yes(Attestation(bindHash: bindHash, verifiedAt: verifiedAt, issuedAt: issuedAt, kid: kid, state: state))
    }

    // MARK: tomb. — the directory's deletion record

    struct Tombstone: Equatable {
        let lastBindHash: String?
        let seq: Int
        let deletedAt: Int
        let by: String
        let kid: String
    }

    static func buildTomb(_ t: Tombstone) -> String {
        ["tomb", t.lastBindHash ?? "", String(t.seq), String(t.deletedAt), t.by, t.kid].joined(separator: ".")
    }

    static func verifyTomb(_ text: String, _ sig: String, directoryKeys: [String: String], now: Int) -> Verdict<Tombstone> {
        guard let p = fields(text, "tomb", 6) else { return .no("grammar") }
        let hashF = p[1], by = p[4], kid = p[5]
        if !hashF.isEmpty && !isHash(hashF) { return .no("grammar") }
        guard let seq = int(p[2]), seq >= 1, let deletedAt = ms(p[3]) else { return .no("grammar") }
        guard ["holder", "mailbox", "operator"].contains(by) else { return .no("grammar") }
        guard isKid(kid) else { return .no("grammar") }
        if deletedAt > now + skewMs { return .no("not-yet-valid") }
        guard let dk = directoryKeys[kid] else { return .no("unknown-kid") }
        guard verifyStatementSig(dk, sig, text) else { return .no("signature") }
        return .yes(Tombstone(lastBindHash: hashF.isEmpty ? nil : hashF, seq: seq, deletedAt: deletedAt, by: by, kid: kid))
    }

    // MARK: del. — a holder's delete request

    static let deleteWindowMs = 5 * 60_000

    static func buildDel(address: String, ts: Int) -> String { ["del", b64uEnc(Data(address.utf8)), String(ts)].joined(separator: ".") }

    static func verifyDel(_ text: String, _ sig: String, accountPub: String, now: Int) -> Verdict<(address: String, ts: Int)> {
        guard let p = fields(text, "del", 3) else { return .no("grammar") }
        guard let address = freeText(p[1]), isNormalAddress(address) else { return .no("address") }
        guard let ts = ms(p[2]) else { return .no("grammar") }
        if abs(now - ts) > deleteWindowMs { return .no("expired") }
        guard verifyStatementSig(accountPub, sig, text) else { return .no("signature") }
        return .yes((address, ts))
    }

    // MARK: cmp. — the email-code completion

    static func buildCmp(bindHash: String, code: String) -> String { ["cmp", bindHash, code].joined(separator: ".") }

    static func verifyCmp(_ text: String, _ sig: String, accountPub: String, bindText: String) -> Verdict<(bindHash: String, code: String)> {
        guard let p = fields(text, "cmp", 3) else { return .no("grammar") }
        let bindHash = p[1], code = p[2]
        guard isHash(bindHash), isCode(code) else { return .no("grammar") }
        if bindHash != sha256b64u(bindText) { return .no("bind-mismatch") }
        guard verifyStatementSig(accountPub, sig, text) else { return .no("signature") }
        return .yes((bindHash, code))
    }

    // MARK: cns. — host-stamped consent

    /// The closed set of consent purposes, and the statement family each authorises.
    static let consentFamily: [String: String] = ["invite": "inv.", "revoke": "rev.", "link": "dev.", "rotate": "bind.", "unbind": "del."]
    private static let reservedPurposes: Set<String> = ["grant", "role"]
    private static let docScoped: Set<String> = ["invite", "revoke"]
    static let consentMaxTtlMs = 5 * 60_000

    /// The channel binding (security §24): who verifies, the single-use challenge
    /// they issued, and the exact statement being authorised.
    static func consentTranscript(audience: String, challenge: String, payloadText: String) -> String? {
        guard isAudience(audience), let c = b64uDec(challenge), c.count >= 16, c.count <= 64 else { return nil }
        return sha256b64u("cnst.v1.\(audience).\(challenge).\(sha256b64u(payloadText))")
    }

    struct Consent: Equatable {
        let rp: String
        let purpose: String
        let docId: String?
        let transcript: String
        let exp: Int
    }

    /// `cns.<rp>.<purpose>.<docId|empty>.<transcript>.<exp>`, every field host-stamped.
    static func buildConsent(_ c: Consent) -> String {
        ["cns", c.rp, c.purpose, c.docId ?? "", c.transcript, String(c.exp)].joined(separator: ".")
    }

    static func verifyConsent(_ text: String, _ sig: String, consentPub: String, rp: String, audience: String,
                              challenge: String, payloadText: String, docId: String?, now: Int,
                              spend: (String) -> Bool) -> Verdict<Consent> {
        guard let p = fields(text, "cns", 6) else { return .no("grammar") }
        if !spend(challenge) { return .no("replay") }
        let rpF = p[1], purposeF = p[2], docIdF = p[3], transcript = p[4]
        guard isRp(rpF), isHash(transcript) else { return .no("grammar") }
        if reservedPurposes.contains(purposeF) { return .no("reserved-purpose") }
        guard let family = consentFamily[purposeF] else { return .no("grammar") }
        guard let exp = ms(p[5]) else { return .no("grammar") }
        if rpF != rp { return .no("rp") }
        if !payloadText.hasPrefix(family) { return .no("payload-family") }
        if docScoped.contains(purposeF) {
            if !isDocId(docIdF) || docIdF != docId { return .no("docid") }
        } else if !docIdF.isEmpty || docId != nil { return .no("docid") }
        guard let expected = consentTranscript(audience: audience, challenge: challenge, payloadText: payloadText),
              transcript == expected else { return .no("transcript") }
        if now >= exp { return .no("expired") }
        if exp - now > consentMaxTtlMs { return .no("lifetime") }
        guard verifyStatementSig(consentPub, sig, text) else { return .no("signature") }
        return .yes(Consent(rp: rpF, purpose: purposeF, docId: docIdF.isEmpty ? nil : docIdF, transcript: transcript, exp: exp))
    }

    /// The light tier's WebAuthn challenge for a consent: b64u(SHA-256(exact cns. bytes)).
    static func webauthnChallenge(for cnsText: String) -> String { sha256b64u(cnsText) }

    // MARK: routine signing — what each SignPurpose may sign

    private static func b64Len(_ f: String, min: Int, exact: Int? = nil) -> Bool {
        guard let b = b64uDec(f) else { return false }
        return exact.map { b.count == $0 } ?? (b.count >= min)
    }
    private static func isPubField(_ f: String) -> Bool { guard let b = b64uDec(f) else { return false }; return b.count == 65 && b.first == 0x04 }
    private static func iv(_ f: String) -> Bool { b64Len(f, min: 0, exact: 12) }
    private static func ct(_ f: String) -> Bool { b64Len(f, min: 16) }

    /// Does `payload` have the exact shape of the statement `purpose` names? The
    /// agent signs only a matching payload, so a prompt for one kind of action can
    /// never yield a signature on another.
    static func payloadMatchesPurpose(_ purpose: String, _ payload: String) -> Bool {
        guard payload.utf16.count <= maxStatement else { return false }
        let p = payload.components(separatedBy: ".")
        switch purpose {
        case "frame": return p.count == 2 && iv(p[0]) && ct(p[1])
        case "prove": return p.count == 3 && p[0] == "prove" && b64Len(p[1], min: 16) && matches(p[2], "^[rw][A-Za-z0-9_-]{1,64}$")
        case "delegate": return p.count == 2 && p[0] == "dlg" && isPubField(p[1])
        case "show":
            return (p.count == 1 && (p[0] == "live" || p[0] == "end")) ||
                (p.count == 4 && (p[0] == "nav" || p[0] == "black") && p[1] == "aud" && iv(p[2]) && ct(p[3]))
        case "invite": return p.count == 4 && p[0] == "inv" && isPubField(p[1]) &&
            ["writer", "commenter", "audience"].contains(p[2]) && matches(p[3], "^(0|[1-9][0-9]{0,15})$")
        case "revoke": return p.count == 2 && p[0] == "rev" && isPubField(p[1])
        default: return false
        }
    }

    // MARK: addresses (kernel/src/address.ts)

    enum Address: Equatable { case ok(String), refused(String) }

    static func normalizeAddress(_ input: String) -> Address {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.utf16.count > 254 { return .refused("too-long") }
        for c in s.utf16 where c < 0x21 || c > 0x7E { return .refused("not-ascii") }
        let chars = Array(s)
        guard let at = chars.firstIndex(of: "@"), at > 0, at == chars.lastIndex(of: "@"), at != chars.count - 1
        else { return .refused("at-sign") }
        let local = String(chars[..<at]).lowercased(), domain = String(chars[(at + 1)...]).lowercased()
        if local.utf16.count > 64 { return .refused("too-long") }
        for atom in local.components(separatedBy: ".") where !matches(atom, "^[a-z0-9!#$%&'*+/=?^_`{|}~-]+$") {
            return .refused("local-part")
        }
        let labels = domain.components(separatedBy: ".")
        if labels.count < 2 { return .refused("domain") }
        for l in labels {
            if l.isEmpty || l.utf16.count > 63 { return .refused("domain") }
            if !matches(l, "^[a-z0-9-]+$") { return .refused("domain") }
            if l.hasPrefix("-") || l.hasSuffix("-") { return .refused("domain") }
        }
        if matches(labels[labels.count - 1], "^[0-9]+$") { return .refused("numeric-tld") }
        return .ok("\(local)@\(domain)")
    }

    static func isNormalAddress(_ s: String) -> Bool { normalizeAddress(s) == .ok(s) }
}
