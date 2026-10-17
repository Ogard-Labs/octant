#!/usr/bin/env bash
# Publish signed update-feed files to a ring's mailbox release.
#
#   scripts/publish-update-feed.sh <preview|candidate|stable> <feed-file>...
#
# Each ring has one fixed GitHub release, tagged `feed-<ring>`, that holds
# nothing but that ring's feed JSON files. It is a mailbox, not a release: it is
# a prerelease, never "latest", and its tag does not start with `v`, so nothing
# that looks for version tags sees it. octant.sh redirects
# `/updates/<ring>/<file>` to the file's download URL on this release, and the
# app trusts the signature inside the file rather than the host that served it.
#
# Every matrix job writes its own file names, so `--clobber` replaces only the
# file a job owns. The create can race another job; losing that race is fine as
# long as the release exists afterwards.
#
# Needs `GH_TOKEN` with `contents: write` and runs inside the checkout.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <preview|candidate|stable> <feed-file>..." >&2
  exit 2
fi

ring=$1
shift
case "$ring" in
  preview | candidate | stable) ;;
  *)
    echo "unknown ring: ${ring}" >&2
    exit 2
    ;;
esac

for file in "$@"; do
  if [ ! -f "$file" ]; then
    echo "feed file not found: ${file}" >&2
    exit 1
  fi
done

tag="feed-${ring}"
if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" \
    --prerelease \
    --latest=false \
    --target "${GITHUB_SHA}" \
    --title "Update feed (${ring})" \
    --notes "Mailbox for the ${ring} ring's signed update feed. The app reads these files; it is never a real release and holds no installable build." \
    || gh release view "$tag" >/dev/null
fi
gh release upload "$tag" "$@" --clobber
