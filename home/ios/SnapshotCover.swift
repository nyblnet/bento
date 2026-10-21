// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit

/// Hide document content in the app switcher while sealed.
///
/// iOS saves the app-switcher snapshot to disk, so while a sealed or password
/// document is open (its saved body is a bento/enc envelope), a plain cover goes
/// over the window as the scene resigns active and comes off when it's active
/// again. Unsealed documents are left alone.
///
/// Not on the Mac: Catalyst window previews aren't saved, and a scene there
/// resigns active every time another window takes focus.
enum SnapshotCover {
    /// the saved body is sealed: the same check the library index makes
    static func isSealed(_ html: Data) -> Bool {
        BentoIndex.isEncrypted(Array(String(decoding: html.prefix(BentoIndex.headBytes), as: UTF8.self).utf16))
    }

    private static let tag = 0x5EA1_0C0

    static func show(over window: UIWindow) {
        guard window.viewWithTag(tag) == nil else { return }
        let cover = UIView(frame: window.bounds)
        cover.tag = tag
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = .systemBackground
        let lock = UIImageView(image: UIImage(systemName: "lock.fill"))
        lock.tintColor = .secondaryLabel
        lock.translatesAutoresizingMaskIntoConstraints = false
        cover.addSubview(lock)
        NSLayoutConstraint.activate([
            lock.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            lock.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
            lock.widthAnchor.constraint(equalToConstant: 44),
            lock.heightAnchor.constraint(equalToConstant: 44),
        ])
        window.addSubview(cover)
    }

    static func hide(from window: UIWindow) {
        window.viewWithTag(tag)?.removeFromSuperview()
    }

    /// Every editor anywhere under `root`: presented, or a child of a container.
    static func editors(in root: UIViewController?) -> [EditorViewController] {
        guard let root else { return [] }
        var out: [EditorViewController] = []
        if let e = root as? EditorViewController { out.append(e) }
        for child in root.children { out += editors(in: child) }
        if let p = root.presentedViewController { out += editors(in: p) }
        return out
    }

    /// Whether this window shows a sealed document right now.
    static func needed(in window: UIWindow) -> Bool {
        editors(in: window.rootViewController).contains { $0.isSealed }
    }
}
