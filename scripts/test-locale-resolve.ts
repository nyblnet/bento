#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Locale resolution against a browser whose language is an ALIAS (pt-BR).
//
//   node scripts/test-locale-resolve.ts
//
// Two bugs, one browser: on pt-BR, locale() returned 'pt-BR' — no picker
// choice has that code, so Preferences showed English as selected while the
// UI was Portuguese — and choosing English CLEARED the override, so a reload
// fell back to the browser and came back Portuguese.

const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'pt-BR' } })

const i18n = await import('../kernel/src/i18n.ts')
const boot = () => i18n.registerI18n({ // a reload: registration re-resolves
  packed: { locales: ['pt'], table: { Delete: ['Excluir'] }, alias: { 'pt-BR': 'pt' } },
  choices: [{ code: 'en', label: 'English' }, { code: 'pt', label: 'Português' }],
})

let failed = 0
const ok = (cond: boolean, msg: string) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) failed++ }

boot()
ok(i18n.locale() === 'pt', `a pt-BR browser resolves to the picker code 'pt' (got ${i18n.locale()})`)
ok(i18n.localeChoices().some((c) => c.code === i18n.locale()), 'and that code is a picker choice')
ok(i18n.t('Delete') === 'Excluir', 'and translates')

i18n.setLocale('en')
boot()
ok(i18n.locale() === 'en', `choosing English survives a reload on a pt-BR browser (got ${i18n.locale()})`)

store.set('bento-lang', 'pt-BR') // an override written by an older build
boot()
ok(i18n.locale() === 'pt', 'a stored alias is canonicalised too')

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
