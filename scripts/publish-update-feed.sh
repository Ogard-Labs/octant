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
# A file is never replaced in place: `gh release upload --clobber` deletes the
# live asset before the new bytes arrive, so a failed upload would leave the
# public URL empty. Instead the new bytes go up under a temporary name, are
# checked against the local size, and only then does the old asset give way and
# the temporary one take its name. A failure before that point leaves the old
# file serving; a failure after the delete leaves the new bytes uploaded, and a
# rerun finishes the rename. Reruns are idempotent.
#
# Every matrix job writes its own file names, so a swap only touches the file a
# job owns. The create can race another job; losing that race is fine as long
# as the release exists afterwards.
#
# Needs `GH_TOKEN` with `contents: write`, `jq`, and runs inside the checkout.
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

assets_api="repos/${GITHUB_REPOSITORY}/releases/assets"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

# ids_matching <regex>: ids of the mailbox assets whose name matches it.
ids_matching() {
  gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" \
    | jq -r --arg re "$1" '.assets[] | select(.name | test($re)) | .id'
}

for file in "$@"; do
  name=$(basename "$file")
  temp="${name}.next-${GITHUB_RUN_ID:-local}"
  # Pattern-safe: feed names are letters, digits, dots and dashes.
  escaped=$(printf '%s' "$name" | sed 's/[.]/\\./g')

  # Leftovers of an earlier failed attempt are not the live file; drop them.
  for id in $(ids_matching "^${escaped}\\.next-"); do
    gh api -X DELETE "${assets_api}/${id}" >/dev/null
  done

  cp "$file" "${staging}/${temp}"
  gh release upload "$tag" "${staging}/${temp}"

  expected=$(wc -c <"$file" | tr -d ' ')
  new_id=$(ids_matching "^${escaped}\\.next-${GITHUB_RUN_ID:-local}\$")
  actual=$(gh api "${assets_api}/${new_id}" | jq -r '.size')
  if [ -z "$new_id" ] || [ "$actual" != "$expected" ]; then
    echo "uploaded ${temp} is missing or the wrong size (${actual:-none} of ${expected} bytes); ${name} left as it was." >&2
    exit 1
  fi

  # The old asset must go first: a release cannot hold two assets with a name.
  for id in $(ids_matching "^${escaped}\$"); do
    gh api -X DELETE "${assets_api}/${id}" >/dev/null
  done
  gh api -X PATCH "${assets_api}/${new_id}" -f name="$name" >/dev/null
done
