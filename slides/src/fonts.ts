// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Font utilities: the curated system-stack choices offered in the editor,
// and @font-face injection for fonts embedded in the document's asset table.

import type { BentoDoc } from './model.ts'
import { FRAUNCES_900, INSTRUMENT_VAR } from './fontdata.ts'

/**
 * Faces the SHELL carries (fontdata.ts, compiled into every build). A font
 * entry may name one by this key instead of an asset — `builtin:` is not a
 * key any asset table holds — and the bytes are not written into the file.
 *
 * Why: every saved deck used to embed the same two woff2 files the shell
 * already ships, 86 KB that existed twice in every file and was 80% of a
 * typical text deck's document block (measured 2026-09-14 on three decks).
 * A font that is NOT one of these still embeds, as before.
 *
 * Older shells: `injectFonts` there looks the key up in `assets`, finds
 * nothing, and skips the rule — the deck opens with the system stack for
 * that family. A degrade, and a short one: the shell updates itself.
 */
export const BUILTIN_FONTS: Readonly<Record<string, string>> = {
  'builtin:fraunces-900': FRAUNCES_900,
  'builtin:instrument-sans': INSTRUMENT_VAR,
}

/** Font bytes for a font entry: the deck's own asset, or a built-in face. */
export function resolveFontSrc(doc: BentoDoc, asset: string): string | undefined {
  return doc.assets?.[asset] ?? BUILTIN_FONTS[asset]
}

/**
 * At save: a deck that embeds bytes IDENTICAL to a built-in face is rewritten
 * to name the face instead, and the bytes leave the file. Byte equality, not
 * family name — a deck carrying its own Fraunces cut keeps it. Returns the
 * same object when there is nothing to do, a shallow copy otherwise (the live
 * document is never touched — same contract as pruneUnusedAssets).
 */
export function adoptBuiltinFonts(doc: BentoDoc): BentoDoc {
  const fonts = doc.fonts
  const assets = doc.assets
  if (!fonts?.length || !assets) return doc
  const byBytes = new Map(Object.entries(BUILTIN_FONTS).map(([k, v]) => [v, k]))
  const rewrite = new Map<string, string>() // asset key → builtin key
  for (const f of fonts) {
    const bytes = assets[f.asset]
    const builtin = bytes !== undefined ? byBytes.get(bytes) : undefined
    if (builtin) rewrite.set(f.asset, builtin)
  }
  if (rewrite.size === 0) return doc
  const nextAssets = { ...assets }
  for (const k of rewrite.keys()) delete nextAssets[k]
  return {
    ...doc,
    fonts: fonts.map((f) => (rewrite.has(f.asset) ? { ...f, asset: rewrite.get(f.asset)! } : f)),
    assets: nextAssets,
  }
}

/** Safe cross-platform stacks offered in the font picker. */
export const FONT_CHOICES: Array<{ label: string; stack: string }> = [
  { label: 'System UI', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { label: 'Helvetica', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Verdana', stack: "Verdana, 'DejaVu Sans', Geneva, Tahoma, sans-serif" },
  { label: 'Trebuchet', stack: "'Trebuchet MS', 'Segoe UI', Tahoma, sans-serif" },
  { label: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
  { label: 'Palatino', stack: "Palatino, 'Palatino Linotype', 'Book Antiqua', Georgia, serif" },
  { label: 'Times', stack: "'Times New Roman', Times, serif" },
  { label: 'Monospace', stack: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Courier New', monospace" },
  { label: 'Impact', stack: "Impact, 'Arial Black', 'Franklin Gothic Bold', sans-serif" },
]

/** First family of a stack, normalised — used to match stacks loosely. */
export function firstFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase()
}

/**
 * (Re)register @font-face rules for every embedded font in the document.
 * Idempotent — call at boot and again whenever a font is added.
 */
export function injectFonts(doc: BentoDoc) {
  const css = (doc.fonts ?? [])
    .map((f) => {
      const src = resolveFontSrc(doc, f.asset)
      if (!src) return ''
      return `@font-face{font-family:${JSON.stringify(f.family)};src:url(${JSON.stringify(src)});` +
        `font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'};font-display:swap}`
    })
    .join('\n')
  let style = document.getElementById('bento-fonts') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'bento-fonts'
    document.head.appendChild(style)
  }
  style.textContent = css
}
