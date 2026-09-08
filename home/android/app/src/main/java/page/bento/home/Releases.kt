// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64

/**
 * Where a NEW document comes from.
 *
 * **Starter decks are never bundled.** They change often, and there are already
 * three apps with more coming — so a bundled seed means either picking one
 * arbitrarily or shipping several copies of Bento inside the app, each stale
 * from the moment it was built. Measured before this changed: the single
 * bundled slides seed was 517,161 bytes, **81% of a 630,851-byte release APK**.
 *
 * So the shell is fetched from the same signed release channel a document uses
 * to update itself, which also means a document created here is the version
 * everyone else has, the same day.
 *
 * THIS IS THE ONE THING THE HOST FETCHES. The app makes no other network request
 * — no update check of its own, no telemetry. `docs/PLATFORM.md` §1 requires no
 * network to OPEN, EDIT, PRESENT or SAVE, and none of those touch this; creating
 * a document from a template is a different act, and `home/webext` draws the
 * line in the same place. The result is cached, so only the first "New" of a
 * given release needs a connection.
 *
 * VERIFICATION IS NOT OPTIONAL HERE. The bytes become an executable HTML
 * document on the user's own disk that they will afterwards trust, so an
 * unverified download lets a network attacker choose what they create. Both
 * halves are checked, exactly as `kernel/src/update.ts` does it: the manifest's
 * ECDSA signature, and then the shell's sha256 as pinned by the signed payload.
 * (`home/webext`'s equivalent does neither — raised separately.)
 */
object Releases {

    private const val TAG = "BentoTray"

    /** The apps a new document can be. Mirrors `APPS` in
     *  `home/webext/src/library.js`; adding one here is the whole integration,
     *  because nothing else in this app asks which Bento a document is. */
    data class App(val id: String, val label: String, val blurb: String) {
        val manifest get() = "https://bento.page/releases/$id/manifest.json"
        /** What a manifest for this app must call itself. Compared against what
         *  the CALLER asked for, never against what the payload claims. */
        val appId get() = "bento-$id"
    }

    val APPS = listOf(
        App("slides", "Slides", "Presentations"),
        App("spaces", "Spaces", "Notes and pages"),
        App("dash", "Dash", "Data and sheets"),
    )

    /** Release signing PUBLIC key, copied from `kernel/src/update.ts`. The
     *  private half lives offline with the maintainer. Rotating it orphans every
     *  previously shipped file, so the key is guarded rather than rotated. */
    private const val KEY_X = "GMHSKwWcAoJVq-Dz1ZxWZM6TXATWIKbaQBpjoTystH8"
    private const val KEY_Y = "flFNzbdXCmJN8RQYCeG71rBZnnbN-MCEnp1EbCLFrj0"

    private const val TIMEOUT = 20_000

    class Failed(message: String) : Exception(message)

    /**
     * The current signed shell for [app], from cache when we already have it.
     *
     * Blocking — call it off the main thread.
     */
    fun seedFor(c: Context, app: App): ByteArray =
        resolve(app, Deps(
            get = ::get,
            readFloor = { key -> floors(c).getString(key, null) },
            writeFloor = { key, v -> floors(c).edit().putString(key, v).apply() },
            cached = { v -> cached(c, app, v) },
            store = { v, b -> put(c, app, v, b) },
        ))

    /**
     * Everything the network can lie about, in the order it has to be checked.
     *
     * Dependencies are injected so the sequence can be tested on the JVM without
     * a device — the two cases that matter (a high version whose bytes fail, and
     * an equal version) are exactly the ones nobody exercises by hand.
     */
    internal class Deps(
        val get: (String) -> ByteArray,
        val readFloor: (String) -> String?,
        val writeFloor: (String, String) -> Unit,
        val cached: (String) -> ByteArray? = { null },
        val store: (String, ByteArray) -> Unit = { _, _ -> },
    )

    internal fun resolve(app: App, d: Deps): ByteArray {
        // Only slides has a published channel today; spaces and dash 404. Say so
        // rather than surfacing an HTTP code — the app list is aspirational on
        // purpose, so an unreleased one is an expected answer, not a fault.
        val envelope = try { d.get(app.manifest) } catch (e: Failed) {
            if (e.message?.contains("404") == true)
                throw Failed("${app.label} has not been released yet")
            throw e
        }
        // The signature is checked HERE, over the exact bytes that arrived, and
        // everything after it works from the verified payload. Split so the
        // ORDER of the remaining checks can be tested on the JVM without
        // manufacturing a signing key — the sequence is what gets these wrong,
        // not the crypto.
        val payload = verify(String(envelope, Charsets.UTF_8))
        return resolveVerified(app, parse(payload), d)
    }

    /**
     * What a verified payload says, as data.
     *
     * The seam is a struct rather than a JSON string on purpose: `org.json` is
     * an Android STUB on the JVM rig, so a seam that parses there would be
     * testing the stub. Parsing happens once, on the device side of the line;
     * the ORDER of the checks — which is what gets these wrong — is then pure.
     */
    internal data class Release(
        val app: String?, val version: String, val url: String, val sha256: String,
    )

    private fun parse(payload: JSONObject): Release = Release(
        // "" for an absent field, normalised to null so the identity check
        // below compares a genuine absence rather than an empty string.
        app = payload.optString("app").ifEmpty { null },
        version = payload.optString("version").ifEmpty {
            throw Failed("the release server did not name a version")
        },
        url = payload.optString("url").ifEmpty {
            throw Failed("the release server did not offer a build")
        },
        sha256 = payload.optString("sha256").lowercase().ifEmpty {
            throw Failed("the release is not pinned to a hash")
        },
    )

    internal fun resolveVerified(app: App, r: Release, d: Deps): ByteArray {
        // IDENTITY. A genuinely signed bento-slides manifest served on the dash
        // channel passes the signature AND the digest — every byte authentic,
        // just not what was asked for. Compared against the app the CALLER
        // wanted, never against what the payload says about itself.
        //
        // An ABSENT field must not read as a match. `named` is null when the
        // field is missing and `want` is never null, so the comparison already
        // refuses it — tidying this to `if (named != null && named != want)`
        // would silently turn a missing field into a pass, which is the hole
        // home/webext had.
        val want = app.appId
        val named = r.app
        if (named != want) {
            throw Failed("the release channel offered ${named ?: "an unnamed app"}, not $want — refusing it")
        }

        val version = r.version

        // NO DOWNGRADES. Everything above passes for a replayed OLD release: it
        // is genuinely signed, it names the right app, and its shell really does
        // hash to its pin. Every byte authentic — just last month's. That is
        // what survives an origin or CDN compromise where the attacker can
        // re-serve but cannot forge, so remembering is the only thing that
        // catches it. kernel/src/update.ts refuses to go backwards too, but it
        // has its own build version to compare against; a host that CREATES
        // documents has nothing to compare against but what it has seen.
        val floor = readFloor(app, d)
        if (floor != null && compareVersions(version, floor) < 0) {
            throw Failed(
                "the ${app.label} channel offered $version, older than the $floor " +
                    "already seen — refusing it"
            )
        }

        d.cached(version)?.let { return it }

        val shell = d.get(r.url)
        val got = MessageDigest.getInstance("SHA-256").digest(shell)
            .joinToString("") { "%02x".format(it) }
        if (got != r.sha256) throw Failed("the downloaded app did not match its signed hash — refusing it")

        // Raised only NOW, after the bytes passed their digest. Raising it on a
        // merely-verified manifest would let one forged-but-unfetchable release
        // naming 9.9.9 lock this device out of every real release below it —
        // turning a failed attack into a permanent denial of service.
        raiseFloor(app, version, floor, d)

        d.store(version, shell)
        return shell
    }

    // ------------------------------------------------------------------- floor

    private fun floorKey(app: App) = "release-floor:${app.id}"

    /** An unreadable store reads as NO FLOOR, not as a refusal. Private mode,
     *  quota, a migration mid-flight — being unable to remember must not mean
     *  being unable to create a document. */
    private fun readFloor(app: App, d: Deps): String? =
        try { d.readFloor(floorKey(app))?.ifEmpty { null } } catch (_: Exception) { null }

    private fun raiseFloor(app: App, version: String, floor: String?, d: Deps) {
        // EQUAL is not a downgrade. Re-fetching the version already seen is the
        // normal case — the second document somebody creates — so treating it as
        // a rollback would break the + button on its SECOND USE rather than at
        // some exotic edge.
        if (floor != null && compareVersions(version, floor) <= 0) return
        // Best effort: a floor that cannot be written costs protection next
        // time, not this document.
        try { d.writeFloor(floorKey(app), version) } catch (_: Exception) { }
    }

    /**
     * The kernel's comparison semantics, not a third set.
     *
     * Note what JavaScript's `(pa[i] || 0) - (pb[i] || 0)` actually does with a
     * component that will not parse: `Number('1a')` is NaN, NaN is FALSY, so it
     * coerces to 0 rather than propagating. A strange version can therefore fail
     * to RAISE the floor but can never block a release. `toIntOrNull() ?: 0`
     * reproduces that exactly.
     */
    internal fun compareVersions(a: String, b: String): Int {
        val pa = a.split(".")
        val pb = b.split(".")
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val d = (pa.getOrNull(i)?.toIntOrNull() ?: 0) - (pb.getOrNull(i)?.toIntOrNull() ?: 0)
            if (d != 0) return d
        }
        return 0
    }

    // ------------------------------------------------------------------ crypto

    /**
     * Verify the `{payload, sig}` envelope and return the parsed payload.
     *
     * The signature covers the EXACT payload string bytes — no canonicalisation,
     * no re-serialisation. Parse it for reading only, never to re-encode and
     * verify, or a byte-identical-looking round trip breaks the signature.
     */
    private fun verify(raw: String): JSONObject {
        val env = try { JSONObject(raw) } catch (e: Exception) {
            throw Failed("the release manifest is not valid JSON")
        }
        val payload = env.optString("payload")
        val sig = env.optString("sig")
        if (payload.isEmpty() || sig.isEmpty()) throw Failed("the release manifest is malformed")

        val params = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(ECParameterSpec::class.java)

        val point = ECPoint(BigInteger(1, b64url(KEY_X)), BigInteger(1, b64url(KEY_Y)))
        val key = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params))

        val ok = try {
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(key)
                update(payload.toByteArray(Charsets.UTF_8))
                verify(derOf(Base64.getMimeDecoder().decode(sig)))
            }
        } catch (e: Exception) {
            Log.w(TAG, "signature check errored", e); false
        }
        if (!ok) throw Failed("the release manifest signature is INVALID — refusing it")

        return try { JSONObject(payload) } catch (e: Exception) {
            throw Failed("the release payload is not valid JSON")
        }
    }

    /**
     * WebCrypto emits ECDSA signatures as RAW `r || s`; Java expects DER.
     *
     * This is the whole reason a correct-looking verification can fail: the
     * manifest is signed by `scripts/sign-release.mjs` through WebCrypto, so its
     * 64 bytes are two fixed-width integers, and handing those to
     * `SHA256withECDSA` unconverted is simply a bad signature. Silent, and
     * indistinguishable from tampering.
     */
    private fun derOf(raw: ByteArray): ByteArray {
        if (raw.size != 64) return raw   // already DER, or not something we made
        fun int(b: ByteArray): ByteArray {
            var i = 0
            while (i < b.size - 1 && b[i] == 0.toByte()) i++          // drop leading zeros
            var v = b.copyOfRange(i, b.size)
            if (v[0].toInt() and 0x80 != 0) v = byteArrayOf(0) + v    // keep it positive
            return byteArrayOf(0x02, v.size.toByte()) + v
        }
        val body = int(raw.copyOfRange(0, 32)) + int(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    /** java.util.Base64, not android.util.Base64: the Android one is a STUB in
     *  unit tests, and this routine is the part most worth testing. Available
     *  since API 26, which is minSdk. */
    private fun b64url(s: String): ByteArray = Base64.getUrlDecoder().decode(s)

    // ------------------------------------------------------------------- net

    private fun get(url: String): ByteArray {
        if (!url.startsWith("https://")) throw Failed("the release server offered a non-HTTPS build")
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = TIMEOUT
        c.readTimeout = TIMEOUT
        c.setRequestProperty("Cache-Control", "no-store")
        // ASK FOR BYTES, NOT A PAGE. HttpURLConnection's default Accept is
        // browser-shaped ("text/html, image/gif, …"), and bento.page sits behind
        // a CDN that INJECTS a tracking beacon into anything it believes is a
        // page being browsed. That made the download 359 bytes longer than the
        // release the maintainer signed, and the hash check below refused it —
        // correctly. `Accept: */*` asks for the artifact itself.
        //
        // The hash check is the actual defence and stays regardless: this header
        // avoids a known rewrite, it does not make the bytes trustworthy.
        c.setRequestProperty("Accept", "*/*")
        try {
            if (c.responseCode !in 200..299) throw Failed("the release server answered ${c.responseCode}")
            return c.inputStream.use { it.readBytes() }
        } finally {
            c.disconnect()
        }
    }

    // ----------------------------------------------------------------- cache

    /** Kept in filesDir, not cacheDir: this is what makes "New" work offline
     *  after the first time, so it should not evaporate under storage pressure
     *  the way a thumbnail happily can. */
    private fun floors(c: Context) =
        c.getSharedPreferences("releases", Context.MODE_PRIVATE)

    private fun cacheFile(c: Context, app: App, version: String) =
        File(File(c.filesDir, "seeds"), "${app.id}-$version.html")

    private fun cached(c: Context, app: App, version: String): ByteArray? {
        val f = cacheFile(c, app, version)
        return if (f.exists() && f.length() > 0) try { f.readBytes() } catch (_: Exception) { null }
        else null
    }

    private fun put(c: Context, app: App, version: String, bytes: ByteArray) {
        try {
            val f = cacheFile(c, app, version)
            f.parentFile?.mkdirs()
            f.writeBytes(bytes)
            // One release per app is enough to work offline; older ones are dead
            // weight the moment a newer one is cached.
            f.parentFile?.listFiles()
                ?.filter { it.name.startsWith("${app.id}-") && it.name != f.name }
                ?.forEach { it.delete() }
        } catch (e: Exception) {
            Log.w(TAG, "could not cache the seed", e)
        }
    }

    /** The newest cached shell for [app], whatever its version — the offline
     *  fallback when the release server cannot be reached at all. */
    fun anyCached(c: Context, app: App): ByteArray? =
        File(c.filesDir, "seeds").listFiles()
            ?.filter { it.name.startsWith("${app.id}-") }
            ?.maxByOrNull { it.lastModified() }
            ?.let { try { it.readBytes() } catch (_: Exception) { null } }
}
