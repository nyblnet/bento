// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The test tiers: which CI steps the quick check runs (fast), which the sweep
// adds (full), and which run only with --deep.
//
//   fast   node scripts/check.mjs --affected: the steps a diff reaches, nearest
//          first, inside the time budget. The default for every step.
//   full   node scripts/sweep.mjs (and check.mjs with no --affected): fast plus
//          every entry below marked full.
//   deep   check.mjs --deep: everything, including what needs a toolchain the
//          release machine lacks (Linux desktop packages, Windows, an Android
//          SDK). A full check lists every deep step it did not run as NOT RUN.
//
// The tiers nest (deep ⊃ full ⊃ fast). A step is in the slowest tier any
// explicit entry gives it; with no explicit entry, a rule applies (below); with
// no rule, it is fast. Every entry says why it is not in the faster tier.
//
// THE RULES. A fast step that takes over 5 s on GitHub's runner moves to full
// with a line saying so. Mutant suites and runs on more than one browser engine
// are full. Never delete or weaken a test to get the quick check green: move it
// here, with its reason, and the sweep keeps running it.
//
// `pin: true` marks a released-surface invariant: when the diff reaches it, the
// quick check runs it whatever its distance and whatever the budget says. These
// are why shipped files do not brick (docs/PLATFORM.md).
//
// `sweepEnv` raises a step's depth in the sweep only (more seeds, more steps);
// the quick check runs it as CI's step text says.
//
// Matching: `rig` is a glob on a script the step runs (its basename), `args` a
// regular expression on the step's run text, `job` one on its job id, `needs`
// a provider it needs (browser, build:<app>, ...).

export const TIERS = ['fast', 'full', 'deep']

/** @typedef {{ rig?: string, args?: RegExp, job?: RegExp, tier: 'fast'|'full'|'deep', why: string, pin?: boolean, sweepEnv?: Record<string,string> }} Entry */

/** @type {Entry[]} */
export const ENTRIES = [
  // ---- released-surface invariants: pinned in the quick check
  { rig: 'shell-gate.mjs', tier: 'fast', pin: true, why: 'the splice contract every frozen updater relies on; release.mjs runs the same gate before signing' },
  { rig: 'test-sync.ts', tier: 'fast', pin: true, why: 'CRDT convergence: 300 seeds here, 3000 in the sweep', sweepEnv: { SEEDS: '3000' } },
  { rig: 'test-sync-equiv.ts', tier: 'fast', pin: true, why: 'CRDT baseline vs candidate byte for byte; deeper in the sweep', sweepEnv: { SEEDS: '1000' } },
  { rig: 'test-sync-spaces.ts', tier: 'fast', pin: true, why: 'spaces under the shared CRDT; deeper in the sweep', sweepEnv: { SEEDS: '1000' } },
  { rig: 'test-sync-type.ts', tier: 'fast', pin: true, why: 'type under the shared CRDT; deeper in the sweep', sweepEnv: { SEEDS: '1000' } },
  { rig: 'test-preview.ts', tier: 'fast', pin: true, why: 'the static preview\'s escapes and its remover ordering, written into every save' },
  { rig: 'test-savepurpose.ts', tier: 'fast', pin: true, why: 'which save path writes what: the plaintext-to-disk guards' },
  { rig: 'test-doc-layout.ts', tier: 'fast', pin: true, why: 'the saved document layout and its escapes' },
  { rig: 'test-body-seal.ts', tier: 'fast', pin: true, why: 'the one "body is sealed" predicate every plaintext guard asks' },
  { rig: 'test-gate1.ts', tier: 'fast', pin: true, why: 'the shared gate-1 verifier against the conformance corpus' },
  { rig: 'test-release-history.ts', tier: 'fast', pin: true, why: 'the signed release history only grows' },
  { rig: 'test-packs.ts', tier: 'fast', pin: true, why: 'language packs: the signature and hash-pin chain' },

  // ---- typechecks: the quick check's tsc for every project the diff reaches
  { args: /(?:^|\s)(?:\S*\/)?tsc\s+(?:-b|-p)\b/, tier: 'fast', why: 'the typecheck of a project the diff reaches (slides takes about 6 s on CI; the build would run it anyway)' },

  // ---- the check's own rigs: they name Playwright as data, never launch it
  { rig: 'test-ci-registered.ts', tier: 'fast', why: 'every rig is run by CI and in one tier; it imports the planner, whose text names Playwright' },
  { rig: 'test-check.mjs', tier: 'fast', why: 'the planner, tiers, cache and sweep gate, against a scratch repository' },

  // ---- the headless loads: one browser boot per app, when its shell is built
  { rig: 'test-slides-save-browser.mjs', tier: 'fast', why: 'the quick check\'s headless load for slides: boots the built shell and saves (4 s)' },
  { rig: 'test-spaces-save-browser.mjs', tier: 'fast', why: 'the quick check\'s headless load for spaces: boots and saves (4 s)' },
  { rig: 'test-dash-gate-browser.mjs', tier: 'fast', why: 'the quick check\'s headless load for dash: boots behind its gate (2 s)' },
  { rig: 'test-type-boot-browser.mjs', tier: 'fast', why: 'the quick check\'s headless load for type (3 s)' },

  // ---- platforms: what only a GitHub runner of another kind can run
  { job: /^home-desktop-/, tier: 'deep', why: 'needs Linux with WebKitGTK, TPM and keyring packages (apt), or Windows: the release Mac has neither, so the full check lists it NOT RUN' },
  { job: /^home-android-/, tier: 'deep', why: 'needs Java and the Android SDK (Gradle), absent on the release Mac today: listed NOT RUN until it has them' },
  { job: /^home-ios-/, tier: 'full', why: 'Xcode, Swift and the iOS simulator: macOS only, 8 to 19 min a job' },
  { args: /BENTO_BROWSER=firefox|\s--firefox\b/, tier: 'deep', why: 'Playwright\'s Firefox does not launch on the sweep\'s Mac (macOS 27: launch timeout after sandbox_extension_issue_file_to_process, Operation not permitted; measured 2026-11-28, with and without the agent sandbox); listed NOT RUN; the WebKit and Chromium runs of the same rigs are full' },

  // ---- mutant suites: each mutant reruns a whole rig
  { rig: '*-mutants.{ts,mjs}', tier: 'full', why: 'a mutant suite: every mutant reruns its rig (7 s to 15 min on CI)' },
  { args: /\s--mutants\b/, tier: 'full', why: 'the rig\'s mutant half: every mutant reruns it' },
  { args: /BENTO_BROWSER=(?:webkit|firefox)|\s--(?:webkit|firefox)\b/, tier: 'full', why: 'a second browser engine' },

  // ---- over 5 s on GitHub's runner (CI run of c5aa4b91, 2026-11-28)
  { rig: 'test-spaces-chrome.ts', tier: 'full', why: '116 s: spaces chrome in a real browser, every surface' },
  { rig: 'test-home-web-build.mjs', tier: 'full', why: '65 s: builds home/web several ways' },
  { rig: 'test-home-web.mjs', tier: 'full', why: '50 s: home/web in a browser' },
  { rig: 'test-home-bridge.ts', tier: 'full', why: '31 s: the host bridge end to end' },
  { rig: 'test-home-web-offline.mjs', tier: 'full', why: '25 s: home/web offline in a browser' },
  { rig: 'test-home-web-host.mjs', tier: 'full', why: '25 s (Chromium; WebKit 51 s, mutants 134 s): the library-host security rows in a browser' },
  { rig: 'test-home-web-kill-drill.mjs', tier: 'full', why: '26 s (Chromium; WebKit 25 s, mutants in three engines 12 min): the D5(c) kill-switch drill, infecting a browser on purpose' },
  { rig: 'test-sync-session.ts', tier: 'full', why: '20 s: the sync session over many seeded schedules' },
  { rig: 'test-bento-check.ts', tier: 'full', why: '18 s: the bento-check CLI against built shells' },
  { rig: 'test-seal-gate.mjs', tier: 'full', why: '16 s: builds the sealed test shell first' },
  { rig: 'test-webext-id.ts', tier: 'full', why: '15 s: the extension\'s identity agent end to end' },
  { rig: 'test-release-channel.mjs', tier: 'full', why: '12 s: rehearses release.mjs with a throwaway key; the sweep a release needs runs it' },
  { rig: 'test-convert.ts', tier: 'full', why: '12 s: PowerPoint round trips' },
  { rig: 'test-stage0-probes.mjs', tier: 'full', why: '10 s: the stage-0 probe pages against a local server' },
  { rig: 'test-media-autoplay.ts', tier: 'full', why: '9 s: media playback across slide changes' },
  { rig: 'test-browser-guard.mjs', tier: 'full', why: '9 s: kills browsers on purpose' },
  { rig: 'test-directory-roster.ts', tier: 'full', why: '9 s: the directory roster over its full matrix' },
  { rig: 'test-shell-standalone.mjs', tier: 'full', why: '9 s: every app\'s shell in a browser' },
  { rig: 'test-sync-spaces-session.ts', tier: 'full', why: '9 s: spaces over the sync session, many schedules' },
  { rig: 'test-spaces-mentions.ts', tier: 'full', why: '8 s: mentions across every page shape' },
  { rig: 'test-spaces-trail.ts', tier: 'full', why: '5 s: bundled, then run in four time zones' },
  // measured in the quick check itself, four steps at once on the runner (2026-11-28)
  { rig: 'test-tray-index.mjs', tier: 'full', why: '31 to 43 s in the quick check on the runner (4 s alone): builds and indexes a tray of real shells' },
  { rig: 'test-tray-releases.mjs', tier: 'full', why: '20 to 29 s in the quick check on the runner (5 s alone)' },
  // A released-surface invariant the quick check could not keep (2026-11-28): its hidden-tab
  // timing row ("the splash is gone within 50 ms of the mount") measured 5 to 12 ms in every
  // sequential CI run and when run first on the runner, but 51 to 164 ms inside the quick
  // check (hidden mount 0.8 to 1.2 s against 0.4 s), whether run last and alone, first and
  // alone, or after a Chrome warm-up. Cause not found. The splice gate (pinned) still checks
  // every built shell per change; this rig runs in the sweep a release requires.
  { rig: 'test-shell-loader.ts', tier: 'full', why: 'its 50 ms hidden-tab splash timing fails inside the quick check on the runner (51 to 164 ms; 5 to 12 ms run alone); the sweep runs it' },
]

/** Rules, for steps no entry names. */
export const RULES = [
  { needs: 'browser', tier: 'full', why: 'drives a browser: the quick check boots one shell per built app (the headless loads above); the rest is the sweep\'s' },
]

const globRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\{([^}]+)\}/g, (_, a) => `(?:${a.split(',').join('|')})`) + '$')
const rank = (t) => TIERS.indexOf(t)

/** Does `e` name step `s`? */
export function entryMatches(e, s) {
  if (e.rig && !s.scripts.some((p) => globRe(e.rig).test(p.split('/').pop()))) return false
  if (e.args && !e.args.test(s.run)) return false
  if (e.job && !e.job.test(s.job)) return false
  return !!(e.rig || e.args || e.job)
}

/** A step's tier: { tier, why, pin, sweepEnv, entries } (needs `step.needs` for the rules). */
export function matchTier(s, entries = ENTRIES, rules = RULES) {
  const hits = entries.filter((e) => entryMatches(e, s))
  if (hits.length) {
    const top = hits.reduce((a, b) => (rank(b.tier) > rank(a.tier) ? b : a))
    return { tier: top.tier, why: top.why, pin: hits.some((e) => e.pin) && top.tier === 'fast', sweepEnv: Object.assign({}, ...hits.map((e) => e.sweepEnv ?? {})), entries: hits }
  }
  const rule = rules.find((r) => (s.needs ?? []).includes(r.needs))
  if (rule) return { tier: rule.tier, why: rule.why, pin: false, sweepEnv: {}, entries: [], rule: true }
  return { tier: 'fast', why: '', pin: false, sweepEnv: {}, entries: [] }
}

/** Is `tier` within a run of `runTier`? */
export const inTier = (tier, runTier) => rank(tier) <= rank(runTier)
