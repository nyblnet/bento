// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.probe.origin

/**
 * A copy of the host app's strict JSON reader (page.bento.home.Json): the probe shares no code with
 * the app, by design. org.json is a stub on the JVM rig, so parsing is plain Kotlin and
 * tested as such. Objects become
 * Map, arrays List, numbers Double, plus String / Boolean / null. Anything malformed,
 * or any trailing text, is null — never a partial result.
 */
object Json {
    fun parse(s: String): Any? = try {
        val r = Reader(s); val v = r.value(0); r.ws(); if (r.i != s.length) throw IllegalArgumentException("trailing") else v
    } catch (e: Exception) { null }

    fun quote(s: String): String = buildString {
        append('"')
        for (c in s) when {
            c == '"' -> append("\\\""); c == '\\' -> append("\\\\")
            c.code < 0x20 || c.code > 0x7e -> append("\\u%04x".format(c.code))
            else -> append(c)
        }
        append('"')
    }

    @Suppress("UNCHECKED_CAST") fun obj(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>

    private class Reader(val s: String) {
        var i = 0
        fun ws() { while (i < s.length && s[i] in " \t\r\n") i++ }
        fun value(depth: Int): Any? {
            require(depth < 16); ws()
            return when (val c = s[i]) {
                '{' -> obj(depth)
                '[' -> arr(depth)
                '"' -> str()
                't' -> lit("true", true); 'f' -> lit("false", false); 'n' -> lit("null", null)
                else -> { require(c == '-' || c in '0'..'9'); val st = i; i++
                    while (i < s.length && (s[i] in '0'..'9' || s[i] in ".eE+-")) i++
                    s.substring(st, i).toDouble() }
            }
        }
        fun obj(depth: Int): Map<String, Any?> {
            i++; val m = LinkedHashMap<String, Any?>(); ws()
            if (s[i] == '}') { i++; return m }
            while (true) {
                ws(); val k = str(); ws(); require(s[i++] == ':'); require(!m.containsKey(k)); m[k] = value(depth + 1); ws()
                when (s[i++]) { ',' -> continue; '}' -> return m; else -> throw IllegalArgumentException() }
            }
        }
        fun arr(depth: Int): List<Any?> {
            i++; val l = ArrayList<Any?>(); ws()
            if (s[i] == ']') { i++; return l }
            while (true) {
                l += value(depth + 1); ws()
                when (s[i++]) { ',' -> continue; ']' -> return l; else -> throw IllegalArgumentException() }
            }
        }
        fun lit(w: String, v: Any?): Any? { require(s.startsWith(w, i)); i += w.length; return v }
        fun str(): String {
            require(s[i++] == '"'); val b = StringBuilder()
            while (true) {
                val c = s[i++]
                when {
                    c == '"' -> return b.toString()
                    c == '\\' -> when (val e = s[i++]) {
                        '"', '\\', '/' -> b.append(e); 'n' -> b.append('\n'); 't' -> b.append('\t'); 'r' -> b.append('\r')
                        'b' -> b.append('\b'); 'f' -> b.append('\u000c')
                        'u' -> { b.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                        else -> throw IllegalArgumentException()
                    }
                    c.code < 0x20 -> throw IllegalArgumentException()
                    else -> b.append(c)
                }
            }
        }
    }
}
