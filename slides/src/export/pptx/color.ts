// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

export interface PptxColor {
  color: string
  transparency: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/** Bento authors solid CSS colors as hex/rgb/rgba/transparent. Turn those into
 * OOXML-safe six-digit RGB plus a separate transparency value. */
export function pptxColor(value?: string, fallback = '000000'): PptxColor {
  const raw = (value ?? '').trim()
  if (!raw || raw === 'none' || raw === 'transparent') return { color: fallback, transparency: 100 }
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)%?)?\s*\)$/i)
  if (rgb) {
    const alphaRaw = rgb[4]
    const alpha = alphaRaw === undefined ? 1 : Number(alphaRaw) > 1 ? Number(alphaRaw) / 100 : Number(alphaRaw)
    return {
      color: [rgb[1], rgb[2], rgb[3]].map((n) => clamp(Math.round(Number(n)), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase(),
      transparency: clamp(Math.round((1 - alpha) * 100), 0, 100),
    }
  }
  let hex = raw.replace(/^#/, '')
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('')
  if (/^[0-9a-f]{6,8}$/i.test(hex)) {
    const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1
    return { color: hex.slice(0, 6).toUpperCase(), transparency: Math.round((1 - alpha) * 100) }
  }
  return { color: fallback, transparency: 0 }
}

export function combineTransparency(color: PptxColor, opacity = 1): PptxColor {
  const alpha = (1 - color.transparency / 100) * Math.min(Math.max(opacity, 0), 1)
  return { color: color.color, transparency: Math.round((1 - alpha) * 100) }
}
