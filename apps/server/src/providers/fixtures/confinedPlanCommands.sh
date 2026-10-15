#!/bin/bash
# Stands in for the Claude runtime of a Plan turn: hands the commands in
# OCTANT_PROBE_COMMANDS to the shell the runtime's Bash tool runs in, so they
# run under the launch's profile as a process that is not the runtime.
exec /bin/zsh -c "$OCTANT_PROBE_COMMANDS"
