// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let w = UIWindow(windowScene: ws)
        w.rootViewController = DocumentBrowserViewController()
        w.makeKeyAndVisible()
        window = w
        // COLD LAUNCH: the system can hand us a file as it starts the scene.
        // Deferred a runloop so the browser is on screen before it presents.
        if let url = options.urlContexts.first?.url {
            DispatchQueue.main.async { [weak self] in self?.open(url) }
        }
    }

    /// WARM: the app is already running and the system hands it another file.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        open(url)
    }

    /// A file arriving from outside is security-scoped: without the accessor the
    /// read fails silently and the document opens empty.
    private func open(_ url: URL) {
        guard let browser = window?.rootViewController as? DocumentBrowserViewController else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        browser.openIncoming(url)
    }
}
