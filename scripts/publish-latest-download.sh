#!/usr/bin/env bash
# Mark a finished Preview or stable release as GitHub's latest release and
# give it the fixed-name disk image the public download link needs.
#
#   scripts/publish-latest-download.sh v<version>
#
# https://github.com/<owner>/<repo>/releases/latest/download/<file> resolves
# `latest` to the newest non-draft, non-prerelease release, then downloads the
# asset by name. The link therefore needs two things the build's own release
# does not have: a release that is not marked a prerelease, and an asset whose
# name does not change between versions.
#
# The versioned disk image must already exist — a missing image fails the run
# and the release is never marked. The fixed-name copy is uploaded before the
# latest flag moves, so the public link never points at a release without the
# file, and an existing fixed-name asset is left alone so a rerun stays
# idempotent. Only `v<version>` and `v<version>-candidate.<date>.<run>` tags
# may be marked: the check refuses a Nightly `v…-preview.…` tag before `gh`
# runs. The calling job waits for every build row to publish, so a failed or
# partial Preview never becomes latest.
#
# Needs `GH_TOKEN` with `contents: write` and runs inside the checkout.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 v<version>" >&2
  exit 2
fi

tag=$1
if ! printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-candidate\.[0-9]+\.[0-9]+)?$'; then
  echo "refusing to mark ${tag} latest: only a stable or Preview candidate release may carry the public download" >&2
  exit 2
fi
version=${tag#v}
versioned="Octant-${version}-darwin-arm64.dmg"
fixed="Octant-darwin-arm64.dmg"

if ! draft=$(gh release view "$tag" --json isDraft --jq '.isDraft'); then
  echo "release ${tag} does not exist" >&2
  exit 1
fi
if [ "$draft" != "false" ]; then
  echo "release ${tag} is a draft" >&2
  exit 1
fi

assets=$(gh release view "$tag" --json assets --jq '.assets[].name')
if ! printf '%s\n' "$assets" | grep -Fqx "$versioned"; then
  echo "release ${tag} has no ${versioned}; not marking it latest" >&2
  exit 1
fi

if ! printf '%s\n' "$assets" | grep -Fqx "$fixed"; then
  staging=$(mktemp -d)
  trap 'rm -rf "$staging"' EXIT
  gh release download "$tag" --pattern "$versioned" --dir "$staging"
  cp "${staging}/${versioned}" "${staging}/${fixed}"
  gh release upload "$tag" "${staging}/${fixed}"
fi

gh release edit "$tag" --prerelease=false --latest
