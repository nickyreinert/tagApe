#!/bin/sh
# YAW hook shim (ADR-0006), written by YAW to .yaw/bin/yaw-hook; agents run it as `sh .yaw/bin/yaw-hook ...`.
# It finds the kit and runs `yaw hook "$@"` in the project root. It fails open: without Node or the
# kit (or when anything fails) it exits 0 with no output, so the agent session is never affected.
# Shell builtins only until node runs, so a broken PATH cannot print errors.
case "$0" in */*) here=${0%/*} ;; *) here=. ;; esac
root=$(CDPATH='' cd -- "$here/../.." 2>/dev/null && pwd) || exit 0
if [ -f "$root/.yaw/lib/bin/yaw" ]; then
  kit="$root/.yaw/lib"
else
  kit="${YAW_KIT:-$HOME/.yaw/kit}"
fi
command -v node >/dev/null 2>&1 || exit 0
[ -f "$kit/bin/yaw" ] || exit 0
cd "$root" || exit 0
# stderr is dropped and the exit code forced to 0, so even a Node that cannot load the kit stays silent.
node --no-warnings "$kit/bin/yaw" hook "$@" 2>/dev/null
exit 0
