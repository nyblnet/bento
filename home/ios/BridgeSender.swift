// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import Foundation

/// Whether a bridge message came from the open document itself.
///
/// Every op is checked, `begin` included: the top frame of this editor, served
/// from this document's own `bento-tray://<originHost>`. Anything else is
/// ignored without a reply. Android's equivalent is `allowedOriginRules` plus
/// `isMainFrame`.
///
/// Foundation-only, so the rule can be checked standalone with `swiftc`.
/// EditorViewController passes in what WebKit reports about the sender
/// (`message.frameInfo`); it decides nothing itself.
enum BridgeSender {
    static func accepts(isMainFrame: Bool, scheme: String, host: String, documentHost: String) -> Bool {
        guard isMainFrame else { return false }
        guard scheme == "bento-tray", host == documentHost, !documentHost.isEmpty else { return false }
        return true
    }
}
