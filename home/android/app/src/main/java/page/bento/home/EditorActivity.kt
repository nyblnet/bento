// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.provider.OpenableColumns
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.EditText
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.MessageDigest

/**
 * Hosts one open document in a WebView and bridges saving to the Storage Access
 * Framework.
 *
 * This is the Android counterpart of `home/ios/EditorViewController.swift`, and
 * it keeps that file's two load-bearing decisions:
 *
 * 1. The document is served through an ORIGIN WE CONTROL, never `file://`. A
 *    `file://` page gets an opaque origin, which makes `localStorage` and
 *    IndexedDB unreliable — that would silently break the autosave backstop, the
 *    per-device collab member key, and the language and reduce-motion
 *    preferences. Here the origin is a real `https://` one that never leaves the
 *    device: every request to it is answered from memory by
 *    [shouldInterceptRequest], and the host ends in `.invalid`, which RFC 6761
 *    guarantees will never resolve — so the failure mode of a missed intercept
 *    is a dead load, never a silent request to somebody's server.
 *
 *    The host is PER DOCUMENT, derived from the document's own URI. This app
 *    opens ANY self-contained HTML document, so a shared origin would let one
 *    document read another's `localStorage` and IndexedDB — fine when every file
 *    is yours, a real leak between unrelated third-party apps. Derived rather
 *    than random because the origin IS the storage boundary: a fresh host per
 *    launch would wipe that storage on every open.
 *
 * 2. The web content is the DOCUMENT'S OWN runtime. The app bundles no shell for
 *    rendering and has no opinion about which version a document carries, so a
 *    deck self-updates through Bento's normal signed channel and Android users
 *    get the same release as everyone else on the same day. What the app ships
 *    is file access.
 */
class EditorActivity : Activity() {

    companion object {
        const val EXTRA_URI = "page.bento.home.URI"
        private const val TAG = "BentoTray"
        private const val REQ_EXPORT = 1
        private const val REQ_FILE_CHOOSER = 2

        /** Reduce a page-supplied filename to ONE plain component, or refuse it.
         *
         * The name arrives from the document, and this host treats documents as
         * mutually untrusted (that is why the origin is per-document). It ends up
         * as `EXTRA_TITLE` on a create-document intent, where a path separator is
         * at best meaningless and at worst a provider's problem. Refused rather
         * than repaired: a legitimate export name is already a single filename. */
        fun safeFileName(raw: String?): String? {
            if (raw.isNullOrEmpty()) return null
            val name = raw.substringAfterLast('/').substringAfterLast('\\')
            if (name.isEmpty() || name.startsWith(".")) return null
            return name
        }
    }

    private lateinit var web: WebView
    private var docUri: Uri? = null
    private var docName: String = "document.bento.html"
    private var bytes: ByteArray = ByteArray(0)

    /**
     * Can saves land on the open document, or must every one become a Save-As?
     *
     * This has no iOS counterpart, and it is the sharpest difference between the
     * two platforms. A document opened through the app's own picker
     * (ACTION_OPEN_DOCUMENT) carries a persistable read+write grant. A document
     * arriving by ACTION_VIEW — tapped in a file manager, opened from Drive or
     * Gmail — usually carries READ ONLY, because that is all the sender chose to
     * grant, and no API lets the receiver ask for more.
     *
     * So this is checked rather than assumed, and when it is false the first save
     * prompts instead of writing. Silently failing a save is the worst outcome
     * available; prompting costs a dialog. `home/README.md` states the rule for
     * the whole project: when in doubt, prompt.
     */
    private var canWriteInPlace = false

    /**
     * Has the open document been handed to the web app yet? Bento only reaches a
     * picker when it holds no handle — afterwards ⌘S, autosave write-back and
     * in-place update all reuse it. So the FIRST request targets this document
     * and needs no UI; any later one is a genuine Save-As or export and must not
     * overwrite it. Deciding that from the suggested name instead would fail:
     * Bento derives it from the deck TITLE, so it rarely matches, and every save
     * would wrongly prompt.
     */
    private var openDocumentVended = false

    private var replyProxy: JavaScriptReplyProxy? = null

    /** An export whose bytes are held while the user chooses where it goes. */
    private class PendingExport(val id: Int, val text: String)
    private var pendingExport: PendingExport? = null

    /** Stable per-document host: a truncated SHA-256 of the document's URI.
     *  Hex only, so it is always a valid host component. */
    private val originHost: String by lazy {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest((docUri?.toString() ?: "unsaved").toByteArray())
        digest.joinToString("") { "%02x".format(it) }.take(24) + ".bento-tray.invalid"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val uri = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            intent.getParcelableExtra(EXTRA_URI, Uri::class.java)
        else
            @Suppress("DEPRECATION") intent.getParcelableExtra<Uri>(EXTRA_URI)) ?: intent.data
        if (uri == null) { finish(); return }
        docUri = uri

        // An ACTION_VIEW sender grants for the life of this task only, so take
        // what durability is on offer before anything else can drop it.
        if (intent.action == Intent.ACTION_VIEW) {
            Recents.persist(contentResolver, uri, intent.flags)
        }
        canWriteInPlace = checkUriPermission(
            uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        ) == PackageManager.PERMISSION_GRANTED

        docName = displayName(uri) ?: "document.bento.html"

        // Read off the main thread: a document is the whole app, and decks run
        // to megabytes.
        Thread {
            val data = try {
                contentResolver.openInputStream(uri)?.use { it.readBytes() }
            } catch (e: Exception) {
                Log.w(TAG, "open failed", e); null
            }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (data == null) {
                    fatal(getString(R.string.err_open))
                } else {
                    bytes = data
                    Recents.touch(this, uri, docName)
                    startWebView()
                }
            }
        }.start()
    }

    private fun startWebView() {
        // Debug builds only: makes the document inspectable from
        // chrome://inspect, which is the only way to see what a hosted page is
        // actually doing. Gated on the manifest flag rather than BuildConfig so a
        // release build cannot expose a user's document no matter how it was
        // assembled.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        web = WebView(this)

        // The web view lives in a container whose PADDING carries the system
        // insets, rather than being inset itself: padding on a WebView insets its
        // scrollbars and its own content box, which a document then has to
        // account for.
        //
        // Reserve exactly what the system says is unsafe at the top, and nothing
        // else — so a document's own toolbar is reachable but never gives up a
        // pixel it did not have to. Done NATIVELY rather than by asking the page
        // to pad itself, because `--tray-safe-*` only helps a page that has heard
        // of this host; a third-party HTML file has no way to know, and its top
        // controls would sit under the status bar unreachable.
        val frame = FrameLayout(this)
        frame.addView(web, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(frame, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        frame.setOnApplyWindowInsetsListener { v, insets ->
            val top: Int; val left: Int; val right: Int; val bottom: Int
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                top = bars.top; left = bars.left; right = bars.right; bottom = bars.bottom
            } else {
                @Suppress("DEPRECATION")
                run {
                    top = insets.systemWindowInsetTop; left = insets.systemWindowInsetLeft
                    right = insets.systemWindowInsetRight; bottom = insets.systemWindowInsetBottom
                }
            }
            v.setPadding(0, top, 0, 0)
            // Report top as 0: the container is already inset by it, and a page
            // that DOES read these would otherwise pad twice.
            publishSafeArea(0, right, bottom, left)
            insets
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // The document is served from memory and is self-contained. Nothing
            // it holds should be reachable through the filesystem, and turning
            // these off costs it nothing.
            allowFileAccess = false
            allowContentAccess = false
            // Bento sets its own viewport; letting WebView second-guess it made
            // the deck render at desktop width and scale down.
            useWideViewPort = true
            loadWithOverviewMode = false
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? {
                val u = request.url
                if (u.host != originHost) return null
                // ANY path under our origin serves the document, matching the
                // iOS scheme handler. A self-contained document has no
                // subresources by definition, and diverging here would mean a
                // file that works on one host and not the other.
                return WebResourceResponse(
                    "text/html", "utf-8", 200, "OK",
                    mapOf("Content-Length" to bytes.size.toString()),
                    ByteArrayInputStream(bytes)
                )
            }

            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                // The document may not navigate away from itself. A link to the
                // web opens in the browser, where it belongs; anything else on
                // our own origin is served above.
                val u = request.url
                if (u.host == originHost) return false
                if (u.scheme == "http" || u.scheme == "https" || u.scheme == "mailto") {
                    try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
                }
                return true
            }
        }

        web.webChromeClient = TrayChromeClient()

        installBridge()

        // `<a download>` and blob: saves — the older, commoner idiom that is not
        // File System Access at all (TiddlyWiki, and most "export this page"
        // tools). WebView drops these silently without a listener, so the button
        // appears to do nothing, which is the worst possible failure for a save.
        web.setDownloadListener { url, _, contentDisposition, _, _ ->
            startDownload(url, contentDisposition)
        }

        registerBackHandling()
        web.loadUrl("https://$originHost/index.html")
    }

    /**
     * Inject the polyfill and open the reply channel.
     *
     * Both halves are androidx.webkit APIs rather than the framework's own, and
     * both choices are deliberate:
     *
     * - `addDocumentStartJavaScript` is the exact equivalent of WebKit's
     *   `WKUserScript(.atDocumentStart)`. Bento decides whether it can save
     *   DURING BOOT, so a script injected from `onPageStarted` or
     *   `onPageFinished` has already lost the race some of the time — and the
     *   symptom is not a crash, it is an editor that quietly believes it cannot
     *   save.
     * - `addWebMessageListener` is ORIGIN-SCOPED. `addJavascriptInterface` — the
     *   dependency-free alternative, and what most WebView wrappers reach for —
     *   is injected into EVERY frame, so a remote iframe inside an untrusted
     *   document would be handed a channel that overwrites the user's file.
     */
    private fun installBridge() {
        val rules = setOf("https://$originHost")

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // Both shipped in WebView 83 (2020) and it updates through Play, so
            // this is close to unreachable — but "close to" is not "never", and
            // the honest failure is to say the app cannot save rather than to
            // open a document that silently will not.
            fatal(getString(R.string.err_webview_old))
            return
        }

        WebViewCompat.addWebMessageListener(web, "__bentoTrayNative", rules) { _, message, _, isMainFrame, proxy ->
            if (!isMainFrame) return@addWebMessageListener
            replyProxy = proxy
            message.data?.let { onBridgeMessage(it) }
        }

        val src = assets.open("bridge.js").use { it.readBytes().toString(Charsets.UTF_8) }
        WebViewCompat.addDocumentStartJavaScript(web, src, rules)
    }

    /**
     * The things a WebView does NOT do on its own, and fails at silently.
     *
     * Without a `WebChromeClient` a WebView does not merely skip these — it
     * answers them wrongly and says nothing:
     *
     *  - `alert()` is a no-op, so a warning the document meant to show is
     *    swallowed.
     *  - **`confirm()` returns `false`**, immediately, with no dialog. Every one
     *    of the runtime's seven uses is shaped `if (!confirm(…)) return`, so the
     *    whole feature behind it — delete this slide, remove a collaborator,
     *    reset access, embed a large file — just does nothing when tapped. There
     *    is no error and nothing in the log.
     *  - **`<input type="file">` cannot open at all**, which is how images,
     *    video, audio and fonts get into a deck.
     *
     * `home/ios` had the same hole (`WKUIDelegate` is required there for the
     * dialogs; WKWebView does handle file inputs itself) and was fixed in the
     * same change.
     *
     * NOTE the omission: `onShowCustomView` is deliberately NOT implemented, so
     * element fullscreen is declined — the same answer `home/ios` gives, for the
     * same reasons. A page refused fullscreen falls back to filling its view,
     * which is the well-trodden mobile path, and the host has already handed it
     * the whole screen anyway.
     */
    private inner class TrayChromeClient : WebChromeClient() {

        override fun onJsAlert(
            view: WebView?, url: String?, message: String?, result: JsResult
        ): Boolean {
            AlertDialog.Builder(this@EditorActivity)
                .setMessage(message ?: "")
                .setCancelable(false)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setOnDismissListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsConfirm(
            view: WebView?, url: String?, message: String?, result: JsResult
        ): Boolean {
            AlertDialog.Builder(this@EditorActivity)
                .setMessage(message ?: "")
                .setCancelable(false)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnDismissListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsPrompt(
            view: WebView?, url: String?, message: String?, defaultValue: String?,
            result: JsPromptResult
        ): Boolean {
            val field = EditText(this@EditorActivity).apply { setText(defaultValue ?: "") }
            AlertDialog.Builder(this@EditorActivity)
                .setMessage(message ?: "")
                .setView(field)
                .setCancelable(false)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm(field.text.toString()) }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnDismissListener { result.cancel() }
                .show()
            return true
        }

        /** `beforeunload` — the document is served from memory and never
         *  navigates away, so this can only fire on a reload. Confirm it rather
         *  than leaving the page blocked forever waiting for an answer. */
        override fun onJsBeforeUnload(
            view: WebView?, url: String?, message: String?, result: JsResult
        ): Boolean {
            result.confirm()
            return true
        }

        /**
         * `<input type="file">`. Restored from #87's `native/android`, which had
         * this and was right to.
         *
         * The callback MUST be answered exactly once. Dropping it leaves the
         * page's file input permanently dead — not for that attempt, for the rest
         * of the session — so a superseded chooser is cancelled here, and
         * [onActivityResult] answers every outcome including a cancel.
         */
        override fun onShowFileChooser(
            view: WebView, callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams
        ): Boolean {
            pendingFileChooser?.onReceiveValue(null)
            pendingFileChooser = callback
            return try {
                startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER)
                true
            } catch (e: Exception) {
                Log.w(TAG, "no file chooser available", e)
                pendingFileChooser = null
                callback.onReceiveValue(null)
                false
            }
        }
    }

    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null

    /**
     * Hand the real insets to the page as CSS custom properties.
     *
     * The same `--tray-safe-*` contract the iOS host publishes, for the same
     * reason: a document that knows about this host can keep its own chrome clear
     * of the status bar and the gesture pill, and one that has never heard of it
     * is unaffected — the variables simply go unread.
     *
     * Density matters here. `WindowInsets` are in physical pixels and CSS is in
     * device-independent ones, so the raw numbers would be roughly three times
     * too large on a modern phone — a page reading them would push its toolbar
     * most of the way down the screen.
     */
    private fun publishSafeArea(top: Int, right: Int, bottom: Int, left: Int) {
        if (!this::web.isInitialized) return
        val d = resources.displayMetrics.density
        val css = { px: Int -> (px / d).toInt() }
        val js = "(function(){var r=document.documentElement.style;" +
            "r.setProperty('--tray-safe-top','${css(top)}px');" +
            "r.setProperty('--tray-safe-right','${css(right)}px');" +
            "r.setProperty('--tray-safe-bottom','${css(bottom)}px');" +
            "r.setProperty('--tray-safe-left','${css(left)}px');})();"
        web.evaluateJavascript(js, null)
    }

    // MARK: - the save bridge

    private fun onBridgeMessage(raw: String) {
        val m = try { JSONObject(raw) } catch (e: Exception) {
            Log.w(TAG, "unparseable bridge message", e); return
        }
        val id = m.optInt("id", -1)
        when (m.optString("op")) {
            "begin" -> {
                if (!openDocumentVended && canWriteInPlace) {
                    openDocumentVended = true
                    reply(id, true, docName)
                } else {
                    // Either a copy/template/read-only export, or a document we
                    // hold no write grant on. Both must end at a picker, and
                    // neither may land on the open file.
                    //
                    // Normalised HERE as well as at the write, because this name
                    // is handed back to the page and comes straight back as the
                    // write target: sanitising only one end would leave the two
                    // disagreeing about what file the handle refers to.
                    reply(id, true, exportName(m.optString("suggestedName")))
                }
            }

            "read" -> {
                // getFile() and createWritable({keepExistingData}) need the bytes
                // currently on disk. Only the OPEN document is readable — an
                // export target is somewhere we were handed once and do not hold.
                if (targetsOpenDocument(m.optString("name"))) {
                    reply(id, true, bytes.toString(Charsets.UTF_8))
                } else {
                    reply(id, true, null)
                }
            }

            "write" -> {
                val text = m.optString("text")
                if (targetsOpenDocument(m.optString("name"))) {
                    writeInPlace(id, text)
                } else {
                    beginExport(id, m.optString("name"), text)
                }
            }

            "download" -> {
                // The readback half of the `<a download>` path — see
                // startDownload(). No reply: nothing is waiting on it.
                pendingExport = PendingExport(-1, m.optString("text"))
                launchCreateDocument(safeFileName(m.optString("name")) ?: "download.html")
            }

            else -> reply(id, false, "unknown op")
        }
    }

    /**
     * The name to vend for an export handle: sanitised, and never the open
     * document's.
     *
     * The vended name IS the handle as far as this bridge is concerned — read and
     * write carry nothing else to tell two handles apart — so an export vended
     * under the open document's filename would BE the open document's handle, and
     * its close() would overwrite the original in place. That is not exotic:
     * Bento suggests an export name derived from the deck TITLE, so a deck saved
     * under its own title makes "Duplicate as new deck…" suggest exactly the open
     * file's name.
     *
     * Prefixed rather than numbered, because ".bento.html" is a DOUBLE extension
     * that splitting on the last dot cuts down the middle ("Notes.bento 2.html").
     */
    private fun exportName(suggested: String?): String {
        val name = safeFileName(suggested) ?: "deck.bento.html"
        return if (name == docName) "copy of $name" else name
    }

    /**
     * Does a read/write from the page address the OPEN document, or an export?
     *
     * Both halves are load-bearing. Comparing names is only sound because
     * [exportName] guarantees no export handle is ever vended under this name;
     * requiring that the document was actually vended means a name the page
     * produced on its own — no handle for it ever handed out — cannot address the
     * file the user opened.
     */
    private fun targetsOpenDocument(name: String?) = openDocumentVended && name == docName

    private fun writeInPlace(id: Int, text: String) {
        val uri = docUri ?: return reply(id, false, "no document")
        val data = text.toByteArray()
        Thread {
            val err = try {
                // "wt" TRUNCATES. Plain "w" leaves any bytes past the new length
                // in place, so saving a document that got shorter would leave the
                // tail of the previous version glued to the end of the new one —
                // and for a Bento shell that tail contains a second, stale
                // #bento-doc block.
                contentResolver.openOutputStream(uri, "wt")?.use { it.write(data) }
                    ?: "no output stream"
                null
            } catch (e: Exception) {
                Log.w(TAG, "write failed", e); e.message ?: "write failed"
            }
            runOnUiThread {
                if (err == null) bytes = data
                reply(id, err == null, err)
            }
        }.start()
    }

    private fun beginExport(id: Int, name: String?, text: String) {
        val safe = safeFileName(name) ?: return reply(id, false, "unsafe name")
        pendingExport = PendingExport(id, text)
        launchCreateDocument(safe)
    }

    private fun launchCreateDocument(name: String) {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "text/html"
            putExtra(Intent.EXTRA_TITLE, name)
        }
        try {
            startActivityForResult(intent, REQ_EXPORT)
        } catch (e: Exception) {
            val p = pendingExport; pendingExport = null
            if (p != null && p.id >= 0) reply(p.id, false, "no picker available")
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_FILE_CHOOSER) {
            val cb = pendingFileChooser
            pendingFileChooser = null
            // Answered on EVERY path, cancel included: an unanswered callback
            // leaves the page's file input dead for the rest of the session.
            cb?.onReceiveValue(
                if (resultCode == RESULT_OK)
                    WebChromeClient.FileChooserParams.parseResult(resultCode, data)
                else null
            )
            return
        }
        if (requestCode != REQ_EXPORT) return super.onActivityResult(requestCode, resultCode, data)
        val p = pendingExport
        pendingExport = null
        val target = data?.data

        // A cancelled picker is a save that did not happen, and the page is told
        // so. Reporting success would leave Bento believing a copy exists.
        if (p == null) return
        if (resultCode != RESULT_OK || target == null) {
            if (p.id >= 0) reply(p.id, false, "cancelled")
            return
        }

        val payload = p.text.toByteArray()
        Thread {
            val err = try {
                contentResolver.openOutputStream(target, "wt")?.use { it.write(payload) }
                    ?: "no output stream"
                null
            } catch (e: Exception) {
                Log.w(TAG, "export failed", e); e.message ?: "export failed"
            }
            runOnUiThread {
                if (p.id >= 0) reply(p.id, err == null, err)
                if (err != null) notify(getString(R.string.err_export))
            }
        }.start()
    }

    /**
     * Replies travel as JSON through the same origin-scoped channel.
     *
     * Worth noting against the iOS host, which replies by evaluating a JS call
     * and therefore has to encode the payload as a JavaScript string literal by
     * hand — a `read` reply carries the WHOLE document, and a raw newline in it
     * is a syntax error that hangs the page's promise forever. Here the payload
     * is data, not code, so that whole class of bug does not exist.
     */
    private fun reply(id: Int, ok: Boolean, value: String?) {
        if (id < 0) return
        val o = JSONObject().put("id", id).put("ok", ok)
        if (value != null) o.put("value", value) else o.put("value", JSONObject.NULL)
        try { replyProxy?.postMessage(o.toString()) } catch (e: Exception) {
            Log.w(TAG, "reply failed", e)
        }
    }

    // MARK: - downloads

    /**
     * `<a download>` and blob: saves.
     *
     * Unlike iOS, every download ends at a picker rather than in an app folder.
     * Android has no equivalent of "the app's Documents folder, visible in
     * Files" that a user would ever find — the app-private external directory is
     * effectively invisible — so a silent write would be a file the user cannot
     * locate. A document that saves OFTEN should be using the File System Access
     * path above, which prompts once and never again.
     *
     * A blob: URL cannot be fetched by native code at all: it exists only inside
     * the page's own origin. So the page is asked to read it back through the
     * bridge, which is the same trick every WebView-based browser uses.
     */
    private fun startDownload(url: String, contentDisposition: String?) {
        val name = safeFileName(fileNameFrom(contentDisposition)) ?: "download.html"
        if (url.startsWith("blob:") || url.startsWith("data:")) {
            val js = """
                (function(){
                  fetch(${JSONObject.quote(url)})
                    .then(function(r){ return r.blob() })
                    .then(function(b){ return b.text() })
                    .then(function(t){
                      __bentoTrayNative.postMessage(JSON.stringify(
                        { op: 'download', name: ${JSONObject.quote(name)}, text: t }))
                    })
                    .catch(function(){})
                })();
            """.trimIndent()
            web.evaluateJavascript(js, null)
            return
        }
        // An ordinary URL the page linked to. Let the browser have it: it has the
        // download UI, the notification and the resume logic already.
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {
            notify(getString(R.string.err_download))
        }
    }

    private fun fileNameFrom(contentDisposition: String?): String? {
        val cd = contentDisposition ?: return null
        val m = Regex("""filename\*?=(?:UTF-8'')?"?([^";]+)"?""", RegexOption.IGNORE_CASE).find(cd)
        return m?.groupValues?.get(1)?.let { Uri.decode(it) }
    }

    // MARK: - odds and ends

    private fun displayName(uri: Uri): String? = try {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
    } catch (e: Exception) {
        Log.w(TAG, "name lookup failed", e); null
    }

    override fun onResume() {
        super.onResume()
        // Said once, on the first resume, and only when it is true. A document
        // that cannot be saved back is still worth opening — reading and
        // presenting work — but the user has to know before they edit it.
        if (!canWriteInPlace && !warnedReadOnly) {
            warnedReadOnly = true
            notify(getString(R.string.notice_read_only))
        }
    }
    private var warnedReadOnly = false

    private fun notify(message: String) {
        AlertDialog.Builder(this)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun fatal(message: String) {
        AlertDialog.Builder(this)
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
            .show()
    }

    override fun onDestroy() {
        // Never strand a file-chooser callback: the WebView may outlive this
        // activity briefly, and an unanswered one is a leak with a visible
        // symptom.
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = null
        // A WebView outlives its activity if anything still references it, and
        // it holds the whole document. Detach and destroy explicitly.
        if (this::web.isInitialized) {
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    /**
     * The document owns the back gesture while it has history of its own —
     * present mode, a dialog, a state slide. Only when it has none does back mean
     * "leave the document".
     *
     * Registered TWO ways, and both are needed. The manifest opts this app into
     * the predictive back gesture (`enableOnBackInvokedCallback`), and that opt-in
     * stops `onBackPressed` from being called at all on Android 13+ — so an
     * override alone would compile, run, and silently do nothing on every current
     * device, dropping the user out of a document on the first back gesture.
     */
    private fun handleBack() {
        if (this::web.isInitialized && web.canGoBack()) web.goBack() else finish()
    }

    private fun registerBackHandling() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT
            ) { handleBack() }
        }
    }

    @Deprecated("Superseded by OnBackInvokedCallback above; still the path below API 33")
    override fun onBackPressed() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
        handleBack()
    }
}
