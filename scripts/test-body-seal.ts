#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The identity seal (identity-kernel §E): one "body is sealed" predicate, and a
// sealed body that every shell, frozen or new, reads as sealed.
//
//   node scripts/test-body-seal.ts
//
// WHY. Every plaintext-to-disk guard in the apps (recovery snapshots, version
// history, previews, the filename) asked isEncryptionActive(): "is there a
// PASSWORD". A document sealed to people rather than a password has none, so
// each of those guards would write it to IndexedDB, or into the file beside the
// ciphertext, in plaintext. isBodySealed() is the question they must ask.
//
// And the sealed body must be a GENUINE bento/enc v1 envelope. Frozen shells'
// parseEnvelope accepts only v1 with salt, iv and data. Anything else and an old
// shell boots the starter deck in its place, and its next save overwrites the
// sealed block: data loss.

import { configureApp } from '../kernel/src/app.ts'
import {
  setIdentitySeal, isBodySealed, isEncryptionActive, setEncryptionPassword, encodeDocBody,
  parseEnvelope, previewAllowed, openIdentitySealed, decryptEnvelope, suggestedFileName, capturePristine,
} from '../kernel/src/save.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

configureApp({ appId: 'bento-test', appName: 'Bento Test', manifestUrl: 'https://invalid.example/m.json' })
const TITLE = 'ZZ Secret Title ZZ'
const doc = { format: 'bento/test', docId: '00000000-0000-4000-8000-000000000000', title: TITLE, body: 'ZZSECRETBODYZZ' } as never
const kdoc = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const other = Uint8Array.from({ length: 32 }, (_, i) => 0xff - i)

console.log('\nbefore any seal: plaintext, as today')
ok(!isBodySealed() && !isEncryptionActive(), 'nothing is sealed')
{
  const body = await encodeDocBody(doc)
  ok(parseEnvelope(body) === null && body.includes('ZZSECRETBODYZZ'), 'the body is the plain document JSON')
  ok(suggestedFileName(doc).startsWith('ZZ_Secret_Title_ZZ'), 'the filename carries the title')
  ok(previewAllowed(body), 'a preview is allowed')
}

console.log('\nthe identity seal, with no password')
setIdentitySeal(kdoc)
ok(isBodySealed(), 'isBodySealed() is true')
ok(!isEncryptionActive(), 'isEncryptionActive() stays false: there is no password (the password UI is unchanged)')
{
  const body = await encodeDocBody(doc)
  const env = parseEnvelope(body)
  ok(env !== null, "the frozen shells' parseEnvelope accepts it (a genuine v1 envelope)")
  ok(env?.v === 1 && env?.format === 'bento/enc' && !!env.salt && !!env.iv && !!env.data, 'v1, with real salt, iv and data')
  ok(env?.kdf === 'hkdf-kdoc' && env?.it === undefined, "kdf: 'hkdf-kdoc', and no PBKDF2 rounds")
  ok(!body.includes('ZZSECRETBODYZZ') && !body.includes(TITLE), 'neither the body nor the title is in it')
  ok(!previewAllowed(body), 'no preview: the envelope vetoes it')
  ok(!previewAllowed('{"plain":true}'), "no preview even for a plain body while sealed (previewAllowed's default is isBodySealed)")
  ok(suggestedFileName(doc) === 'Bento_Test.bento.html', 'the filename is neutral (the app name)')
  ok(suggestedFileName(doc, 'copy') === 'Bento_Test-copy.bento.html', 'and with a suffix')

  // guarded, so a broken seal reports every row rather than crashing the rig
  const back = env ? await openIdentitySealed(env, kdoc) : null
  ok(back !== null && JSON.parse(back).body === 'ZZSECRETBODYZZ', 'the document key opens it to the document')
  ok(!!env && (await openIdentitySealed(env, other)) === null, 'another key does not')
  ok(!!env && (await decryptEnvelope(env, 'any password')) === null, 'no password opens it')
  ok(!!env && (await openIdentitySealed({ ...env, kdf: undefined }, kdoc)) === null, 'without its kdf marker it is not opened as identity-sealed')

  const again = parseEnvelope(await encodeDocBody(doc))
  ok(!!env && !!again && again.data !== env.data, 'two saves of the same document share no ciphertext')
  ok(!!env && !!again && again.salt !== env.salt && again.iv !== env.iv, 'every save draws a fresh salt and iv (a fresh body key)')
}

console.log('\nthe two paths refuse each other')
{
  setEncryptionPassword('correct horse')
  const pw = parseEnvelope(await encodeDocBody(doc))
  setEncryptionPassword(null)
  ok(!!pw && (await openIdentitySealed(pw, kdoc)) === null, 'a password envelope offered to the document key is refused')
  ok(!!pw && (await decryptEnvelope(pw, 'correct horse')) !== null, 'control: the password does open it')
}

console.log('\nsynchronous: sealed from the call, before the key import settles')
setIdentitySeal(null)
setIdentitySeal(kdoc)
ok(isBodySealed(), 'isBodySealed() is true in the same tick as setIdentitySeal()')
{
  const pending = encodeDocBody(doc)
  ok(parseEnvelope(await pending)?.kdf === 'hkdf-kdoc', 'a save started in that tick is sealed')
}

console.log('\na password set as well: the password path, unchanged')
setEncryptionPassword('correct horse')
{
  const env = parseEnvelope(await encodeDocBody(doc))!
  ok(isBodySealed() && isEncryptionActive(), 'both predicates are true')
  ok(env.kdf === undefined && typeof env.it === 'number', 'the body is a PBKDF2 envelope (the password wins, as today)')
  ok((await decryptEnvelope(env, 'correct horse')) !== null, 'and the password opens it')
}
setEncryptionPassword(null)

console.log('\nclearing the seal')
setIdentitySeal(null)
ok(!isBodySealed(), 'isBodySealed() is false again')
ok(parseEnvelope(await encodeDocBody(doc)) === null, 'saves are plaintext again')
let threw = false
try { setIdentitySeal(new Uint8Array(16)) } catch { threw = true }
ok(threw && !isBodySealed(), 'a document key that is not 32 bytes is refused, and seals nothing')

console.log('\nthe host is told the seal state (security §30.6), on every change, before any save')
{
  const posts: unknown[] = []
  const g = globalThis as Record<string, unknown>
  g.window = { postMessage: (m: unknown) => posts.push(m) }
  g.document = { cloneNode: () => ({}) }
  const last = () => (posts.at(-1) as { payload?: { sealed?: unknown } } | undefined)?.payload?.sealed
  // a host that does NOT declare 'seal' hears nothing
  g.__bentoHost = { ops: ['store'] }
  setEncryptionPassword('x'); setEncryptionPassword(null)
  ok(posts.length === 0, "a host without 'seal' is sent nothing")
  g.__bentoHost = { ops: ['store', 'seal'] }
  capturePristine()
  ok(posts.length === 1 && last() === false, 'boot: sealed=false for a plain document')
  setEncryptionPassword('correct horse')
  ok(last() === true, 'a password SET (not yet saved): sealed=true, at once')
  setEncryptionPassword(null)
  ok(last() === false, 'the password removed: sealed=false')
  setIdentitySeal(kdoc)
  ok(last() === true, 'the identity seal on: sealed=true')
  setIdentitySeal(null)
  ok(last() === false, 'the identity seal off: sealed=false')
  const m = posts[1] as Record<string, unknown> & { payload: Record<string, unknown> }
  ok(m.__bento_tray__ === true && m.dir === 'req' && m.op === 'seal.state' && typeof m.payload.sealed === 'boolean' && Object.keys(m.payload).length === 1,
    "the message is the relay's shape, and the payload a bare boolean")
  setEncryptionPassword('a'); setEncryptionPassword('b')
  ok(posts.length === 7, 'not deduplicated: an unchanged state is posted again (a missed true is the only failure)')
  setEncryptionPassword(null)
  delete g.window; delete g.document; delete g.__bentoHost
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
