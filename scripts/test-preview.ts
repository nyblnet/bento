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
//      still refused: it costs nothing and older files carry one.
//
// The rest of the feature — laying the page out, fitting it to a viewport,
// staying inside the byte budget — needs a DOM and is verified in a browser
// and against the real macOS thumbnailer (`qlmanage -t`). These two are pure
// decisions, so they get pinned here where a regression costs one CI run
// instead of one release.
//
// The shell-level counterpart is `scripts/shell-gate.mjs`, which proves a
// preview-carrying FILE still satisfies the splice contract and asserts that
// both rules below are still wired into the save path at all.

import { previewAllowed, previewIsSafe, setEncryptionPassword } from '../kernel/src/save.ts'

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

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
