import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeSeatbeltConfinementLive,
  type SeatbeltConfinementPort,
} from "../process/seatbeltProfile";

/**
 * Test-only Seatbelt confinement that uses a passthrough sandbox-exec shim.
 * Production launchers must keep using makeSeatbeltConfinementLive() so missing
 * sandbox-exec fails closed.
 *
 * Native macOS sandbox-exec probes remain packaged/native validation evidence;
 * Linux CI covers profile generation and this shimmed launch path.
 */
export function createFakeSandboxConfinement(label = "octant-seatbelt-fake-"): {
  readonly root: string;
  readonly temporaryDirectory: string;
  readonly confinement: SeatbeltConfinementPort;
  readonly sandboxPath: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), label)));
  const temporaryDirectory = join(root, "tmp");
  mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  const sandboxPath = join(root, "sandbox-exec");
  // sandbox-exec argv shape: -p PROFILE -- COMMAND ARGS...
  writeFileSync(sandboxPath, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o700 });
  chmodSync(sandboxPath, 0o700);
  return {
    root,
    temporaryDirectory,
    sandboxPath,
    confinement: makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath,
      homeDirectory: root,
      usersDirectory: root,
    }),
  };
}
