// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    /// The device locked: the routine signing session ends with it.
    func applicationProtectedDataWillBecomeUnavailable(_ application: UIApplication) {
        EditorViewController.identitySession.lock()
    }

    func application(_ app: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let cfg = UISceneConfiguration(name: "Default", sessionRole: session.role)
        cfg.delegateClass = SceneDelegate.self
        return cfg
    }
}
