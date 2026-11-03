// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation

/// bento/connect B1 on iOS: what answers the shared bridge's `id.whoami`,
/// `id.sign` and `id.resolve` (home/bridge.js, contract kernel/src/identity.ts).
///
/// This file is pure Foundation + CryptoKit, with no UIKit, so a macOS rig drives
/// the very code the editor runs. EditorViewController supplies only the things
/// that need a screen: the consent prompt and the re-authentication prompt.
///
/// **Three gates, in this order, every call.** The bridge's own refusal to define
/// an agent for an unverified load is a courtesy; these are the authority.
/// 1. `genuine`: the load passed gate 1. An UNKNOWN document is `unavailable`
///    for everything, even if its page forged the message.
/// 2. no identity managed-config key is present (O1 is deferred, §39.4): while
///    one is, no identity op runs at all. `whoami`/`sign` say `no-identity`,
///    `resolve` says nothing. Checked on EVERY call, so a key added after the
///    page loaded still stops it.
/// 3. the op's own rule below.
///
/// - **whoami** is an identity-disclosure sink (§1): it answers only after the
///   person said yes to THIS document, and before that the answer is nothing.
///   The prompt is the host's, shows the real address, and a "no" is
///   remembered only for the life of the process. A "yes" is remembered per
///   document (its origin string, the identity the host minted: never a name the
///   page chose).
/// - **sign** is purpose-locked and session-bound (§2e B). The payload must be
///   exactly the shape its purpose names; only the routine purposes are served
///   (`invite`/`revoke` are the room owner's key, which in phase 1 lives in the
///   document, so they are `unavailable` here). Past the host's idle (1 h) or
///   overall (24 h) limit the answer is `reauth` until the person re-authenticates
///   AT THE HOST. The bridge caches nothing and never retries, so the one prompt
///   a refusal raises is coalesced here, and a cancelled prompt is not raised
///   again for `reauthCooldownMs`.
/// - **resolve** answers only for a key the host already holds a verified
///   binding for. It never sends an email and never reaches a directory. The
///   person's OWN keys resolve to their own identity, which is `whoami`'s answer,
///   so they need the same consent.
final class IdentityBridgeHost {
    /// What `whoami` may say, apart from the keys. The record that backs it is the
    /// setup flow's (a verified `bind.`); until that is wired the provider answers nil.
    struct Profile: Equatable {
        var name: String
        var email: String
        var vouchedBy: String
        /// when this device first knew the binding, ms
        var since: Int
    }

    /// A binding the host already holds for some other key (the pin store).
    struct Known: Equatable {
        var name: String
        var email: String
        var vouchedBy: String
        var accountPub: String
        var firstSeen: Int
        var changed: Bool
    }

    /// The reply shape the bridge understands: `ok` with a JSON value, or not ok
    /// with a refusal word.
    enum Reply: Equatable {
        case ok([String: String])
        case okSign(sig: String, pub: String)
        case okNull
        case refuse(String)
    }

    /// kernel/src/identity.ts SignRefusal
    private static let routinePurposes: Set<String> = ["frame", "prove", "delegate", "show"]

    // MARK: session

    /// The host's own routine session (§2e B). One per app run, shared by every
    /// open document: re-authentication is the PERSON's, not a document's.
    final class Session {
        struct Policy: Equatable {
            var idleMs: Int
            var overallMs: Int
            static let standard = Policy(idleMs: 60 * 60_000, overallMs: 24 * 60 * 60_000)
        }
        let policy: Policy
        private let clock: () -> Int
        private var window: (start: Int, last: Int)?
        init(policy: Policy = .standard, clock: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }) {
            self.policy = policy; self.clock = clock
        }
        /// Open (or renew) the session. Called ONLY after the person re-authenticated.
        func begin() { let t = clock(); window = (t, t) }
        /// Idle lock, sleep, session lock: signing is refused until `begin()`.
        func lock() { window = nil }
        /// Live only while BOTH limits are still to come: a limit ENDS the session AT
        /// the limit (security's ruling), so a use exactly 1 h after the last one, or
        /// 24 h after the start, is already refused. One millisecond short still signs.
        func live() -> Bool {
            let t = clock()
            // a clock that moved BACKWARDS would stretch both limits (a set-back clock held a
            // session live for ever), so it fails closed, as Android does
            if let w = window, t >= w.last, t - w.last < policy.idleMs, t - w.start < policy.overallMs { return true }
            window = nil
            return false
        }
        /// A routine use renews the idle clock, never the overall one.
        func touch() { if let w = window { window = (w.start, clock()) } }
    }

    // MARK: consent

    /// Which documents the person has let `whoami` answer for.
    final class ConsentBook {
        private var granted: Set<String>
        private var declined: Set<String> = []   // this process only
        private let save: (Set<String>) -> Void
        init(granted: Set<String> = [], save: @escaping (Set<String>) -> Void = { _ in }) {
            self.granted = granted; self.save = save
        }
        enum State { case granted, declined, unasked }
        func state(_ doc: String) -> State { granted.contains(doc) ? .granted : declined.contains(doc) ? .declined : .unasked }
        func record(_ doc: String, allow: Bool) {
            if allow { granted.insert(doc); declined.remove(doc); save(granted) } else { declined.insert(doc) }
        }
    }

    // MARK: wiring

    let genuine: Bool
    /// The document's origin string: the consent key. Empty means "not decided yet", and refuses.
    let docKey: String
    let store: IdentityKeys.Store
    let session: Session
    let consent: ConsentBook
    let profile: () -> Profile?
    let known: (String) -> Known?
    let managed: () -> Bool
    /// Shows the host's consent prompt for this document; calls back once.
    let askConsent: (Profile, @escaping (Bool) -> Void) -> Void
    /// Asks the person to re-authenticate; calls back with whether they did.
    let askReauth: (@escaping (Bool) -> Void) -> Void
    let now: () -> Int
    let enclave: Bool
    static let reauthCooldownMs = 30_000

    private var waitingConsent: [(Reply) -> Void]? = nil
    private var reauthPending = false
    private var reauthCancelledAt: Int?

    init(genuine: Bool, docKey: String, store: IdentityKeys.Store, session: Session, consent: ConsentBook,
         profile: @escaping () -> Profile?, known: @escaping (String) -> Known? = { _ in nil },
         managed: @escaping () -> Bool = IdentityBridgeHost.managedConfigPresent,
         askConsent: @escaping (Profile, @escaping (Bool) -> Void) -> Void,
         askReauth: @escaping (@escaping (Bool) -> Void) -> Void,
         now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
         enclave: Bool = SecureEnclave.isAvailable) {
        self.genuine = genuine; self.docKey = docKey; self.store = store; self.session = session
        self.consent = consent; self.profile = profile; self.known = known; self.managed = managed
        self.askConsent = askConsent; self.askReauth = askReauth; self.now = now; self.enclave = enclave
    }

    /// PLACEHOLDER namespace for the presence key: any key under it counts. The
    /// same prefix the setup flow uses (IdentitySetup.managedPrefix); the two
    /// should read ONE constant once both are on main.
    static let managedPrefix = "bento.id"
    /// iOS managed AppConfig arrives in this UserDefaults dictionary.
    static func managedConfigPresent() -> Bool {
        guard let d = UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed") else { return false }
        return d.keys.contains { $0.lowercased().hasPrefix(managedPrefix) }
    }

    /// The capabilities the editor declares to bridge.js for THIS load. 'identity'
    /// only for a load that passed gate 1: the bridge then defines no agent at
    /// all for anything else.
    static func hostCaps(genuine: Bool) -> [String] { genuine ? ["store", "identity"] : ["store"] }

    // MARK: ops

    static let ops: Set<String> = ["id.whoami", "id.sign", "id.resolve"]

    func handle(op: String, message m: [String: Any], reply: @escaping (Reply) -> Void) {
        guard genuine, !docKey.isEmpty else { return reply(.refuse("unavailable")) }
        guard !managed() else { return reply(op == "id.resolve" ? .okNull : .refuse("no-identity")) }
        switch op {
        case "id.whoami": whoami(reply)
        case "id.sign": reply(sign(purpose: m["purpose"] as? String, payload: m["payload"] as? String))
        case "id.resolve": reply(resolve(pub: m["pub"] as? String))
        default: reply(.refuse("unavailable"))
        }
    }

    private func keys() -> (account: String, device: String)? {
        guard let a = try? IdentityKeys.account(in: store),
              let d = try? IdentityKeys.device(.routine, in: store, enclave: enclave) else { return nil }
        return (IdentityKeys.b64url(a.publicKey.x963Representation), IdentityKeys.b64url(d.publicRaw))
    }

    private func whoami(_ reply: @escaping (Reply) -> Void) {
        guard let p = profile() else { return reply(.refuse("no-identity")) }
        switch consent.state(docKey) {
        case .granted: reply(whoamiReply(p))
        case .declined: reply(.refuse("declined"))
        case .unasked:
            // one prompt however many calls arrive while it is up
            if waitingConsent != nil { waitingConsent!.append(reply); return }
            waitingConsent = [reply]
            askConsent(p) { [self] allow in
                consent.record(docKey, allow: allow)
                let waiting = waitingConsent ?? []
                waitingConsent = nil
                // the answer is built AFTER the person chose, from what is true now
                let r: Reply = allow ? (profile().map(whoamiReply) ?? .refuse("no-identity")) : .refuse("declined")
                waiting.forEach { $0(r) }
            }
        }
    }

    private func whoamiReply(_ p: Profile) -> Reply {
        guard let k = keys() else { return .refuse("no-identity") }
        return .ok(["name": p.name, "email": p.email, "vouchedBy": p.vouchedBy, "accountPub": k.account, "devicePub": k.device])
    }

    private func sign(purpose: String?, payload: String?) -> Reply {
        guard let purpose, let payload else { return .refuse("purpose") }
        // the shape first: a mismatch is refused before any key or session is looked at
        guard IdentityStatements.payloadMatchesPurpose(purpose, payload) else { return .refuse("purpose") }
        guard Self.routinePurposes.contains(purpose) else { return .refuse("unavailable") }
        do { _ = try IdentityKeys.account(in: store) }
        catch IdentityKeys.Failure.noIdentity { return .refuse("no-identity") }
        catch { return .refuse("unavailable") }
        guard session.live() else { raiseReauth(); return .refuse("reauth") }
        let host = IdentityAgent.HostContext(docId: nil, verifier: nil, deviceName: "", devices: [], now: now(),
                                             domainState: { nil }, presence: nil)
        switch IdentityAgent.sign(purpose: purpose, payload: payload, host: host, store: store, enclave: enclave) {
        case .success(.routine(let sig, let pub)): session.touch(); return .okSign(sig: sig, pub: pub)
        case .success: return .refuse("unavailable")
        case .failure(let r): return .refuse(r.rawValue)
        }
    }

    /// At most one prompt in flight; after a cancel, none for the cooldown.
    private func raiseReauth() {
        if reauthPending { return }
        if let c = reauthCancelledAt, now() - c < Self.reauthCooldownMs { return }
        reauthPending = true
        askReauth { [self] ok in
            reauthPending = false
            if ok { reauthCancelledAt = nil; session.begin() } else { reauthCancelledAt = now() }
        }
    }

    private func resolve(pub: String?) -> Reply {
        guard let pub, !pub.isEmpty, pub.utf8.count < 4096 else { return .okNull }
        if let mine = keys(), pub == mine.account || pub == mine.device {
            // the person's own identity is whoami's answer: same consent, same nothing before it
            guard consent.state(docKey) == .granted, let p = profile() else { return .okNull }
            return .ok(["name": p.name, "email": p.email, "vouchedBy": p.vouchedBy, "accountPub": mine.account,
                        "firstSeen": String(p.since), "changed": "false"])
        }
        guard let k = known(pub) else { return .okNull }
        return .ok(["name": k.name, "email": k.email, "vouchedBy": k.vouchedBy, "accountPub": k.accountPub,
                    "firstSeen": String(k.firstSeen), "changed": k.changed ? "true" : "false"])
    }

    // MARK: the wire

    /// A JSON-compatible value for `__bentoNativeReply(id, ok, <value>)`, which the
    /// bridge reads as an object (whoami/resolve/sign) or a refusal word.
    static func wire(_ r: Reply) -> (ok: Bool, value: Any) {
        switch r {
        case .refuse(let w): return (false, w)
        case .okNull: return (true, NSNull())
        case .okSign(let sig, let pub): return (true, ["sig": sig, "pub": pub])
        case .ok(let f):
            var o: [String: Any] = f
            if let s = f["firstSeen"] { o["firstSeen"] = Int(s) ?? 0 }
            if let c = f["changed"] { o["changed"] = (c == "true") }
            return (true, o)
        }
    }

    /// The script that hands a reply to bridge.js: `__bentoNativeReply(id, ok, <JSON>)`.
    /// A JSON encoder makes the literal (a raw newline or the U+2028/9 separators
    /// must never reach the parser); nil if it cannot be encoded.
    static func replyScript(id: Int, ok: Bool, json: Any) -> String? {
        guard let d = try? JSONSerialization.data(withJSONObject: json, options: [.fragmentsAllowed]),
              let lit = String(data: d, encoding: .utf8) else { return nil }
        let safe = lit.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return "window.__bentoNativeReply(\(id), \(ok), \(safe))"
    }
}
