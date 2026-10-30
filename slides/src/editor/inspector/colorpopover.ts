// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The colour popover, Penpot's: a saturation/brightness square, hue and
// opacity sliders, the value as HEX, RGB or HSL, the eyedropper, and swatches.
// It edits nothing itself: the caller previews, commits or cancels.
import { t } from '../../i18n'
import { ICONS } from '../../icons'

export interface Swatch { label: string; color: string; pick: () => void }
export interface ColorPopoverOpts {
  hex: string
  /** 0..1; absent = the field has no opacity, so no opacity slider */
  alpha?: number
  groups: Array<{ title: string; swatches: Swatch[] }>
  preview: (hex: string, alpha: number) => void
  commit: (hex: string, alpha: number) => void
  cancel: () => void
}

type Model = 'hex' | 'rgb' | 'hsl'
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

function show(hex: string, m: Model): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  if (m === 'rgb') return `${r}, ${g}, ${b}`
  if (m === 'hex') return hex.slice(1)
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  return `${Math.round(hexToHsv(hex)[0])}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`
}
function parse(text: string, m: Model) {
  const s = text.trim()
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
  for (const m of ['hex', 'rgb', 'hsl'] as const) models.add(new Option(m.toUpperCase(), m, false, m === model))
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
  pop.append(sv, hue)
  if (o.alpha !== undefined) pop.append(alpha)
  pop.append(line)
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
    pop.append(cap, row)
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
    if (!keepText) text.value = show(c, model)
  }
  const emit = (keepText = false) => { touched = true; paint(keepText); o.preview(hex(), a) }
  paint()

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
    if (commit && touched) o.commit(hex(), a)
    else if (touched) o.cancel()
    anchor.focus({ preventScroll: true })
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
