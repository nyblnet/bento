// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.tray

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView

/**
 * The app's root: the documents this app can reach.
 *
 * iOS gets `UIDocumentBrowserViewController` — a whole file browser, hostable,
 * showing iCloud and every File Provider on the device. Android has nothing to
 * host: its picker is a one-shot dialog that returns a URI and closes. So the
 * root is a list of documents the user has already granted, plus the two ways in.
 *
 * That difference is worth stating plainly rather than apologising for. On iOS
 * the app is a lens onto the filesystem; on Android it is a keyring. Both end at
 * the same place — a document opened where it already lives, with edits going
 * back to that same file.
 */
class DocumentsActivity : Activity() {

    companion object {
        private const val TAG = "BentoTray"
        private const val REQ_OPEN = 1
        private const val REQ_NEW = 2
        private const val SEED = "starter.bento.html"
    }

    private lateinit var list: ListView
    private lateinit var empty: TextView
    private var entries: List<Recents.Entry> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        entries = Recents.prune(this)
        (list.adapter as RecentsAdapter).notifyDataSetChanged()
        empty.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
        list.visibility = if (entries.isEmpty()) View.GONE else View.VISIBLE
    }

    // MARK: - getting documents in

    /**
     * ACTION_OPEN_DOCUMENT, not ACTION_GET_CONTENT.
     *
     * GET_CONTENT hands back a COPY, which is the whole problem this app exists
     * to solve — every save would land somewhere other than the file the user
     * opened. OPEN_DOCUMENT returns a durable, writable reference to the document
     * itself, and it is the only Android API that does.
     */
    private fun openDocument() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // Permissive on type, deliberate about it: providers disagree about
            // what a .bento.html is, and several report octet-stream. A filter
            // that hides the user's own document is worse than one that shows
            // too much.
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/html", "application/octet-stream"))
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }
        startActivityForResult(intent, REQ_OPEN)
    }

    /**
     * A new document is seeded from the bundled starter shell.
     *
     * The user chooses where it goes, which is not a compromise: it means the new
     * document is a real file in the user's own storage from its first byte, with
     * a persistable write grant already attached. There is no app-private staging
     * copy to migrate later, and no file the user cannot find.
     */
    private fun newDocument() {
        if (!hasSeed()) {
            AlertDialog.Builder(this)
                .setMessage(getString(R.string.err_no_seed))
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "text/html"
            putExtra(Intent.EXTRA_TITLE, "Untitled.bento.html")
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }
        startActivityForResult(intent, REQ_NEW)
    }

    private fun hasSeed() = try {
        assets.list("")?.contains(SEED) == true
    } catch (_: Exception) { false }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null) {
            return super.onActivityResult(requestCode, resultCode, data)
        }
        Recents.persist(contentResolver, uri, data.flags)

        when (requestCode) {
            REQ_OPEN -> open(uri)
            REQ_NEW -> seedThenOpen(uri)
            else -> super.onActivityResult(requestCode, resultCode, data)
        }
    }

    private fun seedThenOpen(uri: Uri) {
        Thread {
            val ok = try {
                assets.open(SEED).use { input ->
                    contentResolver.openOutputStream(uri, "wt")?.use { input.copyTo(it) }
                        ?: throw IllegalStateException("no output stream")
                }
                true
            } catch (e: Exception) {
                Log.w(TAG, "seed failed", e); false
            }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (ok) open(uri) else AlertDialog.Builder(this)
                    .setMessage(getString(R.string.err_create))
                    .setPositiveButton(android.R.string.ok, null)
                    .show()
            }
        }.start()
    }

    private fun open(uri: Uri) {
        startActivity(Intent(this, EditorActivity::class.java).putExtra(EditorActivity.EXTRA_URI, uri))
    }

    // MARK: - a plain UI, built in code
    //
    // No layout XML and no AndroidX UI libraries: this screen is a title, two
    // buttons and a list. Every dependency it does not have is one that cannot
    // drift out of step with the WebView work, which is where all the difficulty
    // in this app actually lives.

    private fun buildUi(): View {
        val dp = { v: Int -> (v * resources.displayMetrics.density).toInt() }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#F0EBE0"))
        }

        // Insets are applied by hand, and both halves of that are deliberate.
        //
        // `fitsSystemWindows = true` was the first attempt and it is a trap: it
        // does not ADD the system insets to a view's padding, it REPLACES the
        // padding outright. The screen lost its 20dp side margin and the title
        // sat flush against the edge of the display.
        //
        // Doing nothing is not an option either — from targetSdk 35 an app draws
        // edge to edge whether it asks to or not, so the header would sit under
        // the status bar. This is the only way to have both.
        val pad = intArrayOf(dp(20), dp(28), dp(20), dp(12))
        root.setOnApplyWindowInsetsListener { v, insets ->
            val l: Int; val t: Int; val r: Int; val b: Int
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                l = bars.left; t = bars.top; r = bars.right; b = bars.bottom
            } else {
                @Suppress("DEPRECATION")
                run {
                    l = insets.systemWindowInsetLeft; t = insets.systemWindowInsetTop
                    r = insets.systemWindowInsetRight; b = insets.systemWindowInsetBottom
                }
            }
            v.setPadding(pad[0] + l, pad[1] + t, pad[2] + r, pad[3] + b)
            insets
        }

        root.addView(TextView(this).apply {
            text = getString(R.string.app_name)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#16273E"))
        })
        root.addView(TextView(this).apply {
            text = getString(R.string.tagline)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(Color.parseColor("#5E7699"))
            setPadding(0, dp(4), 0, dp(20))
        })

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(16)
            layoutParams = lp
        }
        val half = { LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f) }
        buttons.addView(Button(this).apply {
            text = getString(R.string.open_document)
            layoutParams = half().also { it.rightMargin = dp(8) }
            setOnClickListener { openDocument() }
        })
        buttons.addView(Button(this).apply {
            text = getString(R.string.new_document)
            layoutParams = half()
            setOnClickListener { newDocument() }
        })
        root.addView(buttons)

        empty = TextView(this).apply {
            text = getString(R.string.empty_hint)
            setTextColor(Color.parseColor("#5E7699"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(48), dp(8), dp(8))
            visibility = View.GONE
        }
        root.addView(empty)

        list = ListView(this).apply {
            divider = null
            adapter = RecentsAdapter()
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            setOnItemClickListener { _, _, i, _ -> open(entries[i].uri) }
            setOnItemLongClickListener { _, _, i, _ ->
                val e = entries[i]
                AlertDialog.Builder(this@DocumentsActivity)
                    .setTitle(e.name)
                    // "Remove" is emphatically not "delete". The app hands back
                    // its key; the document stays exactly where it is.
                    .setMessage(getString(R.string.forget_explain))
                    .setPositiveButton(R.string.forget) { _, _ ->
                        Recents.forget(this@DocumentsActivity, e.uri); refresh()
                    }
                    .setNegativeButton(android.R.string.cancel, null)
                    .show()
                true
            }
        }
        root.addView(list)
        return root
    }

    private inner class RecentsAdapter : BaseAdapter() {
        override fun getCount() = entries.size
        override fun getItem(i: Int) = entries[i]
        override fun getItemId(i: Int) = i.toLong()

        override fun getView(i: Int, convert: View?, parent: ViewGroup): View {
            val dp = { v: Int -> (v * resources.displayMetrics.density).toInt() }
            val row = (convert as? LinearLayout) ?: LinearLayout(this@DocumentsActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(14), dp(14), dp(14))
                addView(TextView(context).apply {
                    id = 1
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                    setTextColor(Color.parseColor("#16273E"))
                })
                addView(TextView(context).apply {
                    id = 2
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    setTextColor(Color.parseColor("#5E7699"))
                })
            }
            val e = entries[i]
            row.findViewById<TextView>(1).text = e.name
            row.findViewById<TextView>(2).text =
                DateUtils.getRelativeTimeSpanString(e.openedAt, System.currentTimeMillis(), 0)
            return row
        }
    }
}
