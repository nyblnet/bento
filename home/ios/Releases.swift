// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation

/// Where a NEW document comes from.
///
/// **Starter decks are never bundled.** They change often, and there are already
/// three apps with more coming — so a bundled seed means either picking one
/// arbitrarily or shipping several copies of Bento inside the app, each stale
/// from the moment it was built. Measured on the Android host before this
/// changed: the single bundled slides seed was 517,161 bytes, **81% of a
/// 630,851-byte release APK**. The `.ipa` was never measured, but it staged the
/// same 686KB shell.
///
/// So the shell is fetched from the same signed release channel a document uses
/// to update itself, which also means a document created here is the version
/// everyone else has, the same day.
///
/// THIS IS THE ONE THING THE HOST FETCHES. The app makes no other network
/// request — no update check of its own, no telemetry. `docs/PLATFORM.md` §1
/// requires no network to OPEN, EDIT, PRESENT or SAVE, and none of those touch
/// this; creating a document from a template is a different act, and
/// `home/webext` draws the line in the same place. The result is cached, so only
/// the first "New" of a given release needs a connection.
///
/// VERIFICATION IS NOT OPTIONAL HERE. The bytes become an executable HTML
/// document on the user's own disk that they will afterwards trust, so an
/// unverified download lets a network attacker choose what they create. Both
/// halves are checked, exactly as `kernel/src/update.ts` does it: the manifest's
/// ECDSA signature, and then the shell's sha256 as pinned by the signed payload.
///
/// Deliberately a mirror of `home/android`'s `Releases.kt` — same apps, same
/// key, same order of checks, same refusal messages — so the two hosts cannot
/// answer differently. Two details there were learned the hard way and are
/// inherited rather than rediscovered: the Accept header (see `fetch`), and the
/// signature being raw `r || s` rather than DER (see `verify`).
enum Releases {

    /// The apps a new document can be. Mirrors `APPS` in
    /// `home/webext/src/library.js` and `Releases.kt`; adding one here is the
    /// whole integration, because nothing else in this app asks which Bento a
    /// document is.
    struct App: Equatable {
        let id: String
        let label: String
        let blurb: String
        var manifest: String { "https://bento.page/releases/\(id)/manifest.json" }
    }

    static let apps = [
        App(id: "slides", label: "Slides", blurb: "Presentations"),
        App(id: "spaces", label: "Spaces", blurb: "Notes and pages"),
        App(id: "dash", label: "Dash", blurb: "Data and sheets"),
    ]

    /// Release signing PUBLIC key, copied from `kernel/src/update.ts`. The
    /// private half lives offline with the maintainer. Rotating it orphans every
    /// previously shipped file, so the key is guarded rather than rotated.
    private static let keyX = "GMHSKwWcAoJVq-Dz1ZxWZM6TXATWIKbaQBpjoTystH8"
    private static let keyY = "flFNzbdXCmJN8RQYCeG71rBZnnbN-MCEnp1EbCLFrj0"

    private static let timeout: TimeInterval = 20

    struct Failed: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // MARK: - The release

    struct Release {
        let version: String
        let url: String
        let sha256: String
    }

    /// Verify an envelope and pull out what a download needs — including that it
    /// is a release of the app we ASKED for.
    ///
    /// That last check is not redundant with the signature, and it was missing
    /// here until `home/webext`'s own verification (PR #318) tested for it. Both
    /// a `bento-slides` manifest and a `bento-dash` one are genuinely signed by
    /// the same maintainer key, so serving the former on the latter's channel
    /// passes the signature AND the hash: every byte is authentic, just not the
    /// thing that was requested. Only identity catches a swap between two real
    /// releases. `home/android` does not check this either — reported.
    static func release(from raw: String, for app: App, notBefore floor: String? = nil) throws -> Release {
        let payload = try verify(raw)

        // The payload names the app as `bento-<id>`.
        let want = "bento-\(app.id)"
        guard let named = payload["app"] as? String, named == want else {
            let got = (payload["app"] as? String) ?? "nothing"
            throw Failed(message: "the \(app.label) channel served a release for \(got) — refusing it")
        }
        guard let version = payload["version"] as? String, !version.isEmpty else {
            throw Failed(message: "the release server did not name a version")
        }
        guard let url = payload["url"] as? String, !url.isEmpty else {
            throw Failed(message: "the release server did not offer a build")
        }
        guard let sha = (payload["sha256"] as? String)?.lowercased(), !sha.isEmpty else {
            throw Failed(message: "the release is not pinned to a hash")
        }
        // ROLLBACK REPLAY. A stale but GENUINE manifest passes every check above
        // — signature, app identity, and the digest of the shell it points at,
        // because all of it really was signed and really does match. It just
        // hands over an older release, which is how someone who can re-serve but
        // not forge pins new documents to a version with a known hole in it.
        //
        // `kernel/src/update.ts` already refuses to go backwards; a host that
        // CREATES documents had no such floor, because it has no version of its
        // own to compare against. The floor is therefore the highest version
        // this device has already accepted for this app.
        //
        // The cost is honest and worth stating: a deliberate rollback by the
        // maintainer — pulling a bad release — is refused too, until the version
        // number moves past it. That is the same trade update.ts makes, so at
        // least the two agree.
        if let floor, isOlder(version, than: floor) {
            throw Failed(message: "the \(app.label) channel offered \(version), older than the \(floor) "
                       + "this device already accepted — refusing it")
        }
        return Release(version: version, url: url, sha256: sha)
    }

    /// Dotted-numeric compare, enough for the versions this project mints. An
    /// unparsable component sorts as 0 rather than throwing: a strange version
    /// string should not be able to BLOCK an update, only fail to raise the floor.
    static func isOlder(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
        let y = b.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0
            let r = i < y.count ? y[i] : 0
            if l != r { return l < r }
        }
        return false
    }

    /// The highest version this device has accepted for `app`, if any.
    static func floor(for app: App) -> String? {
        UserDefaults.standard.string(forKey: "bento.tray.release-floor.\(app.id)")
    }

    private static func raiseFloor(_ app: App, to version: String) {
        if let current = floor(for: app), !isOlder(current, than: version) { return }
        UserDefaults.standard.set(version, forKey: "bento.tray.release-floor.\(app.id)")
    }

    // MARK: - The seed

    /// The current signed shell for `app`, from cache when we already have it.
    static func seed(for app: App) async throws -> Data {
        // Only slides has a published channel today; spaces and dash 404. Say so
        // rather than surfacing an HTTP code — the app list is aspirational on
        // purpose (adding an app here is the whole integration), so an unreleased
        // one is an expected answer, not a fault.
        let envelope: Data
        do {
            envelope = try await fetch(app.manifest)
        } catch let e as Failed where e.message.contains("404") {
            throw Failed(message: "\(app.label) has not been released yet")
        }

        let release = try release(from: String(decoding: envelope, as: UTF8.self),
                                  for: app, notBefore: floor(for: app))

        if let hit = cached(app, release.version) {
            raiseFloor(app, to: release.version)
            return hit
        }

        let shell = try await fetch(release.url)
        let got = SHA256.hash(data: shell).map { String(format: "%02x", $0) }.joined()
        // The signed payload pins this. A mismatch means the bytes are not the
        // release the maintainer signed, whatever the server said.
        guard got == release.sha256 else {
            throw Failed(message: "the downloaded app did not match its signed hash — refusing it")
        }

        // Only after the bytes have proven themselves. Raising the floor on a
        // manifest whose download then failed its hash would let a forged
        // manifest lock the device out of every real release below it.
        store(app, release.version, shell)
        raiseFloor(app, to: release.version)
        return shell
    }

    // MARK: - Crypto

    /// Verify the `{payload, sig}` envelope and return the parsed payload.
    ///
    /// The signature covers the EXACT payload string bytes — no canonicalisation,
    /// no re-serialisation. Parse it for reading only, never to re-encode and
    /// verify, or a byte-identical-looking round trip breaks the signature.
    ///
    /// `scripts/sign-release.mjs` signs through WebCrypto, which emits ECDSA
    /// signatures as RAW `r || s` — 64 bytes, two fixed-width integers.
    /// CryptoKit's `ECDSASignature(rawRepresentation:)` takes exactly that, so
    /// iOS needs no conversion. Noted because the Android host DOES: Java's
    /// `SHA256withECDSA` wants DER, and handing it the raw 64 bytes is simply a
    /// bad signature — silent, and indistinguishable from tampering. Anyone
    /// porting this a third time should check which their platform expects
    /// before concluding the manifest is broken.
    /// Internal rather than private so `scripts/test-tray-releases.mjs` can prove
    /// it REFUSES things. A verifier that has only ever been watched saying yes
    /// is indistinguishable from `return true`.
    static func verify(_ raw: String) throws -> [String: Any] {
        guard let data = raw.data(using: .utf8),
              let env = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw Failed(message: "the release manifest is not valid JSON") }

        let payloadField = env["payload"] as? String
        let sigField = env["sig"] as? String
        // An UNSIGNED manifest is refused as its own category, not as a parse
        // error. `{"url": …}` flat is exactly the shape the old broken reader
        // was reaching for, so saying "malformed" invites someone later to add a
        // lenient fallback for it as a compatibility gap. It is not a gap.
        if (payloadField ?? "").isEmpty && (sigField ?? "").isEmpty {
            throw Failed(message: "the release manifest is not signed — refusing it")
        }
        guard let payload = payloadField, !payload.isEmpty,
              let sig = sigField, !sig.isEmpty
        else { throw Failed(message: "the release manifest is malformed") }

        guard let x = b64url(keyX), let y = b64url(keyY),
              let key = try? P256.Signing.PublicKey(rawRepresentation: x + y)
        else { throw Failed(message: "the embedded release key is unusable") }

        guard let sigBytes = Data(base64Encoded: sig) ?? b64url(sig),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: sigBytes),
              key.isValidSignature(signature, for: Data(payload.utf8))
        else { throw Failed(message: "the release manifest signature is INVALID — refusing it") }

        guard let parsed = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any]
        else { throw Failed(message: "the release payload is not valid JSON") }
        return parsed
    }

    private static func b64url(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    // MARK: - Net

    private static func fetch(_ url: String) async throws -> Data {
        guard url.hasPrefix("https://"), let u = URL(string: url) else {
            throw Failed(message: "the release server offered a non-HTTPS build")
        }
        var req = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
                             timeoutInterval: timeout)
        // ASK FOR BYTES, NOT A PAGE — and this header is LOAD-BEARING, not
        // belt-and-braces. Measured against the live server 2026-08-17:
        //
        //   Accept: */*                       689,316 bytes — matches the pin
        //   Accept: text/html,…,*/*;q=0.8     689,675 bytes — does NOT
        //
        // Same URL, same `.bento.html` path, 359 bytes apart. The CDN injects a
        // Cloudflare analytics beacon before `</body>` when it believes the
        // response is a page being browsed, and the trigger is the ACCEPT
        // HEADER, not the extension — which is worth knowing precisely, because
        // if it were the path then no header would fix it for anyone.
        //
        // The injected file still carries an intact `id="bento-doc"`, so it
        // looks like a perfectly good document; only the hash tells them apart.
        // (An earlier note here said this had been fixed at the origin. It has
        // not — that was inherited second-hand and is wrong.)
        //
        // The hash check remains the actual defence: this header avoids a known
        // rewrite, it does not make the bytes trustworthy.
        req.setValue("*/*", forHTTPHeaderField: "Accept")
        req.setValue("no-store", forHTTPHeaderField: "Cache-Control")

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw Failed(message: "the release server gave no answer")
        }
        guard (200...299).contains(http.statusCode) else {
            throw Failed(message: "the release server answered \(http.statusCode)")
        }
        return data
    }

    // MARK: - Cache

    /// Kept in Application Support, not Caches: this is what makes "New" work
    /// offline after the first time, so it should not evaporate under storage
    /// pressure the way a thumbnail happily can.
    private static func seedsDir() -> URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                                 in: .userDomainMask).first?
            .appendingPathComponent("seeds") else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func cacheFile(_ app: App, _ version: String) -> URL? {
        seedsDir()?.appendingPathComponent("\(app.id)-\(version).html")
    }

    private static func cached(_ app: App, _ version: String) -> Data? {
        guard let f = cacheFile(app, version), let d = try? Data(contentsOf: f), !d.isEmpty
        else { return nil }
        return d
    }

    private static func store(_ app: App, _ version: String, _ bytes: Data) {
        guard let f = cacheFile(app, version), let dir = seedsDir() else { return }
        do { try bytes.write(to: f, options: .atomic) } catch { return }
        // One release per app is enough to work offline; older ones are dead
        // weight the moment a newer one is cached.
        let others = (try? FileManager.default.contentsOfDirectory(at: dir,
                                                                   includingPropertiesForKeys: nil)) ?? []
        for other in others where other.lastPathComponent.hasPrefix("\(app.id)-")
            && other.lastPathComponent != f.lastPathComponent {
            try? FileManager.default.removeItem(at: other)
        }
    }

    /// The newest cached shell for `app`, whatever its version — the offline
    /// fallback when the release server cannot be reached at all. Sound rather
    /// than a guess: it was verified when it was cached.
    static func anyCached(_ app: App) -> Data? {
        guard let dir = seedsDir(),
              let files = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return nil }
        let mine = files.filter { $0.lastPathComponent.hasPrefix("\(app.id)-") }
        let newest = mine.max { a, b in
            let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            return da < db
        }
        return newest.flatMap { try? Data(contentsOf: $0) }
    }
}
