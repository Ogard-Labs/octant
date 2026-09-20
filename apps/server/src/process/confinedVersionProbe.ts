/**
 * Confinement for the `--version` read every provider family performs before it
 * launches a runtime, and for the one the discovery scan performs on a
 * candidate it found itself.
 *
 * 0009 requires every Octant-spawned subprocess that can execute arbitrary code
 * to launch through the shared builder. The version read was the one launch no
 * family wrapped: the binary path is user-configured — and, in discovery, not
 * even named by the user — so a replaced executable ran with the user's whole
 * home and the network before any confined launch happened. 0139 names that as
 * a standing gap across every family, and 0141 closes it here, in one place, so
 * the read sites cannot drift apart again.
 *
 * A version read needs far less than a turn. It has no thread, so no bound
 * project root and no managed home: its working directory, its `HOME` and the
 * only path it may write are one throwaway scratch directory this module
 * creates and the caller releases. Egress is `none` — a version string is
 * local, so 0122's probe exception for readiness checks that must reach a
 * control plane does not apply here.
 *
 * Process execution and fork stay allowed, which a turn in Chat or Plan denies.
 * A provider's configured path is routinely a launcher rather than the program:
 * `@openai/codex`'s npm entry point is a Node script that spawns the platform
 * binary beside it, and a version manager's shim runs the real CLI through
 * `/bin/sh`. Measured on macOS 27 against the installed CLIs, denying exec or
 * fork turned both shapes into `spawn EPERM` and
 * `Failed to exec /bin/bash as variant for /bin/sh`, which a caller reports as
 * `unavailable` — the provider then disappears from the picker on a host where
 * it is installed and working. A child the probe starts inherits this profile,
 * so it reaches no more than the probe does.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import {
  makeSeatbeltConfinementLive,
  SeatbeltConfinementError,
  type SeatbeltConfinementPort,
} from "./seatbeltProfile";

export interface ConfinedVersionProbeLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The probe's working directory, its `HOME`, and the only path it may write. */
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Removes the scratch directory. Callers run it once the probe has exited. */
  readonly release: () => void;
}

export type ConfinedVersionProbe =
  | { readonly status: "prepared"; readonly launch: ConfinedVersionProbeLaunch }
  | {
      readonly status: "refused";
      readonly reason: "incompatible" | "invalid-configuration";
      readonly message: string;
    };

export interface PrepareConfinedVersionProbeInput {
  readonly binaryPath: string;
  /** Names the provider in a refusal the caller turns into a provider failure. */
  readonly displayName: string;
  /** Defaults to `--version`. */
  readonly args?: ReadonlyArray<string>;
  /**
   * Built from the scratch directory, so a family's managed-home variables name
   * the one path this launch may write instead of the user's real home.
   */
  readonly environment: (scratchDirectory: string) => NodeJS.ProcessEnv;
  readonly confinement?: SeatbeltConfinementPort;
  readonly temporaryRoot?: string;
  readonly homeDirectory?: string;
}

export function prepareConfinedVersionProbe(
  input: PrepareConfinedVersionProbeInput,
): ConfinedVersionProbe {
  const name = input.displayName;
  let scratchDirectory: string;
  try {
    scratchDirectory = realpathSync(
      mkdtempSync(join(input.temporaryRoot ?? tmpdir(), "octant-version-probe-")),
    );
  } catch {
    return {
      status: "refused",
      reason: "invalid-configuration",
      message: `${name} version probe could not create a private temporary directory.`,
    };
  }
  const release = () => {
    try {
      rmSync(scratchDirectory, { recursive: true, force: true });
    } catch {
      // A scratch directory the probe's own child still holds open is left to
      // the operating system; it carries nothing the next probe reads.
    }
  };

  try {
    const environment = input.environment(scratchDirectory);
    const confinement = input.confinement ?? makeSeatbeltConfinementLive();
    const readRoots = versionProbeReadRoots(
      input.binaryPath,
      scratchDirectory,
      input.homeDirectory ?? homedir(),
    );
    const launch = confinement.prepare({
      executable: input.binaryPath,
      args: input.args ?? ["--version"],
      // There is no thread, so the one root the builder binds is the scratch
      // directory itself: the read's working directory on both platforms, and
      // the only path it may write. It is bound writable rather than left to
      // the temporary-directory grant, because a bound root a launch may not
      // write is denied outright after that grant and the denial would cover
      // the same path.
      boundRoot: scratchDirectory,
      temporaryDirectory: scratchDirectory,
      networkEgress: "none",
      allowProcessExec: true,
      allowProcessFork: true,
      allowFileReadStar: true,
      readRoots,
      privateHomeAllowPaths: readRoots,
      ...(environment.PATH === undefined ? {} : { interpreterSearchPath: environment.PATH }),
    });
    return {
      status: "prepared",
      launch: {
        command: launch.command,
        args: launch.args,
        workingDirectory: scratchDirectory,
        environment: {
          ...environment,
          HOME: scratchDirectory,
          TMPDIR: scratchDirectory,
        },
        release,
      },
    };
  } catch (error) {
    release();
    return {
      status: "refused",
      reason:
        error instanceof SeatbeltConfinementError && error.reason === "invalid-configuration"
          ? "invalid-configuration"
          : "incompatible",
      message:
        error instanceof SeatbeltConfinementError
          ? error.message
          : `${name} version probe confinement could not be prepared.`,
    };
  }
}

/**
 * The paths a version read has to reach: its own scratch, and the install tree
 * the configured program actually runs out of.
 *
 * The program alone is not enough. Measured against the installed CLIs on macOS
 * 27: a uv tool's entry point is a script whose interpreter reads `pyvenv.cfg`
 * and `lib/` beside it, so the directory above the program has to open too, and
 * an npm package's entry point resolves its dependencies out of the package's
 * own `node_modules`, which sits above that again. Everything else under the
 * user's home stays denied, which is the reach this confinement exists to take
 * away.
 */
function versionProbeReadRoots(
  binaryPath: string,
  scratchDirectory: string,
  homeDirectory: string,
): ReadonlyArray<string> {
  let resolved: string;
  try {
    resolved = realpathSync(binaryPath);
  } catch {
    resolved = binaryPath;
  }
  const home = safeRealpath(homeDirectory);
  const packageRoot = nodePackageRoot(resolved);
  const candidates = [
    resolved,
    dirname(resolved),
    dirname(dirname(resolved)),
    // The configured path is often a launcher link in a `bin` directory the
    // kernel must read before it can resolve to the program.
    dirname(binaryPath),
    ...(packageRoot === undefined ? [] : [packageRoot]),
  ];
  return [scratchDirectory, ...new Set(candidates.filter((path) => isOwnInstallPath(path, home)))];
}

/**
 * Whether a computed root names an install tree rather than a shared ancestor.
 *
 * Walking two directories above the program reaches the user's home for a
 * program kept directly in it, and a one-segment system root such as `/usr` for
 * one installed there. The builder re-allows launch roots after its own
 * denials, so either would hand back exactly what this confinement exists to
 * close. Both are dropped; the program's own path still opens, and a
 * self-contained binary needs nothing else.
 */
function isOwnInstallPath(path: string, homeDirectory: string): boolean {
  if (path === homeDirectory || homeDirectory.startsWith(withTrailingSeparator(path))) return false;
  return path.split(sep).filter(Boolean).length >= 2;
}

/** The npm package directory a resolved entry point lives in, if it is in one. */
function nodePackageRoot(resolved: string): string | undefined {
  let current = dirname(resolved);
  while (current.includes(`${sep}node_modules${sep}`)) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function withTrailingSeparator(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}
