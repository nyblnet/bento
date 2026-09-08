// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit

/// The mark, the wordmark, and the four colours — in one place.
///
/// Everything here reads from `Assets.xcassets`, which is GENERATED from
/// `home/assets/home-icon.svg` by `home/assets/make-icons.mjs`. Nothing in this
/// file contains a hex value, deliberately: a colour typed into Swift is a colour
/// that can quietly disagree with the logo, and the app would simply be the wrong
/// navy forever with nothing to notice it. `make-icons.mjs --check` fails if the
/// catalog drifts from the mark.
enum Brand {

    // MARK: - Palette

    /// Falling back to a system colour rather than a literal keeps the no-hex rule
    /// honest: if an asset is ever missing, the app looks plain rather than
    /// looking *nearly* right, which is the failure that hides.
    private static func named(_ name: String, fallback: UIColor) -> UIColor {
        UIColor(named: name) ?? fallback
    }

    static var navy: UIColor { named("BentoNavy", fallback: .label) }
    static var cream: UIColor { named("BentoCream", fallback: .systemBackground) }
    static var steel: UIColor { named("BentoSteel", fallback: .systemBlue) }
    static var peach: UIColor { named("BentoPeach", fallback: .systemOrange) }

    /// The accent for interactive chrome.
    ///
    /// Steel, not peach. Peach is the wordmark's slash and the icon's brightest
    /// block — it earns its attention by being rare, and spending it on every bar
    /// button makes it ordinary. Steel is the same family and reads as a control.
    static var accent: UIColor { steel }

    /// Navy is a brand colour, not a text colour: on a dark interface it is nearly
    /// the background. Chrome that must stay legible asks for this instead, which
    /// keeps navy in light mode and hands dark mode back to the system.
    static var ink: UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark ? .label : navy
        }
    }

    // MARK: - The mark

    /// The app's mark as a rounded tile.
    ///
    /// The asset is the ICON artwork, whose navy ground is a full-bleed square —
    /// correct there, because iOS applies its own squircle mask to app icons.
    /// Nothing masks it inside the app, so the rounding is applied here rather
    /// than by shipping a second, nearly-identical asset to maintain.
    static func markView(side: CGFloat) -> UIView {
        let view = UIImageView(image: UIImage(named: "BentoMark"))
        view.contentMode = .scaleAspectFit
        view.clipsToBounds = true
        view.layer.cornerRadius = side * 0.22   // matches the icon's 7/32
        view.layer.cornerCurve = .continuous
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: side).isActive = true
        view.heightAnchor.constraint(equalToConstant: side).isActive = true
        view.isAccessibilityElement = false     // the wordmark beside it says the name
        return view
    }

    // MARK: - The wordmark

    /// `bento` + a peach slash + the app name, set to match the web editor's
    /// lockup: one weight throughout, the slash carrying the only colour.
    ///
    /// Rounded design, because the mark is all rounded rectangles and the system
    /// text face beside it looks like a different family. Scales with Dynamic Type
    /// rather than being pinned — a wordmark that ignores the reader's text size
    /// is a wordmark that looks broken at the sizes people actually use.
    static func wordmark(_ app: String = "home", style: UIFont.TextStyle = .title3) -> UILabel {
        let label = UILabel()
        let base = UIFont.preferredFont(forTextStyle: style)
        let size = base.pointSize
        let font = UIFont.systemFont(ofSize: size, weight: .bold)
        let rounded = font.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: size) } ?? font

        let text = NSMutableAttributedString()
        text.append(NSAttributedString(string: "bento", attributes: [.font: rounded, .foregroundColor: ink]))
        text.append(NSAttributedString(string: "/", attributes: [.font: rounded, .foregroundColor: peach]))
        text.append(NSAttributedString(string: app, attributes: [.font: rounded, .foregroundColor: ink]))

        label.attributedText = text
        label.adjustsFontForContentSizeCategory = true
        // Read as one word, not as three fragments with a slash in the middle.
        label.accessibilityLabel = "bento \(app)"
        return label
    }

    /// Mark and wordmark together, for a screen that needs to say whose it is.
    static func lockup(_ app: String = "home", side: CGFloat = 28,
                       style: UIFont.TextStyle = .title3) -> UIStackView {
        let stack = UIStackView(arrangedSubviews: [markView(side: side), wordmark(app, style: style)])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = side * 0.32
        return stack
    }
}
