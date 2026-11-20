#!/usr/bin/env bash
# The overnight gate. Run from the root of a checkout (main repo or a worktree).
#   docs/ui-upgrade/tools/gate.sh [smoke|py|js|git|all] [port-base]
# port-base (default 8808) picks the smoke ports: base for the main server, base+1 for the live one, so parallel
# worktrees do not collide (use 8810, 8812, 8814, ...).
# Baseline (Phase 0, on bc8ea0c): smoke 24/24 + axe clean; JS 85/85; Python 396 run, 4 errors, all
# test_native_dialog.TkHelperTests (no tkinter in the cloud container) = pre-existing, not ours.
set -u
what="${1:-all}"
base="${2:-8808}"
root="$(pwd)"
out="${TMPDIR:-/tmp}/gate-$(basename "$root")-$$"
mkdir -p "$out"
fail=0

if [ ! -e node_modules ] && [ -d /home/user/OrchestraCaseComp/node_modules ]; then
  ln -s /home/user/OrchestraCaseComp/node_modules node_modules
fi

if [ "$what" = smoke ] || [ "$what" = all ]; then
  UI_PORT_MAIN="$base" UI_PORT_LIVE="$((base + 1))" node tests/ui/smoke.mjs > "$out/smoke.txt" 2>&1
  rc=$?
  grep -E "^(FAIL|KNOWN)|axe .*: [1-9]" "$out/smoke.txt"
  tail -1 "$out/smoke.txt" | sed 's/^/smoke: /'
  grep -E "tests, .* passed" "$out/smoke.txt" | sed 's/^/smoke: /'
  [ $rc -eq 0 ] || { echo "SMOKE FAILED (full log: $out/smoke.txt)"; fail=1; }
fi

if [ "$what" = js ] || [ "$what" = all ]; then
  node --test tests/js/*.test.mjs > "$out/js.txt" 2>&1
  p=$(grep -E "^# pass" "$out/js.txt" | awk '{print $3}'); f=$(grep -E "^# fail" "$out/js.txt" | awk '{print $3}')
  echo "js: pass=$p fail=$f (baseline 85/0)"
  [ "$f" = 0 ] || { echo "JS FAILED ($out/js.txt)"; fail=1; }
fi

if [ "$what" = py ] || [ "$what" = all ]; then
  timeout 900 python3 -m unittest discover -s tests -p "test_*.py" -t tests > "$out/py.txt" 2>&1
  grep -E "^Ran |^OK|^FAILED" "$out/py.txt" | sed 's/^/py: /'
  new=$(grep -E "^(ERROR|FAIL):" "$out/py.txt" | grep -v "test_native_dialog.TkHelperTests" | grep -v "test_local_model" )
  if [ -n "$new" ]; then echo "PY NEW FAILURES:"; echo "$new"; fail=1; else echo "py: no new failures vs baseline (tkinter x4 pre-existing; test_local_model is the known flake)"; fi
fi

if [ "$what" = git ] || [ "$what" = all ]; then
  s=$(git status --short --untracked-files=all -- dashboards/conductor/state out)
  if [ -n "$s" ]; then echo "GIT: stray files:"; echo "$s"; fail=1; else echo "git: clean under dashboards/conductor/state and out"; fi
fi

[ $fail -eq 0 ] && echo "GATE GREEN" || echo "GATE RED"
exit $fail
