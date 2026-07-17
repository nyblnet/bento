#!/usr/bin/env node
// One-time: generate the Bento release signing keypair (ECDSA P-256).
//
//   node scripts/keygen.mjs [key-file]
//
// The PRIVATE key is written to ~/.bento/release-key.json (chmod 600) —
// it must never enter the repository or any CI secret store; releases are
// signed locally with scripts/sign-release.mjs. The PUBLIC key is printed
// for embedding in slides/src/update.ts (PUBLIC_KEY_JWK). Every shipped
// Bento file verifies update manifests against that embedded public key,
// so a compromised release host cannot push code without this private key.

import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const keyPath = process.argv[2] ?? join(homedir(), '.bento', 'release-key.json')
if (existsSync(keyPath)) {
  console.error(`Refusing to overwrite existing key at ${keyPath}`)
  console.error('If you really mean to rotate keys, move the old file away first —')
  console.error('files already shipped only trust the OLD public key.')
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const priv = privateKey.export({ format: 'jwk' })
const pub = publicKey.export({ format: 'jwk' })

mkdirSync(dirname(keyPath), { recursive: true })
writeFileSync(keyPath, JSON.stringify({ kind: 'bento-release-key', private: priv, public: pub }, null, 2) + '\n')
chmodSync(keyPath, 0o600)

console.log(`Private key written to ${keyPath} (keep offline, never commit).`)
console.log('\nEmbed this public key as PUBLIC_KEY_JWK in slides/src/update.ts:\n')
console.log(JSON.stringify(pub, null, 2))
