// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import java.math.BigInteger
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.security.spec.ECPoint
import java.security.spec.ECParameterSpec
import java.security.AlgorithmParameters
import java.security.spec.ECGenParameterSpec

/**
 * The slice of kernel/src/statements.ts and kernel/src/address.ts the setup flow
 * needs: build `bind.`, `dev.` and `cmp.`, sign them, and check the directory's
 * `att.` against a PINNED key. kernel/fixtures/identity-v1.json is the contract;
 * StatementsTest runs its rows. Nothing here invents a layout.
 *
 * Deliberately not ported: the `label`/`name` display text. Both are optional
 * in the format, and their Unicode filter (DISPLAY_FORBIDDEN_RANGES) has no
 * port yet, so this build emits them EMPTY rather than guess at the filter.
 */
object Address {
    sealed class Result { class Ok(val address: String) : Result(); class No(val reason: String) : Result() }
    private val ATEXT = Regex("^[a-z0-9!#$%&'*+/=?^_`{|}~-]+$")
    private val LABEL = Regex("^[a-z0-9-]+$")

    fun normalize(input: String): Result {
        val s = input.trim()
        if (s.length > 254) return Result.No("too-long")
        if (s.any { it.code < 0x21 || it.code > 0x7e }) return Result.No("not-ascii")
        val at = s.indexOf('@')
        if (at <= 0 || at != s.lastIndexOf('@') || at == s.length - 1) return Result.No("at-sign")
        val local = s.substring(0, at).lowercase(); val domain = s.substring(at + 1).lowercase()
        if (local.length > 64) return Result.No("too-long")
        if (local.split('.').any { !ATEXT.matches(it) }) return Result.No("local-part")
        val labels = domain.split('.')
        if (labels.size < 2) return Result.No("domain")
        for (l in labels) {
            if (l.isEmpty() || l.length > 63 || !LABEL.matches(l) || l.startsWith("-") || l.endsWith("-")) return Result.No("domain")
        }
        if (labels.last().all { it in '0'..'9' }) return Result.No("numeric-tld")
        return Result.Ok("$local@$domain")
    }
}

object Statements {
    const val SKEW_MS = 5 * 60_000L
    const val DAY_MS = 86_400_000L
    /** kernel CERT_MAX_MS: 13 × 30.5 days + 1 day. */
    const val CERT_MAX_MS = (13 * 30.5 * DAY_MS).toLong() + DAY_MS
    /** The email code: exactly 8 characters from a 31-character alphabet, upper case. */
    val CODE_RE = Regex("^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$")

    private fun utf8(s: String) = s.toByteArray(Charsets.UTF_8)
    fun sha256b64u(text: String): String = B64u.enc(MessageDigest.getInstance("SHA-256").digest(utf8(text)))

    // ---- keys ---------------------------------------------------------------------------------

    private val P256: ECParameterSpec = AlgorithmParameters.getInstance("EC").run {
        init(ECGenParameterSpec("secp256r1")); getParameterSpec(ECParameterSpec::class.java)
    }
    private val FIELD_P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    private val CURVE_B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)

    /** A raw uncompressed P-256 point ON THE CURVE (signing and ECDH keys share the encoding). */
    fun isPoint(b64: String): Boolean {
        val raw = B64u.dec(b64) ?: return false
        if (raw.size != 65 || raw[0] != 4.toByte()) return false
        val x = BigInteger(1, raw.copyOfRange(1, 33)); val y = BigInteger(1, raw.copyOfRange(33, 65))
        if (x >= FIELD_P || y >= FIELD_P) return false
        val lhs = y.multiply(y).mod(FIELD_P)
        val rhs = x.multiply(x).multiply(x).subtract(x.multiply(BigInteger.valueOf(3))).add(CURVE_B).mod(FIELD_P)
        return lhs == rhs
    }

    private val HALF_N = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16).shiftRight(1)

    /** Verify `sigB64` (raw r‖s, low-S) by `pubB64` over the exact UTF-8 of `text`. */
    fun verifySig(pubB64: String, sigB64: String, text: String): Boolean = try {
        val sig = B64u.dec(sigB64)
        if (sig == null || sig.size != 64 || !isPoint(pubB64)) false else {
            val r = BigInteger(1, sig.copyOfRange(0, 32)); val s = BigInteger(1, sig.copyOfRange(32, 64))
            if (r.signum() <= 0 || s.signum() <= 0 || s > HALF_N) false else {
                val raw = B64u.dec(pubB64)!!
                val pub = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(
                    ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65))), P256))
                Signature.getInstance("SHA256withECDSA").run { initVerify(pub); update(utf8(text)); verify(derOf(sig)) }
            }
        }
    } catch (e: Exception) { false }

    /** Sign with a private scalar; emits the low-S raw form every verifier requires. */
    fun sign(scalar: ByteArray, text: String): String {
        val priv = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, scalar), P256))
        val der = Signature.getInstance("SHA256withECDSA").run { initSign(priv); update(utf8(text)); sign() }
        return B64u.enc(Ecdsa.lowS(Ecdsa.derToRaw(der)))
    }

    private fun derOf(raw: ByteArray): ByteArray {
        fun int(b: ByteArray): ByteArray {
            var v = b.dropWhile { it == 0.toByte() }.toByteArray()
            if (v.isEmpty()) v = byteArrayOf(0)
            if (v[0] < 0) v = byteArrayOf(0) + v
            return byteArrayOf(0x02, v.size.toByte()) + v
        }
        val body = int(raw.copyOfRange(0, 32)) + int(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    // ---- builders ----------------------------------------------------------------------------------

    /** `bind.<b64u(address)>.<accountPub>.<kx>.<name|empty>.<seq>.<prev|empty>.<created>.<expires>` (name: not ported, empty). */
    class BindCert(val address: String, val accountPub: String, val kx: String, val seq: Int,
                   val prev: String?, val created: Long, val expires: Long)

    fun buildBind(c: BindCert): String = listOf("bind", B64u.enc(utf8(c.address)), c.accountPub, c.kx, "",
        c.seq.toString(), c.prev ?: "", c.created.toString(), c.expires.toString()).joinToString(".")

    /** `dev.<devicePub>.<consentPub|empty>.<accountPub>.<kx>.<label|empty>.<created>.<expires>` (label: not ported, empty). */
    class DeviceCert(val devicePub: String, val consentPub: String?, val accountPub: String, val kx: String,
                     val created: Long, val expires: Long, val label: String? = null)

    fun buildDev(c: DeviceCert): String = listOf("dev", c.devicePub, c.consentPub ?: "", c.accountPub, c.kx,
        c.label?.let { B64u.enc(it.toByteArray(Charsets.UTF_8)) } ?: "", c.created.toString(), c.expires.toString()).joinToString(".")

    /** `cmp.<sha256(bind text)>.<code>`. The code is upper-cased before it is signed. */
    fun buildCmp(bindHash: String, code: String): String? {
        val c = code.trim().uppercase()
        return if (CODE_RE.matches(c)) "cmp.$bindHash.$c" else null
    }

    // ---- dreq. (an account-signed request only the directory verifies) -------------------------------

    fun sha256b64u(bytes: ByteArray): String = B64u.enc(MessageDigest.getInstance("SHA-256").digest(bytes))

    /** `dreq.<op>.<b64u(address)>.<bindHash>.<challenge>.<arg|empty>`; [arg] is empty for freeze and status,
     *  else the SHA-256 the op fixes (rc-enrol: of the EXACT enrolment body bytes). */
    fun buildDreq(op: String, address: String, bindHash: String, challenge: String, arg: String): String =
        listOf("dreq", op, B64u.enc(utf8(address)), bindHash, challenge, arg).joinToString(".")

    // ---- att. (the directory's attestation) -----------------------------------------------------------

    class Att(val bindHash: String, val verifiedAt: Long, val issuedAt: Long, val kid: String, val state: String)
    sealed class Verdict { class Ok(val att: Att) : Verdict(); class No(val reason: String) : Verdict() }
    private val KID_RE = Regex("^[a-z0-9][a-z0-9-]{0,62}$")
    private val INT_RE = Regex("^(0|[1-9][0-9]{0,15})$")

    /** The attestation must name THIS binding, be fresh, and verify under a key PINNED by kid
     *  (exact match against [directoryKeys]; "any key that verifies" is never accepted). */
    fun verifyAtt(text: String, sig: String, directoryKeys: Map<String, String>, bindText: String,
                  now: Long, maxAgeMs: Long): Verdict {
        if (text.isEmpty() || text.length > 4096 || text.any { it.code < 0x21 || it.code > 0x7e }) return Verdict.No("grammar")
        val p = text.split('.')
        if (p.size != 6 || p[0] != "att") return Verdict.No("grammar")
        val hash = B64u.dec(p[1])
        if (hash == null || hash.size != 32 || !KID_RE.matches(p[4])) return Verdict.No("grammar")
        if (p[5] != "active" && p[5] != "pending" && p[5] != "frozen") return Verdict.No("grammar")
        if (!INT_RE.matches(p[2]) || !INT_RE.matches(p[3])) return Verdict.No("grammar")
        val verified = p[2].toLong(); val issued = p[3].toLong()
        if (verified <= 0 || issued <= 0 || verified > issued) return Verdict.No("grammar")
        if (issued > now + SKEW_MS) return Verdict.No("not-yet-valid")
        if (now - issued > maxAgeMs) return Verdict.No("stale")
        if (p[1] != sha256b64u(bindText)) return Verdict.No("bind-mismatch")
        val key = directoryKeys[p[4]] ?: return Verdict.No("unknown-kid")
        if (!verifySig(key, sig, text)) return Verdict.No("signature")
        return Verdict.Ok(Att(p[1], verified, issued, p[4], p[5]))
    }
}
