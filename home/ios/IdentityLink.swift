// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation

/// bento/id device linking, link v1, in Swift: the same bytes as
/// kernel/src/link.ts. The conformance contract is the `link` section of
/// kernel/fixtures/identity-v1.json; scripts/test-home-id-link.mjs runs this
/// file against every row of it.
///
/// Pure functions only: no network, no Keychain, no clock but the one passed in.
/// The flow that uses them is LinkFlow.swift.
///
/// Rules a host must keep that are not bytes (kernel/fixtures/README.md):
/// - Verifiers answer every row and never trap: a malformed input is a refusal.
/// - A platform token the host does not know is shown as unknown, never as verified.
/// - After linking, N shows the label H wrote into N's dev., not the one N offered.
/// - Each direction key seals exactly ONE message (n2h: 2, h2n: 3), chosen here
///   from the message number, never by the caller. A retry is a new slot.
enum IdentityLink {
    typealias S = IdentityStatements
    typealias R = IdentityRecovery
    typealias Verdict<T> = S.Verdict<T>

    // MARK: the link code and the slot

    struct Slot: Equatable {
        let id: String
        let tok: String
        let salt: [UInt8]
    }

    /// id, tok, salt = HKDF-SHA-256(code bytes, empty salt, "bento/id/link/v1/{id,tok,salt}").
    static func slot(code: [UInt8]) -> Slot? {
        guard code.count == R.codeBytes else { return nil }
        return Slot(id: R.b64uEnc(R.hkdf(code, info: "bento/id/link/v1/id")),
                    tok: R.b64uEnc(R.hkdf(code, info: "bento/id/link/v1/tok")),
                    salt: R.hkdf(code, info: "bento/id/link/v1/salt"))
    }

    /// What the directory stores for a slot's token: b64u(SHA-256(the token's 32 bytes)).
    static func tokHash(_ tok: String) -> String? {
        guard let b = S.b64uDec(tok), b.count == 32 else { return nil }
        return S.b64uEnc(Data(SHA256.hash(data: b)))
    }

    // MARK: strict text

    private static let maxLine = 4096
    private static func printable(_ t: String) -> Bool {
        let b = Array(t.utf8)
        return !b.isEmpty && b.count <= maxLine && b.allSatisfy { $0 >= 0x21 && $0 <= 0x7E }
    }
    private static func fields(_ t: String, _ prefix: String, _ count: Int) -> [String]? {
        guard printable(t) else { return nil }
        let p = t.components(separatedBy: ".")
        return p.count == count && p[0] == prefix ? p : nil
    }
    private static func isSig(_ f: String) -> Bool { S.b64uDec(f)?.count == 64 }

    // MARK: msg0, msg1 — the ephemerals, in clear on the slot

    enum Role: String { case H, N }

    static func buildMsg0(_ eD: String, _ role: Role) -> String { "lnk0.\(eD).\(role.rawValue)" }
    static func buildMsg1(_ eS: String) -> String { "lnk1.\(eS)" }

    static func parseMsg0(_ t: String) -> Verdict<(eD: String, role: Role)> {
        guard let p = fields(t, "lnk0", 3), let role = Role(rawValue: p[2]) else { return .no("grammar") }
        guard S.isKxKey(p[1]) else { return .no("key") }
        return .yes((p[1], role))
    }

    static func parseMsg1(_ t: String) -> Verdict<String> {
        guard let p = fields(t, "lnk1", 2) else { return .no("grammar") }
        guard S.isKxKey(p[1]) else { return .no("key") }
        return .yes(p[1])
    }

    /// The scanner's check of the role the displayer claims (security §39.1 cond. 2):
    /// exactly one side holds the account. Anything else aborts.
    static func scannerMayProceed(roleD: Role, scannerHoldsAccount: Bool) -> Bool {
        roleD == .H ? !scannerHoldsAccount : scannerHoldsAccount
    }

    // MARK: the transcript, the keys and the SAS

    /// nil if the two ephemerals are the same point (a reflected msg0).
    static func transcript(id: String, eD: String, eS: String, roleD: Role) -> String? {
        eD == eS ? nil : S.sha256b64u("lnkt.v1.\(id).\(eD).\(eS).\(roleD.rawValue)")
    }

    struct Keys: Equatable {
        let h2n: [UInt8]
        let n2h: [UInt8]
        let sasKey: [UInt8]
        var sas: String { IdentityLink.sasDigits(sasKey) }
    }

    static func keys(z: [UInt8], salt: [UInt8], t: String) -> Keys? {
        guard z.count == 32, salt.count == 32 else { return nil }
        return Keys(h2n: R.hkdf(z, salt: salt, info: "bento/id/link/v1/h2n.\(t)"),
                    n2h: R.hkdf(z, salt: salt, info: "bento/id/link/v1/n2h.\(t)"),
                    sasKey: R.hkdf(z, salt: salt, info: "bento/id/link/v1/sas.\(t)"))
    }

    /// Z = ECDH(own ephemeral, the other side's point), the x-coordinate; nil for a bad point.
    static func sharedSecret(own: P256.KeyAgreement.PrivateKey, otherPub: String) -> [UInt8]? {
        guard let raw = S.b64uDec(otherPub), raw.count == 65, raw[0] == 4,
              let other = try? P256.KeyAgreement.PublicKey(x963Representation: raw),
              let z = try? own.sharedSecretFromKeyAgreement(with: other) else { return nil }
        return z.withUnsafeBytes { Array($0) }
    }

    static func keys(own: P256.KeyAgreement.PrivateKey, otherPub: String, salt: [UInt8], t: String) -> Keys? {
        guard let z = sharedSecret(own: own, otherPub: otherPub) else { return nil }
        return keys(z: z, salt: salt, t: t)
    }

    /// First 4 bytes big-endian, mod 1,000,000, zero-padded to 6 digits.
    static func sasDigits(_ sasKey: [UInt8]) -> String {
        guard sasKey.count >= 4 else { return "" }
        let v = (UInt32(sasKey[0]) << 24) | (UInt32(sasKey[1]) << 16) | (UInt32(sasKey[2]) << 8) | UInt32(sasKey[3])
        let d = String(v % 1_000_000)
        return String(repeating: "0", count: 6 - d.count) + d
    }

    /// Does what the person typed equal the SAS? Spaces and hyphens are ignored; nothing
    /// else is, and full-width digits are not digits.
    static func sasMatches(typed: String, sas: String) -> Bool {
        let s = typed.unicodeScalars.filter { !jsSpace.contains($0.value) && $0.value != 0x2D }
        let isDigits = { (u: [Unicode.Scalar]) in u.count == 6 && u.allSatisfy { $0.value >= 0x30 && $0.value <= 0x39 } }
        let a = Array(s), b = Array(sas.unicodeScalars)
        return isDigits(a) && isDigits(b) && a == b
    }
    // JavaScript's \s, which the reference strips (see IdentityRecovery.jsSpace)
    private static let jsSpace: Set<UInt32> = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680,
        0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
        0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]

    // MARK: AES-GCM — AAD = the transcript and the message number

    enum MsgNo: Int { case offer = 2, final = 3 }
    static func aad(_ t: String, _ n: MsgNo) -> String { "lnka.v1.\(t).\(n.rawValue)" }
    private static func key(_ k: Keys, _ n: MsgNo) -> [UInt8] { n == .offer ? k.n2h : k.h2n }

    /// wire = b64u(iv (12) ‖ ciphertext ‖ tag (16)). The iv is fresh random bytes in an
    /// agent. Each key seals one message in its life: LinkFlow enforces that.
    static func seal(_ k: Keys, _ n: MsgNo, t: String, iv: [UInt8], _ pt: [UInt8]) -> String? {
        guard let ct = R.gcmSeal(key: key(k, n), iv: iv, aad: aad(t, n), pt) else { return nil }
        return R.b64uEnc(iv + ct)
    }

    static func open(_ k: Keys, _ n: MsgNo, t: String, wire: String) -> [UInt8]? {
        guard let b = R.b64uDec(wire), b.count >= 12 + 16 else { return nil }
        return R.gcmOpen(key: key(k, n), iv: Array(b[0..<12]), aad: aad(t, n), Array(b[12...]))
    }

    // MARK: msg2 — N's offer

    struct Offer: Equatable {
        let devicePub: String
        let consentPub: String?
        let kx: String
        let label: String?
        let platform: String
    }

    /// What N's devicePub and consentPub each sign to prove it holds them.
    static func popText(_ t: String) -> String { "lnkp.v1.\(t)" }

    static func buildOffer(_ o: Offer, popDevice: String, popConsent: String?) -> String {
        ["lnk2", o.devicePub, o.consentPub ?? "", o.kx, o.label.map { S.b64uEnc(Data($0.utf8)) } ?? "",
         o.platform, popDevice, popConsent ?? ""].joined(separator: ".")
    }

    private static func platformOk(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard (1...32).contains(b.count), b[0] >= 0x61, b[0] <= 0x7A else { return false }
        return b.dropFirst().allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D }
    }

    static func verifyOffer(_ text: String, t: String) -> Verdict<Offer> {
        guard let p = fields(text, "lnk2", 8) else { return .no("grammar") }
        let devicePub = p[1], consentF = p[2], kxF = p[3], labelF = p[4], platform = p[5], popDevice = p[6], popConsentF = p[7]
        guard platformOk(platform), isSig(popDevice), popConsentF.isEmpty || isSig(popConsentF) else { return .no("grammar") }
        guard S.isSigningKey(devicePub) else { return .no("key") }
        var consentPub: String?
        if !consentF.isEmpty {
            guard consentF != devicePub, S.isSigningKey(consentF) else { return .no("consent-key") }
            consentPub = consentF
        }
        guard !kxF.isEmpty, kxF != devicePub, kxF != consentF, S.isKxKey(kxF) else { return .no("kx") }
        var label: String?
        if !labelF.isEmpty { guard let l = S.displayText(labelF) else { return .no("label") }; label = l }
        if (consentPub == nil) != popConsentF.isEmpty { return .no("pop-consent") }
        let pop = popText(t)
        guard S.verifyStatementSig(devicePub, popDevice, pop) else { return .no("pop-device") }
        if let c = consentPub, !S.verifyStatementSig(c, popConsentF, pop) { return .no("pop-consent") }
        return .yes(Offer(devicePub: devicePub, consentPub: consentPub, kx: kxF, label: label, platform: platform))
    }

    static func openOffer(_ k: Keys, t: String, wire: String) -> Verdict<Offer> {
        guard let pt = open(k, .offer, t: t, wire: wire) else { return .no("decrypt") }
        guard let text = String(data: Data(pt), encoding: .utf8) else { return .no("grammar") }
        return verifyOffer(text, t: t)
    }

    // MARK: the platform field is context, never proof

    struct PlatformShown: Equatable {
        /// PLACEHOLDER wording (the maintainer owns the strings)
        let name: String
        /// true only for a token in the fixed map. Never "verified": the token is
        /// N's own claim, so this says only that the host recognises the word.
        let known: Bool
    }
    static let knownPlatforms: [String: String] = [
        "ios": "iPhone or iPad", "ipados": "iPad", "macos": "Mac", "android": "Android phone or tablet",
        "windows": "Windows PC", "linux": "Linux computer", "web": "Web browser", "extension": "Browser extension",
    ]
    static func showPlatform(_ token: String) -> PlatformShown {
        knownPlatforms[token].map { PlatformShown(name: $0, known: true) } ?? PlatformShown(name: "Unknown device type", known: false)
    }

    // MARK: msg3 — H's completion, checked by the directory and then by N

    struct Final: Equatable {
        let hDev: String, hDevSig: String
        let cns: String, cnsSig: String
        let nDev: String, nDevSig: String
        let sealed: String
    }
    private static let sealedLen = 12 + R.blobLen + 16

    static func buildFinal(_ f: Final) -> String {
        ["lnk3", f.hDev, f.hDevSig, f.cns, f.cnsSig, f.nDev, f.nDevSig, f.sealed].joined(separator: "\n")
    }

    static func parseFinal(_ text: String) -> Final? {
        guard text.utf8.count <= 8 * (maxLine + 1) else { return nil }
        let l = text.components(separatedBy: "\n")
        guard l.count == 8, l[0] == "lnk3", l.allSatisfy(printable) else { return nil }
        guard isSig(l[2]), isSig(l[4]), isSig(l[6]), S.b64uDec(l[7])?.count == sealedLen else { return nil }
        return Final(hDev: l[1], hDevSig: l[2], cns: l[3], cnsSig: l[4], nDev: l[5], nDevSig: l[6], sealed: l[7])
    }

    /// The DIRECTORY's check before it releases msg3 to N. Hosts do not run a directory;
    /// this is here so a rig can hold the Swift to the same rows, and so an agent can
    /// check its own msg3 before sending it. `spend` is called once msg3 and its cns.
    /// parse, before anything else.
    static func verifyRelease(_ text: String, bindText: String, state: String, challenge: String, now: Int,
                              spend: (String) -> Bool) -> Verdict<(sealed: String, device: S.DeviceCert)> {
        guard let f = parseFinal(text), fields(f.cns, "cns", 6) != nil else { return .no("grammar") }
        if !spend(challenge) { return .no("replay") }
        if state != "active" { return .no("state") }
        guard let bind = S.parseBind(bindText).value else { return .no("bind") }
        let h = S.verifyDev(f.hDev, f.hDevSig, now: now)
        guard let hd = h.value else { return .no("h-dev-\(h.reason ?? "?")") }
        if hd.accountPub != bind.accountPub { return .no("h-account") }
        guard let hConsent = hd.consentPub else { return .no("h-no-consent") }
        let c = S.verifyConsent(f.cns, f.cnsSig, consentPub: hConsent, rp: "bento", audience: "dir", challenge: challenge,
                                payloadText: f.nDev, docId: nil, now: now, spend: { _ in true })
        guard let cv = c.value else { return .no("cns-\(c.reason ?? "?")") }
        if cv.purpose != "link" { return .no("cns-purpose") }
        let n = S.verifyDev(f.nDev, f.nDevSig, now: now)
        guard let nd = n.value else { return .no("n-dev-\(n.reason ?? "?")") }
        if nd.accountPub != bind.accountPub { return .no("n-account") }
        if nd.devicePub == hd.devicePub { return .no("n-device-is-h") }
        return .yes((f.sealed, nd))
    }

    struct Opened {
        let keys: R.BlobKeys
        let device: S.DeviceCert
        let dev: String
        let devSig: String
    }

    /// N's check of msg3 before it stores anything (security §39.1 cond. 4). `offer` is
    /// exactly what N sent; `binding` the public halves of the binding the directory
    /// served under a PINNED key.
    static func openFinal(_ text: String, keys: Keys, t: String, offer: Offer,
                          accountPub: String, kxPub: String, now: Int) -> Verdict<Opened> {
        guard let f = parseFinal(text) else { return .no("grammar") }
        let n = S.verifyDev(f.nDev, f.nDevSig, now: now)
        guard let nd = n.value else { return .no("dev-\(n.reason ?? "?")") }
        if nd.accountPub != accountPub { return .no("account") }
        if nd.devicePub != offer.devicePub { return .no("device-mismatch") }
        if nd.consentPub != offer.consentPub { return .no("consent-mismatch") }
        if nd.kx != offer.kx { return .no("kx-mismatch") }
        guard let pt = open(keys, .final, t: t, wire: f.sealed) else { return .no("decrypt") }
        switch R.unpackScalars(pt, accountPub: accountPub, kxPub: kxPub) {
        case .ok(let k): return .yes(Opened(keys: k, device: nd, dev: f.nDev, devSig: f.nDevSig))
        case .no(let r): return .no(r)
        }
    }
}
