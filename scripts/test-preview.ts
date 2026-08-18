#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// First-page preview rig.
//
//   node scripts/test-preview.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Every save writes a static rendering of page one into the
// shell so file managers can thumbnail the deck (kernel/src/save.ts, and
// slides/src/preview.ts for the drawing). Two of the decisions in that flow
// can fail SILENTLY — nobody looks at markup they cannot see — and both are
// unrecoverable once files are on disk:
//
//   1. THE ENCRYPTION VETO. A `bento/enc` deck must never carry a plaintext
//      rendering of page one. Getting this wrong publishes the title slide of
//      every password-protected deck ever saved, and the owner would have no
//      way to notice.
//   2. THE OUTPUT REFUSAL. The preview is generated from author content. A
//      script tag reaching the file unbalances it and breaks the frozen
//      splice contract every shipped updater relies on. `</noscript>` is
//      still refused: it costs nothing and older files carry one. The same
//      refusal covers the preview's own `<style>`, which is the hole escaping
//      cannot close: a raw text element is written to the file VERBATIM, so a
//      `</style>` inside one author-supplied declaration ends it early and the
//      rest becomes live markup in every reader's DOM, outside #bento-doc.
//   3. THE AT-REST KDF. Its iteration count may be raised, and raising it must
//      never cost a file. The count lives in the envelope, so an encrypted deck
//      written by any older build has to keep opening with ITS number — a deck
//      that stops opening is unrecoverable in a way a weak KDF is not.
//
// The rest of the feature — laying the page out, fitting it to a viewport,
// staying inside the byte budget — needs a DOM and is verified in a browser
// and against the real macOS thumbnailer (`qlmanage -t`). These are pure
// decisions, so they get pinned here where a regression costs one CI run
// instead of one release.
//
// The shell-level counterpart is `scripts/shell-gate.mjs`, which proves a
// preview-carrying FILE still satisfies the splice contract and asserts that
// both rules below are still wired into the save path at all.

import { decryptEnvelope, previewAllowed, previewIsSafe, setEncryptionPassword } from '../kernel/src/save.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

// Never write these literals (AGENTS.md #1): this file is not bundled, but the
// fixtures below need them as data, and the habit is the rule.
const SCRIPT_CLOSE = '</scr' + 'ipt>'
const SCRIPT_OPEN = '<scr' + 'ipt>'
const NOSCRIPT_CLOSE = '</nosc' + 'ript>'
const STYLE_OPEN = '<sty' + 'le>'
const STYLE_CLOSE = '</sty' + 'le>'

const PLAIN = JSON.stringify({ format: 'bento/slides', docId: 'x', title: 'Q3 board' })
const ENVELOPE = JSON.stringify({
  format: 'bento/enc', v: 1, it: 300000, salt: 'c2FsdA==', iv: 'aXY=', data: 'ZGF0YQ==',
})

// --- 1. the encryption veto -------------------------------------------------

console.log('\nencryption veto')

setEncryptionPassword(null)
ok(previewAllowed(PLAIN) === true, 'a plain deck with no password may carry a preview')

// The password flag alone must be enough. This is the live-session case: the
// user typed a password this session, and the tooling path (serializeFile) is
// still handing serializeBody a PLAINTEXT body.
ok(previewAllowed(PLAIN, true) === false, 'password active vetoes the preview even for a plaintext body')

// The body alone must be enough too. This is the path where an already-
// encrypted block is re-serialized without the in-memory flag ever being set.
ok(previewAllowed(ENVELOPE) === false, 'a bento/enc body vetoes the preview even with no password flag')
ok(previewAllowed(ENVELOPE, true) === false, 'both signals together still veto')

// …and through the real module state, not just the parameter, because that is
// how the save path actually calls it.
setEncryptionPassword('hunter2')
ok(previewAllowed(PLAIN) === false, 'setEncryptionPassword() vetoes the preview on the real save path')
setEncryptionPassword(null)
ok(previewAllowed(PLAIN) === true, 'clearing the password restores the preview')

// A body that merely looks envelope-ish must not accidentally suppress a
// preview — the check has to be the real parse, not a substring sniff.
ok(previewAllowed(JSON.stringify({ title: 'about bento/enc envelopes' })) === true,
  'a deck that merely mentions bento/enc still previews')
ok(previewAllowed('not json at all') === true, 'an unparseable body is not mistaken for an envelope')

// --- 2. the output refusal --------------------------------------------------

console.log('\noutput refusal')

const SAFE = '<div style="position:fixed;inset:0"><div>Hello &lt;world&gt; &amp; &quot;quotes&quot;</div></div>'
ok(previewIsSafe(SAFE) === true, 'ordinary escaped preview markup is accepted')
ok(previewIsSafe('<div>مرحبا שלום 🎌 a b c</div>') === true, 'RTL, emoji and JS line separators are fine')

ok(previewIsSafe(`<div>${SCRIPT_CLOSE}</div>`) === false, 'a bare script close is refused')
ok(previewIsSafe(`<div>${SCRIPT_OPEN}alert(1)${SCRIPT_CLOSE}</div>`) === false, 'a script element is refused')
ok(previewIsSafe(`<div>${NOSCRIPT_CLOSE}<h1>escaped</h1></div>`) === false,
  'a noscript close is refused — older files park the preview in one')

// Case and attribute variants: an HTML parser ends a script element at
// `</script` regardless of case or what follows, so the check must too.
ok(previewIsSafe('<div>' + '</SCR' + 'IPT>' + '</div>') === false, 'an upper-case script close is refused')
ok(previewIsSafe('<div>' + '</scr' + 'ipt foo>' + '</div>') === false, 'a script close with junk before ">" is refused')
ok(previewIsSafe('<div>' + '<SCR' + 'IPT src=x>' + '</div>') === false, 'an upper-case script open is refused')
ok(previewIsSafe('<div>' + '</NOSC' + 'RIPT>' + '</div>') === false, 'an upper-case noscript close is refused')

// The forged-block case the pack rig also covers: a preview must not be able
// to counterfeit an opening #bento-doc tag above the real one, because an old
// updater splices into the FIRST match.
ok(previewIsSafe('<div>' + '<scr' + 'ipt type="application/bento+json" id="bento-doc">{}</div>') === false,
  'a forged #bento-doc opening tag is refused')

// --- 3. the stylesheet, which escaping cannot protect -----------------------
//
// Every app's preview hoists repeated declarations into ONE <style> (slides and
// dash) or writes a scoped sheet (spaces), and those declarations are built
// from author data. A <style> is a raw text element, so nothing escapes what
// goes in it: `}</style><img src=x onerror=…>{` inside one colour ends the
// element and the rest lands in the reader's live DOM. The first check below is
// the one that keeps this honest — refusing every preview that contains a
// <style> would "fix" the hole by deleting the feature.

console.log('\nstylesheet refusal')

const SHEET = `<div class="p">${STYLE_OPEN}._0{color:#1E2A3A}._1{font-size:18px}${STYLE_CLOSE}<div class="_0 _1">Q3</div></div>`
ok(previewIsSafe(SHEET) === true, 'a preview carrying its hoisted stylesheet is accepted')
ok(previewIsSafe(`<div>${STYLE_OPEN}@media print{._0{color:red}}${STYLE_CLOSE}</div>`) === true,
  'braces, at-rules and selectors inside the sheet are ordinary CSS')

ok(previewIsSafe(`<div>${STYLE_OPEN}._0{color:red}${STYLE_CLOSE}<img src=x onerror=alert(1)>{}${STYLE_CLOSE}</div>`) === false,
  'a declaration that closes the stylesheet early is refused')
ok(previewIsSafe(`<div>${STYLE_OPEN}._0{color:red}${STYLE_CLOSE}<img src=x onerror=alert(1)>${STYLE_OPEN}{}${STYLE_CLOSE}</div>`) === false,
  'the tidy version — re-open a sheet after the smuggled markup, tags balanced — is refused too')
ok(previewIsSafe(`<div>${STYLE_OPEN}._0{content:"<b>"}${STYLE_CLOSE}</div>`) === false,
  'a "<" inside the sheet is refused whether or not it closes anything')
ok(previewIsSafe(`<div>${STYLE_CLOSE}<img src=x onerror=alert(1)></div>`) === false,
  'a closer with no sheet to close is refused')
ok(previewIsSafe(`<div>${'<STY' + 'LE>'}._0{color:red}${'</STY' + 'LE>'}<b>x</b>${'</STY' + 'LE>'}</div>`) === false,
  'the same, upper-case — an HTML parser does not care about case')

// --- 4. the at-rest KDF ------------------------------------------------------
//
// A real envelope minted by the 300k build, kept as bytes. Raising
// ENC_ITERATIONS must not touch it: the count is in the file, and this is the
// only proof that decryption reads it from there rather than from the constant.

console.log('\nat-rest KDF')

const LEGACY_PASSWORD = 'correct horse battery staple'
const LEGACY_ENVELOPE = {
  format: 'bento/enc' as const, v: 1 as const, it: 300000,
  salt: 'zcBz9Vbqwj+iUtehuL5l/g==',
  iv: 'Cqufag7LTNkRg6Lu',
  data: '+IrsgJlM1O3yUyEvjDhl+2gLpXJzdKH9nV8JSInKsKkJFKIZfkC9uxu0Wdq0E6Ds5+U3q3lJ7DrEaN5j+jBKH8HLjAFWFyQ3y5uMYgHO6g==',
}

const opened = await decryptEnvelope(LEGACY_ENVELOPE, LEGACY_PASSWORD)
ok(JSON.parse(opened ?? 'null')?.title === 'Q3 board',
  'a deck encrypted at 300k still opens after the iteration count is raised')
ok((await decryptEnvelope(LEGACY_ENVELOPE, 'wrong')) === null, 'the wrong password still fails closed')
ok((await decryptEnvelope({ ...LEGACY_ENVELOPE, it: 600_000 }, LEGACY_PASSWORD)) === null,
  'and the count is what does it — deriving with any other number cannot open the same bytes')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
