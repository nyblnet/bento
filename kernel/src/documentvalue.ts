// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/** JSON document values only: containers are copied, immutable asset strings shared. */
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
export function copy<T>(v: T): T {
  if (Array.isArray(v)) return v.map(copy) as T
  if (object(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) as T
  return v
}
export function equal(a: any, b: any): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]))
}
