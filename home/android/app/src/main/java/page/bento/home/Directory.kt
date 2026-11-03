// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import java.net.HttpURLConnection
import java.net.URL

/**
 * The bento/id directory's client side (server/directory/README.md): the two calls that
 * make a binding. An interface, so the setup engine's rig runs without a network and
 * the emulator rig runs the same engine against a real worker.
 */
interface Directory {
    sealed class Started { object Accepted : Started(); class Refused(val status: Int) : Started(); object Unreachable : Started() }
    /** The directory's 200 to bind/complete: the statement it holds, its signature, and its att. */
    class Completed(val binding: String, val sig: String, val attestation: String, val attestationSig: String)
    sealed class Complete { class Ok(val value: Completed) : Complete(); object Rejected : Complete(); object Unreachable : Complete() }

    /** POST /v1/bind/start. The directory answers 202 whether or not it mailed a code, so
     *  [Started.Accepted] does NOT mean a code is on its way. */
    fun bindStart(stmt: String, sig: String): Started
    /** POST /v1/bind/complete. A uniform 400 for every wrong code, so a rejection says nothing more. */
    fun bindComplete(email: String, code: String, sig: String): Complete

    /** POST /v1/challenge: a single-use challenge for this address, good for 60 seconds; null when unreachable or refused. */
    fun challenge(email: String): String?

    /** The consent a directory request carries: the device certificate (account-signed) that names the
     *  consent key, and the cns. that key signed (kernel: verifyDirConsent, audience `dir`). */
    class ConsentProof(val dev: String, val devSig: String, val cns: String, val cnsSig: String)

    sealed class Enrol {
        object Enrolled : Enrol()
        object NotAvailable : Enrol()                 // the route is off (KEYSTORE unset): a 404
        class Refused(val status: Int, val reason: String) : Enrol()
        object Unreachable : Enrol()
    }
    /** POST /v1/recovery/enrol: [body] is the exact enrolment JSON, [req]/[sig] the `dreq.rc-enrol.` the account key signed. */
    fun recoveryEnrol(email: String, body: ByteArray, req: String, sig: String, challenge: String, consent: ConsentProof): Enrol
}

/** HTTPS in a release build; a debug build may point it at a local worker. */
class HttpDirectory(private val base: String, allowDevHttp: Boolean = false) : Directory {
    init { require(base.startsWith("https://") || (allowDevHttp && DEV_HTTP.any { base.startsWith(it) })) { "the directory is reached over https" } }

    private fun post(path: String, body: String): Pair<Int, String>? = try {
        val c = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        c.requestMethod = "POST"; c.connectTimeout = 10_000; c.readTimeout = 20_000; c.doOutput = true
        c.instanceFollowRedirects = false
        c.setRequestProperty("content-type", "application/json")
        c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val status = c.responseCode
        val text = (if (status in 200..299) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        status to text
    } catch (e: java.io.IOException) { null }

    override fun bindStart(stmt: String, sig: String): Directory.Started {
        val r = post("/v1/bind/start", """{"stmt":${Json.quote(stmt)},"sig":${Json.quote(sig)}}""") ?: return Directory.Started.Unreachable
        return if (r.first == 202) Directory.Started.Accepted else Directory.Started.Refused(r.first)
    }

    override fun bindComplete(email: String, code: String, sig: String): Directory.Complete {
        val r = post("/v1/bind/complete", """{"email":${Json.quote(email)},"code":${Json.quote(code)},"sig":${Json.quote(sig)}}""")
            ?: return Directory.Complete.Unreachable
        if (r.first != 200) return Directory.Complete.Rejected
        val o = Json.obj(Json.parse(r.second)) ?: return Directory.Complete.Rejected
        fun s(k: String) = o[k] as? String
        return Directory.Complete.Ok(Directory.Completed(
            s("binding") ?: return Directory.Complete.Rejected, s("sig") ?: return Directory.Complete.Rejected,
            s("attestation") ?: return Directory.Complete.Rejected, s("attestationSig") ?: return Directory.Complete.Rejected))
    }

    override fun challenge(email: String): String? {
        val r = post("/v1/challenge", """{"email":${Json.quote(email)}}""") ?: return null
        if (r.first != 200) return null
        return Json.obj(Json.parse(r.second))?.get("challenge") as? String
    }

    override fun recoveryEnrol(email: String, body: ByteArray, req: String, sig: String, challenge: String,
                               consent: Directory.ConsentProof): Directory.Enrol {
        val c = consent
        val r = post("/v1/recovery/enrol", """{"email":${Json.quote(email)},"body":${Json.quote(B64u.enc(body))},"req":${Json.quote(req)},""" +
            """"sig":${Json.quote(sig)},"challenge":${Json.quote(challenge)},"consent":{"dev":${Json.quote(c.dev)},"devSig":${Json.quote(c.devSig)},""" +
            """"cns":${Json.quote(c.cns)},"cnsSig":${Json.quote(c.cnsSig)}}}""") ?: return Directory.Enrol.Unreachable
        return when {
            r.first == 200 -> Directory.Enrol.Enrolled
            r.first == 404 -> Directory.Enrol.NotAvailable
            else -> Directory.Enrol.Refused(r.first, (Json.obj(Json.parse(r.second))?.get("reason") as? String) ?: "")
        }
    }

    companion object {
        /** Cleartext only for the emulator's host alias and loopback, and only when the caller says it is a debug build. */
        val DEV_HTTP = listOf("http://10.0.2.2:", "http://127.0.0.1:", "http://localhost:")
    }
}
