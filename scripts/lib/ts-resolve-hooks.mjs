// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Node module hooks for driving APP source (not just kernel source) from a rig.
//
// Two gaps between how the app is written and what Node loads on its own, and
// the kernel rigs hit neither — which is why this appeared only when the
// SESSION layer needed testing.
//
//   1. RESOLUTION. App source is written for Vite and imports without file
//      extensions (`from '../store'`). Node requires them, so a rig importing
//      app modules dies at load with ERR_MODULE_NOT_FOUND before one check
//      runs. Kernel modules all carry `.ts`, so kernel rigs never noticed.
//
//   2. SYNTAX. Node's built-in TypeScript support is STRIP-ONLY: it removes
//      types but refuses anything that emits code. `constructor(private store:
//      Store)` — a parameter property, which session.ts uses — is exactly that,
//      and fails with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
//
// The alternative to (2) was editing session.ts to drop the parameter property.
// Rejected on principle: the rig exists to prove the session's behaviour is
// UNCHANGED across a move into the kernel, and it cannot do that if the first
// thing it does is change the code it is meant to be pinning. A test that
// requires edits to its subject has stopped being a control.
//
// esbuild is the app's own transpiler (it is what Vite uses), so this runs the
// same transform the shipped build does rather than a second interpretation of
// the language.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';

// esbuild is taken from whichever app workspace has it installed, NOT from a
// hardcoded one. Pinning it to slides/ meant every rig using this hook failed
// in a worktree where only another app's dependencies were installed — an
// environment difference reported as a test failure, which is the most
// expensive kind of false alarm: it looks exactly like a real regression.
const CANDIDATES = ['slides', 'type', 'spaces', 'dash'];
let esbuild;
for (const app of CANDIDATES) {
  const url = new URL(`../../${app}/node_modules/esbuild/lib/main.js`, import.meta.url);
  try { await access(fileURLToPath(url)); esbuild = await import(url.href); break; } catch { /* next */ }
}
if (!esbuild) {
  throw new Error(
    `esbuild not found in any of: ${CANDIDATES.map(a => `${a}/node_modules`).join(', ')}. ` +
    `Run \`npm install\` in one of those app directories.`,
  );
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // only relative, extensionless specifiers — never bare package names
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$/.test(specifier)) throw err;
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch {
        /* try the next candidate */
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (!/\.tsx?$/.test(url)) return nextLoad(url, context);
  const path = fileURLToPath(url);
  const source = await readFile(path, 'utf8');
  const { code } = await esbuild.transform(source, {
    loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    target: 'es2022',
    sourcefile: path,
  });
  return { format: 'module', source: code, shortCircuit: true };
}
