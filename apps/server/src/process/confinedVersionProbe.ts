/**
 * Confinement for the `--version` read every provider family performs before it
 * launches a runtime, and for the one the discovery scan performs on a
 * candidate it found itself.
 *
 * 0009 requires every Octant-spawned subprocess that can execute arbitrary code
 * to launch through the shared builder. The version read was the one launch no
 * family wrapped: the binary path is user-configured — and, in discovery, not
 * even named by the user — so a replaced executable ran with the user's whole
 * home and the network before any confined launch happened. 0142 names that as
 * a standing gap across every family, and 0146 closes it here, in one place, so
 * the read sites cannot drift apart again.
 *
 * A version read needs far less than a turn. It has no thread, so no bound
 * project root and no managed home: its working directory, its `HOME` and the
 * only path it may write are one throwaway scratch directory this module
 * creates and the caller releases. Egress is `none` — a version string is
 * local, so 0122's probe exception for readiness checks that must reach a
 * control plane does not apply here.
 *
 * The environment is reduced here, not by each family. A family builds the one
 * it always built, and this module keeps only a fixed set of inherited names
 * (PATH, locale, user identity, terminal hints), what the family computed from
 * the scratch directory, and the static guards the family names. Provider
 * credentials, cloud keys and a family's config-home variables — `CODEX_HOME`,
 * `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` — are dropped, so a program that
 * consults one falls back to `HOME`, which is the scratch. Six families each
 * building their own allowlist is how one of them, and discovery, ended up
 * handing a replaced executable a real config home and a token.
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
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
   * What the family would launch with. Built from the scratch directory, so a
   * family's managed-home variables name the one path this launch may write
   * instead of the user's real home. It is reduced before use; see the module
   * comment.
   */
  readonly environment: (scratchDirectory: string) => NodeJS.ProcessEnv;
  /**
   * Static variables the family sets for every launch, such as a telemetry or
   * update-check switch. Kept verbatim when `environment` returns the same
   * value; never host-derived, which is why they pass where a host variable
   * of the same name would not.
   */
  readonly guards?: Readonly<Record<string, string>>;
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
    const environment = versionReadEnvironment(
      input.environment(scratchDirectory),
      scratchDirectory,
      input.guards ?? {},
    );
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
        environment,
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

export interface ExecVersionReadOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer: number;
}

/**
 * `execFile` for a version read that owns everything the program starts.
 *
 * `execFile` tracks only the direct child. A program that forks a background
 * process, closes the pipes it inherited, and exits settles the read while the
 * descendant runs on — after the scratch it was confined to is gone, and, when
 * the program was found by a scan rather than named, with nobody having chosen
 * to run it. The child leads its own process group and the group is ended when
 * the read settles, on success, failure and timeout alike, which is what the
 * spawn-based reads already do. A descendant that starts a session of its own
 * leaves the group; that is the same limit those reads have.
 *
 * It settles the way `execFile` does: a non-zero exit, a timeout, or more than
 * `maxBuffer` bytes on either stream is a rejection.
 */
export function execVersionRead(
  command: string,
  args: ReadonlyArray<string>,
  options: ExecVersionReadOptions,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRead, rejectRead) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      endProcessGroup(child);
      settle();
    };
    const timer = setTimeout(
      () => finish(() => rejectRead(new Error("The version read timed out."))),
      options.timeout,
    );
    const capture = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (settled) return;
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (stdout.length > options.maxBuffer || stderr.length > options.maxBuffer) {
        finish(() => rejectRead(new Error("The version read exceeded its output limit.")));
      }
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.once("error", (error) => finish(() => rejectRead(error)));
    child.once("close", (code) =>
      finish(() =>
        code === 0
          ? resolveRead({ stdout, stderr })
          : rejectRead(new Error(`The version read exited with ${String(code)}.`)),
      ),
    );
  });
}

function endProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined || process.platform === "win32") return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // ESRCH: nothing is left in the group, which is the outcome wanted.
  }
}

/** Inherited names a version read may see. Everything else is dropped. */
const INHERITED_NAMES = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "USER",
  "SHELL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "TZ",
]);

function versionReadEnvironment(
  environment: NodeJS.ProcessEnv,
  scratchDirectory: string,
  guards: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (
      INHERITED_NAMES.has(name) ||
      name.startsWith("LC_") ||
      // A value under the scratch names the one path this launch may write; a
      // host cannot have known it, because the directory did not exist yet.
      value === scratchDirectory ||
      value.startsWith(withTrailingSeparator(scratchDirectory)) ||
      guards[name] === value
    ) {
      kept[name] = value;
    }
  }
  return { ...kept, HOME: scratchDirectory, TMPDIR: scratchDirectory };
}

/**
 * The paths a version read has to reach: its own scratch, and the install tree
 * the configured program actually runs out of.
 *
 * The program alone is not enough. Measured against the installed CLIs on macOS
 * 27: a uv tool's entry point is a script whose interpreter reads `pyvenv.cfg`
 * and `lib/` beside it, so the directory above the program has to open too, and
 * an npm package's entry point resolves its dependencies through Node's
 * lookup, which walks up every enclosing `node_modules`. A platform-split CLI
 * keeps its native program in a sibling package a manager may hoist beside it
 * (a project install, a Bun global) or into another directory of one tree (a
 * symlinking manager), so the whole outermost `node_modules` opens, not the
 * entry point's own package. Everything else under the user's home stays
 * denied, which is the reach this confinement exists to take away.
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
  const dependencyTree = nodeModulesRoot(resolved);
  const candidates = [
    resolved,
    dirname(resolved),
    dirname(dirname(resolved)),
    // The configured path is often a launcher link in a `bin` directory the
    // kernel must read before it can resolve to the program.
    dirname(binaryPath),
    ...(dependencyTree === undefined ? [] : [dependencyTree]),
  ];
  // Judged in both forms. The builder canonicalises every root it is given, so
  // a lexical directory that is a link into the home — `/tmp/link/tool` with
  // `link` pointing at `$HOME` — passes a check on its own spelling and then
  // opens the whole home once resolved.
  return [
    scratchDirectory,
    ...new Set(
      candidates.filter((path) =>
        [path, safeRealpath(path)].every((form) => isOwnInstallPath(form, home)),
      ),
    ),
  ];
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

/** The outermost `node_modules` directory a resolved entry point lives under, if any. */
function nodeModulesRoot(resolved: string): string | undefined {
  const marker = `${sep}node_modules`;
  const index = resolved.indexOf(`${marker}${sep}`);
  return index === -1 ? undefined : resolved.slice(0, index + marker.length);
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
