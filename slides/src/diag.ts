// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// DIAGNOSTIC BUILD ONLY — never ship this.
//
// A heads-up display that answers, on screen, the questions I have been
// guessing at: is this actually Slideshow, is reduced motion on, and did any
// token animate on the last slide change. Four exchanges of "it does not
// animate" / "it does here" is three too many; the artifact should be able to
// say what it is doing.

export function startDiag(): void {
  const hud = document.createElement('div')
  hud.style.cssText = [
    'position:fixed', 'left:10px', 'bottom:10px', 'z-index:2147483647',
    'font:12px/1.5 ui-monospace,SF Mono,Menlo,monospace',
    'background:rgba(10,16,26,0.92)', 'color:#DCE3EC', 'padding:8px 11px',
    'border:1px solid #3a4b63', 'border-radius:8px', 'pointer-events:none',
    'white-space:pre', 'min-width:260px',
  ].join(';')
  document.body.appendChild(hud)

  let peakMove = 0
  let peakFade = 0
  let lastSlide = -1
  let sinceChange = 0

  const reduced = () => {
    try {
      const v = localStorage.getItem('bento-reduce-motion')
      if (v === 'on') return 'ON (stored)'
      if (v === 'off') return 'off (stored)'
    } catch { /* storage refused */ }
    return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'ON (from OS)' : 'off'
  }

  setInterval(() => {
    const overlay = document.querySelector('.bento-present-overlay')
    const inShow = !!overlay
    const root: ParentNode = overlay ?? document
    const sections = overlay ? [...overlay.querySelectorAll('section')] : []
    const idx = sections.findIndex((s) => s.classList.contains('present'))

    if (idx !== lastSlide) { lastSlide = idx; peakMove = 0; peakFade = 0; sinceChange = 0 }
    sinceChange += 200

    const toks = [...root.querySelectorAll<HTMLElement>('.bento-code [data-sym]')]
    const moving = toks.filter((t) => t.style.transform && t.style.transform !== 'none').length
    const fading = toks.filter((t) => t.style.opacity !== '' && +t.style.opacity < 0.99).length
    if (sinceChange < 2500) { peakMove = Math.max(peakMove, moving); peakFade = Math.max(peakFade, fading) }

    hud.textContent = [
      `MODE      ${inShow ? 'SLIDESHOW ✓' : 'editor — press Slideshow'}`,
      `reduced   ${reduced()}`,
      `slide     ${inShow ? `${idx + 1} / ${sections.length}` : '—'}`,
      `tokens    ${toks.length} on screen`,
      `travelled ${peakMove}   (peak since this slide)`,
      `faded in  ${peakFade}   (peak since this slide)`,
    ].join('\n')
  }, 200)
}
