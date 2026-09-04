#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext release-trust rig.
//
//   node scripts/test-webext-release.ts
//
// WHAT THIS PROVES. Creating a document downloads an app shell and writes it to
// the user's disk, where they will later double-click it. That is executable
// HTML, so the download has to be earned: the manifest's signature against the
// key compiled into the extension, then the shell's sha256 against the digest
// that signature covers. Signature over the pin, pin over the bytes. Neither
// half alone is worth anything — a signature with no pin verifies a description
// of a build, and a pin with no signature is a digest chosen by whoever served
// the bytes.
//
// WHY IT EXISTS AT ALL. `newDocument` read `manifest.url` off the top level of
// the envelope, where there is no `url`. It threw "the release server did not
// offer a build" every single time: the `+` button had never worked, in any
// version, and nothing said so. The rig agreed with the bug, because its
// fixture was written to the shape the CODE expected — `{version, url}` flat —
// rather than the shape the SERVER sends. A self-consistent fixture proves the
// code agrees with itself.
//
// So the load-bearing check here is not a hand-written envelope: it is
// `scripts/fixtures/release-manifest-slides.json`, captured verbatim from
// https://bento.page/releases/slides/manifest.json, verified against the
// SHIPPED public key with no test seam in the path. If the envelope format
// moves, or the embedded key drifts from the kernel's, that fixture stops
// verifying here instead of the `+` button stopping working out there.
//
// This matters more than it did. Starter shells are bundled in NO host as of
// 2026-08-16 (they change too often, and there are three apps with more
// coming), so fetch-and-verify is the ONLY way a new document gets created —
// here, in home/android, and in home/ios.

import { readFileSync } from 'node:fs'
import {
  RELEASE_KEY, verifySigned, verifyManifest, fetchPinned,
} from '../home/webext/src/release.js'
import { newDocument, APPS } from '../home/webext/src/library.js'
import { releaseSigner, sha256Hex, realManifest } from './lib/release-sign.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const threw = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return '' } catch (e: any) { return e?.message ?? 'threw' }
}

// ---- 1. the envelope, as the server actually sends it -----------------------
// THE REGRESSION. Every assertion in this block would have failed the code that
// shipped, and none of them needs a key or a network.
{
  const raw = realManifest()
  const envelope = JSON.parse(raw)
  ok(Object.keys(envelope).sort().join(',') === 'payload,sig',
    `a manifest is exactly {payload, sig} (${Object.keys(envelope).join(', ')})`)
  ok(typeof envelope.payload === 'string',
    'and the payload is a STRING — the signature covers its exact bytes, so it '
    + 'cannot travel as an object without making the check depend on key order')
  ok(envelope.url === undefined && envelope.version === undefined && envelope.sha256 === undefined,
    'there is NO url, version or sha256 at the top level — reading one is the bug this rig exists for')

  const info = JSON.parse(envelope.payload)
  ok(info.app === 'bento-slides' && typeof info.version === 'string',
    `the fields live inside the payload (${info.app} ${info.version})`)
  ok(/^[0-9a-f]{64}$/.test(info.sha256), 'and the payload pins the shell it describes')
}
{
  // No seam: the captured manifest against the compiled-in key.
  const info = await verifySigned(realManifest(), 'release manifest') as any
  ok(info.app === 'bento-slides',
    'a REAL manifest verifies against the shipped public key — which proves the '
    + 'key is right and the envelope format has not moved')
}
{
  // A valid signature under a key we do not trust — and NO test seam: the REAL
  // payload, re-signed with a throwaway key, handed to the shipped verifier
  // using the SHIPPED key. It must refuse.
  //
  // Distinct from bending a signature, which any bug-free crypto call rejects.
  // This one validates perfectly; it is simply not ours. It is what catches a
  // verifier that imported the wrong key, or one that would trust a key
  // travelling in the envelope alongside the signature — a verifier like that
  // passes every tampering test ever written. (home/ios's construction, from
  // PR #315; it is better than the seam-based version I had.)
  const real = JSON.parse(realManifest())
  const impostor = await releaseSigner()
  const forged = JSON.parse(await impostor.envelope(JSON.parse(real.payload)))
  ok(forged.payload === real.payload, 'the impostor signs the genuine payload, byte for byte')
  const msg = await threw(() => verifySigned(JSON.stringify(forged), 'release manifest'))
  ok(/INVALID/.test(msg),
    `a real payload re-signed by another key is refused against the shipped key (${msg})`)
}
{
  // Mirrored code has one failure mode: drift. Pin both ends.
  const kernel = readFileSync(new URL('../kernel/src/update.ts', import.meta.url), 'utf8')
  // From the declaration onward, and `\b` on the coordinate names — `kty: 'EC'`
  // ends in `y:` and matches a lazy pattern, which reads as a key mismatch.
  const block = kernel.slice(kernel.indexOf('PUBLIC_KEY_JWK'))
  const x = block.match(/\bx:\s*'([A-Za-z0-9_-]+)'/)?.[1]
  const y = block.match(/\by:\s*'([A-Za-z0-9_-]+)'/)?.[1]
  ok(!!x && x === RELEASE_KEY.x && y === RELEASE_KEY.y,
    "the extension's key is byte-identical to the kernel's — the extension mirrors "
    + 'kernel/src/update.ts because it cannot import it, and a mirror drifts silently')
}

// ---- 2. what verification refuses -------------------------------------------
const signer = await releaseSigner()
const SHELL = '<html><!-- a real app shell would be 560KB --></html>'
const shellBytes = new TextEncoder().encode(SHELL)
const shellHash = await sha256Hex(shellBytes)
const payloadFor = (over: Record<string, unknown> = {}) => ({
  app: 'bento-slides',
  version: '1.0.18',
  sha256: shellHash,
  url: 'https://bento.page/releases/slides/Bento_Slides.bento.html',
  ...over,
})

{
  const raw = await signer.envelope(payloadFor())
  const info = await verifyManifest(raw, 'bento-slides', signer.jwk) as any
  ok(info.version === '1.0.18', 'a well-signed manifest verifies and yields its payload')
}
{
  const raw = await signer.envelope(payloadFor())
  const e = JSON.parse(raw)
  // One character, in the URL — the whole point of signing.
  e.payload = e.payload.replace('bento.page', 'bento.pagd')
  const msg = await threw(() => verifyManifest(JSON.stringify(e), 'bento-slides', signer.jwk))
  ok(/INVALID/.test(msg), `an edited payload is refused (${msg})`)
}
{
  const raw = await signer.envelope(payloadFor())
  const other = await releaseSigner()
  const msg = await threw(() => verifyManifest(raw, 'bento-slides', other.jwk))
  ok(/INVALID/.test(msg),
    `a manifest signed by somebody else is refused — a signature only means something against OUR key (${msg})`)
}
{
  // The shape the broken code believed in. It must not merely fail to find a
  // url: it must be refused for being unsigned.
  const msg = await threw(() => verifyManifest(
    JSON.stringify({ version: '9.9.9', url: 'https://evil.example/x.html', sha256: shellHash }),
    'bento-slides', signer.jwk))
  ok(/not signed/.test(msg), `an unsigned flat manifest is refused outright (${msg})`)
}
{
  // A 404 page, a captive portal, a proxy's error — HTML where JSON was asked for.
  const msg = await threw(() => verifyManifest('<!DOCTYPE html><title>404</title>', 'bento-slides', signer.jwk))
  ok(/not valid JSON/.test(msg), `a page of HTML is reported, not parsed hopefully (${msg})`)
}
{
  // The channels are sibling paths on ONE origin, so a genuine manifest served
  // from the wrong one would hand somebody a different application.
  const raw = await signer.envelope(payloadFor())
  const msg = await threw(() => verifyManifest(raw, 'bento-spaces', signer.jwk))
  ok(/malformed/.test(msg),
    `a correctly signed manifest for ANOTHER app is refused on the wrong channel (${msg})`)
}
{
  // An ABSENT app must not read as a match. `undefined !== 'bento-slides'` gets
  // this right, but only by construction — a later refactor to something like
  // `info.app && info.app !== appId` would turn a missing field into a pass,
  // and no other check would notice: signature and digest are both happy.
  // (home/ios raised this on PR #315; the same case, from the other direction.)
  const raw = await signer.envelope({
    version: '1.0.18', sha256: shellHash, url: 'https://bento.page/x.bento.html',
  })
  const msg = await threw(() => verifyManifest(raw, 'bento-slides', signer.jwk))
  ok(/malformed/.test(msg), `a payload naming no app at all is refused (${msg})`)
}
{
  const raw = await signer.envelope(payloadFor({ sha256: 'not-a-digest' }))
  const msg = await threw(() => verifyManifest(raw, 'bento-slides', signer.jwk))
  ok(/malformed/.test(msg), `a payload that pins nothing is refused (${msg})`)
}

// ---- 3. the pin, over the bytes ---------------------------------------------
const netFor = (body: string, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  async arrayBuffer() { return new TextEncoder().encode(body).buffer },
  async text() { return body },
})
{
  const bytes = await fetchPinned(netFor(SHELL), 'https://x/shell.html', shellHash)
  ok(new TextDecoder().decode(bytes) === SHELL, 'bytes matching the signed digest come back')
}
{
  const msg = await threw(() => fetchPinned(netFor(SHELL + '<script>evil()</script>'), 'https://x/s.html', shellHash))
  ok(/does not match the signed release/.test(msg),
    `bytes that do not hash to the pin are refused — this is the half that catches a swapped download (${msg})`)
}
{
  const msg = await threw(() => fetchPinned(netFor('', 404), 'https://x/s.html', shellHash))
  ok(/could not download/.test(msg), `a missing shell is reported (${msg})`)
}
{
  const msg = await threw(() => fetchPinned(netFor(SHELL), 'https://x/s.html', ''))
  ok(/not pinned/.test(msg), 'an unpinned release is refused rather than fetched and hoped over')
}
{
  // The header is load-bearing, and its absence is silent. Measured 2026-08-17:
  // the live release URL serves 689,675 bytes to a browser-shaped Accept and
  // 689,316 — the signed ones — to the wildcard, the difference being an
  // analytics beacon the edge injects into anything it reads as a page. Asking
  // for a page here would mean the digest check refuses every real download.
  const seen: any[] = []
  const net = async (_u: string, init: any) => {
    seen.push(init)
    return { ok: true, status: 200, async arrayBuffer() { return new TextEncoder().encode(SHELL).buffer } }
  }
  await fetchPinned(net, 'https://x/s.html', shellHash)
  ok(seen[0]?.headers?.Accept === '*/*',
    `the shell is fetched asking for BYTES, not for a page (${JSON.stringify(seen[0]?.headers)})`)
  ok(seen[0]?.cache === 'no-store', 'and uncached — a stale shell is a stale document')
}
{
  // Hex case is a presentation choice, not a difference.
  const bytes = await fetchPinned(netFor(SHELL), 'https://x/s.html', shellHash.toUpperCase())
  ok(bytes.byteLength > 0, 'a digest written in upper case still matches')
}

// ---- 4. end to end, through newDocument -------------------------------------
// A fake directory that records what was actually written, because the only
// failure that matters is unverified bytes reaching a file handle.
const written = new Map<string, string>()
const dirHandle = () => {
  const tree = new Set<string>()
  return {
    kind: 'directory' as const,
    name: 'Decks',
    written,
    async getFileHandle(n: string, opts?: { create?: boolean }) {
      if (!tree.has(n) && !opts?.create) throw Object.assign(new Error(n), { name: 'NotFoundError' })
      tree.add(n)
      return {
        kind: 'file' as const,
        name: n,
        async createWritable() {
          return {
            async write(chunk: any) {
              written.set(n, typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
            },
            async close() {},
          }
        },
      }
    },
  }
}

/** A release channel that answers both requests: manifest, then shell. */
const channel = (manifestRaw: string, shell = SHELL, shellStatus = 200) => async (url: string) =>
  url.endsWith('manifest.json')
    ? { ok: true, status: 200, async text() { return manifestRaw } }
    : {
        ok: shellStatus >= 200 && shellStatus < 300,
        status: shellStatus,
        async arrayBuffer() { return new TextEncoder().encode(shell).buffer },
      }

{
  written.clear()
  const good = channel(await signer.envelope(payloadFor()))
  const made = await newDocument(dirHandle() as any, 'Untitled', { fetch: good, jwk: signer.jwk })
  ok(made.name === 'Untitled.bento.html' && made.version === '1.0.18',
    `a verified release is written, and reports the version it wrote (${made.version})`)
  ok(written.get('Untitled.bento.html') === SHELL,
    'and the file holds the downloaded shell — the whole feature, which had never once run')
}
{
  // The bug, exactly: the envelope, read by code that wants a flat manifest.
  // Kept as a standing check that nobody "simplifies" the parse back.
  written.clear()
  const flat = JSON.stringify({ version: '1.0.18', url: 'https://bento.page/x.html', sha256: shellHash })
  const msg = await threw(() => newDocument(dirHandle() as any, 'Untitled', {
    fetch: channel(flat), jwk: signer.jwk,
  }))
  ok(/not signed/.test(msg), `an unsigned manifest stops the whole thing (${msg})`)
  ok(written.size === 0, 'and NOTHING is written — a half-created document is a document the user will open')
}
{
  written.clear()
  const swapped = channel(await signer.envelope(payloadFor()), '<html>swapped payload</html>')
  const msg = await threw(() => newDocument(dirHandle() as any, 'Untitled', {
    fetch: swapped, jwk: signer.jwk,
  }))
  ok(/does not match the signed release/.test(msg),
    `a shell that is not the signed one is refused (${msg})`)
  ok(written.size === 0,
    'and nothing lands on disk — the file would be executable HTML the user goes on to trust')
}
{
  written.clear()
  const other = await releaseSigner()
  const forged = channel(await other.envelope(payloadFor()))
  const msg = await threw(() => newDocument(dirHandle() as any, 'Untitled', {
    fetch: forged, jwk: signer.jwk,
  }))
  ok(/INVALID/.test(msg) && written.size === 0,
    'a manifest from the wrong key writes nothing — a network attacker cannot choose what the user creates')
}
{
  // Spaces and Dash have no published release yet: the channel 404s. The user
  // asked for a document and must be told why they have not got one.
  written.clear()
  const msg = await threw(() => newDocument(dirHandle() as any, 'Untitled', {
    app: 'spaces', jwk: signer.jwk,
    fetch: async () => ({ ok: false, status: 404, async text() { return '<html>404</html>' } }),
  }))
  ok(/Spaces has not been released yet/.test(msg),
    `an unpublished channel says so, rather than reporting a parse failure (${msg})`)
}
// ---- 5. no downgrades -------------------------------------------------------
// A replayed OLD release passes every other check in this file: genuinely
// signed, right app, and its shell really does hash to its pin. Every byte
// authentic, just last month's — which is exactly what survives an origin or
// CDN compromise where the attacker can re-serve but cannot forge. A document
// carries no version to be monotonic against, unlike the shell's own update, so
// the host has to remember. Semantics mirrored from home/ios (PR #315).
const floorStore = (initial: string | null = null) => {
  const box = { value: initial, writes: 0 }
  return {
    box,
    getFloor: async () => box.value,
    putFloor: async (v: string) => { box.value = v; box.writes++ },
  }
}
{
  written.clear()
  const store = floorStore('1.0.18')
  const chan = channel(await signer.envelope(payloadFor({ version: '1.0.9' })))
  const msg = await threw(() => newDocument(dirHandle() as any, 'Untitled',
    { fetch: chan, jwk: signer.jwk, ...store }))
  ok(/older than the 1\.0\.18/.test(msg), `a signed but OLDER release is refused (${msg})`)
  ok(written.size === 0, 'and nothing is written — the replay does not become a document')
}
{
  written.clear()
  const store = floorStore('1.0.18')
  const chan = channel(await signer.envelope(payloadFor({ version: '1.0.18' })))
  const made = await newDocument(dirHandle() as any, 'Untitled',
    { fetch: chan, jwk: signer.jwk, ...store })
  ok(made.version === '1.0.18' && written.size === 1,
    'the SAME version is accepted — re-fetching what you already have is the normal '
    + 'case, and refusing it would break the + button on its second use')
  ok(store.box.writes === 0, 'and the floor is not rewritten when it has not moved')
}
{
  written.clear()
  const store = floorStore('1.0.9')
  const chan = channel(await signer.envelope(payloadFor({ version: '1.0.18' })))
  await newDocument(dirHandle() as any, 'Untitled', { fetch: chan, jwk: signer.jwk, ...store })
  ok(store.box.value === '1.0.18', `a newer release raises the floor (${store.box.value})`)
}
{
  // THE DENIAL-OF-SERVICE CASE. A manifest that verifies but whose shell fails
  // its digest must NOT raise the floor: otherwise one forged-but-unfetchable
  // release locks this browser out of every real release below it, and a failed
  // attack becomes a permanent one.
  written.clear()
  const store = floorStore('1.0.9')
  const chan = channel(await signer.envelope(payloadFor({ version: '9.9.9' })), '<html>not the signed bytes</html>')
  const msg = await threw(() => newDocument(dirHandle() as any, 'Untitled',
    { fetch: chan, jwk: signer.jwk, ...store }))
  ok(/does not match the signed release/.test(msg), `the swapped shell is refused (${msg})`)
  ok(store.box.value === '1.0.9',
    `and the floor stays at ${store.box.value} — a failed attack must not become a lasting one`)
}
{
  // An unreadable store reads as NO floor. Availability over protection, in a
  // case that is not an attack: private mode, quota, a migration mid-flight.
  written.clear()
  const chan = channel(await signer.envelope(payloadFor()))
  const made = await newDocument(dirHandle() as any, 'Untitled', {
    fetch: chan, jwk: signer.jwk,
    getFloor: async () => { throw new Error('private mode') },
    putFloor: async () => { throw new Error('private mode') },
  })
  ok(made.version === '1.0.18' && written.size === 1,
    'a store that cannot be read or written still creates the document')
}
{
  // A strange version string must be able to fail to RAISE the floor, never to
  // block a release. `Number('x')` is NaN and `NaN || 0` is 0, so it sorts as
  // zero rather than throwing — the same behaviour as kernel/src/update.ts and
  // home/ios, verified rather than assumed.
  written.clear()
  const store = floorStore('1.0.x')
  const chan = channel(await signer.envelope(payloadFor({ version: '1.0.18' })))
  const made = await newDocument(dirHandle() as any, 'Untitled',
    { fetch: chan, jwk: signer.jwk, ...store })
  ok(made.version === '1.0.18', 'an unparsable stored floor does not block a real release')
}

// ---- 6. the app family ------------------------------------------------------
{
  // Every app must name itself, or its channel silently skips the app check.
  ok(APPS.every((a: any) => /^bento-[a-z]+$/.test(a.appId)),
    `every app declares the appId its manifest is signed for (${APPS.map((a: any) => a.appId).join(', ')})`)
  ok(APPS.every((a: any) => a.manifest.includes(`/${a.id}/`)),
    'and each points at its own release channel')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
