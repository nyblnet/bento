// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Link v1 (kernel/src/link.ts): device linking, byte for byte. The `link` section of
 * kernel/fixtures/identity-v1.json is the contract and LinkTest runs every row it carries
 * for these functions. Nothing here invents a layout.
 *
 * Not ported, by design: [verifyLinkRelease] is the DIRECTORY's check (it holds the live binding
 * and the challenge); a host never releases msg3 to anyone, it only builds it (H) and opens it (N).
 *
 * Every function that judges input answers with a refusal and a reason; none throws on bad bytes.
 */
object Link {
    sealed class V<out T> {
        class Ok<T>(val value: T) : V<T>()
        class No(val reason: String) : V<Nothing>()
    }
    private fun no(reason: String) = V.No(reason)

    enum class Role(val word: String) { H("H"), N("N") }

    // ---- the link code and the slot -----------------------------------------------------------

    /** The link code is a recovery code in every byte. */
    const val CODE_BYTES = Recovery.CODE_BYTES
    fun formatCode(code: ByteArray): String = Recovery.format(code)
    fun parseCode(input: String): Recovery.Parsed = Recovery.parse(input)

    class Slot(val id: String, val tok: String, val salt: ByteArray)

    /** id, tok, salt = HKDF-SHA-256(code bytes, empty salt, "bento/id/link/v1/{id,tok,salt}"). */
    fun slot(code: ByteArray): Slot {
        require(code.size == CODE_BYTES) { "a link code is 10 bytes" }
        val none = ByteArray(0)
        return Slot(B64u.enc(Recovery.hkdf(code, none, "bento/id/link/v1/id")), B64u.enc(Recovery.hkdf(code, none, "bento/id/link/v1/tok")),
            Recovery.hkdf(code, none, "bento/id/link/v1/salt"))
    }

    /** What the directory stores for a slot's token: b64u(SHA-256(the token's 32 bytes)). */
    fun tokHash(tok: String): String? {
        val b = B64u.dec(tok) ?: return null
        return if (b.size == 32) B64u.enc(MessageDigest.getInstance("SHA-256").digest(b)) else null
    }

    // ---- strict text ---------------------------------------------------------------------------

    private const val MAX_LINE = 4096
    private fun printable(t: String): Boolean = t.isNotEmpty() && t.length <= MAX_LINE && t.all { it.code in 0x21..0x7e }
    /** Split on '.', keeping empty fields: exact prefix and count, printable ASCII only. */
    private fun fields(text: String, prefix: String, count: Int): List<String>? {
        if (!printable(text)) return null
        val p = text.split('.')
        return if (p.size == count && p[0] == prefix) p else null
    }
    private fun isSig(f: String) = B64u.dec(f)?.size == 64

    // ---- msg0, msg1 ----------------------------------------------------------------------------

    fun buildMsg0(eD: String, roleD: Role) = "lnk0.$eD.${roleD.word}"
    fun buildMsg1(eS: String) = "lnk1.$eS"

    class Msg0(val eD: String, val roleD: Role)
    fun parseMsg0(text: String): V<Msg0> {
        val p = fields(text, "lnk0", 3)
        if (p == null || (p[2] != "H" && p[2] != "N")) return no("grammar")
        if (!Statements.isPoint(p[1])) return no("key")
        return V.Ok(Msg0(p[1], if (p[2] == "H") Role.H else Role.N))
    }
    fun parseMsg1(text: String): V<String> {
        val p = fields(text, "lnk1", 2) ?: return no("grammar")
        if (!Statements.isPoint(p[1])) return no("key")
        return V.Ok(p[1])
    }

    /**
     * The scanner's check of the role the displayer claims (security §39.1 condition 2): exactly
     * one side holds the account. D claims H → S must hold none; D claims N → S must hold one.
     * (Condition 1, that an id.bento.page/l# link never starts the H side, is UI: see LinkActivity.)
     */
    fun scannerMayProceed(roleD: Role, scannerHoldsAccount: Boolean) =
        if (roleD == Role.H) !scannerHoldsAccount else scannerHoldsAccount

    // ---- the transcript, the keys and the SAS ---------------------------------------------------

    /** t = b64u(SHA-256("lnkt.v1." ‖ id ‖ "." ‖ E_D ‖ "." ‖ E_S ‖ "." ‖ roleD)); null for a reflected ephemeral. */
    fun transcript(id: String, eD: String, eS: String, roleD: Role): String? =
        if (eD == eS) null else Statements.sha256b64u("lnkt.v1.$id.$eD.$eS.${roleD.word}")

    class Keys(val h2n: ByteArray, val n2h: ByteArray, val sasKey: ByteArray, val sas: String) {
        fun wipe() { h2n.fill(0); n2h.fill(0); sasKey.fill(0) }
    }

    fun keysFromShared(z: ByteArray, salt: ByteArray, t: String): Keys {
        require(z.size == 32 && salt.size == 32) { "Z and the salt are 32 bytes" }
        val sasKey = Recovery.hkdf(z, salt, "bento/id/link/v1/sas.$t")
        return Keys(Recovery.hkdf(z, salt, "bento/id/link/v1/h2n.$t"), Recovery.hkdf(z, salt, "bento/id/link/v1/n2h.$t"), sasKey, sasDigits(sasKey))
    }

    private val P256: ECParameterSpec = AlgorithmParameters.getInstance("EC").run {
        init(ECGenParameterSpec("secp256r1")); getParameterSpec(ECParameterSpec::class.java)
    }

    /** Z, the ECDH x-coordinate of own scalar and the other side's point; null if the point is bad. */
    fun sharedSecret(ownScalar: ByteArray, otherPub: String): ByteArray? {
        if (!Statements.isPoint(otherPub)) return null
        return try {
            val raw = B64u.dec(otherPub)!!
            val kf = KeyFactory.getInstance("EC")
            val other = kf.generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65))), P256))
            val mine = kf.generatePrivate(ECPrivateKeySpec(BigInteger(1, ownScalar), P256))
            KeyAgreement.getInstance("ECDH").run { init(mine); doPhase(other, true); generateSecret() }
        } catch (e: Exception) { null }
    }

    fun keys(ownScalar: ByteArray, otherPub: String, salt: ByteArray, t: String): Keys? {
        val z = sharedSecret(ownScalar, otherPub) ?: return null
        return try { keysFromShared(z, salt, t) } finally { z.fill(0) }
    }

    /** First 4 bytes big-endian, mod 1,000,000, zero-padded to 6 digits. */
    fun sasDigits(sasKey: ByteArray): String {
        val v = ((sasKey[0].toLong() and 0xff) shl 24) or ((sasKey[1].toLong() and 0xff) shl 16) or
            ((sasKey[2].toLong() and 0xff) shl 8) or (sasKey[3].toLong() and 0xff)
        return (v % 1_000_000L).toString().padStart(6, '0')
    }

    /** JavaScript's \\s (kernel strips it from what was typed) plus the hyphen. */
    private val JS_SPACE_OR_HYPHEN = Regex("[\\t\\n\\u000b\\u000c\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff-]")

    /** Spaces and hyphens are ignored; nothing else is, and full-width digits are not digits. */
    fun sasMatches(typed: String, sas: String): Boolean {
        val s = JS_SPACE_OR_HYPHEN.replace(typed, "")
        val digits = Regex("^[0-9]{6}$")
        return digits.matches(s) && digits.matches(sas) && MessageDigest.isEqual(s.toByteArray(), sas.toByteArray())
    }

    // ---- AES-GCM: AAD = the transcript and the message number ----------------------------------

    fun aad(t: String, n: Int) = "lnka.v1.$t.$n"
    private fun keyFor(k: Keys, n: Int) = if (n == 2) k.n2h else k.h2n

    /** wire = b64u(iv ‖ ciphertext ‖ tag). Each key seals one message number in one direction (n2h: 2, h2n: 3). */
    fun seal(k: Keys, n: Int, t: String, iv: ByteArray, plaintext: ByteArray): String {
        require(n == 2 || n == 3) { "link v1 seals messages 2 and 3 only" }
        require(iv.size == 12) { "the iv is 12 bytes" }
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyFor(k, n), "AES"), GCMParameterSpec(128, iv)); updateAAD(aad(t, n).toByteArray())
        }
        return B64u.enc(iv + c.doFinal(plaintext))
    }

    fun open(k: Keys, n: Int, t: String, wire: String): ByteArray? {
        if (n != 2 && n != 3) return null
        val b = B64u.dec(wire) ?: return null
        if (b.size < 12 + 16) return null
        return try {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, SecretKeySpec(keyFor(k, n), "AES"), GCMParameterSpec(128, b.copyOfRange(0, 12)))
                updateAAD(aad(t, n).toByteArray()); doFinal(b.copyOfRange(12, b.size))
            }
        } catch (e: Exception) { null }
    }

    // ---- msg2: N's offer -------------------------------------------------------------------------

    class Offer(val devicePub: String, val consentPub: String?, val kx: String, val label: String?, val platform: String)

    private val PLATFORM_RE = Regex("^[a-z][a-z0-9-]{0,31}$")
    fun popText(t: String) = "lnkp.v1.$t"

    fun buildOffer(o: Offer, popDevice: String, popConsent: String?): String =
        listOf("lnk2", o.devicePub, o.consentPub ?: "", o.kx, o.label?.let { B64u.enc(it.toByteArray(Charsets.UTF_8)) } ?: "",
            o.platform, popDevice, popConsent ?: "").joinToString(".")

    /** H's check of the offer plaintext, in the order kernel's verifyOffer makes it. */
    fun verifyOffer(text: String, t: String): V<Offer> {
        val p = fields(text, "lnk2", 8) ?: return no("grammar")
        val devicePub = p[1]; val consentF = p[2]; val kxF = p[3]; val labelF = p[4]
        val platform = p[5]; val popDevice = p[6]; val popConsentF = p[7]
        if (!PLATFORM_RE.matches(platform) || !isSig(popDevice) || (popConsentF != "" && !isSig(popConsentF))) return no("grammar")
        if (!Statements.isPoint(devicePub)) return no("key")
        var consentPub: String? = null
        if (consentF != "") {
            if (consentF == devicePub || !Statements.isPoint(consentF)) return no("consent-key")
            consentPub = consentF
        }
        if (kxF == "" || kxF == devicePub || kxF == consentF || !Statements.isPoint(kxF)) return no("kx")
        var label: String? = null
        if (labelF != "") { label = DisplayText.parse(labelF) ?: return no("label") }
        if ((consentPub == null) != (popConsentF == "")) return no("pop-consent")
        val pop = popText(t)
        if (!Statements.verifySig(devicePub, popDevice, pop)) return no("pop-device")
        if (consentPub != null && !Statements.verifySig(consentPub, popConsentF, pop)) return no("pop-consent")
        return V.Ok(Offer(devicePub, consentPub, kxF, label, platform))
    }

    fun openOffer(k: Keys, t: String, wire: String): V<Offer> {
        val pt = open(k, 2, t, wire) ?: return no("decrypt")
        val text = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(pt)).toString()
        } catch (e: java.nio.charset.CharacterCodingException) { return no("grammar") }
        return verifyOffer(text, t)
    }

    // ---- msg3: H's completion, opened by N ---------------------------------------------------------

    class Final(val hDev: String, val hDevSig: String, val cns: String, val cnsSig: String,
                val nDev: String, val nDevSig: String, val sealed: String)

    private const val SEALED_LEN = 12 + Recovery.BLOB_LEN + 16

    fun buildFinal(f: Final): String = listOf("lnk3", f.hDev, f.hDevSig, f.cns, f.cnsSig, f.nDev, f.nDevSig, f.sealed).joinToString("\n")

    private fun parseFinal(text: String): Final? {
        if (text.length > 8 * (MAX_LINE + 1)) return null
        val l = text.split('\n')
        if (l.size != 8 || l[0] != "lnk3" || !l.all { printable(it) }) return null
        if (!isSig(l[2]) || !isSig(l[4]) || !isSig(l[6]) || B64u.dec(l[7])?.size != SEALED_LEN) return null
        return Final(l[1], l[2], l[3], l[4], l[5], l[6], l[7])
    }

    /** `dev.<devicePub>.<consentPub|empty>.<accountPub>.<kx>.<b64u(label)|empty>.<created>.<expires>`, verified. */
    class Dev(val devicePub: String, val consentPub: String?, val accountPub: String, val kx: String, val label: String?, val created: Long, val expires: Long)

    private val INT_RE = Regex("^(0|[1-9][0-9]{0,15})$")
    private fun ms(f: String): Long? = if (INT_RE.matches(f)) f.toLong().takeIf { it > 0 } else null

    /** kernel verifyDev: grammar, keys, kx slot (mode C), label, lifetime, then the account key's signature. */
    fun verifyDev(text: String, sig: String, now: Long): V<Dev> {
        val p = fields(text, "dev", 8) ?: return no("grammar")
        val devicePub = p[1]; val consentF = p[2]; val accountPub = p[3]; val kxF = p[4]; val labelF = p[5]
        if (!Statements.isPoint(devicePub) || !Statements.isPoint(accountPub)) return no("key")
        if (devicePub == accountPub) return no("key")
        var consentPub: String? = null
        if (consentF != "") {
            if (!Statements.isPoint(consentF) || consentF == devicePub || consentF == accountPub) return no("consent-key")
            consentPub = consentF
        }
        if (kxF == "" || !Statements.isPoint(kxF) || kxF == devicePub || kxF == accountPub || kxF == consentF) return no("kx")
        var label: String? = null
        if (labelF != "") { label = DisplayText.parse(labelF) ?: return no("label") }
        val created = ms(p[6]); val expires = ms(p[7])
        if (created == null || expires == null) return no("grammar")
        when {
            expires <= created -> return no("lifetime")
            expires - created > Statements.CERT_MAX_MS -> return no("lifetime")
            created > now + Statements.SKEW_MS -> return no("not-yet-valid")
            now >= expires -> return no("expired")
        }
        if (!Statements.verifySig(accountPub, sig, text)) return no("signature")
        return V.Ok(Dev(devicePub, consentPub, accountPub, kxF, label, created, expires))
    }

    class Opened(val keys: Recovery.Keys, val device: Dev, val dev: String, val devSig: String)

    /**
     * N's check of msg3 before it stores anything (security §39.1 condition 4). [offer] is exactly what
     * N sent in msg2; [accountPub] and [recoveryKx] come from the binding the directory served under a
     * PINNED key. The dev. must name N's OWN devicePub, consentPub and kx; SEALED must open under h2n as
     * message 3; both scalars must be in range and match the binding.
     */
    fun openFinal(text: String, k: Keys, t: String, offer: Offer, accountPub: String, recoveryKx: String, now: Long): V<Opened> {
        val f = parseFinal(text) ?: return no("grammar")
        val n = when (val v = verifyDev(f.nDev, f.nDevSig, now)) { is V.No -> return no("dev-${v.reason}"); is V.Ok -> v.value }
        if (n.accountPub != accountPub) return no("account")
        if (n.devicePub != offer.devicePub) return no("device-mismatch")
        if (n.consentPub != offer.consentPub) return no("consent-mismatch")
        if (n.kx != offer.kx) return no("kx-mismatch")
        val pt = open(k, 3, t, f.sealed) ?: return no("decrypt")
        return when (val u = Recovery.unpack(pt, accountPub, recoveryKx)) {
            is Recovery.Opened.No -> no(u.reason)
            is Recovery.Opened.Ok -> V.Ok(Opened(u.keys, n, f.nDev, f.nDevSig))
        }
    }

    // ---- what the person is shown about the other device ------------------------------------------

    /** The platform token is context, never evidence. A token not in this fixed map is NOT shown as
     *  anything the host vouches for: [platformLabel] returns null and the UI says "unrecognised". */
    private val PLATFORMS = mapOf(
        "android" to "an Android device", "ios" to "an iPhone or iPad", "windows" to "a Windows PC",
        "macos" to "a Mac", "linux" to "a Linux PC", "chrome" to "the Chrome extension", "edge" to "the Edge extension",
    )
    fun platformLabel(token: String): String? = PLATFORMS[token]
}
