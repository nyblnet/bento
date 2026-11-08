// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import Foundation
import os

/// Argon2id (RFC 9106, version 0x13), which neither CryptoKit nor CommonCrypto
/// has. It stretches a recovery code into its keys (kernel/src/recovery.ts).
///
/// Self-contained, no third-party code. scripts/test-home-id-recovery.mjs holds
/// it to RFC 9106 §5.3, to every byte of kernel/fixtures/recovery-v1.json, and
/// to Node's native Argon2id on random inputs.
///
/// Lanes are filled one after another (no threads), which is what the format
/// allows and is the same result as filling them in parallel.
///
/// Everything derived from the password (the 64 MiB of blocks, the scratch
/// blocks, H0 and the H' intermediates) is wiped with memset_s before it's
/// released, which the compiler may not elide. That's best effort in Swift: an
/// Array the runtime copied behind our back can't be reached.
enum Argon2id {
    struct Params: Equatable {
        let memoryKiB: Int
        let passes: Int
        let parallelism: Int
        let tagLength: Int
    }

    /// security §28: p = 1, 64 MiB, t = 3, a 32-byte tag
    static let bento = Params(memoryKiB: 65536, passes: 3, parallelism: 1, tagLength: 32)

    // MARK: - memory

    /// Past what it was given, iOS ends the process outright (jetsam): there is
    /// no failed allocation to catch, and Swift's allocate never returns nil. So
    /// the memory is checked BEFORE anything is allocated, and a derivation the
    /// process can't afford is refused cleanly.
    static let headroom = 32 << 20

    /// the blocks a derivation fills, plus headroom
    static func memoryNeeded(_ params: Params) -> Int {
        let p = params.parallelism
        return 4 * p * (params.memoryKiB / (4 * p)) * 1024 + headroom
    }

    /// How much more this process may allocate before iOS ends it. nil where
    /// there's no such limit: the simulator and the Mac.
    static func platformAvailableMemory() -> Int? {
        #if os(iOS) && !targetEnvironment(simulator) && !targetEnvironment(macCatalyst)
        return Int(os_proc_available_memory())
        #else
        return nil
        #endif
    }

    #if DEBUG || BENTO_WIPE_PROBE
    /// Replaceable in DEBUG and rig builds only, so the rig can stand in a
    /// low-memory device. A release build can't swap the reading.
    nonisolated(unsafe) static var availableMemory: () -> Int? = platformAvailableMemory
    #else
    static let availableMemory: () -> Int? = platformAvailableMemory
    #endif

    /// Whether a derivation with these parameters can run now: what the UI asks
    /// so it can say why a recovery can't go ahead.
    static func hasMemory(for params: Params = bento) -> Bool {
        guard let free = availableMemory() else { return true }
        return free >= memoryNeeded(params)
    }

    /// The tag, or nil when this process can't afford the memory right now.
    static func hash(password: [UInt8], salt: [UInt8], secret: [UInt8] = [], ad: [UInt8] = [],
                     params: Params = bento) -> [UInt8]? {
        let p = params.parallelism, t = params.passes
        precondition(p >= 1 && t >= 1 && params.tagLength >= 4 && params.memoryKiB >= 8 * p)
        guard hasMemory(for: params) else { return nil }
        let mPrime = 4 * p * (params.memoryKiB / (4 * p))
        let laneLen = mPrime / p, segLen = laneLen / 4

        var h0in: [UInt8] = []
        for v in [p, params.tagLength, params.memoryKiB, t, 0x13, 2] { h0in += le32(v) }
        for field in [password, salt, secret, ad] { h0in += le32(field.count) + field }
        var h0 = Blake2b.hash(h0in, outLength: 64)
        wipe(&h0in)
        defer { wipe(&h0) }

        let mem = UnsafeMutablePointer<UInt64>.allocate(capacity: mPrime * 128)
        mem.initialize(repeating: 0, count: mPrime * 128)
        defer { release(mem, mPrime * 128) }
        func block(_ lane: Int, _ col: Int) -> UnsafeMutablePointer<UInt64> { mem + (lane * laneLen + col) * 128 }

        for lane in 0..<p {
            for col in 0..<2 {
                var seed = h0 + le32(col) + le32(lane), first = hPrime(seed, 1024)
                load(first, into: block(lane, col))
                wipe(&seed); wipe(&first)
            }
        }

        let g = Compressor()
        defer { g.free() }
        let zero = UnsafeMutablePointer<UInt64>.allocate(capacity: 128); zero.initialize(repeating: 0, count: 128)
        let input = UnsafeMutablePointer<UInt64>.allocate(capacity: 128); input.initialize(repeating: 0, count: 128)
        let address = UnsafeMutablePointer<UInt64>.allocate(capacity: 128); address.initialize(repeating: 0, count: 128)
        defer { release(zero, 128); release(input, 128); release(address, 128) }

        for pass in 0..<t {
            for slice in 0..<4 {
                for lane in 0..<p {
                    // Argon2id: data-independent addressing for the first half of the first pass
                    let independent = pass == 0 && slice < 2
                    if independent {
                        input.initialize(repeating: 0, count: 128)
                        input[0] = UInt64(pass); input[1] = UInt64(lane); input[2] = UInt64(slice)
                        input[3] = UInt64(mPrime); input[4] = UInt64(t); input[5] = 2
                    }
                    func nextAddresses() {
                        input[6] &+= 1
                        g.fill(prev: zero, ref: input, next: address, xor: false)
                        g.fill(prev: zero, ref: address, next: address, xor: false)
                    }
                    var start = 0
                    if pass == 0 && slice == 0 {
                        start = 2
                        if independent { nextAddresses() }
                    }
                    for i in start..<segLen {
                        let col = slice * segLen + i
                        let prev = block(lane, col == 0 ? laneLen - 1 : col - 1)
                        let rand: UInt64
                        if independent {
                            if i % 128 == 0 { nextAddresses() }
                            rand = address[i % 128]
                        } else {
                            rand = prev[0]
                        }
                        let refLane = (pass == 0 && slice == 0) ? lane : Int((rand >> 32) % UInt64(p))
                        let same = refLane == lane
                        var area: Int
                        if pass == 0 {
                            if slice == 0 { area = i - 1 }
                            else if same { area = slice * segLen + i - 1 }
                            else { area = slice * segLen + (i == 0 ? -1 : 0) }
                        } else {
                            area = laneLen - segLen + (same ? i - 1 : (i == 0 ? -1 : 0))
                        }
                        var x = rand & 0xFFFF_FFFF
                        x = (x &* x) >> 32
                        let rel = UInt64(area) - 1 - ((UInt64(area) &* x) >> 32)
                        let startPos = pass != 0 ? (slice == 3 ? 0 : (slice + 1) * segLen) : 0
                        let refCol = (startPos + Int(rel)) % laneLen
                        g.fill(prev: prev, ref: block(refLane, refCol), next: block(lane, col), xor: pass != 0)
                    }
                }
            }
        }

        var c = [UInt64](repeating: 0, count: 128)
        for lane in 0..<p { let b = block(lane, laneLen - 1); for k in 0..<128 { c[k] ^= b[k] } }
        var cBytes: [UInt8] = []; cBytes.reserveCapacity(1024)
        for w in c { for s in 0..<8 { cBytes.append(UInt8(truncatingIfNeeded: w >> (8 * s))) } }
        wipe(&c)
        defer { wipe(&cBytes) }
        return hPrime(cBytes, params.tagLength)
    }

    // MARK: - pieces

    /// Overwrite with zeros in a way the optimiser must keep (C11 memset_s).
    static func wipe<T>(_ a: inout [T]) {
        a.withUnsafeMutableBytes { b in if let base = b.baseAddress { _ = memset_s(base, b.count, 0, b.count) } }
    }

    #if BENTO_WIPE_PROBE
    /// test builds only: sees each buffer after the wipe, before it's freed
    nonisolated(unsafe) static var probe: ((UnsafeMutablePointer<UInt64>, Int) -> Void)?
    #endif

    static func release(_ p: UnsafeMutablePointer<UInt64>, _ count: Int) {
        _ = memset_s(p, count * 8, 0, count * 8)
        #if BENTO_WIPE_PROBE
        probe?(p, count)
        #endif
        p.deinitialize(count: count)
        p.deallocate()
    }

    private static func le32(_ v: Int) -> [UInt8] { (0..<4).map { UInt8(truncatingIfNeeded: v >> (8 * $0)) } }

    private static func load(_ bytes: [UInt8], into b: UnsafeMutablePointer<UInt64>) {
        for k in 0..<128 {
            var w: UInt64 = 0
            for s in 0..<8 { w |= UInt64(bytes[8 * k + s]) << (8 * s) }
            b[k] = w
        }
    }

    /// RFC 9106 §3.3 H': a variable-length hash built from BLAKE2b
    static func hPrime(_ x: [UInt8], _ tau: Int) -> [UInt8] {
        var input = le32(tau) + x
        defer { wipe(&input) }
        if tau <= 64 { return Blake2b.hash(input, outLength: tau) }
        let r = (tau + 31) / 32 - 2
        var v = Blake2b.hash(input, outLength: 64)
        var out = Array(v[0..<32])
        for _ in 1..<r { var next = Blake2b.hash(v, outLength: 64); swap(&v, &next); wipe(&next); out += v[0..<32] }
        out += Blake2b.hash(v, outLength: tau - 32 * r)
        wipe(&v)
        return out
    }

    /// The compression function G over 1 KiB blocks, with its scratch space allocated once.
    private final class Compressor {
        let r = UnsafeMutablePointer<UInt64>.allocate(capacity: 128)
        let tmp = UnsafeMutablePointer<UInt64>.allocate(capacity: 128)
        init() { r.initialize(repeating: 0, count: 128); tmp.initialize(repeating: 0, count: 128) }
        func free() { Argon2id.release(r, 128); Argon2id.release(tmp, 128) }

        /// next = G(prev, ref), XORed into next's old value when `xor` (passes after the first)
        func fill(prev: UnsafeMutablePointer<UInt64>, ref: UnsafeMutablePointer<UInt64>,
                  next: UnsafeMutablePointer<UInt64>, xor: Bool) {
            for k in 0..<128 { r[k] = ref[k] ^ prev[k] }
            for k in 0..<128 { tmp[k] = xor ? r[k] ^ next[k] : r[k] }
            for i in 0..<8 {   // rows: 16 consecutive words
                let b = 16 * i
                round(b, b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7,
                      b + 8, b + 9, b + 10, b + 11, b + 12, b + 13, b + 14, b + 15)
            }
            for i in 0..<8 {   // columns: word pairs 2i, 2i+1 of each row
                let b = 2 * i
                round(b, b + 1, b + 16, b + 17, b + 32, b + 33, b + 48, b + 49,
                      b + 64, b + 65, b + 80, b + 81, b + 96, b + 97, b + 112, b + 113)
            }
            for k in 0..<128 { next[k] = tmp[k] ^ r[k] }
        }

        @inline(__always)
        private func round(_ v0: Int, _ v1: Int, _ v2: Int, _ v3: Int, _ v4: Int, _ v5: Int, _ v6: Int, _ v7: Int,
                           _ v8: Int, _ v9: Int, _ v10: Int, _ v11: Int, _ v12: Int, _ v13: Int, _ v14: Int, _ v15: Int) {
            gb(v0, v4, v8, v12); gb(v1, v5, v9, v13); gb(v2, v6, v10, v14); gb(v3, v7, v11, v15)
            gb(v0, v5, v10, v15); gb(v1, v6, v11, v12); gb(v2, v7, v8, v13); gb(v3, v4, v9, v14)
        }

        @inline(__always)
        private func gb(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
            @inline(__always) func mix(_ x: UInt64, _ y: UInt64) -> UInt64 {
                x &+ y &+ 2 &* ((x & 0xFFFF_FFFF) &* (y & 0xFFFF_FFFF))
            }
            @inline(__always) func rotr(_ x: UInt64, _ n: UInt64) -> UInt64 { (x >> n) | (x << (64 - n)) }
            r[a] = mix(r[a], r[b]); r[d] = rotr(r[d] ^ r[a], 32)
            r[c] = mix(r[c], r[d]); r[b] = rotr(r[b] ^ r[c], 24)
            r[a] = mix(r[a], r[b]); r[d] = rotr(r[d] ^ r[a], 16)
            r[c] = mix(r[c], r[d]); r[b] = rotr(r[b] ^ r[c], 63)
        }
    }
}

/// BLAKE2b (RFC 7693), unkeyed, one-shot: all Argon2 needs.
enum Blake2b {
    private static let iv: [UInt64] = [
        0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
        0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
    ]
    private static let sigma: [[Int]] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
        [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
        [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
        [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
        [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
        [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
        [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
        [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
        [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    ]

    static func hash(_ data: [UInt8], outLength: Int) -> [UInt8] {
        precondition(outLength >= 1 && outLength <= 64)
        var h = iv
        h[0] ^= 0x0101_0000 ^ UInt64(outLength)
        let blocks = max(1, (data.count + 127) / 128)
        var m = [UInt64](repeating: 0, count: 16)
        for bi in 0..<blocks {
            let last = bi == blocks - 1
            for k in 0..<16 {
                var w: UInt64 = 0
                for s in 0..<8 {
                    let idx = bi * 128 + 8 * k + s
                    if idx < data.count { w |= UInt64(data[idx]) << (8 * s) }
                }
                m[k] = w
            }
            let counted = last ? data.count : (bi + 1) * 128
            compress(&h, m, UInt64(counted), last)
        }
        var out: [UInt8] = []
        for w in h { for s in 0..<8 { out.append(UInt8(truncatingIfNeeded: w >> (8 * s))) } }
        return Array(out[0..<outLength])
    }

    private static func compress(_ h: inout [UInt64], _ m: [UInt64], _ t: UInt64, _ last: Bool) {
        var v = h + iv
        v[12] ^= t
        if last { v[14] = ~v[14] }
        @inline(__always) func rotr(_ x: UInt64, _ n: UInt64) -> UInt64 { (x >> n) | (x << (64 - n)) }
        func g(_ a: Int, _ b: Int, _ c: Int, _ d: Int, _ x: UInt64, _ y: UInt64) {
            v[a] = v[a] &+ v[b] &+ x; v[d] = rotr(v[d] ^ v[a], 32)
            v[c] = v[c] &+ v[d]; v[b] = rotr(v[b] ^ v[c], 24)
            v[a] = v[a] &+ v[b] &+ y; v[d] = rotr(v[d] ^ v[a], 16)
            v[c] = v[c] &+ v[d]; v[b] = rotr(v[b] ^ v[c], 63)
        }
        for round in 0..<12 {
            let s = sigma[round % 10]
            g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]])
            g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]])
            g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]])
            g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]])
        }
        for i in 0..<8 { h[i] ^= v[i] ^ v[i + 8] }
    }
}
