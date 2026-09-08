// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.MessageDigest

/**
 * The order in which a new document's shell is checked, which is the part that
 * cannot be exercised by hand.
 *
 * Mirrors `home/webext`'s two load-bearing cases (PR #318) and the reasoning
 * `home/ios` settled first (PR #315): a version high enough to lock the device
 * out must not raise the floor unless its BYTES were good, and re-fetching the
 * version already seen must be allowed. Both are cases where getting it
 * backwards produces a denial of service rather than a visible bug — the first
 * bricks the + button permanently, the second breaks it on its second use.
 *
 * A plain JVM test: no emulator, so there is no excuse not to run it.
 */
class ReleasesTest {

    private val app = Releases.APPS.first { it.id == "slides" }

    private fun sha(b: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    /** A signed-looking envelope is not needed here: these tests drive
     *  [Releases.resolve] through its dependency seam, and the signature step is
     *  covered by the live manifest the app verifies on device. What is under
     *  test is the SEQUENCE — identity, floor, digest, raise. */
    private fun deps(
        shell: ByteArray,
        floor: MutableMap<String, String>,
        stored: MutableList<String> = mutableListOf(),
    ) = Releases.Deps(
        get = { shell },
        readFloor = { k -> floor[k] },
        writeFloor = { k, v -> floor[k] = v },
        cached = { null },
        store = { v, _ -> stored += v },
    )

    private fun release(version: String, shell: ByteArray, appId: String? = "bento-slides") =
        Releases.Release(appId, version, "https://bento.page/x.html", sha(shell))

    // ---------------------------------------------------------------- the floor

    @Test
    fun `a high version whose bytes fail their digest leaves the floor untouched`() {
        val floor = mutableMapOf<String, String>()
        val shell = "real".toByteArray()
        // Names 9.9.9 and pins a hash the served bytes do not match.
        val lying = Releases.Release(
            "bento-slides", "9.9.9", "https://bento.page/x.html", sha("something else".toByteArray()))

        try {
            Releases.resolveVerified(app, lying, deps(shell, floor))
            fail("a shell that fails its pinned digest must be refused")
        } catch (e: Releases.Failed) {
            assertTrue(e.message!!, e.message!!.contains("signed hash"))
        }

        // THE POINT: had the floor been raised on the merely-verified manifest,
        // this device could never accept a real release below 9.9.9 again — a
        // failed attack turned into a permanent one.
        assertNull("the floor must not move for bytes that never passed", floor["release-floor:slides"])
    }

    @Test
    fun `an equal version is accepted, not treated as a downgrade`() {
        val floor = mutableMapOf("release-floor:slides" to "1.0.18")
        val shell = "same release".toByteArray()
        val got = Releases.resolveVerified(app, release("1.0.18", shell), deps(shell, floor))
        assertEquals(String(shell), String(got))
        assertEquals("1.0.18", floor["release-floor:slides"])
    }

    @Test
    fun `an older version than the floor is refused`() {
        val floor = mutableMapOf("release-floor:slides" to "1.0.18")
        val shell = "old release".toByteArray()
        try {
            Releases.resolveVerified(app, release("1.0.17", shell), deps(shell, floor))
            fail("a release older than the floor must be refused")
        } catch (e: Releases.Failed) {
            assertTrue(e.message!!, e.message!!.contains("older than"))
        }
        assertEquals("1.0.18", floor["release-floor:slides"])
    }

    @Test
    fun `a newer version raises the floor, but only after the bytes pass`() {
        val floor = mutableMapOf("release-floor:slides" to "1.0.18")
        val shell = "new release".toByteArray()
        Releases.resolveVerified(app, release("1.1.0", shell), deps(shell, floor))
        assertEquals("1.1.0", floor["release-floor:slides"])
    }

    @Test
    fun `an unreadable store reads as no floor rather than a refusal`() {
        val shell = "release".toByteArray()
        val d = Releases.Deps(
            get = { shell },
            readFloor = { throw IllegalStateException("private mode") },
            writeFloor = { _, _ -> throw IllegalStateException("quota") },
        )
        // Being unable to remember must not mean being unable to create a
        // document, and an unwritable floor must not fail the document either.
        assertEquals(String(shell), String(Releases.resolveVerified(app, release("1.0.0", shell), d)))
    }

    // ------------------------------------------------------------- identity

    @Test
    fun `a manifest for another app is refused on the channel it was served from`() {
        val floor = mutableMapOf<String, String>()
        val shell = "dash release".toByteArray()
        // Genuinely signed, genuinely hashes — just not the app that was asked for.
        try {
            Releases.resolveVerified(app, release("2.0.0", shell, "bento-dash"), deps(shell, floor))
            fail("a manifest naming another app must be refused")
        } catch (e: Releases.Failed) {
            assertTrue(e.message!!, e.message!!.contains("bento-dash"))
        }
    }

    @Test
    fun `an absent app field is refused rather than passing by omission`() {
        val floor = mutableMapOf<String, String>()
        val shell = "unnamed".toByteArray()
        try {
            Releases.resolveVerified(app, release("2.0.0", shell, null), deps(shell, floor))
            fail("a manifest with no app field must be refused")
        } catch (e: Releases.Failed) {
            assertTrue(e.message!!, e.message!!.contains("unnamed"))
        }
    }

    // ------------------------------------------------------------- comparison

    @Test
    fun `version comparison matches the kernel, including unparsable components`() {
        assertTrue(Releases.compareVersions("1.0.18", "1.0.17") > 0)
        assertTrue(Releases.compareVersions("1.0.17", "1.0.18") < 0)
        assertEquals(0, Releases.compareVersions("1.0.18", "1.0.18"))
        // Shorter sorts as trailing zeros, as (pa[i] || 0) does.
        assertEquals(0, Releases.compareVersions("1.0", "1.0.0"))
        assertTrue(Releases.compareVersions("1.1", "1.0.9") > 0)
        // NOT NaN: Number('1a') is NaN, NaN is falsy, so JS coerces it to 0.
        // A strange version can fail to RAISE the floor, never block a release.
        assertEquals(0, Releases.compareVersions("1.0.x", "1.0.0"))
        assertTrue(Releases.compareVersions("2.0.0", "1.0.x") > 0)
    }
}
