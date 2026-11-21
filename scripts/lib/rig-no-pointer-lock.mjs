// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A browser rig that drags a number's label calls this on its context, so the
// drag reads the pointer's own position on every machine.
//
// A scrub (slides/src/editor/inspector/controls.ts) asks for pointer lock once
// the drag is under way and carries on without it when the browser refuses.
// With the lock GRANTED, a mouse driven over CDP reports its movement
// differently from one Chromium to the next. Measured on CI's Chrome 149
// (Playwright 1.61.1), against the newer Chromium these rigs were written on:
// a 40px drag moved X by -400 where +20 was expected, took a font size from 32
// to 4 and an opacity to 0, and a 2000px drag stopped a page width at 721
// instead of its 320 floor. None of that happens to a hand on a real mouse.
//
// Refusing the lock removes the browser from the result. What the lock itself
// does (asked once, held, released, movementX summed) is checked in
// test-slides-inspector-scrub-browser.mjs against a stub it installs itself,
// which replaces this refusal for that section.
export async function refusePointerLock(context) {
  await context.addInitScript(() => {
    Element.prototype.requestPointerLock = function () { return Promise.reject(new Error('rig: pointer lock refused')) }
  })
}
