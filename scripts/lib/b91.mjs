// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// base91 — the carrier of the bento/lzma-b91 payload blocks: printable ASCII 0x21–0x7E minus `<` `>` `{`: 91 symbols.
// Still unproducible by construction: `</script`, `<!--` (no `<`), `-->`,
// `]]>` (no `>`), `${` (no `{`). Unlike b86 it carries `&` `"` `'` `\` `-`,
// so it is safe as SCRIPT TEXT only, not inside an attribute or a JS string.
// 91^2 = 8281 >= 2^13: 13 bits per 2 chars = 6.5 bits per char (x1.2308
// against b86's x1.25), a plain bit stream, 32-bit arithmetic.
// Tail: 1..6 leftover bits -> one char, 7..12 -> two chars (zero padded), so
// the padding is always under 8 bits and the byte count is floor(bits / 8).
export const ALPHABET = (() => { let s = ''; for (let c = 0x21; c <= 0x7e; c++) { const ch = String.fromCharCode(c); if (!'<>{'.includes(ch)) s += ch } return s })()
if (ALPHABET.length !== 91) throw new Error('b91: alphabet')
export function encode(bytes) {
  const out = []; let acc = 0, nb = 0
  for (let i = 0; i < bytes.length; i++) {
    acc = acc * 256 + bytes[i]; nb += 8
    while (nb >= 13) { nb -= 13; const v = Math.floor(acc / 2 ** nb); acc -= v * 2 ** nb; out.push(ALPHABET[(v / 91) | 0], ALPHABET[v % 91]) }
  }
  if (nb > 6) { const v = acc * 2 ** (13 - nb); out.push(ALPHABET[(v / 91) | 0], ALPHABET[v % 91]) } else if (nb) out.push(ALPHABET[acc * 2 ** (6 - nb)])
  return out.join('')
}
const VALUE = new Int16Array(128).fill(-1)
for (let i = 0; i < 91; i++) VALUE[ALPHABET.charCodeAt(i)] = i
export function decode(t) {
  const n = t.length, out = new Uint8Array(((n >> 1) * 13 + (n & 1) * 6) >> 3)
  let o = 0, acc = 0, nb = 0
  const c = (j) => { const x = t.charCodeAt(j), y = x < 128 ? VALUE[x] : -1; if (y < 0) throw new Error('base91: bad character code ' + x + ' at index ' + j); return y }
  for (let i = 0; i < n; i += 2) {
    if (i + 1 < n) { acc = acc << 13 | (c(i) * 91 + c(i + 1)); nb += 13 } else { acc = acc << 6 | c(i); nb += 6 }
    while (nb >= 8 && o < out.length) { nb -= 8; out[o++] = (acc >>> nb) & 255 }
  }
  return out
}
/** the name the loader calls; see LOADER_DECODER */
export const LOADER_DECODE_FN = 'b91decode'
export const LOADER_DECODER = `
  var B91 = ${JSON.stringify(ALPHABET)}
  var b91v = new Int16Array(128); for (var q = 0; q < 128; q++) b91v[q] = -1
  for (var q = 0; q < 91; q++) b91v[B91.charCodeAt(q)] = q
  var b91decode = function (t) {
    var n = t.length, out = new Uint8Array(((n >> 1) * 13 + (n & 1) * 6) >> 3), o = 0, acc = 0, nb = 0
    var c = function (j) { var x = t.charCodeAt(j), y = x < 128 ? b91v[x] : -1; if (y < 0) throw new Error('base91: bad character code ' + x + ' at index ' + j); return y }
    for (var i = 0; i < n; i += 2) {
      if (i + 1 < n) { acc = acc << 13 | (c(i) * 91 + c(i + 1)); nb += 13 } else { acc = acc << 6 | c(i); nb += 6 }
      while (nb >= 8 && o < out.length) { nb -= 8; out[o++] = (acc >>> nb) & 255 }
    }
    return out
  }`
