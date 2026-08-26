// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Save-time asset compaction for bento/slides.

import type { BentoDoc, Slide, SlideElement } from './model'

export interface AssetCompactionStats {
  before: number
  after: number
  removed: number
  deduplicated: number
  interned: number
}

export interface CompactedDocument {
  doc: BentoDoc
  stats: AssetCompactionStats
}

const cloneDoc = (doc: BentoDoc): BentoDoc =>
  typeof structuredClone === 'function'
    ? structuredClone(doc)
    : JSON.parse(JSON.stringify(doc)) as BentoDoc

/** Compact a serialization copy. The caller's live document is never mutated. */
export function compactDocumentAssets(input: BentoDoc): CompactedDocument {
  const doc = cloneDoc(input)
  const original = doc.assets ?? {}
  const assets: Record<string, string> = {}
  const canonicalByValue = new Map<string, string>()
  const alias = new Map<string, string>()
  let deduplicated = 0
  let interned = 0
  let seq = 0

  for (const [key, value] of Object.entries(original)) {
    const existing = canonicalByValue.get(value)
    if (existing) {
      alias.set(key, existing)
      deduplicated++
    } else {
      assets[key] = value
      canonicalByValue.set(value, key)
      alias.set(key, key)
    }
  }

  const freshKey = () => {
    let key: string
    do key = `a-compact-${++seq}`
    while (key in assets || key in original)
    return key
  }

  const intern = (value: string): string => {
    const existing = canonicalByValue.get(value)
    if (existing) return existing
    const key = freshKey()
    assets[key] = value
    canonicalByValue.set(value, key)
    interned++
    return key
  }

  const assetRef = (value: string | undefined): string | undefined => {
    if (!value) return value
    if (value.startsWith('data:')) return `asset:${intern(value)}`
    if (!value.startsWith('asset:')) return value
    const key = value.slice(6)
    return `asset:${alias.get(key) ?? key}`
  }

  const bareRef = (value: string | undefined): string | undefined =>
    value ? (alias.get(value) ?? value) : value

  const rewriteElement = (el: SlideElement) => {
    if (el.type === 'image' || el.type === 'media') el.src = assetRef(el.src) ?? ''
    if (el.type === 'media') el.poster = assetRef(el.poster)
    if (el.type === 'svg') el.asset = bareRef(el.asset)
    if (el.type === 'code') {
      el.grammarAssetId = bareRef(el.grammarAssetId)
      el.themeAssetId = bareRef(el.themeAssetId)
    }
  }
  const rewriteSlide = (slide: Slide) => slide.elements.forEach(rewriteElement)
  doc.slides.forEach(rewriteSlide)
  doc.layouts?.forEach(rewriteSlide)
  doc.fonts?.forEach((font) => { font.asset = bareRef(font.asset)! })

  const used = new Set<string>()
  const useBare = (key: string | undefined) => { if (key) used.add(key) }
  const useElement = (el: SlideElement) => {
    const useRef = (ref: string | undefined) => {
      if (ref?.startsWith('asset:')) used.add(ref.slice(6))
    }
    if (el.type === 'image' || el.type === 'media') useRef(el.src)
    if (el.type === 'media') useRef(el.poster)
    if (el.type === 'svg') useBare(el.asset)
    if (el.type === 'code') {
      useBare(el.grammarAssetId)
      useBare(el.themeAssetId)
    }
  }
  const useSlide = (slide: Slide) => slide.elements.forEach(useElement)
  doc.slides.forEach(useSlide)
  doc.layouts?.forEach(useSlide)
  doc.fonts?.forEach((font) => useBare(font.asset))

  // Preserve additive future fields that use the explicit asset:<key> form.
  // Skip the asset table itself, otherwise every entry would keep itself live.
  const scan = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.startsWith('asset:')) used.add(alias.get(value.slice(6)) ?? value.slice(6))
      return
    }
    if (Array.isArray(value)) { value.forEach(scan); return }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key !== 'assets') scan(child)
    }
  }
  scan(doc)

  const compacted: Record<string, string> = {}
  for (const key of used) if (assets[key] !== undefined) compacted[key] = assets[key]
  if (Object.keys(compacted).length) doc.assets = compacted
  else delete doc.assets

  if (doc.blobs) {
    const blobs = Object.fromEntries(Object.entries(doc.blobs).filter(([key]) => used.has(key)))
    if (Object.keys(blobs).length) doc.blobs = blobs
    else delete doc.blobs
  }

  const before = Object.keys(original).length
  const after = Object.keys(compacted).length
  return {
    doc,
    stats: { before, after, removed: Math.max(0, before + interned - after), deduplicated, interned },
  }
}
