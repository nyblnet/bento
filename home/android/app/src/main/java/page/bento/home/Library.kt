// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log

/**
 * The documents this app can reach, and what is inside them.
 *
 * `Recents` is a keyring — the documents you have opened. This is a LIBRARY: a
 * folder you grant once, walked and indexed, so a document is findable by a
 * phrase on one of its slides rather than only by what you happened to call the
 * file. That is what `home/webext` has had and neither native host did.
 *
 * The grant is `ACTION_OPEN_DOCUMENT_TREE` plus a persistable permission — the
 * Android analogue of the extension's `showDirectoryPicker` and of a
 * security-scoped bookmark on iOS. Nothing is copied: the index holds text and
 * a preview, the documents stay where the user put them.
 *
 * SQLite rather than a JSON file, because search has to scan the prose of every
 * document and the budget is 40KB EACH. A few hundred documents is megabytes,
 * which is fine on disk and ruinous to parse into memory on every launch.
 */
object Library {

    private const val TAG = "BentoTray"

    /** Depth cap for the walk. A granted folder can be a whole home directory,
     *  and a symlinked or pathological tree should cost a bounded amount. */
    private const val MAX_DEPTH = 8

    /** Files examined per scan. A ceiling, not a target — reported to the user
     *  when hit rather than silently truncating, because a library that quietly
     *  stops at N is a library that lies about what it holds. */
    private const val MAX_FILES = 5000

    data class Doc(
        val uri: Uri, val name: String, val folder: String, val title: String?,
        val app: String?, val encrypted: Boolean, val modified: Long, val hasPreview: Boolean,
    ) {
        /** What to show: the document's own title when it has one. Documents are
         *  called `Q3-board.bento.html`; the document knows it is "Q3 Board
         *  Review". Showing the filename when the title is right there is the
         *  difference between a file list and a document list. */
        val label: String get() = title?.takeIf { it.isNotBlank() } ?: name
    }

    // ------------------------------------------------------------------ store

    private class Db(context: Context) : SQLiteOpenHelper(context, "library.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """CREATE TABLE docs(
                     uri TEXT PRIMARY KEY, name TEXT, folder TEXT, title TEXT, app TEXT,
                     encrypted INTEGER, size INTEGER, modified INTEGER,
                     text TEXT, preview TEXT, seen INTEGER)"""
            )
            db.execSQL("CREATE INDEX docs_folder ON docs(folder)")
        }

        override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {
            // The index is a CACHE, never the document. Dropping it costs one
            // rescan and can never lose anything the user wrote.
            db.execSQL("DROP TABLE IF EXISTS docs")
            onCreate(db)
        }
    }

    private var db: Db? = null
    private fun db(c: Context) = db ?: Db(c.applicationContext).also { db = it }

    // ----------------------------------------------------------------- grants

    /** Folders the user has granted, as tree URIs. */
    fun grants(c: Context): List<Uri> = c.contentResolver.persistedUriPermissions
        .map { it.uri }
        .filter { DocumentsContract.isTreeUri(it) }

    fun intentToGrantFolder(): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        )
    }

    /** Take the durable grant. Write is requested as well as read: a document
     *  found through the library should be editable in place, not read-only —
     *  which is the whole difference this app exists to make. */
    fun keepGrant(c: Context, tree: Uri, flags: Int) {
        val wanted = flags and
            (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        try {
            c.contentResolver.takePersistableUriPermission(tree, wanted)
        } catch (e: SecurityException) {
            Log.w(TAG, "folder grant is not persistable", e)
        }
    }

    fun dropGrant(c: Context, tree: Uri) {
        try {
            c.contentResolver.releasePersistableUriPermission(
                tree,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: SecurityException) { /* already gone; the system owns it */ }
        db(c).writableDatabase.delete("docs", "folder = ?", arrayOf(folderLabel(tree)))
    }

    // ------------------------------------------------------------------- scan

    data class ScanResult(val indexed: Int, val examined: Int, val truncated: Boolean)

    /**
     * Walk every granted folder and index what is ours.
     *
     * Re-reads a file only when its size or timestamp changed, so a rescan over
     * an unchanged folder costs one directory listing per folder and no reads at
     * all. That matters because the expensive step is not the walk, it is
     * pulling 40KB of prose out of a megabyte of document.
     *
     * SYNCHRONIZED, and not defensively. Each pass stamps the rows it saw and
     * then deletes everything it did not, so two overlapping scans delete each
     * other's work: the newly-granted folder indexed 2 documents and the list
     * showed 0. Granting a folder starts a scan and the resume that follows
     * starts another, so the overlap is the ordinary path, not a rare one.
     */
    @Synchronized
    fun scan(c: Context): ScanResult {
        val w = db(c).writableDatabase
        val stamp = System.currentTimeMillis()
        var examined = 0
        var indexed = 0
        var truncated = false

        for (tree in grants(c)) {
            val folder = folderLabel(tree)
            val root = try {
                DocumentsContract.buildChildDocumentsUriUsingTree(
                    tree, DocumentsContract.getTreeDocumentId(tree)
                )
            } catch (e: Exception) {
                Log.w(TAG, "unusable grant $tree", e); continue
            }
            val budget = MAX_FILES - examined
            val r = walk(c, w, tree, root, folder, 0, budget, stamp)
            examined += r.first
            indexed += r.second
            if (examined >= MAX_FILES) { truncated = true; break }
        }

        // Anything not seen this pass is gone from the granted folders — deleted,
        // moved out, or its grant dropped. The row goes with it.
        w.delete("docs", "seen != ?", arrayOf(stamp.toString()))
        return ScanResult(indexed, examined, truncated)
    }

    /** @return examined to indexed */
    private fun walk(
        c: Context, w: SQLiteDatabase, tree: Uri, dir: Uri, folder: String,
        depth: Int, budget: Int, stamp: Long,
    ): Pair<Int, Int> {
        if (depth > MAX_DEPTH || budget <= 0) return 0 to 0
        var examined = 0
        var indexed = 0

        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val cursor = try {
            c.contentResolver.query(dir, cols, null, null, null)
        } catch (e: Exception) {
            Log.w(TAG, "cannot list $dir", e); null
        } ?: return 0 to 0

        cursor.use {
            while (it.moveToNext()) {
                if (examined >= budget) break
                val id = it.getString(0) ?: continue
                val name = it.getString(1) ?: continue
                val mime = it.getString(2) ?: ""
                val size = it.getLong(3)
                val modified = it.getLong(4)

                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    val child = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
                    val r = walk(c, w, tree, child, folder, depth + 1, budget - examined, stamp)
                    examined += r.first; indexed += r.second
                    continue
                }

                // Only plausible pages are opened at all. The name is a
                // convention and conventions get broken by people — renamed to
                // email it, saved with a browser's "(1)" — so `.html` counts as
                // well as `.bento.html`, and what settles it is the marker
                // inside. Everything else is skipped without a read.
                if (!name.endsWith(".html", true) && !name.endsWith(".htm", true)) continue
                examined++

                val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                if (indexOne(c, w, uri, name, folder, size, modified, stamp)) indexed++
            }
        }
        return examined to indexed
    }

    /** @return whether this file is one of ours */
    private fun indexOne(
        c: Context, w: SQLiteDatabase, uri: Uri, name: String, folder: String,
        size: Long, modified: Long, stamp: Long,
    ): Boolean {
        // Unchanged since last time? Touch it and read nothing.
        w.rawQuery(
            "SELECT size, modified FROM docs WHERE uri = ?", arrayOf(uri.toString())
        ).use {
            if (it.moveToFirst() && it.getLong(0) == size && it.getLong(1) == modified) {
                w.execSQL("UPDATE docs SET seen = ? WHERE uri = ?", arrayOf<Any>(stamp, uri.toString()))
                return true
            }
        }

        val whole = try {
            c.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
        } catch (e: Exception) {
            Log.w(TAG, "cannot read $name", e); null
        } ?: return false

        val meta = DocumentIndex.describe(whole)
        if (!meta.isDocument) {
            // Remember nothing about other people's HTML, but do not keep
            // re-reading it either — the row would be a lie in a document list.
            w.delete("docs", "uri = ?", arrayOf(uri.toString()))
            return false
        }

        w.insertWithOnConflict("docs", null, ContentValues().apply {
            put("uri", uri.toString()); put("name", name); put("folder", folder)
            put("title", meta.title); put("app", meta.app)
            put("encrypted", if (meta.encrypted) 1 else 0)
            put("size", size); put("modified", modified)
            put("text", meta.text); put("preview", meta.preview)
            put("seen", stamp)
        }, SQLiteDatabase.CONFLICT_REPLACE)
        return true
    }

    // ----------------------------------------------------------------- search

    /**
     * Title, file name, folder — and the document's own words.
     *
     * The last one is the point. What you remember is a phrase ON a slide, not
     * what you called the file, and the bytes to answer that were already read
     * for the preview.
     */
    fun search(c: Context, query: String, limit: Int = 300): List<Doc> {
        val q = query.trim()
        val where: String
        val args: Array<String>
        if (q.isEmpty()) {
            where = ""; args = emptyArray()
        } else {
            val like = "%" + q.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
            where = """WHERE (title LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!'
                        OR folder LIKE ? ESCAPE '!' OR text LIKE ? ESCAPE '!')"""
            args = arrayOf(like, like, like, like)
        }
        val out = ArrayList<Doc>()
        db(c).readableDatabase.rawQuery(
            """SELECT uri, name, folder, title, app, encrypted, modified,
                        preview IS NOT NULL AND preview != ''
                 FROM docs $where ORDER BY modified DESC LIMIT $limit""", args
        ).use {
            while (it.moveToNext()) {
                out += Doc(
                    uri = Uri.parse(it.getString(0)), name = it.getString(1),
                    folder = it.getString(2), title = it.getString(3), app = it.getString(4),
                    encrypted = it.getInt(5) == 1, modified = it.getLong(6),
                    hasPreview = it.getInt(7) == 1,
                )
            }
        }
        return out
    }

    /**
     * One document's stored preview, fetched only when something is about to
     * draw it.
     *
     * Deliberately NOT part of [search]: a preview block runs to tens of
     * kilobytes, so selecting it for every row of a 300-document list would pull
     * megabytes of markup into memory to show a handful of pictures.
     */
    fun previewFor(c: Context, uri: Uri): String? =
        db(c).readableDatabase.rawQuery(
            "SELECT preview FROM docs WHERE uri = ?", arrayOf(uri.toString())
        ).use { if (it.moveToFirst()) it.getString(0) else null }

    fun count(c: Context): Int =
        db(c).readableDatabase.rawQuery("SELECT COUNT(*) FROM docs", null).use {
            if (it.moveToFirst()) it.getInt(0) else 0
        }

    /** A readable name for a granted tree. The tree document id is the closest
     *  thing a provider offers to a path, and its last segment is what the user
     *  actually picked. */
    fun folderLabel(tree: Uri): String = try {
        DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':')
            .substringAfterLast('/').ifEmpty { tree.lastPathSegment ?: "folder" }
    } catch (_: Exception) {
        tree.lastPathSegment ?: "folder"
    }
}
