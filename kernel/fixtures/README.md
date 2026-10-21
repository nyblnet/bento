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
- **Blob plaintext** is raw 32-byte big-endian private scalars: the account
  scalar alone while kx is unruled, or with kx appended under modes A and C. On
  import, each scalar must be in 1..n−1 AND its public point d·G must equal the
  public key in the directory-signed binding. A swapped blob fails closed.
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
  `kxMode`, the `bindText` it holds, and for `cns` its own `rp`, `audience`,
  `challenge`, `payloadText` and `docId`. `challengeSpent: true` means its
  challenge book has already seen that challenge.
- `transcripts`: the consent channel binding (security §24), including the
  refusals (a dotted audience, a challenge under 16 bytes, a padded challenge).
- `webauthn`: the light tier's `clientDataJSON.challenge` derivation (§27).
- `lowS`: pairs of valid ECDSA signatures. Verifiers must refuse the high-S one,
  and signers must emit only the low-S form.
- `purposes`: which payload each routine `SignPurpose` may sign.
- `addresses`: the one normal form for an email address.

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
- **kx placement is unruled** (identity-design §6b). Both the `bind.` and the
  `dev.` kx slots must be EMPTY in the default mode. Rows with `kxMode` A, B or C
  show the format the ruling will select.
- **The consent key is per use on Android** (measured by home-android on the
  emulator): one BiometricPrompt authorises exactly one signature, and the
  Keystore, not the UI, refuses a second. Residency in the TEE or StrongBox still
  needs a real phone.
