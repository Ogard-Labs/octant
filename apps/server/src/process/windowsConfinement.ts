/**
 * The Windows form of the shared confinement port: an AppContainer, ACL grants
 * and a kill-on-close job object, applied by the fixed native launcher
 * `octant-windows-confine.exe` (built from `apps/desktop/native/windows-confine`).
 *
 * Dormant by design. `makeProcessConfinementLive` reaches this only when its
 * caller passes `unverifiedWindowsConfinement`, and no production caller does:
 * the mechanism has run only on a hosted Windows runner, never with a real
 * provider on a person's Windows machine, so Work and Code stay refused on
 * Windows at every level until that evidence exists.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  isSameOrInside,
  protectedEntryFor,
  windowsGuardPath,
} from "@octant/domain/secret-guard-policy";
import {
  planWindowsConfinedLaunch,
  type WindowsConfinementPatternScan,
  windowsConfinedLauncherArguments,
  windowsNativePath,
} from "@octant/domain/windows-confinement-policy";
import { secretGuardEntries } from "./secretGuard";
import {
  type ConfinedProcessLaunch,
  ProcessConfinementError,
  type ProcessConfinementPrepareInput,
} from "./seatbeltProfile";

export interface UnverifiedWindowsConfinementOptions {
  /** Drive-absolute path of `octant-windows-confine.exe`. */
  readonly launcherPath: string;
  readonly homeDirectory?: string;
  /** Fixed only by tests; a launch otherwise gets a fresh random id. */
  readonly launchId?: string;
  /** Lists one folder; tests substitute a fixture for the Windows disk. */
  readonly readDirectory?: (
    path: string,
  ) => ReadonlyArray<{ readonly name: string; readonly directory: boolean }>;
}

/** How many entries a pattern scan reads before it refuses the launch. */
const PATTERN_SCAN_LIMIT = 4_096;

export function buildWindowsConfinedLaunch(
  input: ProcessConfinementPrepareInput,
  options: UnverifiedWindowsConfinementOptions,
): ConfinedProcessLaunch {
  const launcher = windowsNativePath(options.launcherPath);
  if (launcher === undefined || !/\\octant-windows-confine\.exe$/iu.test(launcher)) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Windows confinement needs the drive-absolute path of octant-windows-confine.exe.",
    );
  }
  if (process.platform === "win32" && !isFile(launcher)) {
    throw new ProcessConfinementError(
      "incompatible",
      "Windows confinement requires octant-windows-confine.exe.",
    );
  }
  refuseWhatWindowsCannotExpress(input);

  const homeDirectory = options.homeDirectory ?? homedir();
  const ownAccountPaths =
    input.ownAccountAccess === "none"
      ? []
      : (input.ownAccountPaths ?? [
          ...(input.readRoots ?? []),
          ...(input.additionalWriteRoots ?? []),
        ]);
  const decision = planWindowsConfinedLaunch({
    launchId: options.launchId ?? randomBytes(16).toString("hex"),
    executable: input.executable,
    boundRoot: input.boundRoot,
    extraBoundRoots: input.extraBoundRoots ?? [],
    writeBoundRoot: input.writeBoundRoot !== false,
    temporaryDirectory: input.temporaryDirectory,
    additionalWriteRoots: input.additionalWriteRoots ?? [],
    readRoots: input.readRoots ?? [],
    network: typeof input.networkEgress === "object" ? "proxied" : input.networkEgress,
    processCreation:
      input.allowProcessFork === false || input.allowProcessExec === false ? "denied" : "allowed",
    protectedEntries: secretGuardEntries({ platform: "win32", homeDirectory }),
    ownAccountPaths,
  });
  if (decision.status === "refused") {
    throw new ProcessConfinementError("incompatible", decision.message);
  }

  // A deny entry cannot carve a file out of a grant (see the plan's module
  // comment), so a grant that already holds a protected store, or a
  // carve-out the launch asked for inside a grant, refuses the launch.
  const readDirectory = options.readDirectory ?? listDirectory;
  for (const scan of decision.patternScans) {
    const found = patternMatches(scan, readDirectory);
    if (found === "truncated") {
      throw new ProcessConfinementError(
        "incompatible",
        `Windows confinement could not finish checking ${scan.directory} for ${scan.entry.label} (over ${String(PATTERN_SCAN_LIMIT)} entries), so the launch was refused.`,
      );
    }
    const [first] = found;
    if (first !== undefined) {
      throw new ProcessConfinementError(
        "incompatible",
        `Windows confinement does not grant ${scan.directory}: it holds ${first}, one of the ${scan.entry.label} the secret guard protects.`,
      );
    }
  }
  // Outside the grants the deny-by-default container already misses a path;
  // a carve-out matters only where an inherited grant would reach it.
  const grantForms = decision.grants.map((grant) => windowsGuardPath(`${grant.path}\\`) ?? "");
  for (const path of [
    ...(input.isolatedRoots ?? []),
    ...(input.additionalDenyReadPaths ?? []),
    ...(input.additionalDenyWritePaths ?? []),
  ]) {
    const form = windowsNativePath(path) === undefined ? undefined : windowsGuardPath(path);
    if (form === undefined) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        "Windows confinement denials must be drive-absolute paths.",
      );
    }
    if (grantForms.some((grant) => isSameOrInside(form, grant))) {
      throw new ProcessConfinementError(
        "incompatible",
        `Windows confinement cannot keep ${path} out of a folder it grants.`,
      );
    }
  }
  return {
    command: launcher,
    args: windowsConfinedLauncherArguments(decision, input.args),
  };
}

/**
 * Parts of the port with no Windows form yet. Each is refused rather than
 * dropped, so a launch never runs with less confinement than it asked for.
 */
function refuseWhatWindowsCannotExpress(input: ProcessConfinementPrepareInput): void {
  const refuse = (what: string) => {
    throw new ProcessConfinementError("incompatible", `Windows confinement has no ${what}.`);
  };
  if (input.extraRules !== undefined && input.extraRules.length > 0) refuse("Seatbelt rules");
  // Reading everywhere would take an inheritable ACE on every drive.
  if (input.allowFileReadStar === true) refuse("read-everywhere grant");
  if (input.allowSimulatorControl === true) refuse("simulator control");
  if (input.inboundRelay !== undefined) refuse("inbound relay");
  if ((input.loopbackRelayPorts ?? []).length > 0) refuse("loopback relay");
  if ((input.serverRelays ?? []).length > 0) refuse("server relay");
  if (input.recipientAdmission !== undefined) refuse("pinned credential recipient");
}

function patternMatches(
  scan: WindowsConfinementPatternScan,
  readDirectory: NonNullable<UnverifiedWindowsConfinementOptions["readDirectory"]>,
): ReadonlyArray<string> | "truncated" {
  const found: string[] = [];
  let read = 0;
  const walk = (directory: string, levels: number): boolean => {
    for (const child of readDirectory(directory)) {
      read += 1;
      if (read > PATTERN_SCAN_LIMIT) return false;
      const path = `${directory}\\${child.name}`;
      const form = windowsGuardPath(path);
      if (form !== undefined && protectedEntryFor([form], [scan.entry]) !== undefined) {
        found.push(path);
      }
      if (child.directory && levels > 1 && !walk(path, levels - 1)) return false;
    }
    return true;
  };
  return walk(scan.directory, scan.levels) ? found : "truncated";
}

function listDirectory(
  path: string,
): ReadonlyArray<{ readonly name: string; readonly directory: boolean }> {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      // A junction or link is not followed: what it reaches gets no grant.
      directory: entry.isDirectory(),
    }));
  } catch (error) {
    // A missing folder holds no store. One the host cannot list might, so
    // the launch is refused rather than granted unchecked.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new ProcessConfinementError(
      "incompatible",
      `Windows confinement could not check ${path} for protected files, so the launch was refused.`,
    );
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
