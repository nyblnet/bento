// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Pure operations on a JSON document VALUE — the shared vocabulary the save
// queue (and, later, the shared history engine) speak. Split out of the Codex
// document-state work in #535; this PR takes only what the save queue needs
// (`copy`), and `equal` joins it when the conditional-history engine lands.
//
// A document is plain JSON: nested containers plus immutable leaves. `copy`
// deep-copies the CONTAINERS so a detached snapshot can never be mutated through
// the live tree, while leaving primitive leaves shared (an asset data-URI string
// is immutable, so copying it per edit would only cost memory). It also never
// walks the prototype chain — `Object.entries` reads own enumerable keys only —
// so a hostile `__proto__` entry in an imported document copies as an ordinary
// key and cannot pollute `Object.prototype`.

/** True for a plain (non-array) object we should recurse into. */
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A structural deep copy: containers cloned, primitive leaves shared. */
export function copy<T>(v: T): T {
  if (Array.isArray(v)) return v.map(copy) as T
  if (object(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) as T
  return v
}
