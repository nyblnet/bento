// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id's origins, written ONCE. Every other copy of these values either
// imports this module (bento/home's library: home/web/src/identity.ts and
// home/web/build.mjs, which esbuild bundles it into) or is a literal pinned to
// it by scripts/test-id-origins.mjs: the sign-in host's static files and the
// directory worker cannot import from scripts/, the kernel's roster rules
// name the rp id and the ceremony origin, and the rigs' stubs and hosting
// rules keep their own. A copy that drifts, or goes missing, fails that rig.
//
// Plain ESM with no imports, so it can be bundled into a browser page.

/** The registrable domain every bento/id host sits under. */
export const APEX = 'bento.page'
/** The WebAuthn relying party id: every bento/id passkey belongs to it (kernel ROSTER_RP_ID). */
export const RP_ID = 'id.bento.page'
/** The directory: JSON routes, and the one void page. Never a ceremony origin. */
export const DIRECTORY_ORIGIN = 'https://id.bento.page'
/** The sign-in host: the only web origin that runs ceremonies (kernel ROSTER_WEB_ORIGINS). */
export const SIGNIN_ORIGIN = 'https://signin.id.bento.page'
/** bento/home in your browser: the library, the one page that may ask the sign-in host to certify a browser key. */
export const HOME_ORIGIN = 'https://home.bento.page'
