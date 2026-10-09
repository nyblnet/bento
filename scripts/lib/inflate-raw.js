// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A raw DEFLATE (RFC 1951) decoder in plain JavaScript — stored, fixed and
// dynamic Huffman blocks — for a host without DecompressionStream. No
// dependencies, no window, so it runs in node for the byte-identity check
// and is inlined (minified) into the shell loader when asked for.
//
//   inflateRaw(bytes: Uint8Array) → Uint8Array
//
// Straightforward, not fast: a bit reader, canonical Huffman tables built as
// (code length → first code) plus a symbol list, and a linear decode loop.
// The runtime payload is ~650 KB and inflates in well under a second even
// so; this path is a fallback, not the default.

export function inflateRaw(src) {
  var pos = 0, bit = 0
  var out = new Uint8Array(src.length * 4 + 1024), len = 0
  function grow(n) {
    if (len + n <= out.length) return
    var next = new Uint8Array(Math.max(out.length * 2, len + n + 1024))
    next.set(out.subarray(0, len)); out = next
  }
  function bits(n) {
    var v = 0
    for (var i = 0; i < n; i++) {
      if (pos >= src.length) throw new Error('inflate: unexpected end of data')
      v |= ((src[pos] >> bit) & 1) << i
      if (++bit === 8) { bit = 0; pos++ }
    }
    return v
  }
  // A canonical Huffman table from code lengths: count[len], symbols in code order.
  function table(lengths) {
    var count = new Uint16Array(16), symbol = new Uint16Array(lengths.length), i
    for (i = 0; i < lengths.length; i++) count[lengths[i]]++
    count[0] = 0
    var offs = new Uint16Array(16)
    for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1]
    for (i = 0; i < lengths.length; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i
    return { count: count, symbol: symbol }
  }
  function decode(t) {
    var code = 0, first = 0, index = 0
    for (var l = 1; l < 16; l++) {
      code |= bits(1)
      var c = t.count[l]
      if (code - c < first) return t.symbol[index + (code - first)]
      index += c; first += c; first <<= 1; code <<= 1
    }
    throw new Error('inflate: bad code')
  }
  var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
  var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
  var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
  var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
  var fixedLit = null, fixedDist = null
  function codes(lit, dist) {
    for (;;) {
      var sym = decode(lit)
      if (sym < 256) { grow(1); out[len++] = sym; continue }
      if (sym === 256) return
      sym -= 257
      if (sym >= 29) throw new Error('inflate: bad length symbol')
      var n = LBASE[sym] + bits(LEXT[sym])
      var ds = decode(dist)
      if (ds >= 30) throw new Error('inflate: bad distance symbol')
      var d = DBASE[ds] + bits(DEXT[ds])
      if (d > len) throw new Error('inflate: distance too far back')
      grow(n)
      for (var i = 0; i < n; i++) { out[len] = out[len - d]; len++ }
    }
  }
  var last
  do {
    last = bits(1)
    var type = bits(2)
    if (type === 0) {
      // stored: skip to a byte boundary, LEN, NLEN, raw bytes
      if (bit) { bit = 0; pos++ }
      var n = src[pos] | (src[pos + 1] << 8), nn = src[pos + 2] | (src[pos + 3] << 8)
      if ((n ^ 0xffff) !== nn) throw new Error('inflate: stored length check failed')
      pos += 4
      grow(n); out.set(src.subarray(pos, pos + n), len); len += n; pos += n
    } else if (type === 1) {
      if (!fixedLit) {
        var l = new Uint8Array(288), i
        for (i = 0; i < 144; i++) l[i] = 8
        for (; i < 256; i++) l[i] = 9
        for (; i < 280; i++) l[i] = 7
        for (; i < 288; i++) l[i] = 8
        fixedLit = table(l)
        var dl = new Uint8Array(30); for (i = 0; i < 30; i++) dl[i] = 5
        fixedDist = table(dl)
      }
      codes(fixedLit, fixedDist)
    } else if (type === 2) {
      var nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4
      var ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
      var cl = new Uint8Array(19), j
      for (j = 0; j < ncode; j++) cl[ORDER[j]] = bits(3)
      var clt = table(cl)
      var lengths = new Uint8Array(nlen + ndist), k = 0
      while (k < nlen + ndist) {
        var s = decode(clt)
        if (s < 16) lengths[k++] = s
        else {
          var rep, val = 0
          if (s === 16) { if (!k) throw new Error('inflate: repeat with no previous length'); val = lengths[k - 1]; rep = 3 + bits(2) }
          else if (s === 17) rep = 3 + bits(3)
          else rep = 11 + bits(7)
          if (k + rep > nlen + ndist) throw new Error('inflate: too many lengths')
          while (rep--) lengths[k++] = val
        }
      }
      codes(table(lengths.subarray(0, nlen)), table(lengths.subarray(nlen)))
    } else throw new Error('inflate: bad block type')
  } while (!last)
  return out.subarray(0, len)
}
