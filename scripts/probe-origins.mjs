#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Serves the tray/webext capability probes on TWO origins.
//
//   node scripts/probe-origins.mjs
//   → open http://localhost:5301/probe/parent.html in YOUR OWN browser
//
// WHY TWO PORTS. A different port is a different origin, which is all the probe
// needs: it asks whether a `FileSystemFileHandle` picked on one origin can be
// `postMessage`d to another and still be used to read and WRITE. That is the
// question that closed bento/home and pointed at a browser EXTENSION instead
// (docs/DECISIONS.md, 2026-08-02): a page cannot hand a document write access,
// so the host has to be something that already has it.
//
// WHY YOU HAVE TO RUN IT YOURSELF. Permission-gated APIs — File System Access
// write, clipboard, notifications — report `denied` in an AUTOMATED browser,
// without ever prompting, because a driven browser must not be able to hand out
// filesystem write access. So an agent testing this gets `denied` no matter
// what the truth is. That trap already produced two wrong conclusions during
// this design (working/home-design.md §3.2). Only a human in a real browser
// window can answer it.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, dirname, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'tray', 'webext')
const PARENT_PORT = 5301
const RUNNER_PORT = 5302

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }

function serve(port, label) {
  createServer(async (req, res) => {
    // Normalise and confine to `home/` — this serves on localhost, but a path
    // traversal in a dev server is still a path traversal.
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
    const path = join(root, rel)
    if (!path.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    try {
      const body = await readFile(path)
      res.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        // No caching: the whole point is re-running after an edit.
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  }).listen(port, () => console.log(`  ${label.padEnd(8)} http://localhost:${port}`))
}

console.log('\nbento/home — cross-origin handle probe\n')
serve(PARENT_PORT, 'origin A')
serve(RUNNER_PORT, 'origin B')
console.log(`
  Open this in YOUR OWN browser (not an automated one):

    http://localhost:${PARENT_PORT}/probe/parent.html

  Pick a THROWAWAY file — the last step rewrites it with identical bytes.
  The runner page reports what it can do with the handle it receives, and
  has a "Copy the report" button at the end.

  Ctrl-C to stop.
`)
