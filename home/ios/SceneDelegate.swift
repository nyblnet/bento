// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CoreSpotlight
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
        // …or a Spotlight result, which arrives as a user activity instead.
        for activity in options.userActivities where activity.activityType == CSSearchableItemActionType {
            DispatchQueue.main.async { [weak self] in self?.openSpotlight(activity) }
        }
        // The index is only as good as its last pass, and documents change
        // outside this app — that is the point of opening them in place.
        LibraryIndex.shared.reindex()
        #if DEBUG
        // scripts/test-home-snapshot-cover.mjs: open this file at launch
        if let path = ProcessInfo.processInfo.environment["BENTO_RIG_OPEN"] {
            DispatchQueue.main.async { [weak self] in self?.open(URL(fileURLWithPath: path)) }
        }
        #endif
    }

    // The app-switcher snapshot is written to disk: a sealed document is covered
    // before it's taken (see SnapshotCover). Not on the Mac, where window
    // previews aren't saved and a scene resigns active whenever focus moves.
    func sceneWillResignActive(_ scene: UIScene) {
        #if !targetEnvironment(macCatalyst)
        if let w = window, SnapshotCover.needed(in: w) { SnapshotCover.show(over: w) }
        #endif
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        if let w = window { SnapshotCover.hide(from: w) }
    }

    #if DEBUG
    /// scripts/test-home-snapshot-cover.mjs: what the window shows as it goes to
    /// the background, the moment the system takes its snapshot
    func sceneDidEnterBackground(_ scene: UIScene) {
        guard let path = ProcessInfo.processInfo.environment["BENTO_RIG_SNAPSHOT"], let w = window else { return }
        let image = UIGraphicsImageRenderer(bounds: w.bounds).image { _ in _ = w.drawHierarchy(in: w.bounds, afterScreenUpdates: false) }
        try? image.pngData()?.write(to: URL(fileURLWithPath: path))
    }
    #endif

    /// A result tapped in system Spotlight. The identifier is the one donated in
    /// `LibraryIndex.donate`, so it resolves through the index rather than being
    /// re-derived from a path that may since have moved.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        openSpotlight(userActivity)
    }

    private func openSpotlight(_ activity: NSUserActivity) {
        guard activity.activityType == CSSearchableItemActionType,
              let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
              let browser = window?.rootViewController as? DocumentBrowserViewController
        else { return }
        guard let doc = LibraryIndex.shared.document(withIdentifier: id),
              let url = LibraryIndex.shared.openableURL(for: doc) else { return }
        browser.openIndexed(url)
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
