# Bento kernel

The app-agnostic machinery every Bento app shares: document lifecycle
(save/splice, `bento/enc` encryption, autosave/version history), signed
self-update, the i18n engine, the animation engine, charts-lite, and the
bento-sync CRDT engine (`src/sync/crdt.ts`). The
kernel/app boundary is defined in `docs/PLATFORM.md` §9 — the kernel never
sees an app's content shape (slides, blocks, cells); it reads only the
`KernelDoc` envelope (`src/doc.ts`).

## How it's consumed

Plain TypeScript source, no build step, no package.json. Apps import with
relative paths and explicit `.ts` extensions:

```ts
import { anim } from '../../kernel/src/anim.ts'
```

— the one convention that works identically in vite, `tsc` (bundler
resolution), and Node's native type stripping. In app code, prefer the app's
facade modules (e.g. `slides/src/save.ts`) over importing the kernel
directly; facades pin the app's configuration (and for i18n, guarantee
catalog registration order).

This is deliberately NOT an npm workspace: the kernel has zero dependencies,
so a workspace buys nothing yet (decision in `docs/DECISIONS.md`). If a
shared dependency ever appears, convert then, in one mechanical sweep.

## Rules (see also AGENTS.md, docs/PARALLEL-WORK.md)

- **Kernel-zone changes are serialized** — one PR at a time, reviewed against
  the platform invariants. App work never edits kernel files in passing.
- Nothing here may import from an app directory. The dependency direction is
  app → kernel, only.
- New envelope fields on `KernelDoc` are platform decisions, not
  conveniences.
- Frozen contracts that live here: the `#bento-doc` splice (save.ts), the
  `bento/enc` envelope (save.ts), the update-manifest verification
  (update.ts), and **every byte the sync engine mints** (sync/crdt.ts) — ops,
  `SyncStateJSON`, fractional position keys, lamport ordering. Treat every byte
  as shipped-file compatibility surface.
- `sync/crdt.ts` takes its document shape as a `DocShape` at construction and
  knows nothing else about an app's content. The app binds it
  (`slides/src/sync/crdt.ts` → `SLIDES_SHAPE`), and the binding is what an app
  imports. Changing the engine is gated by `scripts/test-sync-equiv.ts`, which
  compares it byte-for-byte against a frozen copy of the engine as shipped: a
  change that alters a minted byte forks every file in the field from its own
  copies, with no way to push a fix.

## Typecheck

```sh
slides/node_modules/.bin/tsc -p kernel
```

(CI runs this standalone; each app's `tsc -b` also typechecks kernel files
transitively through its imports.)
