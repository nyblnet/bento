# Stage 0 device probes (iOS)

Two test tools for measurements only a person with a real iPhone can make.
Neither is part of a Release build of bento/home:
`scripts/test-home-stage0-probes.mjs` builds both configurations and checks.

| probe | what it measures | where it lives | developer team |
|---|---|---|---|
| **Sign session (C1)** | the routine signing session ends when the app goes to the background, the device locks, or the clock moves back | DEBUG builds of bento/home: ⋯ menu → *Stage 0: sign session (C1)* | a free personal team is enough |
| **Passkey origin (Q3)** | the `origin` Apple writes into `clientDataJSON` when a native app creates or uses a passkey | this folder, its own Xcode project | needs the paid Apple Developer Program |

## Sign session (C1)

Runs the app's real signing path: the one session the app locks from
`sceneDidEnterBackground` and `applicationProtectedDataWillBecomeUnavailable`,
the identity host a document's `sign('show', 'live')` reaches, and the editor's
own device-owner prompt. The only stand-in is the account key, held in memory
while the screen is open: nothing is written to the Keychain.

Each **Sign** shows one of: *ASKED to re-authenticate*, *SIGNED without
asking*, or *refused (…)*. The log also records every lifecycle event iOS
delivers (background, protected data going away and coming back, clock changes)
and how far the clock moved, so each answer can be traced to its cause.
**Copy results** puts the whole log on the clipboard.

### Install (free personal team)

1. On the Mac: current Xcode, and `brew install xcodegen`.
2. Xcode → Settings → Accounts → **+** → Apple ID. Xcode creates a
   *Personal Team* for it.
3. `cd home/ios && xcodegen && open BentoTray.xcodeproj`
4. Select the **BentoTray** target → Signing & Capabilities → Team: your
   *(Personal Team)*. If Xcode says the bundle identifier `page.bento.home`
   is not available, change it to something of your own, such as
   `page.bento.home.<yourname>`; nothing in the probe depends on it.
   (`BENTO_TEAM_ID=<id> xcodegen` sets the team at generation time instead;
   a plain re-run of `xcodegen` resets the choice made in Xcode.)
5. Connect the iPhone with a cable, unlock it, tap **Trust**. Turn on
   Settings → Privacy & Security → **Developer Mode** (the switch appears once
   the phone has been connected to Xcode), let it restart, confirm.
6. In Xcode choose the iPhone as the run destination, scheme **BentoTray**, and
   press Run (⌘R). Run builds Debug.
7. The first launch is refused as an untrusted developer: on the iPhone,
   Settings → General → VPN & Device Management → your Apple ID → **Trust**.
   Press Run again.
8. In the app: ⋯ (top right) → **Stage 0: sign session (C1)**.

A personal team's install expires after 7 days (press Run again to renew), and
at most three such apps can be installed on one device at a time.

### What the answers mean on a phone

- Locking the screen also sends the app to the background, so (b) is answered
  by the background lock before the device-lock event arrives. The log shows
  both events and their order.
- Changing the clock means leaving for Settings, which also backgrounds the app
  on an iPhone, so (c) is answered by the background lock as well. On an iPad,
  open Settings in **Split View or Slide Over** beside the app: the app stays in
  the foreground, and only the clock check is left to answer.
- With **no passcode** the device-owner check cannot run at all: the log's
  first line says so, no prompt appears, and every Sign is refused. The session
  can never open, so there is nothing for backgrounding or locking to end.
  Turning the passcode off also removes Apple Pay cards from the phone.

## Passkey origin (Q3)

An app with the Associated Domains entitlement `webcredentials:<rp id>`, which
registers (**Create**) and asserts (**Sign in**) a passkey for that relying
party and shows `clientDataJSON` byte for byte, its `origin`, whether the
challenge and rp id hash match, and the UP/UV/BE/BS flags.

The rp id is the build setting `BENTO_PROBE_RP_ID` in `project.yml`
(`id.bento.page`); it is expanded into both the entitlement and the app. The
app id is `page.bento.home`, the one the rp's association file lists, so the
origin measured is the one bento/home itself would get. Installing it replaces
a bento/home build with the same id on the phone.

### What must exist first

- A paid Apple Developer Program team. A personal team cannot sign the
  Associated Domains entitlement.
- The App ID `page.bento.home` with **Associated Domains** enabled (Xcode's
  automatic signing does this on the first build if the team allows it).
- The rp host serving `https://<rp id>/.well-known/apple-app-site-association`
  over HTTPS with no redirect, as JSON, containing
  `{"webcredentials":{"apps":["<TEAMID>.page.bento.home"]}}`. Apple's CDN can
  take hours to pick up a new or changed file. While testing, the entitlement
  can be `webcredentials:<rp id>?mode=developer` with Settings → Developer →
  **Associated Domains Development** on, so the phone fetches the file
  directly.
- iCloud Keychain on (or another passkey provider), and a passcode.

### Install

1. `cd home/ios/Stage0 && BENTO_TEAM_ID=<TEAMID> xcodegen && open Stage0Probes.xcodeproj`
2. Steps 5–7 above, with the scheme **PasskeyOriginProbe**.
3. Tap **Create**, accept the passkey sheet; tap **Sign in**. **Copy results**.
4. Delete the passkey afterwards: Settings → Passwords, search for the rp.

An error 1004 that says the app is not associated with the domain means the
association file is missing, wrong, or not yet on Apple's CDN.
