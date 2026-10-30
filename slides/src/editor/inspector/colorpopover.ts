// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The colour popover, Penpot's: a saturation/brightness square, hue and
// opacity sliders, the value as HEX, RGB, HSL or OKLCH, the eyedropper, and swatches.
// It edits nothing itself: the caller previews, commits or cancels.
import { t } from '../../i18n'
import { ICONS } from '../../icons'
import type { GradientFill } from '../../model'
import type { PaintHost, PaintKind } from './color'
import { gradientBar } from './gradientbar'
import { gradientFor } from './color'
import { combineColor, parseColor } from './controls'

export interface Swatch { label: string; color: string; pick: () => void }
export interface ColorPopoverOpts {
  hex: string
  /** 0..1; absent = the field has no opacity, so no opacity slider */
  alpha?: number
  groups: Array<{ title: string; swatches: Swatch[] }>
  preview: (hex: string, alpha: number) => void
  commit: (hex: string, alpha: number) => void
  cancel: () => void
  /** a fill that can also be a gradient or a token: the popover opens with
   *  Solid | Linear | Radial | Tokens on top, and writes through the host */
  paint?: PaintHost
  /** after the popover closed having changed the fill's kind */
  done?: () => void
}

type Model = 'hex' | 'rgb' | 'hsl' | 'oklch'
let model: Model = 'hex' // the viewer's choice, kept for the session
let open: (() => void) | null = null // closes the popover that is open, committing

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0')
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)) }
  return '#' + [f(5), f(3), f(1)].map((c) => hex2(c * 255)).join('')
}
export function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b)
  const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [(h * 60 + 360) % 360, max ? d / max : 0, max]
}

/** Any colour the browser understands — names, #rgb, #rrggbbaa, rgb(), hsl() —
 *  as #rrggbb plus alpha, or null. The canvas does the parsing: one colour
 *  grammar, the browser's own, rather than a second one of ours. */
let ctx: CanvasRenderingContext2D | null = null
export function readColor(text: string): { hex: string; a: number } | null {
  ctx ??= document.createElement('canvas').getContext('2d')!
  for (const probe of ['#010203', '#030201']) { // a value equal to a probe would read as refused
    ctx.fillStyle = probe
    ctx.fillStyle = text.trim()
    if (ctx.fillStyle !== probe) break
    if (probe === '#030201') return null
  }
  const v = String(ctx.fillStyle)
  if (v.startsWith('#')) return { hex: v, a: 1 }
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(v)
  return m ? { hex: '#' + [m[1], m[2], m[3]].map((c) => hex2(+c)).join(''), a: m[4] === undefined ? 1 : +m[4] } : null
}

/** sRGB ⇄ OKLCH (Björn Ottosson's OKLab, CSS Color 4 matrices). */
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
export function hexToOklch(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q
  const C = Math.hypot(A, B)
  return [L, C, C < 1e-4 ? 0 : (Math.atan2(B, A) * 180 / Math.PI + 360) % 360]
}
/** OKLCH → gamma-encoded sRGB channels (0..1, unclipped). */
function oklchToRgb(L: number, C: number, H: number): number[] {
  const A = C * Math.cos(H * Math.PI / 180), B = C * Math.sin(H * Math.PI / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const q = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * q,
  ].map((c) => Math.sign(c) * gam(Math.abs(c)))
}
const toHex = (rgb: number[]) => '#' + rgb.map((c) => hex2(Math.min(Math.max(c, 0), 1) * 255)).join('')
// in gamut = every channel within what 8-bit rounding hides (typed values carry
// a few digits, so exact-gamut colours land a hair outside)
const inGamut = (rgb: number[]) => rgb.every((c) => c >= -0.5 / 255 && c <= 1 + 0.5 / 255)
/** ΔEOK: distance in OKLab between an OKLCH colour and a (clipped) sRGB one. */
function deltaEOK([L, C, H]: number[], rgb: number[]): number {
  const [L2, C2, H2] = hexToOklch(toHex(rgb))
  const a = C * Math.cos(H * Math.PI / 180), b = C * Math.sin(H * Math.PI / 180)
  return Math.hypot(L - L2, a - C2 * Math.cos(H2 * Math.PI / 180), b - C2 * Math.sin(H2 * Math.PI / 180))
}

/**
 * OKLCH (L 0..1, C, H°) as #rrggbb; `clamped` when the colour lies outside
 * sRGB. Out of gamut it is MAPPED, not clipped, by CSS Color 4's algorithm:
 * keep L and H, binary-search the chroma down until clipping the result moves
 * it less than a just-noticeable difference (ΔEOK 0.02) — so a too-vivid red
 * stays that red's hue and lightness instead of skewing per channel.
 */
export function oklchToHex(L: number, C: number, H: number): { hex: string; clamped: boolean } {
  const rgb = oklchToRgb(L, C, H)
  if (inGamut(rgb)) return { hex: toHex(rgb), clamped: false }
  if (L >= 1) return { hex: '#ffffff', clamped: true }
  if (L <= 0) return { hex: '#000000', clamped: true }
  const JND = 0.02, EPS = 0.0001
  let lo = 0, hi = C, loIn = true
  let clipped = oklchToRgb(L, C, H).map((c) => Math.min(Math.max(c, 0), 1))
  if (deltaEOK([L, C, H], clipped) < JND) return { hex: toHex(clipped), clamped: true }
  while (hi - lo > EPS) {
    const mid = (lo + hi) / 2
    const cur = oklchToRgb(L, mid, H)
    if (loIn && inGamut(cur)) { lo = mid; continue }
    clipped = cur.map((c) => Math.min(Math.max(c, 0), 1))
    const E = deltaEOK([L, mid, H], clipped)
    if (E < JND) {
      if (JND - E < EPS) break
      loIn = false
      lo = mid
    } else hi = mid
  }
  return { hex: toHex(clipped), clamped: true }
}

function show(hex: string, m: Model): string {
  if (m === 'oklch') {
    const [L, C, H] = hexToOklch(hex)
    return `${+(L * 100).toFixed(1)}%, ${+C.toFixed(3)}, ${+H.toFixed(1)}`
  }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  if (m === 'rgb') return `${r}, ${g}, ${b}`
  if (m === 'hex') return hex.slice(1)
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  return `${Math.round(hexToHsv(hex)[0])}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`
}
function parse(text: string, m: Model): { hex: string; a: number; clamped?: boolean } | null {
  const s = text.trim()
  const ok = m === 'oklch' && /^([\d.]+)(%?)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?$/.exec(s)
  if (ok) {
    const L = ok[2] || +ok[1] > 1 ? +ok[1] / 100 : +ok[1]
    const a = ok[5] === undefined ? 1 : ok[6] ? +ok[5] / 100 : +ok[5]
    return { ...oklchToHex(Math.min(Math.max(L, 0), 1), +ok[3], +ok[4]), a: Math.min(Math.max(a, 0), 1) }
  }
  if (m === 'rgb' && /^[\d.\s,]+$/.test(s)) return readColor(`rgb(${s})`)
  if (m === 'hsl' && /^[\d.\s,%]+$/.test(s)) return readColor(`hsl(${s.replace(/,\s*([\d.]+)(?!%)/g, ', $1%')})`)
  if (/^[0-9a-f]{3}([0-9a-f]{3}([0-9a-f]{2})?)?$/i.test(s)) return readColor('#' + s)
  return readColor(s)
}

/** Close whichever popover is open, committing what it shows. */
export function closeColorPopover() { open?.() }

export function openColorPopover(anchor: HTMLElement, o: ColorPopoverOpts) {
  closeColorPopover()
  let [h, s, v] = hexToHsv(o.hex)
  let a = o.alpha ?? 1
  let touched = false
  const hex = () => hsvToHex(h, s, v)
  // the paint being edited: solid (the swatch's own path), or a gradient whose
  // selected stop the colour controls edit; 'tokens' lists the colour tokens
  const host = o.paint
  let kind: PaintKind = host?.kind ?? 'solid'
  let tab: PaintKind | 'tokens' = kind
  let grad: GradientFill | undefined = host?.grad ? { ...host.grad, stops: host.grad.stops.map((st) => ({ ...st })) } : undefined
  let sel = 0
  let kindChanged = false

  const pop = document.createElement('div')
  pop.className = 'ed-cpop'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', t('Color'))

  const sv = document.createElement('div')
  sv.className = 'ed-cpop-sv'
  sv.tabIndex = 0
  sv.setAttribute('role', 'slider')
  sv.setAttribute('aria-label', t('Saturation and brightness'))
  const knob = document.createElement('span')
  sv.appendChild(knob)

  const range = (cls: string, label: string, max: number) => {
    const r = document.createElement('input')
    r.type = 'range'
    r.className = cls
    r.min = '0'; r.max = String(max); r.step = '1'
    r.setAttribute('aria-label', label)
    return r
  }
  const hue = range('ed-cpop-hue', t('Hue'), 360)
  const alpha = range('ed-cpop-alpha', t('Opacity'), 100)

  const line = document.createElement('div')
  line.className = 'ed-cpop-line'
  const models = document.createElement('select')
  models.setAttribute('aria-label', t('Color model'))
  for (const m of ['hex', 'rgb', 'hsl', 'oklch'] as const) models.add(new Option(m.toUpperCase(), m, false, m === model))
  const text = document.createElement('input')
  text.type = 'text'
  text.className = 'ed-cpop-text'
  text.spellcheck = false
  text.setAttribute('aria-label', t('Color value'))
  line.append(models, text)
  const EyeDropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper
  if (EyeDropper) {
    const drop = document.createElement('button')
    drop.type = 'button'
    drop.className = 'ed-btn ed-tool'
    drop.innerHTML = ICONS.eyedropper
    drop.title = t('Pick a color from the screen')
    drop.setAttribute('aria-label', drop.title)
    drop.addEventListener('click', async () => {
      try {
        const c = readColor((await new EyeDropper().open()).sRGBHex)
        if (c) { [h, s, v] = hexToHsv(c.hex); emit() }
      } catch { /* the viewer pressed Esc */ }
    })
    line.appendChild(drop)
  }
  const kinds = document.createElement('div')
  const barHost = document.createElement('div')
  barHost.className = 'ed-cpop-bar'
  const tokenList = document.createElement('div')
  tokenList.className = 'ed-cpop-tokens'
  const colorPart = document.createElement('div')
  colorPart.className = 'ed-cpop-color'
  if (host) {
    kinds.className = 'ed-cpop-kinds'
    kinds.setAttribute('role', 'radiogroup')
    kinds.setAttribute('aria-label', t('Fill style'))
    const labels: Array<[PaintKind | 'tokens', string]> = [['solid', t('Solid')], ['linear', t('Linear')], ['radial', t('Radial')], ['tokens', t('Tokens')]]
    for (const [k, label] of labels) {
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.kind = k
      b.setAttribute('role', 'radio')
      b.textContent = label
      b.addEventListener('click', () => choose(k))
      kinds.appendChild(b)
    }
    for (const tk of host.tokens) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-palette-item'
      const chip = document.createElement('span')
      chip.className = 'ed-swatch'
      chip.style.background = tk.color
      const name = document.createElement('span')
      name.textContent = tk.name
      b.append(chip, name)
      b.addEventListener('click', () => { done = true; teardown(); tk.pick(); o.done?.() })
      tokenList.appendChild(b)
    }
    if (!host.tokens.length) {
      const none = document.createElement('p')
      none.className = 'ed-hint'
      none.textContent = t('This deck has no colour tokens yet — add them in the Tokens view.')
      tokenList.appendChild(none)
    }
    pop.append(kinds, barHost, tokenList)
  }
  colorPart.append(sv, hue)
  if (o.alpha !== undefined || host) colorPart.append(alpha)
  colorPart.append(line)
  pop.append(colorPart)
  for (const g of o.groups) {
    if (!g.swatches.length) continue
    const cap = document.createElement('div')
    cap.className = 'ed-palette-cap'
    cap.textContent = g.title
    const row = document.createElement('div')
    row.className = 'ed-cpop-swatches'
    for (const sw of g.swatches) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-swatch ed-cpop-swatch'
      b.style.background = sw.color
      b.title = sw.label
      b.setAttribute('aria-label', sw.label)
      b.addEventListener('click', () => { done = true; teardown(); sw.pick() })
      row.appendChild(b)
    }
    colorPart.append(cap, row)
  }

  const paint = (keepText = false) => {
    const c = hex()
    sv.style.setProperty('--hue', `hsl(${h} 100% 50%)`)
    knob.style.left = `${s * 100}%`
    knob.style.top = `${(1 - v) * 100}%`
    knob.style.background = c
    sv.setAttribute('aria-valuetext', c)
    hue.value = String(Math.round(h))
    alpha.value = String(Math.round(a * 100))
    alpha.style.setProperty('--c', c)
    if (!keepText) { text.value = show(c, model); text.classList.remove('is-clamped'); text.title = '' }
  }
  const emit = (keepText = false) => {
    touched = true
    paint(keepText)
    if (kind === 'solid' || !grad) { o.preview(hex(), a); return }
    grad.stops[sel].color = combineColor(hex(), a)
    host!.write(kind, grad, undefined, false)
    drawBar()
  }
  // the gradient's stops; a press on one makes it the colour being edited
  const drawBar = () => {
    barHost.replaceChildren()
    if (!grad || kind === 'solid') return
    barHost.appendChild(gradientBar(grad, (fn) => {
      fn(grad!)
      sel = Math.min(sel, grad!.stops.length - 1)
      touched = true
      host!.write(kind, grad, undefined, false)
      drawBar()
    }, sel, (i) => { sel = i; fromStop(); drawBar() }))
  }
  const fromStop = () => {
    const c = parseColor(grad!.stops[sel].color)
    ;[h, s, v] = hexToHsv(c.hex)
    a = c.a
    paint()
  }
  const show_ = () => {
    for (const b of kinds.querySelectorAll<HTMLElement>('[data-kind]')) b.setAttribute('aria-checked', String(b.dataset.kind === tab))
    tokenList.hidden = tab !== 'tokens'
    colorPart.hidden = tab === 'tokens'
    barHost.hidden = tab === 'tokens' || kind === 'solid'
    alpha.hidden = kind === 'solid' && o.alpha === undefined
  }
  const choose = (k: PaintKind | 'tokens') => {
    tab = k
    if (k !== 'tokens' && k !== kind) {
      kindChanged = true
      touched = true
      if (k === 'solid') {
        kind = 'solid'
        host!.write('solid', undefined, undefined, false)
        o.preview(hex(), a)
      } else {
        grad = gradientFor(k, grad, host!.solid)
        kind = k
        sel = Math.min(sel, grad.stops.length - 1)
        host!.write(kind, grad, undefined, false)
        fromStop()
      }
    }
    drawBar()
    show_()
  }
  if (host && kind !== 'solid' && grad) fromStop()
  else paint()
  drawBar()
  if (host) show_()

  const pickAt = (e: PointerEvent) => {
    const r = sv.getBoundingClientRect()
    s = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1)
    v = 1 - Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)
    emit()
  }
  sv.addEventListener('pointerdown', (e) => {
    sv.setPointerCapture(e.pointerId)
    pickAt(e)
    const mv = (m: PointerEvent) => pickAt(m)
    sv.addEventListener('pointermove', mv)
    sv.addEventListener('pointerup', () => sv.removeEventListener('pointermove', mv), { once: true })
  })
  sv.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 0.1 : 0.01
    const k = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key]
    if (!k) return
    e.preventDefault()
    s = Math.min(Math.max(s + k[0], 0), 1); v = Math.min(Math.max(v + k[1], 0), 1)
    emit()
  })
  hue.addEventListener('input', () => { h = +hue.value; emit() })
  alpha.addEventListener('input', () => { a = +alpha.value / 100; emit() })
  models.addEventListener('change', () => { model = models.value as Model; paint() })
  text.addEventListener('change', () => {
    const c = parse(text.value, model)
    if (!c) { paint(); return }
    ;[h, s, v] = hexToHsv(c.hex)
    if (o.alpha !== undefined && c.a < 1) a = c.a
    emit()
    // out of sRGB: the nearest colour it can show, and the field says so
    text.classList.toggle('is-clamped', !!c.clamped)
    text.title = c.clamped ? t('Outside sRGB — shown as the nearest colour it can display') : ''
  })

  let done = false
  const teardown = () => {
    open = null
    pop.remove()
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', key, true)
  }
  const finish = (commit: boolean) => {
    if (done) return
    done = true
    teardown()
    if (commit && touched) {
      if (kind === 'solid' || !grad) o.commit(hex(), a)
      else host!.write(kind, grad, undefined, true)
    } else if (touched) o.cancel()
    anchor.focus({ preventScroll: true })
    if (kindChanged || !commit) o.done?.()
  }
  const outside = (e: Event) => { if (!pop.contains(e.target as Node) && e.target !== anchor) finish(true) }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
    else if (e.key === 'Enter' && e.target !== text) { e.preventDefault(); finish(true) }
    else if (e.key === 'Enter') { text.dispatchEvent(new Event('change')); e.preventDefault(); finish(true) }
  }
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', key, true)
  open = () => finish(true)

  document.body.appendChild(pop)
  // under the swatch, kept on screen
  const r = anchor.getBoundingClientRect()
  const w = pop.offsetWidth, ht = pop.offsetHeight
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`
  pop.style.top = `${r.bottom + 6 + ht > innerHeight ? Math.max(8, r.top - ht - 6) : r.bottom + 6}px`
  sv.focus({ preventScroll: true })
}
