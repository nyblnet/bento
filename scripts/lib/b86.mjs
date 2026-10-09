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

// ————— Experimental alphabets (Teams preview bisection, 2026-09-16) —————
//
// Built to bisect why Teams' preview card stayed blue for base86 files when
// a base64 file had rendered; the bisection was overturned when the same
// bytes previewed on one upload and not the next (DECISIONS, "The preview
// pane is not deterministic"). No character conclusion stands. Kept
// build-side only, behind `--encoding` in postbuild-compress: makeCodec is
// never part of the shipped loader, which carries the b86 decoder alone.
//
//   b85np / b85ns / b85nq / b85nh / b85nc / b85na
//          b86 minus `%` / `*` / `?` / `#` / `:` / `@` (85; 4→5)
//   b84    b86 minus `?` and `#` (84 < 85 → 7→9 group)
//   b80    b86 minus the RFC 3986 gen-delims `: / ? # @` and `%` (80;
//          80^5 < 2^32 so the group is 7 bytes → 9 chars, 80^9 > 2^56,
//          BigInt arithmetic: 6.32 bits per char, ×1.286)
//
// Tail rule generalised from Ascii85: n leftover bytes are zero-padded to a
// full group, encoded, and the first m characters emitted, where m is the
// least count such that max-symbol padding on decode still recovers the n
// bytes: BASE^(C−m) ≤ 256^(B−n). Both sides compute the same table.

const tailTable = (B, C, base) => {
  const chars = new Array(B).fill(0)
  for (let n = 1; n < B; n++) {
    let m = C
    while (m > 0 && Math.pow(base, C - (m - 1)) <= Math.pow(256, B - n)) m--
    chars[n] = m
  }
  return chars // chars[n] = characters emitted for n leftover bytes
}

export function makeCodec(alphabet) {
  const base = alphabet.length
  const big = Math.pow(base, 5) <= 4294967296
  const [B, C] = big ? [7, 9] : [4, 5]
  if (big && Math.pow(base, 9) <= Math.pow(2, 56)) throw new Error(`alphabet of ${base} symbols cannot carry 7 bytes in 9 chars`)
  const tail = tailTable(B, C, base)
  const value = new Int16Array(128).fill(-1)
  for (let i = 0; i < base; i++) value[alphabet.charCodeAt(i)] = i
  const val = (c) => { const v = value[c]; if (v < 0) throw new Error(`base${base}: bad character ${JSON.stringify(String.fromCharCode(c))}`); return v }
  const groupEnc = (bytes, i, count) => {
    let v = 0n
    for (let k = 0; k < B; k++) v = v * 256n + BigInt(k < count ? bytes[i + k] : 0)
    const out = new Array(C)
    const bb = BigInt(base)
    for (let k = C - 1; k >= 0; k--) { out[k] = alphabet[Number(v % bb)]; v /= bb }
    return out
  }
  const groupDec = (text, i, count, into, o) => {
    let v = 0n
    const bb = BigInt(base)
    for (let k = 0; k < C; k++) v = v * bb + BigInt(k < count ? val(text.charCodeAt(i + k)) : base - 1)
    const bytes = new Array(B)
    for (let k = B - 1; k >= 0; k--) { bytes[k] = Number(v & 255n); v >>= 8n }
    return bytes
  }
  const encode = (bytes) => {
    if (!big) { // same arithmetic as the shipped b86, parameterised by base
      const out = []; const n = bytes.length; let i = 0
      for (; i + 4 <= n; i += 4) {
        let v = ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3]
        const c = new Array(5)
        for (let k = 4; k >= 0; k--) { c[k] = alphabet[v % base]; v = Math.floor(v / base) }
        out.push(c[0], c[1], c[2], c[3], c[4])
      }
      const rest = n - i
      if (rest) { let v = 0; for (let k = 0; k < 4; k++) v = v * 256 + (k < rest ? bytes[i + k] : 0); const c = new Array(5); for (let k = 4; k >= 0; k--) { c[k] = alphabet[v % base]; v = Math.floor(v / base) }; out.push(...c.slice(0, tail[rest])) }
      return out.join('')
    }
    const out = []; const n = bytes.length; let i = 0
    for (; i + B <= n; i += B) out.push(...groupEnc(bytes, i, B))
    const rest = n - i
    if (rest) out.push(...groupEnc(bytes, i, rest).slice(0, tail[rest]))
    return out.join('')
  }
  const decode = (text) => {
    const len = text.length
    const full = Math.floor(len / C)
    const rest = len - full * C
    const restBytes = rest ? tail.indexOf(rest) : 0
    if (rest && restBytes < 1) throw new Error(`base${base}: a trailing run of ${rest} characters encodes nothing`)
    const out = new Uint8Array(full * B + restBytes)
    let o = 0; let i = 0
    if (!big) {
      for (; i + 5 <= len; i += 5) {
        const v = (((val(text.charCodeAt(i)) * base + val(text.charCodeAt(i + 1))) * base + val(text.charCodeAt(i + 2))) * base + val(text.charCodeAt(i + 3))) * base + val(text.charCodeAt(i + 4))
        out[o++] = (v / 16777216) & 255; out[o++] = (v >>> 16) & 255; out[o++] = (v >>> 8) & 255; out[o++] = v & 255
      }
      if (rest) { let v = 0; for (let k = 0; k < 5; k++) v = v * base + (k < rest ? val(text.charCodeAt(i + k)) : base - 1); const bytes = [(v / 16777216) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; for (let k = 0; k < restBytes; k++) out[o++] = bytes[k] }
      return out
    }
    for (; i + C <= len; i += C) { const b = groupDec(text, i, C); for (let k = 0; k < B; k++) out[o++] = b[k] }
    if (rest) { const b = groupDec(text, i, rest); for (let k = 0; k < restBytes; k++) out[o++] = b[k] }
    return out
  }
  // the decoder as it ships inside the loader for this alphabet
  const loaderDecoder = !big ? `
  var B86 = ${JSON.stringify(alphabet)}
  var b86v = new Int16Array(128); for (var q = 0; q < 128; q++) b86v[q] = -1
  for (var q = 0; q < ${base}; q++) b86v[B86.charCodeAt(q)] = q
  var b86tail = ${JSON.stringify(tail)}
  var b86decode = function (t) {
    var n = t.length, full = (n / 5) | 0, rest = n - full * 5, restBytes = rest ? b86tail.indexOf(rest) : 0
    if (rest && restBytes < 1) throw new Error('base${base}: bad tail length ' + rest)
    var out = new Uint8Array(full * 4 + restBytes), o = 0, i = 0, v
    var c = function (j) { var x = t.charCodeAt(j), y = x < 128 ? b86v[x] : -1; if (y < 0) throw new Error('base${base}: bad character code ' + x + ' at index ' + j); return y }
    for (; i + 5 <= n; i += 5) {
      v = (((c(i) * ${base} + c(i + 1)) * ${base} + c(i + 2)) * ${base} + c(i + 3)) * ${base} + c(i + 4)
      out[o++] = (v / 16777216) & 255; out[o++] = (v >>> 16) & 255; out[o++] = (v >>> 8) & 255; out[o++] = v & 255
    }
    if (rest) {
      v = 0
      for (var k = 0; k < 5; k++) v = v * ${base} + (k < rest ? c(i + k) : ${base - 1})
      var tl = [(v / 16777216) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
      for (var k2 = 0; k2 < restBytes; k2++) out[o++] = tl[k2]
    }
    return out
  }` : `
  var B86 = ${JSON.stringify(alphabet)}
  var b86v = new Int16Array(128); for (var q = 0; q < 128; q++) b86v[q] = -1
  for (var q = 0; q < ${base}; q++) b86v[B86.charCodeAt(q)] = q
  var b86tail = ${JSON.stringify(tail)}
  var b86decode = function (t) {
    var n = t.length, full = (n / ${C}) | 0, rest = n - full * ${C}, restBytes = rest ? b86tail.indexOf(rest) : 0
    if (rest && restBytes < 1) throw new Error('base${base}: bad tail length ' + rest)
    var out = new Uint8Array(full * ${B} + restBytes), o = 0, i = 0, bb = BigInt(${base})
    var c = function (j) { var x = t.charCodeAt(j), y = x < 128 ? b86v[x] : -1; if (y < 0) throw new Error('base${base}: bad character code ' + x + ' at index ' + j); return y }
    var grp = function (at, count, take) {
      var v = 0n
      for (var k = 0; k < ${C}; k++) v = v * bb + BigInt(k < count ? c(at + k) : ${base - 1})
      var bytes = new Array(${B})
      for (var k2 = ${B - 1}; k2 >= 0; k2--) { bytes[k2] = Number(v & 255n); v >>= 8n }
      for (var k3 = 0; k3 < take; k3++) out[o++] = bytes[k3]
    }
    for (; i + ${C} <= n; i += ${C}) grp(i, ${C}, ${B})
    if (rest) grp(i, rest, restBytes)
    return out
  }`
  return { ALPHABET: alphabet, BASE: base, GROUP: [B, C], encode, decode, LOADER_DECODER: loaderDecoder }
}

const without = (drop) => ALPHABET.split('').filter((ch) => !drop.includes(ch)).join('')
export const VARIANTS = {
  b86: { ALPHABET, BASE, GROUP: [4, 5], encode, decode, LOADER_DECODER },
  b85np: makeCodec(without('%')),
  b85ns: makeCodec(without('*')),
  b80: makeCodec(without('%:/?#@')),
  b85nq: makeCodec(without('?')),
  b85nh: makeCodec(without('#')),
  b85nc: makeCodec(without(':')),
  b85na: makeCodec(without('@')),
  b84: makeCodec(without('?#')), // 84 < 85 forces the 7→9 group
}
