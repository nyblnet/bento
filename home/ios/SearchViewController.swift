// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit
import UniformTypeIdentifiers

/// Find a document by something inside it.
///
/// This screen SITS BESIDE `UIDocumentBrowserViewController` rather than
/// replacing it, which is the whole shape of the decision in `docs/DECISIONS.md`
/// (2026-08-16). The browser is not a list — it is Files, iCloud Drive, every
/// File Provider on the device, drag-and-drop, rename in place, favourites and
/// tags — and none of that is worth trading for a search field. So the browser
/// stays the root and this is one button away from it, answering the one
/// question the browser cannot: which document was the one that said this?
final class SearchViewController: UIViewController {

    /// Handing the opening back rather than doing it here: the browser already
    /// knows how to open a document in place, and two code paths that open
    /// documents is how one of them ends up subtly different.
    var onOpen: ((URL) -> Void)?

    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private let search = UISearchController(searchResultsController: nil)
    private let empty = UILabel()
    /// The mark and wordmark sit above the empty state's text. This is the one
    /// screen in the app that is OURS rather than the system's — the document
    /// browser is deliberately left as iOS designed it — so it is the right and
    /// only place to say whose app this is.
    private let brand = Brand.lockup("home", side: 34, style: .title2)
    private var hits: [SearchHit] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Search"
        view.backgroundColor = .systemGroupedBackground
        view.tintColor = Brand.accent

        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .close, target: self, action: #selector(close))
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            image: UIImage(systemName: "folder.badge.plus"), style: .plain,
            target: self, action: #selector(folders))

        search.searchResultsUpdater = self
        search.obscuresBackgroundDuringPresentation = false
        search.searchBar.placeholder = "Title, file name, or a phrase inside"
        // A phrase from inside a document is not a sentence, and the keyboard
        // capitalising it is a small lie about what is being matched — the
        // search itself is case-insensitive either way.
        search.searchBar.autocapitalizationType = .none
        search.searchBar.autocorrectionType = .no
        navigationItem.searchController = search
        navigationItem.hidesSearchBarWhenScrolling = false
        definesPresentationContext = true

        table.dataSource = self
        table.delegate = self
        table.register(HitCell.self, forCellReuseIdentifier: "hit")
        table.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(table)

        empty.numberOfLines = 0
        empty.textAlignment = .center
        empty.textColor = .secondaryLabel
        empty.font = .preferredFont(forTextStyle: .callout)
        empty.adjustsFontForContentSizeCategory = true
        empty.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(empty)

        brand.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(brand)

        NSLayoutConstraint.activate([
            table.topAnchor.constraint(equalTo: view.topAnchor),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            // The lockup and the text are one block, centred together: pinning the
            // text to the centre and hanging the mark above it drifts as Dynamic
            // Type changes the text's height.
            brand.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            brand.bottomAnchor.constraint(equalTo: empty.topAnchor, constant: -20),
            empty.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            empty.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 40),
            empty.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -40),
        ])

        LibraryIndex.shared.onChange = { [weak self] in self?.refresh() }
        refresh()
        LibraryIndex.shared.reindex()
    }

    private func refresh() {
        hits = LibraryIndex.shared.search(search.searchBar.text ?? "")
        table.reloadData()
        let granted = !FolderGrants.shared.isEmpty
        empty.isHidden = !hits.isEmpty
        brand.isHidden = !hits.isEmpty
        table.isHidden = hits.isEmpty
        empty.text = granted
            ? (search.isActive && !(search.searchBar.text ?? "").isEmpty
                ? "Nothing matches that."
                : "No Bento documents in the folders you have added yet.")
            // The permission is explained where it is asked for, not in a
            // settings screen nobody opens.
            : "Add a folder to search inside your documents.\n\nThe browser opens one file at a time; searching what a document SAYS means reading the folder it lives in."
    }

    @objc private func close() { dismiss(animated: true) }

    @objc private func folders() {
        let sheet = UIAlertController(title: "Folders", message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Add a folder…", style: .default) { [weak self] _ in
            self?.pickFolder()
        })
        for url in FolderGrants.shared.folders {
            sheet.addAction(UIAlertAction(title: "Remove “\(url.lastPathComponent)”", style: .destructive) { [weak self] _ in
                FolderGrants.shared.remove(url)
                LibraryIndex.shared.forget(folder: url)
                self?.refresh()
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItem
        present(sheet, animated: true)
    }

    private func pickFolder() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }
}

extension SearchViewController: UISearchResultsUpdating {
    func updateSearchResults(for searchController: UISearchController) { refresh() }
}

extension SearchViewController: UIDocumentPickerDelegate {
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        FolderGrants.shared.add(url)
        refresh()
        LibraryIndex.shared.reindex()
    }
}

extension SearchViewController: UITableViewDataSource, UITableViewDelegate {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { hits.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "hit", for: indexPath) as! HitCell
        cell.show(hits[indexPath.row], query: search.searchBar.text ?? "")
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let doc = hits[indexPath.row].document
        guard let url = LibraryIndex.shared.openableURL(for: doc) else { return }
        dismiss(animated: true) { [weak self] in self?.onOpen?(url) }
    }
}

/// Title, where it lives, and — when the match was on the prose — the words
/// that matched, with the query itself picked out. A prose result that does not
/// show the phrase is indistinguishable from a wrong result.
private final class HitCell: UITableViewCell {
    private let titleLabel = UILabel()
    private let whereLabel = UILabel()
    private let snippetLabel = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        titleLabel.font = .preferredFont(forTextStyle: .body)
        whereLabel.font = .preferredFont(forTextStyle: .caption1)
        whereLabel.textColor = .secondaryLabel
        snippetLabel.font = .preferredFont(forTextStyle: .caption1)
        snippetLabel.textColor = .secondaryLabel
        snippetLabel.numberOfLines = 2
        for label in [titleLabel, whereLabel, snippetLabel] {
            label.adjustsFontForContentSizeCategory = true
        }
        let stack = UIStackView(arrangedSubviews: [titleLabel, whereLabel, snippetLabel])
        stack.axis = .vertical
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8),
            stack.leadingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.trailingAnchor),
        ])
        accessoryType = .disclosureIndicator
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func show(_ hit: SearchHit, query: String) {
        let doc = hit.document
        titleLabel.text = doc.title
        var where_ = doc.folder
        if let app = doc.app { where_ += " · bento/\(app)" }
        if doc.encrypted { where_ += " · encrypted" }
        whereLabel.text = where_
        snippetLabel.isHidden = hit.snippet == nil
        snippetLabel.attributedText = hit.snippet.map { highlight($0, query: query) }
        // VoiceOver reads one sentence rather than three fragments.
        accessibilityLabel = [doc.title, where_, hit.snippet].compactMap { $0 }.joined(separator: ", ")
    }

    private func highlight(_ text: String, query: String) -> NSAttributedString {
        let out = NSMutableAttributedString(string: text)
        guard !query.isEmpty, let range = text.range(of: query, options: .caseInsensitive) else { return out }
        out.addAttributes([.foregroundColor: UIColor.label,
                           .font: UIFont.preferredFont(forTextStyle: .caption1).bold()],
                          range: NSRange(range, in: text))
        return out
    }
}

private extension UIFont {
    func bold() -> UIFont {
        guard let d = fontDescriptor.withSymbolicTraits(.traitBold) else { return self }
        return UIFont(descriptor: d, size: 0)
    }
}
