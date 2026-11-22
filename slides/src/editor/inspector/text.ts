// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Text: font, size, weight, fill, stroke, fields.
import { tokenBind, tokenWrap } from './tokenbind'
import type { PropsPanel } from '../panels'
import type { TextElement } from '../../model'
import { ICONS } from '../../icons'
import { t } from '../../i18n'
import { measureElement } from '../../measure'
import { formatDate, DATE_PRESETS, TIME_PRESETS, OTHER_FIELDS } from '../../datefmt'
import { openCtxMenu } from '../ctxmenu'
import { field, mini, segmented, section, withIcon } from './fields'
import { paintRow, colorCatalog } from './paintrow'
import { colorAlpha, gradientRows, gradientChip, paintHost } from './color'
import { firstFamily, FONT_CHOICES, injectFonts } from '../../fonts'
import { fontFaceDescriptors } from '../../fontmeta'

/**
 * "Fit height to text" — set `h` to exactly what the content needs.
 *
 * A box that is too short lets its text spill over whatever sits below, and
 * one that is too tall throws off vertical alignment against its neighbours;
 * neither is visible in the numbers. The button reports the delta so it is
 * obvious whether anything was wrong before you press it.
 */
export function buildFitHeight(p: PropsPanel, el: TextElement): HTMLElement {
  const fit = document.createElement('button')
  fit.type = 'button'
  fit.className = 'ed-btn ed-tool'
  fit.innerHTML = ICONS.fitHeight
  fit.setAttribute('aria-label', t('Fit height to text'))
  if (!el.html?.trim()) { // nothing to measure yet
    fit.disabled = true
    fit.title = t('Fit height to text')
    return fit
  }
  const m = measureElement(el, p.store.doc)
  fit.title = `${t('Fit height to text')}\n${t('The text needs {need}px and the box is {have}px',
    { need: String(m.height), have: String(el.h) })}`
  if (m.height === el.h) fit.disabled = true
  fit.addEventListener('click', () => {
    // measure again at click time — the text may have been edited since the
    // panel was built, and a stale height is worse than no button
    const fresh = measureElement(p.store.element(el.id) as TextElement, p.store.doc)
    p.mutate(el.id, (e) => { e.h = fresh.height }, true)
  })
  return fit
}

/** "Insert field": drops a {{token}} at the end of the text (discussion
 *  #381 — the tokens existed since 0.9.12 but nothing in the editor said
 *  so). Date and time offer presets whose labels show TODAY in that shape,
 *  so the choice is made by eye; the pattern is in the token for anyone who
 *  wants to edit it. Appends rather than inserts at a caret: choosing from
 *  the panel blurs the text box and commits the edit, so there is no caret
 *  to honour — the token lands at the end, inside the last block, and the
 *  author moves it like any other text. */
export function buildFieldPicker(p: PropsPanel, el: TextElement): HTMLElement {
  const now = new Date()
  const fmt = (token: string) => { const m = /^\{\{(?:date|time):(.*)\}\}$/.exec(token); return m ? formatDate(now, m[1]) : '' }
  const pairs: Array<[string, string]> = []
  for (const p of DATE_PRESETS) pairs.push([p.token, p.token === '{{date}}' ? t(p.label) : `${t('Date')} — ${fmt(p.token)}`])
  for (const p of TIME_PRESETS) pairs.push([p.token, p.token === '{{time}}' ? t(p.label) : `${t('Time')} — ${fmt(p.token)}`])
  for (const p of OTHER_FIELDS) pairs.push([p.token, t(p.label)])
  const insert = (token: string) => p.mutate(el.id, (e) => {
    const tx = e as TextElement
    const html = tx.html ?? ''
    // inside the last block if there is one, so the token joins the last
    // line rather than starting a stray one after </p>
    const m = /<\/(p|div|li)>\s*$/i.exec(html)
    const at = m ? m.index : html.length
    const sep = at > 0 && !/[\s>]$/.test(html.slice(0, at)) ? ' ' : ''
    tx.html = html.slice(0, at) + sep + token + html.slice(at)
  }, true)
  // a tool among the text tools, its list a menu — a dropdown that reads
  // 'Insert field…' sat among the settings looking like one of them
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn ed-tool'
  b.innerHTML = ICONS.braces
  b.title = `${t('Insert field…')}\n${t('Page number, date, time, title and the document properties — resolved when the slide is shown. Date and time can pin a format: {{date:M/D/YY}}; edit the pattern in the text.')}`
  b.setAttribute('aria-label', t('Insert field…'))
  b.setAttribute('aria-haspopup', 'menu')
  b.addEventListener('click', () => {
    const r = b.getBoundingClientRect()
    openCtxMenu(r.left, r.bottom + 4, pairs.map(([token, label]) => ({ label, run: () => insert(token) })))
  })
  return b
}

export function buildTextProps(p: PropsPanel, el: TextElement) {
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.innerHTML = t('While editing: <b>⌘B</b>/<b>⌘I</b>/<b>⌘U</b> · markdown auto-converts — **bold*&#8203;* *italic*&#8203; `code` ~~strike~~ and "- " bullets; pasting markdown converts too. Escape with \\ or press ⌘Z right after to keep the literal characters.')
  p.host.appendChild(hint)
  // Penpot's Text block: family; size and weight; line height and tracking;
  // then the alignments and the list tools as one icon row each.
  const font = fontSelect(p, el)
  font.setAttribute('aria-label', t('Font'))
  font.title = t('Font')
  field(p, tokenWrap(p, withIcon(font, ICONS.text), el, 'fontFamily', ['fontFamily']))

  const sizes = document.createElement('div')
  sizes.className = 'ed-grid2'
  // Shown in POINTS (the unit office users know); the model stores slide-space
  // px. 1pt = 4/3 px at the slide's 96dpi space, so 32px = 24pt exactly.
  const size = mini('pt', Math.round(el.fontSize * 0.75 * 10) / 10, (v, fin) =>
    p.mutate(el.id, (e) => {
      (e as TextElement).fontSize = Math.round(Math.max(v, 3) * (4 / 3) * 100) / 100
    }, fin), undefined, { min: 3 })
  size.title = t('Size (pt)')
  size.querySelector('input')!.setAttribute('aria-label', size.title) // not 'pt'
  const weight = weightSelect(p, el)
  weight.title = t('Weight')
  weight.setAttribute('aria-label', t('Weight'))
  sizes.append(tokenBind(p, size, el, 'fontSize', ['fontSize', 'number']), withIcon(weight, ICONS.weight),
    mini(t('Line height'), el.lineHeight, (v, fin) =>
      p.mutate(el.id, (e) => { (e as TextElement).lineHeight = Math.max(Math.round(v * 100) / 100, 0.5) }, fin), ICONS.lineHeight, { min: 0.5 }),
    mini(t('Letter spacing'), el.letterSpacing ?? 0, (v, fin) =>
      p.mutate(el.id, (e) => {
        const tx = e as TextElement
        if (v) tx.letterSpacing = v
        else delete tx.letterSpacing
      }, fin), ICONS.letterSpacing))
  ;(sizes.children[2].querySelector('input') as HTMLInputElement).step = '0.05'
  p.host.appendChild(sizes)

  const align = segmented(['left', 'center', 'right'], el.align, (v) =>
    p.mutate(el.id, (e) => { (e as TextElement).align = v as TextElement['align'] }, true))
  align.setAttribute('aria-label', t('Align'))
  const valign = segmented(['top', 'middle', 'bottom'], el.valign, (v) =>
    p.mutate(el.id, (e) => { (e as TextElement).valign = v as TextElement['valign'] }, true))
  valign.setAttribute('aria-label', t('Vertical align'))
  field(p, align, valign).classList.add('ed-line-even')

  // Indent / Outdent bullets (#368): the item under the caret while the box
  // is open — a press here must not take the caret away, so mousedown is
  // held — else the whole box. Tab / ⇧Tab do the same while editing.
  const tools: HTMLElement[] = []
  for (const [dir, icon, label, tip] of [
    [-1, ICONS.outdent, t('Outdent'), t('Move the bullet up a level (⇧Tab while editing)')],
    [1, ICONS.indent, t('Indent'), t('Move the bullet down a level, under the one above (Tab while editing)')],
  ] as const) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn ed-tool'
    b.innerHTML = icon
    b.setAttribute('aria-label', label)
    b.title = tip
    b.addEventListener('mousedown', (ev) => ev.preventDefault())
    b.addEventListener('click', (ev) => { ev.preventDefault(); p.onListIndent?.(dir) })
    tools.push(b)
  }
  field(p, ...tools, buildFitHeight(p, el), buildFieldPicker(p, el))
}

/** Text fill: a solid colour, or a multi-stop gradient painted into the glyphs. */
export function buildTextFill(p: PropsPanel, el: TextElement) {
  // Figma's: a text fill is a layer like any other — 👁 hides it, − removes it
  // (the text keeps its place, drawn with no fill), + brings one back
  const none = el.color === 'transparent' && !el.colorGradient
  const add = () => p.mutate(el.id, (e) => { (e as TextElement).color = '#1E2A3A'; delete e.fillHidden }, true)
  section(p, t('Fill'), none ? { add: true, hint: t('Add fill'), run: add } : undefined, colorCatalog(p, none ? add : undefined))
  if (none) return
  const tgrad = el.colorGradient
  const host = paintHost(p, el.id, 'color', 'colorGradient', 90)
  const eye = { hidden: !!el.fillHidden, toggle: () => p.mutate(el.id, (e) => { if (e.fillHidden) delete e.fillHidden; else e.fillHidden = true }, true) }
  const remove = () => p.mutate(el.id, (e) => { const tx = e as TextElement; tx.color = 'transparent'; delete tx.colorGradient; delete tx.fillHidden; delete tx.themeRefs?.color }, true)
  if (host.kind === 'solid' || !tgrad) {
    paintRow(p, colorAlpha(p, el.color, (v, fin) =>
      p.mutate(el.id, (e) => { (e as TextElement).color = v }, fin),
      { id: el.id, path: 'color' }, host), eye, remove)
  } else {
    paintRow(p, gradientChip(p, host), eye, remove)
    gradientRows(p, tgrad, (fn, fin) => p.mutate(el.id, (e) => {
      const g = (e as TextElement).colorGradient
      if (g) fn(g)
    }, fin), host.target)
  }
}

/** Text outline — hollow or outlined glyphs, an optional layer like a shape's stroke. */
export function buildTextStroke(p: PropsPanel, el: TextElement) {
  const ts = el.textStroke
  const add = () => p.mutate(el.id, (e) => {
    const tx = e as TextElement
    tx.textStroke = { color: '#1E2A3A', ...(tx.textStroke ?? {}), width: 1 }
    delete tx.strokeHidden
  }, true)
  // one outline per text: + adds it, the row's − removes it, 👁 hides it
  section(p, t('Stroke'), ts?.width ? undefined : { add: true, hint: t('Add stroke'), run: add }, colorCatalog(p, ts?.width ? undefined : add))
  if (!ts?.width) return
  paintRow(p, colorAlpha(p, ts.color, (v, fin) =>
    p.mutate(el.id, (e) => {
      const g = (e as TextElement).textStroke
      if (g) g.color = v
    }, fin), { id: el.id, path: 'textStroke.color' }),
  { hidden: !!el.strokeHidden, toggle: () => p.mutate(el.id, (e) => { if (e.strokeHidden) delete e.strokeHidden; else e.strokeHidden = true }, true) },
  () => p.mutate(el.id, (e) => { delete (e as TextElement).textStroke; delete e.strokeHidden }, true))
  const w = mini(t('Width'), ts.width, (v, fin) =>
    p.mutate(el.id, (e) => {
      const tx = e as TextElement
      if (v > 0) tx.textStroke = { color: '#1E2A3A', ...(tx.textStroke ?? {}), width: v }
      else delete tx.textStroke
    }, fin), undefined, { min: 0 })
  const interior = segmented(['filled', 'hollow'], ts.fill === 'none' ? 'hollow' : 'filled', (v) =>
    p.mutate(el.id, (e) => {
      const g = (e as TextElement).textStroke
      if (g) { if (v === 'hollow') g.fill = 'none'; else delete g.fill }
    }, true))
  interior.setAttribute('aria-label', t('Interior'))
  // the width beside nothing it could crowd; the words ('filled' / 'hollow')
  // get a line of their own, so no translation is cut
  const grid = document.createElement('div')
  grid.className = 'ed-grid2'
  grid.append(w)
  p.host.appendChild(grid)
  field(p, interior)
}

/**
 * Font picker: theme default, curated system stacks, fonts embedded in the
 * document, and (if unmatched) the element's current custom stack. Options
 * render in their own face so the menu previews itself.
 */
export function fontSelect(p: PropsPanel, el: TextElement): HTMLElement {
  const sel = document.createElement('select')
  const current = el.fontFamily ?? ''
  const add = (label: string, value: string, selected: boolean) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    o.style.fontFamily = value || 'inherit'
    o.selected = selected
    sel.appendChild(o)
    return o
  }
  const curFirst = firstFamily(current)
  let matched = false
  add(t('Theme font'), '', current === '')
  for (const f of p.store.doc.fonts ?? []) {
    const hit = !matched && (current === f.family || curFirst === firstFamily(f.family))
    if (hit) matched = true
    add(t('{name} (embedded)', { name: f.family }), f.family, hit)
  }
  for (const c of FONT_CHOICES) {
    const hit = !matched && current !== '' && curFirst === firstFamily(c.stack)
    if (hit) matched = true
    add(c.label, c.stack, hit)
  }
  if (current && !matched) add(curFirst || t('Custom'), current, true)
  // bringing in a font is where you look for fonts: the list's last entry
  const EMBED = '\u0000embed'
  const chosen = sel.selectedIndex
  const embed = add(t('＋ Embed font file…'), EMBED, false)
  embed.style.fontFamily = 'inherit'
  embed.title = t('Bundle a .woff2/.woff/.ttf/.otf into this file and use it here')
  sel.addEventListener('change', () => {
    if (sel.value === EMBED) {
      sel.selectedIndex = chosen // the choice stays the font in use
      embedFont(p, el)
      return
    }
    p.mutate(el.id, (e) => { (e as TextElement).fontFamily = sel.value }, true)
  })
  return sel
}

/** Bundle a font file into the document and apply it to this element. */
export function embedFont(p: PropsPanel, el: TextElement) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.woff2,.woff,.ttf,.otf'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const family = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Embedded font'
      const asset = `font_${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
      const src = String(reader.result)
      // the weights and style the file states (#850): otherwise every face is
      // declared 400 and Bold on a variable or bold font is faux bold
      const faces = await fontFaceDescriptors(new Uint8Array(await file.arrayBuffer()), src)
      p.store.commit(() => {
        const doc = p.store.doc
        doc.assets = { ...(doc.assets ?? {}), [asset]: src }
        doc.fonts = [...(doc.fonts ?? []).filter((f) => f.family !== family), { family, asset, ...faces }]
        const live = p.store.element(el.id)
        if (live && live.type === 'text') live.fontFamily = family
      })
      injectFonts(p.store.doc)
      p.toast(t('“{name}” embedded in this file', { name: family }))
    }
    reader.readAsDataURL(file)
  })
  input.click()
}

/** Weight picker with the familiar named weights; stores the numeric value. */
export function weightSelect(p: PropsPanel, el: TextElement): HTMLElement {
  const WEIGHTS: Array<[number, string]> = [
    [100, 'Thin'], [200, 'Extra light'], [300, 'Light'], [400, 'Regular'],
    [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black'],
  ]
  const sel = document.createElement('select')
  const current = el.fontWeight ?? 400
  if (!WEIGHTS.some(([n]) => n === current)) {
    const o = document.createElement('option')
    o.value = String(current)
    o.textContent = t('Custom ({n})', { n: current })
    o.selected = true
    sel.appendChild(o)
  }
  for (const [n, name] of WEIGHTS) {
    const o = document.createElement('option')
    o.value = String(n)
    o.textContent = t(name)
    o.style.fontWeight = String(n)
    if (n === current) o.selected = true
    sel.appendChild(o)
  }
  sel.addEventListener('change', () =>
    p.mutate(el.id, (e) => { (e as TextElement).fontWeight = parseInt(sel.value) }, true))
  return sel
}
