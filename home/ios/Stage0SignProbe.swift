// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

// Stage 0 device probe for the routine signing session (bento/id B1): DEBUG
// builds ONLY. The whole file is inside `#if DEBUG`, so a Release build has no
// trace of it; scripts/test-home-stage0-probes.mjs builds both configurations
// and checks the compiled app for this file's marker string.
#if DEBUG
import UIKit
import LocalAuthentication

/// Drives the app's real signing path with a test account present, so a person
/// on a real iPhone can watch the session end when UIKit says it should:
/// background and return, lock the device, set the clock back.
///
/// What is REAL here:
/// - `EditorViewController.identitySession`, the one session the app's
///   `sceneDidEnterBackground` and `applicationProtectedDataWillBecomeUnavailable`
///   lock. Nothing in this file locks it.
/// - `IdentityBridgeHost.handle("id.sign", …)`, the code a document's
///   `sign('show', 'live')` reaches through bridge.js.
/// - `EditorViewController.promptReauth`, the editor's own device-owner check.
/// - The device key: minted by IdentityKeys on first use (Secure Enclave on a device).
///
/// What is the FIXTURE: the account key lives in an in-memory store, made fresh
/// each time this screen opens. Nothing is written to the Keychain, so no test
/// account outlives the screen, and no real account is ever touched.
///
/// The log also records every lifecycle event UIKit delivers (scene background,
/// protected data going away, the clock changing), so each "asked" or "signed"
/// can be attributed to what happened before it.
final class Stage0SignProbeViewController: UIViewController {
    static let marker = "bento-stage0-probe-c1"

    /// The fixture: an account present, held only in memory.
    private final class MemorySecrets: HostDocStore.Secrets {
        private var items: [String: Data] = [:]
        func get(_ account: String) -> HostDocStore.Read { items[account].map { .found($0) } ?? .absent }
        func set(_ account: String, _ data: Data) -> Bool { items[account] = data; return true }
        func delete(_ account: String) { items[account] = nil }
    }

    private let store = MemorySecrets()
    private var host: IdentityBridgeHost?
    private let output = UITextView()
    private let verdict = UILabel()
    private var lines: [String] = []
    private var events: [String] = []
    private var presses = 0
    private var lastPress: (wall: Double, uptime: Double)?
    private var observers: [NSObjectProtocol] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Stage 0: sign session (C1)"
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: self, action: #selector(close))
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Copy results", style: .plain, target: self, action: #selector(copyResults))

        let sign = UIButton(configuration: .filled())
        sign.configuration?.title = "Sign"
        sign.configuration?.buttonSize = .large
        sign.addTarget(self, action: #selector(signOnce), for: .touchUpInside)
        verdict.numberOfLines = 0
        verdict.font = .preferredFont(forTextStyle: .title3)
        verdict.text = "Press Sign."
        output.isEditable = false
        output.font = .monospacedSystemFont(ofSize: 12, weight: .regular)

        let stack = UIStackView(arrangedSubviews: [sign, verdict, output])
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

        setUpFixture()
        watchLifecycle()
        // scripts/test-home-stage0-probes.mjs drives this screen on a simulator: one Sign at open
        if ProcessInfo.processInfo.environment["BENTO_RIG_STAGE0"] != nil { signOnce() }
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    private func setUpFixture() {
        let d = UIDevice.current
        log("\(Self.marker) · \(d.model) · \(d.systemName) \(d.systemVersion) · \(Self.stamp())")
        log("device-owner check available: \(Self.ownerCheck())")
        do {
            _ = try IdentityKeys.createAccount(in: store)
            log("test account: present (in memory only)")
        } catch {
            log("test account: could not be created (\(error)); every Sign will say no-identity")
        }
        host = IdentityBridgeHost(
            genuine: true, docKey: "stage0-probe", store: store,
            session: EditorViewController.identitySession, consent: .init(),
            profile: { nil },
            askConsent: { _, done in done(false) },
            askReauth: { [weak self] done in
                self?.log("  re-authentication prompt raised")
                EditorViewController.promptReauth { ok in
                    self?.log("  re-authentication: \(ok ? "approved, session open" : "not approved (cancelled, failed, or unavailable)")")
                    done(ok)
                }
            })
    }

    @objc private func signOnce() {
        guard let host else { return }
        presses += 1
        let wall = Date().timeIntervalSince1970, up = ProcessInfo.processInfo.systemUptime
        log("Sign #\(presses) at \(Self.stamp())")
        log("  events since the last Sign: \(events.isEmpty ? "none" : events.joined(separator: ", "))")
        if let p = lastPress {
            let drift = (wall - p.wall) - (up - p.uptime)
            if abs(drift) >= 2 { log(String(format: "  the clock moved %@ %.0f s since the last Sign", drift < 0 ? "BACK" : "forward", abs(drift))) }
        }
        events = []
        lastPress = (wall, up)
        host.handle(op: "id.sign", message: ["purpose": "show", "payload": "live"]) { [weak self] r in
            guard let self else { return }
            switch r {
            case .okSign:
                self.log("  answer: ok (signed without asking)")
                self.verdict.text = "#\(self.presses): SIGNED without asking"
            case .refuse("reauth"):
                self.log("  answer: reauth")
                self.verdict.text = "#\(self.presses): ASKED to re-authenticate"
            case .refuse(let w):
                self.log("  answer: \(w)")
                self.verdict.text = "#\(self.presses): refused (\(w))"
            default:
                self.log("  answer: \(r)")
            }
        }
    }

    private func watchLifecycle() {
        let nc = NotificationCenter.default
        let watch: [(Notification.Name, String)] = [
            (UIScene.didEnterBackgroundNotification, "scene entered background"),
            (UIScene.willEnterForegroundNotification, "scene returning"),
            (UIApplication.protectedDataWillBecomeUnavailableNotification, "protected data going away (device lock)"),
            (UIApplication.protectedDataDidBecomeAvailableNotification, "protected data back (unlock)"),
            (UIApplication.significantTimeChangeNotification, "significant time change"),
            (.NSSystemClockDidChange, "system clock changed"),
        ]
        for (name, label) in watch {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                // read AFTER the app's own handlers have run for this event
                DispatchQueue.main.async {
                    // live() never extends a session, so reading it can't change the next Sign's answer
                    let state = EditorViewController.identitySession.live() ? "session still live" : "session ended"
                    self?.events.append(label)
                    self?.log("event: \(label) at \(Self.stamp()); \(state)")
                }
            })
        }
    }

    private func log(_ s: String) {
        lines.append(s)
        if let path = ProcessInfo.processInfo.environment["BENTO_RIG_STAGE0"] {
            try? (lines.joined(separator: "\n") + "\n").write(toFile: path, atomically: true, encoding: .utf8)
        }
        output.text = lines.joined(separator: "\n")
        output.scrollRangeToVisible(NSRange(location: (output.text as NSString).length, length: 0))
    }

    @objc private func copyResults() {
        log("device-owner check available: \(Self.ownerCheck())")
        UIPasteboard.general.string = lines.joined(separator: "\n")
        verdict.text = "Copied \(lines.count) lines."
    }

    @objc private func close() { dismiss(animated: true) }

    private static func ownerCheck() -> String {
        var err: NSError?
        let ok = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &err)
        return ok ? "yes" : "no (\(err?.localizedDescription ?? "unknown"))"
    }

    private static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: Date())
    }
}
#endif
