import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "publish-update-feed.sh");

// A stand-in for `gh` that keeps the mailbox release's assets as files in a
// directory. Like GitHub, it refuses a rename onto an existing name.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
assets="$FAKE_ASSETS"
case "$1 $2" in
  "release view") exit 0 ;;
  "release upload")
    [ -z "\${FAKE_FAIL_UPLOAD:-}" ] || exit 1
    cp "$4" "$assets/$(basename "$4")"
    ;;
  "api -X")
    id=\${4##*/}
    if [ "$3" = "DELETE" ]; then rm "$assets/$id"; exit 0; fi
    new=\${6#name=}
    [ ! -e "$assets/$new" ] || exit 1
    mv "$assets/$id" "$assets/$new"
    ;;
  "api repos/"*)
    path=$2
    if [[ "$path" == */releases/tags/* ]]; then
      first=1; printf '{"assets":['
      for f in "$assets"/*; do
        [ -e "$f" ] || continue
        [ "$first" = 1 ] || printf ','; first=0
        printf '{"id":"%s","name":"%s","size":%s}' "$(basename "$f")" "$(basename "$f")" "$(wc -c <"$f" | tr -d ' ')"
      done
      printf ']}'
    else
      f="$assets/\${path##*/}"
      printf '{"size":%s}' "$(wc -c <"$f" | tr -d ' ')"
    fi
    ;;
  *) echo "fake gh: unhandled $*" >&2; exit 99 ;;
esac
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mailbox(existing: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "publish-feed-"));
  roots.push(root);
  const bin = join(root, "bin");
  const assets = join(root, "assets");
  mkdirSync(bin);
  mkdirSync(assets);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  for (const [name, text] of Object.entries(existing)) writeFileSync(join(assets, name), text);
  const feed = join(root, "darwin-arm64.json");
  writeFileSync(feed, "new feed bytes");
  const run = (env: Record<string, string> = {}) =>
    spawnSync("bash", [SCRIPT, "preview", feed], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_ASSETS: assets,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_SHA: "abc",
        GITHUB_RUN_ID: "77",
        ...env,
      },
    });
  return { assets, run };
}

describe("publish-update-feed.sh", () => {
  it("keeps the live file when the upload fails", () => {
    const { assets, run } = mailbox({ "darwin-arm64.json": "old feed bytes" });

    const result = run({ FAKE_FAIL_UPLOAD: "1" });

    expect(result.status).not.toBe(0);
    expect(readdirSync(assets)).toEqual(["darwin-arm64.json"]);
    expect(readFileSync(join(assets, "darwin-arm64.json"), "utf8")).toBe("old feed bytes");
  });

  it("swaps in the new bytes under the final name and leaves no temporary file", () => {
    const { assets, run } = mailbox({ "darwin-arm64.json": "old feed bytes" });

    const result = run();

    expect(result.status).toBe(0);
    expect(readdirSync(assets)).toEqual(["darwin-arm64.json"]);
    expect(readFileSync(join(assets, "darwin-arm64.json"), "utf8")).toBe("new feed bytes");
  });

  it("publishes a first file and clears a leftover from an earlier attempt", () => {
    const { assets, run } = mailbox({ "darwin-arm64.json.next-12": "stale" });

    expect(run().status).toBe(0);

    expect(readdirSync(assets)).toEqual(["darwin-arm64.json"]);
    expect(existsSync(join(assets, "darwin-arm64.json"))).toBe(true);
  });
});
