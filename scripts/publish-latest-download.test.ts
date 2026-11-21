import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "publish-latest-download.sh");
const VERSION = "0.145.0-candidate.20261118.77";
const TAG = `v${VERSION}`;
const VERSIONED_DMG = `Octant-${VERSION}-darwin-arm64.dmg`;
const FIXED_DMG = "Octant-darwin-arm64.dmg";

// A stand-in for `gh` that keeps the release's assets as files in a directory
// and appends every invocation to a call log, so a test can assert both what
// the release looks like afterwards and the order the calls happened in.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CALLS"
case "$1 $2" in
  "release view")
    [ -z "\${FAKE_MISSING_RELEASE:-}" ] || exit 1
    if [[ "$*" == *isDraft* ]]; then printf '%s\\n' "\${FAKE_DRAFT:-false}"; exit 0; fi
    for f in "$FAKE_ASSETS"/*; do [ -e "$f" ] && basename "$f"; done
    ;;
  "release download")
    dir=""; pattern=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --dir) dir=$2; shift 2 ;;
        --pattern) pattern=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    cp "$FAKE_SOURCE_DMG" "$dir/$pattern"
    ;;
  "release upload")
    cp "$4" "$FAKE_ASSETS/$(basename "$4")"
    ;;
  "release edit") ;;
  *) echo "fake gh: unhandled $*" >&2; exit 99 ;;
esac
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function release(existingAssets: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "publish-latest-"));
  roots.push(root);
  const bin = join(root, "bin");
  const assets = join(root, "assets");
  const calls = join(root, "calls");
  mkdirSync(bin);
  mkdirSync(assets);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  for (const [name, text] of Object.entries(existingAssets)) {
    writeFileSync(join(assets, name), text);
  }
  // What `gh release download` serves: the versioned image's bytes.
  const source = join(root, "source.dmg");
  writeFileSync(source, "disk image bytes");
  const run = (arg: string, env: Record<string, string> = {}) =>
    spawnSync("bash", [SCRIPT, arg], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "token",
        FAKE_ASSETS: assets,
        FAKE_CALLS: calls,
        FAKE_SOURCE_DMG: source,
        ...env,
      },
    });
  const callLog = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { assets, calls, callLog, run };
}

describe("publish-latest-download.sh", () => {
  it("refuses to mark a Nightly release latest before asking GitHub", () => {
    const { callLog, run } = release({});

    const result = run("v0.145.0-preview.20261118.77");

    expect(result.status).not.toBe(0);
    expect(callLog()).toBe("");
  });

  it("refuses to mark a release latest when its disk image is missing", () => {
    const { callLog, run } = release({
      [`Octant-${VERSION}-darwin-arm64.zip`]: "archive bytes",
    });

    const result = run(TAG);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(VERSIONED_DMG);
    expect(callLog()).not.toContain("release edit");
  });

  it("uploads the fixed-name disk image before marking the release latest", () => {
    const { assets, callLog, run } = release({ [VERSIONED_DMG]: "ignored" });

    const result = run(TAG);

    expect(result.status).toBe(0);
    const lines = callLog().trim().split("\n");
    const download = lines.findIndex((line) => line.startsWith("release download"));
    const upload = lines.findIndex((line) => line.startsWith("release upload"));
    const edit = lines.findIndex((line) => line.startsWith("release edit"));
    expect(download).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(download);
    expect(edit).toBeGreaterThan(upload);
    expect(readFileSync(join(assets, FIXED_DMG), "utf8")).toBe("disk image bytes");
  });

  it("skips the upload when the fixed-name disk image is already there", () => {
    const { callLog, run } = release({
      [VERSIONED_DMG]: "ignored",
      [FIXED_DMG]: "already published",
    });

    const result = run(TAG);

    expect(result.status).toBe(0);
    const log = callLog();
    expect(log).not.toContain("release download");
    expect(log).not.toContain("release upload");
    expect(log).toContain(`release edit ${TAG} --prerelease=false --latest`);
  });

  it("refuses a release that is still a draft", () => {
    const { callLog, run } = release({ [VERSIONED_DMG]: "ignored" });

    const result = run(TAG, { FAKE_DRAFT: "true" });

    expect(result.status).not.toBe(0);
    expect(callLog()).not.toContain("release edit");
  });

  it("refuses a release that does not exist", () => {
    const { callLog, run } = release({});

    const result = run(TAG, { FAKE_MISSING_RELEASE: "1" });

    expect(result.status).not.toBe(0);
    expect(callLog()).not.toContain("release edit");
  });

  it("accepts a stable tag too, so the newest stable keeps the link live", () => {
    const { callLog, run } = release({ "Octant-0.146.0-darwin-arm64.dmg": "ignored" });

    const result = run("v0.146.0");

    expect(result.status).toBe(0);
    expect(callLog()).toContain("release edit v0.146.0 --prerelease=false --latest");
  });
});
