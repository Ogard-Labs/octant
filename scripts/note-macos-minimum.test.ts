import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "note-macos-minimum.sh");
const TAG = "v0.145.0-candidate.20261118.77";

// `gh` keeps the release notes in a file; `plutil` answers from the built
// bundle's minimum, or fails as it does when the key is absent.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "release view") cat "$FAKE_NOTES" ;;
  "release edit") printf '%s' "$5" > "$FAKE_NOTES"; echo edited >> "$FAKE_CALLS" ;;
  *) echo "fake gh: unhandled $*" >&2; exit 99 ;;
esac
`;
const FAKE_PLUTIL = `#!/usr/bin/env bash
[ -n "\${FAKE_MINIMUM:-}" ] || exit 1
printf '%s\\n' "$FAKE_MINIMUM"
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function release(notes: string, minimum: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), "note-macos-"));
  roots.push(root);
  const bin = join(root, "bin");
  const out = join(root, "out");
  mkdirSync(bin);
  mkdirSync(join(out, "mac-arm64", "Octant.app", "Contents"), { recursive: true });
  writeFileSync(join(bin, "gh"), FAKE_GH);
  writeFileSync(join(bin, "plutil"), FAKE_PLUTIL);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "plutil"), 0o755);
  const notesFile = join(root, "notes");
  const calls = join(root, "calls");
  writeFileSync(notesFile, notes);
  writeFileSync(calls, "");
  const run = () =>
    spawnSync("bash", [SCRIPT, TAG, out, "Octant"], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "token",
        FAKE_NOTES: notesFile,
        FAKE_CALLS: calls,
        ...(minimum === undefined ? {} : { FAKE_MINIMUM: minimum }),
      },
    });
  return {
    notes: () => readFileSync(notesFile, "utf8"),
    edits: () => readFileSync(calls, "utf8"),
    run,
  };
}

describe("note-macos-minimum.sh", () => {
  it("puts the macOS requirement above notes another job wrote when it created the release", () => {
    const { notes, run } = release("candidate build of main. Not a stable release.", "15.0");

    const result = run();

    expect(result.status).toBe(0);
    expect(notes()).toMatch(/^The Mac app requires macOS 15\.0 or later\./);
    expect(notes()).toContain("will not launch");
    expect(notes()).toContain("candidate build of main. Not a stable release.");
  });

  it("leaves notes that already state the requirement alone on a rerun", () => {
    const { edits, run } = release("", "15.0");

    expect(run().status).toBe(0);
    expect(run().status).toBe(0);

    expect(edits().trim().split("\n")).toHaveLength(1);
  });

  it("adds nothing for a rollback build whose bundle declares no minimum", () => {
    const { edits, notes, run } = release("preview build of v0.1.0-preview.1.", undefined);

    const result = run();

    expect(result.status).toBe(0);
    expect(edits()).toBe("");
    expect(notes()).toBe("preview build of v0.1.0-preview.1.");
  });
});
