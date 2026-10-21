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
  canonicalize, digest, sign, verify, verifyAll, sigId, signatureOrder, latestSignature, isLowS, newKey, exportPub, VOLATILE,
  SIGNED_EXCLUDE, historyCommitment, newHistorySalt, historyDisplay,
} from '../type/src/canon.ts';
import { readFileSync } from 'node:fs';
import { TYPE_FIELDS } from '../type/src/docclass.ts';

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
// v2 signatures commit to the history under the document's own salt, so every
// fixture carries one — the same salt throughout, as a real document's never
// rotates. Minted by the real minter, so it is a real 16-byte salt.
const SALT = newHistorySalt();
const doc = (over: Record<string, unknown> = {}) => ({
  format: 'bento/type', version: 1, docId: 'doc-1', title: 'Agreement',
  body: [{ id: 'p1', kind: 'para', text: 'The fee is due within 30 days.' }],
  footnotes: {}, revisions: [], signatures: {}, historySalt: SALT, ...over,
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
  const shuffled = { title: 'Agreement', docId: 'doc-1', signatures: {}, revisions: [],
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

// ───────────────────────────────────────────── 8. each signature on its own (ruling 7)
// Signatures are keyed by SigId and verified independently: `prev` is ordering
// information, and a fork or a missing predecessor never makes one invalid.
const keyed = (d: { docId: string }, ...sigs: Signature[]): Record<string, Signature> =>
  Object.fromEntries(sigs.map(x => [sigId(d.docId, x), x]));
const idOf = (d: { docId: string }, x: Signature) => sigId(d.docId, x);

H('ruling 7: each signature stands on its own; `prev` is ordering');
{
  const d = doc();
  const [ka, kb, kc] = [await newKey(), await newKey(), await newKey()];
  const a = await sign(d, ka, { name: 'Alice' });
  const b = await sign(d, kb, { name: 'Bob', prev: idOf(d, a) });
  const c = await sign(d, kc, { name: 'Carol', prev: idOf(d, b) });
  const all = await verifyAll(d, keyed(d, a, b, c));
  ok(all.ok && all.entries.every(e => e.ok && e.why === null), 'three signatures each verify');
  ok(all.entries.map(e => e.sig.name).join(',') === 'Alice,Bob,Carol', 'shown in `prev` order, whatever the map order');
  ok(b.prev === idOf(d, a) && c.prev === idOf(d, b), '`prev` holds the SigId of the signature followed');
  ok(all.entries[1].after === idOf(d, a) && all.entries[0].after === null, 'and each entry says which one it follows');
  const reversed = await verifyAll(d, Object.fromEntries(Object.entries(keyed(d, a, b, c)).reverse()));
  ok(reversed.entries.map(e => e.sig.name).join(',') === 'Alice,Bob,Carol', 'the order does not depend on key order in the file');

  // ROW 7: a fork — two signatures following the same one — is never invalid
  const c2 = await sign(d, kc, { name: 'Carol', prev: idOf(d, a) });
  const fork = await verifyAll(d, keyed(d, a, b, c2));
  ok(fork.ok && fork.entries.every(e => e.ok), 'a fork (two signatures after the same one): every signature valid');
  ok(fork.entries[0].sig.name === 'Alice' && fork.entries.filter(e => e.after === idOf(d, a)).length === 2,
     'both siblings shown after the one they follow');
  // a signature whose predecessor this copy does not hold is still valid
  const orphan = await verifyAll(d, keyed(d, c));
  ok(orphan.ok && orphan.entries[0].after === null, 'a signature whose `prev` is not on this copy is still valid, just first');
  ok(latestSignature(keyed(d, a, b, c)) === idOf(d, c), 'a new signature follows the latest in display order');
  ok(latestSignature({}) === null, 'and the first follows none');

  const forged = await verifyAll(d, keyed(d, a, { ...b, name: 'Mallory' }));
  ok(!forged.entries.find(e => e.sig.name === 'Mallory')!.ok, 'relabelling a signature is caught');
  ok((await verifyAll(d, {})).ok && (await verifyAll(d, {})).entries.length === 0,
     'no signatures is vacuously ok — the panel early-returns on an empty map');
}

H('ruling 7: SigId is derived from what was signed (row 8)');
{
  const d = doc();
  const k = await newKey();
  const a = await sign(d, k, { name: 'Alice' });
  const id = idOf(d, a);
  ok(/^[A-Za-z0-9_-]{43}$/.test(id), 'a SigId is a 256-bit base64url digest');
  const again = await sign(d, k, { name: 'Alice' });
  ok(again.sig !== a.sig && idOf(d, again) === id,
     'the same act of signing (same key, same text) has the same id whatever bytes ECDSA drew');
  ok(idOf(d, { ...a, name: 'Alicia' }) !== id && idOf({ docId: 'doc-2' }, a) !== id,
     'a different name, or a different document, is a different id');
  const misfiled = await verifyAll(d, { ['A'.repeat(43)]: a });
  ok(!misfiled.ok && misfiled.entries[0].why === 'bad-id', 'an entry under a key its own fields do not produce is INVALID');
  const both = await verifyAll(d, { [id]: a, [idOf(d, again)]: again });
  ok(both.entries.length === 1, 'the same signature delivered twice is ONE key');

  // TWO SIGNERS, IDENTICAL TEXT. The signed text holds no key, so two people
  // co-signing the same version under the same (or an empty) name sign the very
  // same bytes. The key is what tells them apart: without it in the SigId one
  // would overwrite the other in the map.
  const { parseDoc } = await import('../type/src/model.ts');
  const k1 = await newKey(), k2 = await newKey();
  for (const nm of ['', 'Same Name']) {
    const s1 = await sign(d, k1, { name: nm }), s2 = await sign(d, k2, { name: nm });
    ok(s1.content === s2.content && s1.history === s2.history && s1.prev === s2.prev && s1.name === s2.name && s1.pub !== s2.pub,
       `  (two keys signed identical text, name ${JSON.stringify(nm)})`);
    ok(idOf(d, s1) !== idOf(d, s2), `two signers of identical text get DISTINCT SigIds (name ${JSON.stringify(nm)})`);
    const merged = await verifyAll(d, keyed(d, s1, s2));
    ok(merged.entries.length === 2 && merged.ok, 'and both survive side by side, and both verify');
    const conv = parseDoc(JSON.stringify({ ...d, signatures: [s1, s2] }));
    ok(conv.ok && Object.keys(conv.doc.signatures).length === 2, 'an old array holding both converts to two keys, not one');
  }
}

H('ruling 7: old files convert on open (row 10)');
{
  const { parseDoc } = await import('../type/src/model.ts');
  // a document as a real file holds it (parseDoc fills defaults such as the
  // page, which is content — so sign the parsed form, as Sign does)
  const p0 = parseDoc(JSON.stringify(doc()));
  if (!p0.ok) throw new Error('fixture did not parse');
  const d = p0.doc;
  const ka = await newKey(), kb = await newKey();
  const a = await sign(d, ka, { name: 'Alice' });
  // made before ids: `prev` holds the earlier signature's BYTES
  const b = await sign(d, kb, { name: 'Bob', prev: a.sig });
  const old = { ...d, signatures: [a, b, { junk: true }, a] };       // an ARRAY, a junk entry, a duplicate
  const p1 = parseDoc(JSON.stringify(old));
  ok(p1.ok, 'an array-shaped file opens');
  const m = p1.ok ? p1.doc.signatures : {};
  ok(!Array.isArray(m) && Object.keys(m).sort().join() === [idOf(d, a), idOf(d, b)].sort().join(),
     'and converts to the map, each keyed by its derived SigId (junk dropped, the duplicate one key)');
  const res = await verifyAll(p1.ok ? p1.doc : d, m);
  ok(res.ok && res.entries.map(e => e.sig.name).join(',') === 'Alice,Bob',
     'the converted signatures verify, in order — a byte-valued `prev` still orders them');
  ok(res.entries[1].after === idOf(d, a), 'and the old byte link resolves to the earlier SigId');
  const absent = { ...d } as Record<string, unknown>; delete absent.signatures;
  const p2 = parseDoc(JSON.stringify(absent));
  ok(p2.ok && !('length' in (p2.doc.signatures as object)) && Object.keys(p2.doc.signatures).length === 0,
     'a file with NO signatures key opens, with an empty map (the absent-field case)');
  const asMap = parseDoc(JSON.stringify({ ...d, signatures: { [idOf(d, a)]: a, bogus: 'not an object' } }));
  ok(asMap.ok && Object.keys(asMap.doc.signatures).join() === idOf(d, a), 'a map keeps its object entries and drops anything else');
}

H('ruling 7: LOW-S (row 13)');
{
  const d = doc();
  const k = await newKey();
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
  const raw = (x: Signature) => new Uint8Array(Buffer.from(x.sig, 'base64url'));
  let high = 0;
  for (let i = 0; i < 48; i++) if (!isLowS(raw(await sign(d, k, { name: 'Alice' })))) high++;
  ok(high === 0, `sign() never emits a high s, sampled over 48 signatures (${high} high)`);
  // its malleated twin: (r, n − s), a second VALID ECDSA signature over the same text
  const a = await sign(d, k, { name: 'Alice' });
  const r = raw(a), s = BigInt('0x' + Buffer.from(r.slice(32)).toString('hex'));
  const twin = new Uint8Array(64); twin.set(r.slice(0, 32));
  twin.set(Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex'), 32);
  const pub = await crypto.subtle.importKey('raw', Buffer.from(a.pub, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const text = new TextEncoder().encode(`bento-type-sig.v2|"${d.docId}"|${a.content}|${a.history}||"Alice"`);
  ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, twin, text),
     'control: WebCrypto DOES accept the high-S twin, so the rejection below is ours');
  const hi = { ...a, sig: b64(twin) };
  ok(!(await verify(d, hi)).ok, 'verify REJECTS the high-S twin');
  ok(idOf(d, hi) === idOf(d, a), 'and the twin lands on the SAME SigId, so it can never pose as a new signature');
}

H('the synchronous SHA-256 behind SigId (sha256.ts)');
{
  const { sha256 } = await import('../type/src/sha256.ts');
  const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
  const te = new TextEncoder();
  ok(hex(sha256(te.encode('abc'))) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'FIPS 180-4 vector "abc"');
  ok(hex(sha256(new Uint8Array(0))) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'and the empty string');
  ok(hex(sha256(te.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))) === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
     'and the 448-bit two-block vector');
  let bad = 0;
  for (let n = 0; n <= 200; n++) {
    const data = crypto.getRandomValues(new Uint8Array(n));
    if (hex(sha256(data)) !== hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))) bad++;
  }
  ok(bad === 0, `matches WebCrypto on random input of every length 0..200 (${bad} mismatches)`);
  let big = 0;
  for (const n of [4095, 4096, 4097, 65535, 65536, 1 << 20]) {
    const data = crypto.getRandomValues(new Uint8Array(Math.min(n, 65536)));
    const full = new Uint8Array(n); for (let i = 0; i < n; i += data.length) full.set(data.subarray(0, Math.min(data.length, n - i)), i);
    if (hex(sha256(full)) !== hex(new Uint8Array(await crypto.subtle.digest('SHA-256', full)))) big++;
  }
  ok(big === 0, `and on large inputs around block and buffer boundaries, up to 1 MiB (${big} mismatches)`);
  const backing = crypto.getRandomValues(new Uint8Array(500));
  const view = backing.subarray(13, 13 + 333);                    // an offset VIEW into a bigger buffer
  ok(hex(sha256(view)) === hex(new Uint8Array(await crypto.subtle.digest('SHA-256', view.slice()))),
     'and on a subarray view at an offset (it hashes the view, not the whole buffer)');
}

H('signing again after an edit — the past is reported honestly');
{
  const v1 = doc();
  const ka = await newKey(), kb = await newKey();
  const a = await sign(v1, ka, { name: 'Alice' });
  const v2 = doc({ body: [{ id: 'p1', kind: 'para', text: 'The fee is due within 60 days.' }], signatures: keyed(v1, a) });
  const b = await sign(v2, kb, { name: 'Bob', prev: idOf(v2, a) });
  const res = await verifyAll(v2, keyed(v2, a, b));
  ok(!res.ok, 'the set as a whole no longer verifies, because the text moved under Alice');
  ok(!res.entries[0].ok && res.entries[0].why === 'content-changed', "Alice's signature honestly reports that this is not the text she signed");
  ok(res.entries[1].ok && res.entries[1].after === idOf(v2, a), "and Bob's is valid, shown after Alice's");
  ok((await verifyAll(v1, keyed(v1, a))).entries[0].ok, 'and against the ORIGINAL text Alice verifies again — nothing was destroyed');
  ok(await digest(v2) === b.content,
     'signing digests the document INCLUDING the signature it follows, because `signatures` never enters the digest');
}

// ════════════════════════════════════════════════════════════════════ v2
// Signatures sign the CONTENT plus a salted COMMITMENT to the history
// (maintainer ruling 2026-10-15), so a view-only copy — no revisions, no salt,
// read-only — still verifies. Each row below states one property of that.

H('v2: the content digest covers exactly the content — derived from the class map');
{
  // Which fields the digest attests is stated in canon.ts in prose; this is the
  // same statement made by MEASURING. Every content/identity field moves the
  // digest; every excluded field does not. Derived from TYPE_FIELDS, so a field
  // classified later is checked without anyone remembering this rig.
  const base = doc();
  const d0 = await digest(base);
  const moves = async (k: string) => d0 !== await digest({ ...base, [k]: { probe: k } });
  for (const [k, cls] of Object.entries(TYPE_FIELDS)) {
    const excluded = SIGNED_EXCLUDE.has(k);
    if (excluded) ok(!(await moves(k)), `${k} (${cls}) is NOT in the content digest`);
    else ok(await moves(k), `${k} (${cls}) IS in the content digest`);
  }
  for (const k of ['revisions', 'comments', 'historySalt', 'collab', 'readonly', 'template', 'signatures', 'modified'])
    ok(SIGNED_EXCLUDE.has(k), `${k} is excluded by name, as canon.ts says`);
  ok(await moves('undeclaredFutureField'), 'an UNDECLARED field is signed — the exclude list fails safe');
}

H('v2: the history commitment');
{
  const revs = [{ id: 'rev-1', at: 'x', label: 'Revision 1', body: [{ id: 'p1', kind: 'para', text: 'within 30 days' }] }];
  const s2 = newHistorySalt();
  ok(SALT.length === 22 && s2.length === 22 && SALT !== s2, 'a salt is 16 bytes as 22 base64url chars, and fresh each time');
  ok(await historyCommitment(revs, SALT) !== await historyCommitment(revs, s2),
    'the SAME revisions under two salts commit differently — the salt is what hides the drafts');
  ok(await historyCommitment(revs, SALT) === await historyCommitment(JSON.parse(JSON.stringify(revs)), SALT),
    'and the same revisions under the same salt commit identically');
  // The domain tag is part of the preimage: recompute without it and compare.
  const enc = new TextEncoder();
  const raw = Uint8Array.from(atob(SALT.replace(/-/g, '+').replace(/_/g, '/') + '=='), c => c.charCodeAt(0));
  const body = enc.encode(canonicalize(revs));
  const untagged = new Uint8Array(raw.length + body.length); untagged.set(raw); untagged.set(body, raw.length);
  const h = await crypto.subtle.digest('SHA-256', untagged);
  const untaggedB64 = btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  ok(await historyCommitment(revs, SALT) !== untaggedB64, 'the commitment is DOMAIN-TAGGED — not a bare sha256(salt||revisions)');
  let threw = false; try { await historyCommitment(revs, 'short'); } catch { threw = true; }
  ok(threw, 'a salt that is not 16 bytes is refused, not silently used');
}

H('v2: attestation and history are reported separately');
{
  const revs = [{ id: 'rev-1', at: 'x', label: 'Revision 1', body: [] }];
  const d = doc({ revisions: revs });
  const k = await newKey();
  const s = await sign(d, k, { name: 'Alice' });
  ok(typeof s.history === 'string' && s.history === await historyCommitment(revs, SALT),
    'a v2 signature carries the commitment to the history it signed');
  const own = await verify(d, s);
  ok(own.ok && own.history === 'matches', 'on its own document: valid, and the history matches');

  // ⋯ → Snapshot after signing: the TEXT is identical, only history moved.
  const snapped = doc({ revisions: [...revs, { id: 'rev-2', at: 'y', label: 'Revision 2', body: [] }] });
  const r1 = await verify(snapped, s);
  ok(r1.ok, 'a Snapshot does NOT break the attestation — the content is what was signed');
  ok(r1.history === 'changed', 'but the history reports CHANGED — signatures still cover it');

  // A view-only copy: no revisions, no salt, read-only.
  const reader: Record<string, unknown> = { ...d, readonly: true };
  delete reader.revisions; delete reader.historySalt;
  const r2 = await verify(reader as never, s);
  ok(r2.ok && r2.history === 'not-included',
    'a READER-tier copy verifies, and its missing history is neutral — it never carries history');

  // The SAME document, EDITABLE, with the history deleted: a warning, not grey.
  const stripped: Record<string, unknown> = { ...d };
  delete stripped.revisions;
  const r3 = await verify(stripped as never, s);
  ok(r3.ok && r3.history === 'missing',
    'an EDITABLE document that lost its revisions reports MISSING — deleting history cannot fake "neutral"');
  const unsalted: Record<string, unknown> = { ...d }; delete unsalted.historySalt;
  ok((await verify(unsalted as never, s)).history === 'missing', 'and so does one that lost its salt');

  const forged = await verify(d, { ...s, history: await historyCommitment([], SALT) });
  ok(!forged.ok && forged.why === 'bad-signature', 'a forged `history` field breaks the signature itself');
  const resalted = await verify({ ...d, historySalt: newHistorySalt() }, s);
  ok(resalted.ok && resalted.history === 'changed', 'swapping the salt reads as changed history, never as a match');

  let threw = false; try { await sign({ docId: 'x', revisions: [] }, k, {}); } catch { threw = true; }
  ok(threw, 'signing a document with no salt is refused — the caller mints it, in the document');
}

H('v2: a re-sign after trimming the history');
{
  const r1 = { id: 'rev-1', at: 'x', label: 'Revision 1', body: [] };
  const r2 = { id: 'rev-2', at: 'y', label: 'Revision 2', body: [] };
  const full = doc({ revisions: [r1, r2] });
  const ka = await newKey(), kb = await newKey();
  const before = await sign(full, ka, { name: 'Alice' });
  const trimmed = doc({ revisions: [r2], signatures: keyed(full, before) });
  const after = await sign(trimmed, kb, { name: 'Bob', prev: idOf(trimmed, before) });
  const res = await verifyAll(trimmed, keyed(trimmed, before, after));
  ok(res.entries[1].ok && res.entries[1].history === 'matches', 'the re-sign attests the TRIMMED history');
  ok(res.entries[0].ok && res.entries[0].history === 'changed',
    'and the pre-trim signature still attests the content but reports its history CHANGED — '
    + 'expected after a trim, and the UI must say a trim does this');
}

H('the panel shows history only where this replica can know it (ruling 8)');
{
  // History does not sync, so another replica's signature routinely reads
  // "changed" or "missing" here — the EXPECTED condition. Showing that as a
  // warning trains people to ignore it. So: compared and shown for THIS
  // device's signatures; neutral for everyone else's.
  const d = (st: Parameters<typeof historyDisplay>[0], mine: boolean) => historyDisplay(st, mine);
  ok(d('changed', true).tone === 'warn' && d('changed', true).line === 'changed', 'MY signature, history changed → a warning');
  ok(d('missing', true).tone === 'warn' && d('missing', true).line === 'missing', 'MY signature, history missing → a warning');
  ok(d('changed', false).tone === 'neutral' && d('changed', false).line === 'elsewhere',
    'SOMEONE ELSE\'s signature whose history differs → neutral "kept on the signer\'s copy", never a warning');
  ok(d('missing', false).tone === 'neutral' && d('missing', false).line === 'elsewhere',
    'and the same when this replica holds none of their history');
  ok(d('matches', false).tone === 'ok' && d('matches', true).tone === 'ok',
    'a match is shown for anyone — this replica demonstrably holds the signed history');
  ok(d('not-included', false).tone === 'neutral' && d('not-included', true).tone === 'neutral',
    'a view-only copy is neutral either way');
  const tones = (['matches', 'changed', 'missing', 'not-included'] as const).flatMap(st => [d(st, true), d(st, false)]);
  ok(!tones.some(x => x.tone === 'ok' && x.line !== 'matches'),
    'nothing but an actual match is ever shown as ok — a neutral line never reads as safe');

  // The panel decides "mine" by comparing against THIS device's key, read
  // without minting one. Checked by source: DOM code no rig can run.
  const main = readFileSync(new URL('../type/src/main.ts', import.meta.url), 'utf8');
  ok(/historyDisplay\(r\.history, mine !== null && s\.pub === mine\)/.test(main),
    'the panel passes "mine" only for a signature made with this device\'s own key');
  const dp = main.slice(main.indexOf('async function devicePub'), main.indexOf('const fingerprint'));
  ok(/if \(!saved\) return null;/.test(dp) && dp.indexOf('if (!saved) return null;') < dp.indexOf('getKey()'),
    'and devicePub returns null BEFORE getKey can mint a key — painting never creates one');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
