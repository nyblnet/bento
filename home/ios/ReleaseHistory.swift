// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import Foundation

/// Each app's signed release history (K4), which gate 1 checks documents against.
///
/// - A copy is BUNDLED at build time (`release-history/<app>.json` in the app's
///   resources). It's verified with the release key on first read like a fetched
///   copy, and it's the anti-rollback floor.
/// - A newer copy is fetched only when the person asks for something that
///   needs the network anyway: a New document, or an explicit check for updates.
///   Never on open or launch, which would tell the server when documents open.
///   Offline, the held copy is used.
/// - A fetched copy replaces the held one only through `Gate1.acceptHistory`: it
///   must keep every entry already held, unchanged, and never roll back.
///
/// The bytes are kept as fetched (the `{ payload, sig }` envelope) and verified
/// again on every read, so the copy on disk is never trusted for being there.
enum ReleaseHistory {
    static func url(_ app: String) -> String { "https://bento.page/releases/\(app)/history.json" }

    /// The name a history carries INSIDE its signed payload: the release tooling's
    /// `appId` (scripts/apps.mjs), which is "bento-" + the app's directory. The
    /// directory names the file and the URL; the payload names the app. The
    /// release-build check fails if apps.mjs ever breaks this rule.
    static func historyApp(_ dir: String) -> String { "bento-\(dir)" }

    /// Where histories come from and are kept, and what they're verified with.
    /// The app uses `.app`; the rig points both elsewhere and signs with a test key.
    struct Store {
        let bundled: (String) -> Data?
        let heldDir: URL?
        let verify: (Data, Data) -> Bool
        static let app = Store(
            bundled: { name in Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "release-history").flatMap { try? Data(contentsOf: $0) } },
            // a folder of our own: on an unsandboxed Mac, Application Support is the
            // person's shared folder, not a container
            heldDir: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
                .appendingPathComponent(Bundle.main.bundleIdentifier ?? "page.bento.home", isDirectory: true)
                .appendingPathComponent("release-history", isDirectory: true),
            verify: ReleaseKeys.verify)
        func held(_ app: String) -> URL? { heldDir?.appendingPathComponent("\(app).json") }
    }

    /// The newest verified history this device holds for `app`, or nil when it
    /// holds none (gate 1 then calls every document unknown).
    static func current(_ app: String, in store: Store = .app) -> JSON? {
        #if DEBUG
        if store.heldDir == Store.app.heldDir, let rig = rigHistory() { return rig }
        #endif
        let floor = store.bundled(app).flatMap { open($0, app: app, in: store) }
        guard let held = store.held(app).flatMap({ try? Data(contentsOf: $0) }).flatMap({ open($0, app: app, in: store) }) else { return floor }
        // a held copy counts only while it's a valid successor of the floor
        if let floor, Gate1.acceptHistory(held: floor, incoming: held, app: historyApp(app)) != .ok { return floor }
        return held
    }

    /// Every history this host holds, one per app that has one. Gate 1 judges a
    /// document against all of them (Gate1.verifyServedHeld), never one picked by
    /// a name read from the file. Each is a distinct app's: its payload must name
    /// that app, so two held histories are never the same one.
    static func held(_ apps: [String] = Releases.apps.map(\.id), in store: Store = .app) -> [JSON] {
        #if DEBUG
        // the rig's single test history stands in for every app: hold it ONCE
        if store.heldDir == Store.app.heldDir, let rig = rigHistory() { return [rig] }
        #endif
        return apps.compactMap { current($0, in: store) }
    }

    enum Refresh: Equatable { case updated, unchanged, refused(String), failed(String) }

    /// Fetch the published history and keep it if it's a valid successor of
    /// what's held. Call only from something the person asked for.
    static func refresh(_ app: String, in store: Store = .app) async -> Refresh {
        let data: Data
        do { data = try await Releases.fetch(url(app)) } catch { return .failed(error.localizedDescription) }
        return accept(data, app: app, in: store)
    }

    /// The decision, apart from the network, so the rig can drive it.
    static func accept(_ data: Data, app: String, in store: Store = .app) -> Refresh {
        guard let incoming = open(data, app: app, in: store) else { return .refused("not a valid signed history for \(app)") }
        let held = current(app, in: store)
        if let held, held == incoming { return .unchanged }
        switch Gate1.acceptHistory(held: held, incoming: incoming, app: historyApp(app)) {
        case .refused(let why): return .refused(why)
        case .ok:
            guard let dest = store.held(app) else { return .failed("no place to keep it") }
            do {
                try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: dest, options: .atomic)
            } catch { return .failed(error.localizedDescription) }
            return .updated
        }
    }

    /// A verified, well-formed history for this app, or nil.
    static func open(_ envelope: Data, app: String, in store: Store = .app) -> JSON? {
        guard let h = Gate1.openSigned(envelope, verify: store.verify),
              Gate1.historyProblems(h).isEmpty, h["app"]?.string == historyApp(app) else { return nil }
        return h
    }

    #if DEBUG
    /// scripts/test-home-gate1-host.mjs: the corpus's history and TEST key stand
    /// in for the release one. DEBUG builds only.
    private static func rigHistory() -> JSON? {
        let env = ProcessInfo.processInfo.environment
        guard let h = env["BENTO_RIG_HISTORY"], let k = env["BENTO_RIG_HISTORY_KEY"],
              let hd = FileManager.default.contents(atPath: h), let kd = FileManager.default.contents(atPath: k),
              let key = Gate1.publicKey(jwk: kd) else { return nil }
        return Gate1.openSigned(hd, publicKey: key)
    }
    #endif
}
