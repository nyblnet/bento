// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// CSS colour ⇄ {hex, a}: pure, so model maths (contrast.ts) and node rigs can use it.

/** Any CSS color → {hex, a}. Handles #rgb/#rrggbb/#rrggbbaa/rgb()/rgba()/transparent. */
export function parseColor(v: string): { hex: string; a: number } {
  if (!v || v === 'transparent' || v === 'none') return { hex: '#000000', a: 0 }
  const m = v.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).map((s) => parseFloat(s))
    const [r, g, b] = parts
    const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      const hex = '#' + [r, g, b].map((n) => Math.round(Math.min(Math.max(n, 0), 255)).toString(16).padStart(2, '0')).join('')
      return { hex, a: Math.min(Math.max(a, 0), 1) }
    }
  }
  let hex = v.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('')
  if (/^#[0-9a-fA-F]{8}$/.test(hex)) return { hex: hex.slice(0, 7), a: parseInt(hex.slice(7), 16) / 255 }
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return { hex, a: 1 }
  return { hex: '#1E2A3A', a: 1 }
}

/** {hex, a} → the shortest CSS color that keeps the alpha. */
export function combineColor(hex: string, a: number): string {
  if (a >= 1) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`
}
