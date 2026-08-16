// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.tray

import android.app.Activity
import android.app.AlertDialog
import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.text.Editable
import android.text.TextWatcher
import android.text.format.DateUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.GridView
import android.widget.Toast
import android.widget.TextView

/**
 * The app's root: every document this app can reach, and a box to find one in.
 *
 * iOS gets `UIDocumentBrowserViewController` — a whole file browser showing
 * iCloud and every File Provider on the device. Android has nothing to host: its
 * picker is a one-shot dialog that returns a URI and closes. So this screen is
 * ours, and it holds two things:
 *
 *  - **Recents**, a keyring of documents opened one at a time (`Recents`).
 *  - **The library**, folders granted once and then indexed (`Library`), which
 *    is what makes a document findable by a phrase on one of its slides rather
 *    than only by what somebody called the file.
 *
 * Deliberately NATIVE, and deliberately not the extension's HTML library screen
 * in a WebView: that was measured at ~0.5s of extra cold start, and it makes
 * system font scaling, TalkBack and predictive back things you re-earn rather
 * than get. See `docs/DECISIONS.md`, 2026-08-16.
 */
class DocumentsActivity : Activity() {

    companion object {
        private const val TAG = "BentoTray"
        private const val REQ_OPEN = 1
        private const val REQ_NEW = 2
        private const val REQ_FOLDER = 3
    }

    private lateinit var list: GridView

    /** Grid or list, and the theme override — both VIEWER preferences, kept on
     *  the device and never in a document. Same shape as the runtime's own
     *  locale and reduce-motion settings, which default to the OS and allow an
     *  override without the choice ever entering the file. */
    private val prefs by lazy { getSharedPreferences("ui", Context.MODE_PRIVATE) }
    private var gridMode = true
    private lateinit var viewToggle: TextView
    private lateinit var empty: TextView
    private lateinit var search: EditText
    private lateinit var status: TextView

    /** One list, two sources. A document opened through "Open…" lives outside
     *  any granted folder and would otherwise vanish from a library-only list —
     *  so recents that the library does not already know about are folded in. */
    private class Row(
        val uri: Uri, val label: String, val sub: String, val encrypted: Boolean,
        val app: String?, val modified: Long, val hasPreview: Boolean,
    )

    private var rows: List<Row> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        gridMode = prefs.getString("view", "grid") == "grid"
        applyNightMode(prefs.getString("night", "system")!!)
        // The thumbnail renderer needs a real window, so it gets a host added
        // FIRST — behind the content, which therefore takes every touch.
        val stack = android.widget.FrameLayout(this)
        val renderHost = android.widget.FrameLayout(this)
        stack.addView(renderHost, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        stack.addView(buildUi(), ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(stack)
        Thumbnails.attach(renderHost)
    }

    override fun onResume() {
        super.onResume()
        refresh()
        // A folder's contents change behind our back — a deck saved on the
        // desktop and synced down, a file deleted. Rescanning on resume keeps
        // the list honest, and an unchanged folder costs one listing and no
        // reads because the index is keyed by size and timestamp.
        if (Library.grants(this).isNotEmpty()) rescan(quiet = true)
    }

    // ------------------------------------------------------------------ state

    private fun refresh() {
        val q = search.text.toString().trim()
        val known = HashSet<String>()
        val out = ArrayList<Row>()

        for (d in Library.search(this, q)) {
            known += d.uri.toString()
            val where = if (d.folder.isBlank()) "" else " · ${d.folder}"
            out += Row(d.uri, d.label, describeApp(d.app) + where, d.encrypted, d.app,
                d.modified, d.hasPreview)
        }
        for (e in Recents.prune(this)) {
            if (e.uri.toString() in known) continue
            if (q.isNotEmpty() && !e.name.contains(q, ignoreCase = true)) continue
            val ago = DateUtils.getRelativeTimeSpanString(e.openedAt, System.currentTimeMillis(), 0)
            // A recent that the library does not know about has no index row and
            // therefore no preview — it was opened one-off, not through a folder.
            out += Row(e.uri, e.name, "opened $ago", false, null, e.openedAt, false)
        }

        rows = out
        (list.adapter as RowAdapter).notifyDataSetChanged()

        val grants = Library.grants(this).size
        val indexed = Library.count(this)
        status.text = when {
            grants == 0 -> getString(R.string.status_no_folders)
            else -> resources.getQuantityString(R.plurals.status_indexed, indexed, indexed, grants)
        }
        empty.text = when {
            q.isNotEmpty() -> getString(R.string.empty_search, q)
            grants == 0 -> getString(R.string.empty_hint)
            else -> getString(R.string.empty_library)
        }
        empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        list.visibility = if (rows.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun describeApp(app: String?) = when (app) {
        "slides" -> "Slides"; "spaces" -> "Spaces"; "dash" -> "Dash"
        "enc" -> "Encrypted"; null -> "Document"; else -> app.replaceFirstChar { it.uppercase() }
    }

    private fun rescan(quiet: Boolean) {
        Thread {
            val r = try { Library.scan(this) } catch (e: Exception) {
                Log.w(TAG, "scan failed", e); null
            }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                refresh()
                if (r == null && !quiet) notify(getString(R.string.err_scan))
                // A ceiling that is hit is reported. A library that quietly stops
                // at N is a library that lies about what it holds.
                else if (r != null && r.truncated && !quiet) {
                    notify(getString(R.string.warn_scan_truncated, r.examined))
                }
            }
        }.start()
    }

    // ----------------------------------------------------------- getting in

    /** `ACTION_OPEN_DOCUMENT`, never `ACTION_GET_CONTENT`: the latter hands back
     *  a COPY, which is the whole problem this app exists to solve. */
    private fun openDocument() {
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // Permissive on type, deliberately: providers disagree about what a
            // .bento.html is and several report octet-stream. A filter that hides
            // the user's own document is worse than one that shows too much.
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/html", "application/octet-stream"))
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }, REQ_OPEN)
    }

    private fun addFolder() = startActivityForResult(Library.intentToGrantFolder(), REQ_FOLDER)

    /**
     * A new document, of whichever Bento the user wants.
     *
     * The shell is NOT bundled — it is fetched from the signed release channel
     * (`Releases`), so a document created here is the version everyone else has
     * today rather than whatever the app was built against. That also makes
     * "which app?" a real question worth asking, since there are three of them.
     */
    private fun newDocument() {
        val apps = Releases.APPS
        AlertDialog.Builder(this)
            .setTitle(R.string.new_document_title)
            .setItems(apps.map { "${it.label} — ${it.blurb}" }.toTypedArray()) { _, i ->
                pendingApp = apps[i]
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "text/html"
                    putExtra(Intent.EXTRA_TITLE, "Untitled.bento.html")
                    addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or
                            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                    )
                }, REQ_NEW)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private var pendingApp: Releases.App? = null

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null) {
            return super.onActivityResult(requestCode, resultCode, data)
        }
        when (requestCode) {
            REQ_FOLDER -> {
                Library.keepGrant(this, uri, data.flags)
                rescan(quiet = false)
            }
            REQ_OPEN -> { Recents.persist(contentResolver, uri, data.flags); open(uri) }
            REQ_NEW -> { Recents.persist(contentResolver, uri, data.flags); seedThenOpen(uri) }
            else -> super.onActivityResult(requestCode, resultCode, data)
        }
    }

    /**
     * Fetch the signed shell, verify it, and write it into the file the user
     * just named.
     *
     * The fetch is the ONLY network request this app makes on its own account.
     * It is verified twice over — manifest signature, then the shell's pinned
     * sha256 — because these bytes become an executable document the user will
     * afterwards trust. A cached shell from a previous "New" is used when the
     * server cannot be reached, so this keeps working on a plane.
     */
    private fun seedThenOpen(uri: Uri) {
        val app = pendingApp ?: Releases.APPS[0]
        pendingApp = null
        Thread {
            var error: String? = null
            val bytes = try {
                Releases.seedFor(this, app)
            } catch (e: Exception) {
                Log.w(TAG, "could not fetch a seed", e)
                error = e.message
                // Offline, or the server is down. A shell cached by an earlier
                // "New" is still a signed release — it was verified when it was
                // cached — so it is a sound fallback rather than a guess.
                Releases.anyCached(this, app)
            }

            val ok = bytes != null && try {
                contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } != null
            } catch (e: Exception) { Log.w(TAG, "could not write the new document", e); false }

            // ACTION_CREATE_DOCUMENT has already made the file by the time we
            // get here, so a failed fetch leaves an EMPTY document behind — which
            // then shows up in the folder and indexes as nothing. Take it back.
            if (!ok) try { DocumentsContract.deleteDocument(contentResolver, uri) }
                     catch (e: Exception) { Log.w(TAG, "could not remove the empty file", e) }

            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (ok) open(uri)
                else notify(getString(R.string.err_create_fetch, error ?: getString(R.string.err_offline)))
            }
        }.start()
    }

    private fun open(uri: Uri) =
        startActivity(Intent(this, EditorActivity::class.java).putExtra(EditorActivity.EXTRA_URI, uri))

    private fun manageFolders() {
        val grants = Library.grants(this)
        if (grants.isEmpty()) { addFolder(); return }
        val labels = grants.map { Library.folderLabel(it) }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle(R.string.folders_title)
            .setItems(labels) { _, i ->
                AlertDialog.Builder(this)
                    .setTitle(labels[i])
                    // Emphatically not "delete": the app hands back its key and
                    // forgets what it indexed. The documents do not move.
                    .setMessage(R.string.folder_forget_explain)
                    .setPositiveButton(R.string.forget) { _, _ ->
                        Library.dropGrant(this, grants[i]); refresh()
                    }
                    .setNegativeButton(android.R.string.cancel, null)
                    .show()
            }
            .setPositiveButton(R.string.add_folder) { _, _ -> addFolder() }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun notify(message: String) = AlertDialog.Builder(this)
        .setMessage(message).setPositiveButton(android.R.string.ok, null).show()

    /** Grid or list. Rebuilds the adapter rather than reusing it: the two modes
     *  produce different view shapes, and GridView recycles by position with no
     *  notion of a view type, so a reused card would be re-fed as a row. */
    private fun applyViewMode() {
        list.numColumns = if (gridMode) 2 else 1
        viewToggle.text = if (gridMode) "☰" else "▦"
        viewToggle.contentDescription =
            getString(if (gridMode) R.string.view_as_list else R.string.view_as_grid)
        list.adapter = RowAdapter()
    }

    /**
     * The theme override, defaulting to the system.
     *
     * Deliberately API 31+ only. `setApplicationNightMode` is the sole way to
     * override the system theme per-app without AndroidX, so below it the app
     * follows the system and the control is not offered at all — a button that
     * silently does nothing is worse than no button.
     */
    private fun applyNightMode(mode: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        getSystemService(UiModeManager::class.java)?.setApplicationNightMode(
            when (mode) {
                "light" -> UiModeManager.MODE_NIGHT_NO
                "dark" -> UiModeManager.MODE_NIGHT_YES
                else -> UiModeManager.MODE_NIGHT_AUTO
            }
        )
    }

    private fun cycleNightMode() {
        val next = when (prefs.getString("night", "system")) {
            "system" -> "light"
            "light" -> "dark"
            else -> "system"
        }
        prefs.edit().putString("night", next).apply()
        // Named, because "system" and "light" look identical on a device that is
        // already light — the screen alone cannot tell you which you picked.
        Toast.makeText(this, getString(when (next) {
            "light" -> R.string.theme_light
            "dark" -> R.string.theme_dark
            else -> R.string.theme_system
        }), Toast.LENGTH_SHORT).show()
        applyNightMode(next)
    }

    // ------------------------------------------------- a plain UI, in code
    //
    // No layout XML and no AndroidX UI libraries: a title, three buttons, a
    // search box and a list. Every dependency this screen does not have is one
    // that cannot drift out of step with the WebView work, which is where all
    // the difficulty in this app actually lives.

    private fun buildUi(): View {
        val dp = { v: Int -> (v * resources.displayMetrics.density).toInt() }
        // No setBackgroundColor here: Theme.Tray's windowBackground is the
        // ground, and it follows the system theme. A view that paints its own
        // is a view that cannot.
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        // Insets by hand. `fitsSystemWindows = true` REPLACES a view's padding
        // rather than adding to it — the screen lost its side margin that way —
        // and from targetSdk 35 the app draws edge to edge whether it asks to or
        // not, so doing nothing puts the header under the status bar.
        val pad = intArrayOf(dp(20), dp(24), dp(20), dp(8))
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

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_tray_mark)
            layoutParams = LinearLayout.LayoutParams(dp(30), dp(30))
                .also { it.rightMargin = dp(10) }
            contentDescription = null   // decorative; the title beside it says the name
        })
        header.addView(TextView(this).apply {
            text = getString(R.string.app_name)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 23f)
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(getColor(R.color.ink))
            // -.015em on headings, from tray/webext/src/ui.css. Android's
            // letterSpacing is already in ems, so the number transfers directly.
            letterSpacing = -0.015f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        viewToggle = TextView(this, null, 0, R.style.IconBtn).apply {
            setOnClickListener {
                gridMode = !gridMode
                prefs.edit().putString("view", if (gridMode) "grid" else "list").apply()
                applyViewMode()
            }
        }
        header.addView(viewToggle)
        // Only offered where it can be honoured: setApplicationNightMode is API
        // 31+, and without AndroidX there is no way to override the system
        // theme below it. A control that silently does nothing is worse than no
        // control, so older devices simply follow the system.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            header.addView(TextView(this, null, 0, R.style.IconBtn).apply {
                text = "◐"
                contentDescription = getString(R.string.theme_toggle)
                setOnClickListener { cycleNightMode() }
            })
        }
        root.addView(header)

        search = EditText(this, null, 0, R.style.Field).apply {
            hint = getString(R.string.search_hint)
            setSingleLine()
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = dp(10) }
            addTextChangedListener(object : TextWatcher {
                override fun afterTextChanged(s: Editable?) = refresh()
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            })
        }
        root.addView(search)

        status = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(getColor(R.color.dim))
            setPadding(dp(2), dp(8), dp(2), dp(12))
        }
        root.addView(status)

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.bottomMargin = dp(10) }
        }
        val third = { LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f) }
        // Styled through R.style.Btn rather than themed, because this screen
        // builds its views in code — the 4-arg View constructor applies a style
        // exactly as an XML layout would, with no library involved.
        buttons.addView(Button(this, null, 0, R.style.Btn_Primary).apply {
            text = getString(R.string.open_document)
            layoutParams = third().also { it.rightMargin = dp(8) }
            setOnClickListener { openDocument() }
        })
        buttons.addView(Button(this, null, 0, R.style.Btn).apply {
            text = getString(R.string.new_document)
            layoutParams = third().also { it.rightMargin = dp(8) }
            setOnClickListener { newDocument() }
        })
        buttons.addView(Button(this, null, 0, R.style.Btn).apply {
            text = getString(R.string.folders)
            layoutParams = third()
            setOnClickListener { manageFolders() }
        })
        root.addView(buttons)

        empty = TextView(this).apply {
            setTextColor(getColor(R.color.dim))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(40), dp(8), dp(8))
            visibility = View.GONE
        }
        root.addView(empty)

        list = GridView(this).apply {
            adapter = RowAdapter()
            horizontalSpacing = dp(10)
            verticalSpacing = dp(10)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            setOnItemClickListener { _, _, i, _ -> open(rows[i].uri) }
            setOnItemLongClickListener { _, _, i, _ ->
                val r = rows[i]
                AlertDialog.Builder(this@DocumentsActivity)
                    .setTitle(r.label)
                    .setMessage(getString(R.string.forget_explain))
                    .setPositiveButton(R.string.forget) { _, _ ->
                        Recents.forget(this@DocumentsActivity, r.uri); refresh()
                    }
                    .setNegativeButton(android.R.string.cancel, null)
                    .show()
                true
            }
        }
        root.addView(list)
        applyViewMode()
        return root
    }

    private inner class RowAdapter : BaseAdapter() {
        override fun getCount() = rows.size
        override fun getItem(i: Int) = rows[i]
        override fun getItemId(i: Int) = i.toLong()

        override fun getView(i: Int, convert: View?, parent: ViewGroup): View {
            val r = rows[i]
            val row = (convert as? LinearLayout) ?: if (gridMode) buildCard() else buildRow()

            row.findViewById<TextView>(1).text = if (r.encrypted) "🔒 ${r.label}" else r.label
            row.findViewById<TextView>(2).text = r.sub

            val thumb = row.findViewById<ImageView>(3)
            // The KEY, not the position: the collection recycles views, so a
            // thumbnail that finishes after its cell scrolled away would
            // otherwise be drawn onto whatever document now occupies it.
            val key = "${r.uri}|${r.modified}"
            thumb.tag = key
            thumb.setImageBitmap(null)
            thumb.background = getDrawable(R.drawable.bg_thumb)
            if (r.hasPreview) {
                Thumbnails.request(this@DocumentsActivity, r.uri, r.modified) { bmp ->
                    if (bmp != null && thumb.tag == key) thumb.setImageBitmap(bmp)
                }
            }
            return row
        }

        private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

        /** A card: the thumbnail carries the row, which is the point of having
         *  rendered one. Matches how tray/webext presents a folder. */
        private fun buildCard(): LinearLayout {
            // GridView cells size to content, so the thumbnail's height is
            // computed from the column width to hold 16:9 rather than guessed.
            val cols = 2
            val screen = resources.displayMetrics.widthPixels
            val cellW = (screen - dp(40) - dp(10) * (cols - 1)) / cols - dp(16)
            return LinearLayout(this@DocumentsActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(8), dp(8), dp(8), dp(10))
                background = getDrawable(R.drawable.bg_row)
                addView(ImageView(context).apply {
                    id = 3
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, cellW * 9 / 16)
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    clipToOutline = true
                })
                addView(TextView(context).apply {
                    id = 1
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                    setTextColor(context.getColor(R.color.ink))
                    typeface = emphasis()
                    maxLines = 2
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    setPadding(dp(2), dp(8), dp(2), 0)
                })
                addView(TextView(context).apply {
                    id = 2
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                    setTextColor(context.getColor(R.color.dim))
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    setPadding(dp(2), dp(2), dp(2), 0)
                })
            }
        }

        private fun buildRow(): LinearLayout = LinearLayout(this@DocumentsActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(12), dp(10), dp(12))
            background = getDrawable(R.drawable.bg_row)
            addView(ImageView(context).apply {
                id = 3
                layoutParams = LinearLayout.LayoutParams(dp(64), dp(36))
                    .also { it.rightMargin = dp(14) }
                scaleType = ImageView.ScaleType.FIT_CENTER
                clipToOutline = true
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                addView(TextView(context).apply {
                    id = 1
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                    setTextColor(context.getColor(R.color.ink))
                })
                addView(TextView(context).apply {
                    id = 2
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    setTextColor(context.getColor(R.color.dim))
                })
            })
        }

        /** `font-weight: 600` in the extension. Real 600 exists from API 28;
         *  below it the nearest the framework offers is bold. */
        private fun emphasis(): Typeface =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                Typeface.create(Typeface.DEFAULT, 600, false)
            else Typeface.DEFAULT_BOLD
    }
}
