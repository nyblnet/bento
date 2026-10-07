#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type canonicalization + signature-chain rig.  node scripts/test-type-canon.ts
//
// WHY THIS RIG EXISTS. Signature code does not fail loudly. A canonicalization
// bug does not crash and does not corrupt a file — it quietly makes an honest
// document fail to verify, or, far worse, lets two DIFFERENT documents produce
// the same bytes so one signature covers both. Neither is discovered until
// somebody is in a dispute, which is the one moment you cannot re-run the test.
//
// So the properties pinned here are not "does it work"; they are the four
// things a signature is worth nothing without:
//
//   1. DETERMINISM — the same document must produce the same bytes on every
//      machine, whatever order the keys happen to sit in memory. This is the
//      property that breaks when a developer "tidies" a serializer.
//   2. INJECTIVITY — two different documents must NEVER produce the same
//      bytes. A collision here is a forgery: a signature taken over document A
//      verifies against document B. The lone-surrogate case below was exactly
//      this, and it was real.
//   3. VOLATILITY — the fields that churn on every save must be dropped at
//      EVERY level, or opening a file breaks its own signature. This is what
//      makes the feature usable at all; get it wrong and every autosave
//      invalidates the chain.
//   4. ORDER — the chain must make reordering, removing and re-labelling
//      signatures detectable without trusting anybody's clock.
//
// Anything the Signatures panel RENDERS is also pinned, because the panel is
// where a false "✓ valid" would actually mislead someone.

import {
  canonicalize, digest, sign, verify, verifyChain, newKey, exportPub, VOLATILE,
} from '../type/src/canon.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => {
  checks++;
  if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`);
};
const H = (s: string) => console.log(`\n=== ${s} ===`);
const threw = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return (e as Error).message; }
};

// A document shaped like the real thing, so the properties are pinned against
// something a user could actually produce rather than a toy object.
const doc = (over: Record<string, unknown> = {}) => ({
  format: 'bento/type', version: 1, docId: 'doc-1', title: 'Agreement',
  body: [{ id: 'p1', kind: 'para', text: 'The fee is due within 30 days.' }],
  footnotes: {}, revisions: [], signatures: [], ...over,
});

// ────────────────────────────────────────────────────────────── 1. determinism
H('determinism — insertion order must not change one byte');
{
  ok(canonicalize({ b: 1, a: 2 }) === canonicalize({ a: 2, b: 1 }),
     'top-level keys canonicalize identically whatever order they were written in');

  const one = { z: { d: 4, c: 3 }, a: { b: 2, a: 1 } };
  const two = { a: { a: 1, b: 2 }, z: { c: 3, d: 4 } };
  ok(canonicalize(one) === canonicalize(two),
     'NESTED objects are sorted too — not just the top level');

  const arr1 = { xs: [{ q: 1, p: 2 }, { s: 3, r: 4 }] };
  const arr2 = { xs: [{ p: 2, q: 1 }, { r: 4, s: 3 }] };
  ok(canonicalize(arr1) === canonicalize(arr2),
     'objects INSIDE arrays are sorted too — the deepest place a bug hides');

  ok(canonicalize({ xs: [3, 1, 2] }) === '{"xs":[3,1,2]}',
     'arrays keep their order — an array is content, not a bag of keys');
  ok(canonicalize({ xs: [1, 2, 3] }) !== canonicalize({ xs: [3, 2, 1] }),
     'and reordering an array therefore changes the document');

  // The real thing: two hand-built copies of the same document, keys shuffled.
  const shuffled = { title: 'Agreement', docId: 'doc-1', signatures: [], revisions: [],
    footnotes: {}, body: [{ text: 'The fee is due within 30 days.', kind: 'para', id: 'p1' }],
    version: 1, format: 'bento/type' };
  ok(await digest(doc()) === await digest(shuffled),
     'a whole document digests identically with every key in a different place');
}

// ─────────────────────────────────────────────────────────── 2. key ordering
H('key ordering is by UTF-16 code unit (RFC 8785 §3.2.3), not by locale');
{
  ok(canonicalize({ a: 1, A: 2, Z: 3 }) === '{"A":2,"Z":3,"a":1}',
     'uppercase sorts before lowercase — a locale sort would interleave them');
  ok(['a', 'A', 'Z'].sort((x, y) => x.localeCompare(y)).join('') !== 'AZa',
     '(and localeCompare really would disagree, so this test discriminates)');

  ok(canonicalize({ a: 1, _: 2, '[': 3, '~': 4 }) === '{"[":3,"_":2,"a":1,"~":4}',
     'punctuation sorts by code point, not by any notion of "word characters"');

  ok(canonicalize({ z: 1, 'é': 2 }) === '{"z":1,"é":2}',
     'a non-ASCII key sorts after ASCII, by its code unit');

  // The discriminating case between UTF-16 code units and code POINTS: an
  // astral character is a surrogate pair starting at U+D83D, which is BELOW
  // U+FB00 as code units and ABOVE it as code points. RFC 8785 says code units.
  ok(canonicalize({ 'ﬀ': 1, '😀': 2 }) === '{"😀":2,"ﬀ":1}',
     'an astral key sorts by its LEADING SURROGATE — code units, not code points');
  ok([...'😀'][0].codePointAt(0)! > 'ﬀ'.codePointAt(0)!,
     '(by code point the order would be the other way round, so this test discriminates)');

  ok(canonicalize({ '': 1, a: 2 }) === '{"":1,"a":2}', 'the empty key sorts first');
}

// ──────────────────────────────────────────────────────────── 3. volatile fields
H('volatile fields are dropped at EVERY level, or saving breaks signing');
{
  ok(canonicalize({ modified: 'x', title: 'T' }) === '{"title":"T"}',
     'a volatile field is dropped at the root');

  const nested = { body: { modified: 'x', sync: {}, collab: {}, text: 'a' } };
  ok(canonicalize(nested) === '{"body":{"text":"a"}}',
     'and dropped one level down');
  ok(canonicalize({ a: [{ preview: 'png', keep: 1 }] }) === '{"a":[{"keep":1}]}',
     'and inside an array, which is where an "only at the root" bug survives');

  for (const k of VOLATILE) {
    ok(canonicalize({ [k]: 'anything', keep: 1 }) === '{"keep":1}',
       `'${k}' is excluded`);
  }

  // The property the whole feature rests on.
  const before = doc({ modified: '2026-01-01T00:00:00Z', sync: { v: 2, ops: [1, 2, 3] } });
  const after = doc({ modified: '2026-09-09T12:00:00Z', sync: { v: 9, ops: [] }, preview: '<svg/>' });
  ok(await digest(before) === await digest(after),
     'two saves of the SAME text digest identically — otherwise every autosave breaks the chain');

  ok(await digest(doc()) !== await digest(doc({ title: 'Other' })),
     'but a non-volatile field still counts');

  ok(canonicalize({ modified: 1, a: 2 }, { volatile: new Set(['a']) }) === '{"modified":1}',
     'the volatile set is a parameter, so a caller can canonicalize with a different one');

  ok(canonicalize({ a: 1, b: undefined }) === '{"a":1}',
     'a key explicitly set to undefined is indistinguishable from a missing one');
}

// ──────────────────────────────────────────────────────── 4. scalars and shapes
H('scalars — the places a serializer quietly disagrees with itself');
{
  ok(canonicalize({ n: -0 }) === '{"n":0}', 'negative zero serializes as 0 (RFC 8785)');
  ok(await digest({ n: -0 }) === await digest({ n: 0 }),
     'so -0 and 0 are the same document, which is what JSON round-tripping makes them');

  ok(threw(() => canonicalize({ n: NaN }))?.includes('non-finite'), 'NaN is refused, loudly');
  ok(threw(() => canonicalize({ n: Infinity }))?.includes('non-finite'), 'Infinity is refused');
  ok(threw(() => canonicalize({ n: -Infinity }))?.includes('non-finite'), '-Infinity is refused');

  ok(canonicalize({ n: 1e21 }) === '{"n":1e+21}', 'large numbers use ECMAScript Number::toString');
  ok(canonicalize({ n: 1e-7 }) === '{"n":1e-7}', 'and so do small ones');
  ok(canonicalize({ n: 1.5 }) === '{"n":1.5}', 'and ordinary ones are unsurprising');

  ok(canonicalize({ s: 'a"b\\c' }) === '{"s":"a\\"b\\\\c"}', 'quote and backslash are escaped');
  ok(canonicalize({ s: '\n\t\r\b\f' }) === '{"s":"\\n\\t\\r\\b\\f"}',
     'the short escapes are used for the five characters that have them');
  ok(canonicalize({ s: '\u0001\u001f' }) === '{"s":"\\u0001\\u001f"}',
     'other control characters take the \\u form, lowercase hex');
  ok(canonicalize({ s: '\u007f' }) === '{"s":"\u007f"}', 'DEL is NOT escaped — it is not a JSON control char');

  ok(canonicalize(null) === 'null' && canonicalize({ a: null }) === '{"a":null}', 'null');
  ok(canonicalize({ t: true, f: false }) === '{"f":false,"t":true}', 'booleans');
  ok(canonicalize({ a: [], o: {} }) === '{"a":[],"o":{}}', 'empty array and empty object are distinct');
  ok(canonicalize([]) !== canonicalize({}), 'and an empty array is not an empty object');

  ok(threw(() => canonicalize({ f: () => 1 }))?.includes('cannot canonicalize'),
     'a function is refused rather than silently vanishing');
}

// ───────────────────────────────────────────────────── 5. Unicode: the two rules
H('Unicode — NFC normalization, and NO two documents sharing bytes');
{
  const NFC = 'é', NFD = 'é';                    // é, two ways
  ok(NFC !== NFD, '(the two spellings really are different strings)');
  ok(await digest({ s: NFC }) === await digest({ s: NFD }),
     'a VALUE normalizes to NFC — a Mac and a Windows machine typing "é" agree');

  ok(await digest({ [NFC]: 1 }) === await digest({ [NFD]: 1 }),
     'a KEY normalizes to NFC as well, or the same document digests two ways');
  ok(await digest({ [NFC]: 1, z: 2 }) === await digest({ [NFD]: 1, z: 2 }),
     'and it normalizes BEFORE sorting, or the key lands in a different slot');

  ok(threw(() => canonicalize({ [NFC]: 1, [NFD]: 2 }))?.includes('duplicate'),
     'two keys that normalize to the SAME key is refused — silently emitting both '
     + 'produces JSON with duplicate keys whose order depends on insertion order');

  // INJECTIVITY. A lone surrogate is not valid Unicode, but it survives
  // JSON.parse('"\\ud800"') perfectly happily, so a document can contain one.
  // TextEncoder turns EVERY lone surrogate into U+FFFD, so unless they are
  // escaped, three different documents share one digest — and a signature over
  // any of them verifies against the other two.
  const hi = { s: '\uD800' }, lo = { s: '\uDC00' }, repl = { s: '�' };
  ok(await digest(hi) !== await digest(lo),
     'two different lone surrogates are two different documents');
  ok(await digest(hi) !== await digest(repl),
     'and a lone surrogate is not the same document as a literal U+FFFD');
  ok(canonicalize(hi) === '{"s":"\\ud800"}',
     'a lone surrogate is escaped (ES2019 well-formed JSON.stringify, per RFC 8785 §3.2.2.2)');
  ok(canonicalize({ s: '😀' }) === '{"s":"😀"}',
     'but a WELL-FORMED pair is emitted literally, not escaped');
  ok(await digest({ s: 'a\uD800b' }) !== await digest({ s: 'a\uDC00b' }),
     'and the same holds mid-string, which is how it would actually arrive');
}

// ──────────────────────────────────────────────────────────── 6. hostile shapes
H('hostile input — a parsed document is attacker-controlled');
{
  const poison = JSON.parse('{"__proto__":{"polluted":1},"b":2}');
  ok(canonicalize(poison) === '{"__proto__":{"polluted":1},"b":2}',
     '__proto__ is an ordinary key and is SIGNED, not skipped');
  ok(({} as Record<string, unknown>).polluted === undefined,
     'and canonicalizing it pollutes nothing');

  const deep = JSON.parse('{"a":{"constructor":{"prototype":{"x":1}}}}');
  ok(canonicalize(deep).includes('"constructor"'), 'so is "constructor"');

  ok(await digest({ a: 1, b: 2 }) !== await digest({ 'a":1,"b': 2 }),
     'a key containing JSON punctuation cannot forge a different structure');
  ok(canonicalize({ 'a":1,"b': 2 }) === '{"a\\":1,\\"b":2}', '(because it is escaped)');
}

// ─────────────────────────────────────────────────────────────── 7. signatures
H('a signature verifies its own document and nothing else');
{
  const d = doc();
  const key = await newKey();
  const s = await sign(d, key, { name: 'Alice' });

  ok((await verify(d, s)).ok, 'a fresh signature verifies against the document it covers');
  ok((await verify(d, s)).why === null, 'and reports no reason');
  ok(s.alg === 'ES256' && s.pub === await exportPub(key), 'it carries the algorithm and the public key');
  ok(s.prev === '', 'the first signature chains to nothing');
  ok(s.content === await digest(d), 'and records the content digest it signed');

  // One character. This is the whole promise of the feature.
  const edited = doc({ body: [{ id: 'p1', kind: 'para', text: 'The fee is due within 60 days.' }] });
  const r = await verify(edited, s);
  ok(!r.ok && r.why === 'content-changed',
     'changing ONE character of body text breaks it, and says so');

  const invisible = doc({ body: [{ id: 'p1', kind: 'para', text: 'The fee is due within 30 days.', marks: [{ from: 4, to: 7, m: 'b' }] }] });
  ok(!(await verify(invisible, s)).ok, 'so does adding a bold run — formatting is content');

  ok((await verify(doc({ modified: 'later', sync: { v: 3 } }), s)).ok,
     'but re-saving does not, which is why the volatile set exists');

  ok(!(await verify(doc({ docId: 'doc-2' }), s)).ok,
     'a signature does not travel to a document with a different docId');

  // The signed text is `…|<docId>|<content>|<prev>|<name>`. docId and name are
  // the two fields a document controls the LENGTH of, so both are quoted and
  // escaped — otherwise a docId full of separators could shift the other fields
  // along and make one signature's text collide with another's.
  const framed = { ...doc(), docId: 'a|b|c' };
  const fs = await sign(framed, key, { name: 'Alice' });
  ok((await verify(framed, fs)).ok, 'a docId containing separators signs and verifies');
  ok(!(await verify({ ...doc(), docId: 'a' }, { ...fs, content: await digest({ ...doc(), docId: 'a' }) })).ok,
     'and cannot be re-split into a different docId with the rest shifted along');
  ok(!(await verify(doc(), { ...s, name: 'Alice|extra' })).ok,
     'nor can a name smuggle a separator past the framing');

  const tamperedSig = { ...s, sig: s.sig.slice(0, -4) + (s.sig.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  const t1 = await verify(d, tamperedSig);
  ok(!t1.ok && t1.why === 'bad-signature', 'a mangled signature is rejected as bad-signature');

  const other = await newKey();
  const t2 = await verify(d, { ...s, pub: await exportPub(other) });
  ok(!t2.ok && t2.why === 'bad-signature', 'swapping in someone else\'s public key does not help');

  const t3 = await verify(d, { ...s, prev: 'something-else' });
  ok(!t3.ok && t3.why === 'bad-signature', 'rewriting `prev` breaks the signature');

  // The panel prints this name next to a green tick, so it must be signed.
  const t4 = await verify(d, { ...s, name: 'Mallory' });
  ok(!t4.ok && t4.why === 'bad-signature',
     'RELABELLING a valid signature breaks it — the name is beside the ✓ and must be covered');
}

// ─────────────────────────────────────────────────────────────────── 8. the chain
H('the chain — order without a trusted clock');
{
  const d = doc();
  const [ka, kb, kc] = [await newKey(), await newKey(), await newKey()];
  const a = await sign(d, ka, { name: 'Alice' });
  const b = await sign(d, kb, { name: 'Bob', prev: a });
  const c = await sign(d, kc, { name: 'Carol', prev: b });

  const good = await verifyChain(d, [a, b, c]);
  ok(good.ok, 'three signatures in sequence verify');
  ok(good.entries.length === 3 && good.entries.every(e => e.ok && e.linked && e.why === null),
     'and every entry is individually valid and linked');
  ok(good.entries.map(e => e.name).join(',') === 'Alice,Bob,Carol',
     'the entries carry the names the panel renders, in order');
  ok(b.prev === a.sig && c.prev === b.sig, 'each signature commits to the one before it');

  const swapped = await verifyChain(d, [a, c, b]);
  ok(!swapped.ok, 'reordering the chain fails');
  ok(swapped.entries[0].linked && !swapped.entries[1].linked,
     'and `linked` points at WHERE it broke, which is what the panel shows');
  ok(swapped.entries.every(e => e.ok),
     'while every signature is still individually valid — only the ORDER is wrong, '
     + 'so "not linked" and "invalid" are genuinely different messages');

  const dropped = await verifyChain(d, [a, c]);
  ok(!dropped.ok && dropped.entries[0].linked && !dropped.entries[1].linked,
     'removing a middle signature is detectable — c no longer follows what it committed to');

  const truncated = await verifyChain(d, [a, b]);
  ok(truncated.ok, 'truncating the END is NOT detectable — a chain proves order, not completeness');

  ok(!(await verifyChain(d, [b, c])).entries[0].linked,
     'and dropping the FIRST signature is detectable, because b commits to a');

  const forged = await verifyChain(d, [a, { ...b, name: 'Mallory' }, c]);
  ok(!forged.ok && !forged.entries[1].ok, 'relabelling a signature inside a chain is caught');

  ok((await verifyChain(d, [])).ok && (await verifyChain(d, [])).entries.length === 0,
     'an empty chain is vacuously ok — the panel must not render it as "verified" '
     + '(it early-returns on `!sigs.length`, which is what makes this safe)');
}

H('signing again after an edit — the chain reports the past honestly');
{
  const v1 = doc();
  const ka = await newKey(), kb = await newKey();
  const a = await sign(v1, ka, { name: 'Alice' });

  const v2 = doc({ body: [{ id: 'p1', kind: 'para', text: 'The fee is due within 60 days.' }],
                   signatures: [a] });
  const b = await sign(v2, kb, { name: 'Bob', prev: a });
  const chain = [a, b];

  const res = await verifyChain(v2, chain);
  ok(!res.ok, 'the chain as a whole no longer verifies, because the text moved under Alice');
  ok(!res.entries[0].ok && res.entries[0].why === 'content-changed',
     "Alice's signature honestly reports that this is not the text she signed");
  ok(res.entries[1].ok && res.entries[1].linked,
     "and Bob's is valid and linked — he signed the document as it now stands");
  ok(res.entries[0].linked, 'Alice is still LINKED — the order is intact, the content is not');

  ok((await verifyChain(v1, chain)).entries[0].ok,
     'and against the ORIGINAL text Alice verifies again — nothing was destroyed');

  ok(await digest(v2) === b.content,
     'signing digests the document INCLUDING the signature it chains from, because '
     + '`signatures` is volatile and never enters the digest');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
