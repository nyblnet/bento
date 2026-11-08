// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import java.security.MessageDigest
import java.util.Base64

/**
 * The host-stamped consent statement (`cns.`, kernel/src/statements.ts) and the
 * routine payload shapes, in Kotlin. kernel/fixtures/identity-v1.json is the
 * contract: ConsentTest re-reads it, so this file can never drift from the
 * reference without a failing test.
 *
 * Every field of a `cns.` is chosen HERE, never by the page (identity-design
 * §2e (A)): the relying party is this app's, the docId is the one the host read
 * from the file it opened, the audience is phase 1's only one (`dir`), and the
 * transcript binds the verifier's challenge to the exact statement being
 * authorised. A page asking for consent supplies only the statement and the
 * challenge — so it cannot aim a signature at another verifier (relay), reuse
 * one (replay: the challenge is single-use), or swap what it authorises.
 */
object Consent {
    /** bento's relying-party identity in a `cns.` (a vault id when there is one). */
    const val RP = "bento"
    /** Phase 1's only consent audience: the directory (security §24). No relay change. */
    const val AUDIENCE = "dir"
    /** A consent is good for at most five minutes (CONSENT_MAX_TTL_MS); stamp two. */
    const val TTL_MS = 2 * 60_000L

    enum class Purpose(val word: String, val family: String, val docScoped: Boolean) {
        INVITE("invite", "inv.", true),
        REVOKE("revoke", "rev.", true),
        LINK("link", "dev.", false),
        ROTATE("rotate", "bind.", false),
        UNBIND("unbind", "del.", false),
        // The directory-request purposes name their OP (kernel's CONSENT_FAMILY): a consent to enrol a
        // recovery code must not authorise adding or removing a passkey. Account-scoped: no docId.
        CRED_ADD("cred-add", "dreq.cred-add.", false),
        CRED_DEL("cred-del", "dreq.cred-del.", false),
        RC_ENROL("rc-enrol", "dreq.rc-enrol.", false);
        companion object { fun of(w: String) = values().firstOrNull { it.word == w } }
    }

    // ---- strict base64url ------------------------------------------------------

    fun b64uEnc(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    /** Canonical base64url only: alphabet, no padding, re-encodes to the same text. */
    fun b64uDec(s: String): ByteArray? {
        if (!B64U.matches(s) || s.length % 4 == 1) return null
        val b = try { Base64.getUrlDecoder().decode(s) } catch (e: IllegalArgumentException) { return null }
        return if (b64uEnc(b) == s) b else null
    }
    private val B64U = Regex("^[A-Za-z0-9_-]*$")

    fun sha256b64u(text: String): String =
        b64uEnc(MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)))

    // ---- the channel binding ---------------------------------------------------

    private val ROOM = "w[A-Za-z0-9_-]{43}"
    private val AUDIENCE_RE = Regex("^(dir|room:$ROOM)$")

    /**
     * b64u(SHA-256("cnst.v1." ‖ audience ‖ "." ‖ challenge ‖ "." ‖ b64u(SHA-256(payload)))),
     * or null if the audience or challenge breaks its grammar.
     */
    fun transcript(audience: String, challenge: String, payloadText: String): String? {
        if (!AUDIENCE_RE.matches(audience)) return null
        val c = b64uDec(challenge) ?: return null
        if (c.size < 16 || c.size > 64) return null
        return sha256b64u("cnst.v1.$audience.$challenge.${sha256b64u(payloadText)}")
    }

    fun build(rp: String, purpose: Purpose, docId: String?, transcript: String, exp: Long): String =
        listOf("cns", rp, purpose.word, docId ?: "", transcript, exp.toString()).joinToString(".")

    private val DOC_ID = Regex("^[A-Za-z0-9_-]{1,128}$")

    /**
     * The statement this host will sign for a consent request, or null when the
     * request does not hold together — the host refuses to stamp what a verifier
     * would refuse to accept. `docId` is the HOST's: the one it read from the
     * file it opened (DocumentOrigin.extractDocId), never one the page names.
     */
    fun stamp(purpose: Purpose, hostDocId: String?, challenge: String, payloadText: String, now: Long): String? {
        if (!payloadText.startsWith(purpose.family)) return null
        val docId = if (purpose.docScoped) hostDocId?.takeIf { DOC_ID.matches(it) } ?: return null else null
        val t = transcript(AUDIENCE, challenge, payloadText) ?: return null
        return build(RP, purpose, docId, t, now + TTL_MS)
    }

    // ---- routine signing: what payload each identity.ts SignPurpose may sign ---

    private const val MAX_STATEMENT = 4096
    private val INT = Regex("^(0|[1-9][0-9]{0,15})$")
    private val PROVE_ROOM = Regex("^[rw][A-Za-z0-9_-]{1,64}$")
    private fun len(f: String, min: Int, exact: Int? = null): Boolean {
        val b = b64uDec(f) ?: return false
        return if (exact == null) b.size >= min else b.size == exact
    }
    private fun pub(f: String): Boolean { val b = b64uDec(f); return b != null && b.size == 65 && b[0] == 4.toByte() }
    private fun iv(f: String) = len(f, 0, 12)
    private fun ct(f: String) = len(f, 16)

    /** Does `payload` have the exact shape `purpose` names? Mirrors payloadMatchesPurpose. */
    fun payloadMatchesPurpose(purpose: String, payload: String): Boolean {
        if (payload.length > MAX_STATEMENT) return false
        val p = payload.split(".")   // Kotlin's split keeps empty fields, like JS
        return when (purpose) {
            "frame" -> p.size == 2 && iv(p[0]) && ct(p[1])
            "prove" -> p.size == 3 && p[0] == "prove" && len(p[1], 16) && PROVE_ROOM.matches(p[2])
            "delegate" -> p.size == 2 && p[0] == "dlg" && pub(p[1])
            "show" -> (p.size == 1 && (p[0] == "live" || p[0] == "end")) ||
                (p.size == 4 && (p[0] == "nav" || p[0] == "black") && p[1] == "aud" && iv(p[2]) && ct(p[3]))
            "invite" -> p.size == 4 && p[0] == "inv" && pub(p[1]) &&
                (p[2] == "writer" || p[2] == "commenter" || p[2] == "audience") && INT.matches(p[3])
            "revoke" -> p.size == 2 && p[0] == "rev" && pub(p[1])
            else -> false
        }
    }
}
