#!/usr/bin/env bash
# SCRATCH, never to merge: run a rig N times with no retry and report each run.
#   loop.sh N label cmd...
set -u
n=$1; shift; label=$1; shift
mkdir -p failures
pass=0; fail=0
for i in $(seq 1 "$n"); do
  start=$(date +%s)
  "$@" > out.txt 2> err.txt; code=$?
  sum=$(grep -E "checks passed" out.txt | tail -1)
  echo "LOOP $label run $i exit=$code $(( $(date +%s) - start ))s :: $sum"
  if [ "$code" -ne 0 ]; then
    fail=$((fail+1))
    grep -E "FAIL|note|SKIP" out.txt | cut -c1-900 | sed 's/^/    /'
    cp out.txt "failures/$label-$i.out"; cp err.txt "failures/$label-$i.err"
    echo "    --- stderr tail"; tail -n 60 err.txt | cut -c1-400 | sed 's/^/    /'
  else
    pass=$((pass+1))
    grep -E "SKIP" out.txt | sed 's/^/    /'
  fi
done
echo "LOOP $label total: $pass passed, $fail failed of $n"
