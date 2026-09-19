#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// When the editor mentions the bento/home extension (slides/src/editor/exthint.ts):
//
//   node scripts/test-slides-exthint.ts
//
// WHAT THIS PROVES. The hint exists only where the extension would change
// something: Chrome/Edge (the File System Access API exists), a file:// page,
// no host injected. A web-served deck, a browser without FSA, or a page that
// already has the host: nothing. Each kind shows once and "Not now" is
// remembered. The two sentences say the three things — in-place save,
// in-place update with a backup, the on-device model — in that order.

// a DOM the size of what exthint.ts touches: no jsdom in this repo
class FakeEl {
  className = ''
  textContent = ''
  children: FakeEl[] = []
  private handlers = new Map<string, Array<() => void>>()
  parent: FakeEl | null = null
  tag: string
  constructor(tag: string) { this.tag = tag }
  appendChild(c: FakeEl) { c.parent = this; this.children.push(c); return c }
  append(...cs: FakeEl[]) { for (const c of cs) this.appendChild(c) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this) }
  addEventListener(ev: string, fn: () => void) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]) }
  click() { for (const fn of this.handlers.get('click') ?? []) fn() }
  querySelector(sel: string): FakeEl | null {
    const cls = sel.replace(/^\./, '')
    const walk = (e: FakeEl): FakeEl | null => { for (const c of e.children) { if (c.className.split(' ').includes(cls)) return c; const d = walk(c); if (d) return d } return null }
    return walk(this)
  }
  get text(): string { return this.textContent + this.children.map((c) => c.text).join('') }
}

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

const store = new Map<string, string>()
const boot = async (url: string, opts: { fsa?: boolean; host?: boolean } = {}) => {
  const w: Record<string, unknown> = { open: () => {} }
  const g = globalThis as Record<string, unknown>
  g.window = w
  g.document = { createElement: (tag: string) => new FakeEl(tag) }
  g.location = new URL(url)
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
  if (opts.fsa !== false) w.showSaveFilePicker = () => {}
  if (opts.host) w.__bentoHost = { name: 'home/webext', ops: ['write'] }
  const m = await import(`../slides/src/editor/exthint.ts?${Math.random()}`)
  return m as typeof import('../slides/src/editor/exthint.ts')
}

console.log('\nwhere it would help')
{
  const m = await boot('file:///Users/x/deck.bento.html')
  ok(m.extensionWouldHelp(), 'Chrome + file:// + no host → yes')
  const m2 = await boot('https://bento.page/slides/')
  ok(!m2.extensionWouldHelp(), 'a web-served deck → no (the extension does not attach there)')
  const m3 = await boot('file:///Users/x/deck.bento.html', { fsa: false })
  ok(!m3.extensionWouldHelp(), 'no File System Access API (Safari, Firefox) → no')
  const m4 = await boot('file:///Users/x/deck.bento.html', { host: true })
  ok(!m4.extensionWouldHelp(), 'the host is already injected → no')
}

console.log('\nonce, and remembered')
{
  store.clear()
  const m = await boot('file:///Users/x/deck.bento.html')
  const line = m.extensionHint('save', (k) => k)
  ok(!!line && /already had open/.test((line as unknown as FakeEl).text) && /⌘S writes it in place/.test((line as unknown as FakeEl).text) && /backup beside/.test((line as unknown as FakeEl).text) && /on-device model/.test((line as unknown as FakeEl).text), 'save: the sentence names in-place save, in-place update with a backup, and the on-device model')
  ok(!!(line as unknown as FakeEl).querySelector('.ed-exthint-get') && !!(line as unknown as FakeEl).querySelector('.ed-exthint-not'), 'with Get the extension and Not now')
  ;((line as unknown as FakeEl).querySelector('.ed-exthint-not') as FakeEl).click()
  ok(store.get('bento-ext-hint-save') === 'off' && m.hintDismissed('save'), 'Not now is remembered')
  ok(m.extensionHint('save', (k) => k) === null, 'and the save hint never shows again')
  const up = m.extensionHint('update', (k) => k)
  ok(!!up && /rewrites the file in place/.test((up as unknown as FakeEl).text) && /backup beside/.test((up as unknown as FakeEl).text), 'update: its own sentence, its own memory')
  const m5 = await boot('https://bento.page/slides/')
  ok(m5.extensionHint('update', (k) => k) === null, 'nothing on a web deck even before any dismissal')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
