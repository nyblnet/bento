// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Which files make up CI, read as TEXT — for the registration checks
// (scripts/test-ci-registered.ts, scripts/test-spaces.mjs --manifest).
//
// CI used to be one file, .github/workflows/ci.yml. It is now:
//   .github/workflows/*.yml                  every workflow (ci.yml holds the
//                                            required `validate` job; ci-<zone>.yml
//                                            hold each zone's other jobs)
//   .github/actions/validate-<zone>/action.yml
//                                            the zone slices `validate` runs as
//                                            composite actions, inside that job
//
// A step in an action file runs ONLY if some workflow says
// `uses: ./.github/actions/<name>`. So `ciText` counts an action's text only
// when a workflow uses it: an action nobody calls is a file of steps that never
// execute, and treating it as registration would be the silent pass these
// checks exist to prevent. `unusedActions` names them so the rig can fail.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const WORKFLOWS_DIR = '.github/workflows'
export const ACTIONS_DIR = '.github/actions'

export function ciFiles(root) {
  const wdir = join(root, WORKFLOWS_DIR)
  const workflows = existsSync(wdir)
    ? readdirSync(wdir).filter((f) => /\.ya?ml$/.test(f)).sort()
      .map((f) => ({ path: `${WORKFLOWS_DIR}/${f}`, text: readFileSync(join(wdir, f), 'utf8') }))
    : []
  const adir = join(root, ACTIONS_DIR)
  const actions = existsSync(adir)
    ? readdirSync(adir).sort()
      .filter((d) => existsSync(join(adir, d, 'action.yml')))
      .map((d) => ({ name: d, path: `${ACTIONS_DIR}/${d}/action.yml`, text: readFileSync(join(adir, d, 'action.yml'), 'utf8') }))
    : []
  // `uses: ./.github/actions/<name>` from a workflow or from another action.
  const usesOf = (text) => [...text.matchAll(/^\s*(?:-\s+)?uses:\s*\.\/\.github\/actions\/([A-Za-z0-9._-]+)\s*$/gm)].map((m) => m[1])
  const used = new Set()
  const frontier = workflows.flatMap((w) => usesOf(w.text))
  while (frontier.length) {
    const n = frontier.pop()
    if (used.has(n)) continue
    used.add(n)
    const a = actions.find((x) => x.name === n)
    if (a) frontier.push(...usesOf(a.text))
  }
  return {
    workflows,
    actions,
    usedActions: actions.filter((a) => used.has(a.name)),
    unusedActions: actions.filter((a) => !used.has(a.name)),
    missingActions: [...used].filter((n) => !actions.some((a) => a.name === n)).sort(),
  }
}

/** Every workflow, plus every action a workflow actually runs, as one text. */
export function ciText(root) {
  const f = ciFiles(root)
  return [...f.workflows, ...f.usedActions].map((x) => `# ---- ${x.path}\n${x.text}`).join('\n')
}
