# Security Policy

bento takes security seriously. The project is local-first, documents remain
self-contained, and secret collaboration keys are generated and held
client-side. This document explains how to report a vulnerability and summarizes
the security posture so reports can be precise.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through
[**GitHub's private vulnerability reporting**](https://github.com/nyblnet/bento/security/advisories/new).
This opens a private advisory visible only to you and the maintainers.

Include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, ideally with a minimal `.bento.html` file or a short
  script.
- The affected version (the app version is shown in the About dialog and baked
  into every shell as `APP_VERSION`), plus your browser and OS.

What to expect:

- We aim to acknowledge a report within a few days.
- We'll work with you to confirm the issue, assess severity, and prepare a fix.
- Fixes ship as signed releases and are offered to existing files through the
  in-app update channel once the maintainer cuts and signs a new version.
- Please give us reasonable time to release a fix before any public disclosure.
  We're happy to credit reporters who want it.

## Scope

In scope:

- The current releases of bento’s document apps and their shared runtime (for
  example `slides` or `kernel`).
- Document formats, parsing, sanitization, encryption, and saving.
- Collaboration engine.
- Blind sync relay.
- Signed self-update mechanism.

Out of scope:

- Vulnerabilities solely in third-party code.
- Arbitrary executable code in an HTML file that was not produced by bento and
  has merely been presented or renamed as a `.bento.html` file.

## Security posture

bento’s security guarantees, intended security boundary, known limitations,
and threat model are documented in [docs/security.md](docs/security.md) and
[docs/collab-design.md](docs/collab-design.md).
