// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The page's Argon2id: the same function as ./argon2.js (kernel's Argon2id
// shape), run in ./argon2-worker.js so the page never freezes. A failure in
// the worker comes back by name, so RecoveryUnavailable still reaches the
// caller as RecoveryUnavailable.

import { RecoveryUnavailable } from './argon2.js'

export function argon2idInWorker(password, salt) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./argon2-worker.js', import.meta.url), { type: 'module' })
    w.onmessage = (e) => {
      w.terminate()
      const d = e.data
      if (d?.ok) resolve(d.key)
      else if (d?.name === 'RecoveryUnavailable') reject(new RecoveryUnavailable())
      else reject(new Error(`Argon2id failed: ${d?.name}: ${d?.message}`))
    }
    w.onerror = (e) => { w.terminate(); reject(new Error(`Argon2id worker failed: ${e.message}`)) }
    w.postMessage({ password, salt })
  })
}
