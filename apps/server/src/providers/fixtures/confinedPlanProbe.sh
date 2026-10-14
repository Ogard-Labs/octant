#!/bin/bash
# Reports what the OS let a confined Plan launch do.
#
# Builtins only: `cat` or `test -w` would be an exec, which this posture also
# refuses, so a refused exec would be reported as a refused read. The shebang
# names bash rather than sh because macOS `/bin/sh` re-execs `/bin/bash` as its
# posix variant, and a profile that allows only the launched program refuses
# that second exec before the script runs a line: "Failed to exec /bin/bash as
# variant for /bin/sh (1: Operation not permitted)."
if printf 'escaped' > "$OCTANT_PROBE_TARGET" 2>/dev/null; then
  printf 'write=allowed\n'
else
  printf 'write=refused\n'
fi
if read -r probe_line < "$OCTANT_PROBE_READABLE" 2>/dev/null; then
  printf 'read=%s\n' "$probe_line"
else
  printf 'read=refused\n'
fi
# Each path in the colon-separated OCTANT_PROBE_STATE_WRITES is reported by its
# name under OCTANT_PROBE_STATE_ROOT, so a test can tell the runtime's own
# folders from the account files a later session would load.
if [ -n "$OCTANT_PROBE_STATE_WRITES" ]; then
  set -f
  IFS=':'
  for probe_path in $OCTANT_PROBE_STATE_WRITES; do
    if printf 'planted' > "$probe_path" 2>/dev/null; then
      printf 'state:%s=allowed\n' "${probe_path#"$OCTANT_PROBE_STATE_ROOT"/}"
    else
      printf 'state:%s=refused\n' "${probe_path#"$OCTANT_PROBE_STATE_ROOT"/}"
    fi
  done
  unset IFS
  set +f
fi
# Last, because a posture that denies process-fork ends the shell here rather
# than letting it report: bash prints "fork: Operation not permitted" and exits
# 128 without running another line. Either way `exec=allowed` is never printed.
if /bin/date > /dev/null 2>&1; then
  printf 'exec=allowed\n'
else
  printf 'exec=refused\n'
fi
