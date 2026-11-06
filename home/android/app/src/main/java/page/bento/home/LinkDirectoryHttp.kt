// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** [LinkDirectory] over the directory's link slot routes under `/v1/link/`. HTTPS in a release build, like [HttpDirectory]. */
class HttpLinkDirectory(private val base: String, allowDevHttp: Boolean = false) : LinkDirectory {
    private val plain = HttpDirectory(base, allowDevHttp)

    private fun call(method: String, path: String, body: String?, readMs: Int = 20_000): Pair<Int, String>? = try {
        val c = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        c.requestMethod = method; c.connectTimeout = 10_000; c.readTimeout = readMs; c.instanceFollowRedirects = false
        if (body != null) { c.doOutput = true; c.setRequestProperty("content-type", "application/json"); c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) } }
        val status = c.responseCode
        status to ((if (status in 200..299) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: "")
    } catch (e: java.io.IOException) { null }

    private fun idTok(s: Link.Slot) = "\"id\":${Json.quote(s.id)},\"tok\":${Json.quote(s.tok)}"
    private fun errorOf(text: String) = (Json.obj(Json.parse(text))?.get("error") as? String) ?: ""

    private fun reply(r: Pair<Int, String>?): LinkDirectory.R {
        if (r == null) return LinkDirectory.R.Unreachable
        return when (r.first) {
            200 -> LinkDirectory.R.Ok
            404 -> LinkDirectory.R.NotFound
            403 -> LinkDirectory.R.Forbidden
            409 -> errorOf(r.second).let { if (it == "contended") LinkDirectory.R.Contended else LinkDirectory.R.Gone(it) }
            else -> LinkDirectory.R.Refused(r.first, (Json.obj(Json.parse(r.second))?.get("reason") as? String) ?: errorOf(r.second))
        }
    }

    override fun open(slot: Link.Slot, msg: String) = reply(call("POST", "/v1/link/open", "{${idTok(slot)},\"msg\":${Json.quote(msg)}}"))
    override fun put(slot: Link.Slot, n: Int, msg: String) = reply(call("POST", "/v1/link/put", "{${idTok(slot)},\"n\":$n,\"msg\":${Json.quote(msg)}}"))

    override fun get(slot: Link.Slot, n: Int, waitMs: Long): LinkDirectory.Got {
        val r = call("POST", "/v1/link/get", "{${idTok(slot)},\"n\":$n,\"wait\":$waitMs}", readMs = 35_000)
            ?: return LinkDirectory.Got.Failed(LinkDirectory.R.Unreachable)
        if (r.first == 202) return LinkDirectory.Got.Pending
        if (r.first != 200) return LinkDirectory.Got.Failed(reply(r))
        val m = Json.obj(Json.parse(r.second))?.get("msg") as? String ?: return LinkDirectory.Got.Failed(LinkDirectory.R.Refused(200, "no-msg"))
        return LinkDirectory.Got.Msg(m)
    }

    override fun abort(slot: Link.Slot) { call("POST", "/v1/link/abort", "{${idTok(slot)}}") }

    override fun complete(slot: Link.Slot, email: String, challenge: String, msg3: String) =
        reply(call("POST", "/v1/link/complete", "{${idTok(slot)},\"email\":${Json.quote(email)},\"challenge\":${Json.quote(challenge)},\"msg3\":${Json.quote(msg3)}}"))

    override fun challenge(email: String) = plain.challenge(email)

    override fun lookup(email: String): LinkDirectory.Lookup? {
        val r = call("GET", "/v1/lookup?e=" + URLEncoder.encode(email, "UTF-8"), null) ?: return null
        if (r.first != 200) return null
        val o = Json.obj(Json.parse(r.second)) ?: return null
        fun s(k: String) = o[k] as? String
        return LinkDirectory.Lookup(s("binding") ?: return null, s("sig") ?: return null, s("attestation") ?: return null, s("attestationSig") ?: return null)
    }
}
