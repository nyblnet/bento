// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File
import java.security.MessageDigest

/**
 * First-page thumbnails, rendered once and cached as bitmaps.
 *
 * The other two hosts get this free and in different ways, which is worth
 * knowing before reading the code here:
 *
 *  - **iOS renders nothing.** `UIDocumentBrowserViewController` asks the SYSTEM
 *    to thumbnail the `.bento.html`, and the iOS thumbnailer draws the embedded
 *    `[data-bento-preview]` block because it runs no JavaScript. That block
 *    exists precisely so file managers can do this (`kernel/src/preview.ts`).
 *  - **home/webext** sets `iframe.srcdoc = preview`. It is a browser.
 *
 * Android has neither: no system HTML thumbnailer (`getDocumentThumbnail` asks
 * the provider, and the downloads provider has nothing for an HTML file), and a
 * native list is not a browser. So this host is the only one that renders the
 * block itself.
 *
 * ONE WebView, OFFSCREEN, AT INDEX TIME — emphatically not one per row. A
 * WebView per list row is the design rejected in `docs/DECISIONS.md` for cold
 * start and accessibility, and for a while that ruled out thumbnails here
 * altogether. It should not have: rendering each preview once into a cached
 * bitmap costs nothing at launch, leaves the list plain `ImageView`s, and reuses
 * a single WebView for every document.
 *
 * The bitmaps live in `cacheDir`, which Android empties under storage pressure —
 * exactly right for something reconstructible from a document we still hold.
 */
object Thumbnails {

    private const val TAG = "BentoTray"

    /** Output size, at the deck's canonical 16:9. A deck with a different page
     *  size letterboxes inside this rather than distorting. */
    private const val W = 384
    private const val H = 216

    /** WebView lays out and scales in DP, and the capture is in PIXELS. Ignoring
     *  that renders everything `density` times too large and captures a crop —
     *  the slide's text filled the frame with three letters of it. So the render
     *  box is W x H DP, which is W*density x H*density pixels, and the bitmap is
     *  scaled down afterwards. Rendering large and downscaling also gives
     *  noticeably crisper text than rendering at final size. */
    private fun renderW(c: Context) = (W * c.resources.displayMetrics.density).toInt()
    private fun renderH(c: Context) = (H * c.resources.displayMetrics.density).toInt()

    private val main = Handler(Looper.getMainLooper())

    /** Documents whose preview produced nothing. Without this the list retries
     *  the same failing render every time it scrolls past. */
    private val barren = HashSet<String>()

    private fun keyOf(uri: Uri, modified: Long): String {
        val d = MessageDigest.getInstance("SHA-256")
            .digest("$uri|$modified".toByteArray())
        return d.joinToString("") { "%02x".format(it) }.take(24)
    }

    private fun fileFor(c: Context, key: String) = File(File(c.cacheDir, "thumbs"), "$key.webp")

    /** The cached bitmap, or null. Cheap enough to call from a list adapter. */
    fun cached(c: Context, uri: Uri, modified: Long): Bitmap? {
        val f = fileFor(c, keyOf(uri, modified))
        if (!f.exists()) return null
        return try {
            BitmapFactory.decodeFile(f.absolutePath)
        } catch (e: Exception) {
            Log.w(TAG, "unreadable thumb", e); null
        }
    }

    /**
     * Render one document's preview, then call back on the main thread.
     *
     * Serialised through a single WebView because a WebView may only be touched
     * from the main thread, and because rendering several at once would buy
     * nothing — each is a still frame that draws in milliseconds.
     */
    fun request(c: Context, uri: Uri, modified: Long, done: (Bitmap?) -> Unit) {
        val key = keyOf(uri, modified)
        if (key in barren) { done(null); return }
        cached(c, uri, modified)?.let { done(it); return }
        queue += Pending(c.applicationContext, uri, modified, key, done)
        pump()
    }

    private class Pending(
        val ctx: Context, val uri: Uri, val modified: Long, val key: String,
        val done: (Bitmap?) -> Unit,
    )

    private val queue = ArrayDeque<Pending>()
    private var busy = false
    private var web: WebView? = null
    private var host: ViewGroup? = null

    /**
     * Give the renderer a real window to live in.
     *
     * A detached WebView draws the wrong thing, not nothing: `measure`/`layout`
     * on a view with no window never reaches the renderer, so the CSS viewport
     * stays at WebView's default (~980px) while the capture box is a fraction of
     * that — and the preview block, which sizes itself against 100vw, rendered
     * at 980 and was captured as a magnified crop of its top-left corner.
     *
     * So the WebView is attached, sized exactly W x H, and made invisible with
     * alpha rather than visibility: GONE and INVISIBLE both skip the layout or
     * the draw this depends on.
     */
    fun attach(container: ViewGroup) { host = container }

    private fun pump() {
        if (busy || queue.isEmpty()) return
        busy = true
        val job = queue.removeFirst()

        // The preview is fetched only now, and only for what is actually being
        // drawn. Selecting it for every row of a 300-document list would pull
        // megabytes of markup into memory to show a handful of pictures.
        val html = Library.previewFor(job.ctx, job.uri)
        if (html.isNullOrBlank()) {
            barren += job.key
            finish(job, null)
            return
        }

        val parent = host
        if (parent == null) { finish(job, null); return }

        val v = web ?: WebView(parent.context).also {
            it.settings.javaScriptEnabled = false   // a still render; nothing to run
            it.settings.blockNetworkLoads = true    // self-contained, and stays that way
            // Without BOTH of these WebView ignores the page's viewport and lays
            // out at its default ~980 CSS px. The preview block sizes itself
            // against 100vw, so it then scaled to 980 while the view was ~128 CSS
            // px wide and the capture was a magnified crop of the top-left
            // corner — dots and a stray curve, no slide.
            it.settings.useWideViewPort = true
            it.settings.loadWithOverviewMode = true
            it.setBackgroundColor(Color.WHITE)
            // Software layer, because the bitmap comes from draw(Canvas) and a
            // hardware-accelerated layer has nothing for that canvas to copy.
            it.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
            it.alpha = 0f
            it.isFocusable = false
            parent.addView(it, ViewGroup.LayoutParams(renderW(parent.context), renderH(parent.context)))
            web = it
        }

        v.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                // onPageFinished fires when LOADING is done, which is before the
                // first frame is composited — capturing here gives a blank
                // bitmap often enough to look like a bug in the preview itself.
                // postVisualStateCallback is the API that actually means "the
                // next draw will show this".
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    view.postVisualStateCallback(1L, object : WebView.VisualStateCallback() {
                        override fun onComplete(requestId: Long) = capture(job, view)
                    })
                } else {
                    main.postDelayed({ capture(job, view) }, 120)
                }
            }
        }

        // The viewport is pinned to the deck's canonical width, NOT
        // device-width, and that is the whole trick.
        //
        // The preview's outer element is `position:fixed; width:100%;
        // height:100%` — it covers the VIEWPORT, by design, because a
        // thumbnailer injects it into the real document. So the viewport has to
        // be the capture box. `width=device-width` resolves to the SCREEN width
        // in CSS px, not this view's width, and the mismatch rendered the block
        // far wider than the box: the capture was a magnified crop of its
        // top-left corner, all background dots and one stray curve.
        //
        // `width=1280` plus loadWithOverviewMode makes WebView lay out at 1280
        // CSS px — the width Bento decks are authored at — and scale the whole
        // thing down to fit, which is density-independent and needs no
        // arithmetic here.
        val page = """<!DOCTYPE html><html><head><meta name="viewport"
            content="width=1280"><style>
            html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff}
            </style></head><body>$html</body></html>"""
        v.loadDataWithBaseURL(null, page, "text/html", "utf-8", null)
    }

    private fun capture(job: Pending, v: WebView) {
        val bmp = try {
            val rw = renderW(job.ctx); val rh = renderH(job.ctx)
            val full = Bitmap.createBitmap(rw, rh, Bitmap.Config.ARGB_8888)
            full.eraseColor(Color.WHITE)
            v.draw(Canvas(full))
            Bitmap.createScaledBitmap(full, W, H, true).also { if (it !== full) full.recycle() }
        } catch (e: Exception) {
            Log.w(TAG, "thumb render failed", e); null
        }
        if (bmp != null) write(job, bmp) else barren += job.key
        finish(job, bmp)
    }

    private fun write(job: Pending, bmp: Bitmap) {
        try {
            val f = fileFor(job.ctx, job.key)
            f.parentFile?.mkdirs()
            f.outputStream().use {
                val fmt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                    Bitmap.CompressFormat.WEBP_LOSSY
                else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
                bmp.compress(fmt, 80, it)
            }
        } catch (e: Exception) {
            // A thumbnail that cannot be cached costs a re-render, nothing more.
            Log.w(TAG, "could not cache thumb", e)
        }
    }

    private fun finish(job: Pending, bmp: Bitmap?) {
        busy = false
        main.post { job.done(bmp) }
        main.post { pump() }
    }
}
