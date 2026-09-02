// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit

/// A `.bento.html` opened IN PLACE from Files/iCloud/Dropbox.
///
/// UIDocument is what makes the whole app worth building: it is the only way to
/// write back to the user's actual file on iOS. Every browser there is WebKit,
/// so the File System Access API does not exist and the web app can only ever
/// hand back downloaded copies.
///
/// The bytes are kept as Data and handed to the web view untouched. The app
/// never parses, rewrites or "understands" the document — it is a courier. That
/// is deliberate: the file carries its own runtime, so a deck saved by any past
/// or future version of Bento opens correctly without this app knowing anything
/// about the format.
final class BentoDocument: UIDocument {
    var html: Data = Data()

    override func contents(forType typeName: String) throws -> Any { html }

    override func load(fromContents contents: Any, ofType typeName: String?) throws {
        guard let data = contents as? Data else { return }
        html = data
    }
}
