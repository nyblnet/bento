// SPDX-License-Identifier: MIT
// Canonicalization + the signature chain, for bento/type.
//
// WHY THIS IS THE HIGH-RISK SMALL PIECE. A signature is over BYTES. If two
// honest parties can serialize the same document to different bytes, every
// signature is worthless; if two DIFFERENT documents can serialize to the same
// bytes, every signature is a forgery waiting to happen. Neither failure is
// visible until someone is in a dispute, which is the worst possible time.
//
// The rule set here is RFC 8785 (JSON Canonicalization Scheme) plus two
// deliberate additions, both of which JCS leaves open and both of which bite a
// word processor specifically:
//
//   1. UNICODE NORMALIZATION. JCS canonicalizes structure, not text. "é" as
//      U+00E9 and as U+0065 U+0301 are different byte strings and identical
//      documents — and a Mac and a Windows machine will genuinely produce
//      different ones from the same keystrokes. We normalize to NFC.
//   2. AN EXPLICIT EXCLUDE LIST, not an include list. Volatile fields
//      (modified, sync state, cached previews) must not enter the signature or
//      merely opening a file breaks it. An exclude list fails SAFE: a new
//      content field added by a later version is signed by default, whereas a
//      forgotten include would silently leave new content unsigned.
//
// `slides/src/autosave.ts` already computes a content key on this principle
// ("excludes volatile fields ... that churn without a real edit"). This is the
// same idea made exact enough to sign.

import type { Signature } from './model.ts';

export interface ChainEntry { ok: boolean; why: string | null; linked: boolean; name: string }
export interface ChainResult { ok: boolean; entries: ChainEntry[] }

/**
 * Fields that never enter a signature. Everything else is signed — including
 * `revisions`, deliberately: signatures cover content AND history, so trimming
 * history on a signed document is a re-sign by the signer, never a silent fold.
 *
 * This set answers ONE question — what may a signature not cover — and must
 * not be reused to answer "what counts as unsaved work". A signature excludes
 * itself, but losing a signature on crash recovery is still lost work. The
 * recovery key has its own set (autosave.ts NOT_EDIT); reusing this one there
 * is exactly how signatures became invisible to recovery.
 */
export const VOLATILE = new Set([
  'modified',      // touched by every save
  'sync',          // CRDT state, per-replica
  'collab',        // credentials + room state
  'preview',       // cached first-page render
  'signatures',    // the chain itself — a signature cannot cover itself
  'autosave',
]);

/** RFC 8785 number serialization: ECMAScript Number::toString, with -0 → 0. */
function num(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError(`non-finite number in document: ${n}`);
  if (Object.is(n, -0)) return '0';
  return String(n);
}

/**
 * RFC 8785 string serialization: minimal escaping, NFC-normalized.
 *
 * LONE SURROGATES ARE ESCAPED, and that is not a detail. `JSON.parse('"\\ud800"')`
 * succeeds, so a document really can carry an unpaired surrogate — and
 * TextEncoder maps EVERY one of them to U+FFFD. Emitted literally, "a\uD800b",
 * "a\uDC00b" and "a�b" would be three different documents sharing ONE
 * digest, so a signature over any of them verifies against the other two. That
 * is a collision, which is to say a forgery. Escaping them — what ES2019's
 * well-formed JSON.stringify does, and what RFC 8785 §3.2.2.2 points at — keeps
 * the map from documents to bytes injective. Well-formed pairs are still
 * emitted literally; `for…of` yields those as one code point above 0xFFFF.
 */
function str(s: string): string {
  const t = s.normalize('NFC');
  let out = '"';
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0xd800 && c <= 0xdfff) out += '\\u' + c.toString(16).padStart(4, '0');
    else if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/**
 * Canonical JSON. Keys sorted by UTF-16 code unit (RFC 8785 §3.2.3), volatile
 * fields dropped at EVERY level, no insignificant whitespace.
 *
 * KEYS ARE NORMALIZED BEFORE THEY ARE SORTED. Rule 1 at the top of this file
 * normalizes text to NFC, and a key is text. Normalizing on the way out but
 * sorting on the way in is the worst of both: "é" spelled U+00E9 sorts after
 * "z" while the same key spelled U+0065 U+0301 sorts before it, so one document
 * digests two ways depending on which keyboard produced the field name — the
 * exact determinism failure rule 1 exists to prevent. Sorting the normalized
 * form also makes the collision visible instead of silent: two keys that
 * normalize alike would otherwise emit an object with DUPLICATE keys, in
 * insertion order, which is neither valid JSON nor deterministic. That is
 * refused rather than serialized.
 */
export function canonicalize(value: unknown,
  { volatile = VOLATILE }: { volatile?: ReadonlySet<string> } = {}): string {
  const go = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return num(v);
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return '[' + v.map(go).join(',') + ']';
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const src = new Map<string, string>();      // normalized key -> as written
      for (const k of Object.keys(o)) {
        const n = k.normalize('NFC');
        if (volatile.has(n) || o[k] === undefined) continue;
        if (src.has(n)) throw new TypeError(`duplicate key after NFC normalization: ${n}`);
        src.set(n, k);
      }
      const keys = [...src.keys()].sort();        // UTF-16 code-unit order
      return '{' + keys.map(k => str(k) + ':' + go(o[src.get(k)!])).join(',') + '}';
    }
    throw new TypeError(`cannot canonicalize ${typeof v}`);
  };
  return go(value);
}

const enc = new TextEncoder();

// base64url, isomorphic. The first version used Node's Buffer, which passes
// every test under `node` and throws "Buffer is not defined" the moment the
// same module is loaded in a browser — where this code actually has to run.
// btoa/atob exist in both.
const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export async function digest(doc: unknown): Promise<string> {
  const bytes = enc.encode(canonicalize(doc));
  return b64u(await crypto.subtle.digest('SHA-256', bytes));
}

// ---------------------------------------------------------------- signatures
const EC = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

export const newKey = (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(EC, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
export const exportPub = async (k: CryptoKeyPair): Promise<string> =>
  b64u(await crypto.subtle.exportKey('raw', k.publicKey));

/**
 * The bytes a signature is taken over.
 *
 *     bento-type-sig.v1|<docId>|<content digest>|<prev sig or "">|<name>
 *
 * THE NAME IS IN HERE, and it was not always. `name` is self-asserted — the
 * signer chooses it and no crypto makes it true — but "self-asserted" has to
 * mean asserted BY THE SIGNER, and while the name sat outside the signed text
 * it was asserted by whoever held the file last: anyone could take a valid
 * signature, rewrite `name` to somebody else's, and the Signatures panel would
 * print that name beside a green ✓ valid. A claim the signature does not
 * support is exactly what the panel warns about; it must not be one the panel
 * itself manufactures. Bound in before bento/type's first release, so no
 * shipped signature is invalidated.
 *
 * `at` is deliberately NOT in here. It is a self-asserted wall clock that can
 * be backdated freely, the panel does not render it, and the model says it
 * proves nothing — signing it would only lend it the credibility it must not
 * have.
 *
 * docId and name are emitted through `str()` — quoted, escaped and
 * NFC-normalized — because they are the two variable-length fields a document
 * controls. Unquoted, a docId of `x|<digest>|<sig>` could shift every field
 * right and make one signature's text collide with another's. The digests
 * between them are fixed-alphabet base64url and cannot. Normalizing also means
 * a name typed on a Mac verifies on Windows, which is rule 1 again.
 */
const sigText = (docId: string, content: string, prev: string, name: string) =>
  `bento-type-sig.v1|${str(docId)}|${content}|${prev}|${str(name)}`;

/**
 * Sign a revision, chaining to the previous signature.
 *
 * Chaining is what buys ORDER without a trusted clock. A self-asserted
 * timestamp can be backdated freely, so it is carried for display and
 * deliberately NOT relied on; what cannot be faked is that signature n commits
 * to signature n-1, so the sequence is tamper-evident even though the times
 * are not. The UI should say "signed after B's revision", never "signed at
 * 14:32" — see type-design.md §3.3.
 */
export async function sign(
  doc: { docId: string },
  key: CryptoKeyPair,
  { name = '', prev = null }: { name?: string; prev?: { sig: string } | null } = {},
): Promise<Signature> {
  const content = await digest(doc);
  const prevSig = prev ? prev.sig : '';
  const text = sigText(doc.docId, content, prevSig, name);
  const sig = b64u(await crypto.subtle.sign(SIG, key.privateKey, enc.encode(text)));
  return { alg: 'ES256', pub: await exportPub(key), name, content, prev: prevSig, sig };
}

export async function verify(doc: { docId: string }, entry: Signature): Promise<{ ok: boolean; why: string | null }> {
  const content = await digest(doc);
  if (content !== entry.content) return { ok: false, why: 'content-changed' };
  const pub = await crypto.subtle.importKey('raw', unb64u(entry.pub), EC, false, ['verify']);
  const text = sigText(doc.docId, entry.content, entry.prev, entry.name ?? '');
  const ok = await crypto.subtle.verify(SIG, pub, unb64u(entry.sig), enc.encode(text));
  return { ok, why: ok ? null : 'bad-signature' };
}

/** Verify a whole chain: every signature valid, and correctly linked. */
export async function verifyChain(doc: { docId: string }, chain: Signature[]): Promise<ChainResult> {
  const out: ChainEntry[] = [];
  let expectedPrev = '';
  for (const entry of chain) {
    const r = await verify(doc, entry);
    const linked = entry.prev === expectedPrev;
    out.push({ ...r, linked, name: entry.name });
    expectedPrev = entry.sig;
  }
  return { ok: out.every(r => r.ok && r.linked), entries: out };
}
