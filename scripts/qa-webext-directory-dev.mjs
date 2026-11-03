#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext — the directory client against a LOCAL directory over real HTTP (manual).
//
//   WRANGLER=/path/to/wrangler node scripts/qa-webext-directory-dev.mjs
//
// scripts/test-webext-directory.ts drives the same client against the worker in
// memory (that one runs in CI). This one starts `wrangler dev` on server/directory
// with a throwaway signing key, a log mailer and an empty state directory, then
// runs the extension's own bindStart/bindComplete across the network: the mailed
// code is read from the worker's dev log, exactly as a person would read an inbox.
// Needs wrangler (`npm i wrangler` in a scratch dir; no wrangler is a dependency here).

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argon2 as nodeArgon2 } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const agent = await import(join(root, 'home/webext/src/id/agent.js'))
const dc = await import(join(root, 'home/webext/src/id/directory.js'))
const ks = await import(join(root, 'home/webext/src/id/keystore.js'))
const st = await import(join(root, 'home/webext/src/id/gen/statements.js'))

let failures = 0
const ok = (c, m) => { if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const argon2id = (p, s) => new Promise((res, rej) => nodeArgon2('argon2id', { message: p, nonce: s, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 }, (e, k) => (e ? rej(e) : res(new Uint8Array(k)))))

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
const dirPub = st.b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
const port = 8700 + Math.floor(Math.random() * 200)
const wr = process.env.WRANGLER ?? 'wrangler'
const child = spawn(wr, ['dev', '--port', String(port), '--persist-to', mkdtempSync(join(tmpdir(), 'dir-state-')), '--var', 'DEV:1', '--var', 'MAILER:log', '--var', 'DIR_KID:dev-1', '--var', `DIR_KEY_JWK:${JSON.stringify(jwk)}`], { cwd: join(root, 'server/directory'), stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { log += d })
const stop = () => { child.kill('SIGTERM') }
process.on('exit', stop)
const t0 = Date.now()
while (!/Ready on/.test(log)) {
  if (Date.now() - t0 > 60000 || child.exitCode !== null) { console.error('FAIL: wrangler dev did not start:\n' + log.slice(-800)); process.exit(2) }
  await new Promise((r) => setTimeout(r, 200))
}
const codeFor = async (to) => {
  for (let i = 0; i < 50; i++) {
    const hits = [...log.matchAll(/\{"devmail":(\{.*?\})\}/g)].map((m) => JSON.parse(m[1])).filter((m) => m.to === to)
    const last = hits.at(-1)
    if (last) return /\b([2-9A-HJKMNP-Z]{8})\b/.exec(last.body.split('\n').find((l) => /[2-9A-HJKMNP-Z]{8}/.test(l)) ?? '')?.[1]
    await new Promise((r) => setTimeout(r, 100))
  }
}
const base = `http://localhost:${port}`
const deps = { fetch: (u, i) => fetch(u, i), now: () => Date.now(), directoryKeys: { 'dev-1': dirPub }, base }

const { record } = await agent.createBentoId({ label: 'qa' }, { subtle: crypto.subtle, rand: (n) => crypto.getRandomValues(new Uint8Array(n)), now: () => Date.now(), argon2id,
  passkey: async () => ({ credentialId: crypto.getRandomValues(new Uint8Array(32)), prfOutput: crypto.getRandomValues(new Uint8Array(32)) }) })
const { pending } = await dc.bindStart({ record, email: 'qa@example.com' }, deps)
const code = await codeFor('qa@example.com')
ok(!!code, `the worker mailed a code (read from its dev log): ${code ? code.slice(0, 2) + '******' : 'none'}`)
ok((await dc.bindComplete({ record, pending, code: 'AAAAAAAA' }, deps)).reason === 'rejected', 'a wrong code is refused over HTTP')
const done = await dc.bindComplete({ record, pending, code }, deps)
ok(done.ok === true, `the right code completes it; kernel verifyBind + verifyAtt passed against the dev key (${done.reason ?? done.bound.att.kid})`)
const lk = await (await fetch(`${base}/v1/lookup?e=qa@example.com`)).json()
ok(lk.binding === pending.text, 'a lookup over HTTP returns the binding we signed')
const nothing = await fetch(`${base}/v1/lookup?e=nobody@example.com`)
ok(nothing.status === 404, 'an unknown address is 404')
stop()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
