// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit

/// Typing the recovery code on a new device. The decisions are RecoveryFlow's;
/// this only asks it and says what came back.
///
/// Memory is asked BEFORE the field is offered: a phone that can't spare Argon2id's
/// 64 MiB sees why, instead of a box that would fail, and nothing it says there
/// counts as a wrong code. Nothing opens this yet: the directory that serves the
/// blob (D1) isn't live, so the host has no `Material` to give it.
final class RecoveryViewController: UIViewController {
    private var flow = RecoveryFlow()
    private let material: RecoveryFlow.Material
    private let onRestored: (IdentityRecovery.BlobKeys) -> Void

    private let field = UITextField()
    private let button = UIButton(type: .system)
    private let status = UILabel()

    init(material: RecoveryFlow.Material, onRestored: @escaping (IdentityRecovery.BlobKeys) -> Void) {
        self.material = material
        self.onRestored = onRestored
        super.init(nibName: nil, bundle: nil)
        title = "Recovery code"
    }
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        field.placeholder = "XXXX-XXXX-XXXX-XXXX-X"
        field.font = .monospacedSystemFont(ofSize: 18, weight: .regular)
        field.autocapitalizationType = .allCharacters
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.borderStyle = .roundedRect
        field.accessibilityLabel = "Recovery code"

        button.setTitle("Recover", for: .normal)
        button.addTarget(self, action: #selector(tryCode), for: .touchUpInside)

        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel

        let stack = UIStackView(arrangedSubviews: [field, button, status])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
        refresh()
    }

    /// the field is offered only where the derivation can run
    private func refresh() {
        let ok = flow.available
        field.isEnabled = ok
        button.isEnabled = ok
        if !ok { status.text = Self.message(.unavailable) }
    }

    @objc private func tryCode() {
        button.isEnabled = false
        let typed = field.text ?? ""
        status.text = "Checking…"
        // Argon2id takes a second or more: off the main thread, and the flow is a value copied back
        var f = flow
        let m = material
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let outcome = f.attempt(typed, m)
            DispatchQueue.main.async {
                guard let self else { return }
                self.flow = f
                if case .restored(let keys) = outcome { self.onRestored(keys); return }
                self.status.text = Self.message(outcome)
                self.refresh()
                if self.flow.available { self.button.isEnabled = true }
            }
        }
    }

    static func message(_ o: RecoveryFlow.Outcome) -> String {
        switch o {
        case .unavailable:
            return "Recovery can't run on this device right now: it needs more free memory than is available. " +
                "Close other apps and try again. Nothing was tried, so this isn't counted against you."
        case .notACode(let why):
            switch why {
            case "check": return "That doesn't look right. Check the last character and try again."
            case "length": return "A recovery code has 16 letters and numbers, then one more character."
            default: return "A recovery code uses only letters and numbers."
            }
        case .wrongCode: return "That code didn't open your account."
        case .blobRejected: return "The code is right, but the saved keys don't match this account. Nothing was changed."
        case .restored: return ""
        }
    }
}
