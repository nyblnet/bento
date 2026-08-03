#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Language-pack verification rig.
//
//   node scripts/test-packs.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Packs are fetched from the network, so the only thing
// standing between a hostile (or merely broken) release channel and the
// strings in someone's UI is the chain in slides/src/packs.ts:
//
//     embedded release key  ->  signs the index
//     index                 ->  pins each pack's sha256
//     pinned sha256         ->  the bytes we accept
//
// Break any link and the pack must be REFUSED, not used. Each case below
// breaks exactly one link and asserts the refusal, plus a good-path case so
// the suite cannot pass by refusing everything.
//
// THE KEY. Verification runs against the real PUBLIC_KEY_JWK baked into
// kernel/src/update.ts, whose private half lives offline with the maintainer
// and is never available here (nor should it be). So the harness swaps the
// TRUST ROOT for a throwaway keypair generated in-process — crypto.subtle
// .importKey hands back the test public key instead of the shipped one. That
// is the only substitution: the envelope parsing, the real WebCrypto ECDSA
// verify, the hashing and every decision in packs.ts are the shipped code.

import { webcrypto } from 'node:crypto'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

const subtle = webcrypto.subtle
const enc = new TextEncoder()

// --- the throwaway release key ---------------------------------------------
const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const testPubJwk = await subtle.exportKey('jwk', keys.publicKey)

const sign = async (payload: string): Promise<string> =>
  Buffer.from(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc.encode(payload)),
  ).toString('base64')

/** A signed envelope, exactly as sign-release.mjs emits one. */
const envelope = async (value: unknown): Promise<string> => {
  const payload = JSON.stringify(value)
  return JSON.stringify({ payload, sig: await sign(payload) })
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

// --- browser globals the module graph expects -------------------------------
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
})

// Swap ONLY the trust root: any EC JWK import (there is exactly one call site,
// verifySigned's) resolves to the test public key. Everything else passes
// through to real WebCrypto.
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    ...webcrypto,
    subtle: {
      digest: subtle.digest.bind(subtle),
      verify: subtle.verify.bind(subtle),
      importKey: (fmt: string, data: any, algo: any, ext: boolean, usages: string[]) =>
        subtle.importKey(
          fmt as 'jwk',
          fmt === 'jwk' && data?.kty === 'EC' ? testPubJwk : data,
          algo,
          ext,
          usages as any,
        ),
    },
  },
})

// --- the channel ------------------------------------------------------------
const CHANNEL = 'https://bento.page/releases/slides'
const PACK_URL = 'packs/bento-slides-1.0.0-xx.pack.json'

const pack = {
  app: 'slides',
  version: '1.0.0',
  lang: 'xx',
  label: 'Testish',
  strings: { Delete: 'Deletish', Close: 'Closish' },
}
const packBytes = enc.encode(JSON.stringify(pack))
const packHash = await sha256Hex(packBytes)

/** The bytes an attacker would rather we ran. */
const evilPack = { ...pack, strings: { Delete: 'PWNED', Close: 'PWNED' } }
const evilBytes = enc.encode(JSON.stringify(evilPack))

/** What the fake channel currently serves; each case rewrites these. */
let servedIndex: string | null = null
let servedPack: Uint8Array | null = packBytes

const res = (body: Uint8Array | string, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
  arrayBuffer: async () =>
    typeof body === 'string' ? enc.encode(body).buffer : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
})

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async (url: string, init?: { method?: string }) => {
    if (url === `${CHANNEL}/packs.json`) return servedIndex === null ? res('', 404) : res(servedIndex)
    if (url === `${CHANNEL}/${PACK_URL}`) {
      if (servedPack === null) return res('', 404)
      // HEAD is the reachability probe packs.ts makes on the failure path.
      return init?.method === 'HEAD' ? res('') : res(servedPack)
    }
    return res('', 404)
  },
})

// Imported AFTER the globals exist — module scope must find them in place.
const { configureApp } = await import('../kernel/src/app.ts')
configureApp({
  appId: 'bento-slides',
  appName: 'bento/slides',
  manifestUrl: `${CHANNEL}/manifest.json`,
})
const packs = await import('../slides/src/packs.ts')

/** The index payload shape scripts/sign-packs.mjs publishes. */
const index = async (listings: unknown[], app = 'bento-slides') =>
  envelope({ app, version: '1.0.0', at: new Date().toISOString(), packs: listings })

const listing = (sha256 = packHash, version = '1.0.0') => ({
  lang: 'xx', label: 'Testish', version, url: PACK_URL, sha256, bytes: packBytes.length,
})
const goodIndex = async (sha256 = packHash) => index([listing(sha256)])

// --- 1. the good path -------------------------------------------------------
console.log('\nsigned index, matching hash')
servedIndex = await goodIndex()
servedPack = packBytes
let listed = await packs.availablePacks()
ok(listed.length === 1 && listed[0].lang === 'xx', 'a signed listing is offered')
let got = await packs.fetchPack(listed[0])
ok(typeof got !== 'string' && got.lang === 'xx', 'a pack matching its pinned hash is accepted')
ok(typeof got !== 'string' && got.strings.Delete === 'Deletish', 'and it is the pack we asked for')

// --- 2. tampered pack, untouched index -------------------------------------
// The channel (or anyone between it and us) swaps the pack bytes but cannot
// re-sign the index that pins them.
console.log('\ntampered pack bytes')
servedPack = evilBytes
got = await packs.fetchPack(listed[0])
ok(got === 'unverified', 'a pack whose bytes do not match the pinned hash is REFUSED')
ok(got !== 'offline', 'and it is reported as a failed check, not as a network problem')

// --- 3. tampered index ------------------------------------------------------
// The forger also rewrites the index to pin the forged pack's hash — which is
// the only way to make case 2 pass — and the signature no longer verifies.
console.log('\ntampered index (hash re-pinned to the forged pack)')
servedPack = evilBytes
const forgedHash = await sha256Hex(evilBytes)
const honest = JSON.parse(await goodIndex())
const forged = JSON.stringify({
  payload: JSON.parse(await index([listing(forgedHash)])).payload,
  sig: honest.sig, // the old signature, over the old payload
})
servedIndex = forged
ok((await packs.availablePacks()).length === 0, 'an index whose signature fails offers NOTHING')

// --- 4. unsigned index ------------------------------------------------------
console.log('\nunsigned index')
servedIndex = JSON.stringify({ app: 'bento-slides', version: '1.0.0', packs: [listing()] })
ok((await packs.availablePacks()).length === 0, 'a bare (unsigned) payload is refused — fail closed')
servedIndex = await index([{ lang: 'xx', label: 'Testish', url: PACK_URL }])
ok((await packs.availablePacks()).length === 0, 'a signed listing with NO pinned hash is not offered')

// --- 4b. an index signed for another app ------------------------------------
// The release key is platform-wide, so a validly signed bento/spaces index is
// a real thing an attacker could replay onto this channel. The app id is what
// stops it — same check verifyManifest makes on the release manifest.
console.log('\nindex signed for a different app')
servedIndex = await index([listing()], 'bento-spaces')
ok((await packs.availablePacks()).length === 0, 'a validly signed index for ANOTHER app offers nothing')
servedIndex = await envelope([listing()])
ok((await packs.availablePacks()).length === 0, 'a bare array payload (no app id) offers nothing')

// --- 5. no pin at the fetch itself -----------------------------------------
console.log('\nlisting with no usable pin, handed straight to fetchPack')
ok(
  (await packs.fetchPack({ lang: 'xx', label: 'Testish', url: PACK_URL, sha256: '' } as any)) === 'unverified',
  'fetchPack refuses an unpinned listing without even downloading',
)
ok(
  (await packs.fetchPack({ lang: 'xx', label: 'Testish', url: PACK_URL, sha256: 'nonsense' } as any)) === 'unverified',
  'and refuses a malformed pin',
)

// --- 6. offline is still offline -------------------------------------------
console.log('\nunreachable pack')
servedIndex = await goodIndex()
servedPack = null
ok((await packs.fetchPack((await packs.availablePacks())[0])) === 'offline', 'a missing download is reported as offline, not as tampering')

// --- 7. refresh keeps a verified pack when the new one fails ---------------
// The update flow's rule: degraded beats absent. A pack already in the file
// was verified when it was added, so a refresh that cannot be verified must
// leave it exactly where it is — and must never write the unverified bytes.
console.log('\nrefresh with a tampered pack on the channel')
servedIndex = await goodIndex()
servedPack = packBytes
const fresh = await packs.fetchPack((await packs.availablePacks())[0])
ok(typeof fresh !== 'string' && packs.stageForFile(fresh), 'stage the verified pack into the file')
servedPack = evilBytes // channel turns hostile between install and update
servedIndex = await index([listing(packHash, '1.0.1')])
const out = await packs.refreshPacksForVersion('1.0.1')
ok(out.kept.includes('xx') && !out.refreshed.includes('xx'), 'the pack is KEPT, not refreshed')
const inFile = packs.packsInFile().find((p) => p.lang === 'xx')
ok(inFile?.version === '1.0.0', 'the file still holds the version that was verified')
ok(
  JSON.stringify(inFile?.strings) === JSON.stringify(pack.strings),
  'and the forged strings never reached the file',
)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
