// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.tray

import android.content.Context
import android.util.Base64
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
 * a document from a template is a different act, and `tray/webext` draws the
 * line in the same place. The result is cached, so only the first "New" of a
 * given release needs a connection.
 *
 * VERIFICATION IS NOT OPTIONAL HERE. The bytes become an executable HTML
 * document on the user's own disk that they will afterwards trust, so an
 * unverified download lets a network attacker choose what they create. Both
 * halves are checked, exactly as `kernel/src/update.ts` does it: the manifest's
 * ECDSA signature, and then the shell's sha256 as pinned by the signed payload.
 * (`tray/webext`'s equivalent does neither — raised separately.)
 */
object Releases {

    private const val TAG = "BentoTray"

    /** The apps a new document can be. Mirrors `APPS` in
     *  `tray/webext/src/library.js`; adding one here is the whole integration,
     *  because nothing else in this app asks which Bento a document is. */
    data class App(val id: String, val label: String, val blurb: String) {
        val manifest get() = "https://bento.page/releases/$id/manifest.json"
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
    fun seedFor(c: Context, app: App): ByteArray {
        val envelope = get(app.manifest)
        val payload = verify(String(envelope, Charsets.UTF_8))

        val version = payload.optString("version").ifEmpty {
            throw Failed("the release server did not name a version")
        }
        val url = payload.optString("url").ifEmpty {
            throw Failed("the release server did not offer a build")
        }
        val want = payload.optString("sha256").lowercase().ifEmpty {
            throw Failed("the release is not pinned to a hash")
        }

        cached(c, app, version)?.let { return it }

        val shell = get(url)
        val got = MessageDigest.getInstance("SHA-256").digest(shell)
            .joinToString("") { "%02x".format(it) }
        // The signed payload pins this. A mismatch means the bytes are not the
        // release the maintainer signed, whatever the server said.
        if (got != want) throw Failed("the downloaded app did not match its signed hash — refusing it")

        put(c, app, version, shell)
        return shell
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
                verify(derOf(Base64.decode(sig, Base64.DEFAULT)))
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

    private fun b64url(s: String): ByteArray =
        Base64.decode(s, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

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
