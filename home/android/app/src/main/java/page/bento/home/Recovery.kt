// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The recovery code and the key blobs (identity-design §2f, security §28), the
 * Android port of kernel/src/recovery.ts. kernel/fixtures/recovery-v1.json is
 * deterministic, and RecoveryTest reproduces every byte of it.
 *
 * Argon2id is Bouncy Castle's (security §35: pinned, with Gradle dependency
 * verification). Its 64 MiB of blocks come from [WipingPool], which zeroes each
 * block as Argon2 hands it back and keeps none — best effort, because the
 * garbage collector may already have copied a block before it was cleared.
 * Everything else is the platform's: HKDF over HmacSHA256, AES-GCM, and the
 * KeyFactory + sign/verify probe for a recovered scalar.
 *
 * The directory's pepper layer is server code (share implements it) and is not
 * ported here.
 */
object Recovery {
    const val CODE_BYTES = 10
    const val SALT_LEN = 16

    /** Argon2id, version 0x13, p = 1, 64 MiB, t = 3, 32-byte tag (security §28). Fixed by the format. */
    const val MEMORY_KIB = 65536
    const val PASSES = 3
    const val LANES = 1
    const val TAG_LEN = 32

    /** Why a recovery step did not complete. */
    class Unavailable(message: String) : Exception(message)

    // ---- Argon2id ----------------------------------------------------------------------

    /**
     * Hands Argon2 fresh blocks and zeroes every block it gives back, keeping
     * none. `seen` exists so a test can read each block back afterwards.
     */
    class WipingPool(private val track: Boolean = false) : Argon2BytesGenerator.BlockPool {
        val seen = ArrayList<Argon2BytesGenerator.Block>()
        override fun allocate(): Argon2BytesGenerator.Block =
            Argon2BytesGenerator.Block().also { if (track) seen += it }
        override fun deallocate(block: Argon2BytesGenerator.Block) { block.clear() }
    }

    /** What a derivation needs on the heap: each 1 KiB block is a 1040-byte allocation
     *  (measured on Android), plus room for everything else the app is doing. */
    fun heapNeeded(memoryKiB: Int): Long = memoryKiB.toLong() * 1040 + HEADROOM
    private const val HEADROOM = 16L shl 20

    /** The heap this process can still grow into. */
    fun heapAvailable(): Long = Runtime.getRuntime().let { it.maxMemory() - (it.totalMemory() - it.freeMemory()) }

    /**
     * Argon2id with arbitrary parameters (the RFC 9106 row uses its own). Call off
     * the main thread. Too little memory is [Unavailable] — never a crash and never
     * weaker parameters, which the format fixes.
     *
     * The check comes BEFORE allocating. Catching OutOfMemoryError alone is not
     * enough: measured on a 48 MiB heap, filling it made the runtime's own threads
     * (finalizer, binder) throw OutOfMemoryError and the process died. So a
     * device whose heap can't hold the blocks never starts the derivation.
     */
    fun argon2id(
        password: ByteArray, salt: ByteArray,
        memoryKiB: Int = MEMORY_KIB, passes: Int = PASSES, lanes: Int = LANES, tagLen: Int = TAG_LEN,
        secret: ByteArray? = null, ad: ByteArray? = null,
        version: Int = Argon2Parameters.ARGON2_VERSION_13,
        pool: Argon2BytesGenerator.BlockPool = WipingPool(),
        available: () -> Long = ::heapAvailable,
    ): ByteArray {
        // RFC 9106 §3.1: a salt is at least 8 bytes. Bouncy Castle would accept a
        // shorter one and Node refuses it, so refuse here as the format does.
        require(salt.size >= 8) { "an Argon2 salt is at least 8 bytes" }
        if (available() < heapNeeded(memoryKiB))
            throw Unavailable("recovery is unavailable on this device: not enough memory")
        val p = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(version).withMemoryAsKB(memoryKiB).withIterations(passes).withParallelism(lanes)
            .withSalt(salt).apply { if (secret != null) withSecret(secret); if (ad != null) withAdditional(ad) }
            .withBlockPool(pool)
            .build()
        val out = ByteArray(tagLen)
        try {
            Argon2BytesGenerator().apply { init(p) }.generateBytes(password, out)
        } catch (e: OutOfMemoryError) {
            throw Unavailable("recovery is unavailable on this device: not enough memory")
        }
        return out
    }

    // ---- the recovery code: 80 bits, Crockford base32, a mod-37 check ------------------

    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private const val CHECK_ALPHABET = ALPHABET + "*~$=U"

    private fun check37(code: ByteArray) = code.fold(0) { r, b -> (r * 256 + (b.toInt() and 0xff)) % 37 }

    /** The printed form: XXXX-XXXX-XXXX-XXXX-C. */
    fun format(code: ByteArray): String {
        require(code.size == CODE_BYTES) { "a recovery code is 10 bytes" }
        val s = StringBuilder()
        for (i in 0 until 16) {
            val bit = i * 5; val byte = bit shr 3; val sh = bit and 7
            val two = ((code[byte].toInt() and 0xff) shl 8) or (if (byte + 1 < CODE_BYTES) code[byte + 1].toInt() and 0xff else 0)
            s.append(ALPHABET[(two shr (11 - sh)) and 31])
        }
        return "${s.substring(0, 4)}-${s.substring(4, 8)}-${s.substring(8, 12)}-${s.substring(12, 16)}-${CHECK_ALPHABET[check37(code)]}"
    }

    sealed class Parsed {
        class Ok(val code: ByteArray) : Parsed()
        class No(val reason: String) : Parsed()   // length | character | check
    }

    /** Forgiving where Crockford is (case, spaces, hyphens; O→0, I/L→1); the check must match. */
    fun parse(input: String): Parsed {
        val s = input.uppercase().replace(Regex("[\\s-]"), "").replace('O', '0').replace(Regex("[IL]"), "1")
        if (s.length != 17) return Parsed.No("length")
        val code = ByteArray(CODE_BYTES)
        for (i in 0 until 16) {
            val v = ALPHABET.indexOf(s[i])
            if (v < 0) return Parsed.No("character")       // includes U: valid only as the check
            val bit = i * 5; val byte = bit shr 3; val sh = bit and 7
            val two = v shl (11 - sh)
            code[byte] = (code[byte].toInt() or (two shr 8)).toByte()
            if (byte + 1 < CODE_BYTES) code[byte + 1] = (code[byte + 1].toInt() or (two and 0xff)).toByte()
        }
        val check = CHECK_ALPHABET.indexOf(s[16])
        if (check < 0) return Parsed.No("character")
        if (check != check37(code)) return Parsed.No("check")
        return Parsed.Ok(code)
    }

    // ---- derivations ---------------------------------------------------------------------

    /** HKDF-SHA-256, 32 bytes out. An empty salt is 32 zero bytes (RFC 5869), which is what
     *  WebCrypto does with a zero-length one — and SecretKeySpec refuses an empty key. */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        mac.update(info.toByteArray(Charsets.UTF_8)); mac.update(1)
        return mac.doFinal()
    }

    /** HKDF(Argon2id(code, salt), empty, "bento/id/rc-wrap/v1"). */
    fun wrapKey(code: ByteArray, salt: ByteArray): ByteArray {
        require(code.size == CODE_BYTES && salt.size == SALT_LEN)
        return hkdf(argon2id(code, salt), ByteArray(0), "bento/id/rc-wrap/v1")
    }

    /** What proves knowledge of the code to the directory: Argon2id(code, salt_v). */
    fun verifier(code: ByteArray, saltV: ByteArray): ByteArray {
        require(code.size == CODE_BYTES && saltV.size == SALT_LEN)
        return argon2id(code, saltV)
    }

    /** The PRF blob's key: HKDF(PRF output, 32-byte salt, "bento/id/acct-wrap/v1"). */
    fun prfKek(prfOutput: ByteArray, salt: ByteArray): ByteArray {
        require(prfOutput.size == 32 && salt.size == 32)
        return hkdf(prfOutput, salt, "bento/id/acct-wrap/v1")
    }

    // ---- blob plaintext: raw private scalars, checked on import ---------------------------

    /** Which kx placement the blob follows (identity-design §6b); phase 1 is unruled: account only. */
    enum class KxMode(val carriesKx: Boolean) { UNRULED(false), A(true), B(false), C(true) }

    class Keys(val account: ByteArray, val kx: ByteArray? = null)

    fun pack(keys: Keys, mode: KxMode = KxMode.UNRULED): ByteArray {
        require(keys.account.size == 32)
        if (!mode.carriesKx) { require(keys.kx == null) { "kx mode $mode carries no kx" }; return keys.account.copyOf() }
        val kx = requireNotNull(keys.kx) { "kx mode $mode needs a kx" }
        require(kx.size == 32)
        return keys.account + kx
    }

    sealed class Opened {
        class Ok(val keys: Keys) : Opened()
        class No(val reason: String) : Opened()
    }

    private val N = Hex.bytes("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")

    /** 1 ≤ d < n, comparing every byte without branching on the scalar's bits. */
    fun scalarInRange(d: ByteArray): Boolean {
        if (d.size != 32) return false
        var nonzero = 0; var lt = 0; var gt = 0
        for (i in 0 until 32) {
            val a = d[i].toInt() and 0xff; val b = N[i].toInt() and 0xff
            val open = 1 xor (lt or gt)
            lt = lt or (open and (((a - b) ushr 31) and 1))
            gt = gt or (open and (((b - a) ushr 31) and 1))
            nonzero = nonzero or a
        }
        return (lt and (((nonzero or -nonzero) ushr 31))) == 1
    }

    private val PROBE = "bento/id/scalar-probe/v1".toByteArray(Charsets.UTF_8)
    private val P256: ECParameterSpec = AlgorithmParameters.getInstance("EC").run {
        init(ECGenParameterSpec("secp256r1")); getParameterSpec(ECParameterSpec::class.java)
    }

    /**
     * Does private scalar d belong to the raw public key? Through the platform's
     * own key and signature code, never a hand-rolled d·G (security, #770): the
     * scalar becomes a key, signs a probe, and that must verify under `pub`.
     */
    fun scalarMatches(d: ByteArray, pubB64: String): Boolean = try {
        val raw = B64u.dec(pubB64)
        if (raw == null || raw.size != 65 || raw[0] != 4.toByte()) false else {
            val kf = KeyFactory.getInstance("EC")
            val priv = kf.generatePrivate(ECPrivateKeySpec(BigInteger(1, d), P256))
            val pub = kf.generatePublic(ECPublicKeySpec(
                ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65))), P256))
            val sig = Signature.getInstance("SHA256withECDSA").run { initSign(priv); update(PROBE); sign() }
            Signature.getInstance("SHA256withECDSA").run { initVerify(pub); update(PROBE); verify(sig) }
        }
    } catch (e: Exception) { false }

    /** Read a blob's plaintext and CHECK it before anything uses it. A swapped blob fails closed. */
    fun unpack(pt: ByteArray, accountPub: String, kxPub: String? = null, mode: KxMode = KxMode.UNRULED): Opened {
        if (pt.size != (if (mode.carriesKx) 64 else 32)) return Opened.No("length")
        val scalars = if (mode.carriesKx) listOf(pt.copyOfRange(0, 32), pt.copyOfRange(32, 64)) else listOf(pt.copyOfRange(0, 32))
        val pubs = if (mode.carriesKx) listOf(accountPub, kxPub) else listOf(accountPub)
        for (i in scalars.indices) {
            if (!scalarInRange(scalars[i])) return Opened.No("scalar-range")
            val pub = pubs[i] ?: return Opened.No("key-mismatch")
            if (!scalarMatches(scalars[i], pub)) return Opened.No("key-mismatch")
        }
        return Opened.Ok(if (mode.carriesKx) Keys(scalars[0], scalars[1]) else Keys(scalars[0]))
    }

    // ---- AES-256-GCM -------------------------------------------------------------------------

    private fun gcm(mode: Int, key: ByteArray, iv: ByteArray, aad: String, data: ByteArray): ByteArray {
        require(key.size == 32 && iv.size == 12)
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            updateAAD(aad.toByteArray(Charsets.UTF_8))
            doFinal(data)
        }
    }

    private fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)
    private fun accountTag(accountPub: String) = B64u.enc(sha256(accountPub.toByteArray(Charsets.UTF_8)))

    // ---- the PRF blob (one per passkey) -----------------------------------------------------

    class PrfBlob(val v: Int, val cred: String, val salt: String, val iv: String, val ct: String)

    /** cred = b64u(sha256(credentialId)); aad = "bento/id/acct-wrap/v1." ‖ cred. */
    fun sealPrfBlob(prfOutput: ByteArray, credentialId: ByteArray, salt: ByteArray, iv: ByteArray,
                    keys: Keys, mode: KxMode = KxMode.UNRULED): PrfBlob {
        val cred = B64u.enc(sha256(credentialId))
        val ct = gcm(Cipher.ENCRYPT_MODE, prfKek(prfOutput, salt), iv, "bento/id/acct-wrap/v1.$cred", pack(keys, mode))
        return PrfBlob(1, cred, B64u.enc(salt), B64u.enc(iv), B64u.enc(ct))
    }

    fun openPrfBlob(blob: PrfBlob, prfOutput: ByteArray, credentialId: ByteArray,
                    accountPub: String, kxPub: String? = null, mode: KxMode = KxMode.UNRULED): Opened {
        if (blob.v != 1) return Opened.No("version")
        val cred = B64u.enc(sha256(credentialId))
        if (blob.cred != cred) return Opened.No("credential")
        val salt = B64u.dec(blob.salt); val iv = B64u.dec(blob.iv); val ct = B64u.dec(blob.ct)
        if (salt == null || salt.size != 32 || iv == null || iv.size != 12 || ct == null) return Opened.No("grammar")
        val pt = try { gcm(Cipher.DECRYPT_MODE, prfKek(prfOutput, salt), iv, "bento/id/acct-wrap/v1.$cred", ct) }
                 catch (e: Exception) { return Opened.No("decrypt") }
        return unpack(pt, accountPub, kxPub, mode)
    }

    // ---- the recovery-code blob's inner layer (the directory adds its pepper layer) --------

    /** aad = "bento/id/rc-wrap/v1." ‖ b64u(sha256(accountPub)). */
    fun sealRecoveryInner(wrapKey: ByteArray, iv: ByteArray, accountPub: String, keys: Keys, mode: KxMode = KxMode.UNRULED): ByteArray =
        gcm(Cipher.ENCRYPT_MODE, wrapKey, iv, "bento/id/rc-wrap/v1.${accountTag(accountPub)}", pack(keys, mode))

    fun openRecoveryInner(ct: ByteArray, wrapKey: ByteArray, iv: ByteArray,
                          accountPub: String, kxPub: String? = null, mode: KxMode = KxMode.UNRULED): Opened {
        val pt = try { gcm(Cipher.DECRYPT_MODE, wrapKey, iv, "bento/id/rc-wrap/v1.${accountTag(accountPub)}", ct) }
                 catch (e: Exception) { return Opened.No("decrypt") }
        return unpack(pt, accountPub, kxPub, mode)
    }
}

/** Canonical base64url (no padding; must re-encode to itself), as kernel/src/statements.ts. */
object B64u {
    fun enc(b: ByteArray): String = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun dec(s: String): ByteArray? {
        if (!Regex("^[A-Za-z0-9_-]*$").matches(s) || s.length % 4 == 1) return null
        val b = try { java.util.Base64.getUrlDecoder().decode(s) } catch (e: IllegalArgumentException) { return null }
        return if (enc(b) == s) b else null
    }
}

/** Lower-case hex, as the fixture writes bytes. */
object Hex {
    fun bytes(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    fun str(b: ByteArray): String = b.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
