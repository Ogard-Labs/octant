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
  /**
   * Lists one folder, throwing as `readdirSync` does (`ENOENT`, `ENOTDIR`,
   * ...); tests substitute a fixture for the Windows disk.
   */
  readonly readDirectory?: (path: string) => ReadonlyArray<DirectoryEntry>;
}

interface DirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
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
  const readDirectory = options.readDirectory ?? readFolder;
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
  // a carve-out matters only where an inherited grant would reach it. The
  // shared port re-allows the launch's own write roots after an isolated root
  // and an extra write denial (a capture's one writer carries it as both), so
  // those two never count against a grant that is one of its write roots.
  const ownWriteForms = (input.additionalWriteRoots ?? []).map(
    (path) => windowsGuardPath(path) ?? "",
  );
  const grantForms = decision.grants.map((grant) => windowsGuardPath(`${grant.path}\\`) ?? "");
  const otherGrantForms = grantForms.filter((form) => !ownWriteForms.includes(form));
  const carveOuts = [
    ...(input.isolatedRoots ?? []).map((path) => ({ path, grants: otherGrantForms })),
    ...(input.additionalDenyReadPaths ?? []).map((path) => ({ path, grants: grantForms })),
    ...(input.additionalDenyWritePaths ?? []).map((path) => ({ path, grants: otherGrantForms })),
  ];
  for (const { path, grants } of carveOuts) {
    const form = windowsNativePath(path) === undefined ? undefined : windowsGuardPath(path);
    if (form === undefined) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        "Windows confinement denials must be drive-absolute paths.",
      );
    }
    if (grants.some((grant) => isSameOrInside(form, grant))) {
      throw new ProcessConfinementError(
        "incompatible",
        `Windows confinement cannot keep ${path} out of a folder it grants.`,
      );
    }
  }
  // The other direction, as the shared port means it: an isolated root denies
  // its whole subtree and an extra write denial the writes beneath it, both
  // after every grant, and only the launch's own write roots are re-allowed
  // past them. Here a grant beneath one would simply be granted, so it is
  // refused instead, unless it is one of those write roots.
  const beneath = (paths: ReadonlyArray<string> | undefined, access: "read" | "modify") =>
    decision.grants.find((grant) => {
      if (access === "modify" && grant.access !== "modify") return false;
      const form = windowsGuardPath(`${grant.path}\\`) ?? "";
      if (ownWriteForms.includes(form)) return false;
      return (paths ?? []).some((path) => isSameOrInside(form, windowsGuardPath(path) ?? ""));
    });
  const underIsolated = beneath(input.isolatedRoots, "read");
  if (underIsolated !== undefined) {
    throw new ProcessConfinementError(
      "incompatible",
      `Windows confinement does not grant ${underIsolated.path}: it lies beneath an isolated root.`,
    );
  }
  const underDenyWrite = beneath(input.additionalDenyWritePaths, "modify");
  if (underDenyWrite !== undefined) {
    throw new ProcessConfinementError(
      "incompatible",
      `Windows confinement does not let the launch write ${underDenyWrite.path}, which it asked to keep unwritable.`,
    );
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
  readDirectory: (path: string) => ReadonlyArray<DirectoryEntry>,
): ReadonlyArray<string> | "truncated" {
  const found: string[] = [];
  let read = 0;
  const walk = (directory: string, levels: number): boolean => {
    for (const child of listForScan(directory, readDirectory)) {
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

function readFolder(path: string): ReadonlyArray<DirectoryEntry> {
  return readdirSync(path, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    // A junction or link is not followed: what it reaches gets no grant.
    directory: entry.isDirectory(),
  }));
}

/**
 * One folder's entries for a pattern scan. A missing path holds no store, and
 * a file (`ENOTDIR`) has nothing beneath it: a read root naming `~/.ssh/config`
 * was refused outright when its scan tried to list it, though the guard keeps
 * that file readable (the planner judges the grant path itself). Any other
 * failure might hide a store, so the launch is refused rather than granted
 * unchecked.
 */
function listForScan(
  path: string,
  readDirectory: (path: string) => ReadonlyArray<DirectoryEntry>,
): ReadonlyArray<DirectoryEntry> {
  try {
    return readDirectory(path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR" || isFile(path)) return [];
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
