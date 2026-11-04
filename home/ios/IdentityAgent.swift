// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation
import LocalAuthentication

/// What answers a document's `sign(purpose, payload)` (kernel/src/identity.ts),
/// and the host-stamped consent statement (identity-design §2e (A)).
///
/// The page names only WHAT it wants signed and for which purpose. It never names:
/// - which document it is (the host knows from the file it opened)
/// - who will verify the result, or with what challenge
/// - when the consent expires
/// The host stamps all of those itself, so a consent signature can't be pointed
/// at a context the page chose.
///
/// - **Routine purposes** (frame, prove, delegate, show) sign with the routine
///   device key, no prompt, and only a payload of exactly that purpose's shape.
/// - **High-authority purposes** (invite, revoke) need consent. The enrolment
///   gate runs first, so any notice is queued before anything else. Then the
///   host builds `cns.` and the consent key signs it, with the person present.
///
/// The bridge exposure of all this is I2's gate (a verified shell only); this
/// file decides and signs.
enum IdentityAgent {
    /// kernel/src/identity.ts SignRefusal
    enum Refusal: String, Error { case declined, reauth, purpose, noIdentity = "no-identity", unavailable }

    enum Signed: Equatable {
        /// a routine signature over the page's payload
        case routine(sig: String, pub: String)
        /// a consent: the host-stamped `cns.` text and the consent key's signature over it
        case consent(cns: String, sig: String, pub: String)
    }

    static let routine: Set<String> = ["frame", "prove", "delegate", "show"]
    /// the page's high-authority purposes, and the consent purpose each one is
    static let consentFor: [String: String] = ["invite": "invite", "revoke": "revoke"]

    /// The verifier this consent is FOR, as the host knows it: who it's talking
    /// to, and the single-use challenge that verifier issued. Never from the page.
    struct Verifier: Equatable {
        let audience: String   // "dir", or "room:<roomName>"
        let challenge: String
    }

    /// Build the host-stamped consent statement, or nil if any part breaks the
    /// rules. `docId` is the one the HOST read from the file it opened.
    static func stampConsent(purpose: String, payload: String, docId: String?, verifier: Verifier,
                             rp: String = "bento", now: Int,
                             ttlMs: Int = IdentityStatements.consentMaxTtlMs) -> String? {
        guard let family = IdentityStatements.consentFamily[purpose], payload.hasPrefix(family),
              ttlMs > 0, ttlMs <= IdentityStatements.consentMaxTtlMs else { return nil }
        let docScoped = purpose == "invite" || purpose == "revoke"
        if docScoped { guard let d = docId, IdentityStatements.isDocId(d) else { return nil } }
        guard let transcript = IdentityStatements.consentTranscript(audience: verifier.audience,
                                                                   challenge: verifier.challenge, payloadText: payload)
        else { return nil }
        return IdentityStatements.buildConsent(.init(rp: rp, purpose: purpose, docId: docScoped ? docId : nil,
                                                     transcript: transcript, exp: now + ttlMs))
    }

    /// What `consent` needs from the host's own state: never from the page.
    struct HostContext {
        let docId: String?
        let verifier: Verifier?
        let deviceName: String
        let devices: Set<String>
        let now: Int
        let domainState: () -> Data?
        let presence: LAContext?
    }

    /// `sign(purpose, payload)` as a document asks it.
    static func sign(purpose: String, payload: String, host: HostContext,
                     store: IdentityKeys.Store, enclave: Bool = SecureEnclave.isAvailable) -> Result<Signed, Refusal> {
        // the payload must be exactly the shape its purpose names, before any key is touched
        guard IdentityStatements.payloadMatchesPurpose(purpose, payload) else { return .failure(.purpose) }
        do { _ = try IdentityKeys.account(in: store) }
        catch IdentityKeys.Failure.noIdentity { return .failure(.noIdentity) }
        catch { return .failure(.unavailable) }

        if routine.contains(purpose) {
            do {
                let k = try IdentityKeys.device(.routine, in: store, enclave: enclave)
                let sig = try k.sign(Data(payload.utf8))
                return .success(.routine(sig: IdentityKeys.b64url(sig), pub: IdentityKeys.b64url(k.publicRaw)))
            } catch { return .failure(.unavailable) }
        }

        guard let cp = consentFor[purpose] else { return .failure(.purpose) }
        return consentSign(purpose: cp, payload: payload, host: host, store: store, enclave: enclave)
    }

    /// Linking a device (link v1): H's consent, purpose `link`, over the `dev.` text it
    /// issued for the new device. HOST-ONLY: a page can never reach this, because `link`
    /// is not in `consentFor` and `payloadMatchesPurpose` has no shape for it. It runs the
    /// same gate as a page's consent (enrolment notice first, presence, host-stamped
    /// `cns.`), so there is one consent path, not two.
    static func signLink(devText: String, host: HostContext,
                         store: IdentityKeys.Store, enclave: Bool = SecureEnclave.isAvailable) -> Result<Signed, Refusal> {
        do { _ = try IdentityKeys.account(in: store) }
        catch IdentityKeys.Failure.noIdentity { return .failure(.noIdentity) }
        catch { return .failure(.unavailable) }
        return consentSign(purpose: "link", payload: devText, host: host, store: store, enclave: enclave)
    }

    private static func consentSign(purpose cp: String, payload: String, host: HostContext,
                                    store: IdentityKeys.Store, enclave: Bool) -> Result<Signed, Refusal> {
        // The consent key FIRST: minting it is what records the enrolment it was
        // born under, so a brand-new key isn't mistaken for a changed enrolment.
        let k: IdentityKeys.DeviceKey
        do { k = try IdentityKeys.device(.consent, in: store, enclave: enclave, domainState: host.domainState) }
        catch { return .failure(.unavailable) }
        // then the notice (§29): queued before the consent can proceed
        switch IdentityKeys.enrolmentGate(host.domainState(), device: host.deviceName, devices: host.devices, now: host.now, in: store) {
        case .refuse: return .failure(.unavailable)
        case .reconfirm, .proceed: break   // a change is re-confirmed by the presence check below
        }
        guard let v = host.verifier,
              let cns = stampConsent(purpose: cp, payload: payload, docId: host.docId, verifier: v, now: host.now)
        else { return .failure(.unavailable) }
        do {
            let sig = try k.sign(Data(cns.utf8), context: host.presence)
            // only now, with the notice queued and the person present, is a changed enrolment accepted
            if IdentityKeys.checkEnrolment(host.domainState(), in: store) == .changed {
                IdentityKeys.acceptEnrolment(host.domainState(), in: store)
            }
            return .success(.consent(cns: cns, sig: IdentityKeys.b64url(sig), pub: IdentityKeys.b64url(k.publicRaw)))
        } catch IdentityKeys.Failure.declined { return .failure(.declined) }
        catch { return .failure(.unavailable) }
    }
}
