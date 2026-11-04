// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Colour fields: the swatch + hex + opacity row, palette links, gradients.
import { mini, field } from './fields'
import { parseColor, unitHandle, slotLabel, combineColor, alphaOf, SCRUB, numeric } from './controls'
import { t } from '../../i18n'
import type { PropsPanel } from '../panels'
import { ICONS } from '../../icons'
import type { BentoDoc, GradientFill, Slide } from '../../model'
import { setColor, refAt, keepAlpha, PALETTE_SLOTS } from '../../palette'
import { cssColor, cssGradient, radialGeom } from '../../render'
import { adoptColor, bindToken, colorUses, freeTokenName, tokenName, tokenValue } from '../../tokens'
import { choices, openTokenPicker, slotOf, type Choice } from './tokenpicker'
import { bindUses, madeToken, usesFollow } from './tokenbind'
import { openColorPopover } from './colorpopover'
import { gradientBar } from './gradientbar'
import { gradTarget } from '../gradientoverlay'

export type PaintKind = 'solid' | 'linear' | 'radial'
export const paintKind = (g?: GradientFill): PaintKind => (!g?.stops?.length ? 'solid' : g.kind === 'radial' ? 'radial' : 'linear')

/** The gradient a fill becomes when switched to `kind`, starting from what it
 *  has: an existing gradient keeps its stops; a solid colour fades out. */
export function gradientFor(kind: 'linear' | 'radial', from: GradientFill | undefined, solid: string, angle = 180): GradientFill {
  const base = parseColor(solid)
  const g: GradientFill = from?.stops?.length
    ? { angle: from.angle ?? angle, stops: from.stops.map((st) => ({ ...st })) }
    : { angle, stops: [{ at: 0, color: combineColor(base.hex, Math.max(base.a, 0.85)) }, { at: 1, color: combineColor(base.hex, 0) }] }
  if (kind === 'radial') Object.assign(g, { kind: 'radial', cx: from?.cx ?? 0.5, cy: from?.cy ?? 0.5, r: from?.r ?? 0.5 })
  return g
}

/** What the colour popover needs to switch a fill between solid, linear,
 *  radial and a token, and to write it. One write per edit, as p.mutate does:
 *  non-final while previewing, final on commit — one undo step. */
export interface PaintHost {
  kind: PaintKind
  grad?: GradientFill
  solid: string
  write: (kind: PaintKind, grad: GradientFill | undefined, solid: string | undefined, final: boolean) => void
  tokens: Array<{ name: string; color: string; pick: () => void }>
  /** marks the controls editing this gradient, so the canvas shows its handle (gradientoverlay.ts) */
  target: string
}

/** A fill's paint host: `solidKey` holds the colour (and the fallback under a
 *  gradient), `gradKey` the gradient — element keys, or dotted paths into a
 *  fill stack's layer (`fills.1.color`, `fills.1.gradient`). A hand-picked
 *  solid drops any palette or token reference on the colour, as every
 *  hand-picked colour does. */
export function paintHost(p: PropsPanel, id: string, solidKey: string, gradKey: string, angle = 180): PaintHost {
  const el = p.store.element(id)
  const grad = readAt(el, gradKey) as GradientFill | undefined
  return {
    kind: paintKind(grad),
    grad,
    target: gradTarget(id, gradKey),
    solid: String(readAt(el, solidKey) ?? '#808080'),
    write: (kind, g, solid, final) => p.mutate(id, (e) => {
      const [holder, key] = slot(e, gradKey)
      if (!holder) return
      if (kind === 'solid') {
        delete holder[key]
        if (solid !== undefined) setColor(e as never, solidKey, solid, null)
      } else {
        holder[key] = g ?? gradientFor(kind, holder[key] as GradientFill | undefined, String(readAt(e, solidKey)), angle)
      }
    }, final),
    tokens: Object.entries(p.store.doc.theme.tokens?.set ?? {}).filter(([, v]) => v.type === 'color').map(([name]) => ({
      name,
      color: String(tokenValue(p.store.doc, name) ?? ''),
      pick: () => p.edit(() => {
        const h = p.store.element(id)
        if (!h) return
        const [holder, key] = slot(h, gradKey)
        if (holder) delete holder[key]
        opaque(h, solidKey)
        bindToken(p.store.doc, h as never, solidKey, name)
      }, true),
    })),
  }
}

/** A colour token keeps the property's own opacity — so a 0% colour (an
 *  empty fill) is made opaque first, or the pick would change nothing visible. */
function opaque(holder: unknown, path: string) {
  const [h, key] = slot(holder, path)
  const v = h?.[key]
  if (typeof v === 'string' && parseColor(v).a === 0) h![key] = combineColor(parseColor(v).hex, 1)
}

/** The value at a dotted path, or undefined. */
function readAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<any>((cur, k) => (cur == null ? undefined : cur[k]), obj)
}

/** The object holding a dotted path's last key, and that key. */
function slot(obj: unknown, path: string): [Record<string, unknown> | undefined, string] {
  const segs = path.split('.')
  const key = segs.pop()!
  return [readAt(obj, segs.join('.')) as Record<string, unknown> | undefined ?? (segs.length ? undefined : obj as Record<string, unknown>), key]
}

/** A gradient fill's swatch: the gradient itself; a click opens the popover on it. */
export function gradientChip(p: PropsPanel, host: PaintHost): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-gradchip'
  b.dataset.gradEdit = host.target
  b.dataset.paint = host.target // the swatch's place: settle() finds it by this
  b.style.setProperty('--grad', host.grad ? cssGradient(host.grad) : 'none')
  b.textContent = host.kind === 'radial' ? t('Radial') : t('Linear')
  b.title = t('Edit the gradient')
  b.addEventListener('click', () => {
    const first = parseColor(host.grad?.stops[0]?.color ?? host.solid)
    openColorPopover(b, {
      hex: first.hex,
      alpha: first.a,
      groups: [],
      preview: (hex, a) => host.write('solid', undefined, combineColor(hex, a), false),
      commit: (hex, a) => host.write('solid', undefined, combineColor(hex, a), true),
      cancel: () => p.cancelBurst(),
      paint: host,
      done: () => settle(p, host.target),
    })
  })
  return b
}

/** After the popover changed the fill's kind, the section must be rebuilt:
 *  let go of the field the popover handed focus back to, so the panel's
 *  deferred rebuild runs — then give focus to whatever now paints that
 *  layer. The swatch it was handed to may be gone (a gradient chip stands in
 *  its place, or the other way round); <body> would strand the keyboard and,
 *  taking focus off the chip, put the canvas handle away. */
function settle(p: PropsPanel, target: string) {
  const a = document.activeElement as HTMLElement | null
  if (a && p.host.contains(a)) a.blur()
  if (p.stale) p.rebuild()
  p.host.querySelector<HTMLElement>(`[data-paint="${CSS.escape(target)}"]`)?.focus({ preventScroll: true })
}

/** A gradient's angle and stops, shared by text and shapes. `edit` hands
 *  the live gradient to change. */
export function gradientRows(p: PropsPanel, grad: GradientFill, edit: (fn: (g: GradientFill) => void, final: boolean) => void, target?: string) {
  const before = p.host.children.length
  p.host.appendChild(gradientBar(grad, edit))
  if (grad.kind === 'radial') {
    // the centre and radius, in % of the box (the canvas handle drags them too)
    const { cx, cy, r } = radialGeom(grad)
    const pct = (label: string, v: number, set: (g: GradientFill, v: number) => void) =>
      mini(label, Math.round(v * 100), (n, fin) => edit((g) => set(g, n / 100), fin), undefined, { unit: '%' })
    const grid = document.createElement('div')
    grid.className = 'ed-grid3'
    grid.append(
      pct(t('X'), cx, (g, v) => { g.cx = v }),
      pct(t('Y'), cy, (g, v) => { g.cy = v }),
      pct(t('Radius'), r, (g, v) => { g.r = Math.max(v, 0.01) }),
    )
    grid.title = t('Centre and radius, in % of the box')
    p.host.appendChild(grid)
  }
  const angle = mini(t('Gradient angle'), grad.angle, (v, fin) => edit((g) => { g.angle = v }, fin), ICONS.rotate, { unit: '°' })
  if (grad.kind === 'radial') angle.hidden = true // kept in the model (an older shell draws it), not a radial's control
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'ed-btn ed-tool'
  add.innerHTML = ICONS.plus
  add.title = t('＋ Add stop').replace(/^＋\s*/, '')
  add.setAttribute('aria-label', add.title)
  add.addEventListener('click', () => edit((g) => {
    const mid = g.stops[Math.floor(g.stops.length / 2)]
    g.stops.push({ at: 0.5, color: mid?.color ?? '#808080' })
    g.stops.sort((a, b) => a.at - b.at)
  }, true))
  field(p, angle, add)
  grad.stops.forEach((stop, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'ed-gradstop'
    const at = mini('%', Math.round(stop.at * 100), (v, fin) =>
      edit((g) => { if (g.stops[i]) g.stops[i].at = Math.min(Math.max(v / 100, 0), 1) }, fin), undefined, { min: 0, max: 100 })
    at.title = t('Stop {n}', { n: i + 1 }) + ' · ' + t('Position %')
    at.querySelector('input')!.setAttribute('aria-label', at.title) // not '%'
    at.classList.add('ed-gradstop-at')
    const color = colorAlpha(p, stop.color, (v, fin) => edit((g) => { if (g.stops[i]) g.stops[i].color = v }, fin))
    wrap.append(at, color)
    if (grad.stops.length > 2) {
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'ed-btn ed-tool'
      del.innerHTML = ICONS.minus
      del.title = t('Remove stop')
      del.setAttribute('aria-label', t('Remove stop'))
      del.addEventListener('click', () => edit((g) => { if (g.stops.length > 2) g.stops.splice(i, 1) }, true))
      wrap.appendChild(del)
    }
    p.host.appendChild(wrap)
  })
  // these rows edit that gradient: focus in any of them shows its canvas handle
  if (target) for (const n of [...p.host.children].slice(before)) (n as HTMLElement).dataset.gradEdit = target
}

export function color(p: PropsPanel, value: string, onEdit: (v: string, final: boolean) => void, ref?: { id: string | null; path: string; slide?: Slide }): HTMLElement {
  const input = document.createElement('input')
  input.type = 'color'
  input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : parseColor(value).hex
  input.addEventListener('input', () => onEdit(input.value, false))
  // A colour chosen by hand must CLEAR any palette reference on this path.
  // Without that, the next theme edit silently overwrites a colour somebody
  // picked deliberately — which reads as the app changing their work.
  // setRef writes the colour AND clears the reference in one edit: one undo step.
  input.addEventListener('change', () => {
    if (ref) setRef(p, ref, input.value, null)
    else onEdit(input.value, true)
  })
  const field = colorField(input)
  popoverOn(p, input)
  return ref ? themeLink(p, ref, input, field) : field
}

/**
 * The colour field as Penpot draws it: the swatch (the native picker), the
 * hex value to read and to type, and — when the colour has one — its
 * opacity, with '%' inside the field and scrubbable. Each part keeps THE
 * FIELD's own box (#729). A typed hex goes through the picker's own
 * 'change', so everything a picked colour does — the edit, clearing a
 * palette reference — a typed one does too.
 */
export function colorField(col: HTMLInputElement, alpha?: HTMLInputElement, unpainted = false): HTMLElement {
  const box = document.createElement('div')
  box.className = 'ed-color'
  const hex = document.createElement('input')
  hex.type = 'text'
  hex.className = 'ed-color-hex'
  hex.spellcheck = false
  hex.maxLength = 9 // #rrggbbaa: an alpha may be typed too
  hex.setAttribute('aria-label', `${t('Color')} (hex)`)
  // a fully transparent colour reads None, not a hex nobody can see
  const show = () => {
    const none = !!alpha && alphaOf(alpha) === 0
    hex.value = none ? '' : col.value.slice(1)
    hex.placeholder = none ? t('None') : ''
  }
  show()
  col.addEventListener('input', show)
  alpha?.addEventListener('change', show)
  alpha?.addEventListener(SCRUB, show)
  col.setAttribute('aria-label', t('Color'))
  hex.addEventListener('change', () => {
    const v = hex.value.trim().replace(/^#/, '')
    const full = /^[0-9a-f]{3}$/i.test(v) ? [...v].map((c) => c + c).join('') : v
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) {
      // a colour typed where there was no paint at all (absent, or the
      // literal 'transparent' — a frame's unfilled box) is meant to be seen:
      // it comes in at 100%. A fill the user set to 0% keeps its 0% (colour
      // and opacity are separate fields, as in Figma). A typed alpha wins.
      const was = alpha?.value
      if (alpha && full.length === 8) alpha.value = String(Math.round((parseInt(full.slice(6), 16) / 255) * 100))
      else if (alpha && unpainted && alphaOf(alpha) === 0) alpha.value = '100'
      const next = '#' + full.slice(0, 6).toLowerCase()
      if (next !== col.value || alpha?.value !== was) {
        col.value = next
        col.dispatchEvent(new Event('input'))
        col.dispatchEvent(new Event('change'))
      }
    }
    show()
  })
  // Enter commits and hands the keyboard back to the canvas, as a number
  // field's does (DECISIONS 2026-10-30). Commit while still focused: the
  // panel then holds its rebuild until the edit's input and change are both
  // in, so the colour stays one undo step (the blur's own 'change' finds
  // nothing new)
  hex.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
    e.preventDefault(); e.stopPropagation()
    hex.dispatchEvent(new Event('change'))
    hex.blur()
  })
  box.append(col, hex)
  if (alpha) {
    const a = document.createElement('label')
    a.className = 'ed-mini ed-color-alpha'
    a.style.setProperty('--lab', '9px')
    a.append(unitHandle('%', alpha), alpha)
    box.append(a)
  }
  return box
}

/** Write a colour and its palette reference together, as one undoable edit. */
export function setRef(p: PropsPanel, ref: { id: string | null; path: string; slide?: Slide }, literal: string, token: string | null) {
  p.edit(() => {
    const holder = ref.id ? p.store.element(ref.id) : (ref.slide ?? p.store.slide)
    if (holder) setColor(holder as never, ref.path, literal, token)
  }, true)
}

/**
 * The deck's theme colours, Penpot's library way. A palette button at the
 * end of the colour field opens them, each swatch with its name; a colour
 * taken from there shows the NAME in the field instead of a hex (it follows
 * the theme now), with a button to detach it back to a plain colour.
 *
 * Choosing one records WHERE the colour came from, so editing the theme later
 * re-derives it — that is the whole difference between a deck that can be
 * re-branded and one that has 400 hex literals in it.
 */
export function themeLink(p: PropsPanel, ref: { id: string | null; path: string; slide?: Slide }, input: HTMLInputElement, field: HTMLElement): HTMLElement {
  const holder = (ref.id ? p.store.element(ref.id) : (ref.slide ?? p.store.slide)) as never
  const rawRef = holder ? refAt(holder, ref.path) : undefined
  const tok = tokenName(rawRef)
  const linked = tok ? undefined : slotOf(rawRef)
  const linkedLabel = tok ?? (linked && slotLabel(linked))
  const outer = document.createElement('div')
  outer.className = 'ed-colorref'
  // follow a theme colour (a palette ref) or a colour token (a `$name` ref);
  // either way the field keeps its own opacity — unless it had none: a pick must show
  const follow = (c: Choice) => {
    const a = field.querySelector<HTMLInputElement>('.ed-color-alpha input')
    if (c.kind === 'slot') {
      const base = String(c.value)
      input.value = /^#[0-9a-fA-F]{6}$/.test(base) ? base : parseColor(base).hex
      setRef(p, ref, a ? combineColor(input.value, alphaOf(a) || 1) : base, c.key as (typeof PALETTE_SLOTS)[number])
    } else {
      p.edit(() => {
        const h = ref.id ? p.store.element(ref.id) : (ref.slide ?? p.store.slide)
        if (h) { opaque(h, ref.path); bindToken(p.store.doc, h as never, ref.path, c.key) }
      }, true)
    }
  }
  choosers.set(input, follow)
  const detach = () => {
    const a = field.querySelector<HTMLInputElement>('.ed-color-alpha input')
    setRef(p, ref, a ? combineColor(input.value, alphaOf(a)) : input.value, null)
  }
  const pick = (anchor: HTMLElement) => {
    const hex = () => input.value.toLowerCase()
    const manage = { icon: ICONS.settings, label: t('Manage tokens'), run: () => document.querySelector<HTMLElement>('.ed-side-tabs [data-view="tokens"]')?.click() }
    openTokenPicker(anchor, {
      title: t('Colors & tokens'),
      choices: choices(p.store.doc, ['color']),
      bound: tok ?? linked,
      pick: follow,
      // adopting a literal: the deck's brand colour is usually typed in many
      // places before anyone thinks of a token — make the token from it, and
      // every use follows; or find every use on this slide
      actions: linkedLabel
        ? [{ icon: ICONS.minus, label: tok ? t('Detach from token') : t('Detach from theme color'), run: detach }, manage]
        : [
          // the colour is already a theme colour or a token: bind its uses to
          // that one rather than make a second token with the same value
          ...((same) => same ? [{ icon: ICONS.viewTokens, label: bindUses(same.kind === 'token' ? same.key : same.label, colorUses(p.store.doc, hex()).length), run: () => {
            const uses = colorUses(p.store.doc, hex())
            p.store.commit(() => followChoice(p.store.doc, uses.map((u) => ({ holder: (u.element ?? u.slide) as unknown as Record<string, unknown>, path: u.path })), same))
            p.toast(usesFollow(same.kind === 'token' ? same.key : same.label, uses.length))
          } }] : [{ icon: ICONS.tokenNew, label: t('Make a token from this color'), run: () => {
            const name = freeTokenName(p.store.doc, 'color.brand')
            let n = 0
            p.store.commit(() => { n = adoptColor(p.store.doc, hex(), name) })
            p.toast(madeToken(name, n))
            document.querySelector<HTMLElement>('.ed-side-tabs [data-view="tokens"]')?.click()
          } }])(sameAs(p.store.doc, hex())),
          { icon: ICONS.selectSame, label: t('Select all with this color'), run: () => {
            const ids = colorUses(p.store.doc, hex()).filter((u) => u.slide === p.store.slide && u.element).map((u) => u.element!.id)
            p.store.select([...new Set(ids)])
            p.toast(t('{n} elements on this slide use this color', { n: new Set(ids).size }))
          } },
          manage,
        ],
    })
  }
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'ed-btn ed-tool ed-color-open'
  open.innerHTML = ICONS.palette
  open.title = t('Colors & tokens')
  open.setAttribute('aria-label', t('Colors & tokens'))
  open.setAttribute('aria-haspopup', 'dialog')
  open.addEventListener('click', () => pick(open))
  // a bound field shows the name as a pill (Figma's)
  if (linkedLabel) field.querySelector<HTMLElement>('.ed-color-hex')?.replaceWith(boundPill(linkedLabel, !!tok, () => pick(open), detach))
  field.appendChild(open)
  outer.append(field)
  colorPickers.set(outer, pick)
  return outer
}

/** Each colour field's Colors & tokens picker, so a section's ⠿ (Figma's
 *  catalog) opens the one for its row — the field's own button stays out of
 *  sight in a paint row. */
export const colorPickers = new WeakMap<HTMLElement, (anchor: HTMLElement) => void>()

/** Make every (holder, path) follow a theme colour or a colour token; each
 *  keeps its own opacity. The caller wraps it in one commit (one undo step). */
export function followChoice(doc: BentoDoc, uses: Array<{ holder: Record<string, unknown>; path: string }>, c: Choice) {
  for (const { holder, path } of uses) {
    if (c.kind === 'slot') setColor(holder as never, path, keepAlpha(readAt(holder, path), String(c.value)), c.key)
    else { opaque(holder, path); bindToken(doc, holder as never, path, c.key) }
  }
}

/** The theme colour or token whose value is this colour, if one is. */
function sameAs(doc: BentoDoc, hex: string): Choice | undefined {
  const want = parseColor(hex).hex.toLowerCase()
  return choices(doc, ['color']).find((c) => parseColor(String(c.value)).hex.toLowerCase() === want)
}

/**
 * Fill, Stroke or Text colour on a multi-selection: the same picker, binding
 * every element at once (one undo step); when every element follows the same
 * theme colour or token the field shows it as a pill, like a single one.
 */
export function sharedLink(p: PropsPanel, ids: string[], path: string, field: HTMLElement): HTMLElement {
  const holders = () => ids.map((id) => p.store.element(id)).filter(Boolean) as unknown as Array<Record<string, unknown> & { themeRefs?: Record<string, string> }>
  const refs = holders().map((h) => h.themeRefs?.[path])
  const common = refs.every((r) => r && r === refs[0]) ? refs[0] : undefined
  const tok = tokenName(common)
  const bound = tok ?? slotOf(common)
  const detach = () => p.edit(() => { for (const h of holders()) setColor(h as never, path, String(readAt(h, path) ?? ''), null) }, true)
  const pick = (anchor: HTMLElement) => openTokenPicker(anchor, {
    title: t('Colors & tokens'),
    choices: choices(p.store.doc, ['color']),
    bound,
    pick: (c) => p.edit(() => followChoice(p.store.doc, holders().map((holder) => ({ holder, path })), c), true),
    actions: bound ? [{ icon: ICONS.minus, label: tok ? t('Detach from token') : t('Detach from theme color'), run: detach }] : [],
  })
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'ed-btn ed-tool ed-color-open'
  open.innerHTML = ICONS.palette
  open.title = t('Colors & tokens')
  open.setAttribute('aria-label', t('Colors & tokens'))
  open.setAttribute('aria-haspopup', 'dialog')
  open.addEventListener('click', () => pick(open))
  if (bound) field.querySelector<HTMLElement>('.ed-color-hex')?.replaceWith(boundPill(tok ?? slotLabel(bound), !!tok, () => pick(open), detach))
  // the popover's theme swatches bind every element too
  const col = field.querySelector<HTMLInputElement>('input[type=color]')
  if (col) choosers.set(col, (c) => p.edit(() => followChoice(p.store.doc, holders().map((holder) => ({ holder, path })), c), true))
  field.appendChild(open)
  return field
}

/** The name a bound colour field shows instead of its hex: a click reopens
 *  the picker, the detach icon (on hover or focus) lets go and keeps the value. */
function boundPill(label: string, isToken: boolean, reopen: () => void, detach: () => void): HTMLElement {
  const token = document.createElement('span')
  token.className = 'ed-color-token'
  const name = document.createElement('button')
  name.type = 'button'
  name.className = 'ed-color-token-name'
  name.textContent = label
  name.title = isToken
    ? t('Follows the token “{name}”. Click to change.', { name: label })
    : t('Follows the theme color “{name}”. Click to change.', { name: label })
  name.addEventListener('click', reopen)
  const off = document.createElement('button')
  off.type = 'button'
  off.className = 'ed-color-detach'
  off.innerHTML = ICONS.unlink
  off.title = isToken ? t('Detach from token') : t('Detach from theme color')
  off.setAttribute('aria-label', off.title)
  off.addEventListener('click', detach)
  token.append(name, off)
  return token
}

/** How a colour field follows a theme colour or token picked in its popover. */
const choosers = new WeakMap<HTMLInputElement, (c: Choice) => void>()

/** Color swatch + opacity %. Native color inputs have no alpha channel, so
 *  the pair round-trips rgba()/#rrggbbaa strings losslessly. */
export function colorAlpha(p: PropsPanel, value: string, onEdit: (v: string, final: boolean) => void, ref?: { id: string | null; path: string; slide?: Slide }, paint?: PaintHost): HTMLElement {
  const parsed = parseColor(value)
  const col = document.createElement('input')
  col.type = 'color'
  col.value = parsed.hex
  const alpha = document.createElement('input')
  alpha.min = '0'
  alpha.max = '100'
  alpha.step = '1'
  alpha.value = String(Math.round(parsed.a * 100))
  numeric(alpha, '%')
  alpha.title = t('Opacity %')
  alpha.setAttribute('aria-label', alpha.title) // the wrapping label's '%' would name it otherwise
  const emit = (final: boolean) => onEdit(combineColor(col.value, alphaOf(alpha)), final)
  col.addEventListener('input', () => emit(false))
  // picking by hand clears the palette reference — see color() for why — in
  // the same edit as the colour. The opacity % keeps the reference: a
  // reference names the hue, and the theme re-derives it with this alpha kept.
  col.addEventListener('change', () => {
    if (ref) setRef(p, ref, combineColor(col.value, alphaOf(alpha)), null)
    else emit(true)
  })
  alpha.addEventListener('change', () => emit(true))
  alpha.addEventListener(SCRUB, () => emit(false))
  const wrap = colorField(col, alpha, !value || value.trim().toLowerCase() === 'transparent')
  popoverOn(p, col, alpha, paint)
  return ref ? themeLink(p, ref, col, wrap) : wrap
}

/**
 * The swatch opens the colour popover instead of the browser's picker. The
 * popover drives the same <input type=color> (and % field) the inline row
 * does, so it takes every path a typed hex takes: live preview, the palette
 * reference cleared by a hand-picked colour, one undo step. Esc undoes the
 * preview burst, so a cancelled pick leaves no step and no change.
 */
function popoverOn(p: PropsPanel, col: HTMLInputElement, alpha?: HTMLInputElement, paint?: PaintHost) {
  const swatch = () => {
    const a = alpha ? alphaOf(alpha) : 1
    col.classList.toggle('ed-see-through', a < 1)
    col.style.setProperty('--see', combineColor(col.value, a))
  }
  swatch()
  if (paint) col.dataset.paint = paint.target // the gradient chip takes this place: settle() finds either
  col.addEventListener('input', swatch)
  alpha?.addEventListener('change', swatch)
  alpha?.addEventListener(SCRUB, swatch)
  col.addEventListener('click', (e) => {
    e.preventDefault() // never the native picker
    const set = (hex: string, a: number) => {
      col.value = hex
      if (alpha) alpha.value = String(Math.round(a * 100))
      col.dispatchEvent(new Event('input'))
    }
    openColorPopover(col, {
      hex: col.value,
      alpha: alpha ? alphaOf(alpha) : undefined,
      groups: colorGroups(p.store.doc, (c) => {
        // a field that can follow (a palette/token ref) follows; any other
        // colour — a gradient stop, a token's own value — takes the literal
        const follow = choosers.get(col)
        if (follow) return follow(c)
        const v = parseColor(String(c.value)); set(v.hex, v.a); col.dispatchEvent(new Event('change'))
      }).concat([
        { title: t('On this slide'), swatches: slideColors(p).map((c) => ({ label: c, color: cssColor(c, 'transparent'), pick: () => { const v = parseColor(c); set(v.hex, v.a); col.dispatchEvent(new Event('change')) } })) },
      ]),
      preview: set,
      commit: () => col.dispatchEvent(new Event('change')),
      cancel: () => p.cancelBurst(),
      paint,
      done: paint ? () => settle(p, paint.target) : undefined,
    })
  })
}

/** The theme colours and colour tokens as the colour popover's swatch groups,
 *  named as the Tokens view and the token picker name them. */
export function colorGroups(doc: BentoDoc, pick: (c: Choice) => void): Array<{ title: string; swatches: Array<{ label: string; color: string; pick: () => void }> }> {
  const all = choices(doc, ['color'])
  const groups = new Map<string, Choice[]>()
  for (const c of all) groups.set(c.group, [...(groups.get(c.group) ?? []), c])
  return [...groups].map(([title, cs]) => ({ title, swatches: cs.map((c) => ({ label: c.kind === 'token' ? c.key : c.label, color: cssColor(String(c.value), 'transparent'), pick: () => pick(c) })) }))
}

/** The distinct colours the current slide already uses, for one-click reuse. */
function slideColors(p: PropsPanel): string[] {
  const out = new Map<string, string>()
  const add = (v: unknown) => {
    if (typeof v !== 'string' || !v || v === 'none' || v === 'transparent' || v.includes('gradient')) return
    const c = parseColor(v)
    if (c.a > 0) out.set(combineColor(c.hex, c.a), combineColor(c.hex, c.a))
  }
  const slide = p.store.slide
  add(slide.background)
  for (const el of slide.elements) for (const k of ['fill', 'color', 'stroke'] as const) add((el as unknown as Record<string, unknown>)[k])
  return [...out.values()].slice(0, 16)
}
