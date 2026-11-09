// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.probe.origin

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProbeTest {
    private val rp = "id.example.test"
    private val challenge = ByteArray(32) { it.toByte() }
    private val cert = "abc".toByteArray()   // stands in for a certificate: only its SHA-256 matters
    private val origin = Probe.apkKeyHashOrigin(cert)

    @Test fun originIsBase64urlOfTheCertSha256() {
        // sha256("abc") is the FIPS 180-2 test vector ba7816bf…15ad.
        assertEquals("android:apk-key-hash:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0", origin)
        assertEquals("BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD",
            Probe.colonHex(Probe.sha256(cert)))
    }

    @Test fun assetlinksIsTheStatementGooglePasskeysRead() {
        val v = Json.parse(Probe.assetlinks("page.bento.probe.origin", listOf(Probe.sha256(cert)))) as List<*>
        assertEquals(1, v.size)
        val st = v[0] as Map<*, *>
        assertTrue((st["relation"] as List<*>).contains("delegate_permission/common.get_login_creds"))
        val target = st["target"] as Map<*, *>
        assertEquals("android_app", target["namespace"])
        assertEquals("page.bento.probe.origin", target["package_name"])
        assertEquals(listOf(Probe.colonHex(Probe.sha256(cert))), target["sha256_cert_fingerprints"])
    }

    @Test fun requestsAreJsonOfTheBentoIdShape() {
        val c = Json.obj(Json.parse(Probe.createRequestJson(rp, challenge, ByteArray(16), "u\"1")))!!
        assertEquals(rp, Json.obj(c["rp"])!!["id"])
        assertEquals(listOf(-7.0), (c["pubKeyCredParams"] as List<*>).map { (it as Map<*, *>)["alg"] })
        assertEquals("u\"1", Json.obj(c["user"])!!["name"])
        assertEquals(Probe.b64u(challenge), c["challenge"])
        val g = Json.obj(Json.parse(Probe.getRequestJson(rp, challenge, "AAEC")))!!
        assertEquals(rp, g["rpId"])
        assertEquals("AAEC", ((g["allowCredentials"] as List<*>)[0] as Map<*, *>)["id"])
        assertNull(Json.obj(Json.parse(Probe.getRequestJson(rp, challenge, null)))!!["allowCredentials"])
    }

    @Test fun registrationReportsOriginFieldsFlagsAndAlg() {
        val rep = Probe.registration(registrationJson(origin, extra = ",\"androidPackageName\":\"page.bento.probe.origin\""), rp, challenge, listOf(origin))
        val text = rep.lines.joinToString("\n")
        assertEquals("AQI", rep.credentialId)
        for (want in listOf(
            "origin: $origin",
            "origin is this app's apk-key-hash: yes",
            "type: webauthn.create\n",
            "challenge echoed: yes",
            "keys in order: type,challenge,origin,androidPackageName",
            "extra keys: androidPackageName=page.bento.probe.origin",
            "attestation format: none",
            "rpIdHash is sha256(\"$rp\"): yes",
            "flags: UP=1 UV=1 BE=1 BS=1 AT=1 ED=0 (0x5d)",
            "COSE key alg: -7  kty: 2  crv: 1",
        )) assertTrue("missing <$want> in\n$text", text.contains(want))
    }

    @Test fun aDifferentOriginOrChallengeIsCalledOut() {
        val text = Probe.registration(registrationJson("https://id.example.test", extra = ""), rp, ByteArray(32), listOf(origin)).lines.joinToString("\n")
        assertTrue(text, text.contains("origin is this app's apk-key-hash: NO (expected $origin)"))
        assertTrue(text, text.contains("challenge echoed: NO"))
        assertTrue(text, text.contains("extra keys: none"))
    }

    @Test fun assertionReportsHighS() {
        val n = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)
        assertTrue(Probe.signatureNote(der(BigInteger.ONE, n.subtract(BigInteger.ONE))).contains("HIGH-S"))
        assertTrue(Probe.signatureNote(der(BigInteger.ONE, n.shiftRight(1))).contains("low-S"))
        assertTrue(Probe.signatureNote(byteArrayOf(1, 2, 3)).contains("not DER"))

        val cd = Probe.b64u("{\"type\":\"webauthn.get\",\"challenge\":\"${Probe.b64u(challenge)}\",\"origin\":\"$origin\"}".toByteArray())
        val ad = Probe.b64u(Probe.sha256(rp.toByteArray()) + byteArrayOf(0x05, 0, 0, 0, 0))
        val json = "{\"id\":\"AQI\",\"response\":{\"clientDataJSON\":\"$cd\",\"authenticatorData\":\"$ad\"," +
            "\"signature\":\"${Probe.b64u(der(BigInteger.TWO, n.subtract(BigInteger.TWO)))}\",\"userHandle\":\"AA\"}}"
        val text = Probe.assertion(json, rp, challenge, listOf(origin)).lines.joinToString("\n")
        for (want in listOf("origin is this app's apk-key-hash: yes", "flags: UP=1 UV=1 BE=0 BS=0", "HIGH-S", "challenge echoed: yes"))
            assertTrue("missing <$want> in\n$text", text.contains(want))
    }

    @Test fun garbageIsReportedNotThrown() {
        assertEquals(listOf("response is not a JSON object"), Probe.registration("nope", rp, challenge, listOf(origin)).lines)
        val text = Probe.registration("{\"response\":{\"attestationObject\":\"AAAA\"}}", rp, challenge, listOf(origin)).lines.joinToString("\n")
        assertTrue(text, text.contains("clientDataJSON: absent"))
        assertNotNull(text)
    }

    // --- builders: a registration response as Credential Manager returns it ---

    private fun registrationJson(origin: String, extra: String): String {
        val cd = "{\"type\":\"webauthn.create\",\"challenge\":\"${Probe.b64u(challenge)}\",\"origin\":\"$origin\"$extra}"
        val cose = cbor(mapOf(1L to 2L, 3L to -7L, -1L to 1L, -2L to ByteArray(32), -3L to ByteArray(32)))
        val authData = Probe.sha256(rp.toByteArray()) + byteArrayOf(0x5d, 0, 0, 0, 0) + ByteArray(16) + byteArrayOf(0, 2, 1, 2) + cose
        val att = cbor(mapOf("fmt" to "none", "attStmt" to emptyMap<Any, Any>(), "authData" to authData))
        return "{\"id\":\"AQI\",\"rawId\":\"AQI\",\"type\":\"public-key\",\"authenticatorAttachment\":\"platform\"," +
            "\"response\":{\"clientDataJSON\":\"${Probe.b64u(cd.toByteArray())}\",\"attestationObject\":\"${Probe.b64u(att)}\"," +
            "\"transports\":[\"internal\",\"hybrid\"]},\"clientExtensionResults\":{}}"
    }

    private fun cbor(v: Any?): ByteArray = ByteArrayOutputStream().also { enc(it, v) }.toByteArray()
    private fun head(o: ByteArrayOutputStream, major: Int, n: Long) {
        if (n < 24) o.write((major shl 5) or n.toInt()) else { o.write((major shl 5) or 24); o.write(n.toInt()) }
    }
    private fun enc(o: ByteArrayOutputStream, v: Any?) {
        when (v) {
            is Long -> if (v >= 0) head(o, 0, v) else head(o, 1, -1 - v)
            is ByteArray -> { head(o, 2, v.size.toLong()); o.write(v) }
            is String -> { val b = v.toByteArray(); head(o, 3, b.size.toLong()); o.write(b) }
            is Map<*, *> -> { head(o, 5, v.size.toLong()); v.forEach { (k, x) -> enc(o, k); enc(o, x) } }
            else -> error("unsupported $v")
        }
    }

    private fun der(r: BigInteger, s: BigInteger): ByteArray {
        fun int(x: BigInteger): ByteArray { val b = x.toByteArray(); return byteArrayOf(0x02, b.size.toByte()) + b }
        val body = int(r) + int(s)
        return byteArrayOf(0x30, body.size.toByte()) + body
    }
}
