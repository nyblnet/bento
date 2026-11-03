// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class JsonDirectoryTest {
    @Test fun `json reads what the directory sends and refuses the rest`() {
        val o = Json.obj(Json.parse("""{"a":"xé\n","b":[1,2.5,true,null],"c":{"d":"e"}}"""))!!
        assertEquals("xé\n", o["a"]); assertEquals(listOf(1.0, 2.5, true, null), o["b"]); assertEquals(mapOf("d" to "e"), o["c"])
        for (bad in listOf("", "{", """{"a":1,}""", """{"a":1} x""", """{"a":1,"a":2}""", "[1 2]", """{"a":"\q"}""", "nul"))
            assertNull(bad, Json.parse(bad))
        assertNull("depth is bounded", Json.parse("[".repeat(40) + "]".repeat(40)))
        assertEquals("\"a\\\"b\\\\c\\u00e9\"", Json.quote("a\"b\\cé"))
    }

    /** A bare HTTP/1.1 responder on a socket (the Android SDK on the unit-test classpath has no com.sun.net). */
    private class Srv(val port: Int, private val sock: java.net.ServerSocket) { fun stop(@Suppress("UNUSED_PARAMETER") n: Int) = sock.close() }

    private fun server(handler: (String, String) -> Pair<Int, String>): Pair<Srv, String> {
        val ss = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!ss.isClosed) try {
                ss.accept().use { c ->
                    val inp = c.getInputStream().buffered()
                    fun line(): String { val sb = StringBuilder(); while (true) { val ch = inp.read(); if (ch < 0 || ch == '\n'.code) break; if (ch != '\r'.code) sb.append(ch.toChar()) }; return sb.toString() }
                    val path = line().split(" ")[1]
                    var len = 0
                    while (true) { val h = line(); if (h.isEmpty()) break; if (h.lowercase().startsWith("content-length:")) len = h.substringAfter(":").trim().toInt() }
                    val body = String(ByteArray(len).also { var n = 0; while (n < len) n += inp.read(it, n, len - n) }, Charsets.UTF_8)
                    val (code, out) = handler(path, body)
                    val b = out.toByteArray()
                    c.getOutputStream().apply { write("HTTP/1.1 $code X\r\ncontent-length: ${b.size}\r\nconnection: close\r\n\r\n".toByteArray()); write(b); flush() }
                }
            } catch (e: java.io.IOException) {}
        }.start()
        return Srv(ss.localPort, ss) to "http://127.0.0.1:${ss.localPort}"
    }

    @Test fun `the http client speaks the directory's two calls`() {
        val seen = mutableListOf<String>()
        val (srv, url) = server { path, body ->
            seen += "$path $body"
            when (path) {
                "/v1/bind/start" -> 202 to """{"ok":true}"""
                "/v1/bind/complete" -> if ("GOOD" in body) 200 to """{"binding":"b","sig":"s","attestation":"a","attestationSig":"as","rebound":false}""" else 400 to """{"error":"invalid"}"""
                else -> 404 to "{}"
            }
        }
        try {
            val d = HttpDirectory(url, allowDevHttp = true)
            assertTrue(d.bindStart("bind.x", "sig") is Directory.Started.Accepted)
            assertEquals("""/v1/bind/start {"stmt":"bind.x","sig":"sig"}""", seen[0])
            val ok = d.bindComplete("a@b.co", "GOODGOOD", "sig") as Directory.Complete.Ok
            assertEquals(listOf("b", "s", "a", "as"), with(ok.value) { listOf(binding, sig, attestation, attestationSig) })
            assertTrue(d.bindComplete("a@b.co", "BADBAD22", "sig") is Directory.Complete.Rejected)
        } finally { srv.stop(0) }
        assertTrue("nothing listening", HttpDirectory(url, allowDevHttp = true).bindStart("x", "y") is Directory.Started.Unreachable)
    }

    @Test fun `a redirect or an odd reply is a refusal, not a result`() {
        val (srv, url) = server { path, _ -> if (path.endsWith("start")) 302 to "" else 200 to """{"binding":"b"}""" }
        try {
            val d = HttpDirectory(url, allowDevHttp = true)
            assertTrue(d.bindStart("x", "y") is Directory.Started.Refused)
            assertTrue("missing fields", d.bindComplete("a@b.co", "K7Q3MZ2P", "s") is Directory.Complete.Rejected)
        } finally { srv.stop(0) }
    }

    @Test fun `cleartext is for a debug build's local directory only`() {
        for (u in listOf("http://id.bento.page", "http://10.0.2.2.evil.example", "ftp://x"))
            try { HttpDirectory(u, allowDevHttp = true); fail(u) } catch (e: IllegalArgumentException) {}
        try { HttpDirectory("http://10.0.2.2:8787"); fail("release must not accept cleartext") } catch (e: IllegalArgumentException) {}
        HttpDirectory("https://id.bento.page"); HttpDirectory("http://10.0.2.2:8787", allowDevHttp = true)
    }
}
