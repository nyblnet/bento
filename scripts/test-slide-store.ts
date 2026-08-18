#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slide-list/view-state regression rig. Runs without a DOM.

import { emptySlide, newDoc, defaultText } from '../slides/src/model.ts'
import { Store } from '../slides/src/store.ts'

let checks = 0
let failures = 0

function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else {
    failures++
    console.error(`  FAIL  ${message}`)
  }
}

function makeStore(ids: string[]): Store {
  const doc = newDoc()
  doc.slides = ids.map((id) => emptySlide({ id, name: id }))
  return new Store(doc)
}

function observeDoc(store: Store) {
  let observed: string[] = []
  store.on('doc', () => { observed.push(store.slide.id) })
  return () => observed
}

console.log('\nslide view reconciliation')

{
  const store = makeStore(['a', 'b', 'c', 'd'])
  store.currentIndex = 3
  store.slide.elements.push(defaultText({ id: 'selected' }))
  store.selection = ['selected']
  const observed = observeDoc(store)
  store.commit(() => { store.doc.slides.splice(0, 1) }, 'slides')
  ok(store.slide.id === 'd' && store.currentIndex === 2, 'deleting before the current slide preserves it by id')
  ok(store.selection[0] === 'selected', 'selection survives when the current slide survives')
  ok(observed().join() === 'd', 'doc listeners only observe a valid reconciled slide')
}

{
  const store = makeStore(['a', 'b', 'c', 'd'])
  store.currentIndex = 1
  store.slide.elements.push(defaultText({ id: 'shared-morph-id' }))
  store.doc.slides[2].elements.push(defaultText({ id: 'shared-morph-id' }))
  store.selection = ['shared-morph-id']
  store.hoverPreview = 'details'
  let currentEvents = 0
  let selectionEvents = 0
  store.on('current', () => { currentEvents++ })
  store.on('selection', () => { selectionEvents++ })
  store.commit(() => { store.doc.slides.splice(1, 1) }, 'slides')
  ok(store.slide.id === 'c' && store.currentIndex === 1, 'deleting the current slide selects its next neighbour')
  ok(store.selection.length === 0 && store.hoverPreview == null, 'switching slides clears transient view state even when element ids repeat')
  ok(currentEvents === 1 && selectionEvents === 1, 'the reconciled slide switch emits current and selection once')
}

{
  const store = makeStore(['a', 'b', 'c', 'd'])
  store.currentIndex = 3
  store.commit(() => { store.doc.slides.pop() }, 'slides')
  ok(store.slide.id === 'c' && store.currentIndex === 2, 'deleting the last current slide selects the previous neighbour')
}

{
  const store = makeStore(['parent', 'state-1', 'state-2', 'next', 'tail'])
  store.currentIndex = 2
  const doomed = new Set(['parent', 'state-1', 'state-2'])
  store.commit(() => { store.doc.slides = store.doc.slides.filter((slide) => !doomed.has(slide.id)) }, 'slides')
  ok(store.slide.id === 'next' && store.currentIndex === 0, 'a deleted state selects the next survivor across a cascade')
}

{
  const store = makeStore(['parent', 'state-1', 'state-2', 'current', 'tail'])
  store.currentIndex = 3
  const doomed = new Set(['parent', 'state-1', 'state-2'])
  store.commit(() => { store.doc.slides = store.doc.slides.filter((slide) => !doomed.has(slide.id)) }, 'slides')
  ok(store.slide.id === 'current' && store.currentIndex === 0, 'a surviving current slide follows its id across a cascade')
}

{
  const store = makeStore(['a', 'b', 'c'])
  store.currentIndex = 1
  store.commit(() => {
    const [current] = store.doc.slides.splice(1, 1)
    store.doc.slides.push(current)
  }, 'slides')
  ok(store.slide.id === 'b' && store.currentIndex === 2, 'reordering preserves the current slide by id')
}

{
  const store = makeStore(['a', 'b', 'c'])
  store.currentIndex = 2
  store.slide.elements.push(defaultText({ id: 'shared-morph-id' }))
  store.doc.slides[0].elements.push(defaultText({ id: 'shared-morph-id' }))
  store.selection = ['shared-morph-id']
  store.hoverPreview = 'details'
  const movedId = store.doc.slides[0].id
  store.goTo(store.doc.slides.findIndex((slide) => slide.id === movedId))
  store.commit(() => {
    const [moved] = store.doc.slides.splice(0, 1)
    store.doc.slides.splice(1, 0, moved)
  }, 'slides')
  ok(store.slide.id === 'a', 'drag navigation selects the moved slide')
  ok(store.selection.length === 0 && store.hoverPreview == null, 'drag navigation clears transient state from the previous slide')
}

console.log('\nhistory reconciliation')

{
  const store = makeStore(['a', 'b', 'c', 'd'])
  store.currentIndex = 3
  store.slide.elements.push(defaultText({ id: 'shared-morph-id' }))
  store.doc.slides[2].elements.push(defaultText({ id: 'shared-morph-id' }))
  store.selection = ['shared-morph-id']
  store.commit(() => { store.doc.slides.splice(0, 1) }, 'slides')
  store.undo()
  ok(store.slide.id === 'd' && store.currentIndex === 3, 'undo restores the pre-edit slide by id rather than by shifted index')
  ok(store.selection[0] === 'shared-morph-id', 'undo keeps selection only on the same surviving slide')
  store.redo()
  ok(store.slide.id === 'd' && store.currentIndex === 2, 'redo restores the post-edit slide by id')
}

{
  const store = makeStore(['a', 'b', 'c'])
  store.currentIndex = 1
  store.selection = ['shared-morph-id']
  store.commit(() => { store.doc.slides.splice(1, 1) }, 'slides')
  store.undo()
  ok(store.slide.id === 'b' && store.selection.length === 0, 'undoing current-slide deletion restores that slide without carrying another slide selection onto it')
}

console.log('\nexternal mutation reconciliation')

{
  const store = makeStore(['a', 'b', 'c', 'd'])
  store.currentIndex = 2
  store.slide.elements.push(defaultText({ id: 'shared-morph-id' }))
  store.doc.slides[3].elements.push(defaultText({ id: 'shared-morph-id' }))
  store.selection = ['shared-morph-id']
  const view = store.captureView()
  store.doc.slides.splice(0, 1) // remote CRDT changes bypass commit()
  const change = store.reconcileView(view)
  ok(store.slide.id === 'c' && store.currentIndex === 1, 'external deletion before current preserves the current slide by id')
  ok(store.selection[0] === 'shared-morph-id' && !change.currentChanged, 'external reconciliation does not transfer selection to a repeated id on another slide')
}

{
  const store = makeStore(['a', 'b'])
  store.currentIndex = 1
  store.selection = ['selected']
  let currentEvents = 0
  let selectionEvents = 0
  store.on('current', () => { currentEvents++ })
  store.on('selection', () => { selectionEvents++ })
  store.commit(() => { store.doc.slides = [emptySlide({ id: 'blank' })] }, 'slides')
  ok(store.slide.id === 'blank' && store.currentIndex === 0, 'whole-deck replacement lands on its valid blank slide')
  ok(currentEvents === 1 && selectionEvents === 1, 'whole-deck replacement emits current and selection exactly once')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
