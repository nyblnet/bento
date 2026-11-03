// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

/**
 * The host's side of the shared bridge's identity calls (home/bridge.js `id.whoami`,
 * `id.sign`, `id.resolve`; contract: kernel/src/identity.ts). Pure logic with the clock,
 * the account record and the signing key injected, so the rules are tested on the JVM
 * and the emulator rig only has to prove the wiring.
 *
 * The rules, each of which a test breaks on purpose:
 * - NO AGENT FOR AN UNVERIFIED LOAD. [Caller.genuine] is gate 1's verdict on the bytes
 *   served for THIS load. Without it every call is `unavailable` / null, whatever the
 *   page says (the bridge file declares the capability only for a genuine load; this is
 *   the authority, the bridge is the courtesy).
 * - MODE C / O1 DEFERRED: while any managed-configuration key is present, no identity
 *   operation at all (security §39.4), the same predicate setup and linking use.
 * - THE HOST KNOWS WHO IS ASKING: the document is [Caller.doc], the host's own per-document
 *   origin label. Nothing in a request names it.
 * - CONSENT IS PER DOCUMENT: whoami asks the person once; sign and resolve serve only a
 *   document that was granted. A refusal is remembered for the session, never for good.
 * - SIGN IS PURPOSE-LOCKED: the payload must have the exact shape the purpose names
 *   ([Consent.payloadMatchesPurpose]); only the routine purposes sign here. `invite` and
 *   `revoke` need an owner key no phase-1 agent holds: `unavailable`.
 * - THE HOST OWNS THE SESSION: [RoutineGate] (1 h idle, 24 h overall). Past either, `reauth`
 *   until the person re-authenticates (the editor asks the device credential, then calls
 *   [reauthenticated]). A refusal is never a use, and nothing the page sends can reopen it.
 * - NEVER AN EMAIL: resolve answers from keys this device already holds (its own account),
 *   makes no network call and takes no address.
 */
class IdentityHost(
    private val record: () -> IdentitySetup.Record?,
    private val managed: () -> Boolean,
    private val consent: DocConsent,
    private val gate: RoutineGate,
    private val signRoutine: (ByteArray) -> ByteArray,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** Who is asking, as the HOST knows it. */
    class Caller(val genuine: Boolean, val doc: String)

    /** The Keystore's own floor lapsed (no device authentication in the overall period). */
    class AuthLapsed : Exception()

    sealed class Out {
        /** `value` is null (a legitimate "nobody") or a Map of strings/numbers/booleans. */
        class Ok(val value: Map<String, Any?>?) : Out()
        class Refuse(val word: String) : Out()
        /** whoami for a document nobody has been asked about: the editor asks, records, calls again. */
        object NeedConsent : Out()
    }

    enum class State { UNASKED, GRANTED, DECLINED }
    interface DocConsent {
        fun state(doc: String): State
        fun grant(doc: String)
        fun decline(doc: String)
    }

    fun whoami(c: Caller): Out {
        if (blocked(c)) return Out.Refuse("unavailable")
        val r = record() ?: return Out.Refuse("no-identity")
        return when (consent.state(c.doc)) {
            State.UNASKED -> Out.NeedConsent
            State.DECLINED -> Out.Refuse("declined")
            State.GRANTED -> Out.Ok(identity(r))
        }
    }

    fun sign(c: Caller, purpose: String, payload: String): Out {
        if (blocked(c)) return Out.Refuse("unavailable")
        if (!Consent.payloadMatchesPurpose(purpose, payload)) return Out.Refuse("purpose")
        if (purpose !in ROUTINE) return Out.Refuse("unavailable")
        val r = record() ?: return Out.Refuse("no-identity")
        if (consent.state(c.doc) != State.GRANTED) return Out.Refuse("declined")
        if (!gate.allow(now())) return Out.Refuse("reauth")
        val sig = try {
            signRoutine(payload.toByteArray(Charsets.UTF_8))
        } catch (e: AuthLapsed) {
            gate.lock(); return Out.Refuse("reauth")
        } catch (e: Exception) {
            return Out.Refuse("unavailable")
        }
        return Out.Ok(mapOf("sig" to B64u.enc(sig), "pub" to part(r.devText, 1)))
    }

    /** A key already in the room: only this account's own is known here. Everything else is null. */
    fun resolve(c: Caller, pub: String): Out {
        if (blocked(c) || consent.state(c.doc) != State.GRANTED) return Out.Ok(null)
        val r = record() ?: return Out.Ok(null)
        val id = identity(r)
        if (pub != id["accountPub"] && pub != id["devicePub"]) return Out.Ok(null)
        return Out.Ok(mapOf("name" to id["name"], "email" to id["email"], "vouchedBy" to id["vouchedBy"],
            "accountPub" to id["accountPub"], "firstSeen" to (part(r.bindText, 7).toLongOrNull() ?: 0L), "changed" to false))
    }

    /** The person just authenticated at the host: open a fresh session. */
    fun reauthenticated() = gate.authenticated(now())

    private fun blocked(c: Caller) = !c.genuine || managed()

    private fun identity(r: IdentitySetup.Record): Map<String, Any?> = mapOf(
        // The binding carries no display name yet: the address stands in (placeholder, flagged).
        "name" to r.address, "email" to r.address, "vouchedBy" to VOUCHED_BY,
        "accountPub" to part(r.bindText, 2), "devicePub" to part(r.devText, 1))

    private fun part(text: String, i: Int) = text.split(".").getOrElse(i) { "" }

    companion object {
        const val VOUCHED_BY = "id.bento.page"
        /** The purposes signed with the device (routine) key, as the desktop agent's ROUTINE list. */
        val ROUTINE = setOf("frame", "prove", "delegate", "show")

        /**
         * The capabilities the shared bridge is told to declare for ONE load. `identity` only for
         * a load gate 1 passed, and never on a device that is managed. Store and seal as before.
         */
        fun capabilities(genuine: Boolean, managed: Boolean): List<String> =
            if (genuine && !managed) listOf("store", "seal", "identity") else listOf("store", "seal")
    }
}

/** Per-document consent: grants persist (a file in no-backup storage), declines last the process. */
class DocConsentStore(private val file: java.io.File?) : IdentityHost.DocConsent {
    private val declined = HashSet<String>()
    private val sessionGrants = HashSet<String>()
    private val key = Regex("^[A-Za-z0-9_-]{1,128}$")

    @Synchronized override fun state(doc: String): IdentityHost.State = when {
        doc in declined -> IdentityHost.State.DECLINED
        doc in sessionGrants || doc in stored() -> IdentityHost.State.GRANTED
        else -> IdentityHost.State.UNASKED
    }

    @Synchronized override fun grant(doc: String) {
        declined.remove(doc)
        // A document with no docId of its own has no stable identity to remember: this session only.
        if (file == null || !key.matches(doc)) { sessionGrants.add(doc); return }
        try { file.parentFile?.mkdirs(); file.appendText(doc + "\n") } catch (e: Exception) { sessionGrants.add(doc) }
    }

    @Synchronized override fun decline(doc: String) { declined.add(doc); sessionGrants.remove(doc) }

    private fun stored(): Set<String> = try { file?.takeIf { it.exists() }?.readLines()?.toSet() ?: emptySet() } catch (e: Exception) { emptySet() }
}

/** Reads back what [IdentitySetup.Record.serialize] wrote; anything incomplete is null, never a half record. */
fun parseRecord(text: String): IdentitySetup.Record? {
    val m = text.split("\n").mapNotNull { l -> l.indexOf('\t').takeIf { it > 0 }?.let { l.substring(0, it) to l.substring(it + 1) } }.toMap()
    fun f(k: String) = m[k]?.takeIf { it.isNotEmpty() }
    val parts = listOf("address", "bind", "bindSig", "att", "attSig", "dev", "devSig").map { f(it) ?: return null }
    return IdentitySetup.Record(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6], m["recoveryEnrolled"] == "true")
}
