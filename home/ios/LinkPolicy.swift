// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import Foundation

/// What the editor does with a navigation: load it in place, or keep the
/// document on screen and (for a web or mail link) hand it to the system.
///
/// Foundation-only, so the whole decision table can be checked standalone with
/// `swiftc` rather than only by tapping links in a simulator. The delegate in
/// EditorViewController applies the answer; it decides nothing itself.
///
/// Mirrors home/android's `shouldOverrideUrlLoading` rule for rule.
enum LinkPolicy {
    enum Decision: Equatable {
        /// Load it in the editor.
        case allow
        /// Keep the document; open this URL in the system instead.
        case openExternally(URL)
        /// Keep the document; do nothing else.
        case drop
    }

    /// Schemes worth handing to the system. Anything else that would leave the
    /// document is dropped rather than launching some other app on its say-so.
    static let external: Set<String> = ["http", "https", "mailto"]

    /// - Parameters:
    ///   - url: where the navigation goes.
    ///   - replacesDocument: true for the main frame and for a new window
    ///     (a nil target frame); false for a frame inside the document.
    ///   - documentHost: the host the document itself is served from.
    static func decide(_ url: URL?, replacesDocument: Bool, documentHost: String) -> Decision {
        // A frame inside the document loading its own content is the
        // document's business, not a navigation of it.
        guard replacesDocument else { return .allow }
        if url?.scheme == "bento-tray", url?.host == documentHost { return .allow }
        if let url, external.contains(url.scheme?.lowercased() ?? "") { return .openExternally(url) }
        return .drop
    }
}
