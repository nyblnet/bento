// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation
import LocalAuthentication

/// bento/connect device linking on iOS: the flow in both roles, over the directory's
/// `/v1/link/*` slot (identity-launch-gaps, security §39.1). The bytes are
/// IdentityLink.swift; this file is the decisions, so a rig can drive two agents
/// against a local directory with no UI.
///
/// H is the device that HOLDS the account, N the new device that does not. Either may
/// DISPLAY the code (the other scans or types it), and the steps are the same both ways:
/// the displayer opens the slot, the scanner answers, both derive the SAS; N SHOWS it,
/// the person TYPES it into H; N sends its offer; H consents and completes; N checks
/// and stores.
///
/// The rules this file keeps (security §39.1):
/// 1. **H never starts from outside.** The H side begins only from the in-app "Link a new
///    device" action (`Origin.inApp`). A universal link or camera intent on a device
///    that holds an account is refused, whichever side of the slot it would be.
/// 2. **Roles are checked against our own state**, not trusted: exactly one side
///    holds the account.
/// 3. **One attempt.** A wrong SAS aborts the slot; there is no second try on the code.
/// 4. **Each key seals exactly one message** (n2h: 2, h2n: 3). A retry is a new slot
///    with a new code, never a second message under a key.
/// 5. **N checks what it was given** before storing anything: its OWN keys in the dev.,
///    and the unsealed scalars against a binding served under a PINNED directory key.
/// 6. **N shows the label H wrote**, from the dev. it was issued, not the one it offered.
/// 7. **An unknown platform token is never shown as verified.**
/// 8. **Never act while blind**: an unreadable store is `unavailable`, never "no account".
///
/// While any identity managed-config key is present no identity operation runs (O1).
final class LinkAgent {
    // MARK: seams

    /// POST (JSON body) and GET against the directory. Synchronous: call off the main thread.
    struct Net {
        let post: (_ path: String, _ body: [String: Any]) -> IdentitySetup.Reply
        let get: (_ pathAndQuery: String) -> IdentitySetup.Reply
    }

    /// Where a link action began. Only `.inApp` may start the H side.
    enum Origin { case inApp, universalLink, cameraIntent }

    let store: IdentityKeys.Store
    let net: Net
    let directoryKeys: [String: String]
    let managed: () -> Bool
    let now: () -> Int
    let random: (Int) -> [UInt8]
    let enclave: Bool
    /// the consent key's enrolment reading (tripwire) and the presence check for it
    let domainState: () -> Data?
    let presence: LAContext?
    let deviceName: String
    /// the platform token N offers (context for the person on H, never proof)
    let platform: String
    /// how long one poll waits at the directory, and how long a step waits in all
    let pollMs: Int
    let stepSeconds: Double

    init(store: IdentityKeys.Store, net: Net, directoryKeys: [String: String],
         managed: @escaping () -> Bool = IdentitySetup.managedConfigPresent,
         now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
         random: @escaping (Int) -> [UInt8] = { n in (0..<n).map { _ in UInt8.random(in: 0...255) } },
         enclave: Bool = SecureEnclave.isAvailable,
         domainState: @escaping () -> Data? = IdentityKeys.currentDomainState,
         presence: LAContext? = nil, deviceName: String = "This device", platform: String = "ios",
         pollMs: Int = 8000, stepSeconds: Double = 600) {
        self.store = store; self.net = net; self.directoryKeys = directoryKeys; self.managed = managed
        self.now = now; self.random = random; self.enclave = enclave; self.domainState = domainState
        self.presence = presence; self.deviceName = deviceName; self.platform = platform
        self.pollMs = pollMs; self.stepSeconds = stepSeconds
    }

    enum Refusal: Equatable, Error {
        case managed
        case unavailable
        /// a link began somewhere it may not: the H side from outside the app, or a role
        /// the device's own state contradicts
        case notHere(String)
        case badCode
        /// a second device has the code (or a message was written twice): start again
        case contended
        /// the slot is aborted, completed or expired
        case gone(String)
        case wrongSAS
        case badMessage(String)
        case declined
        case directoryRefused(String)
        case untrusted(String)
        /// this session's key has already sealed its one message
        case spent
        case network(Int)
    }

    // MARK: who holds what

    enum Holds { case account, nothing }
    func holds() -> Holds? {
        switch store.get(IdentityKeys.accountItem) {
        case .found: return .account
        case .absent: return .nothing
        case .unavailable: return nil
        }
    }

    // MARK: one linking session (one slot, one code)

    final class Session {
        let agent: LinkAgent
        /// what this device is in the link: H holds the account, N is the new device
        let me: IdentityLink.Role
        let displays: Bool
        let slot: IdentityLink.Slot
        let ephemeral: P256.KeyAgreement.PrivateKey
        /// the code to show (displayer) or that was typed (scanner), in the printed form
        let printedCode: String
        private(set) var roleD: IdentityLink.Role
        private(set) var t: String?
        private(set) var keys: IdentityLink.Keys?
        private(set) var offer: IdentityLink.Offer?          // N: what it sent; H: what it received
        fileprivate(set) var spentOffer = false               // n2h has sealed its message
        fileprivate(set) var spentFinal = false               // h2n has sealed its message
        fileprivate(set) var sasTried = false
        fileprivate(set) var dead = false

        fileprivate init(agent: LinkAgent, me: IdentityLink.Role, displays: Bool, slot: IdentityLink.Slot,
                         ephemeral: P256.KeyAgreement.PrivateKey, printedCode: String, roleD: IdentityLink.Role) {
            self.agent = agent; self.me = me; self.displays = displays; self.slot = slot
            self.ephemeral = ephemeral; self.printedCode = printedCode; self.roleD = roleD
        }
        fileprivate func derive(eD: String, eS: String) -> Bool {
            guard let t = IdentityLink.transcript(id: slot.id, eD: eD, eS: eS, roleD: roleD),
                  let k = IdentityLink.keys(own: ephemeral, otherPub: displays ? eS : eD, salt: slot.salt, t: t) else { return false }
            self.t = t; self.keys = k
            return true
        }
        fileprivate func setOffer(_ o: IdentityLink.Offer) { offer = o }

        /// N shows this; the person types it into H.
        var sas: String? { me == .N ? keys?.sas : nil }
    }

    // MARK: wire helpers

    private func b64(_ b: [UInt8]) -> String { IdentityRecovery.b64uEnc(b) }

    private func slotCall(_ s: Session, _ op: String, _ extra: [String: Any] = [:]) -> IdentitySetup.Reply {
        var body: [String: Any] = ["id": s.slot.id, "tok": s.slot.tok]
        for (k, v) in extra { body[k] = v }
        return net.post("/v1/link/\(op)", body)
    }

    /// The directory's answer, as a refusal.
    private func refusal(_ r: IdentitySetup.Reply) -> Refusal {
        let e = r.json?["error"] as? String
        switch (r.status, e) {
        case (409, "contended"?): return .contended
        case (409, let x?): return .gone(x)
        case (404, _): return .gone("expired")
        case (400, let x?) where x == "invalid": return .directoryRefused((r.json?["reason"] as? String) ?? x)
        case (403, _): return .badCode
        default: return .network(r.status)
        }
    }

    /// Wait for message n: poll until it is there, the slot ends, or the step runs out.
    private func await_(_ s: Session, _ n: Int) -> Result<String, Refusal> {
        let deadline = Date().addingTimeInterval(stepSeconds)
        while true {
            let r = slotCall(s, "get", ["n": n, "wait": pollMs])
            if r.status == 200, let m = r.json?["msg"] as? String { return .success(m) }
            if r.status != 202 { return .failure(refusal(r)) }
            if Date() > deadline { return .failure(.gone("expired")) }
        }
    }

    private func abort(_ s: Session) {
        s.dead = true
        _ = slotCall(s, "abort")
    }

    private func text(_ wire: String) -> String? {
        IdentityRecovery.b64uDec(wire).flatMap { String(bytes: $0, encoding: .utf8) }
    }

    // MARK: 1. begin — display a code, or scan one

    /// DISPLAY: mint a code, open the slot with msg0 and hand back the session; the caller
    /// shows `printedCode` (as a QR or text), then calls `awaitScanner`.
    func display(as me: IdentityLink.Role, origin: Origin) -> Result<Session, Refusal> {
        guard !managed() else { return .failure(.managed) }
        guard let h = holds() else { return .failure(.unavailable) }
        // rule 1 and 2: H starts only in-app, on a device that holds the account;
        // N is a device that holds none, from any origin
        switch (me, h) {
        case (.H, .account): guard origin == .inApp else { return .failure(.notHere("link-from-outside")) }
        case (.N, .nothing): break
        default: return .failure(.notHere("role-contradicts-state"))
        }
        let code = random(IdentityRecovery.codeBytes)
        guard let printed = IdentityRecovery.formatCode(code), let slot = IdentityLink.slot(code: code) else { return .failure(.unavailable) }
        let e = P256.KeyAgreement.PrivateKey()
        let eD = b64(Array(e.publicKey.x963Representation))
        let s = Session(agent: self, me: me, displays: true, slot: slot, ephemeral: e, printedCode: printed, roleD: me)
        let msg0 = IdentityLink.buildMsg0(eD, me)
        let r = slotCall(s, "open", ["msg": b64(Array(msg0.utf8))])
        guard r.status == 200 else { return .failure(refusal(r)) }
        return .success(s)
    }

    /// DISPLAYER: wait for the scanner's msg1, then derive the keys.
    func awaitScanner(_ s: Session) -> Result<Void, Refusal> {
        guard s.displays, !s.dead else { return .failure(.gone("dead")) }
        switch await_(s, 1) {
        case .failure(let f): s.dead = true; return .failure(f)
        case .success(let w):
            guard let t1 = text(w), let eS = IdentityLink.parseMsg1(t1).value else { abort(s); return .failure(.badMessage("msg1")) }
            let eD = b64(Array(s.ephemeral.publicKey.x963Representation))
            guard s.derive(eD: eD, eS: eS) else { abort(s); return .failure(.badMessage("reflected")) }
            return .success(())
        }
    }

    /// SCAN (or type) a code: read msg0, check the displayer's claimed role against OUR state,
    /// answer with msg1 and derive the keys.
    func scan(code typed: String, origin: Origin) -> Result<Session, Refusal> {
        guard !managed() else { return .failure(.managed) }
        guard let h = holds() else { return .failure(.unavailable) }
        guard case .ok(let code) = IdentityRecovery.parseCode(typed), let printed = IdentityRecovery.formatCode(code),
              let slot = IdentityLink.slot(code: code) else { return .failure(.badCode) }
        // we hold the code, so we may read; nothing is written until the role is checked
        let probe = Session(agent: self, me: h == .account ? .H : .N, displays: false, slot: slot,
                            ephemeral: P256.KeyAgreement.PrivateKey(), printedCode: printed, roleD: .H)
        let r = slotCall(probe, "get", ["n": 0, "wait": 0])
        guard r.status == 200, let w = r.json?["msg"] as? String else { return .failure(r.status == 202 ? .gone("not-open") : refusal(r)) }
        guard let t0 = text(w), let m0 = IdentityLink.parseMsg0(t0).value else { return .failure(.badMessage("msg0")) }
        guard IdentityLink.scannerMayProceed(roleD: m0.role, scannerHoldsAccount: h == .account) else {
            return .failure(.notHere("role-contradicts-state"))
        }
        // a scanner that holds the account is H: only the in-app action may start that
        if h == .account && origin != .inApp { return .failure(.notHere("link-from-outside")) }
        let s = Session(agent: self, me: h == .account ? .H : .N, displays: false, slot: slot,
                        ephemeral: probe.ephemeral, printedCode: printed, roleD: m0.role)
        let eS = b64(Array(s.ephemeral.publicKey.x963Representation))
        guard s.derive(eD: m0.eD, eS: eS) else { return .failure(.badMessage("reflected")) }
        let put = slotCall(s, "put", ["n": 1, "msg": b64(Array(IdentityLink.buildMsg1(eS).utf8))])
        guard put.status == 200 else { return .failure(refusal(put)) }
        return .success(s)
    }

    // MARK: 2. N — offer, wait, check, store

    private func deviceKx() -> P256.KeyAgreement.PrivateKey? {
        switch store.get(IdentitySetup.deviceKxItem) {
        case .unavailable: return nil
        case .found(let raw): return try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
        case .absent:
            let k = P256.KeyAgreement.PrivateKey()
            return store.set(IdentitySetup.deviceKxItem, k.rawRepresentation) ? k : nil
        }
    }

    /// N sends its offer (msg2): its device keys, its own kx, a label and platform, with
    /// proofs of possession over this session's transcript. Once per session.
    func sendOffer(_ s: Session, label: String?) -> Result<Void, Refusal> {
        guard s.me == .N, !s.dead, let t = s.t, let keys = s.keys else { return .failure(.notHere("not-n")) }
        guard !s.spentOffer else { return .failure(.spent) }
        guard !managed() else { return .failure(.managed) }
        guard let routine = try? IdentityKeys.device(.routine, in: store, enclave: enclave),
              let consent = try? IdentityKeys.device(.consent, in: store, enclave: enclave, domainState: domainState),
              let kx = deviceKx() else { return .failure(.unavailable) }
        let pop = Data(IdentityLink.popText(t).utf8)
        guard let sd = try? routine.sign(pop), let sc = try? consent.sign(pop, context: presence) else { return .failure(.declined) }
        let offer = IdentityLink.Offer(devicePub: b64(Array(routine.publicRaw)), consentPub: b64(Array(consent.publicRaw)),
                                       kx: b64(Array(kx.publicKey.x963Representation)), label: label, platform: platform)
        let plain = IdentityLink.buildOffer(offer, popDevice: b64(Array(sd)), popConsent: b64(Array(sc)))
        // our own work is checked by the verifier H will use
        guard IdentityLink.verifyOffer(plain, t: t).ok else { return .failure(.unavailable) }
        s.spentOffer = true                                  // set BEFORE sending: a failed send is not a second try
        guard let wire = IdentityLink.seal(keys, .offer, t: t, iv: random(12), Array(plain.utf8)) else { return .failure(.unavailable) }
        let r = slotCall(s, "put", ["n": 2, "msg": wire])
        guard r.status == 200 else { return .failure(refusal(r)) }
        s.setOffer(offer)
        return .success(())
    }

    struct Linked: Equatable {
        /// the label H wrote into the dev. it issued (NOT the one N offered), if any
        let label: String?
        let devicePub: String
    }

    /// N waits for msg3, then checks it against the binding the directory serves for
    /// `address` under a PINNED key, and only then stores anything.
    func awaitLinked(_ s: Session, address typed: String) -> Result<Linked, Refusal> {
        guard s.me == .N, !s.dead, let t = s.t, let keys = s.keys, let offer = s.offer else { return .failure(.notHere("not-n")) }
        guard !managed() else { return .failure(.managed) }
        guard case .ok(let address) = IdentityStatements.normalizeAddress(typed) else { abort(s); return .failure(.untrusted("address")) }
        let fail = { (r: Refusal) -> Result<Linked, Refusal> in self.abort(s); return .failure(r) }
        let m3: String
        switch await_(s, 3) {
        case .failure(let f): s.dead = true; return .failure(f)
        case .success(let m): m3 = m
        }
        // the binding, from the directory, under the pinned key
        let q = address.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? address
        let l = net.get("/v1/lookup?e=\(q)")
        guard l.status == 200, let j = l.json, let bindText = j["binding"] as? String, let bindSig = j["sig"] as? String,
              let attText = j["attestation"] as? String, let attSig = j["attestationSig"] as? String else { return fail(.untrusted("lookup")) }
        guard let bind = IdentityStatements.verifyBind(bindText, bindSig, now: now()).value, bind.address == address else { return fail(.untrusted("binding")) }
        guard let att = IdentityStatements.verifyAtt(attText, attSig, directoryKeys: directoryKeys, bindText: bindText,
                                                     now: now(), maxAgeMs: 5 * 60_000).value, att.state == "active" else { return fail(.untrusted("attestation")) }
        let v = IdentityLink.openFinal(m3, keys: keys, t: t, offer: offer, accountPub: bind.accountPub, kxPub: bind.kx, now: now())
        guard let o = v.value else { return fail(.badMessage(v.reason ?? "final")) }
        // store: recovery kx and record first, the account key LAST (its presence is "holds an account")
        guard case .absent = store.get(IdentityKeys.accountItem) else { return fail(.unavailable) }
        let rec = IdentitySetup.Record(address: address, bindText: bindText, bindSig: bindSig, recoveryKx: "", attempts: 0,
                                       att: attText + "\n" + attSig, recovery: nil, dev: o.dev + "\n" + o.devSig, linked: true)
        guard let recData = try? JSONEncoder().encode(rec) else { return fail(.unavailable) }
        guard store.set(IdentitySetup.recoveryKxItem, Data(o.keys.kx)) else { return fail(.unavailable) }
        guard store.set(IdentitySetup.recordItem, recData) else { store.delete(IdentitySetup.recoveryKxItem); return fail(.unavailable) }
        guard store.set(IdentityKeys.accountItem, Data(o.keys.account)) else {
            store.delete(IdentitySetup.recoveryKxItem); store.delete(IdentitySetup.recordItem); return fail(.unavailable)
        }
        abort(s)                                              // N is done: delete the slot
        return .success(Linked(label: o.device.label, devicePub: o.device.devicePub))
    }

    // MARK: 3. H — SAS, consent, complete

    /// The person types the SAS N shows into H. One attempt: a mismatch ends the slot.
    /// On a match, H reads and checks the offer.
    func submitSAS(_ s: Session, typed: String) -> Result<IdentityLink.Offer, Refusal> {
        guard s.me == .H, !s.dead, let t = s.t, let keys = s.keys else { return .failure(.notHere("not-h")) }
        guard !s.sasTried else { return .failure(.wrongSAS) }
        s.sasTried = true
        guard IdentityLink.sasMatches(typed: typed, sas: keys.sas) else { abort(s); return .failure(.wrongSAS) }
        switch await_(s, 2) {
        case .failure(let f): s.dead = true; return .failure(f)
        case .success(let wire):
            let v = IdentityLink.openOffer(keys, t: t, wire: wire)
            guard let o = v.value else { abort(s); return .failure(.badMessage(v.reason ?? "offer")) }
            s.setOffer(o)
            return .success(o)
        }
    }

    /// H consents (Face ID / passcode), issues N's dev. and completes the slot. `label` is
    /// what N will show as its name. Once per session.
    func approve(_ s: Session, label: String?) -> Result<Linked, Refusal> {
        guard s.me == .H, !s.dead, let t = s.t, let keys = s.keys, let offer = s.offer else { return .failure(.notHere("not-h")) }
        guard !s.spentFinal else { return .failure(.spent) }
        guard !managed() else { return .failure(.managed) }
        guard let loaded = IdentitySetup(store: store, post: { _, _ in .init(status: 0, json: nil) }, directoryKeys: directoryKeys, managed: { false }).load(),
              let rec = loaded, rec.att != nil, let own = rec.dev,
              let account = try? IdentityKeys.account(in: store) else { return .failure(.unavailable) }
        guard case .found(let kx) = store.get(IdentitySetup.recoveryKxItem), kx.count == 32 else { return .failure(.unavailable) }
        let hDev = own.components(separatedBy: "\n")
        guard hDev.count == 2 else { return .failure(.unavailable) }
        let accountPub = b64(Array(account.publicKey.x963Representation))
        // a single-use `dir` challenge for this address
        let ch = net.post("/v1/challenge", ["email": rec.address])
        guard ch.status == 200, let challenge = ch.json?["challenge"] as? String else { return .failure(.network(ch.status)) }
        let t0 = now()
        let nDev = IdentityStatements.buildDev(.init(devicePub: offer.devicePub, consentPub: offer.consentPub, accountPub: accountPub,
                                                     kx: offer.kx, label: label ?? offer.label, created: t0, expires: t0 + IdentitySetup.devLifetimeMs))
        guard let nSig = try? account.signature(for: Data(nDev.utf8)) else { return .failure(.unavailable) }
        let nDevSig = b64(Array(IdentityKeys.lowS(nSig.rawRepresentation)))
        let host = IdentityAgent.HostContext(docId: nil, verifier: .init(audience: "dir", challenge: challenge), deviceName: deviceName,
                                             devices: [deviceName], now: t0, domainState: domainState, presence: presence)
        let cns: IdentityAgent.Signed
        switch IdentityAgent.signLink(devText: nDev, host: host, store: store, enclave: enclave) {
        case .failure(.declined): return .failure(.declined)       // nothing sealed, nothing sent: the person may try again
        case .failure: return .failure(.unavailable)
        case .success(let c): cns = c
        }
        guard case .consent(let cnsText, let cnsSig, _) = cns else { return .failure(.unavailable) }
        guard let blob = IdentityRecovery.packScalars(.init(account: Array(account.rawRepresentation), kx: Array(kx))) else { return .failure(.unavailable) }
        s.spentFinal = true                                  // from here this key has sealed its one message
        guard let sealed = IdentityLink.seal(keys, .final, t: t, iv: random(12), blob) else { return .failure(.unavailable) }
        let msg3 = IdentityLink.buildFinal(.init(hDev: hDev[0], hDevSig: hDev[1], cns: cnsText, cnsSig: cnsSig, nDev: nDev, nDevSig: nDevSig, sealed: sealed))
        // our own msg3 is checked by the verifier the directory will run
        guard IdentityLink.verifyRelease(msg3, bindText: rec.bindText, state: "active", challenge: challenge, now: t0, spend: { _ in true }).ok
        else { abort(s); return .failure(.unavailable) }
        let r = slotCall(s, "complete", ["email": rec.address, "challenge": challenge, "msg3": msg3])
        // no answer, or a server fault: the directory may or may not have claimed the slot, but
        // h2n has sealed its message either way, so a retry is refused (`spentFinal`), not resent
        if r.status == 0 || r.status >= 500 { return .failure(.network(r.status)) }
        guard r.status == 200 else { s.dead = true; return .failure(refusal(r)) }
        s.dead = true
        return .success(Linked(label: label ?? offer.label, devicePub: offer.devicePub))
    }

    /// Abandon a session (the person backed out): delete the slot.
    func cancel(_ s: Session) { if !s.dead { abort(s) } }
}

extension DirectoryHTTP {
    /// POST and GET for LinkAgent. Link polls wait up to 8 s at the directory, so the timeout is longer.
    static func net(base: URL, session: URLSession = .shared) -> LinkAgent.Net {
        func run(_ req: URLRequest) -> IdentitySetup.Reply {
            let sem = DispatchSemaphore(value: 0)
            var out = IdentitySetup.Reply(status: 0, json: nil)
            session.dataTask(with: req) { data, resp, _ in
                out = .init(status: (resp as? HTTPURLResponse)?.statusCode ?? 0,
                            json: data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
                sem.signal()
            }.resume()
            sem.wait()
            return out
        }
        return LinkAgent.Net(
            post: { path, body in
                var req = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: 40)
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "content-type")
                req.httpBody = try? JSONSerialization.data(withJSONObject: body)
                return run(req)
            },
            get: { pq in
                guard let url = URL(string: pq, relativeTo: base) else { return .init(status: 0, json: nil) }
                return run(URLRequest(url: url, timeoutInterval: 20))
            })
    }
}
