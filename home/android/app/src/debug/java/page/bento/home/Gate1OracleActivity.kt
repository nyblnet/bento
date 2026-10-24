// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.io.File

/**
 * DEBUG ONLY: gate 1's browser oracle on Android's own engine (security, after
 * #825). Driven by scripts/test-home-android-gate1-oracle.mjs, which pushes
 * mutants of a synthetic release to files/oracle/ with the REFERENCE's verdict
 * for each, then launches this.
 *
 * For every case, Gate1.kt gives its verdict. Every case it calls GENUINE, and
 * every control, is loaded in a WebView with NO CSP, recording what ran: the
 * release's loader and remover push to window.__ran, every candidate pushes its
 * own name, and a data block that executes throws (its text isn't JavaScript),
 * which a window error counter sees. Results go to files/oracle/results.json.
 */
class Gate1OracleActivity : AppCompatActivity() {
    private val dir by lazy { File(filesDir, "oracle") }
    private lateinit var web: WebView
    private var html = ""
    private val queue = ArrayDeque<Map<*, *>>()
    private val results = ArrayList<Map<String, Any?>>()
    private lateinit var history: Gate1.History

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        File(dir, "results.json").delete()
        history = Gate1.historyOf(Json.read(File(dir, "history.json").readText()))!!
        web = WebView(this).apply { settings.javaScriptEnabled = true }
        setContentView(web)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web,
                "window.__ran=[];window.__errors=0;addEventListener('error',function(){window.__errors++},true);", setOf("*"))
        } else { Log.e(TAG, "no document-start scripts on this WebView"); finish(); return }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, r: WebResourceRequest): WebResourceResponse =
                if (r.url.toString() == URL) WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(html.toByteArray()))
                else WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            override fun onPageFinished(view: WebView, url: String) {
                view.postDelayed({
                    view.evaluateJavascript("JSON.stringify({ran:window.__ran||null,errors:window.__errors})") { s ->
                        val ran = Json.read(Json.read(s) as String) as Map<*, *>
                        val cur = queue.removeFirst()
                        results += mapOf("file" to cur["file"], "ref" to cur["ref"], "kotlin" to cur["kotlin"],
                            "control" to cur["control"], "ran" to ran["ran"], "errors" to ran["errors"])
                        next()
                    }
                }, 150)
            }
        }
        @Suppress("UNCHECKED_CAST")
        val cases = Json.read(File(dir, "index.json").readText()) as List<Map<*, *>>
        var verdicts = 0
        for (c in cases) {
            val f = File(dir, c["file"] as String).readText()
            val kotlin = if (Gate1.verifyServed(f, history) is Gate1.Verdict.Genuine) "genuine" else "unknown"
            verdicts++
            val entry = LinkedHashMap<Any?, Any?>(c).apply { put("kotlin", kotlin) }
            if (kotlin == "genuine" || c["control"] == true) queue.addLast(entry)
            else results += mapOf("file" to c["file"], "ref" to c["ref"], "kotlin" to kotlin, "control" to false)
        }
        Log.i(TAG, "verdicts: $verdicts, loading ${queue.size}")
        next()
    }

    private fun next() {
        val cur = queue.firstOrNull()
        if (cur == null) {
            File(dir, "results.json.tmp").writeText(Json.write(results))
            File(dir, "results.json.tmp").renameTo(File(dir, "results.json"))
            Log.i(TAG, "ORACLE DONE ${results.size}")
            return
        }
        html = File(dir, cur["file"] as String).readText()
        web.loadUrl(URL)
    }

    companion object {
        const val TAG = "BentoGate1Oracle"
        const val URL = "https://bento-oracle.test/doc.html"
    }
}
