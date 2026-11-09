# Passkey origin probe (debug only)

A one-screen Android app that runs one passkey **registration** and one
**assertion** through Credential Manager for a relying party (default
`id.bento.page`, editable on screen) and shows what Android reports:

- the `origin` in `clientDataJSON` (for a native app, expected to be
  `android:apk-key-hash:<base64url of the signing certificate's SHA-256>`),
  next to the value the probe computes from its own signing key, with a
  yes/NO match line;
- every `clientDataJSON` field, in order, with any key beyond `type`,
  `challenge`, `origin`, `crossOrigin` and `topOrigin` listed as extra;
- the attestation format, the authenticator data flags (UP, UV, BE, BS),
  whether `rpIdHash` is the SHA-256 of the rp id, the public key algorithm,
  and whether an assertion's signature is high-S;
- the raw request and response JSON.

**Copy results** puts all of it on the clipboard. Every line is also logged
under the tag `OriginProbe` (`adb logcat -s OriginProbe`).

It is a separate application (package `page.bento.probe.origin`), not part of
bento/home: `:app` does not depend on it, it has no release variant, and
`scripts/test-home-android-probe-excluded.mjs` (run in CI) checks that the
release app's classpath and dex carry none of it.

## What the relying party must serve

Credential Manager only lets an app use passkeys for an rp whose
`https://<rp>/.well-known/assetlinks.json` names that app's package and
signing certificate. For this probe, the file must contain this statement
(add it to the list if the file already holds others), served over HTTPS as
`application/json` with no redirect:

```json
[
  {
    "relation": [
      "delegate_permission/common.handle_all_urls",
      "delegate_permission/common.get_login_creds"
    ],
    "target": {
      "namespace": "android_app",
      "package_name": "page.bento.probe.origin",
      "sha256_cert_fingerprints": [
        "<SHA-256 of the debug key that signs YOUR build, AA:BB:… form>"
      ]
    }
  }
]
```

`get_login_creds` is the relation passkeys check; `handle_all_urls` follows
Google's Credential Manager guide and does nothing here (the probe declares no
links). The fingerprint is the debug key of **the machine that builds the APK
you install**: every Android SDK install makes its own
`~/.android/debug.keystore`, so a fingerprint from another machine will not
match. Read it before installing with either of:

```sh
cd home/android && ./gradlew :originprobe:signingReport      # the "SHA-256" line of variant debug
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA256
```

The probe also prints the exact file for its own key and rp at the top of its
screen. After deploying, check what Google sees:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<rp>&relation=delegate_permission/common.get_login_creds`.

That statement lets any app signed with that debug key, under that package
name, use passkeys for the rp. On a test domain that is the point. On a
production rp, take it out when the measurement is done.

## Build and install

Needs Android 14 or newer (Credential Manager is part of the platform there)
and a passkey provider on the phone, such as Google Password Manager (signed
in to a Google account) or another password manager.

- **Android Studio:** open `home/android`, choose the `originprobe`
  configuration, Run with the phone connected (USB debugging on).
- **adb:** with the phone connected and USB debugging on,

  ```sh
  cd home/android
  ./gradlew :originprobe:installDebug
  # or build, then install the APK:
  ./gradlew :originprobe:assembleDebug
  adb install -r originprobe/build/outputs/apk/debug/originprobe-debug.apk
  ```

- **Sideload without a cable:** build as above, copy
  `originprobe-debug.apk` to the phone (Drive, email, USB storage), open it in
  Files and allow "Install unknown apps" for that app when asked.

No Play Console account is involved: the APK is signed with the builder's
debug key.

## Use

1. Check the rp id at the top (`id.bento.page`, or your test rp).
2. **Create**: the system passkey sheet appears; confirm with the screen lock.
   The report shows the origin and the rest.
3. **Sign in**: asks for the passkey just created (or any passkey for the rp
   if you have not created one in this run).
4. **Copy results** and paste them where you record measurements.

A failure shows the Credential Manager error type and message. An error that
names the rp, the origin or the association almost always means the
assetlinks.json above is missing, not yet visible to Google, or carries a
different fingerprint.

## Clean up

Delete the test passkeys in Google Password Manager (or your provider) and
uninstall: `adb uninstall page.bento.probe.origin`.
