// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.SecureRandom

/**
 * Recovery.kt against kernel/fixtures/recovery-v1.json — deterministic, so every
 * byte must match — plus security §35's checks: RFC 9106 §5.3, a randomized
 * cross-check against Node's native Argon2id, the wipe probe, and out-of-memory
 * failing closed.
 */
class RecoveryTest {
    private val fx: JsonObject = JsonParser.parseString(
        File("../../../kernel/fixtures/recovery-v1.json").readText()).asJsonObject
    private fun JsonObject.s(k: String) = get(k).asString
    private fun JsonObject.h(k: String) = Hex.bytes(get(k).asString)

    // ---- Argon2id -------------------------------------------------------------------------

    @Test fun `RFC 9106 section 5_3 Argon2id`() {
        val r = fx.getAsJsonObject("rfc9106")
        val tag = Recovery.argon2id(r.h("password"), r.h("salt"),
            memoryKiB = r.get("memoryKiB").asInt, passes = r.get("passes").asInt, lanes = r.get("parallelism").asInt,
            tagLen = r.get("tagLength").asInt, secret = r.h("secret"), ad = r.h("ad"))
        assertEquals(r.s("tag"), Hex.str(tag))
    }

    @Test fun `mutant - Argon2 v1_0, without the v1_3 XOR, fails the RFC row`() {
        // Bouncy Castle keeps v1.0 behind a flag, which is exactly "drop the
        // v1.3 XOR": the RFC row must catch it.
        val r = fx.getAsJsonObject("rfc9106")
        val tag = Recovery.argon2id(r.h("password"), r.h("salt"), memoryKiB = 32, passes = 3, lanes = 4,
            secret = r.h("secret"), ad = r.h("ad"), version = Argon2Parameters.ARGON2_VERSION_10)
        assertTrue(Hex.str(tag) != r.s("tag"))
    }

    @Test fun `our parameters - the fixture's argon2_A and verifier`() {
        val d = fx.getAsJsonObject("derivations")
        val p = fx.getAsJsonObject("params").getAsJsonObject("argon2")
        assertEquals(Recovery.MEMORY_KIB, p.get("memoryKiB").asInt)
        assertEquals(Recovery.PASSES, p.get("passes").asInt)
        assertEquals(Recovery.LANES, p.get("parallelism").asInt)
        assertEquals(0x13, p.get("version").asInt)
        assertEquals(d.s("argon2_A"), Hex.str(Recovery.argon2id(d.h("code"), d.h("salt"))))
        assertEquals(d.s("verifier"), Hex.str(Recovery.verifier(d.h("code"), d.h("saltV"))))
    }

    @Test fun `randomized cross-check against Node's native Argon2id`() {
        // Random cases each run, small memory so a few dozen finish quickly.
        val rnd = SecureRandom()
        fun bytes(n: Int) = ByteArray(n).also { rnd.nextBytes(it) }
        data class Case(val pw: ByteArray, val salt: ByteArray, val secret: ByteArray?, val ad: ByteArray?,
                        val m: Int, val t: Int, val p: Int, val len: Int)
        val cases = List(24) { idx ->
            val p = 1 + rnd.nextInt(4)
            // Case 0 always has an EMPTY password (valid Argon2 input): it once
            // shifted every field of the line Node read, so it stays pinned.
            Case(bytes(if (idx == 0) 0 else rnd.nextInt(40)), bytes(8 + rnd.nextInt(24)),
                if (rnd.nextBoolean()) bytes(1 + rnd.nextInt(16)) else null,
                if (rnd.nextBoolean()) bytes(1 + rnd.nextInt(16)) else null,
                8 * p + rnd.nextInt(512), 1 + rnd.nextInt(3), p, 16 + rnd.nextInt(33))
        }
        // Every field is non-blank on the wire: "=" is zero bytes, "-" is absent.
        // A blank first field once vanished under Node's trim() and shifted the rest.
        fun field(b: ByteArray?) = when { b == null -> "-"; b.isEmpty() -> "="; else -> Hex.str(b) }
        val input = cases.joinToString("\n") { c ->
            listOf(field(c.pw), field(c.salt), field(c.secret), field(c.ad),
                c.m, c.t, c.p, c.len).joinToString(" ")
        }
        val script = """
            const c = require('crypto'); const out = []
            const buf = (f) => f === '=' ? Buffer.alloc(0) : Buffer.from(f, 'hex')
            for (const l of require('fs').readFileSync(0, 'utf8').trim().split('\n')) {
              const [pw, salt, sec, ad, m, t, p, len] = l.split(' ')
              const o = { message: buf(pw), nonce: buf(salt),
                memory: +m, passes: +t, parallelism: +p, tagLength: +len }
              if (sec !== '-') o.secret = buf(sec)
              if (ad !== '-') o.associatedData = buf(ad)
              out.push(c.argon2Sync('argon2id', o).toString('hex'))
            }
            process.stdout.write(out.join('\n'))
        """.trimIndent()
        val proc = ProcessBuilder("node", "-e", script).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        proc.outputStream.use { it.write(input.toByteArray()) }
        val node = proc.inputStream.bufferedReader().readText().trim().split("\n")
        assertEquals("node must run (this check never skips)", 0, proc.waitFor())
        assertEquals(cases.size, node.size)
        cases.forEachIndexed { i, c ->
            val ours = Recovery.argon2id(c.pw, c.salt, memoryKiB = c.m, passes = c.t, lanes = c.p, tagLen = c.len,
                secret = c.secret, ad = c.ad)
            assertEquals("case $i (m=${c.m} t=${c.t} p=${c.p} len=${c.len})", node[i], Hex.str(ours))
        }
    }

    @Test fun `a salt under RFC 9106's 8 bytes is refused, 8 is accepted`() {
        assertTrue(runCatching { Recovery.argon2id(ByteArray(10), ByteArray(7), memoryKiB = 64) }.exceptionOrNull() is IllegalArgumentException)
        assertTrue(runCatching { Recovery.argon2id(ByteArray(10), ByteArray(0), memoryKiB = 64) }.exceptionOrNull() is IllegalArgumentException)
        assertEquals(16, Recovery.argon2id(ByteArray(10), ByteArray(8), memoryKiB = 64, tagLen = 16).size)
    }

    @Test fun `every block Argon2 used reads back as zero afterwards`() {
        val pool = Recovery.WipingPool(track = true)
        val d = fx.getAsJsonObject("derivations")
        Recovery.argon2id(d.h("code"), d.h("salt"), memoryKiB = 1024, pool = pool)
        val v = Argon2BytesGenerator.Block::class.java.getDeclaredField("v").apply { isAccessible = true }
        assertTrue("the pool saw the blocks", pool.seen.size >= 1024)
        val dirty = pool.seen.count { (v.get(it) as LongArray).any { w -> w != 0L } }
        assertEquals("blocks left holding data", 0, dirty)
    }

    @Test fun `positive control - a pool that does not wipe leaves data the probe sees`() {
        val seen = ArrayList<Argon2BytesGenerator.Block>()
        val keep = object : Argon2BytesGenerator.BlockPool {
            override fun allocate() = Argon2BytesGenerator.Block().also { seen += it }
            override fun deallocate(block: Argon2BytesGenerator.Block) {}
        }
        Recovery.argon2id(ByteArray(10) { 1 }, ByteArray(16) { 2 }, memoryKiB = 64, pool = keep)
        val v = Argon2BytesGenerator.Block::class.java.getDeclaredField("v").apply { isAccessible = true }
        assertTrue(seen.any { (v.get(it) as LongArray).any { w -> w != 0L } })
    }

    @Test fun `a heap too small for the blocks refuses BEFORE allocating anything`() {
        var allocated = 0
        val counting = object : Argon2BytesGenerator.BlockPool {
            override fun allocate(): Argon2BytesGenerator.Block { allocated++; return Argon2BytesGenerator.Block() }
            override fun deallocate(block: Argon2BytesGenerator.Block) { block.clear() }
        }
        val r = runCatching {
            Recovery.argon2id(ByteArray(10), ByteArray(16), pool = counting,
                available = { Recovery.heapNeeded(Recovery.MEMORY_KIB) - 1 })
        }
        assertTrue(r.exceptionOrNull() is Recovery.Unavailable)
        assertEquals("not one block allocated", 0, allocated)
        assertTrue("and just enough heap runs it", runCatching {
            Recovery.argon2id(ByteArray(10), ByteArray(16), memoryKiB = 64, available = { Recovery.heapNeeded(64) })
        }.isSuccess)
    }

    @Test fun `out of memory is Unavailable, never a crash and never weaker parameters`() {
        val starved = object : Argon2BytesGenerator.BlockPool {
            var n = 0
            override fun allocate(): Argon2BytesGenerator.Block { if (++n > 100) throw OutOfMemoryError("test"); return Argon2BytesGenerator.Block() }
            override fun deallocate(block: Argon2BytesGenerator.Block) { block.clear() }
        }
        val r = runCatching { Recovery.argon2id(ByteArray(10), ByteArray(16), pool = starved) }
        assertTrue(r.exceptionOrNull() is Recovery.Unavailable)
        assertTrue("it tried the full 64 MiB, not less", starved.n > 100)
    }

    // ---- the code -------------------------------------------------------------------------

    @Test fun `every code prints exactly`() {
        for (c in fx.getAsJsonArray("codes").map { it.asJsonObject })
            assertEquals(c.s("printed"), Recovery.format(c.h("bytes")))
    }

    @Test fun `every parse row reaches its verdict`() {
        for (r in fx.getAsJsonArray("parse").map { it.asJsonObject }) {
            val p = Recovery.parse(r.s("input"))
            if (r.has("bytes")) assertEquals(r.s("note"), r.s("bytes"), Hex.str((p as Recovery.Parsed.Ok).code))
            else assertEquals(r.s("note"), r.s("reason"), (p as Recovery.Parsed.No).reason)
        }
    }

    // ---- derivations and blobs ---------------------------------------------------------

    @Test fun `wrap key and PRF kek`() {
        val d = fx.getAsJsonObject("derivations")
        assertEquals(d.s("wrapKey"), Hex.str(Recovery.wrapKey(d.h("code"), d.h("salt"))))
        val prf = d.getAsJsonObject("prf")
        assertEquals(d.s("prfKek"), Hex.str(Recovery.prfKek(prf.h("output"), prf.h("salt"))))
    }

    private val blobs get() = fx.getAsJsonObject("blobs")
    private val keys get() = blobs.getAsJsonObject("keys")

    @Test fun `PRF blobs seal to the exact bytes and open back to checked keys`() {
        val prf = blobs.getAsJsonObject("prf"); val inp = prf.getAsJsonObject("inputs")
        for ((name, mode, kx) in listOf(Triple("unruled", Recovery.KxMode.UNRULED, null), Triple("modeA", Recovery.KxMode.A, keys.h("kxD")))) {
            val want = prf.getAsJsonObject(name)
            val got = Recovery.sealPrfBlob(inp.h("prfOutput"), inp.h("credentialId"), inp.h("salt"), inp.h("iv"),
                Recovery.Keys(keys.h("accountD"), kx), mode)
            assertEquals(name, want.s("cred"), got.cred); assertEquals(want.s("salt"), got.salt)
            assertEquals(want.s("iv"), got.iv); assertEquals(name, want.s("ct"), got.ct)
            val opened = Recovery.openPrfBlob(got, inp.h("prfOutput"), inp.h("credentialId"),
                keys.s("accountPub"), if (kx != null) keys.s("kxPub") else null, mode)
            assertArrayEquals(keys.h("accountD"), (opened as Recovery.Opened.Ok).keys.account)
        }
    }

    @Test fun `a PRF blob opened with the wrong credential or a swapped key fails closed`() {
        val inp = blobs.getAsJsonObject("prf").getAsJsonObject("inputs")
        val blob = Recovery.sealPrfBlob(inp.h("prfOutput"), inp.h("credentialId"), inp.h("salt"), inp.h("iv"), Recovery.Keys(keys.h("accountD")))
        assertEquals("credential", (Recovery.openPrfBlob(blob, inp.h("prfOutput"), ByteArray(16), keys.s("accountPub")) as Recovery.Opened.No).reason)
        val swapped = Recovery.sealPrfBlob(inp.h("prfOutput"), inp.h("credentialId"), inp.h("salt"), inp.h("iv"), Recovery.Keys(keys.h("otherD")))
        assertEquals("key-mismatch", (Recovery.openPrfBlob(swapped, inp.h("prfOutput"), inp.h("credentialId"), keys.s("accountPub")) as Recovery.Opened.No).reason)
    }

    @Test fun `recovery inner layer seals to the exact bytes`() {
        val rec = blobs.getAsJsonObject("recovery"); val inp = rec.getAsJsonObject("inputs")
        val wk = Recovery.wrapKey(inp.h("code"), inp.h("salt"))
        val ct = Recovery.sealRecoveryInner(wk, inp.h("iv"), keys.s("accountPub"), Recovery.Keys(keys.h("accountD")))
        assertEquals(rec.s("inner"), Hex.str(ct))
        val opened = Recovery.openRecoveryInner(ct, wk, inp.h("iv"), keys.s("accountPub"))
        assertArrayEquals(keys.h("accountD"), (opened as Recovery.Opened.Ok).keys.account)
    }

    @Test fun `every scalar row reaches its verdict`() {
        for (r in fx.getAsJsonArray("scalars").map { it.asJsonObject }) {
            val o = Recovery.unpack(r.h("d"), r.s("pub"))
            if (r.s("expect") == "accept") assertTrue(r.s("name"), o is Recovery.Opened.Ok)
            else assertEquals(r.s("name"), r.s("reason"), (o as Recovery.Opened.No).reason)
        }
    }

    @Test fun `the range check refuses 0, n and above, accepts 1 and n-1`() {
        val n = Hex.bytes("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
        val nm1 = n.copyOf().also { it[31] = (it[31] - 1).toByte() }
        val np1 = n.copyOf().also { it[31] = (it[31] + 1).toByte() }
        assertTrue(Recovery.scalarInRange(ByteArray(31) + byteArrayOf(1)))
        assertTrue(Recovery.scalarInRange(nm1))
        assertTrue(!Recovery.scalarInRange(ByteArray(32)))
        assertTrue(!Recovery.scalarInRange(n)); assertTrue(!Recovery.scalarInRange(np1))
        assertTrue(!Recovery.scalarInRange(ByteArray(32) { -1 }))
    }
}
