// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Argon2id off the page's main thread. Noble's asyncTick yields only to the
// microtask queue, which never lets a page repaint or take input: measured in
// the setup page, a 64 MiB derivation froze it for its whole length (0.6 s on
// a fast Mac, 4 s at a 6× CPU slowdown, with no timer tick at all). In a
// worker the page stays live and its progress line paints.
//
// One derivation per worker; the page terminates it afterwards. The password
// copy this worker received is zeroed once used; the key goes back
// transferred, not copied.

import { argon2id } from './argon2.js'

self.onmessage = async (e) => {
  const { password, salt } = e.data ?? {}
  try {
    const key = await argon2id(password, salt)
    self.postMessage({ ok: true, key }, [key.buffer])
  } catch (err) {
    self.postMessage({ ok: false, name: err?.name ?? 'Error', message: err?.message ?? String(err) })
  } finally {
    if (password instanceof Uint8Array) password.fill(0)
  }
}
