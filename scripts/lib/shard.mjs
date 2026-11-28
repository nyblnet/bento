// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// `--shard k/n` for a mutant suite: run the mutants whose index is k-1 modulo
// n, so n shards side by side run every mutant exactly once (the release check
// runs them in parallel; scripts/test-directory-mutants.ts has its own copy).
//
//   const { args, pick } = shard(process.argv.slice(2), 'test-x-mutants')
//   for (const m of pick(MUTANTS.filter(...))) ...
//
// A bad spec exits 1, and so does a shard that selects nothing: an empty shard
// would pass while killing no mutant.
export function shard(argv, name = 'suite') {
  const i = argv.indexOf('--shard')
  if (i < 0) return { args: argv, label: '', pick: (list) => list }
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(argv[i + 1] ?? '')
  if (!m || Number(m[1]) > Number(m[2])) { console.log(`${name}: --shard wants k/n with 1 <= k <= n, not ${argv[i + 1]}`); process.exit(1) }
  const k = Number(m[1]), n = Number(m[2])
  return {
    args: argv.filter((_, j) => j !== i && j !== i + 1),
    label: ` (shard ${k} of ${n})`,
    pick(list) {
      const out = list.filter((_, j) => j % n === k - 1)
      if (!out.length) { console.log(`${name}: shard ${k}/${n} selects no mutant of ${list.length}: an empty shard kills nothing`); process.exit(1) }
      console.log(`${name}: shard ${k} of ${n}: ${out.length} of ${list.length} mutants`)
      return out
    },
  }
}
