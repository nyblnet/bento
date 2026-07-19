// Present mode: a fullscreen Reveal.js overlay generated from the model.
// Slides marked transition:'morph' use GSAP Flip to animate elements whose
// ids match across the two slides (PowerPoint "Morph" behaviour).

import Reveal from 'reveal.js'
import 'reveal.js/dist/reveal.css'
import { anim, resetXform } from './anim'
import { chartSnapshotSvg, mountChart } from './charts'
import type { BentoDoc, GradientFill, ShapeElement, Slide, SlideElement } from './model'
import { applyElementFrame, gradientLineCoords, renderSlide } from './render'
import { t } from './i18n'

const MORPH_DURATION = 0.65
const MORPH_EASE = 'power2.inOut'

export interface PresentSession {
  exit(): void
}

export function startPresentation(
  doc: BentoDoc,
  startIndex: number,
  onExit: (lastIndex: number) => void,
  opts: { fullscreen?: boolean } = {},
): PresentSession {
  const overlay = document.createElement('div')
  overlay.className = 'bento-present-overlay'
  overlay.style.setProperty('--bento-accent', doc.theme.accent)
  // Reveal ignores key events originating from form fields. If focus is still
  // on an editor input (title, notes…) when the show starts, arrows go dead.
  ;(document.activeElement as HTMLElement | null)?.blur?.()

  const revealEl = document.createElement('div')
  revealEl.className = 'reveal'
  const slidesEl = document.createElement('div')
  slidesEl.className = 'slides'
  revealEl.appendChild(slidesEl)
  overlay.appendChild(revealEl)

  doc.slides.forEach((slide) => {
    const section = document.createElement('section')
    // Morph slides swap instantly; the Flip animation supplies the motion.
    section.dataset.transition = slide.transition === 'morph' ? 'none' : slide.transition
    if (slide.stateOf) section.dataset.bentoState = '1' // dimmed in overview
    const surface = renderSlide(slide, doc, { hidePlaceholders: true })
    // reveal slides start with only the default hover set visible
    if (slide.hover?.type === 'reveal') applyRevealSet(surface, slide.hover.default ?? null, slide.hover.default)
    section.appendChild(surface)
    if (slide.notes) {
      const aside = document.createElement('aside')
      aside.className = 'notes'
      aside.textContent = slide.notes
      section.appendChild(aside)
    }
    slidesEl.appendChild(section)
  })

  document.body.appendChild(overlay)

  // ——— state-aware linear navigation ———
  // Slides with stateOf are interactive states: linked-to, never walked-to.
  const isState = (i: number) => !!doc.slides[i]?.stateOf
  const anchorOf = (i: number) => {
    const pid = doc.slides[i]?.stateOf
    const p = doc.slides.findIndex((s) => s.id === pid)
    return p >= 0 ? p : i
  }
  const goNext = () => {
    const cur = deck.getIndices().h
    for (let i = (isState(cur) ? anchorOf(cur) : cur) + 1; i < doc.slides.length; i++) {
      if (!isState(i)) return deck.slide(i, 0)
    }
  }
  const goPrev = () => {
    const cur = deck.getIndices().h
    if (isState(cur)) return deck.slide(anchorOf(cur), 0)
    for (let i = cur - 1; i >= 0; i--) {
      if (!isState(i)) return deck.slide(i, 0)
    }
  }
  const hasNext = () => {
    const cur = deck.getIndices().h
    for (let i = (isState(cur) ? anchorOf(cur) : cur) + 1; i < doc.slides.length; i++) {
      if (!isState(i)) return true
    }
    return false
  }
  const hasPrev = () => {
    const cur = deck.getIndices().h
    if (isState(cur)) return true // right-swipe returns to the parent slide
    for (let i = cur - 1; i >= 0; i--) {
      if (!isState(i)) return true
    }
    return false
  }
  const visibleIndex = (i: number) => doc.slides.slice(0, i + 1).filter((s) => !s.stateOf).length
  const visibleTotal = doc.slides.filter((s) => !s.stateOf).length

  let exited = false
  const deck = new Reveal(revealEl, {
    embedded: true,
    width: doc.size.width,
    height: doc.size.height,
    margin: 0,
    center: false,
    hash: false,
    history: false,
    transition: 'fade',
    transitionSpeed: 'default',
    backgroundTransition: 'fade',
    controls: doc.present?.controls ?? false, // links/keys navigate; corner arrows are clutter
    progress: doc.present?.progress ?? true,
    slideNumber: (doc.present?.slideNumber ?? true)
      ? (((slideEl: HTMLElement) => {
          const i = [...slidesEl.children].indexOf(slideEl)
          return [`${visibleIndex(i)} / ${visibleTotal}`]
        }) as any)
      : false,
    // touch is handled by our own swipe logic below (state-aware + ends exit)
    touch: false,
    // heavy decks: paint only the neighbourhood of the current slide
    viewDistance: 1,
    keyboardCondition: null,
    plugins: [],
  })

  const onResize = () => deck.layout()

  // ——— speaker view (S) ———
  // Reveal's stock speaker window reloads the presentation URL in iframes —
  // which in a Bento file boots the EDITOR. Instead: our own popup, rendered
  // with the same renderer from this one app instance and synced directly.
  let speaker: Window | null = null
  let speakerTimer = 0
  let speakerStart = 0
  // opening the speaker popup drops the main window out of OS fullscreen on most
  // browsers; this guards the fullscreenchange handler so that bounce doesn't
  // end the show (see onFsChange).
  let openingSpeaker = false
  const nextVisibleIndex = (from: number) => {
    for (let i = (isState(from) ? anchorOf(from) : from) + 1; i < doc.slides.length; i++) {
      if (!isState(i)) return i
    }
    return -1
  }
  const svSlide = (idx: number, w: number): HTMLElement => {
    const frame = document.createElement('div')
    frame.className = 'sv-frame'
    const scale = w / doc.size.width
    frame.style.width = `${w}px`
    frame.style.height = `${doc.size.height * scale}px`
    if (idx >= 0) {
      const inner = document.createElement('div')
      inner.style.cssText = `transform:scale(${scale});transform-origin:0 0`
      inner.appendChild(renderSlide(doc.slides[idx], doc, { hidePlaceholders: true }))
      frame.appendChild(inner)
    } else {
      frame.classList.add('end')
      frame.textContent = t('End of deck')
    }
    return frame
  }
  const updateSpeaker = () => {
    if (!speaker || speaker.closed) return
    const d = speaker.document
    const cur = deck.getIndices().h
    const nxt = nextVisibleIndex(cur)
    const curBox = d.querySelector('.sv-current')
    const nxtBox = d.querySelector('.sv-nextbox')
    if (!curBox || !nxtBox) return
    curBox.innerHTML = ''
    curBox.appendChild(d.importNode(svSlide(cur, 660), true))
    nxtBox.innerHTML = ''
    nxtBox.appendChild(d.importNode(svSlide(nxt, 300), true))
    const notes = d.querySelector('.sv-notes')
    if (notes) notes.textContent = doc.slides[cur]?.notes || t('— no notes for this slide —')
    const count = d.querySelector('.sv-count')
    if (count) count.textContent = `${visibleIndex(cur)} / ${visibleTotal}`
  }
  const openSpeaker = () => {
    if (speaker && !speaker.closed) {
      speaker.focus()
      return
    }
    // guard the whole open + fullscreen-restore dance: the popup makes the
    // browser leave fullscreen, and without this that would end the show
    const wasFullscreen = document.fullscreenElement === overlay
    openingSpeaker = true
    speaker = window.open('', 'bento-speaker', 'width=1080,height=640')
    if (!speaker) { openingSpeaker = false; return } // popup blocked
    ;(window as unknown as Record<string, unknown>).__bentoSpeaker = speaker // diagnostics
    const d = speaker.document
    d.title = `${doc.title} — ${t('Speaker view')}`
    for (const st of document.querySelectorAll('style')) d.head.appendChild(d.importNode(st, true))
    d.body.className = 'bento-speaker'
    d.body.innerHTML =
      `<div class="sv-top"><div class="sv-timer" title="${t('Click to reset')}">00:00</div>` +
      '<div class="sv-clock"></div><div class="sv-count"></div></div>' +
      '<div class="sv-main"><div class="sv-current"></div>' +
      `<div class="sv-side"><div><div class="sv-label">${t('Next')}</div><div class="sv-nextbox"></div></div>` +
      `<div class="sv-notes-wrap"><div class="sv-label">${t('Notes')}</div><div class="sv-notes"></div></div></div></div>`
    speakerStart = performance.now()
    d.querySelector('.sv-timer')?.addEventListener('click', () => { speakerStart = performance.now() })
    clearInterval(speakerTimer)
    speakerTimer = window.setInterval(() => {
      if (!speaker || speaker.closed) {
        clearInterval(speakerTimer)
        return
      }
      const el = speaker.document.querySelector('.sv-timer')
      if (el) {
        const t = Math.floor((performance.now() - speakerStart) / 1000)
        const mm = String(Math.floor(t / 60)).padStart(2, '0')
        const ss = String(t % 60).padStart(2, '0')
        el.textContent = `${mm}:${ss}`
      }
      const clock = speaker.document.querySelector('.sv-clock')
      if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }, 1000)
    updateSpeaker()
    // If we were fullscreen, the popup just knocked us out of it. Put the slides
    // back into fullscreen (best effort — may need re-activation) and keep the
    // bounce from ending the show. Escape still exits via its own handler.
    if (wasFullscreen) {
      window.setTimeout(() => {
        window.focus()
        enterFullscreen()
        window.setTimeout(() => { openingSpeaker = false }, 400)
      }, 120)
    } else {
      openingSpeaker = false
    }
  }

  // Real fullscreen (F toggles; Present enters it by default). The overlay
  // element is what goes fullscreen, so the speaker popup stays independent.
  // Requests can be denied (iframes, no user activation) — tab-fill mode is
  // the graceful floor, and stays the mode for testing/sharing via F.
  const enterFullscreen = () => {
    overlay.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
  }
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else enterFullscreen()
  }
  // leaving fullscreen — Esc, F, the browser's own UI, an OS gesture —
  // ends the show outright; it never drops into tab-fill mode. (Tab mode
  // is only ever entered deliberately, via the small present button.)
  let wentFullscreen = false
  const onFsChange = () => {
    if (document.fullscreenElement === overlay) wentFullscreen = true
    else if (wentFullscreen && !exited && !openingSpeaker) exit()
  }
  document.addEventListener('fullscreenchange', onFsChange)
  if (opts.fullscreen !== false) enterFullscreen()

  const exit = () => {
    if (exited) return
    exited = true
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    const last = deck.getIndices().h
    try {
      deck.destroy()
    } catch {
      /* Reveal teardown is best-effort */
    }
    overlay.remove()
    window.removeEventListener('resize', onResize)
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('fullscreenchange', onFsChange)
    clearInterval(speakerTimer)
    if (speaker && !speaker.closed) speaker.close()
    onExit(last)
  }

  // Capture-phase keys: Esc exits; arrows navigate unconditionally. Reveal
  // drops key events when focus sits in odd places (a leftover form field, a
  // host-embedded frame) — present mode has no fields, so arrows are always
  // navigation. Handled here exclusively (stopPropagation avoids double-steps).
  const onKeydown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      if (deck.isOverview()) return // let Reveal close its overview first
      ev.preventDefault()
      ev.stopPropagation()
      exit()
      return
    }
    if (ev.key === 's' || ev.key === 'S') {
      ev.preventDefault()
      ev.stopPropagation()
      openSpeaker()
      return
    }
    if (ev.key === 'f' || ev.key === 'F') {
      ev.preventDefault()
      ev.stopPropagation()
      toggleFullscreen()
      return
    }
    const key = ev.key || ({ 32: ' ', 37: 'ArrowLeft', 39: 'ArrowRight', 33: 'PageUp', 34: 'PageDown' } as Record<number, string>)[ev.keyCode]
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') {
      ev.preventDefault()
      ev.stopPropagation()
      goNext()
    } else if (key === 'ArrowLeft' || key === 'PageUp') {
      ev.preventDefault()
      ev.stopPropagation()
      goPrev()
    }
  }
  document.addEventListener('keydown', onKeydown, true)

  // ——— touch: swipe left/right to navigate; swiping past either end of
  // the deck drops back into the editor (phones have no Esc) ———
  let touchX = 0
  let touchY = 0
  overlay.addEventListener('touchstart', (ev) => {
    touchX = ev.touches[0].clientX
    touchY = ev.touches[0].clientY
  }, { passive: true })
  overlay.addEventListener('touchend', (ev) => {
    const t0 = ev.changedTouches[0]
    if (!t0) return
    const dx = t0.clientX - touchX
    const dy = t0.clientY - touchY
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return // a tap or a scroll
    if (dx < 0) {
      if (hasNext()) goNext()
      else exit()
    } else {
      if (hasPrev()) goPrev()
      else exit()
    }
  }, { passive: true })

  deck.on('slidechanged', ((event: any) => {
    const from = event.previousSlide as HTMLElement | undefined
    const to = event.currentSlide as HTMLElement
    if (!to) return
    const fromIdx = from ? [...slidesEl.children].indexOf(from) : -1
    const toIdx = [...slidesEl.children].indexOf(to)
    if (from) {
      // Kill the outgoing slide's tweens, then restore model frames —
      // a tween killed during its delay would otherwise leave the element
      // stuck at its "from" state (invisible) for every future visit.
      anim.killTweensOf(from.querySelectorAll('.bento-el'))
      const fromSlide = doc.slides[fromIdx]
      for (const el of fromSlide?.elements ?? []) {
        const node = from.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
        if (node) {
          applyElementFrame(node, el) // resets style.transform…
          resetXform(node) // …so the engine must forget its composed state
        }
      }
      if (fromSlide?.hover?.type === 'reveal') {
        applyRevealSet(from, null, fromSlide.hover.default)
      }
    }
    const forward = toIdx > fromIdx
    // Morph forward into a morph slide, and un-morph when backing out of one.
    const morphing =
      from &&
      ((forward && doc.slides[toIdx]?.transition === 'morph') ||
        (!forward && doc.slides[fromIdx]?.transition === 'morph'))
    if (morphing) runMorph(doc, from!, to, fromIdx, toIdx)
    else runEnterFx(doc.slides[toIdx], to)
    runAmbientFx(doc.slides[toIdx], to)
    restartSvgAnimations(to)
    wireHoverFocus(doc.slides[toIdx], to)
    if (from) disposeLiveCharts(doc.slides[fromIdx], from)
    mountLiveCharts(doc.slides[toIdx], to, morphing ? doc.slides[fromIdx] : undefined)
    updateSpeaker()
  }) as any)

  // Clicking an element with a link jumps to its target slide.
  slidesEl.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-link]')
    if (!target) return
    const idx = doc.slides.findIndex((s) => s.id === target.dataset.link)
    if (idx >= 0) {
      ev.preventDefault()
      ev.stopPropagation()
      deck.slide(idx, 0)
    }
  })

  deck.initialize().then(() => {
    if (startIndex > 0) deck.slide(startIndex, 0)
    // late layout: fonts/images that finish loading after init can change
    // the measured size, and the boot viewport may still be settling
    window.addEventListener('resize', onResize)
    setTimeout(onResize, 120)
    setTimeout(onResize, 600)
    const first = slidesEl.children[startIndex] as HTMLElement | undefined
    if (first) {
      runEnterFx(doc.slides[startIndex], first)
      runAmbientFx(doc.slides[startIndex], first)
      restartSvgAnimations(first)
      wireHoverFocus(doc.slides[startIndex], first)
      mountLiveCharts(doc.slides[startIndex], first)
    }
  })

  return { exit }
}

// --- live charts --------------------------------------------------------------

// Present mode swaps chart snapshots for live ECharts instances (tooltips,
// dataZoom). Leaving the slide disposes the instance and restores the
// snapshot so the section stays presentable in Reveal's viewDistance cache.
const chartHandles = new WeakMap<HTMLElement, Array<() => void>>()

function mountLiveCharts(slide: Slide, section: HTMLElement, fromSlide?: Slide) {
  const handles: Array<() => void> = []
  for (const el of slide?.elements ?? []) {
    if (el.type !== 'chart') continue
    const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (!node) continue
    // a matching chart on the other side of a morph: animate its data over
    const fromEl = fromSlide?.elements.find((e) => e.id === el.id && e.type === 'chart')
    const dispose = mountChart(el, node, fromEl && fromEl.type === 'chart' ? fromEl.option : undefined)
    handles.push(() => {
      dispose()
      node.innerHTML = chartSnapshotSvg(el)
      const csvg = node.querySelector('svg')
      if (csvg) {
        csvg.setAttribute('preserveAspectRatio', 'none')
        ;(csvg as SVGElement).style.cssText = 'width:100%;height:100%;display:block'
      }
    })
  }
  if (handles.length) chartHandles.set(section, handles)
}

function disposeLiveCharts(_slide: Slide, section: HTMLElement) {
  for (const h of chartHandles.get(section) ?? []) h()
  chartHandles.delete(section)
}

// --- element fx -------------------------------------------------------------

function fxNodes(slide: Slide, section: HTMLElement): Array<[SlideElement, HTMLElement]> {
  const pairs: Array<[SlideElement, HTMLElement]> = []
  for (const el of slide?.elements ?? []) {
    if (!el.fx) continue
    const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (node) pairs.push([el, node])
  }
  return pairs
}

/** Staggered entrance animations + count-ups for the incoming slide. */
function runEnterFx(slide: Slide, section: HTMLElement) {
  const entering = fxNodes(slide, section)
    // reveal-set members are shown/hidden by hover, never by entrance tweens
    .filter(([el]) => (el.fx!.enter || el.fx!.countUp) && !el.showOnHover)
    .sort((a, b) => (a[0].fx!.order ?? 0) - (b[0].fx!.order ?? 0))
  // Delay derives from fx.order when set (equal order ⇒ elements enter
  // together — how a diagram reveals band-by-band), else from list position.
  entering.forEach(([el, node], i) => {
    const fx = el.fx!
    const step = fx.order ?? i
    // motion-path loops own the transform — an entrance tween on the same
    // node would fight it and freeze the dot off its path
    if (fx.loop?.type === 'motion-path') return
    if (fx.enter) {
      anim.fromTo(
        node,
        { opacity: 0, y: fx.enter === 'fade-up' ? 16 : 0 },
        {
          opacity: el.opacity,
          y: 0,
          duration: 0.55,
          delay: 0.12 + Math.min(step, 24) * 0.05,
          ease: 'power2.out',
        },
      )
    }
    if (fx.countUp) runCountUp(node)
  })
  settleGuarantee(entering.map(([el, node]) => [node, el]))
}

/**
 * Wall-clock safety net: on starved render loops (throttled tabs, weak
 * machines) tween progress crawls — guarantee every animated element lands
 * on its final model state instead of lingering half-invisible.
 */
function settleGuarantee(pairs: Array<[HTMLElement, SlideElement]>) {
  // Ambient/looping elements run infinite tweens by design — their progress
  // never reaches 1, and "settling" them would kill the loop and freeze the
  // element (a real bug once: orbit dots died 2.8s after every morph entry).
  pairs = pairs.filter(([, el]) => !el.fx?.loop && el.fx?.ambient !== 'kenburns')
  if (!pairs.length) return
  setTimeout(() => {
    for (const [node, el] of pairs) {
      if (!node.isConnected) continue
      const tweens = anim.getTweensOf(node)
      if (tweens.some((t) => t.progress() < 1)) {
        anim.killTweensOf(node)
        applyElementFrame(node, el)
        resetXform(node)
      }
    }
  }, 2800)
}

/** Animate every number in the element's text from 0 to its final value. */
function runCountUp(node: HTMLElement) {
  const inner = node.querySelector<HTMLElement>('.bento-text-inner') ?? node
  const final = inner.textContent ?? ''
  const tokens = [...final.matchAll(/\d+(?:[.,]\d+)?/g)]
  if (!tokens.length) return
  const state = { p: 0 }
  anim.to(state, {
    p: 1,
    duration: 1.15,
    delay: 0.15,
    ease: 'power2.out',
    onUpdate() {
      let out = ''
      let last = 0
      for (const m of tokens) {
        out += final.slice(last, m.index)
        const raw = m[0].replace(',', '.')
        const decimals = raw.includes('.') ? raw.split('.')[1].length : 0
        out += (parseFloat(raw) * state.p).toFixed(decimals)
        last = m.index! + m[0].length
      }
      inner.textContent = out + final.slice(last)
    },
  })
}

/** Re-parse inline svg elements so their CSS animations replay on entry. */
function restartSvgAnimations(section: HTMLElement) {
  for (const host of section.querySelectorAll<HTMLElement>('.bento-el-svg')) {
    if (host.querySelector('animate, [style*="animation"], style')) {
      // eslint-disable-next-line no-self-assign
      host.innerHTML = host.innerHTML
    }
  }
}

/** Continuous motion: ken-burns zoom, marching dashes, dots along paths. */
function runAmbientFx(slide: Slide, section: HTMLElement) {
  for (const [el, node] of fxNodes(slide, section)) {
    const fx = el.fx!
    if (fx.ambient === 'kenburns') {
      const ken = fx.ken ?? {}
      const dir = ken.dir ?? 'drift'
      if (dir === 'drift') {
        anim.fromTo(
          node,
          { scale: 1.02 },
          { scale: ken.scale ?? 1.1, duration: ken.duration ?? 26, ease: 'none', repeat: -1, yoyo: true, transformOrigin: '50% 40%' },
        )
      } else {
        // one-shot settle, replayed on every slide entry
        const far = ken.scale ?? 1.06
        const dur = ken.duration ?? 2.5
        anim.fromTo(
          node,
          { scale: dir === 'out' ? far : 1 },
          { scale: dir === 'out' ? 1 : far, duration: dur, ease: 'power2.out', transformOrigin: '50% 50%' },
        )
      }
    }
    if (fx.loop?.type === 'dash-march') {
      const target = node.querySelector('path, line, rect, ellipse, polygon')
      if (target) {
        anim.fromTo(
          target,
          { strokeDashoffset: fx.loop.distance ?? 18 },
          { strokeDashoffset: 0, duration: fx.loop.duration ?? 1.4, ease: 'none', repeat: -1 },
        )
      }
    }
    if (fx.loop?.type === 'motion-path') {
      anim.to(node, {
        motionPath: { path: fx.loop.path, speeds: fx.loop.speeds },
        duration: fx.loop.duration,
        delay: fx.loop.delay ?? 0,
        ease: fx.loop.ease ?? 'none',
        repeat: -1,
      })
    }
  }
}

/** Show only the showOnHover set for `group` (falling back to the default). */
function applyRevealSet(root: HTMLElement, group: string | null, def?: string | null) {
  const active = group ?? def ?? null
  for (const node of root.querySelectorAll<HTMLElement>('[data-show-on-hover]')) {
    const show = node.dataset.showOnHover === active
    node.style.transition = 'opacity .18s ease'
    node.style.opacity = show ? '' : '0'
    node.style.pointerEvents = show ? '' : 'none'
  }
}

/**
 * Hover behaviours. focus-group: pointing at a grouped element dims every
 * element outside its group. reveal: pointing at a grouped element shows the
 * matching showOnHover set (in-slide content swap — no state slides needed).
 */
function wireHoverFocus(slide: Slide, section: HTMLElement) {
  if (!slide?.hover || section.dataset.hoverWired) return
  section.dataset.hoverWired = '1'
  const mode = slide.hover.type
  const dim = slide.hover.dim ?? 0.13
  const def = slide.hover.default ?? null
  let current: string | null = null
  const apply = (group: string | null) => {
    if (group === current) return
    current = group
    if (mode === 'reveal') {
      applyRevealSet(section, group, def)
      return
    }
    for (const node of section.querySelectorAll<HTMLElement>('[data-group]')) {
      const other = group !== null && node.dataset.group !== group
      node.style.transition = 'opacity .25s ease'
      node.style.opacity = other ? String(dim) : ''
    }
  }
  section.addEventListener('mouseover', (ev) => {
    const hit = (ev.target as HTMLElement).closest<HTMLElement>('[data-group]')
    apply(hit ? hit.dataset.group! : null)
  })
  section.addEventListener('mouseleave', () => apply(null))
}

// --- morph ------------------------------------------------------------------

function elementsById(root: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>()
  root.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((n) => {
    map.set(n.dataset.flipId!, n)
  })
  return map
}

function modelById(doc: BentoDoc, index: number): Map<string, SlideElement> {
  const map = new Map<string, SlideElement>()
  for (const el of doc.slides[index]?.elements ?? []) map.set(el.id, el)
  return map
}

function runMorph(
  doc: BentoDoc,
  fromSection: HTMLElement,
  toSection: HTMLElement,
  fromIdx: number,
  toIdx: number,
) {
  const fromEls = elementsById(fromSection)
  const toEls = elementsById(toSection)
  const fromModel = modelById(doc, fromIdx)
  const toModel = modelById(doc, toIdx)

  const matchedFrom: HTMLElement[] = []
  const matchedTo: HTMLElement[] = []
  for (const [id, el] of fromEls) {
    const target = toEls.get(id)
    if (target) {
      matchedFrom.push(el)
      matchedTo.push(target)
    }
  }

  // Unmatched incoming elements fade/rise in — to their MODEL opacity
  // (clearProps would wipe reveal-set hiding and dimmed-state opacities).
  const toSlide = doc.slides[toIdx]
  const activeSet = toSlide?.hover?.type === 'reveal' ? (toSlide.hover.default ?? null) : null
  const entering: Array<[HTMLElement, number]> = []
  for (const n of toEls.values()) {
    const id = n.dataset.flipId!
    if (fromEls.has(id)) continue
    const m = toModel.get(id)
    if (m?.showOnHover && m.showOnHover !== activeSet) continue // hover-revealed, stays hidden
    entering.push([n, m?.opacity ?? 1])
  }
  if (entering.length) {
    const spread = Math.min(0.45, entering.length * 0.03)
    entering.forEach(([n, opacity], i) => {
      // motion-path loops own the transform — entrance limited to opacity
      const m = toModel.get(n.dataset.flipId!)
      const owns = m?.fx?.loop?.type === 'motion-path'
      anim.fromTo(n,
        owns ? { opacity: 0 } : { opacity: 0, y: 14 },
        {
          opacity, ...(owns ? {} : { y: 0 }), duration: 0.45,
          delay: MORPH_DURATION * 0.4 + (spread * i) / entering.length,
          ease: 'power2.out',
        })
    })
    settleGuarantee(entering.map(([n]) => {
      const m = toModel.get(n.dataset.flipId!)
      return [n, m!] as [HTMLElement, SlideElement]
    }).filter(([, m]) => !!m))
  }
  if (!matchedFrom.length) return

  // Geometry straight from the model — no DOM measuring needed (both sides'
  // frames are in the doc), so the outgoing section's Reveal styling is
  // irrelevant. Each matched node animates from the from-slide's frame to its
  // own via translate+scale about the top-left corner (scale mode like
  // PowerPoint: text scales instead of reflowing mid-morph). Rotating morphs
  // pivot slightly differently than center-origin — rare and acceptable.
  for (const node of matchedTo) {
    const id = node.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b) continue
    if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && (a.rotation ?? 0) === (b.rotation ?? 0)) continue
    const state = { p: 0 }
    node.style.transformOrigin = '0 0'
    anim.to(state, {
      p: 1,
      duration: MORPH_DURATION,
      ease: MORPH_EASE,
      onUpdate() {
        const p = state.p
        const x = a.x + (b.x - a.x) * p
        const y = a.y + (b.y - a.y) * p
        const w = a.w + (b.w - a.w) * p
        const h = a.h + (b.h - a.h) * p
        const r = (a.rotation ?? 0) + ((b.rotation ?? 0) - (a.rotation ?? 0)) * p
        node.style.transform =
          `translate(${x - b.x}px, ${y - b.y}px)` +
          (r ? ` rotate(${r}deg)` : '') +
          ` scale(${w / Math.max(b.w, 0.01)}, ${h / Math.max(b.h, 0.01)})`
      },
      onComplete() {
        node.style.transformOrigin = ''
        node.style.transform = b.rotation ? `rotate(${b.rotation}deg)` : ''
        resetXform(node)
      },
    })
  }

  // Styles morph straight from the model — exact values, no DOM sniffing.
  for (const to of matchedTo) {
    const id = to.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b) continue
    if (a.opacity !== b.opacity) {
      anim.fromTo(to, { opacity: a.opacity }, { opacity: b.opacity, duration: MORPH_DURATION, ease: MORPH_EASE })
    }
    if (a.type === 'shape' && b.type === 'shape') {
      const target = to.querySelector<SVGElement>('rect,ellipse,polygon,line,path')
      if (target) morphShapeFill(target, a, b)
    }
    if (a.type === 'text' && b.type === 'text' && a.color !== b.color) {
      const inner = to.querySelector<HTMLElement>('.bento-text-inner')
      if (inner) {
        anim.fromTo(inner, { color: a.color }, { color: b.color, duration: MORPH_DURATION, ease: MORPH_EASE })
      }
    }
  }
}

// --- fill morphing (solid ⇄ solid, solid ⇄ gradient, gradient ⇄ gradient) ----

const SVG_NS = 'http://www.w3.org/2000/svg'
let morphGradSeq = 0

/** Any solid CSS color we author (#hex / rgb / rgba) → [r, g, b, a]. */
function colorParts(v: string): [number, number, number, number] {
  const m = v?.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(/[\s,/]+/).map(Number)
    return [p[0] || 0, p[1] || 0, p[2] || 0, Number.isFinite(p[3]) ? p[3] : 1]
  }
  let hex = (v ?? '').trim()
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('')
  if (/^#[0-9a-fA-F]{6,8}$/.test(hex)) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
      hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1,
    ]
  }
  return [0, 0, 0, v === 'transparent' || v === 'none' ? 0 : 1]
}

const rgbaStr = (c: [number, number, number, number]) =>
  `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${Math.round(c[3] * 1000) / 1000})`

/** Color of a gradient evaluated at position t (piecewise-linear between stops). */
function sampleGradient(stops: GradientFill['stops'], t: number): string {
  const s = [...stops].sort((x, y) => x.at - y.at)
  if (t <= s[0].at) return rgbaStr(colorParts(s[0].color))
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]
    const b = s[i + 1]
    if (t <= b.at) {
      const f = b.at === a.at ? 0 : (t - a.at) / (b.at - a.at)
      const ca = colorParts(a.color)
      const cb = colorParts(b.color)
      return rgbaStr([0, 1, 2, 3].map((k) => ca[k] + (cb[k] - ca[k]) * f) as [number, number, number, number])
    }
  }
  return rgbaStr(colorParts(s[s.length - 1].color))
}

/**
 * Tween a shape's fill from element a's to element b's. Solids tween the fill
 * attribute; when a gradient is involved the tween runs on the <stop> nodes
 * (colors sampled from the other side at matching positions) and on the
 * gradient line, so angle changes sweep too. A solid destination gets a
 * temporary gradient that collapses to the flat color and is then removed.
 */
function morphShapeFill(target: SVGElement, a: ShapeElement, b: ShapeElement) {
  if (a.fill === b.fill && JSON.stringify(a.fillGradient) === JSON.stringify(b.fillGradient)) return
  // line shapes paint with stroke (fill is the line color in the model)
  if (b.shape === 'line' && target.tagName === 'line') {
    anim.fromTo(target, { attr: { stroke: a.fill } }, { attr: { stroke: b.fill }, duration: MORPH_DURATION, ease: MORPH_EASE })
    return
  }
  const ag = a.fillGradient?.stops.length ? a.fillGradient : undefined
  const bg = b.fillGradient?.stops.length ? b.fillGradient : undefined
  if (!ag && !bg) {
    if (a.fill !== b.fill) {
      anim.fromTo(target, { attr: { fill: a.fill } }, { attr: { fill: b.fill }, duration: MORPH_DURATION, ease: MORPH_EASE })
    }
    return
  }
  const svg = target.ownerSVGElement
  if (!svg) return

  let lin = svg.querySelector('linearGradient')
  if (!lin) {
    // destination is solid — fabricate a gradient shaped like the source so
    // there is something to tween through, then collapse it to b.fill
    lin = document.createElementNS(SVG_NS, 'linearGradient')
    lin.id = `bento-morph-grad-${morphGradSeq++}`
    for (const s of ag!.stops) {
      const stop = document.createElementNS(SVG_NS, 'stop')
      stop.setAttribute('offset', String(s.at))
      lin.appendChild(stop)
    }
    const defs = document.createElementNS(SVG_NS, 'defs')
    defs.appendChild(lin)
    svg.appendChild(defs)
    target.setAttribute('fill', `url(#${lin.id})`)
  }

  const stops = [...lin.querySelectorAll('stop')]
  // per rendered stop: where it sits, what it starts as, what it ends as
  const finals = bg ? bg.stops : ag!.stops.map((s) => ({ at: s.at, color: b.fill }))
  stops.forEach((node, i) => {
    const at = finals[i]?.at ?? 1
    const fromColor = ag ? sampleGradient(ag.stops, at) : rgbaStr(colorParts(a.fill))
    const toColor = finals[i]?.color ?? b.fill
    anim.fromTo(
      node,
      { attr: { 'stop-color': fromColor } },
      {
        attr: { 'stop-color': toColor },
        duration: MORPH_DURATION,
        ease: MORPH_EASE,
        ...(i === 0 && !bg
          ? {
              // solid destination: swap the temp gradient back to a flat fill
              onComplete: () => {
                target.setAttribute('fill', b.fill)
                lin!.parentElement?.remove()
              },
            }
          : {}),
      },
    )
  })

  const fromLine = gradientLineCoords((ag ?? bg)!.angle)
  const toLine = gradientLineCoords((bg ?? ag)!.angle)
  anim.fromTo(lin, { attr: fromLine }, { attr: toLine, duration: MORPH_DURATION, ease: MORPH_EASE })
}
