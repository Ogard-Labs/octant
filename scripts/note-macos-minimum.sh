#!/usr/bin/env bash
# Add the Mac app's minimum macOS to a release's notes.
#
#   scripts/note-macos-minimum.sh <tag> <out dir> <product>
#
# A release page has one set of notes for every build on its tag, and the
# Windows, headless or desktop job can be the one that creates it, so the
# notice cannot ride on whichever `gh release create` runs first. The Mac row
# calls this once its build is attached. The minimum is read from the built
# bundle's own Info.plist rather than assumed: a Nightly rollback can rebuild a
# tag from before the bundle declared one, and that build gets no notice.
# Macs below the minimum must not update past the last version that supports
# them; the update feed does not guard against it (maintainer decision,
# 2026-11-22), so the notes say so. A rerun finds the notice and leaves the
# notes alone.
#
# Needs `GH_TOKEN` with `contents: write` and runs on macOS (`plutil`).
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <tag> <out dir> <product>" >&2
  exit 2
fi
tag=$1
out=$2
product=$3

app=$(find "$out" -maxdepth 2 -type d -name "${product}.app" -print -quit)
if [ -z "$app" ]; then
  echo "no ${product}.app under ${out}" >&2
  exit 1
fi
if ! minimum=$(plutil -extract LSMinimumSystemVersion raw "${app}/Contents/Info.plist" 2>/dev/null); then
  echo "${product}.app declares no minimum macOS; leaving the notes of ${tag} as they are"
  exit 0
fi

notice="The Mac app requires macOS ${minimum} or later. Macs on an earlier macOS must not update past the last version released before that requirement, because an update installed there will not launch."
body=$(gh release view "$tag" --json body --jq '.body')
case "$body" in
  *"$notice"*)
    echo "the notes of ${tag} already state the macOS ${minimum} requirement"
    exit 0
    ;;
esac
if [ -n "$body" ]; then
  gh release edit "$tag" --notes "${notice}

${body}"
else
  gh release edit "$tag" --notes "$notice"
fi
