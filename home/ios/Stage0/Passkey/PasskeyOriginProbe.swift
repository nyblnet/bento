// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

// Stage 0 probe P7: what `origin` does Apple put in clientDataJSON when a
// NATIVE app registers or asserts a passkey for the relying party?
// Shows the bytes exactly as the platform produced them, with a Copy button.
// A test tool: its own project (Stage0/project.yml), never part of bento/home.

import AuthenticationServices
import CryptoKit
import UIKit

@main
final class ProbeAppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = UINavigationController(rootViewController: PasskeyProbeViewController())
        w.makeKeyAndVisible()
        window = w
        return true
    }
}

final class PasskeyProbeViewController: UIViewController, ASAuthorizationControllerDelegate,
                                        ASAuthorizationControllerPresentationContextProviding {
    static let marker = "bento-stage0-probe-q3"
    private let rp = Bundle.main.object(forInfoDictionaryKey: "BentoProbeRPID") as? String ?? ""
    private let output = UITextView()
    private var lines: [String] = []
    private var challenge = Data()
    private var ceremony = ""

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Passkey origin (Q3)"
        view.backgroundColor = .systemBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Copy results", style: .plain, target: self, action: #selector(copyResults))
        let create = button("Create", #selector(register))
        let get = button("Sign in", #selector(signIn))
        output.isEditable = false
        output.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        let row = UIStackView(arrangedSubviews: [create, get])
        row.spacing = 12
        row.distribution = .fillEqually
        let stack = UIStackView(arrangedSubviews: [row, output])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: g.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -16),
        ])
        let d = UIDevice.current
        log("\(Self.marker) · rp id \(rp) · app \(Bundle.main.bundleIdentifier ?? "?") · \(d.model) \(d.systemName) \(d.systemVersion)")
    }

    private func button(_ title: String, _ action: Selector) -> UIButton {
        let b = UIButton(configuration: .filled())
        b.configuration?.title = title
        b.configuration?.buttonSize = .large
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    private func provider() -> ASAuthorizationPlatformPublicKeyCredentialProvider {
        challenge = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        return ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp)
    }

    @objc private func register() {
        let p = provider()
        // a throwaway test user: delete the passkey at the end of the sitting
        let user = "stage0-probe-\(Int(Date().timeIntervalSince1970))"
        let req = p.createCredentialRegistrationRequest(challenge: challenge, name: user, userID: Data(user.utf8))
        run(req, "create")
    }

    @objc private func signIn() {
        run(provider().createCredentialAssertionRequest(challenge: challenge), "get")
    }

    private func run(_ req: ASAuthorizationRequest, _ name: String) {
        ceremony = name
        log("\n\(name): started")
        let c = ASAuthorizationController(authorizationRequests: [req])
        c.delegate = self
        c.presentationContextProvider = self
        c.performRequests()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        view.window ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization auth: ASAuthorization) {
        if let r = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            report(clientData: r.rawClientDataJSON, authData: r.rawAttestationObject.flatMap(Self.authDataInAttestation))
        } else if let a = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            report(clientData: a.rawClientDataJSON, authData: a.rawAuthenticatorData)
        } else {
            log("\(ceremony): finished with an unexpected credential type \(type(of: auth.credential))")
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let e = error as NSError
        // 1004 with "not associated with domain" means the rp host's apple-app-site-association
        // does not (yet) list this app, or Apple's CDN has not picked it up
        log("\(ceremony): error \(e.domain) \(e.code): \(e.localizedDescription)")
    }

    private func report(clientData: Data, authData: Data?) {
        let raw = String(decoding: clientData, as: UTF8.self)
        let obj = (try? JSONSerialization.jsonObject(with: clientData)) as? [String: Any] ?? [:]
        log("\(ceremony): origin = \(obj["origin"].map { "\($0)" } ?? "(absent)")")
        log("\(ceremony): type = \(obj["type"].map { "\($0)" } ?? "(absent)")")
        let sent = challenge.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        log("\(ceremony): challenge matches the one sent: \((obj["challenge"] as? String) == sent ? "yes" : "NO")")
        log("\(ceremony): keys = \(obj.keys.sorted().joined(separator: ", "))")
        log("\(ceremony): clientDataJSON (exact) = \(raw)")
        if let a = authData, a.count >= 37 {
            let rpHash = Data(SHA256.hash(data: Data(rp.utf8)))
            let f = a[a.startIndex + 32]
            log("\(ceremony): rpIdHash is sha256(\(rp)): \(a.prefix(32) == rpHash ? "yes" : "NO")")
            log("\(ceremony): flags UP=\(f & 1 != 0 ? 1 : 0) UV=\(f & 4 != 0 ? 1 : 0) BE=\(f & 8 != 0 ? 1 : 0) BS=\(f & 16 != 0 ? 1 : 0)")
        }
    }

    /// The authenticator data inside a CBOR attestation object: the byte string
    /// under the text key "authData". Enough CBOR for that one field.
    static func authDataInAttestation(_ att: Data) -> Data? {
        let b = [UInt8](att)
        let key: [UInt8] = [0x68] + Array("authData".utf8)
        guard let k = b.indices.first(where: { b.count >= $0 + key.count && Array(b[$0..<$0 + key.count]) == key }) else { return nil }
        var i = k + key.count
        guard i < b.count, b[i] >> 5 == 2 else { return nil }   // major type 2: byte string
        var len = Int(b[i] & 0x1F); i += 1
        if len == 24 { guard i < b.count else { return nil }; len = Int(b[i]); i += 1 }
        else if len == 25 { guard i + 1 < b.count else { return nil }; len = Int(b[i]) << 8 | Int(b[i + 1]); i += 2 }
        else if len > 25 { return nil }
        guard i + len <= b.count else { return nil }
        return Data(b[i..<i + len])
    }

    private func log(_ s: String) {
        lines.append(s)
        output.text = lines.joined(separator: "\n")
    }

    @objc private func copyResults() {
        UIPasteboard.general.string = lines.joined(separator: "\n")
        log("(copied)")
    }
}
