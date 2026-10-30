// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What a selected component member is, at the top of the inspector: "◆ Stat
// card · main", or "◇ Copy of Stat card" with Go to main, Reset overrides and
// Detach — so a copy on slide 12 is one click from the main on slide 3.
import type { PropsPanel } from '../panels'
import type { SlideElement } from '../../model'
import { components, detach, resetOverrides } from '../../components'
import { t } from '../../i18n'

/** The component the whole selection belongs to, if it is one. */
export function selectedComponent(p: PropsPanel, els: SlideElement[]) {
  const id = els[0]?.component?.id
  if (!id || !els.every((e) => e.component?.id === id)) return null
  const info = components(p.store.doc).find((c) => c.id === id)
  if (!info) return null
  const main = els.every((e) => e.component!.main)
  const slideNo = p.store.doc.slides.findIndex((s) => s.id === info.slideId) + 1
  return { info, main, whole: main && info.main.every((m) => els.some((e) => e.id === m.id)), slideNo }
}

/** Select a component's main, on its own slide. */
export function goToMain(p: PropsPanel, id: string) {
  const info = components(p.store.doc).find((c) => c.id === id)
  if (!info) return
  const at = p.store.doc.slides.findIndex((s) => s.id === info.slideId)
  if (at >= 0 && at !== p.store.currentIndex) p.store.goTo(at)
  p.store.select(info.main.map((m) => m.id))
}

export function componentHeader(p: PropsPanel, els: SlideElement[]) {
  const c = selectedComponent(p, els)
  if (!c) return
  const name = c.info.name || t('Component')
  const box = document.createElement('div')
  box.className = 'ed-comp-head'
  const title = document.createElement('div')
  title.className = 'ed-comp-title'
  title.textContent = c.main ? t('◆ {name} · main', { name }) : t('◇ Copy of {name}', { name })
  box.appendChild(title)
  const acts = document.createElement('div')
  acts.className = 'ed-comp-acts'
  const act = (label: string, run: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn'
    b.textContent = label
    b.addEventListener('click', run)
    acts.appendChild(b)
  }
  if (!c.main) {
    act(t('Go to main (slide {n})', { n: c.slideNo }), () => goToMain(p, c.info.id))
    if (els.some((e) => e.component?.over?.length)) act(t('Reset overrides'), () => p.store.commit(() => resetOverrides(els.map((e) => p.store.element(e.id)!).filter(Boolean))))
  }
  act(c.main && !c.whole ? t('Remove from component') : t('Detach'), () => p.store.commit(() => detach(els.map((e) => p.store.element(e.id)!).filter(Boolean))))
  box.appendChild(acts)
  p.host.appendChild(box)
}
