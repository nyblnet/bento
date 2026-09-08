// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ app: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let cfg = UISceneConfiguration(name: "Default", sessionRole: session.role)
        cfg.delegateClass = SceneDelegate.self
        return cfg
    }
}
