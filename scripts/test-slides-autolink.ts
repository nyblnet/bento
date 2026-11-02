#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A URL typed or pasted into text becomes a link, and stops where the URL
// stops (discussion #723).
//
//   node scripts/test-slides-autolink.ts
//
// WHAT THIS PROVES (the typed path is in test-slides-autolink-browser.mjs):
//   - urlLength: where a URL ends before the punctuation that follows it
//     (full stop, comma, closing bracket that has no opener), http(s) only;
//   - markdownToHtml (paste): bare URLs become anchors, an existing
//     [caption](url) is left as it was, an underscore or star inside a URL is
//     not read as emphasis, and javascript:/data:/scheme-only text stays text.

import { markdownToHtml, urlLength } from '../slides/src/editor/markdown.ts'

let failures = 0
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const L = (t: string) => t.slice(0, urlLength(t))

console.log('\nwhere a URL ends\n')
ok(L('https://github.com.') === 'https://github.com', 'a full stop is not part of it')
ok(L('https://x.com/a,') === 'https://x.com/a', 'nor a comma')
ok(L('https://x.com/a?b=1&c=2!') === 'https://x.com/a?b=1&c=2', 'nor an exclamation mark; query stays')
ok(L('https://x.com/a)') === 'https://x.com/a', 'a closing bracket with no opener is not part of it')
ok(L('https://en.wikipedia.org/wiki/Foo_(bar)') === 'https://en.wikipedia.org/wiki/Foo_(bar)', 'a balanced bracket is')
ok(L('https://x.com/a_b_c') === 'https://x.com/a_b_c', 'underscores inside stay')
ok(L('HTTP://X.COM') === 'HTTP://X.COM', 'scheme is case-insensitive')
ok(urlLength('javascript:alert(1)') === 0, 'javascript: is never a link')
ok(urlLength('data:text/html,hi') === 0, 'data: is never a link')
ok(urlLength('ftp://x.com') === 0, 'only http(s)')
ok(urlLength('https://') === 0 && urlLength('https://.') === 0, 'a bare scheme is not a link')
ok(urlLength('xhttps://x.com') === 0, 'must start the word')

console.log('\npasted text\n')
const m = markdownToHtml
ok(m('see https://github.com.') === 'see <a href="https://github.com">https://github.com</a>.', 'a URL in a sentence')
ok(m('https://a.b/x_y_z and https://c.d') === '<a href="https://a.b/x_y_z">https://a.b/x_y_z</a> and <a href="https://c.d">https://c.d</a>', 'two URLs, no emphasis inside')
ok(m('[cap](https://a.b) https://c.d') === '<a href="https://a.b">cap</a> <a href="https://c.d">https://c.d</a>', 'a markdown link is left alone')
ok(m('a https://x.com/?q=1&r=2 b') === 'a <a href="https://x.com/?q=1&amp;r=2">https://x.com/?q=1&amp;r=2</a> b', 'an ampersand is escaped for the attribute')
ok(m('javascript:alert(1)') === 'javascript:alert(1)', 'javascript: stays text')
ok(!m('x "https://a.b/"onclick="y').includes('onclick=') || !/<a [^>]*onclick/.test(m('x "https://a.b/"onclick="y')), 'a quote cannot break out of the attribute')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
