// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Unit assertions for auth.ts's crypto/session logic, written in TS so it
// can import auth.ts directly. Bundled + run as a plain Node process by
// auth.test.mjs — same pattern as compile.spec.ts/compile.test.mjs.
import {
  createConfig,
  verifyPassword,
  createSession,
  touchSession,
  deleteSession,
  PASSWORD_ITERATIONS,
} from '../src/auth.ts'
import type { Env } from '../src/env.ts'

let failures = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((e) => {
      failures++
      console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// Minimal in-memory D1 mock covering exactly what auth.ts's queries need —
// same shape as platform/worker/test/router.test.mjs's makeD1, kept
// independent so this file can run without the bundled worker.
function makeEnv(): Env {
  let configRow: Record<string, unknown> | null = null
  const sessions = new Map<string, { expires_at: number }>()

  const DB = {
    prepare(sql: string) {
      let boundArgs: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) {
          boundArgs = args
          return stmt
        },
        async run() {
          if (sql.startsWith('INSERT INTO config')) {
            const [username, password_hash, password_salt, password_iterations, created_at] = boundArgs
            configRow = { username, password_hash, password_salt, password_iterations, created_at }
          } else if (sql.startsWith('INSERT INTO sessions')) {
            const [id, , expires_at] = boundArgs as [string, number, number]
            sessions.set(id, { expires_at })
          } else if (sql.startsWith('UPDATE sessions')) {
            const [expires_at, id] = boundArgs as [number, string]
            const row = sessions.get(id)
            if (row) row.expires_at = expires_at
          } else if (sql.startsWith('DELETE FROM sessions')) {
            sessions.delete(boundArgs[0] as string)
          }
          return { success: true }
        },
        async first<T>() {
          if (sql.startsWith('SELECT username, password_hash')) return configRow as T | null
          if (sql.startsWith('SELECT expires_at FROM sessions')) {
            const row = sessions.get(boundArgs[0] as string)
            return (row ? { expires_at: row.expires_at } : null) as T | null
          }
          return null
        },
      }
      return stmt
    },
    // expose for the expiry test to reach in and backdate a row directly
    __sessions: sessions,
  }
  return { DOCS: {} as Env['DOCS'], DB: DB as unknown as Env['DB'] } as Env & { DB: { __sessions: typeof sessions } }
}

console.log('auth.ts')

await check('PASSWORD_ITERATIONS stays within the Workers PBKDF2 ceiling', () => {
  // Node's WebCrypto (what this whole suite runs under) does NOT enforce
  // Cloudflare Workers' "iteration counts above 100000 are not supported"
  // limit — this shipped broken once already (300_000, copied from
  // kernel/save.ts's browser-only code) and every real POST /api/setup
  // 500'd in production with every other check here still green, because
  // nothing exercised the actual Workers runtime. This is the only line in
  // the suite that would have caught it: a plain range assertion against
  // the real ceiling, checked in prose so raising it back up is a visible,
  // deliberate edit rather than a silent regression.
  assert(PASSWORD_ITERATIONS <= 100_000, `PASSWORD_ITERATIONS (${PASSWORD_ITERATIONS}) exceeds the Workers PBKDF2 ceiling of 100,000 — this WILL 500 in production even though Node-based tests can't detect it`)
})

await check('createConfig + verifyPassword: correct credentials verify', async () => {
  const env = makeEnv()
  await createConfig(env, 'owner', 'correct horse battery staple')
  assert(await verifyPassword(env, 'owner', 'correct horse battery staple'), 'correct password should verify')
})

await check('verifyPassword rejects a wrong password', async () => {
  const env = makeEnv()
  await createConfig(env, 'owner', 'correct horse battery staple')
  assert(!(await verifyPassword(env, 'owner', 'wrong password entirely')), 'wrong password should not verify')
})

await check('verifyPassword rejects a wrong username', async () => {
  const env = makeEnv()
  await createConfig(env, 'owner', 'correct horse battery staple')
  assert(!(await verifyPassword(env, 'someone-else', 'correct horse battery staple')), 'wrong username should not verify')
})

await check('verifyPassword against no config at all returns false, not a throw', async () => {
  const env = makeEnv()
  assert(!(await verifyPassword(env, 'owner', 'anything')), 'no config should just fail verification')
})

await check('createConfig refuses to run twice', async () => {
  const env = makeEnv()
  await createConfig(env, 'owner', 'correct horse battery staple')
  let threw = false
  try {
    await createConfig(env, 'owner', 'a different password')
  } catch {
    threw = true
  }
  assert(threw, 'second createConfig call should throw')
})

await check('two createConfig calls with the same password produce different stored hashes', async () => {
  // proves the salt is actually random per call, not a fixed/derived value
  const envA = makeEnv()
  const envB = makeEnv()
  await createConfig(envA, 'owner', 'same password same password')
  await createConfig(envB, 'owner', 'same password same password')
  const rowA = await (envA as any).DB.prepare('SELECT username, password_hash, password_salt, password_iterations, created_at FROM config WHERE id = 1').first()
  const rowB = await (envB as any).DB.prepare('SELECT username, password_hash, password_salt, password_iterations, created_at FROM config WHERE id = 1').first()
  assert(rowA.password_salt !== rowB.password_salt, 'salts should differ across independent setups')
  assert(rowA.password_hash !== rowB.password_hash, 'hashes should differ across independent setups (different salts)')
})

await check('createSession + touchSession: a fresh session is valid', async () => {
  const env = makeEnv()
  const id = await createSession(env)
  assert(await touchSession(env, id), 'freshly created session should be valid')
})

await check('touchSession rejects an unknown session id', async () => {
  const env = makeEnv()
  assert(!(await touchSession(env, 'not-a-real-session-id')), 'unknown session should be invalid')
})

await check('touchSession rejects an empty session id without querying', async () => {
  const env = makeEnv()
  assert(!(await touchSession(env, '')), 'empty session id should short-circuit to invalid')
})

await check('deleteSession ends the session', async () => {
  const env = makeEnv()
  const id = await createSession(env)
  assert(await touchSession(env, id), 'sanity: session valid before delete')
  await deleteSession(env, id)
  assert(!(await touchSession(env, id)), 'session should be invalid after delete')
})

await check('touchSession rejects an already-expired session', async () => {
  const env = makeEnv() as ReturnType<typeof makeEnv> & { DB: { __sessions: Map<string, { expires_at: number }> } }
  const id = await createSession(env)
  // backdate it directly in the mock store, rather than waiting 30 real days
  ;(env.DB as any).__sessions.get(id)!.expires_at = Date.now() - 1000
  assert(!(await touchSession(env, id)), 'expired session should be invalid')
})

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
