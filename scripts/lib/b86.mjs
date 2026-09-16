// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// base86 — the densest ASCII carrier that is SAFE inside an HTML script block
// by construction, for the deflated runtime payloads (bento/deflate-b86).
//
// Alphabet: printable ASCII 0x21–0x7E (94 symbols) minus `<` `>` `&` `"` `'`
// `\` `-` and `{` — 86 symbols. What that makes unproducible, whatever the
// bytes: `</script` (no `<`), `<!--` and `-->` (no `<`, `>`, `-`), `]]>`
// (no `>`) and `${` (no `{`; `$` stays). Quotes, ampersand and backslash go
// so the text is also safe inside an attribute or a JS string. Space is not
// in the alphabet, so a run of payload never wraps or tokenises.
//
// Groups: 4 bytes → 5 chars (86^5 = 4,704,270,176 > 2^32): 6.4 bits per
// character, so a payload costs ×1.25 against base64's ×1.333 — 6.25%
// smaller. The limit for 86 symbols is log2(86) = 6.43 bits per character,
// so 4→5 is within 0.4% of it; a 7-byte → 9-char group would be WORSE
// (6.22 bits per character) — larger groups buy nothing here, and 32-bit
// arithmetic is all the decoder needs.
//
// Tail: the last partial group of n bytes (1–3) is padded with zero bytes,
// encoded, and n+1 characters are emitted; a decoder pads the missing
// characters with the highest symbol and keeps the first n bytes — the
// Ascii85 rule, which rounds correctly because the padding is maximal.

export const ALPHABET = (() => {
  let s = ''
  for (let c = 0x21; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c)
    if ('<>&"\'\\-{'.includes(ch)) continue
    s += ch
  }
  return s
})()
export const BASE = ALPHABET.length // 86
if (BASE !== 86) throw new Error(`b86: alphabet is ${BASE} symbols, expected 86`)

const VALUE = new Int16Array(128).fill(-1)
for (let i = 0; i < BASE; i++) VALUE[ALPHABET.charCodeAt(i)] = i

/** Uint8Array → base86 text. */
export function encode(bytes) {
  const out = []
  const n = bytes.length
  let i = 0
  for (; i + 4 <= n; i += 4) {
    let v = ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3]
    const c4 = v % BASE; v = Math.floor(v / BASE)
    const c3 = v % BASE; v = Math.floor(v / BASE)
    const c2 = v % BASE; v = Math.floor(v / BASE)
    const c1 = v % BASE; v = Math.floor(v / BASE)
    out.push(ALPHABET[v], ALPHABET[c1], ALPHABET[c2], ALPHABET[c3], ALPHABET[c4])
  }
  const rest = n - i
  if (rest) {
    let v = 0
    for (let k = 0; k < 4; k++) v = v * 256 + (k < rest ? bytes[i + k] : 0)
    const chars = new Array(5)
    for (let k = 4; k >= 0; k--) { chars[k] = ALPHABET[v % BASE]; v = Math.floor(v / BASE) }
    out.push(...chars.slice(0, rest + 1))
  }
  return out.join('')
}

/** base86 text → Uint8Array. Throws on a character outside the alphabet. */
export function decode(text) {
  const len = text.length
  const full = Math.floor(len / 5)
  const rest = len - full * 5 // 0, or 2–4 (n+1 chars for n bytes)
  if (rest === 1) throw new Error('b86: a trailing single character cannot encode a byte')
  const out = new Uint8Array(full * 4 + (rest ? rest - 1 : 0))
  let o = 0
  let i = 0
  const val = (c) => { const v = VALUE[c]; if (v < 0) throw new Error(`b86: bad character ${JSON.stringify(String.fromCharCode(c))}`); return v }
  for (; i + 5 <= len; i += 5) {
    const v = (((val(text.charCodeAt(i)) * BASE + val(text.charCodeAt(i + 1))) * BASE + val(text.charCodeAt(i + 2))) * BASE + val(text.charCodeAt(i + 3))) * BASE + val(text.charCodeAt(i + 4))
    out[o++] = (v / 16777216) & 255; out[o++] = (v >>> 16) & 255; out[o++] = (v >>> 8) & 255; out[o++] = v & 255
  }
  if (rest) {
    let v = 0
    for (let k = 0; k < 5; k++) v = v * BASE + (k < rest ? val(text.charCodeAt(i + k)) : BASE - 1)
    const bytes = [(v / 16777216) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
    for (let k = 0; k < rest - 1; k++) out[o++] = bytes[k]
  }
  return out
}

/** The five sequences a payload must never contain — asserted by the gate. */
export const FORBIDDEN = ['</script', '<!--', '-->', ']]>', '${']

/** The decoder as it ships inside the loader: the same arithmetic, as a
 *  string, with a 128-entry lookup built from the alphabet at boot. */
export const LOADER_DECODER = `
  var B86 = ${JSON.stringify(ALPHABET)}
  var b86v = new Int16Array(128); for (var q = 0; q < 128; q++) b86v[q] = -1
  for (var q = 0; q < 86; q++) b86v[B86.charCodeAt(q)] = q
  var b86decode = function (t) {
    var n = t.length, full = (n / 5) | 0, rest = n - full * 5
    var out = new Uint8Array(full * 4 + (rest ? rest - 1 : 0)), o = 0, i = 0, v
    // a character outside the alphabet is an error, never a guess
    var c = function (j) { var x = t.charCodeAt(j), y = x < 128 ? b86v[x] : -1; if (y < 0) throw new Error('base86: bad character code ' + x + ' at index ' + j); return y }
    for (; i + 5 <= n; i += 5) {
      v = (((c(i) * 86 + c(i + 1)) * 86 + c(i + 2)) * 86 + c(i + 3)) * 86 + c(i + 4)
      out[o++] = (v / 16777216) & 255; out[o++] = (v >>> 16) & 255; out[o++] = (v >>> 8) & 255; out[o++] = v & 255
    }
    if (rest) {
      v = 0
      for (var k = 0; k < 5; k++) v = v * 86 + (k < rest ? c(i + k) : 85)
      var tail = [(v / 16777216) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
      for (var k2 = 0; k2 < rest - 1; k2++) out[o++] = tail[k2]
    }
    return out
  }`
