// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Raw LZMA1 decoder (range coder + LZ77 with the LZMA state machine), for the
// bento/lzma-b91 payload blocks. SYNCHRONOUS, like inflate-raw.js, and for the
// same reason. The packer fixes lc=3, lp=0, pb=0 (measured best for the
// runtime payloads), so the position-state terms are gone. Input: 4 bytes of
// little-endian output length, then the raw LZMA1 stream, with or without an
// end marker (the packer writes none: decoding stops at the declared length).
// Refuses, rather than guesses: a declared length over 256 MiB (allocated
// before a byte is decoded), a distance before the start of the output, a
// stream that ends early, and one that ran out of input (a truncated block
// would otherwise decode to zero-fed garbage of exactly the right length).
// Probability layout: isMatch 0, isRep 192, isRepG0 204, isRepG1 216,
// isRepG2 228, isRep0Long 240, posSlot 432, specPos 688, align 816,
// lenCoder 832, repLenCoder 1346, literals 1860.
export function unlzma(s) {
  var n = (s[0] | s[1] << 8 | s[2] << 16 | s[3] << 24) >>> 0
  if (n > 268435456) throw new Error('lzma: declared length ' + n + ' is over the limit')
  var o = new Uint8Array(n), P = new Uint16Array(8004).fill(1024),
    r = -1, c = 0, ip = 5, op = 0, st = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0, i, len, m, d, nb
  for (i = 0; i < 4; i++) c = c << 8 | s[ip++]
  var B = function (i) {
    var p = P[i], b = Math.imul(r >>> 11, p)
    if ((c >>> 0) < (b >>> 0)) { r = b; P[i] = p + ((2048 - p) >> 5); if (!(r >>> 24)) { r <<= 8; c = c << 8 | s[ip++] } return 0 }
    r = r - b | 0; c = c - b | 0; P[i] = p - (p >> 5); if (!(r >>> 24)) { r <<= 8; c = c << 8 | s[ip++] }
    return 1
  }
  var T = function (base, bits) { for (var m = 1, i = bits; i--;) m = m * 2 + B(base + m); return m - (1 << bits) }
  var R = function (base, bits) { for (var m = 1, v = 0, i = 0, b; i < bits; i++) { b = B(base + m); m = m * 2 + b; v |= b << i } return v }
  var L = function (base) { return B(base) ? B(base + 1) ? 16 + T(base + 258, 8) : 8 + T(base + 130, 3) : T(base + 2, 3) }
  while (op < n) {
    if (!B(st << 4)) {
      i = 1860 + 768 * ((op ? o[op - 1] : 0) >> 5); m = 1
      if (st > 6) { d = o[op - r0 - 1]; do { nb = (d >> 7) & 1; d <<= 1; len = B(i + ((1 + nb) << 8) + m); m = m * 2 + len } while (nb == len && m < 256) }
      while (m < 256) m = m * 2 + B(i + m)
      o[op++] = m
      st = st < 4 ? 0 : st < 10 ? st - 3 : st - 6
      continue
    }
    if (B(192 + st)) {
      if (!B(204 + st)) {
        if (!B(240 + (st << 4))) { st = st < 7 ? 9 : 11; o[op] = o[op - r0 - 1]; op++; continue }
      } else {
        if (!B(216 + st)) d = r1; else { if (!B(228 + st)) d = r2; else { d = r3; r3 = r2 } r2 = r1 }
        r1 = r0; r0 = d
      }
      len = L(1346); st = st < 7 ? 8 : 11
    } else {
      r3 = r2; r2 = r1; r1 = r0
      len = L(832); st = st < 7 ? 7 : 10
      r0 = T(432 + ((len < 4 ? len : 3) << 6), 6)
      if (r0 > 3) {
        m = r0; nb = (m >> 1) - 1; r0 = (2 | (m & 1)) * Math.pow(2, nb)
        if (m < 14) r0 += R(688 + r0 - m, nb)
        else {
          for (d = 0, i = nb - 4; i--;) { r >>>= 1; d *= 2; if ((c >>> 0) >= r) { c = c - r | 0; d++ } if (!(r >>> 24)) { r <<= 8; c = c << 8 | s[ip++] } }
          r0 += d * 16 + R(816, 4)
        }
      }
      if (r0 == 4294967295) break // the end marker xz writes
    }
    if (r0 >= op) throw new Error('lzma: distance beyond the start of the output')
    for (len += 2; len-- && op < n;) { o[op] = o[op - r0 - 1]; op++ }
  }
  if (op != n) throw new Error('lzma: the stream ended at ' + op + ' of ' + n + ' bytes')
  if (ip > s.length) throw new Error('lzma: the stream is truncated')
  return o
}
