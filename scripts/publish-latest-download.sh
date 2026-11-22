#!/usr/bin/env bash
# Mark a finished Preview or stable release as GitHub's latest release and
# give it the fixed-name disk image the public download link needs.
#
#   scripts/publish-latest-download.sh v<version>
#
# https://github.com/<owner>/<repo>/releases/latest/download/<file> resolves
# `latest` to the release GitHub marks latest, then downloads the asset by
# name. The link therefore needs two things the build's own release does not
# have: a release that is not marked a prerelease, and an asset whose name does
# not change between versions.
#
# Which release may hold the link (maintainer decision, 2026-11-22): a Preview
# `v…-candidate.<date>.<run>` only until the first stable `vX.Y.Z` release
# exists; after that, only stable. Nightly `v…-preview.…` tags never do, and
# are refused before `gh` runs. A candidate that a stable release has
# superseded, or a release older than the one already holding the link, is a
# no-op that exits 0, so rerunning an old run's job cannot move the link
# backward. Re-promoting the release that already holds the link is harmless.
# The calling jobs share one concurrency group across both rings, so two
# promotions never interleave this read-compare-edit sequence.
#
# The versioned disk image must be fully uploaded and non-empty: GitHub can
# leave an empty asset in the `starter` state after a failed upload, and a
# release with one is never marked. The fixed-name copy is reused only when it
# is uploaded and the same size as the versioned image; a leftover starter or
# mismatched copy is deleted and uploaded again, and the copy is checked again
# before the latest flag moves, so the public link never points at a release
# without a working installer.
#
# Needs `GH_TOKEN` with `contents: write` and runs inside the checkout.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 v<version>" >&2
  exit 2
fi

stable_re='^v([0-9]+)\.([0-9]+)\.([0-9]+)$'
candidate_re='^v([0-9]+)\.([0-9]+)\.([0-9]+)-candidate\.([0-9]+)\.([0-9]+)$'

tag=$1
if ! [[ $tag =~ $stable_re || $tag =~ $candidate_re ]]; then
  echo "refusing to mark ${tag} latest: only a stable or Preview candidate release may carry the public download" >&2
  exit 2
fi
version=${tag#v}
versioned="Octant-${version}-darwin-arm64.dmg"
fixed="Octant-darwin-arm64.dmg"

# Prints the tag's numeric fields, space-separated, for an ordering compare
# within one ring: X Y Z for stable, X Y Z date run for a candidate. The date
# and run number keep every candidate strictly newer than the last.
fields() {
  if [[ $1 =~ $stable_re || $1 =~ $candidate_re ]]; then
    local i out=""
    for ((i = 1; i < ${#BASH_REMATCH[@]}; i++)); do
      [ -n "${BASH_REMATCH[$i]}" ] && out+="${BASH_REMATCH[$i]} "
    done
    printf '%s' "$out"
  fi
}

# Succeeds when $1 is strictly older than $2; both are tags of the same ring.
older_than() {
  local -a a b
  read -r -a a <<<"$(fields "$1")"
  read -r -a b <<<"$(fields "$2")"
  local i
  for ((i = 0; i < ${#a[@]}; i++)); do
    if ((10#${a[$i]} < 10#${b[$i]})); then return 0; fi
    if ((10#${a[$i]} > 10#${b[$i]})); then return 1; fi
  done
  return 1
}

if ! draft=$(gh release view "$tag" --json isDraft --jq '.isDraft'); then
  echo "release ${tag} does not exist" >&2
  exit 1
fi
if [ "$draft" != "false" ]; then
  echo "release ${tag} is a draft" >&2
  exit 1
fi

# Every published release, with whether GitHub marks it latest. Ordering is
# decided from tags, not from isPrerelease: a promoted Preview is no longer a
# prerelease.
releases=$(gh release list --exclude-drafts --limit 10000 --json tagName,isLatest \
  --jq '.[] | [.tagName, (.isLatest | tostring)] | @tsv')
current=$(printf '%s\n' "$releases" | awk -F'\t' '!found && $2 == "true" { print $1; found = 1 }')
stable_exists=false
while IFS=$'\t' read -r name _; do
  if [[ $name =~ $stable_re ]]; then stable_exists=true; fi
done <<<"$releases"

if [[ $tag =~ $candidate_re ]] && [ "$stable_exists" = true ]; then
  echo "a stable release exists, so only stable may be latest; leaving ${tag} as it is"
  exit 0
fi
if [ -n "$current" ] && [ "$current" != "$tag" ]; then
  if [[ ($tag =~ $stable_re && $current =~ $stable_re) || ($tag =~ $candidate_re && $current =~ $candidate_re) ]] &&
    older_than "$tag" "$current"; then
    echo "${current} is newer and already holds the download link; leaving ${tag} as it is"
    exit 0
  fi
fi

# name<TAB>state<TAB>size for one asset, or nothing when it is absent.
asset() {
  gh release view "$tag" --json assets \
    --jq '.assets[] | [.name, .state, (.size | tostring)] | @tsv' |
    awk -F'\t' -v want="$1" '!found && $1 == want { print; found = 1 }'
}

IFS=$'\t' read -r _ versioned_state versioned_size <<<"$(asset "$versioned")" || true
if [ -z "${versioned_state:-}" ]; then
  echo "release ${tag} has no ${versioned}; not marking it latest" >&2
  exit 1
fi
if [ "$versioned_state" != "uploaded" ] || [ "${versioned_size:-0}" -le 0 ]; then
  echo "release ${tag} has an incomplete ${versioned} (state ${versioned_state}, ${versioned_size:-0} bytes); not marking it latest" >&2
  exit 1
fi

IFS=$'\t' read -r _ fixed_state fixed_size <<<"$(asset "$fixed")" || true
if [ "${fixed_state:-}" != "uploaded" ] || [ "${fixed_size:-}" != "$versioned_size" ]; then
  if [ -n "${fixed_state:-}" ]; then
    echo "replacing ${fixed} (state ${fixed_state}, ${fixed_size:-0} bytes)"
    gh release delete-asset "$tag" "$fixed" --yes
  fi
  staging=$(mktemp -d)
  trap 'rm -rf "$staging"' EXIT
  gh release download "$tag" --pattern "$versioned" --dir "$staging"
  cp "${staging}/${versioned}" "${staging}/${fixed}"
  gh release upload "$tag" "${staging}/${fixed}"
  fixed_state="" fixed_size=""
  IFS=$'\t' read -r _ fixed_state fixed_size <<<"$(asset "$fixed")" || true
  if [ "${fixed_state:-}" != "uploaded" ] || [ "${fixed_size:-}" != "$versioned_size" ]; then
    echo "uploaded ${fixed} does not match ${versioned} (state ${fixed_state:-missing}, ${fixed_size:-0} of ${versioned_size} bytes); not marking it latest" >&2
    exit 1
  fi
fi

gh release edit "$tag" --prerelease=false --latest
