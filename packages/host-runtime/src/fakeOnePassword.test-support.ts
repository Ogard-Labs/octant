import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in for the 1Password CLI: a shell script that answers `whoami` and
 * `read` from a folder of fixture items, and records every call. It never
 * touches a real vault, so a test can prove what Octant does with a value
 * without any real secret existing.
 */
export interface FakeOnePassword {
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly setMode: (mode: "ready" | "locked" | "broken") => void;
  readonly addItem: (reference: string, value: string) => void;
  /** One line per call: its arguments, then how many OCTANT_ variables it could see. */
  readonly calls: () => ReadonlyArray<string>;
}

const SCRIPT = `#!/bin/sh
state="$FAKE_OP_STATE"
printf '%s|octant=%s\\n' "$*" "$(env | grep -c '^OCTANT_')" >> "$state/calls"
mode="$(cat "$state/mode")"
if [ "$mode" = "locked" ]; then
  echo "[ERROR] 2026/10/31 You are not signed in. Unlock 1Password to continue." >&2
  exit 1
fi
if [ "$mode" = "broken" ]; then
  echo "unexpected trouble" >&2
  exit 3
fi
case "$1" in
  whoami)
    echo "URL: fixture.example"
    exit 0
    ;;
  read)
    shift
    if [ "$1" = "--no-newline" ]; then shift; fi
    item="$state/items/$(printf %s "$1" | tr '/: ' '___')"
    if [ -f "$item" ]; then
      cat "$item"
      exit 0
    fi
    echo "[ERROR] 2026/10/31 \\"$1\\" isn't an item in the vault." >&2
    exit 1
    ;;
esac
exit 2
`;

export function makeFakeOnePassword(): FakeOnePassword {
  const root = mkdtempSync(join(tmpdir(), "octant-fake-op-"));
  const state = join(root, "state");
  mkdirSync(join(state, "items"), { recursive: true });
  writeFileSync(join(state, "mode"), "ready");
  writeFileSync(join(state, "calls"), "");
  const executablePath = join(root, "op");
  writeFileSync(executablePath, SCRIPT);
  chmodSync(executablePath, 0o755);
  return {
    executablePath,
    env: { PATH: "/usr/bin:/bin", FAKE_OP_STATE: state, OCTANT_BROKER_TOKEN: "leak-canary" },
    setMode: (mode) => writeFileSync(join(state, "mode"), mode),
    addItem: (reference, value) =>
      writeFileSync(join(state, "items", reference.replace(/[/: ]/g, "_")), value),
    calls: () =>
      readFileSync(join(state, "calls"), "utf8")
        .split("\n")
        .filter((line) => line !== ""),
  };
}
