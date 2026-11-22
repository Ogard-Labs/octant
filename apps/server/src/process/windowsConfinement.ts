/**
 * The Windows form of the shared confinement port: an AppContainer, ACL grants
 * and a kill-on-close job object, applied by the fixed native launcher
 * `octant-windows-confine.exe` (built from `apps/desktop/native/windows-confine`).
 *
 * Used by Windows Strict, phase 1 for verified native Codex launches at Full
 * access (and by the Windows confinement smoke tests). Every other Windows
 * caller continues to refuse confinement by default unless explicitly wired.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, release } from "node:os";
import { fileURLToPath } from "node:url";
import {
  decodeSandboxPolicySelection,
  type SandboxPolicySelection,
} from "@octant/contracts/sandbox-policy";
import { WINDOWS_STRICT_NETWORK_REFUSAL } from "@octant/domain/guardrail-policy";
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
import {
  recordSandboxLaunch,
  sandboxAuthorityDirectory,
  sandboxNetworkLimitsOn,
  sandboxNetworkSnapshot,
} from "./sandboxRuntimePolicy";
import { secretGuardEntries } from "./secretGuard";
import {
  type ConfinedProcessLaunch,
  ProcessConfinementError,
  type ProcessConfinementPrepareInput,
} from "./seatbeltProfile";
import type { WindowsConfinementLeaseStore } from "./windowsConfinementRecovery";

export interface WindowsConfinementOptions {
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
  /**
   * Durable pre-ACL ownership store. When provided, every confined launch
   * writes its pre-ACL lease before returning and refuses if cleanup is pending
   * on an overlapping grant.
   */
  readonly leaseStore?: WindowsConfinementLeaseStore;
}

export type UnverifiedWindowsConfinementOptions = WindowsConfinementOptions;

/**
 * Resolves the host-packaged `octant-windows-confine.exe` beside the native
 * resources directory, matching `windowsForeground.ts`. Never accepts an
 * arbitrary environment override or symlink.
 */
export function resolvePackagedWindowsConfineLauncher(
  moduleUrl: string | URL = import.meta.url,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return undefined;
  try {
    const candidate = fileURLToPath(
      new URL("../../../../native/octant-windows-confine.exe", moduleUrl),
    );
    const meta = lstatSync(candidate);
    if (!meta.isFile() || meta.isSymbolicLink()) return undefined;
    const canonical =
      process.platform === "win32" ? realpathSync.native(candidate) : realpathSync(candidate);
    const normalized = windowsNativePath(canonical);
    return normalized !== undefined && /\\octant-windows-confine\.exe$/iu.test(normalized)
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

interface DirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
}

/** How many entries a pattern scan reads before it refuses the launch. */
const PATTERN_SCAN_LIMIT = 4_096;

/**
 * What a person can do about a grant that holds, or may hold, a protected
 * store. A deny entry did not stop the read on the hosted runner, so the guard
 * is never narrowed to let the launch through.
 */
const NARROWER_GRANT_CHOICE = "Choose a narrower clean folder or another host.";

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
  const originalPolicy = input.sandboxPolicy;
  const selectedPolicy = parseWindowsSandboxPolicy(originalPolicy);
  refuseWhatWindowsCannotExpress(input, selectedPolicy, originalPolicy);

  const homeDirectory = options.homeDirectory ?? homedir();
  const launchId = options.launchId ?? randomBytes(16).toString("hex");
  const ownAccountPaths =
    input.ownAccountAccess === "none"
      ? []
      : (input.ownAccountPaths ?? [
          ...(input.readRoots ?? []),
          ...(input.additionalWriteRoots ?? []),
        ]);
  const extraBoundRoots = [
    ...new Set([
      ...(input.extraBoundRoots ?? []),
      ...(selectedPolicy?.policy.filesystem.readWriteRoots ?? []),
    ]),
  ];
  const explicitReadOnlyRoots = [
    ...new Set([
      ...(input.explicitReadOnlyRoots ?? []),
      ...(input.policyReadOnlyRoots ?? []),
      ...(selectedPolicy?.policy.filesystem.readOnlyRoots ?? []),
    ]),
  ];
  const network =
    typeof input.networkEgress === "object" ? ("proxied" as const) : input.networkEgress;
  const decision = planWindowsConfinedLaunch({
    launchId,
    executable: input.executable,
    boundRoot: input.boundRoot,
    extraBoundRoots,
    writeBoundRoot: input.writeBoundRoot !== false,
    temporaryDirectory: input.temporaryDirectory,
    additionalWriteRoots: input.additionalWriteRoots ?? [],
    readRoots: input.readRoots ?? [],
    ...(explicitReadOnlyRoots.length === 0 ? {} : { explicitReadOnlyRoots }),
    network,
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
        `Windows confinement could not finish checking ${scan.directory} for ${scan.entry.label} (over ${String(PATTERN_SCAN_LIMIT)} entries), so the launch was refused. ${NARROWER_GRANT_CHOICE}`,
      );
    }
    // The refusal names the grant and the protected category, not the file:
    // it reaches the thread as the reason Codex did not start, and a receipt
    // carries no sensitive path.
    if (found.length > 0) {
      throw new ProcessConfinementError(
        "incompatible",
        `Windows confinement does not grant ${scan.directory}: it holds ${scan.entry.label}, which the secret guard protects. ${NARROWER_GRANT_CHOICE}`,
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
  // Refuse any grant that overlaps private host enforcement storage (such as
  // the durable pre-ACL lease store or sandbox authority directory).
  const privateHostRoots = [options.leaseStore?.leaseDirectory, sandboxAuthorityDirectory()]
    .map((path) => (path === undefined ? undefined : windowsGuardPath(path)))
    .filter((form): form is string => form !== undefined);
  for (const grant of decision.grants) {
    const grantForm = windowsGuardPath(`${grant.path}\\`);
    if (
      grantForm !== undefined &&
      privateHostRoots.some(
        (privateRoot) =>
          isSameOrInside(grantForm, privateRoot) || isSameOrInside(privateRoot, grantForm),
      )
    ) {
      throw new ProcessConfinementError(
        "incompatible",
        `Windows confinement does not grant ${grant.path}: it overlaps private host sandbox storage.`,
      );
    }
  }
  const leaseStore = options.leaseStore;
  if (leaseStore !== undefined) {
    const recorded = leaseStore.recordPreAcl({
      launchId,
      appContainerName: decision.appContainerName,
      grants: decision.grants.map((grant) => grant.path),
      launcherPath: launcher,
    });
    if (recorded.status === "refused") {
      throw new ProcessConfinementError("incompatible", recorded.message);
    }
  }
  const args = windowsConfinedLauncherArguments(decision, input.args);
  if (selectedPolicy !== undefined && originalPolicy !== undefined) {
    const readGrantPaths = decision.grants
      .filter((grant) => grant.access === "read")
      .map((grant) => grant.path);
    const writeGrantPaths = decision.grants
      .filter((grant) => grant.access === "modify")
      .map((grant) => grant.path);
    // Pass the original selection reference registered by SandboxRestrictionsService
    // so WeakMap-backed launch recording matches it by object identity.
    recordSandboxLaunch(originalPolicy, {
      provider: selectedPolicy.context.provider,
      backend: `Windows AppContainer + Job Object · ${release()}`,
      reads: readGrantPaths.slice(0, 64),
      writes: writeGrantPaths.slice(0, 64),
      authentication: ownAccountPaths.slice(0, 64),
    });
  }
  const policyReceipt =
    selectedPolicy === undefined
      ? undefined
      : Object.freeze({
          policyDigest: createHash("sha256")
            .update(JSON.stringify(selectedPolicy.policy))
            .digest("hex"),
          reuseKey: createHash("sha256")
            .update(
              JSON.stringify({
                backend: "windows-appcontainer-v1",
                launchId,
                launcher,
                policy: selectedPolicy.policy,
                grants: decision.grants,
                capabilities: decision.capabilities,
              }),
            )
            .digest("hex"),
          backend: "windows-appcontainer-v1" as const,
        });
  return {
    command: launcher,
    args,
    ...(policyReceipt === undefined ? {} : { policyReceipt }),
    ...(leaseStore === undefined
      ? {}
      : {
          onSpawned: (pid: number) => leaseStore.recordLauncherPid(launchId, pid),
          verifyCleanup: async () => {
            const outcome = await leaseStore.releaseAndVerify(launchId);
            if (outcome.status === "cleanup-pending") {
              throw new Error(outcome.message);
            }
          },
        }),
  };
}

function parseWindowsSandboxPolicy(raw: unknown): SandboxPolicySelection | undefined {
  if (raw === undefined) return undefined;
  try {
    return decodeSandboxPolicySelection(raw);
  } catch {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Windows confinement received a malformed sandbox policy selection.",
    );
  }
}

/**
 * Parts of the port with no Windows form yet. Each is refused rather than
 * dropped, so a launch never runs with less confinement than it asked for.
 */
function refuseWhatWindowsCannotExpress(
  input: ProcessConfinementPrepareInput,
  selectedPolicy: SandboxPolicySelection | undefined,
  originalPolicy: SandboxPolicySelection | undefined,
): void {
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
  if (input.policyBlockHostServices === true || selectedPolicy?.policy.hostServices === "blocked") {
    throw new ProcessConfinementError("incompatible", WINDOWS_STRICT_NETWORK_REFUSAL);
  }
  if (
    (selectedPolicy?.policy.approvedDestinations?.length ?? 0) > 0 ||
    (selectedPolicy?.policy.localServices?.length ?? 0) > 0
  ) {
    throw new ProcessConfinementError("incompatible", WINDOWS_STRICT_NETWORK_REFUSAL);
  }
  if (selectedPolicy !== undefined) {
    // Blocking all AppContainer network without a verified host model-inference
    // proxy would sever Codex's own API calls; refuse rather than breaking or
    // silently weakening network: "deny".
    if (selectedPolicy.policy.network === "deny") {
      throw new ProcessConfinementError("incompatible", WINDOWS_STRICT_NETWORK_REFUSAL);
    }
    if (selectedPolicy.policy.filesystem.protectedPaths.length > 0) {
      throw new ProcessConfinementError(
        "incompatible",
        "Windows confinement does not support custom protected-path rules yet.",
      );
    }
    if (selectedPolicy.policy.credentials === "isolated") {
      throw new ProcessConfinementError(
        "incompatible",
        "Windows confinement does not support isolated credential mediation yet.",
      );
    }
    if (
      selectedPolicy.policy.network === "existing-policy" &&
      ((originalPolicy === undefined ? undefined : sandboxNetworkSnapshot(originalPolicy))
        ?.limitsOn ??
        sandboxNetworkLimitsOn())
    ) {
      throw new ProcessConfinementError("incompatible", WINDOWS_STRICT_NETWORK_REFUSAL);
    }
    if (
      input.writeBoundRoot === false &&
      selectedPolicy.policy.filesystem.readWriteRoots.length > 0
    ) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        "Windows confinement cannot add writable policy folders to a read-only launch.",
      );
    }
  }
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
      `Windows confinement could not check ${path} for protected files, so the launch was refused. ${NARROWER_GRANT_CHOICE}`,
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
