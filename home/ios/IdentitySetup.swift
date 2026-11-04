// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation

/// bento/connect setup on iOS (I1b): create the account key, prove the mailbox
/// by a code, set up the recovery code, and mint this device's `dev.`.
///
/// The decisions live here and the screens only render them, so a rig can drive
/// the whole flow against a local directory with no UI.
///
/// The rules this file keeps (identity-design, threat model §25, §39):
/// - **Two proofs, one flow.** `bind.` is signed by the account key, and the
///   mailed code is entered here and signed by that same key (`cmp.`). Neither
///   half alone binds anything.
/// - **Mode C.** The `bind.` carries a RECOVERY kx, the `dev.` carries the
///   device's own kx; both are required. The recovery kx's private scalar goes
///   into the recovery blob beside the account scalar and nowhere else.
/// - **Trust the directory only through its pinned key.** The attestation that
///   comes back is verified against `directoryKeys` before anything is recorded
///   as bound; an answer under another kid is refused.
/// - **A recovery code the person has not proven they hold is never enrolled.**
///   The code is shown once, never stored, and the blob is opened with what they
///   type back before it is offered to the directory.
/// - **Setup is not complete until the directory holds the recovery material.**
///   That route (D1c) is not served yet, so today the flow stops, honestly, at
///   `recoveryNotServed`; it never reports a device as set up that could not be
///   recovered.
/// - **O1 is deferred (§39.4).** While ANY identity managed-config key is
///   present, no identity operation runs: not start, not verify, not recovery,
///   not the device cert. Presence of an unknown key counts.
/// - **Never act while blind.** An unreadable store is `unavailable`, never
///   "absent"; nothing is minted over it.
struct IdentitySetup {
    // MARK: seams

    struct Reply {
        let status: Int
        let json: [String: Any]?
    }
    /// One synchronous request to the directory. Call off the main thread.
    typealias Transport = (_ path: String, _ body: [String: String]) -> Reply

    let store: IdentityKeys.Store
    let post: Transport
    /// kid → the directory's public key (65-byte point, base64url). The pin.
    let directoryKeys: [String: String]
    /// true while any key in Bento's identity managed-config namespace is present
    let managed: () -> Bool
    let now: () -> Int
    let random: (Int) -> [UInt8]
    let enclave: Bool

    init(store: IdentityKeys.Store, post: @escaping Transport, directoryKeys: [String: String],
         managed: @escaping () -> Bool = IdentitySetup.managedConfigPresent,
         now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
         random: @escaping (Int) -> [UInt8] = { n in (0..<n).map { _ in UInt8.random(in: 0...255) } },
         enclave: Bool = SecureEnclave.isAvailable) {
        self.store = store; self.post = post; self.directoryKeys = directoryKeys
        self.managed = managed; self.now = now; self.random = random; self.enclave = enclave
    }

    static let bindLifetimeMs = 365 * 86_400_000
    static let devLifetimeMs = 365 * 86_400_000
    static let maxCodeAttempts = 5            // the directory's own limit; we stop asking too
    static let recordItem = "identity/setup"
    static let deviceKxItem = "identity/device-kx"
    /// the account's RECOVERY kx scalar, kept so this device can link another (link v1)
    /// PLACEHOLDER namespace for the presence key (vault to name it): any key under it counts.
    static let managedPrefix = "bento.id"

    /// iOS managed AppConfig arrives in this UserDefaults dictionary.
    static func managedConfigPresent() -> Bool {
        guard let d = UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed") else { return false }
        return d.keys.contains { $0.lowercased().hasPrefix(managedPrefix) }
    }

    // MARK: the record kept between steps

    struct Record: Codable, Equatable {
        struct Pkg: Codable, Equatable {
            var salt: String, iv: String, ct: String          // the recovery blob
            var saltV: String, verifier: String                // for the directory; dropped once enrolled
            var confirmed: Bool
        }
        var address: String
        var bindText: String
        var bindSig: String
        var recoveryKx: String                                  // private scalar, b64u: dropped once sealed
        var attempts: Int
        var att: String?                                        // text.sig of the verified attestation
        var recovery: Pkg?
        var dev: String?                                        // dev. text + "\n" + sig
        /// true on a device that arrived by linking (LinkFlow): it has no recovery blob of
        /// its own to make, and setup's recovery steps are not for it
        var linked: Bool?
    }

    func load() -> Record?? {
        switch store.get(Self.recordItem) {
        case .found(let d): return (try? JSONDecoder().decode(Record.self, from: d)).map { .some($0) }
        case .absent: return .some(nil)
        case .unavailable: return nil
        }
    }
    @discardableResult private func save(_ r: Record) -> Bool {
        guard let d = try? JSONEncoder().encode(r) else { return false }
        return store.set(Self.recordItem, d)
    }

    private func b64(_ b: [UInt8]) -> String { IdentityRecovery.b64uEnc(b) }
    private func unb64(_ s: String) -> [UInt8] { IdentityRecovery.b64uDec(s) ?? [] }

    // MARK: 1. start

    enum Start: Equatable {
        case managed
        case badAddress(String)
        case alreadySetUp
        case unavailable
        /// the directory accepted the statement; a code may have been mailed (it never says)
        case mailed
        case failed(Int)
    }

    func start(address input: String, name: String?) -> Start {
        guard !managed() else { return .managed }
        let address: String
        switch IdentityStatements.normalizeAddress(input) {
        case .refused(let why): return .badAddress(why)
        case .ok(let a): address = a
        }
        guard let existing = load() else { return .unavailable }
        if let r = existing {
            // a setup under way for THIS address is resumed (the same statement is sent again);
            // anything else is somebody already set up here
            guard r.address == address, r.att == nil else { return .alreadySetUp }
            return send(r)
        }
        switch store.get(IdentityKeys.accountItem) {
        case .found: return .alreadySetUp
        case .unavailable: return .unavailable
        case .absent: break
        }
        guard let account = try? IdentityKeys.createAccount(in: store) else { return .unavailable }
        let kx = P256.KeyAgreement.PrivateKey()
        let t = now()
        let accountPub = b64(Array(account.publicKey.x963Representation))
        let text = IdentityStatements.buildBind(.init(
            address: address, accountPub: accountPub, kx: b64(Array(kx.publicKey.x963Representation)),
            name: name, seq: 1, prev: nil, created: t, expires: t + Self.bindLifetimeMs))
        guard let sig = try? account.signature(for: Data(text.utf8)) else { store.delete(IdentityKeys.accountItem); return .unavailable }
        let r = Record(address: address, bindText: text, bindSig: b64(Array(IdentityKeys.lowS(sig.rawRepresentation))),
                       recoveryKx: b64(Array(kx.rawRepresentation)), attempts: 0, att: nil, recovery: nil, dev: nil)
        // the key was minted a moment ago by this call, so it is ours to take back
        guard save(r) else { store.delete(IdentityKeys.accountItem); return .unavailable }
        return send(r)
    }

    private func send(_ r: Record) -> Start {
        let reply = post("/v1/bind/start", ["stmt": r.bindText, "sig": r.bindSig])
        return reply.status == 202 ? .mailed : .failed(reply.status)
    }

    // MARK: 2. verify the mailbox

    enum Verify: Equatable {
        case managed
        case notStarted
        case unavailable
        case notACode
        /// the directory refused (wrong, expired or spent: it says one thing for all three)
        case refused(attemptsLeft: Int)
        case tooManyAttempts
        /// the directory answered, but not with something we can trust
        case untrusted(String)
        case bound
        case failed(Int)
    }

    func verify(code typed: String) -> Verify {
        guard !managed() else { return .managed }
        guard let loaded = load() else { return .unavailable }
        guard var r = loaded else { return .notStarted }
        if r.att != nil { return .bound }
        let code = typed.uppercased().filter { !$0.isWhitespace }
        guard code.range(of: "^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$", options: .regularExpression) != nil else { return .notACode }
        guard r.attempts < Self.maxCodeAttempts else { return .tooManyAttempts }
        guard let account = try? IdentityKeys.account(in: store) else { return .unavailable }
        let cmp = IdentityStatements.buildCmp(bindHash: IdentityStatements.sha256b64u(r.bindText), code: code)
        guard let sig = try? account.signature(for: Data(cmp.utf8)) else { return .unavailable }
        let reply = post("/v1/bind/complete", ["email": r.address, "code": code,
                                               "sig": b64(Array(IdentityKeys.lowS(sig.rawRepresentation)))])
        if reply.status == 400 || reply.status == 429 {
            r.attempts += 1; save(r)
            return r.attempts >= Self.maxCodeAttempts ? .tooManyAttempts : .refused(attemptsLeft: Self.maxCodeAttempts - r.attempts)
        }
        guard reply.status == 200, let j = reply.json else { return .failed(reply.status) }
        // what the directory says it bound must be exactly what we asked it to bind
        guard (j["binding"] as? String) == r.bindText, (j["sig"] as? String) == r.bindSig else { return .untrusted("binding") }
        guard let attText = j["attestation"] as? String, let attSig = j["attestationSig"] as? String else { return .untrusted("attestation") }
        switch IdentityStatements.verifyAtt(attText, attSig, directoryKeys: directoryKeys, bindText: r.bindText,
                                            now: now(), maxAgeMs: 5 * 60_000).value {
        case nil: return .untrusted("attestation")
        case let a?: guard a.state == "active" else { return .untrusted("state") }
        }
        r.att = attText + "\n" + attSig
        guard save(r) else { return .unavailable }
        return .bound
    }

    // MARK: 3. the recovery code

    enum Prepare: Equatable {
        case managed
        case notBound
        case unavailable
        /// the device cannot afford Argon2id: say so, count nothing, make nothing
        case noMemory
        /// shown once; never stored
        case code(String)
        case already
    }

    func prepareRecovery() -> Prepare {
        guard !managed() else { return .managed }
        guard let loaded = load() else { return .unavailable }
        guard var r = loaded, r.att != nil else { return .notBound }
        if r.recovery != nil || r.linked == true { return .already }
        guard Argon2id.hasMemory() else { return .noMemory }
        guard let account = try? IdentityKeys.account(in: store) else { return .unavailable }
        var code = random(IdentityRecovery.codeBytes)
        var salt = random(IdentityRecovery.saltLength), saltV = random(IdentityRecovery.saltLength), iv = random(12)
        defer { Argon2id.wipe(&code) }
        guard let printed = IdentityRecovery.formatCode(code),
              var wrap = IdentityRecovery.recoveryWrapKey(code: code, salt: salt),
              var verifier = IdentityRecovery.recoveryVerifier(code: code, saltV: saltV) else { return .noMemory }
        defer { Argon2id.wipe(&wrap); Argon2id.wipe(&verifier) }
        var kx = unb64(r.recoveryKx)
        defer { Argon2id.wipe(&kx) }
        let accountPub = b64(Array(account.publicKey.x963Representation))
        guard let ct = IdentityRecovery.sealRecoveryInner(
            wrapKey: wrap, iv: iv, accountPub: accountPub,
            keys: .init(account: Array(account.rawRepresentation), kx: kx)) else { return .unavailable }
        r.recovery = .init(salt: b64(salt), iv: b64(iv), ct: b64(ct), saltV: b64(saltV), verifier: b64(verifier), confirmed: false)
        // The recovery kx scalar now lives ONLY inside the code-wrapped recovery blob. Link v1
        // seals the account scalar and the address and nothing else, so no device keeps the
        // scalar at rest (the interim rule lets the setup device keep it only under a
        // per-use user-presence key, and nothing needs it).
        r.recoveryKx = ""                                   // not kept in the setup record
        guard save(r) else { return .unavailable }
        salt = []; saltV = []
        return .code(printed)
    }

    enum Confirm: Equatable {
        case managed
        case notPrepared
        case unavailable
        case noMemory
        case notACode(String)
        /// not the code that was shown (counted: it is a real wrong guess)
        case wrong
        case confirmed
    }

    /// The person types the code back. The blob is OPENED with it, so "confirmed"
    /// means the code and the stored blob agree, not that a string matched a string.
    func confirmRecovery(typed: String) -> Confirm {
        guard !managed() else { return .managed }
        guard let loaded = load() else { return .unavailable }
        guard var r = loaded, let p = r.recovery else { return .notPrepared }
        if p.confirmed { return .confirmed }
        var flow = RecoveryFlow()
        let m = RecoveryFlow.Material(salt: unb64(p.salt), iv: unb64(p.iv), ct: unb64(p.ct), accountPub: boundAccountPub(r),
                                      kxPub: boundKxPub(r))
        switch flow.attempt(typed, m) {
        case .unavailable: return .noMemory
        case .notACode(let why): return .notACode(why)
        case .wrongCode: return .wrong
        case .blobRejected: return .unavailable
        case .restored:
            r.recovery?.confirmed = true
            return save(r) ? .confirmed : .unavailable
        }
    }

    private func boundAccountPub(_ r: Record) -> String {
        IdentityStatements.verifyBind(r.bindText, r.bindSig, now: now()).value?.accountPub ?? ""
    }
    private func boundKxPub(_ r: Record) -> String {
        IdentityStatements.verifyBind(r.bindText, r.bindSig, now: now()).value?.kx ?? ""
    }

    enum Enrol: Equatable {
        case managed
        case notConfirmed
        case unavailable
        /// the directory does not serve the recovery store yet (D1c): nothing was sent
        case recoveryNotServed
    }

    /// Offer the confirmed blob and verifier to the directory. The directory's
    /// recovery store (D1c) is not built, so no route is called; when it is, this
    /// is the one place that changes, and the verifier is dropped here on success.
    func enrolRecovery() -> Enrol {
        guard !managed() else { return .managed }
        guard let loaded = load() else { return .unavailable }
        guard let r = loaded, let p = r.recovery, p.confirmed else { return .notConfirmed }
        return .recoveryNotServed
    }

    // MARK: 4. this device's dev.

    enum Mint: Equatable {
        case managed
        case notBound
        case unavailable
        case minted(String)
    }

    /// `dev.` for this device under mode C: routine + consent public keys, the
    /// device's OWN kx (never leaves the device), signed by the account key.
    func mintDevice(label: String?) -> Mint {
        guard !managed() else { return .managed }
        guard let loaded = load() else { return .unavailable }
        guard var r = loaded, r.att != nil else { return .notBound }
        if let d = r.dev { return .minted(String(d.split(separator: "\n", omittingEmptySubsequences: false)[0])) }
        guard let account = try? IdentityKeys.account(in: store),
              let routine = try? IdentityKeys.device(.routine, in: store, enclave: enclave),
              let consent = try? IdentityKeys.device(.consent, in: store, enclave: enclave) else { return .unavailable }
        let kx: P256.KeyAgreement.PrivateKey
        switch store.get(Self.deviceKxItem) {
        case .unavailable: return .unavailable
        case .found(let raw):
            guard let k = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw) else { return .unavailable }
            kx = k
        case .absent:
            let k = P256.KeyAgreement.PrivateKey()
            guard store.set(Self.deviceKxItem, k.rawRepresentation) else { return .unavailable }
            kx = k
        }
        let t = now()
        let text = IdentityStatements.buildDev(.init(
            devicePub: b64(Array(routine.publicRaw)), consentPub: b64(Array(consent.publicRaw)),
            accountPub: b64(Array(account.publicKey.x963Representation)), kx: b64(Array(kx.publicKey.x963Representation)),
            label: label, created: t, expires: t + Self.devLifetimeMs))
        guard let sig = try? account.signature(for: Data(text.utf8)) else { return .unavailable }
        let s = b64(Array(IdentityKeys.lowS(sig.rawRepresentation)))
        // our own work is checked by the verifier everyone else will use
        guard IdentityStatements.verifyDev(text, s, now: t).value != nil else { return .unavailable }
        r.dev = text + "\n" + s
        return save(r) ? .minted(text) : .unavailable
    }

    // MARK: where it stands

    enum Stage: Equatable {
        case none, mailed, bound, recoveryPrepared, recoveryConfirmed
        /// everything done, the directory holds the recovery material
        case complete
    }

    func stage() -> Stage? {
        guard let loaded = load() else { return nil }
        guard let r = loaded else { return Stage.none }
        if r.att == nil { return .mailed }
        guard let p = r.recovery else { return .bound }
        return p.confirmed ? .recoveryConfirmed : .recoveryPrepared
    }
}

/// The directory over HTTPS (or a local `wrangler dev`). Synchronous: call it
/// from a background queue, never the main thread.
enum DirectoryHTTP {
    static func transport(base: URL, session: URLSession = .shared) -> IdentitySetup.Transport {
        return { path, body in
            var req = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: 20)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            let sem = DispatchSemaphore(value: 0)
            var out = IdentitySetup.Reply(status: 0, json: nil)
            session.dataTask(with: req) { data, resp, _ in
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                out = .init(status: status, json: data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
                sem.signal()
            }.resume()
            sem.wait()
            return out
        }
    }
}
