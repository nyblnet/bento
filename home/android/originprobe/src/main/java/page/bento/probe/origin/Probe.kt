// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.probe.origin

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

/**
 * Everything the probe computes that is not a platform call: the request JSON it
 * hands Credential Manager, the origin Android SHOULD report for this signing
 * key, the assetlinks.json the relying party must serve, and a readable report
 * of a registration or assertion response. Pure Kotlin, so the JVM rig tests it.
 */
object Probe {
    /** The fields WebAuthn defines for clientDataJSON; anything else is reported as extra. */
    val STANDARD_CLIENT_DATA_KEYS = setOf("type", "challenge", "origin", "crossOrigin", "topOrigin")

    /** P-256's group order, for the high-S count (a signature with s > n/2). */
    private val P256_N = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)

    fun b64u(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun unb64u(s: String): ByteArray = Base64.getUrlDecoder().decode(s.trimEnd('='))
    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    /** "AB:CD:…" — the form keytool, signingReport and assetlinks.json all use. */
    fun colonHex(b: ByteArray): String = b.joinToString(":") { "%02X".format(it) }

    /**
     * The origin Android puts in clientDataJSON for a native app: the SHA-256 of
     * the signing certificate (DER), base64url without padding. The probe shows
     * it next to the reported one, so a mismatch is visible at once.
     */
    fun apkKeyHashOrigin(certDer: ByteArray): String = "android:apk-key-hash:" + b64u(sha256(certDer))

    /**
     * The statement list the relying party serves at
     * https://<rp>/.well-known/assetlinks.json. Both relations, as in Google's
     * Credential Manager guide: get_login_creds is the one passkeys check;
     * handle_all_urls is harmless here (the probe declares no links to verify).
     */
    fun assetlinks(packageName: String, certSha256s: List<ByteArray>): String = buildString {
        append("[\n  {\n")
        append("    \"relation\": [\n")
        append("      \"delegate_permission/common.handle_all_urls\",\n")
        append("      \"delegate_permission/common.get_login_creds\"\n")
        append("    ],\n")
        append("    \"target\": {\n")
        append("      \"namespace\": \"android_app\",\n")
        append("      \"package_name\": ${Json.quote(packageName)},\n")
        append("      \"sha256_cert_fingerprints\": [\n")
        append(certSha256s.joinToString(",\n") { "        ${Json.quote(colonHex(it))}" })
        append("\n      ]\n    }\n  }\n]")
    }

    fun assetlinksCheckUrl(rpId: String): String =
        "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://$rpId" +
            "&relation=delegate_permission/common.get_login_creds"

    /** ES256 only, discoverable, user verification required: the shape a Bento ID passkey has. */
    fun createRequestJson(rpId: String, challenge: ByteArray, userId: ByteArray, userName: String): String =
        "{\"rp\":{\"id\":${Json.quote(rpId)},\"name\":\"Bento origin probe\"}," +
            "\"user\":{\"id\":${Json.quote(b64u(userId))},\"name\":${Json.quote(userName)},\"displayName\":${Json.quote(userName)}}," +
            "\"challenge\":${Json.quote(b64u(challenge))}," +
            "\"pubKeyCredParams\":[{\"type\":\"public-key\",\"alg\":-7}]," +
            "\"timeout\":120000,\"attestation\":\"none\"," +
            "\"authenticatorSelection\":{\"residentKey\":\"required\",\"requireResidentKey\":true,\"userVerification\":\"required\"}}"

    /** With a credential id, the sheet offers only that passkey; without one, any for the rp. */
    fun getRequestJson(rpId: String, challenge: ByteArray, credentialId: String?): String =
        "{\"rpId\":${Json.quote(rpId)},\"challenge\":${Json.quote(b64u(challenge))},\"timeout\":120000," +
            "\"userVerification\":\"required\"" +
            (if (credentialId == null) "" else ",\"allowCredentials\":[{\"type\":\"public-key\",\"id\":${Json.quote(credentialId)}}]") +
            "}"

    /** What one ceremony produced, as report lines, plus the credential id to sign in with next. */
    class Report(val lines: List<String>, val credentialId: String?)

    fun registration(responseJson: String, rpId: String, challenge: ByteArray, expectedOrigins: List<String>): Report {
        val out = ArrayList<String>()
        val root = Json.obj(Json.parse(responseJson)) ?: return Report(listOf("response is not a JSON object"), null)
        val resp = Json.obj(root["response"]) ?: emptyMap()
        val id = root["id"] as? String
        out += "credential id: $id"
        out += "authenticatorAttachment: ${root["authenticatorAttachment"]}"
        clientData(resp["clientDataJSON"] as? String, "webauthn.create", challenge, expectedOrigins, out)
        var authData: ByteArray? = (resp["authenticatorData"] as? String)?.let { unb64u(it) }
        val att = resp["attestationObject"] as? String
        if (att == null) out += "attestationObject: absent"
        else {
            val m = try { Cbor.decode(unb64u(att)) as? Map<*, *> } catch (e: Exception) { null }
            if (m == null) out += "attestationObject: not a CBOR map"
            else {
                out += "attestation format: ${m["fmt"]}"
                if (authData == null) authData = m["authData"] as? ByteArray
            }
        }
        out += "publicKeyAlgorithm (response): ${(resp["publicKeyAlgorithm"] as? Double)?.toLong()}"
        val ad = authData
        if (ad == null) out += "authenticatorData: absent" else authenticatorData(ad, rpId, out)
        out += "transports: ${(resp["transports"] as? List<*>)?.joinToString(",")}"
        out += "clientExtensionResults: ${keysOf(root["clientExtensionResults"])}"
        return Report(out, id)
    }

    fun assertion(responseJson: String, rpId: String, challenge: ByteArray, expectedOrigins: List<String>): Report {
        val out = ArrayList<String>()
        val root = Json.obj(Json.parse(responseJson)) ?: return Report(listOf("response is not a JSON object"), null)
        val resp = Json.obj(root["response"]) ?: emptyMap()
        val id = root["id"] as? String
        out += "credential id: $id"
        out += "authenticatorAttachment: ${root["authenticatorAttachment"]}"
        clientData(resp["clientDataJSON"] as? String, "webauthn.get", challenge, expectedOrigins, out)
        val ad = resp["authenticatorData"] as? String
        if (ad == null) out += "authenticatorData: absent" else authenticatorData(unb64u(ad), rpId, out)
        val sig = resp["signature"] as? String
        out += "signature: " + if (sig == null) "absent" else signatureNote(unb64u(sig))
        out += "userHandle: ${resp["userHandle"]}"
        return Report(out, id)
    }

    private fun keysOf(v: Any?): String = (v as? Map<*, *>)?.keys?.joinToString(",", "{", "}") ?: v.toString()

    private fun clientData(b64: String?, type: String, challenge: ByteArray, expectedOrigins: List<String>, out: MutableList<String>) {
        if (b64 == null) { out += "clientDataJSON: absent"; return }
        val text = String(unb64u(b64), Charsets.UTF_8)
        out += "clientDataJSON (raw): $text"
        val cd = Json.obj(Json.parse(text))
        if (cd == null) { out += "clientDataJSON: not a JSON object"; return }
        val origin = cd["origin"] as? String
        out += "origin: $origin"
        out += "origin is this app's apk-key-hash: " + when {
            origin == null -> "no origin"
            origin in expectedOrigins -> "yes"
            else -> "NO (expected ${expectedOrigins.joinToString(" or ")})"
        }
        out += "type: ${cd["type"]}" + if (cd["type"] == type) "" else "  (expected $type)"
        out += "challenge echoed: " + if (cd["challenge"] == b64u(challenge)) "yes" else "NO (${cd["challenge"]})"
        out += "crossOrigin: ${cd["crossOrigin"]}"
        out += "keys in order: ${cd.keys.joinToString(",")}"
        val extra = cd.keys.filter { it !in STANDARD_CLIENT_DATA_KEYS }
        out += "extra keys: " + if (extra.isEmpty()) "none" else extra.joinToString(", ") { "$it=${cd[it]}" }
    }

    private fun authenticatorData(ad: ByteArray, rpId: String, out: MutableList<String>) {
        if (ad.size < 37) { out += "authenticatorData: ${ad.size} bytes, too short"; return }
        val rpHashOk = ad.copyOfRange(0, 32).contentEquals(sha256(rpId.toByteArray(Charsets.UTF_8)))
        out += "rpIdHash is sha256(\"$rpId\"): " + if (rpHashOk) "yes" else "NO"
        val f = ad[32].toInt() and 0xff
        fun bit(m: Int) = if (f and m != 0) 1 else 0
        out += "flags: UP=${bit(0x01)} UV=${bit(0x04)} BE=${bit(0x08)} BS=${bit(0x10)} AT=${bit(0x40)} ED=${bit(0x80)} (0x%02x)".format(f)
        val count = ((ad[33].toLong() and 0xff) shl 24) or ((ad[34].toLong() and 0xff) shl 16) or
            ((ad[35].toLong() and 0xff) shl 8) or (ad[36].toLong() and 0xff)
        out += "signCount: $count"
        if (f and 0x40 == 0 || ad.size < 55) return
        out += "aaguid: " + ad.copyOfRange(37, 53).joinToString("") { "%02x".format(it) }
        val len = ((ad[53].toInt() and 0xff) shl 8) or (ad[54].toInt() and 0xff)
        if (ad.size < 55 + len) { out += "credential id length $len overruns authenticatorData"; return }
        val key = try { Cbor.decodePrefix(ad, 55 + len).first as? Map<*, *> } catch (e: Exception) { null }
        out += "COSE key alg: ${key?.get(3L)}  kty: ${key?.get(1L)}  crv: ${key?.get(-1L)}"
    }

    /** DER ECDSA (r, s): reports the format and whether s is high (> n/2). */
    fun signatureNote(der: ByteArray): String {
        val rs = derEcdsa(der) ?: return "${der.size} bytes, not DER ECDSA"
        val high = rs.second > P256_N.shiftRight(1)
        return "${der.size}-byte DER ECDSA, " + if (high) "HIGH-S (s > n/2)" else "low-S"
    }

    fun derEcdsa(der: ByteArray): Pair<BigInteger, BigInteger>? {
        var i = 0
        fun len(): Int { val b = der[i++].toInt() and 0xff; if (b < 0x80) return b
            var n = 0; repeat(b and 0x7f) { n = (n shl 8) or (der[i++].toInt() and 0xff) }; return n }
        fun int(): BigInteger { require(der[i++] == 0x02.toByte()); val l = len(); val v = BigInteger(1, der.copyOfRange(i, i + l)); i += l; return v }
        return try {
            require(der[i++] == 0x30.toByte()); val total = len(); require(i + total == der.size)
            val r = int(); val s = int(); require(i == der.size); r to s
        } catch (e: Exception) { null }
    }
}

/** The minimal CBOR reader the attestation object and the COSE key need. */
object Cbor {
    fun decode(b: ByteArray): Any? { val (v, end) = decodePrefix(b, 0); require(end == b.size) { "trailing bytes" }; return v }

    /** Decodes one item at [start]; returns it and the offset just past it. */
    fun decodePrefix(b: ByteArray, start: Int): Pair<Any?, Int> { val r = R(b, start); return r.item(0) to r.i }

    private class R(val b: ByteArray, var i: Int) {
        fun u8() = b[i++].toInt() and 0xff
        fun arg(ai: Int): Long = when {
            ai < 24 -> ai.toLong()
            ai == 24 -> u8().toLong()
            ai == 25 -> ((u8() shl 8) or u8()).toLong()
            ai == 26 -> (0 until 4).fold(0L) { a, _ -> (a shl 8) or u8().toLong() }
            ai == 27 -> (0 until 8).fold(0L) { a, _ -> (a shl 8) or u8().toLong() }
            else -> throw IllegalArgumentException("indefinite lengths are not used here")
        }
        fun bytes(n: Long): ByteArray { require(n >= 0 && i + n <= b.size); val v = b.copyOfRange(i, i + n.toInt()); i += n.toInt(); return v }
        fun item(depth: Int): Any? {
            require(depth < 16)
            val ib = u8(); val major = ib shr 5; val ai = ib and 0x1f
            return when (major) {
                0 -> arg(ai)
                1 -> -1 - arg(ai)
                2 -> bytes(arg(ai))
                3 -> String(bytes(arg(ai)), Charsets.UTF_8)
                4 -> { val n = arg(ai); (0 until n).map { item(depth + 1) } }
                5 -> { val n = arg(ai); val m = LinkedHashMap<Any?, Any?>(); for (k in 0 until n) { val key = item(depth + 1); m[key] = item(depth + 1) }; m }
                7 -> when (ai) { 20 -> false; 21 -> true; 22 -> null; else -> throw IllegalArgumentException("simple $ai") }
                else -> throw IllegalArgumentException("major type $major")
            }
        }
    }
}
