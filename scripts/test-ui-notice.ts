#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shared kernel NOTICE primitive — behaviour rig.
//
//   node scripts/test-ui-notice.ts
//
// D3 asked for transient messages "as two levels of one primitive": an AMBIENT
// status line for the running commentary ("Edited", "Saved") and a TOAST pill for
// the thing the reader must not miss. Each level carries one lesson these checks
// pin, both real in the tree the primitive replaces:
//
//   TOAST    body-level and singular — spaces raised a second identical pill by
//            re-querying, and slides' toast is one element reused. And it must be
//            ABOVE everything (a dialog included), which is the --z-toast / detail-10
//            reason it is body-level fixed (asserted structurally + by the guard).
//   AMBIENT  the text must LEAVE the element after the fade, not just fade out of
//            it: the status span is `nowrap`, so a word left in it holds the bar's
//            width for the rest of the session (spaces' M16). So: shown, then the
//            class comes off, then — only if nothing new was written — the text is
//            cleared. A write during that window must survive.

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { installDom } from './lib/dash-dom.ts'
import { checkThemedChains } from './lib/ui-theme-guard.ts'

const { doc } = installDom()
const { toast, ambient } = await import('../kernel/src/ui/notice.ts')

let failures = 0, checks = 0
function ok(cond: unknown, msg: string): void { checks++; if (!cond) { failures++; console.error(`  FAIL  ${msg}`) } }
function eq(msg: string, got: unknown, want: unknown): void { checks++; if (got !== want) { failures++; console.error(`  FAIL  ${msg}\n        got  ${String(got)}\n        want ${String(want)}`) } }
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const pills = () => doc.body.querySelectorAll('.bkn-toast')
const A = (el: unknown, k: string): string | null => (el as { getAttribute(k: string): string | null }).getAttribute(k)

// ————— toast: body-level, singular, announced, auto-dismissed —————
{
  toast('Export done', { duration: 30 })
  const one = pills()
  eq('the toast mounts one pill in the body', one.length, 1)
  eq('it announces politely as a status', A(one[0], 'role'), 'status')
  eq('it is an aria-live region', A(one[0], 'aria-live'), 'polite')
  eq('it carries the message', one[0].textContent, 'Export done')
  ok(one[0].classList.contains('bkn-on'), 'it is shown (bkn-on)')

  toast('Saved to disk', { duration: 30 })
  eq('a second toast REPLACES the first, not stacks', pills().length, 1)
  eq('and carries the new message', pills()[0].textContent, 'Saved to disk')

  await wait(60)
  ok(!pills()[0].classList.contains('bkn-on'), 'it dismisses itself after the duration')

  toast('')
  eq('an empty toast is a no-op (no new element, no re-show)', pills().length, 1)
  ok(!pills()[0].classList.contains('bkn-on'), 'and it stays hidden')
}

// ————— ambient: written into the app's element, then CLEARED after the fade —————
{
  const bar = doc.createElement('span')
  doc.body.appendChild(bar)
  ambient(bar as unknown as HTMLElement, 'Edited', { showMs: 20, clearMs: 20 })
  eq('the message is written', bar.textContent, 'Edited')
  ok(bar.classList.contains('bkn-on'), 'and the element is marked shown')
  await wait(35) // past showMs, within the clear window
  ok(!bar.classList.contains('bkn-on'), 'the class comes off after showMs')
  await wait(30) // past clearMs
  eq('the TEXT leaves the element too (it must not hold the bar\'s width)', bar.textContent, '')
}

// ————— a write during the clear window survives (no dropped word) —————
{
  const bar = doc.createElement('span')
  doc.body.appendChild(bar)
  ambient(bar as unknown as HTMLElement, 'Saving…', { showMs: 20, clearMs: 40 })
  await wait(30) // past showMs, into the first message's clear window
  ambient(bar as unknown as HTMLElement, 'Saved', { showMs: 1000, clearMs: 40 })
  await wait(30) // the FIRST message's clear timer would have fired by now
  eq('a re-write during the clear window is not wiped by the old timer', bar.textContent, 'Saved')
  ok(bar.classList.contains('bkn-on'), 'and the new message is shown')
}

// ————— empty message clears immediately —————
{
  const bar = doc.createElement('span')
  doc.body.appendChild(bar)
  ambient(bar as unknown as HTMLElement, 'Working', { showMs: 1000 })
  ambient(bar as unknown as HTMLElement, '')
  eq('an empty ambient clears the text at once', bar.textContent, '')
  ok(!bar.classList.contains('bkn-on'), 'and removes the shown class')
}

// ————— a custom on-class (spaces styles 'sp-on') —————
{
  const bar = doc.createElement('span')
  doc.body.appendChild(bar)
  ambient(bar as unknown as HTMLElement, 'Hi', { onClass: 'sp-on', showMs: 1000 })
  ok(bar.classList.contains('sp-on'), 'ambient toggles the app-named class')
  ok(!bar.classList.contains('bkn-on'), 'and not the default one')
}

// ————— THEMING GUARD — the toast's colours resolve, per app, to a themed token —————
{
  const appStyles = Object.fromEntries(
    ['slides', 'spaces', 'dash', 'type'].map((a) => [a, fileURLToPath(new URL(`../${a}/src/styles.css`, import.meta.url))]),
  )
  for (const r of checkThemedChains({
    cssPath: fileURLToPath(new URL('../kernel/src/ui/notice.css', import.meta.url)),
    prefix: 'bkn',
    // shadow lands on a literal for apps without --shadow-pop; z on --z-toast, a
    // tokens.css stacking token no app defines until it adopts the sheet (like the
    // panel scrim) — both exempt from the "reaches a token the app defines" check.
    colourProps: new Set(['bg', 'ink']),
    exempt: new Set(['shadow', 'z']),
    appStyles,
  })) ok(r.pass, r.msg)
}

console.log(failures ? `\ntest-ui-notice: ${failures} FAILED of ${checks}` : `test-ui-notice: ${checks} checks OK`)
process.exit(failures ? 1 : 0)
