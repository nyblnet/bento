# bento/id conformance vectors

`identity-v1.json` is the contract every host's statement code must pass:
the iOS/macOS agent (Swift), the Android agent (Kotlin), the desktop agent
(Rust), the extension (JS) and the directory. Each host must reach the stated
verdict on every row. The `reason` field is informative: match it where you can,
but the verdict is what counts.

The reference implementation is `kernel/src/statements.ts` (statements) and
`kernel/src/address.ts` (address normalisation). `scripts/test-statements.ts`
proves the reference passes every row. `scripts/gen-identity-vectors.ts`
regenerates the file. Regenerate only when the rules change: signatures are
random, so a regeneration changes bytes but not verdicts.

**The keys in this file are TEST KEYS ONLY.** Never use them for anything else.

`recovery-v1.json` holds the recovery-code and key-blob vectors (identity-design
§2f, signed by security §28). Unlike the statement vectors, every value in it is
DETERMINISTIC (fixed codes, salts and IVs), so a host must reproduce the exact
bytes end to end. Reference: `kernel/src/recovery.ts`. Rig:
`scripts/test-recovery.ts`. Generator: `scripts/gen-recovery-vectors.ts`.

- **Argon2id first.** Check your Argon2id against the `rfc9106` row (RFC 9106
  §5.3, with its own parameters) before trusting it. Then use OUR parameters:
  version 0x13, p = 1, m = 64 MiB, t = 3, a 32-byte tag, 16-byte salts.
- **Check the memory BEFORE allocating; don't count on catching the failure.**
  On Android, catching `OutOfMemoryError` around Argon2id does NOT fail closed.
  On a 48 MiB heap, the runtime's own threads hit the OOM and the process
  died. Measure the remaining heap first and refuse unless it covers the
  65,536 blocks plus headroom (each 1 KiB block costs 1,040 bytes on ART).
  iOS and desktop have their own memory behaviour, but the rule is the same:
  decide first, then allocate. (home-android, measured)
- **The code is 17 symbols: 16 data symbols and a check symbol**, printed
  `XXXX-XXXX-XXXX-XXXX-C`. Data symbols are Crockford base32 (no I, L, O, U).
  The check is the 80-bit value mod 37, with `* ~ $ = U` for 32 to 36. Every one
  of those five has its own row, because that's where hosts disagree. Parsing
  forgives case, spaces and hyphens, and reads O as 0 and I/L as 1. U is valid
  ONLY as the check symbol. Argon2id takes the 10 decoded BYTES, never the
  string.
- **HKDF salt "empty" means zero-length** (equivalent to 32 zero bytes). AES-GCM
  ciphertexts are `ciphertext ‖ 16-byte tag` with a 12-byte IV.
- **Blob plaintext is exactly 64 bytes**: the account scalar ‖ the RECOVERY kx
  scalar, each 32 bytes big-endian (kx placement mode C). On import, the length
  must be 64, each scalar must be in 1..n−1, AND each one's public point d·G
  must equal its public key in the directory-signed binding: the account key,
  and the binding's kx slot. A swapped blob fails closed. A 32-byte
  account-only plaintext (what every pre-C enrolment sealed) is REFUSED with
  `length`; never read it as a partial key set. `blobs.*.wrongLength` carries
  blobs of 32, 63, 65 and 96 bytes sealed under the right key and aad: each
  must decrypt and then be refused on length.
- **The PRF input is the UTF-8 bytes of `bento/id/prf/v1`.** A host that
  speaks CTAP `hmac-secret` directly, with no WebAuthn PRF API (libfido2 on
  desktop), must send `prf.hmacSecretSalt`: SHA-256("WebAuthn PRF" ‖ 0x00 ‖
  input), per WebAuthn L3 §10.1.4. Then the same security key returns the same
  32 bytes in a browser and on the desktop, and a blob sealed on one opens on
  the other. The `prf.wrong` values are the easy mistakes. (home-desktop)

  Apply that hash EXACTLY ONCE, and only where nothing else does (security §34):

  | Path | Who hashes | What you pass |
  |---|---|---|
  | CTAP `hmac-secret` directly (libfido2: Linux, any host driving the key itself) | **you** | `prf.hmacSecretSalt` |
  | a browser's WebAuthn PRF extension | the browser | the input (`prf.inputHex`), never the salt |
  | Windows `webauthn.dll` with the PRF extension | Windows | the input, never the salt |
  | a platform's own WebAuthn PRF API (Apple AuthenticationServices, Android Credential Manager) | the platform | the input, never the salt |

  Passing the salt to an API that hashes again gives the `SHA-256` of the salt:
  a third value, and a blob nothing else can open.
- **The pepper layer** is the directory's (share implements it). Its rows exist
  so the server code can be checked against the same bytes.

## What each section checks

- `statements`: one row per case. `type` names the verifier. `text` and `sig`
  are what arrives. The other fields are what the VERIFIER brings: its `now`,
  the `bindText` it holds, and for `cns` its own `rp`, `audience`,
  `challenge`, `payloadText` and `docId`. `challengeSpent: true` means its
  challenge book has already seen that challenge.
- `transcripts`: the consent channel binding (security §24), including the
  refusals (a dotted audience, a challenge under 16 bytes, a padded challenge).
- `webauthn`: the light tier's `clientDataJSON.challenge` derivation (§27).
- `lowS`: pairs of valid ECDSA signatures. Verifiers must refuse the high-S one,
  and signers must emit only the low-S form.
- `purposes`: which payload each routine `SignPurpose` may sign.
- `addresses`: the one normal form for an email address.
- `dreq`: account-signed requests to the directory (`dreq.`). The verifier
  brings `bindText` (the binding it serves as authoritative; the signer is its
  account key), its `state`, the `challenge` it issued, and the `subject` of the
  endpoint (bytes base64url): `pendingBindText` for contest,
  `attestationObject` + `clientDataJSON` for cred-add (the arg is
  sha256(attestationObject ‖ sha256(clientDataJSON))), `credentialId` for cred-del, `body` for rc-enrol. Every row
  carries `spendCalled`; every refusal before the spend is `grammar`.
- `rot`: `verifyRotation(prevBindText, nextBindText, nextSig, rotText, rotSig)`
  at the file's `now`. `prevBindText` is the binding the client pinned.
- `dreqConsent`: `cns` rows for the three op-specific purposes (`cred-add`,
  `cred-del`, `rc-enrol`), verified exactly like the `cns` rows in `statements`.

These three sections are separate from `statements` so a host runner that
refuses an unknown row type keeps passing until it adopts them.

## Notes for native implementers

- **Signatures are raw r‖s (64 bytes), low-S, base64url.** Android Keystore and
  Apple's Security framework emit DER: convert, then fold s to the lower half,
  before anything crosses the bridge. A DER or high-S signature is refused here,
  so a forgotten conversion fails loudly rather than silently.
- **Parse strictly.** Split on `.` and KEEP empty fields, then require the
  exact field count. The traps, by language:
  - Swift's `split(separator:)` DROPS empty fields by default
    (`omittingEmptySubsequences: true`). Use `components(separatedBy: ".")`, or
    pass `omittingEmptySubsequences: false`.
  - Kotlin's plain `split(".")` keeps them, like JS. A `limit` argument or a
    `.filter { it.isNotEmpty() }` loses them. (home-android, measured)
  - Rust's `str::split('.')` keeps them; `split_terminator` and filters don't.

  Base64url is canonical: no padding, and it must re-encode to the same string.
- **Addresses: the vectors are the contract, not a regex.** The reference
  avoids lookbehind, because Rust's `regex` crate has none. Implement the rules
  however your language allows, but pass every row. Phase 1 is ASCII-only: any
  character outside 0x21–0x7E is refused. A domain typed in its `xn--` form is
  accepted as typed.
- **Display names: embed the fixture's `displayForbidden` table.** Don't use
  your platform's `\p{Cf}`-style categories. Those come from each platform's
  Unicode tables, so a character newly assigned to a category would be refused
  on one host and accepted on another, and a name would verify on one device
  and not the next. The table is frozen at Unicode 17.0 as explicit ranges, and
  changing it is a format decision. It includes every code point UNASSIGNED at
  17.0, the 66 noncharacters among them, because one assigned later could be
  invisible. On top of the table: NFC is required, at most 64 code points, and
  ZWNJ/ZWJ (U+200C/U+200D) are allowed only mid-text. (home-desktop found the
  drift; security added the unassigned code points.)
- **Compare normalised text by code points, not by string equality, in Swift.**
  Swift's `String ==` is canonical equivalence, so a decomposed `é` compares
  equal to its NFC form and an NFC check written as `s == nfc(s)` passes text
  that isn't NFC. Compare `unicodeScalars` instead. (home-ios, measured)
- **Check a recovered private scalar with the platform's key constructor, never
  bignum arithmetic.** It's a secret, and a hand-rolled d·G is variable-time on
  it. CryptoKit's `P256.Signing.PrivateKey(rawRepresentation:)` refuses 0, n,
  n+1 and 2^256−1 and accepts 1 and n−1 (home-ios, measured). The Rust `p256`
  crate's `SecretKey::from_slice` is likewise constant-time (home-desktop).
  Derive the public key from it and compare that to the bound key.
- **Compute NFC with Unicode 17.0 (or later) data.** Normalisation is stable
  across versions only for assigned characters, and the table refuses
  everything unassigned at 17.0. So any normaliser at 17.0 or later agrees on
  every name the table lets through. A native port whose platform normaliser is
  older than 17.0 must embed a 17.0 one.
- **Spend the consent challenge FIRST.** A `cns.` attempt that gets past the
  grammar check must consume its challenge even when it is refused (rp, docId,
  transcript, expiry, signature). Otherwise a refused attempt's challenge stays
  live to be retried. A verdict can't show the order, so every `cns` row carries
  `spendCalled`: assert your spend callback was (or was not) invoked. A port
  that spends late passes every verdict and fails these. (home-desktop found the
  gap.)
- **kx placement is mode C** (identity-design §6b, ruled 2026-11-02; the
  fixture's top-level `kxMode`). Every `dev.` carries that device's own kx and
  every `bind.` carries the account's recovery kx: both slots are REQUIRED. An
  empty slot, a value that is not an uncompressed P-256 point, or one equal to a
  signing key of the same certificate is refused with `kx`. There is no other
  mode: no row carries `kxMode`, and a host must not keep a switch that accepts
  an empty slot or a 32-byte blob. Enrolments made before the ruling (no kx,
  32-byte blobs) are test enrolments: DISCARD them, never migrate.
- **The consent key is per use on Android** (measured by home-android on the
  emulator): one BiometricPrompt authorises exactly one signature, and the
  Keystore, not the UI, refuses a second. Residency in the TEE or StrongBox still
  needs a real phone.

## `link`: device linking, link v1

Reference: `kernel/src/link.ts`. Rig: `scripts/test-link.ts` (and
`scripts/test-link-mutants.ts`). The derivation rows are DETERMINISTIC (fixed
codes, ephemeral scalars, ivs and account scalars), so reproduce them byte for
byte. Only the ECDSA signatures inside msg2 and msg3 are random; those rows are
judged by verdict, like the statement rows.

- `codes`: code bytes → printed form (the recovery-code format), the slot `id`,
  `tok`, `tokHash` (SHA-256 of the token's 32 bytes) and `salt`, each by
  HKDF-SHA-256 with an EMPTY salt and info `bento/id/link/v1/{id,tok,salt}`.
- `sessions`: two honest runs, one per displayer role. From the two ephemeral
  scalars: msg0, msg1, the transcript `t`, Z (the ECDH x-coordinate),
  `h2n`, `n2h`, the SAS key and the SAS. `t` is base64url; HKDF infos append it
  as text: `bento/id/link/v1/h2n.` ‖ t.
- `sas`: SAS key → 6 digits (first 4 bytes big-endian, mod 1,000,000,
  zero-padded). `sasMatch`: what a person typed vs the SAS; only spaces and
  hyphens are ignored, and full-width digits are not digits.
- `roles`: whether the scanner may proceed, from the displayer's claimed role
  and whether the scanner holds an account.
- `msgs`: msg0/msg1 grammar (`kind` names the parser). `reflected`: E_S = E_D
  gets no transcript.
- `msg2`: the exact ciphertext of an offer: key `n2h`, iv, AAD
  `lnka.v1.<t>.2`, plaintext → wire (base64url of iv ‖ ciphertext ‖ tag).
- `offers`: the offer plaintext as H checks it (`verifyOffer`), including the
  proofs of possession over `lnkp.v1.<t>`. `offerWire`: opening msg2 under the
  wrong direction's key, the wrong message number or another transcript must
  fail to decrypt.
- `bind` and `msg3`: the account binding, the released account scalar, the
  address, and the exact SEALED ciphertext (key `h2n`, AAD `lnka.v1.<t>.3`,
  plaintext = the 32-byte ACCOUNT SCALAR ‖ the ADDRESS in UTF-8). The address
  is 1 to 254 bytes, so SEALED is 12 + 32 + 1 + 16 to 12 + 32 + 254 + 16 bytes
  (`SEALED_MIN_LEN`, `SEALED_MAX_LEN`); outside that range is `grammar` in both
  `release` and `final`. Never the recovery kx (security §26c.4): N's history
  comes from H re-wrapping to N's kx. The directory sees only the length, so
  the old 64-byte payload (account ‖ recovery kx) passes `release` and N
  refuses it in `final` (`address`).
- `release`: the DIRECTORY's check before it hands msg3 to N
  (`verifyLinkRelease`). The verifier brings `bindText` (the binding it serves),
  its `state`, the `challenge` it issued and whether that challenge is already
  spent. Every row carries `spendCalled`: every refusal before the spend is
  `grammar`, everything after it has consumed the challenge. A malformed
  served binding is `bind` (after the spend), never a crash; N's dev. naming
  H's own devicePub is `n-device-is-h`. Every msg3 line is printable ASCII
  0x21–0x7E: a space, a control or a non-ASCII byte in any line is `grammar`.
- `final`: N's check of msg3 (`openFinal`), given what it offered (`offer`), the
  keys it pinned (`link.directoryKeys`, this section's own) and `lookup`, the
  directory's answers by address (`bindText`, `bindSig`, `attText`, `attSig`;
  an address with no entry is a failed lookup, `lookup`). The sealed address
  must be strict UTF-8 and already in normal form (`address`: it re-normalises
  to itself under `normalizeAddress`, so case, a Unicode dot, whitespace or a
  byte-order mark are refused, even when `lookup` has an entry for that exact
  text). Only then does N look it up, and every row's `lookupCalled` says
  whether it got that far. The answer's binding must verify (`bind-*`), be for
  exactly that address (`address-mismatch`), and be attested under a pinned key
  (`att-*`) as `active` (`state`), the att. at most `LINK_ATT_MAX_MS` (10
  minutes) old. The 32-byte scalar must be in 1..n−1 and the private half of
  that binding's accountPub: another account's scalar, the binding's recovery
  kx scalar, or an address whose binding names another account is
  `key-mismatch`. An accept row carries the `address` and `displayName` (the
  binding's name, or null) that `openFinal` returns.
- `wire`: how each message travels on the slot (`encodeSlotMsg` /
  `decodeSlotMsg`), `n` naming the message. msg0 and msg1 are canonical
  unpadded base64url of their UTF-8 text; msg2 is its sealed wire as is; msg3
  is its text as is. An accept row's `wire` decodes to `text` and `text`
  encodes to `wire`, byte for byte. Refused as `grammar`: padding, a set
  trailing bit, bytes that are not UTF-8, a byte-order mark, a msg0/msg1 sent
  raw, a message under the wrong number, an empty message, a msg2 shorter than
  an iv and a tag, and anything over 4096 bytes once decoded. The limit is
  always on the DECODED message: for msg2 that is the sealed bytes, so its
  base64url text may be longer than 4096 characters.

Host port notes for link v1:

- Verifiers answer every row; none may throw. A malformed input is a refusal
  with a reason.
- The platform field is shown through a FIXED map of known tokens. A token the
  host does not know is shown as unknown, never presented as verified.
- After linking, N shows the label H wrote into N's dev., not the one N
  offered.
- N asks before it stores. When `openFinal` accepts, N shows
  `Link this device to <address> (<name>)?`, with the address and name it
  returned, and stores nothing until the person agrees. Declining aborts and
  deletes the slot. The address comes from SEALED: a typed address is only a
  fallback for when the lookup fails, and it never replaces the binding check.
- Each direction key seals exactly ONE message (n2h message 2, h2n message 3).
  A retry is a new slot with a new code, never a second message under a key.
