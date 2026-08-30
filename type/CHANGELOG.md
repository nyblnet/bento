# Changelog

All notable changes to **bento/type**. The app version is baked into every
shell as `APP_VERSION` (from `type/package.json`) and checked against the
signed release manifest; a shipped file updates itself through that channel.

This file is per-app on purpose. The notes ride inside the **signed** update
manifest and are what someone reads while deciding whether to rewrite their
file — so an app must never describe another app's changes. The repository
root `CHANGELOG.md` is **bento/slides'**; nothing about bento/type belongs
there.

The format (`bento/type`, version `1`) is additive and stable — every version
below opens files from every earlier version, and unknown fields are preserved.
Versions follow `0.MINOR.PATCH` while pre-1.0.

## [Unreleased]

bento/type has not been released yet. Work before the first release is
summarised in that release's entry rather than tracked here — add a block
below once a change is user-visible in a shipped file.
