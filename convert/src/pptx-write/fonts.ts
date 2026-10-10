// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A CSS font stack → the one typeface name PowerPoint takes.
//
// A stack can name CSS GENERIC families ('ui-monospace', 'sans-serif',
// 'system-ui', …). Those mean "whatever this browser picks", and are not
// font names: written into a .pptx as a typeface, PowerPoint finds no such
// font and substitutes its own default, so code set in 'ui-monospace, Menlo,
// monospace' came out proportional. So the first REAL family in the stack
// wins, and a stack of generics alone maps to a font every PowerPoint has.

/** CSS generic family → a font PowerPoint can be expected to have. */
const GENERIC: Record<string, string> = {
  'monospace': 'Courier New',
  'ui-monospace': 'Courier New',
  'serif': 'Times New Roman',
  'ui-serif': 'Times New Roman',
  'sans-serif': 'Arial',
  'ui-sans-serif': 'Arial',
  'system-ui': 'Arial',
  '-apple-system': 'Arial',
  'blinkmacsystemfont': 'Arial',
  'ui-rounded': 'Arial',
  'cursive': 'Comic Sans MS',
  'fantasy': 'Impact',
  'math': 'Cambria Math',
  'emoji': 'Segoe UI Emoji',
}

/**
 * System fonts that ship with ONE operating system and not with Office. A
 * browser falls through a stack to the next family it has; PowerPoint takes
 * one name and substitutes when it is missing. So naming 'SF Mono' (macOS
 * only) gives Windows PowerPoint a proportional stand-in, while the stack's
 * next family, 'Consolas', is installed with Office everywhere. These are
 * skipped like generics; a deck's own fonts are never on this list.
 */
const ONE_PLATFORM = new Set([
  'sf mono', 'sfmono-regular', 'sf pro', 'sf pro text', 'sf pro display', 'new york',
  'menlo', 'monaco', 'helvetica neue', 'lucida grande', 'apple color emoji',
  'segoe ui', 'segoe ui emoji', 'segoe ui symbol', 'cascadia code', 'cascadia mono',
  'roboto', 'roboto mono', 'ubuntu', 'ubuntu mono', 'cantarell', 'oxygen', 'fira sans',
  'noto sans', 'noto color emoji', 'liberation mono', 'liberation sans', 'liberation serif',
  'dejavu sans', 'dejavu sans mono', 'dejavu serif', 'droid sans', 'droid sans mono',
])

const families = (stack: string): string[] =>
  stack.split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean)

/**
 * The typeface for a CSS stack: its first family that is neither generic nor
 * one-platform, else the PowerPoint stand-in for its first generic, else the
 * first family it names, else `fallback`.
 */
export function typefaceOf(stack: string | undefined, fallback = 'Arial'): string {
  const list = families(stack ?? '')
  const real = list.find((f) => !(f.toLowerCase() in GENERIC) && !ONE_PLATFORM.has(f.toLowerCase()))
  if (real) return real
  const generic = list.find((f) => f.toLowerCase() in GENERIC)
  if (generic) return GENERIC[generic.toLowerCase()]
  return list[0] ?? fallback
}
