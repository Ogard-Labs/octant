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
const IMAGE = "disk image bytes";

// A stand-in for `gh` that keeps the release's assets as files in a directory
// (a sibling `<name>.starter` file marks an asset GitHub left in the `starter`
// state), lists the repository's releases from a file of `tag<TAB>isLatest`
// lines, and appends every invocation to a call log, so a test can assert both
// what the release looks like afterwards and the order the calls happened in.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CALLS"
case "$1 $2" in
  "release view")
    [ -z "\${FAKE_MISSING_RELEASE:-}" ] || exit 1
    if [[ "$*" == *isDraft* ]]; then printf '%s\\n' "\${FAKE_DRAFT:-false}"; exit 0; fi
    for f in "$FAKE_ASSETS"/*; do
      [ -e "$f" ] || continue
      case "$f" in *.starter) continue ;; esac
      state=uploaded; [ -e "$f.starter" ] && state=starter
      printf '%s\\t%s\\t%s\\n' "$(basename "$f")" "$state" "$(wc -c < "$f" | tr -d ' ')"
    done
    ;;
  "release list")
    cat "$FAKE_RELEASES"
    ;;
  "release delete-asset")
    rm -f "$FAKE_ASSETS/$4" "$FAKE_ASSETS/$4.starter"
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
    cp "$FAKE_ASSETS/$pattern" "$dir/$pattern"
    ;;
  "release upload")
    if [ -n "\${FAKE_UPLOAD_LEAVES_STARTER:-}" ]; then
      : > "$FAKE_ASSETS/$(basename "$4")"
      : > "$FAKE_ASSETS/$(basename "$4").starter"
      exit 0
    fi
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

interface Asset {
  readonly bytes: string;
  readonly starter?: boolean;
}

function release(
  existingAssets: Readonly<Record<string, Asset>>,
  releases: ReadonlyArray<readonly [tag: string, isLatest: boolean]> = [[TAG, false]],
) {
  const root = mkdtempSync(join(tmpdir(), "publish-latest-"));
  roots.push(root);
  const bin = join(root, "bin");
  const assets = join(root, "assets");
  const calls = join(root, "calls");
  const releaseList = join(root, "releases");
  mkdirSync(bin);
  mkdirSync(assets);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  for (const [name, asset] of Object.entries(existingAssets)) {
    writeFileSync(join(assets, name), asset.bytes);
    if (asset.starter === true) writeFileSync(join(assets, `${name}.starter`), "");
  }
  writeFileSync(
    releaseList,
    releases.map(([tag, isLatest]) => `${tag}\t${String(isLatest)}\n`).join(""),
  );
  const run = (arg: string, env: Readonly<Record<string, string>> = {}) =>
    spawnSync("bash", [SCRIPT, arg], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "token",
        FAKE_ASSETS: assets,
        FAKE_CALLS: calls,
        FAKE_RELEASES: releaseList,
        ...env,
      },
    });
  const callLog = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { assets, callLog, run };
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
      [`Octant-${VERSION}-darwin-arm64.zip`]: { bytes: "archive bytes" },
    });

    const result = run(TAG);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(VERSIONED_DMG);
    expect(callLog()).not.toContain("release edit");
  });

  it("refuses a release whose disk image is empty or still a starter upload", () => {
    for (const asset of [{ bytes: "" }, { bytes: IMAGE, starter: true }]) {
      const { callLog, run } = release({ [VERSIONED_DMG]: asset });

      const result = run(TAG);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("incomplete");
      expect(callLog()).not.toContain("release edit");
    }
  });

  it("uploads the fixed-name disk image before marking the release latest", () => {
    const { assets, callLog, run } = release({ [VERSIONED_DMG]: { bytes: IMAGE } });

    const result = run(TAG);

    expect(result.status).toBe(0);
    const lines = callLog().trim().split("\n");
    const download = lines.findIndex((line) => line.startsWith("release download"));
    const upload = lines.findIndex((line) => line.startsWith("release upload"));
    const edit = lines.findIndex((line) => line.startsWith("release edit"));
    expect(download).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(download);
    expect(edit).toBeGreaterThan(upload);
    expect(readFileSync(join(assets, FIXED_DMG), "utf8")).toBe(IMAGE);
  });

  it("skips the upload when a complete fixed-name disk image is already there", () => {
    const { callLog, run } = release({
      [VERSIONED_DMG]: { bytes: IMAGE },
      [FIXED_DMG]: { bytes: IMAGE },
    });

    const result = run(TAG);

    expect(result.status).toBe(0);
    const log = callLog();
    expect(log).not.toContain("release download");
    expect(log).not.toContain("release upload");
    expect(log).toContain(`release edit ${TAG} --prerelease=false --latest`);
  });

  it("replaces a fixed-name image a failed upload left behind before promoting on a rerun", () => {
    const { assets, callLog, run } = release({
      [VERSIONED_DMG]: { bytes: IMAGE },
      [FIXED_DMG]: { bytes: "", starter: true },
    });

    const result = run(TAG);

    expect(result.status).toBe(0);
    const lines = callLog().trim().split("\n");
    const remove = lines.findIndex((line) => line.startsWith("release delete-asset"));
    const upload = lines.findIndex((line) => line.startsWith("release upload"));
    const edit = lines.findIndex((line) => line.startsWith("release edit"));
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(remove);
    expect(edit).toBeGreaterThan(upload);
    expect(readFileSync(join(assets, FIXED_DMG), "utf8")).toBe(IMAGE);
    expect(existsSync(join(assets, `${FIXED_DMG}.starter`))).toBe(false);
  });

  it("does not mark the release latest when the fixed-name upload is left incomplete", () => {
    const { callLog, run } = release({ [VERSIONED_DMG]: { bytes: IMAGE } });

    const result = run(TAG, { FAKE_UPLOAD_LEAVES_STARTER: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match");
    expect(callLog()).not.toContain("release edit");
  });

  it("refuses a release that is still a draft", () => {
    const { callLog, run } = release({ [VERSIONED_DMG]: { bytes: IMAGE } });

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

  it("leaves the link alone when an older Preview's job is rerun after a newer one holds it", () => {
    const newer = "v0.145.0-candidate.20261119.78";
    const { callLog, run } = release({ [VERSIONED_DMG]: { bytes: IMAGE } }, [
      [newer, true],
      [TAG, false],
    ]);

    const result = run(TAG);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(newer);
    expect(callLog()).not.toContain("release upload");
    expect(callLog()).not.toContain("release edit");
  });

  it("re-promotes the release that already holds the link without harm", () => {
    const { callLog, run } = release(
      { [VERSIONED_DMG]: { bytes: IMAGE }, [FIXED_DMG]: { bytes: IMAGE } },
      [[TAG, true]],
    );

    const result = run(TAG);

    expect(result.status).toBe(0);
    expect(callLog()).not.toContain("release upload");
    expect(callLog()).toContain(`release edit ${TAG} --prerelease=false --latest`);
  });

  it("never marks a Preview latest once a stable release exists", () => {
    const { callLog, run } = release({ [VERSIONED_DMG]: { bytes: IMAGE } }, [
      [TAG, false],
      ["v0.144.0", false],
      ["v0.144.0-candidate.20261101.60", true],
    ]);

    const result = run(TAG);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("only stable");
    expect(callLog()).not.toContain("release edit");
  });

  it("lets the first stable release take the link from a Preview", () => {
    const { callLog, run } = release({ "Octant-0.146.0-darwin-arm64.dmg": { bytes: IMAGE } }, [
      ["v0.146.0", false],
      [TAG, true],
    ]);

    const result = run("v0.146.0");

    expect(result.status).toBe(0);
    expect(callLog()).toContain("release edit v0.146.0 --prerelease=false --latest");
  });

  it("leaves a newer stable release holding the link when an older stable job is rerun", () => {
    const { callLog, run } = release({ "Octant-0.146.0-darwin-arm64.dmg": { bytes: IMAGE } }, [
      ["v0.146.0", false],
      ["v0.146.1", true],
    ]);

    const result = run("v0.146.0");

    expect(result.status).toBe(0);
    expect(callLog()).not.toContain("release edit");
  });
});
